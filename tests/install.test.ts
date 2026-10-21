import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, mock, afterEach } from 'bun:test';
mock.module('node:child_process', () => ({ spawnSync: vi.fn() }));
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInstallCommand, clientInvocation, installClient } from '../src/install.js';

afterEach(() => vi.restoreAllMocks());

describe('MCP client registration', () => {
  const launch = process.versions.bun
    ? [process.execPath, 'x', '--bun', '--yes', 'omnisql-mcp@latest']
    : ['npx', '-y', 'omnisql-mcp@latest'];
  it.each([
    [
      'claude',
      ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'omnisql', '--', ...launch],
    ],
    ['codex', ['mcp', 'add', 'omnisql', '--', ...launch]],
    ['opencode', ['mcp', 'add', 'omnisql', '--global', '--', ...launch]],
  ])('uses the native %s registration command', (client, args) => {
    expect(buildInstallCommand(client)).toEqual({ command: client, args });
  });

  it.each(['claude', 'codex', 'opencode'])(
    'passes read-only settings to %s before the server command',
    (client) => {
      const { args } = buildInstallCommand(client, true);
      expect(args.indexOf('--env')).toBeLessThan(args.indexOf('--'));
      expect(args).toContain('OMNISQL_READ_ONLY=true');
      if (client === 'claude')
        expect(args.indexOf('--env')).toBeGreaterThan(args.indexOf('omnisql'));
    }
  );

  it('does not invoke clients for dry runs or invalid options', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnSync.mockClear();
    installClient(['claude', '--dry-run']);
    expect(() => installClient(['claude', '--unknown'])).toThrow(/Supported install options/);
    expect(() => installClient(['unknown'])).toThrow(/Choose a client/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports missing clients and failed registrations', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnSync.mockReturnValue({
      error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
    } as never);
    expect(() =>
      installClient(['codex'], {
        OMNISQL_WORKSPACE: tmpdir(),
        OMNISQL_ALLOWED_CONNECTIONS: 'fixture',
      })
    ).toThrow(/not on PATH/);
    spawnSync.mockReturnValue({ status: 1 } as never);
    expect(() =>
      installClient(['codex'], {
        OMNISQL_WORKSPACE: tmpdir(),
        OMNISQL_ALLOWED_CONNECTIONS: 'fixture',
      })
    ).toThrow(/exit 1/);
  });
});

describe('installer environment', () => {
  it('keeps workspace paths and allowlists as individual arguments', () => {
    const { args } = buildInstallCommand('claude', false, {
      OMNISQL_WORKSPACE: '/Users/test/My Databases/workspace6',
      OMNISQL_ALLOWED_CONNECTIONS: 'dev,staging',
    });
    expect(args).toContain('OMNISQL_WORKSPACE=/Users/test/My Databases/workspace6');
    expect(args).toContain('OMNISQL_ALLOWED_CONNECTIONS=dev,staging');
  });
});

describe('safe registration settings', () => {
  it('defaults to read-only and requires an explicit write opt-in', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const safe = vi.spyOn(console, 'error');
    installClient(['codex', '--dry-run']);
    expect(safe.mock.calls.flat().join(' ')).toContain('OMNISQL_READ_ONLY=true');
    safe.mockClear();
    installClient(['codex', '--allow-writes', '--dry-run']);
    expect(safe.mock.calls.flat().join(' ')).toContain('OMNISQL_READ_ONLY=false');
  });
  it('does not accept secret-bearing environment settings', () => {
    expect(() => buildInstallCommand('codex', true, { DATABASE_PASSWORD: randomUUID() })).toThrow(
      /setup settings only/
    );
  });
  it('keeps Windows shim arguments out of command source', () => {
    const arg = 'OMNISQL_CONFIG_FILE=C:\\My Databases\\a & b%done!.json';
    const invocation = clientInvocation('codex.cmd', [arg], 'win32');
    expect(invocation.command).toMatch(/cmd(?:\.exe)?$/i);
    expect(invocation.args).toContain('/v:off');
    expect(invocation.args.at(-1)).not.toContain('My Databases');
    expect(invocation.env.OMNISQL_INSTALL_ARG_1).toBe(arg);
    expect(() => clientInvocation('codex.cmd', ['injected" & whoami'], 'win32')).toThrow(/quotes/);
  });
});

it('rejects conflicting setup sources and unknown configured allowlist IDs', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() =>
    installClient(['codex', '--config', '/unused', '--workspace', '/unused', '--dry-run'])
  ).toThrow(/either --config or --workspace/);
  const directory = fs.mkdtempSync(join(tmpdir(), 'omnisql-install-flags-'));
  try {
    const file = join(directory, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connections: { analytics: { driver: 'sqlite', database: '/unused.db' } },
      }),
      { mode: 0o600 }
    );
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'typo', '--dry-run'])
    ).toThrow(/configured connection ID/);
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'analytics,', '--dry-run'])
    ).toThrow(/configured connection ID/);
    expect(() =>
      installClient(['codex', '--config', file, '--allow', 'analytics/reporting', '--dry-run'])
    ).not.toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
