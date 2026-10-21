import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  intro,
  outro,
  select,
  text,
  confirm,
  isCancel,
  cancel,
  note,
  password,
} from '@clack/prompts';
import { WorkspaceConfigParser } from './config-parser.js';
import { assertNoSymlinks, validateSetupConfig, writeSetupConfig } from './install-config.js';

export function buildInstallCommand(
  client: string,
  readOnly = false,
  environment: Record<string, string> = {}
): { command: string; args: string[] } {
  const allowed = new Set([
    'OMNISQL_CONFIG_FILE',
    'OMNISQL_WORKSPACE',
    'OMNISQL_PROJECT',
    'OMNISQL_READ_ONLY',
    'OMNISQL_ALLOWED_CONNECTIONS',
    'OMNISQL_DISCOVER_WORKSPACE',
  ]);
  if (Object.keys(environment).some((key) => !allowed.has(key)))
    throw new Error(
      'Installer environment accepts setup settings only; keep credentials in private configuration or environment references.'
    );
  const launch = process.versions.bun
    ? [process.execPath, 'x', '--bun', '--yes', 'omnisql-mcp@latest']
    : process.platform === 'win32'
      ? ['cmd', '/c', 'npx', '-y', 'omnisql-mcp@latest']
      : ['npx', '-y', 'omnisql-mcp@latest'];
  const settings = { ...environment, ...(readOnly ? { OMNISQL_READ_ONLY: 'true' } : {}) };
  const env = Object.entries(settings).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  switch (client) {
    case 'claude':
      return {
        command: 'claude',
        args: [
          'mcp',
          'add',
          '--transport',
          'stdio',
          '--scope',
          'user',
          'omnisql',
          ...env,
          '--',
          ...launch,
        ],
      };
    case 'codex':
      return { command: 'codex', args: ['mcp', 'add', ...env, 'omnisql', '--', ...launch] };
    case 'opencode':
      return {
        command: 'opencode',
        args: ['mcp', 'add', 'omnisql', '--global', ...env, '--', ...launch],
      };
    default:
      throw new Error(
        'Choose a client: claude, codex, or opencode. Usage: npx -y omnisql-mcp@latest install <client> [--read-only] [--dry-run]'
      );
  }
}

/** cmd shims cannot be spawned directly on Windows. Values stay in environment slots,
 * quoted once, instead of being interpolated into cmd's command source. */
