/**
 * AWS RDS IAM database authentication.
 *
 * Connections created for IAM auth carry no stored credential - the auth token
 * itself authenticates, and is minted per connection and expires after 15
 * minutes. This module detects such connections, resolves the DB username, and
 * mints tokens via the AWS CLI (which handles SSO and role-chained profiles).
 *
 * Recognised shapes:
 *  - AWS Advanced JDBC Wrapper drivers, which record `wrapperPlugins: "iam"`
 *    alongside `awsProfile`/`iamRegion` and a `jdbc:aws-wrapper:<engine>://` URL.
 *  - The DB client's own AWS IAM auth models, which set an `iam`-flavoured
 *    `auth-model`.
 */

import { spawn } from 'child_process';
import { DatabaseConnection } from '../types.js';
import { readConnectionProp } from './connection-props.js';

/** Tokens valid for 15 minutes; refresh early so in-flight connects never race expiry. */
const TOKEN_TTL_MS = 13 * 60 * 1000;

const DEFAULT_CLI_TIMEOUT_MS = 20000;

/** Wrapper plugin codes that make the password an IAM token. */
const IAM_PLUGIN_CODES = ['iam', 'federatedauth', 'okta', 'adfs'];

export interface IamTarget {
  host: string;
  port: number;
  user: string;
  region?: string;
  profile?: string;
}

/** Runs the AWS CLI and resolves with stdout. Injectable for tests. */
export type AwsCommandRunner = (args: string[], timeoutMs: number) => Promise<string>;

