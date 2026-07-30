import { describe, it, expect, beforeEach } from 'vitest';
import {
  isIamAuthConnection,
  regionFromRdsHost,
  dbUserFromCallerArn,
  resolveIamUsername,
  resolveIamTarget,
  getIamAuthToken,
  resolveIamCredentials,
  clearIamAuthCache,
  AwsCommandRunner,
} from '../src/auth/iam-auth.js';
import { DatabaseConnection } from '../src/types.js';

/**
 * A connection shaped like the ones an AWS Advanced JDBC Wrapper driver writes:
 * an opaque driver id, engine properties nested under `properties`, and no
 * stored password or username.
 */
function iamConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: '35379A2C-3AE9-529E-B72B-244C753C055B-custom-3fea10ef',
    name: 'shared-int-postgres (example-int-db)',
    driver: 'postgresql',
    driverId: '35379A2C-3AE9-529E-B72B-244C753C055B',
    provider: 'postgresql',
    url: 'jdbc:aws-wrapper:postgresql://shared-int.cluster-x.us-east-1.rds.amazonaws.com:5432/postgres',
    host: 'shared-int.cluster-x.us-east-1.rds.amazonaws.com',
    port: 5432,
    database: 'postgres',
    properties: {
      host: 'shared-int.cluster-x.us-east-1.rds.amazonaws.com',
      port: '5432',
      database: 'postgres',
      'auth-model': 'native',
      properties: {
        wrapperPlugins: 'iam',
        awsProfile: 'example-int-db',
        iamRegion: 'us-east-1',
        allowAwsLoginSession: 'true',
        sslmode: 'require',
      },
    } as unknown as Record<string, string>,
    ...overrides,
  };
}

/** Records the AWS CLI invocations a call makes and returns canned stdout. */
function stubRunner(responses: Record<string, string>): {
  runner: AwsCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: AwsCommandRunner = async (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (!(key in responses)) {
      throw new Error(`unexpected AWS call: ${key}`);
    }
    return responses[key];
  };
  return { runner, calls };
}

describe('isIamAuthConnection', () => {
  it('detects the aws-wrapper iam plugin nested in driver properties', () => {
    expect(isIamAuthConnection(iamConnection())).toBe(true);
  });

  it('detects an iam auth model', () => {
    const conn = iamConnection({
      properties: { 'auth-model': 'postgres_aws_iam' } as unknown as Record<string, string>,
    });
    expect(isIamAuthConnection(conn)).toBe(true);
  });

  it('ignores a wrapper used without the iam plugin', () => {
    const conn = iamConnection({
      properties: {
        properties: { wrapperPlugins: 'failover,efm' },
      } as unknown as Record<string, string>,
    });
    expect(isIamAuthConnection(conn)).toBe(false);
  });

  it('leaves ordinary password connections alone', () => {
    const conn: DatabaseConnection = {
      id: 'postgres-jdbc-1',
      name: 'local',
      driver: 'postgres-jdbc',
      url: 'jdbc:postgresql://localhost:5432/app',
      properties: { host: 'localhost', user: 'app', password: 'placeholder-not-a-secret' },
    };
    expect(isIamAuthConnection(conn)).toBe(false);
  });
});

describe('regionFromRdsHost', () => {
  it('reads commercial and GovCloud regions from RDS endpoints', () => {
    expect(regionFromRdsHost('db.cluster-abc.us-east-1.rds.amazonaws.com')).toBe('us-east-1');
    expect(regionFromRdsHost('db.abc.us-gov-east-1.rds.amazonaws.com')).toBe('us-gov-east-1');
    expect(regionFromRdsHost('db.abc.ap-southeast-2.rds.amazonaws.com')).toBe('ap-southeast-2');
  });

  it('returns undefined for non-RDS hosts', () => {
    expect(regionFromRdsHost('localhost')).toBeUndefined();
    expect(regionFromRdsHost('db.internal.example.com')).toBeUndefined();
  });
});

describe('dbUserFromCallerArn', () => {
  it('takes the username from an assumed SSO role session', () => {
    expect(
      dbUserFromCallerArn(
        'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/devuser@example.com'
      )
    ).toBe('devuser');
  });

  it('strips the profile prefix off a per-developer role name', () => {
    // Role-chained profiles produce an SDK-generated session name, so the role
    // name is the only thing identifying the developer.
    expect(
      dbUserFromCallerArn(
        'arn:aws:sts::123456789012:assumed-role/example-int-db-devuser/botocore-session-1785446405',
        'example-int-db'
      )
    ).toBe('devuser');

    expect(
      dbUserFromCallerArn(
        'arn:aws-us-gov:sts::123456789012:assumed-role/example-gov-db-devuser/botocore-session-1785446428',
        'example-gov-db'
      )
    ).toBe('devuser');
  });

  it('never mistakes a generated session name for a username', () => {
    expect(
      dbUserFromCallerArn(
        'arn:aws:sts::123:assumed-role/some-unrelated-role/botocore-session-1785446405'
      )
    ).toBeUndefined();
  });

  it('handles an assumed role session with no email suffix', () => {
    expect(dbUserFromCallerArn('arn:aws:sts::123:assumed-role/some-db-role/devuser')).toBe(
      'devuser'
    );
  });

  it('handles a plain IAM user arn', () => {
    expect(dbUserFromCallerArn('arn:aws:iam::123456789012:user/devuser')).toBe('devuser');
  });

  it('returns undefined for a root or unrecognised arn', () => {
    expect(dbUserFromCallerArn('arn:aws:iam::123456789012:root')).toBeUndefined();
  });
});

