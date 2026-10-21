import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccessPolicy } from '../src/policy/access.js';
import { analyzeSql } from '../src/policy/analyzer.js';
import type { DatabaseConnection } from '../src/types.js';
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function policy(rule: object) {
  const dir = mkdtempSync(join(tmpdir(), 'omnisql-identifiers-'));
  folders.push(dir);
  const file = join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify({ version: 1, defaults: rule }));
  return new AccessPolicy(file);
}
const connection = (driver: string): DatabaseConnection => ({
  id: 'reports',
  name: 'reports',
  driver,
  url: '',
  database: 'reports',
});
describe('database scope in SQL names', () => {
  it('checks expressions inside PostgreSQL arrays and subscripts', () => {
    const p = policy({});
    for (const sql of [
      "SELECT ARRAY[nextval('seq')]",
      "SELECT values[nextval('seq')] FROM public.orders",
    ])
      expect(() => p.assertQuery(connection('postgres'), sql, true)).toThrow(/not permitted/);
    expect(() => p.assertQuery(connection('postgres'), 'SELECT ARRAY[1,2][1]', true)).not.toThrow();
    expect(analyzeSql('SELECT ARRAY[1,2][1]', 'postgres').writes).toBe(false);
    expect(() =>
      p.assertQuery(connection('mssql'), 'SELECT [update] FROM dbo.orders', true)
    ).not.toThrow();
  });
  it('retains physical references when CTE aliases differ under native naming rules', () => {
    const postgres = analyzeSql(
      'WITH Ä AS (SELECT * FROM public.orders) SELECT * FROM ä',
      'postgres'
    );
    expect(postgres.relations.some((parts) => parts[0].value === 'ä')).toBe(true);
    const sqlServer = analyzeSql(
      'WITH Orders AS (SELECT * FROM dbo.orders) SELECT * FROM orders',
      'mssql'
    );
    expect(
      sqlServer.relations.some((parts) => parts.length === 1 && parts[0].value === 'orders')
    ).toBe(true);
    for (const driver of ['sqlite', 'duckdb'])
      expect(
        analyzeSql('WITH "Orders" AS (SELECT 1) SELECT * FROM orders', driver).relations
      ).toEqual([]);
  });
  it.each([
    ['mysql', 'SELECT * FROM private_db.orders', 'SELECT * FROM reports.orders'],
    ['mariadb', 'SELECT * FROM private_db.orders', 'SELECT * FROM reports.orders'],
    ['mssql', 'SELECT * FROM private_db.dbo.orders', 'SELECT * FROM reports.dbo.orders'],
    ['postgres', 'SELECT * FROM private_db.public.orders', 'SELECT * FROM reports.public.orders'],
    ['clickhouse', 'SELECT * FROM private_db.orders', 'SELECT * FROM reports.orders'],
  ])('confines %s references to the selected database', (driver, denied, allowed) => {
    const p = policy({ databases: ['reports', 'private_db'] });
    expect(() => p.assertQuery(connection(driver), denied, true)).toThrow(
      /selected database|database scope/i
    );
    expect(() => p.assertQuery(connection(driver), allowed, true)).not.toThrow();
  });
  it('rejects linked-server references under an access policy', () => {
    const p = policy({ databases: ['reports'] });
    expect(() =>
      p.assertQuery(connection('mssql'), 'SELECT * FROM remote.reports.dbo.orders', true)
    ).toThrow(/linked.server|database scope/i);
  });
  it('applies database scope to function names too', () => {
    const p = policy({ databases: ['reports'], allowFunctions: ['private_db.dbo.report'] });
    expect(() =>
      p.assertQuery(connection('mssql'), 'SELECT private_db.dbo.report()', true)
    ).toThrow(/selected database|database scope/i);
  });
  it('rejects Oracle database links under a policy', () => {
    const p = policy({ databases: ['reports'] });
    expect(() => p.assertQuery(connection('oracle'), 'SELECT * FROM orders@remote', true)).toThrow(
      /database link|analyzed safely/
    );
  });
});