export interface IamAuthOptions {
  runner?: AwsCommandRunner;
  timeoutMs?: number;
  debug?: boolean;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();
const usernameCache = new Map<string, string>();

/** Clear cached tokens and derived usernames. Exposed for tests and long-lived processes. */
export function clearIamAuthCache(): void {
  tokenCache.clear();
  usernameCache.clear();
}

const readProp = readConnectionProp;

/**
 * True when this connection authenticates with an RDS IAM token rather than a
 * stored password.
 */
export function isIamAuthConnection(connection: DatabaseConnection): boolean {
  const plugins = readProp(connection, 'wrapperPlugins', 'wrapperPluginCodes');
  if (plugins) {
    const codes = plugins
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
    if (codes.some((code) => IAM_PLUGIN_CODES.includes(code))) {
      return true;
    }
  }

  const authModel = readProp(connection, 'auth-model', 'authModel', 'authModelId');
  if (authModel && authModel.toLowerCase().includes('iam')) {
    return true;
  }

  return false;
}

/**
 * Extract the AWS region from an RDS endpoint.
 *
 * `db.cluster-abc123.us-gov-east-1.rds.amazonaws.com` -> `us-gov-east-1`
 */
export function regionFromRdsHost(host: string): string | undefined {
  const parts = host.toLowerCase().split('.');
  const rdsIdx = parts.lastIndexOf('rds');
  if (rdsIdx > 0) {
    const candidate = parts[rdsIdx - 1];
    // Regions look like us-east-1 / us-gov-east-1 / ap-southeast-2.
    if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Session names the SDK generates itself, which say nothing about who is calling.
 */
function isGeneratedSessionName(sessionName: string): boolean {
  return /(^|-)session-\d+$/i.test(sessionName);
}

/**
 * Derive the DB username from an STS caller identity ARN.
 *
 * Two shapes matter:
 *
 *  - A per-developer role assumed through a generated profile. The role is named
 *    `<profile>-<dbuser>` (`example-int-db-devuser` behind profile
 *    `example-int-db`), while the session name is SDK-generated
 *    (`botocore-session-1785446405`) and therefore useless. Strip the profile
 *    prefix off the role name.
 *  - A directly assumed SSO role, whose session name *is* the user:
 *    `.../assumed-role/AWSReservedSSO_Admin_x/devuser@example.com` -> `devuser`.
 */
export function dbUserFromCallerArn(arn: string, profile?: string): string | undefined {
  const assumed = arn.match(/assumed-role\/([^/]+)\/(.+)$/);
  if (assumed) {
    const [, roleName, sessionName] = assumed;

    if (profile && roleName.toLowerCase().startsWith(`${profile.toLowerCase()}-`)) {
      const fromRole = roleName.slice(profile.length + 1);
      if (fromRole) {
        return fromRole;
      }
    }

    if (!isGeneratedSessionName(sessionName)) {
      return sessionName.split('@')[0] || undefined;
    }

    return undefined;
  }

  const iamUser = arn.match(/:user\/(?:.*\/)?(.+)$/);
  if (iamUser) {
    return iamUser[1].split('@')[0] || undefined;
  }

  return undefined;
}

function awsCliPath(): string {
  return process.env.OMNISQL_AWS_CLI_PATH || 'aws';
}

/** Default runner: spawn the AWS CLI with an argument array (never a shell). */
const spawnAwsCli: AwsCommandRunner = (args, timeoutMs) => {
  return new Promise<string>((resolve, reject) => {
    const exe = awsCliPath();
    let proc;
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(
        new Error(`Failed to run "${exe}": ${error instanceof Error ? error.message : error}`)
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutId = setTimeout(() => {
      settled = true;
      proc.kill('SIGTERM');
      reject(new Error(`AWS CLI timed out after ${timeoutMs}ms: aws ${args[0]} ${args[1] ?? ''}`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      const hint =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? ` AWS CLI not found at "${exe}" - install it or set OMNISQL_AWS_CLI_PATH.`
          : '';
      reject(new Error(`Failed to run AWS CLI: ${error.message}.${hint}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `AWS CLI exited with code ${code}`));
    });
  });
};

/**
 * Turn a raw AWS CLI failure into something the user can act on.
 *
 * Expired SSO sessions are by far the most common cause and the CLI's own
 * message does not name the profile to re-authenticate.
 */
function decorateAwsError(error: unknown, profile?: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const ssoExpired =
    lower.includes('token has expired') ||
    lower.includes('error loading sso token') ||
    lower.includes('sso session associated with this profile') ||
    lower.includes('the sso access token');

  if (ssoExpired) {
    const loginTarget = profile ? ` --profile ${profile}` : '';
    return new Error(
      `AWS SSO session expired. Run \`aws sso login${loginTarget}\` and retry. (${message})`
    );
  }

  return new Error(message);
}

/**
 * Resolve the DB username for an IAM connection, deriving it from the caller's
 * identity when the connection config does not record one.
 */
export async function resolveIamUsername(
  connection: DatabaseConnection,
  options: IamAuthOptions = {}
): Promise<string> {
  const configured = connection.user || readProp(connection, 'user', 'username');
  if (configured) {
    return configured;
  }

  const profile = readProp(connection, 'awsProfile', 'profile') || process.env.AWS_PROFILE;
  const cacheKey = profile ?? '<default>';
  const cached = usernameCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const runner = options.runner ?? spawnAwsCli;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;

  const args = ['sts', 'get-caller-identity', '--output', 'json'];
  if (profile) {
    args.push('--profile', profile);
  }

  let stdout: string;
  try {
    stdout = await runner(args, timeoutMs);
  } catch (error) {
    throw new Error(
      `Connection "${connection.name}" uses AWS IAM authentication but records no database ` +
        `username, and deriving one from your AWS identity failed: ` +
        `${decorateAwsError(error, profile).message}`
    );
  }

  let arn = '';
  try {
    arn = String(JSON.parse(stdout).Arn ?? '');
  } catch {
    // fall through to the error below
  }

  const derived = arn ? dbUserFromCallerArn(arn, profile) : undefined;
  if (!derived) {
    throw new Error(
      `Connection "${connection.name}" uses AWS IAM authentication but records no database ` +
        `username, and none could be derived from AWS identity "${arn || 'unknown'}". ` +
        `Set the username on the connection in your DB client.`
    );
  }

  if (options.debug) {
    console.error(`Derived IAM database username "${derived}" from ${arn}`);
  }

  usernameCache.set(cacheKey, derived);
  return derived;
}

/**
 * Build the host/port/user/region/profile tuple a token is minted against.
 */
export async function resolveIamTarget(
  connection: DatabaseConnection,
  defaultPort: number,
  options: IamAuthOptions = {}
): Promise<IamTarget> {
  const host = connection.host || readProp(connection, 'host', 'server');
  if (!host) {
    throw new Error(
      `Connection "${connection.name}" uses AWS IAM authentication but has no host configured.`
    );
  }

  const portRaw = connection.port ?? readProp(connection, 'port');
  const port = portRaw ? parseInt(String(portRaw), 10) : defaultPort;

  const user = await resolveIamUsername(connection, options);
  const profile = readProp(connection, 'awsProfile', 'profile') || process.env.AWS_PROFILE;
  const region =
    readProp(connection, 'iamRegion', 'awsRegion', 'region') ||
    regionFromRdsHost(host) ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;

  return {
    host,
    port: Number.isNaN(port) ? defaultPort : port,
    user,
    region,
    profile,
  };
}

/**
 * Mint (or reuse) an RDS IAM auth token to use as the connection password.
 */
export async function getIamAuthToken(
  target: IamTarget,
  options: IamAuthOptions = {}
): Promise<string> {
  const cacheKey = [
    target.profile ?? '',
    target.region ?? '',
    target.host,
    target.port,
    target.user,
  ].join('|');

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const runner = options.runner ?? spawnAwsCli;
  const timeoutMs =
    options.timeoutMs ??
    parseInt(process.env.OMNISQL_IAM_TOKEN_TIMEOUT || String(DEFAULT_CLI_TIMEOUT_MS), 10);

  const args = [
    'rds',
    'generate-db-auth-token',
    '--hostname',
    target.host,
    '--port',
    String(target.port),
    '--username',
    target.user,
  ];
  if (target.region) {
    args.push('--region', target.region);
  }
  if (target.profile) {
    args.push('--profile', target.profile);
  }

  let stdout: string;
  try {
    stdout = await runner(args, Number.isNaN(timeoutMs) ? DEFAULT_CLI_TIMEOUT_MS : timeoutMs);
  } catch (error) {
    throw decorateAwsError(error, target.profile);
  }

  const token = stdout.trim();
  if (!token) {
    throw new Error(
      `AWS returned an empty RDS auth token for ${target.user}@${target.host}:${target.port}.`
    );
  }

  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });

  if (options.debug) {
    console.error(
      `Minted RDS IAM token for ${target.user}@${target.host}:${target.port} ` +
        `(${token.length} chars, profile=${target.profile ?? 'default'}, region=${target.region ?? 'default'})`
    );
  }

  return token;
}

/**
 * Resolve the credentials for an IAM connection in one step.
 *
 * `password` is a freshly minted RDS auth token, named for the driver option it
 * feeds rather than for how it was obtained.
 */
export async function resolveIamCredentials(
  connection: DatabaseConnection,
  defaultPort: number,
  options: IamAuthOptions = {}
): Promise<{ user: string; password: string }> {
  const target = await resolveIamTarget(connection, defaultPort, options);
  const authToken = await getIamAuthToken(target, options);
  return { user: target.user, password: authToken };
}
