import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkspaceClient } from '../src/workspace-client.js';
const available = spawnSync('sqlite3', ['--version']).status === 0;

describe.skipIf(!available)('SQLite execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnisql-sqlite-'));
  const connection = {
    id: 'demo',
    name: 'demo',
    driver: 'sqlite',
    url: '',
    database: join(directory, 'demo.db'),
  };
  const client = new WorkspaceClient();
  beforeAll(async () => {
    await client.executeQuery(
      connection,
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, score INTEGER DEFAULT 0)'
    );
    await client.executeQuery(
      connection,
      `INSERT INTO notes VALUES (1, 'Comma, newline\nand "quotes"', NULL)`
    );
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  it('preserves commas, newlines, quotes, and nulls', async () => {
    const result = await client.executeQuery(connection, 'SELECT * FROM notes');
    expect(result.rows).toEqual([[1, 'Comma, newline\nand "quotes"', null]]);
  });
  it('reads table names and SQLite schema flags', async () => {
    expect(await client.listTables(connection)).toMatchObject([
      { name: 'notes', table_name: 'notes' },
    ]);
    const schema = await client.getTableSchema(connection, 'notes');
    expect(schema.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', isPrimaryKey: true }),
        expect.objectContaining({ name: 'body', nullable: false }),
        expect.objectContaining({ name: 'score', defaultValue: '0' }),
      ])
    );
  });
  it('returns query plans as structured rows', async () => {
    const result = await client.executeQuery(
      connection,
      'EXPLAIN QUERY PLAN SELECT * FROM notes WHERE id=1'
    );
    expect(result.columns).toContain('detail');
    expect(JSON.stringify(result.rows)).toMatch(/SEARCH|SCAN/);
  });
  it('blocks SQLite host file functions', async () => {
    await expect(
      client.executeQuery(connection, `SELECT writefile('/tmp/omnisql-unsafe-test', 'blocked')`)
    ).rejects.toThrow(/SQLite error/);
  });
  it('rejects CLI commands and never treats multiline SQL as CLI input', async () => {
    await expect(client.executeQuery(connection, '.shell echo unsafe')).rejects.toThrow(
      /dot commands/
    );
    await expect(client.executeQuery(connection, 'SELECT 1;\n.shell echo unsafe')).rejects.toThrow(
      /SQLite error/
    );
  });
});