export function clientInvocation(command: string, args: string[], platform = process.platform) {
  if (platform !== 'win32') return { command, args, env: process.env };
  const values = [command, ...args];
  if (values.some((value) => /["\r\n]/.test(value)))
    throw new Error('Windows client arguments cannot contain quotes or newlines.');
  const env = { ...process.env };
  values.forEach((value, index) => {
    env[`OMNISQL_INSTALL_ARG_${index}`] = value;
  });
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: [
      '/d',
      '/v:off',
      '/s',
      '/c',
      '"' + values.map((_, index) => `"%OMNISQL_INSTALL_ARG_${index}%"`).join(' ') + '"',
    ],
    env,
  };
}

function assertClientDestination(client: string): void {
  const home = homedir();
  const candidates =
    client === 'codex'
      ? [join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml')]
      : client === 'claude'
        ? [
            join(home, '.claude.json'),
            ...(process.env.CLAUDE_CONFIG_DIR
              ? [join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')]
              : []),
          ]
        : [
            join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', 'opencode.json'),
            join(
              process.env.XDG_CONFIG_HOME || join(home, '.config'),
              'opencode',
              'opencode.jsonc'
            ),
            ...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : []),
          ];
  for (const file of candidates) {
    assertNoSymlinks(file);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    // Conservatively refuse any existing OmniSQL entry, including JSONC and quoted TOML names.
    if (
      client === 'codex'
        ? /\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:omnisql|"omnisql"|'omnisql')(?:\s*[.\]])/.test(
            content
          )
        : /"omnisql"\s*:/.test(content)
    )
      throw new Error(
        'An omnisql entry already exists. Keep it, or remove it with your client before running setup again.'
      );
  }
}

export function installClient(args: string[], environment: Record<string, string> = {}): void {
  const [client, ...flags] = args;
  const settings = { ...environment };
  if (flags.includes('--read-only') && flags.includes('--allow-writes'))
    throw new Error('Choose either --read-only or --allow-writes.');
  let readOnly = true;
  let dryRun = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--read-only') readOnly = true;
    else if (flag === '--allow-writes') readOnly = false;
    else if (flag === '--dry-run') dryRun = true;
    else if (['--config', '--workspace', '--allow'].includes(flag)) {
      const value = flags[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      if (flag === '--config') settings.OMNISQL_CONFIG_FILE = expandPath(value);
      else if (flag === '--workspace') {
        settings.OMNISQL_WORKSPACE = expandPath(value);
        settings.OMNISQL_DISCOVER_WORKSPACE = 'true';
      } else settings.OMNISQL_ALLOWED_CONNECTIONS = value;
    } else
      throw new Error(
        'Supported install options: --read-only, --allow-writes, --dry-run, --config <file>, --workspace <directory>, --allow <ids>'
      );
  }
  if (settings.OMNISQL_CONFIG_FILE && settings.OMNISQL_WORKSPACE)
    throw new Error('Choose either --config or --workspace for setup.');
  if (settings.OMNISQL_CONFIG_FILE) {
    const ids = validateSetupConfig(settings.OMNISQL_CONFIG_FILE);
    settings.OMNISQL_DISCOVER_WORKSPACE = 'false';
    if (
      settings.OMNISQL_ALLOWED_CONNECTIONS &&
      settings.OMNISQL_ALLOWED_CONNECTIONS.split(',').some(
        (selector) =>
          !ids.some((id) => selector.trim() === id || selector.trim().startsWith(id + '/'))
      )
    )
      throw new Error(
        'Every --allow selector must identify a configured connection ID (optionally followed by /database).'
      );
    settings.OMNISQL_ALLOWED_CONNECTIONS ||= ids.join(',');
  }
  if (settings.OMNISQL_READ_ONLY === 'false' && !flags.includes('--read-only')) readOnly = false;
  if (!readOnly) settings.OMNISQL_READ_ONLY = 'false';
  const { command, args: commandArgs } = buildInstallCommand(client, readOnly, settings);
  if (
    !dryRun &&
    !settings.OMNISQL_CONFIG_FILE &&
    (!settings.OMNISQL_WORKSPACE || !settings.OMNISQL_ALLOWED_CONNECTIONS?.trim())
  )
    throw new Error(
      'Choose --config <file> or --workspace <directory> --allow <connection IDs>, or run guided setup in a terminal.'
    );
  if (settings.OMNISQL_WORKSPACE && !statSync(settings.OMNISQL_WORKSPACE).isDirectory())
    throw new Error('Workspace must be a directory.');
  console.error([command, ...commandArgs.map((value) => JSON.stringify(value))].join(' '));
  if (dryRun) return;
  assertClientDestination(client);
  const invocation = clientInvocation(command, commandArgs);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    shell: false,
    env: invocation.env,
    windowsVerbatimArguments: process.platform === 'win32',
  });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(
        `${command} is not installed or is not on PATH. Install the client first, then rerun this command.`
      );
    }
    throw new Error(`${command} could not start. Check that the client is installed and on PATH.`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} could not add OmniSQL (exit ${result.status ?? result.signal}). Check the client output above.`
    );
  }
  console.error('OmniSQL added. Start a new client session to use it.');
}

function answer<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}

async function workspaceConnections(workspace: string) {
  const previousConfig = process.env.OMNISQL_CONFIG_FILE;
  const previousDiscovery = process.env.OMNISQL_DISCOVER_WORKSPACE;
  try {
    // Setup inspects only the source selected by the person at the terminal.
    delete process.env.OMNISQL_CONFIG_FILE;
    process.env.OMNISQL_DISCOVER_WORKSPACE = 'true';
    return await new WorkspaceConfigParser({ workspacePath: workspace }).parseConnections();
  } catch {
    throw new Error(
      'Cannot read the selected workspace. Check its configuration before registering.'
    );
  } finally {
    if (previousConfig === undefined) delete process.env.OMNISQL_CONFIG_FILE;
    else process.env.OMNISQL_CONFIG_FILE = previousConfig;
    if (previousDiscovery === undefined) delete process.env.OMNISQL_DISCOVER_WORKSPACE;
    else process.env.OMNISQL_DISCOVER_WORKSPACE = previousDiscovery;
  }
}

export async function runInstall(args: string[]): Promise<void> {
  if (args.includes('--config') && args.includes('--workspace'))
    throw new Error('Choose either --config or --workspace for setup.');
  const preselected =
    args.length === 1 &&
    ['claude', 'codex', 'opencode'].includes(args[0]) &&
    process.stdin.isTTY &&
    process.stdout.isTTY
      ? args[0]
      : undefined;
  if (args.length > 0 && !preselected) {
    const workspace = args[args.indexOf('--workspace') + 1];
    if (args.includes('--workspace') && workspace && !args.includes('--dry-run')) {
      const available = await workspaceConnections(expandPath(workspace));
      const selected = args.includes('--allow')
        ? args[args.indexOf('--allow') + 1]?.split(',').map((id) => id.trim())
        : [];
      if (!selected?.length || selected.some((id) => !available.some((entry) => entry.id === id)))
        throw new Error(
          'Select existing workspace connection IDs with --allow before registering.'
        );
    }
    installClient(args);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive setup needs a terminal. Choose a client explicitly: install <claude|codex|opencode> [--read-only] [--dry-run]'
    );
  }
  intro('OmniSQL MCP setup');
  const clients = [
    { value: 'claude', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'opencode', label: 'OpenCode' },
  ];
  const client =
    preselected ??
    answer(
      await select({
        message: 'Where should OmniSQL be added?',
        options: clients.map((entry) => ({
          ...entry,
          hint:
            spawnSync(entry.value, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0
              ? 'detected'
              : 'client must be installed',
        })),
      })
    );
  assertClientDestination(client);
  const mode = answer(
    await select({
      message: 'How do you want to connect?',
      options: [
        { value: 'direct', label: 'Add database instances directly', hint: 'No DBeaver needed' },
        { value: 'config', label: 'Use an existing OmniSQL configuration' },
        { value: 'workspace', label: 'Import selected DBeaver connections' },
      ],
    })
  );
  let environment: Record<string, string>;
  if (mode === 'direct') {
    const config = await collectDirectConfig();
    const file = expandPath(
      answer(
        await text({
          message: 'Save private connection configuration to',
          defaultValue: join(homedir(), '.config', 'omnisql', 'connections.json'),
          validate(value) {
            if (value && existsSync(expandPath(value)))
              return 'File already exists. Choose a new file or use the existing-config path.';
          },
        })
      )
    );
    const ids = writeSetupConfig(file, config);
    environment = {
      OMNISQL_CONFIG_FILE: file,
      OMNISQL_DISCOVER_WORKSPACE: 'false',
      OMNISQL_ALLOWED_CONNECTIONS: ids.join(','),
      OMNISQL_READ_ONLY: String(Object.values(config.connections).every((entry) => entry.readOnly)),
    };
    note(
      'Connection settings stay in this private local file (0600 on Unix). Password input is masked and never passed in command arguments. An agent with unrestricted local file access can still read the file.',
      'Local storage'
    );
  } else if (mode === 'config') {
    const file = expandPath(
      answer(
        await text({
          message: 'OmniSQL connection configuration path',
          validate(value) {
            try {
              validateSetupConfig(expandPath(value || ''));
            } catch {
              return 'Enter a valid configuration with at least one connection and available credential environment references.';
            }
          },
        })
      )
    );
    environment = {
      OMNISQL_CONFIG_FILE: file,
      OMNISQL_DISCOVER_WORKSPACE: 'false',
      OMNISQL_ALLOWED_CONNECTIONS: validateSetupConfig(file).join(','),
      OMNISQL_READ_ONLY: 'false',
    };
  } else {
    const defaultWorkspace = new WorkspaceConfigParser({
      workspacePath: process.env.OMNISQL_WORKSPACE,
    }).getWorkspacePath();
    const workspace = expandPath(
      answer(
        await text({
          message: 'DBeaver workspace directory',
          defaultValue: defaultWorkspace,
          validate(value) {
            return value && existsSync(expandPath(value)) ? undefined : 'Directory not found.';
          },
        })
      )
    );
    const available = await workspaceConnections(workspace);
    note(
      available.map(({ id }) => id).join(', ') || 'No saved connection IDs found.',
      'Available connection IDs'
    );
    const allowed = answer(
      await text({
        message: 'Connection IDs to allow (comma-separated; required)',
        validate(value) {
          return value?.trim()
            ? undefined
            : 'Select explicit IDs so unrelated connections stay hidden.';
        },
      })
    );
    const ids = allowed.split(',').map((id) => id.trim());
    if (ids.some((id) => !available.some((entry) => entry.id === id)))
      throw new Error('A selected connection ID was not found in the workspace.');
    const readOnly = answer(
      await confirm({ message: 'Allow read-only queries only?', initialValue: true })
    );
    environment = {
      OMNISQL_WORKSPACE: workspace,
      OMNISQL_DISCOVER_WORKSPACE: 'true',
      OMNISQL_ALLOWED_CONNECTIONS: ids.join(','),
      OMNISQL_READ_ONLY: String(readOnly),
    };
  }
  installClient([client], environment);
  outro('Ready. Start a new client session, then ask it to list your database connections.');
}

type DirectEntry = {
  driver: string;
  readOnly: boolean;
  database: string;
  host?: string;
  port?: number;
  user?: string;
  passwordEnv?: string;
  properties: Record<string, string>;
  policy?: { allowTables?: string[]; denyTables?: string[] };
  limits: { maxRows: number; timeoutMs: number };
};
async function collectDirectConfig(): Promise<{
  version: 1;
  connections: Record<string, DirectEntry>;
}> {
  const connections: Record<string, DirectEntry> = Object.create(null);
  do {
    const id = answer(
      await text({
        message: 'Logical connection ID (visible to the agent)',
        validate(value) {
          return value &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
            !Object.hasOwn(connections, value)
            ? undefined
            : 'Use a unique ID with letters, numbers, dots, underscores or hyphens.';
        },
      })
    );
    const driver = answer(
      await select({
        message: 'Database engine',
        options: [
          'postgresql',
          'mysql',
          'mariadb',
          'mssql',
          'oracle',
          'sqlite',
          'duckdb',
          'clickhouse',
        ].map((value) => ({ value, label: value })),
      })
    );
    const local = driver === 'sqlite' || driver === 'duckdb';
    const entry: DirectEntry = {
      driver,
      readOnly: true,
      database: '',
      properties: {},
      limits: { maxRows: 1000, timeoutMs: 30000 },
    };
    if (!local) {
      entry.host = answer(
        await text({
          message: 'Database hostname',
          validate(value) {
            return value && !/[\s/@?#]/.test(value)
              ? undefined
              : 'Enter a hostname, without a URI or credentials.';
          },
        })
      );
      const defaults: Record<string, number> = {
        postgresql: 5432,
        mysql: 3306,
        mariadb: 3306,
        mssql: 1433,
        oracle: 1521,
        clickhouse: 8443,
      };
      entry.port = Number(
        answer(
          await text({
            message: 'Port',
            defaultValue: String(defaults[driver]),
            validate(value) {
              return value && /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
                ? undefined
                : 'Use a port between 1 and 65535.';
            },
          })
        )
      );
      entry.user = answer(
        await text({
          message: 'Database username',
          validate(value) {
            return value?.trim() ? undefined : 'Enter a username.';
          },
        })
      );
      const credentials = answer(
        await select({
          message: 'Database credentials',
          options: [
            {
              value: 'private',
              label: 'Enter password (masked)',
              hint: 'Stored in the private local configuration',
            },
            {
              value: 'env',
              label: 'Reference an existing environment variable',
              hint: 'Must also be available to the client at runtime',
            },
            {
              value: 'none',
              label: 'No password',
              hint: 'Configure advanced authentication in the JSON file',
            },
          ],
        })
      );
      if (credentials === 'private') {
        const value = answer(
          await password({
            message: 'Database password (stored locally, never in client arguments)',
          })
        );
        if (value) entry.properties.password = value;
      } else if (credentials === 'env') {
        entry.passwordEnv = answer(
          await text({
            message: 'Password environment variable name',
            validate(value) {
              return value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && process.env[value]
                ? undefined
                : 'Enter the name of an available environment variable.';
            },
          })
        );
      }
      const tls = answer(
        await confirm({ message: 'Use TLS with verified server certificates?', initialValue: true })
      );
      if (driver === 'postgresql' || driver === 'mysql' || driver === 'mariadb')
        entry.properties.sslmode = tls ? 'verify-full' : 'disable';
      if (driver === 'mssql') {
        entry.properties.encrypt = String(tls);
        entry.properties.trustServerCertificate = 'false';
      }
      if (driver === 'clickhouse') entry.properties.ssl = String(tls);
      if (driver === 'oracle') entry.properties.protocol = tls ? 'tcps' : 'tcp';
    }
    entry.database = answer(
      await text({
        message: local ? 'Existing database file path' : 'Database name / service',
        validate(value) {
          if (!value?.trim()) return 'A database is required.';
          if (local && !existsSync(expandPath(value))) return 'Database file not found.';
        },
      })
    );
    if (local) entry.database = expandPath(entry.database);
    entry.readOnly = answer(
      await confirm({ message: `Keep ${id} read-only?`, initialValue: true })
    );
    for (const [key, message] of [
      ['allowTables', 'Allowed tables (comma-separated; Enter for all)'],
      ['denyTables', 'Blocked tables (comma-separated; Enter for none)'],
    ] as const) {
      const value = answer(await text({ message }));
      if (value?.trim())
        (entry.policy ??= {})[key] = value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean);
    }
    connections[id] = entry;
  } while (
    Object.keys(connections).length < 128 &&
    answer(await confirm({ message: 'Add another database instance?', initialValue: false }))
  );
  return { version: 1, connections };
}

function expandPath(value: string): string {
  return resolve(
    value === '~' ? homedir() : value.startsWith('~/') ? homedir() + value.slice(1) : value
  );
}
