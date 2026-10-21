import { describe, it, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceClient } from '../src/workspace-client.js';
import { buildSchemaQuery } from '../src/utils.js';
import { tableNameParts, quoteQualifiedIdentifier } from '../src/metadata/identifiers.js';
import { indexesAndConstraints } from '../src/metadata/catalog.js';
describe('scoped catalog metadata', () => {
  it('accepts exact catalog names and escapes metadata literals (issue #79)', async () => {
    for (const name of ['my-table', 'two words', '123table', 'München', "owner's table"])
      expect(buildSchemaQuery('postgres', name)).toContain(
        `table_name = '${name.replace(/'/g, "''")}'`
      );
    expect(buildSchemaQuery('postgres', '"schema.name"."table.name"')).toContain(
      "table_schema = 'schema.name' AND table_name = 'table.name'"
    );
    expect(tableNameParts('"public"."a""b"')).toEqual(['public', 'a"b']);
    for (const invalid of ['', 'public.', 'a.b.c', '"unfinished', 'table\u0000'])
      expect(() => buildSchemaQuery('postgres', invalid)).toThrow();
    const statements: string[] = [];
    await indexesAndConstraints(
      { id: 'pg', name: 'pg', driver: 'postgres', url: '' },
      "owner's table",
      async (sql) => {
        statements.push(sql);
        return { columns: [], rows: [], rowCount: 0, executionTime: 0 };
      }
    );
    expect(statements).toHaveLength(2);
    expect(statements.every((sql) => sql.includes("t.relname='owner''s table'"))).toBe(true);
  });
  it('quotes qualified write targets separately for each SQL grammar', () => {
    expect(quoteQualifiedIdentifier('public.orders', 'postgres')).toBe('"public"."orders"');
    expect(quoteQualifiedIdentifier('warehouse.orders', 'mysql')).toBe('`warehouse`.`orders`');
    expect(quoteQualifiedIdentifier('dbo.orders', 'mssql')).toBe('[dbo].[orders]');
    expect(quoteQualifiedIdentifier('"public"."a""b"', 'postgres')).toBe('"public"."a""b"');
  });
  it('rejects truncated discovery instead of claiming the catalog is complete', async () => {
    const client = new WorkspaceClient();
    const c = { id: 'fixture', name: 'fixture', url: '', driver: 'postgresql' };
    const query = spyOn(client, 'executeQuery').mockResolvedValue({
      columns: ['name'],
      rows: [['visible']],
      rowCount: 1,
      executionTime: 0,
      truncated: true,
    });
    try {
      await expect(client.listTables(c)).rejects.toThrow(/catalog.*incomplete|narrow/i);
      await expect(client.listDatabases(c)).rejects.toThrow(/catalog.*incomplete|narrow/i);
    } finally {
      query.mockRestore();
      await client.close();
    }
  });
  it('pins server catalogs to the selected schema and database', () => {
    expect(buildSchemaQuery('postgresql', 'private.orders')).toContain("table_schema = 'private'");
    expect(buildSchemaQuery('postgresql', 'orders')).toContain('current_schema()');
    expect(buildSchemaQuery('mysql', 'warehouse.orders')).toContain(
      "BINARY TABLE_SCHEMA=BINARY 'warehouse'"
    );
    expect(buildSchemaQuery('mssql', 'dbo.orders')).toContain('TABLE_CATALOG = DB_NAME()');
  });
  it('reads SQLite indexes, composite keys, references, and page sizes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-catalog-test-'));
    const database = path.join(dir, 'fixture.db');
    const c = { id: 'fixture', name: 'fixture', url: '', driver: 'sqlite', database };
    const client = new WorkspaceClient();
    try {
      execFileSync('sqlite3', [
        database,
        'CREATE TABLE parent(a INTEGER,b INTEGER,PRIMARY KEY(a,b)); CREATE TABLE child(id INTEGER PRIMARY KEY,a INTEGER,b INTEGER,FOREIGN KEY(a,b) REFERENCES parent(a,b));CREATE INDEX child_ab ON child(a,b);INSERT INTO child VALUES(1,NULL,NULL);',
      ]);
      const schema = await client.getTableSchema(c, 'child');
      expect(schema.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'child_ab', columns: ['a', 'b'], unique: false }),
        ])
      );
      expect(schema.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'FOREIGN_KEY',
            columns: ['a', 'b'],
            referencedTable: 'parent',
            referencedColumns: ['a', 'b'],
          }),
        ])
      );
      expect(schema.columns.find((c) => c.name === 'id')?.nullable).toBe(false);
      const stats = await client.getTableStats(c, 'child');
      expect(stats.estimated).toBe(true);
      if (stats.totalBytes !== null) expect(BigInt(stats.totalBytes)).toBeGreaterThan(0n);
      const all = await client.getDatabaseStats(c);
      expect(all.tableCount).toBe(2);
      expect(all.serverVersion).toMatch(/^\d+\./);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('resolves quoted SQLite case variants before allowing queries or metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-case-test-'));
    const database = path.join(dir, 'fixture.db');
    const client = new WorkspaceClient();
    const c = {
      id: 'fixture',
      name: 'fixture',
      url: '',
      driver: 'sqlite',
      database,
      accessRules: [{ allowTables: ['*', 'main.*'], denyTables: ['main.customers'] }],
    };
    try {
      execFileSync('sqlite3', [
        database,
        'CREATE TABLE orders(id INTEGER);CREATE TABLE customers(secret TEXT);',
      ]);
      await client.executeQuery(c, 'SELECT * FROM "ORDERS"');
      await expect(client.executeQuery(c, 'SELECT * FROM "CUSTOMERS"')).rejects.toThrow(
        /Table.*policy/
      );
      await expect(client.getTableSchema(c, 'main.CUSTOMERS')).rejects.toThrow(/Table.*policy/);
      await expect(client.getTableStats(c, 'CUSTOMERS')).rejects.toThrow(/Table.*policy/);
      expect((await client.listTables(c)).map((t) => t.name)).toEqual(['orders']);
      expect((await client.getDatabaseStats(c)).tableCount).toBe(1);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
