import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { intro, outro, select, text, confirm, isCancel, cancel, note } from '@clack/prompts';
import { WorkspaceConfigParser } from './config-parser.js';

export function buildInstallCommand(
  client: string,
  readOnly = false,
  environment: Record<string, string> = {}
): { command: string; args: string[] } {
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

export function installClient(args: string[], environment: Record<string, string> = {}): void {
  const [client, ...flags] = args;
  if (flags.some((flag) => !['--read-only', '--dry-run'].includes(flag))) {
    throw new Error('Supported install options: --read-only, --dry-run');
  }
  const { command, args: commandArgs } = buildInstallCommand(
    client,
    flags.includes('--read-only'),
    environment
  );
  console.error([command, ...commandArgs].join(' '));
  if (flags.includes('--dry-run')) return;
  // Delegate to the client so it owns its config format, scope, and validation.
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error(
        `${command} is not installed or is not on PATH. Install the client first, then rerun this command.`
      );
    }
    throw result.error;
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

export async function runInstall(args: string[]): Promise<void> {
  if (args.length > 0) {
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
  const client = answer(
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
  const readOnly = answer(
    await confirm({ message: 'Allow read-only queries only?', initialValue: true })
  );
  const defaultWorkspace = new WorkspaceConfigParser({
    workspacePath: process.env.OMNISQL_WORKSPACE,
  }).getWorkspacePath();
  const workspace = answer(
    await text({
      message: 'DBeaver workspace directory',
      placeholder: defaultWorkspace,
      defaultValue: defaultWorkspace,
      validate(value) {
        const target = value?.trim() || defaultWorkspace;
        return existsSync(expandPath(target))
          ? undefined
          : 'Directory not found. Open DBeaver or enter its workspace directory.';
      },
    })
  );
  const allowed = answer(
    await text({
      message: 'Connections to allow (comma-separated IDs or names; Enter for all)',
      placeholder: 'All saved connections',
    })
  );
  const environment: Record<string, string> = {
    OMNISQL_WORKSPACE: expandPath(workspace?.trim() || defaultWorkspace),
    OMNISQL_READ_ONLY: String(readOnly),
  };
  if (allowed?.trim()) environment.OMNISQL_ALLOWED_CONNECTIONS = allowed.trim();
  note(
    'Uses the database and SSH credentials already saved in DBeaver. No OmniSQL API key is needed.',
    'Authentication'
  );
  installClient([client], environment);
  outro('Ready. Start a new client session, then ask it to list your database connections.');
}

function expandPath(value: string): string {
  return resolve(
    value === '~' ? homedir() : value.startsWith('~/') ? homedir() + value.slice(1) : value
  );
}
