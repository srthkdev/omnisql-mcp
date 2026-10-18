import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceClient } from '../src/workspace-client.js';
import { buildSchemaQuery } from '../src/utils.js';
describe('scoped catalog metadata', () => {
  it('pins server catalogs to the selected schema and database', () => {
    expect(buildSchemaQuery('postgresql', 'private.orders')).toContain("table_schema = 'private'");
    expect(buildSchemaQuery('postgresql', 'orders')).toContain('current_schema()');
    expect(buildSchemaQuery('mysql', 'warehouse.orders')).toContain("TABLE_SCHEMA = 'warehouse'");
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
});
