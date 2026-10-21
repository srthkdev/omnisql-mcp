import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSetupConfig, writeSetupConfig } from '../src/install-config.js';

const directories: string[] = [];
function temp() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'omnisql-setup-'));
  directories.push(directory);
  return directory;
}
afterEach(() =>
  directories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
);
const config = {
  version: 1,
  connections: {
    analytics: {
      driver: 'postgresql',
      host: 'localhost',
      database: 'test',
      passwordEnv: 'OMNISQL_TEST_SETUP_PASSWORD',
      readOnly: true,
    },
    writer: {
      driver: 'sqlite',
      database: '/unused.db',
      readOnly: false,
      policy: { denyTables: ['private.*'] },
    },
  },
};

describe('private connection setup', () => {
  it('preserves separate policies and references without persisting environment secrets', () => {
    process.env.OMNISQL_TEST_SETUP_PASSWORD = 'synthetic-fixture-secret';
    try {
      const file = join(temp(), 'new directory', 'connections.json');
      expect(writeSetupConfig(file, config)).toEqual(['analytics', 'writer']);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('synthetic-fixture-secret');
      expect(JSON.parse(content).connections.writer.readOnly).toBe(false);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => writeSetupConfig(file, config)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    } finally {
      delete process.env.OMNISQL_TEST_SETUP_PASSWORD;
    }
  });

  it('refuses existing and broken symlinks without modifying their targets', () => {
    const directory = temp();
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, link);
    expect(() => writeSetupConfig(link, config)).toThrow(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    fs.unlinkSync(link);
    fs.symlinkSync(join(directory, 'missing'), link);
    expect(() => writeSetupConfig(link, config)).toThrow(/symlink/);
  });

  it('removes rejected new files and never includes invalid JSON secrets in errors', () => {
    const directory = temp();
    const file = join(directory, 'invalid.json');
    expect(() => writeSetupConfig(file, { version: 1, connections: {} })).toThrow(/at least one/);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, '{"secret": "do-not-expose-me", broken}');
    try {
      validateSetupConfig(file);
      throw new Error('unexpected success');
    } catch (error) {
      expect(String(error)).not.toContain('do-not-expose-me');
    }
  });

  it('rejects ambiguous allowlist IDs before registration', () => {
    const file = join(temp(), 'connections.json');
    expect(() =>
      writeSetupConfig(file, {
        version: 1,
        connections: { 'one,two': { driver: 'sqlite', database: '/x' } },
      })
    ).toThrow(/connection IDs/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
