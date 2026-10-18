import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccessPolicy } from '../src/policy/access.js';
import { analyzeSql, canonicalName } from '../src/policy/analyzer.js';
import { DatabaseConnection } from '../src/types.js';
const c: DatabaseConnection = {
  id: 'sales',
  name: 'Sales',
  driver: 'postgresql',
  database: 'app',
  url: '',
};
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function policy(rule: object, connections?: object): AccessPolicy {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-policy-test-'));
  const file = path.join(dir, 'policy.json');
  directories.push(dir);
  fs.writeFileSync(file, JSON.stringify({ version: 1, defaults: rule, connections }));
  return new AccessPolicy(file);
}
describe('access policies', () => {
  it('reloads changed policies and fails closed for malformed or removed files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-policy-reload-'));
    directories.push(dir);
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    const p = new AccessPolicy(file);
    const revision = p.revision();
    expect(p.allowsTable(c, 'public.orders')).toBe(true);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, defaults: { denyTables: ['public.orders'] } })
    );
    expect(p.allowsTable(c, 'public.orders')).toBe(false);
    expect(p.revision()).not.toBe(revision);
    fs.writeFileSync(file, '{broken');
    expect(() => p.allowsTable(c, 'public.orders')).toThrow();
    fs.unlinkSync(file);
    expect(() => p.allowsTable(c, 'public.orders')).toThrow();
  });
  it('checks every source in joins, subqueries, CTEs, and unions', () => {
    const p = policy({ allowTables: ['public.orders', 'public.customers'] });
    expect(() =>
      p.assertQuery(
        c,
        'WITH report AS (SELECT * FROM public.orders) SELECT count(*) FROM report',
        true
      )
    ).not.toThrow();
    for (const q of [
      'SELECT * FROM public.orders JOIN private.payroll USING (id)',
      'SELECT * FROM public.orders WHERE id IN (SELECT id FROM private.payroll)',
      'WITH report AS (SELECT * FROM private.payroll) SELECT * FROM report',
      'SELECT * FROM public.orders UNION SELECT * FROM private.payroll',
      'WITH orders AS (SELECT * FROM orders) SELECT * FROM orders',
      'WITH "ORDERS" AS (SELECT * FROM public.orders) SELECT * FROM orders',
      'SELECT * FROM "public.orders"',
    ])
      expect(() => p.assertQuery(c, q, true)).toThrow(/allowed|unsupported/);
  });
  it('does not fold quoted identifiers into an allowed object', () => {
    const p = policy({ allowTables: ['public.orders'] });
    expect(() => p.assertQuery(c, 'SELECT * FROM "public"."orders"', true)).not.toThrow();
    expect(() => p.assertQuery(c, 'SELECT * FROM public."ORDERS"', true)).toThrow(/Table/);
    expect(canonicalName([{ value: 'ORDERS', quoted: false }], 'oracle')).toBe('ORDERS');
  });
  it('denies take precedence; defaults cannot be widened per connection', () => {
    const p = policy(
      { allowTables: ['public.*'], denyTables: ['public.secrets'], databases: ['app'] },
      { sales: { allowTables: ['*.*'] } }
    );
    expect(p.allowsTable(c, 'public.orders')).toBe(true);
    expect(p.allowsTable(c, 'public.secrets')).toBe(false);
    expect(p.allowsTable(c, 'private.orders')).toBe(false);
    expect(p.allowsDatabase(c, 'other')).toBe(false);
  });
  it('blocks dynamic tables, settings, functions, and side effects', () => {
    const p = policy({ allowTables: ['public.orders'], readOnly: true });
    for (const q of [
      'SELECT public.mutate()',
      'SELECT * FROM public.orders FOR UPDATE',
      'SELECT * INTO copy FROM public.orders',
      "SELECT * FROM read_csv('/etc/passwd')",
    ])
      expect(() => p.assertQuery(c, q, true)).toThrow();
    expect(() =>
      p.assertQuery(c, "SELECT lower('hello'),count(*) FROM public.orders", true)
    ).not.toThrow();
    expect(() =>
      policy({ allowTables: ['public.orders'], denyFunctions: ['count'] }).assertQuery(
        c,
        'SELECT count(*) FROM public.orders',
        true
      )
    ).toThrow(/Function/);
  });
  it('blocks DDL that could move objects or cascade beyond an allowed table', () => {
    const p = policy({ allowTables: ['public.orders'] });
    for (const sql of [
      'DROP TABLE public.orders CASCADE',
      'ALTER TABLE public.orders SET SCHEMA private',
      "CREATE FUNCTION public.mutate() RETURNS int AS 'x' LANGUAGE SQL",
    ])
      expect(() => p.assertQuery(c, sql, false)).toThrow();
  });
  it('reports invalid configuration instead of silently disabling it', () => {
    expect(() => policy({ allowTable: ['public.orders'] })).toThrow(/Unknown policy/);
    expect(() => policy({ readOnly: 'false' })).toThrow(/boolean/);
    expect(policy({ allowTables: [] }).allowsTable(c, 'public.orders')).toBe(false);
  });
  it('analyzes each supported SQL grammar through the packaged WASM', () => {
    for (const driver of [
      'postgresql',
      'mysql',
      'mssql',
      'sqlite',
      'oracle',
      'duckdb',
      'clickhouse',
    ])
      expect(analyzeSql('SELECT 1', driver).writes).toBe(false);
  });
});
