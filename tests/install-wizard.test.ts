import { afterEach, describe, expect, it, mock, vi } from 'bun:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const answers: unknown[] = [];
const prompt = () => answers.shift();
mock.module('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  select: prompt,
  text: prompt,
  password: prompt,
  confirm: prompt,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
mock.module('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));
import { spawnSync } from 'node:child_process';
import { runInstall } from '../src/install.js';
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  answers.splice(0);
  directories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe('guided direct setup', () => {
  it('registers multiple instances with distinct policies and private masked credentials', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'omnisql-wizard-'));
    directories.push(directory);
    const file = join(directory, 'private setup.json');
    vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(true);
    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const priorHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(directory, 'codex');
    const fixture = join(directory, 'fixture.db');
    fs.writeFileSync(fixture, '');
    answers.push(
      'codex',
      'direct',
      'local',
      'sqlite',
      fixture,
      true,
      'public.*',
      'public.private',
      true,
      'analytics',
      'postgresql',
      'localhost',
      '5432',
      'reader',
      'private',
      'masked-synthetic-fixture',
      true,
      'warehouse',
      false,
      '',
      '',
      false,
      file
    );
    try {
      await runInstall([]);
      expect(answers).toHaveLength(0);
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(config.connections.local.readOnly).toBe(true);
      expect(config.connections.local.policy).toEqual({
        allowTables: ['public.*'],
        denyTables: ['public.private'],
      });
      expect(config.connections.analytics.readOnly).toBe(false);
      expect(config.connections.analytics.properties.sslmode).toBe('verify-full');
      expect(config.connections.analytics.properties.password).toBe('masked-synthetic-fixture');
      expect(JSON.stringify(spawnSync.mock.calls)).not.toContain('masked-synthetic-fixture');
      expect(stderr.mock.calls.flat().join(' ')).not.toContain('masked-synthetic-fixture');
      const registration = spawnSync.mock.calls.at(-1)!;
      expect(registration[1]).toContain('OMNISQL_ALLOWED_CONNECTIONS=local,analytics');
      expect(registration[1]).toContain('OMNISQL_DISCOVER_WORKSPACE=false');
      expect(registration[1]).toContain('OMNISQL_READ_ONLY=false');
    } finally {
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
    }
  });
  it('validates selected workspace IDs without reading an inherited direct config', async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'omnisql-workspace-'));
    directories.push(directory);
    const project = join(directory, 'workspace', 'General', '.dbeaver');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      join(project, 'data-sources.json'),
      JSON.stringify({
        connections: {
          selected: {
            name: 'selected',
            driver: 'sqlite',
            configuration: { database: '/fixture.db' },
          },
        },
      })
    );
    const previousConfig = process.env.OMNISQL_CONFIG_FILE,
      previousDiscovery = process.env.OMNISQL_DISCOVER_WORKSPACE,
      previousHome = process.env.CODEX_HOME;
    process.env.OMNISQL_CONFIG_FILE = join(directory, 'unrelated-private-config.json');
    process.env.OMNISQL_DISCOVER_WORKSPACE = 'false';
    process.env.CODEX_HOME = join(directory, 'codex');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInstall([
        'codex',
        '--workspace',
        join(directory, 'workspace'),
        '--allow',
        'selected',
      ]);
      expect(process.env.OMNISQL_CONFIG_FILE).toBe(
        join(directory, 'unrelated-private-config.json')
      );
      expect(process.env.OMNISQL_DISCOVER_WORKSPACE).toBe('false');
      await expect(
        runInstall(['codex', '--workspace', join(directory, 'workspace'), '--allow', 'missing'])
      ).rejects.toThrow(/existing workspace/);
    } finally {
      for (const [key, value] of [
        ['OMNISQL_CONFIG_FILE', previousConfig],
        ['OMNISQL_DISCOVER_WORKSPACE', previousDiscovery],
        ['CODEX_HOME', previousHome],
      ])
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
    }
  });
});
