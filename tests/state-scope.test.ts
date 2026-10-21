import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceConfigParser } from '../src/config-parser.js';
import { setEnv, restoreEnv } from './support/environment.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-state-scope-'));
afterEach(() => {
  restoreEnv();
  for (const file of fs.readdirSync(root))
    fs.rmSync(path.join(root, file), { force: true, recursive: true });
});
function workspace(name: string) {
  const dir = path.join(root, name);
  const project = path.join(dir, 'General', '.dbeaver');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, 'data-sources.json'),
    JSON.stringify({
      connections: {
        saved: {
          name: 'Saved connection',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: { host: '127.0.0.1', database: 'fixture', user: 'reader' },
        },
      },
    })
  );
  return dir;
}
describe('effective connection-source identity', () => {
  it('refuses database overrides that collide with another saved connection identity', async () => {
    setEnv('OMNISQL_CONFIG_FILE', undefined);
    setEnv('OMNISQL_DISCOVER_WORKSPACE', undefined);
    const dir = workspace('collision');
    const file = path.join(dir, 'General', '.dbeaver', 'data-sources.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.connections['saved/db'] = {
      ...config.connections.saved,
      name: 'Separate saved connection',
    };
    fs.writeFileSync(file, JSON.stringify(config));
    const parser = new WorkspaceConfigParser({ workspacePath: dir });
    expect((await parser.getConnection('saved/db'))?.baseId).toBe('saved/db');
    await expect(parser.getConnection('saved', 'db')).rejects.toThrow(/conflicts/);
  });
  it('does not discover unrelated saved connections in direct-config mode', async () => {
    const dir = workspace('saved');
    const file = path.join(root, 'direct.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connections: { direct: { driver: 'postgres', host: 'localhost' } },
      })
    );
    setEnv('OMNISQL_CONFIG_FILE', file);
    setEnv('OMNISQL_DISCOVER_WORKSPACE', undefined);
    const parser = new WorkspaceConfigParser({ workspacePath: dir });
    expect((await parser.parseConnections()).map((c) => c.id)).toEqual(['direct']);
    setEnv('OMNISQL_DISCOVER_WORKSPACE', 'true');
    expect((await parser.parseConnections()).map((c) => c.id)).toEqual(['direct', 'saved']);
  });
  it('binds scope to the actual parser workspace and refreshed source revisions', () => {
    setEnv('OMNISQL_CONFIG_FILE', undefined);
    setEnv('OMNISQL_DISCOVER_WORKSPACE', undefined);
    const dir = workspace('a');
    const parser = new WorkspaceConfigParser({ workspacePath: dir });
    const before = parser.stateRevision();
    const identity = parser.sourceIdentity();
    setEnv('OMNISQL_WORKSPACE', workspace('b'));
    expect(parser.stateRevision()).toBe(before);
    expect(
      new WorkspaceConfigParser({ workspacePath: process.env.OMNISQL_WORKSPACE }).stateRevision()
    ).not.toBe(before);
    fs.appendFileSync(path.join(dir, 'General', '.dbeaver', 'data-sources.json'), '\n');
    expect(parser.stateRevision()).not.toBe(before);
    expect(parser.sourceIdentity()).toBe(identity);
  });
  it('revokes private state after credential environment or config source changes', () => {
    const config = {
      version: 1,
      connections: {
        direct: { driver: 'postgres', host: 'localhost', passwordEnv: 'SCOPE_FIXTURE_PASSWORD' },
      },
    };
    const first = path.join(root, 'first.json');
    const second = path.join(root, 'second.json');
    fs.writeFileSync(first, JSON.stringify(config));
    fs.writeFileSync(second, JSON.stringify(config));
    setEnv('OMNISQL_CONFIG_FILE', first);
    setEnv('SCOPE_FIXTURE_PASSWORD', 'first-fixture-value');
    const parser = new WorkspaceConfigParser({});
    const before = parser.stateRevision();
    setEnv('SCOPE_FIXTURE_PASSWORD', 'second-fixture-value');
    expect(parser.stateRevision()).not.toBe(before);
    const changed = parser.stateRevision();
    setEnv('OMNISQL_CONFIG_FILE', second);
    expect(parser.stateRevision()).not.toBe(changed);
  });
});
