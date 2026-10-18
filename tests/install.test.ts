import { describe, it, expect, vi, mock, afterEach } from 'bun:test';
mock.module('node:child_process', () => ({ spawnSync: vi.fn() }));
import { spawnSync } from 'node:child_process';
import { buildInstallCommand, installClient } from '../src/install.js';

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
    expect(() => installClient(['codex'])).toThrow(/not on PATH/);
    spawnSync.mockReturnValue({ status: 1 } as never);
    expect(() => installClient(['codex'])).toThrow(/exit 1/);
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