describe('resolveIamUsername', () => {
  beforeEach(() => {
    clearIamAuthCache();
    delete process.env.AWS_PROFILE;
  });

  it('prefers a username recorded on the connection', async () => {
    const { runner, calls } = stubRunner({});
    const user = await resolveIamUsername(iamConnection({ user: 'explicit_user' }), { runner });

    expect(user).toBe('explicit_user');
    expect(calls).toHaveLength(0);
  });

  it('derives the username from the caller identity when absent', async () => {
    const { runner, calls } = stubRunner({
      'sts get-caller-identity': JSON.stringify({
        Arn: 'arn:aws:sts::123:assumed-role/AWSReservedSSO_Admin_x/devuser@example.com',
      }),
    });

    expect(await resolveIamUsername(iamConnection(), { runner })).toBe('devuser');
    // Derived against the connection's own profile, not the ambient default.
    expect(calls[0]).toContain('--profile');
    expect(calls[0]).toContain('example-int-db');
  });

  it('caches the derived username per profile', async () => {
    const { runner, calls } = stubRunner({
      'sts get-caller-identity': JSON.stringify({
        Arn: 'arn:aws:sts::123:assumed-role/role/devuser@example.com',
      }),
    });

    await resolveIamUsername(iamConnection(), { runner });
    await resolveIamUsername(iamConnection(), { runner });

    expect(calls).toHaveLength(1);
  });

  it('explains an expired SSO session rather than leaking the raw error', async () => {
    const runner: AwsCommandRunner = async () => {
      throw new Error('Error loading SSO Token: Token has expired and refresh failed');
    };

    await expect(resolveIamUsername(iamConnection(), { runner })).rejects.toThrow(
      /aws sso login --profile example-int-db/
    );
  });
});

describe('resolveIamTarget', () => {
  beforeEach(() => {
    clearIamAuthCache();
  });

  it('assembles host, port, user, region and profile', async () => {
    const target = await resolveIamTarget(iamConnection({ user: 'devuser' }), 5432, {
      runner: stubRunner({}).runner,
    });

    expect(target).toEqual({
      host: 'shared-int.cluster-x.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'devuser',
      region: 'us-east-1',
      profile: 'example-int-db',
    });
  });

  it('falls back to the region embedded in the RDS endpoint and the default port', async () => {
    // No iamRegion property and no port: both must be inferred. This is the
    // MySQL shape, whose JDBC URL carries no database either.
    const conn = iamConnection({
      user: 'devuser',
      host: 'db.abc.us-gov-east-1.rds.amazonaws.com',
      port: undefined,
      properties: {
        properties: { wrapperPlugins: 'iam', awsProfile: 'example-gov-db' },
      } as unknown as Record<string, string>,
    });

    const target = await resolveIamTarget(conn, 3306, { runner: stubRunner({}).runner });
    expect(target.region).toBe('us-gov-east-1');
    expect(target.port).toBe(3306);
    expect(target.profile).toBe('example-gov-db');
  });

  it('prefers the port recorded on the connection over the engine default', async () => {
    const target = await resolveIamTarget(iamConnection({ user: 'devuser' }), 3306, {
      runner: stubRunner({}).runner,
    });
    expect(target.port).toBe(5432);
  });
});

describe('getIamAuthToken', () => {
  beforeEach(() => {
    clearIamAuthCache();
  });

  const target = {
    host: 'db.cluster-x.us-east-1.rds.amazonaws.com',
    port: 5432,
    user: 'devuser',
    region: 'us-east-1',
    profile: 'example-int-db',
  };

  it('mints a token with the expected AWS CLI arguments', async () => {
    const { runner, calls } = stubRunner({
      'rds generate-db-auth-token': 'db.example.com:5432/?Action=connect&X-Amz-Signature=abc\n',
    });

    const token = await getIamAuthToken(target, { runner });

    expect(token).toBe('db.example.com:5432/?Action=connect&X-Amz-Signature=abc');
    expect(calls[0]).toEqual([
      'rds',
      'generate-db-auth-token',
      '--hostname',
      target.host,
      '--port',
      '5432',
      '--username',
      'devuser',
      '--region',
      'us-east-1',
      '--profile',
      'example-int-db',
    ]);
  });

  it('reuses a cached token for the same target', async () => {
    const { runner, calls } = stubRunner({ 'rds generate-db-auth-token': 'token-1' });

    await getIamAuthToken(target, { runner });
    await getIamAuthToken(target, { runner });

    expect(calls).toHaveLength(1);
  });

  it('does not share tokens between different users or hosts', async () => {
    const { runner, calls } = stubRunner({ 'rds generate-db-auth-token': 'token-1' });

    await getIamAuthToken(target, { runner });
    await getIamAuthToken({ ...target, user: 'someone_else' }, { runner });
    await getIamAuthToken({ ...target, host: 'other.rds.amazonaws.com' }, { runner });

    expect(calls).toHaveLength(3);
  });

  it('rejects an empty token instead of attempting a blank password', async () => {
    const { runner } = stubRunner({ 'rds generate-db-auth-token': '   \n' });

    await expect(getIamAuthToken(target, { runner })).rejects.toThrow(/empty RDS auth token/);
  });
});

describe('resolveIamCredentials', () => {
  beforeEach(() => {
    clearIamAuthCache();
  });

  it('derives the username and mints a token in one step', async () => {
    const { runner } = stubRunner({
      'sts get-caller-identity': JSON.stringify({
        Arn: 'arn:aws:sts::123:assumed-role/role/devuser@example.com',
      }),
      'rds generate-db-auth-token': 'signed-token',
    });

    const creds = await resolveIamCredentials(iamConnection(), 5432, { runner });

    expect(creds).toEqual({ user: 'devuser', password: 'signed-token' });
  });
});
