import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfiguredConnections } from '../src/connections-config.js';
import { AccessPolicy } from '../src/policy/access.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-config-test-'));
const file = path.join(directory, 'connections.json');
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(file, { force: true });
});
function load(connections: object, defaults?: object) {
  fs.writeFileSync(file, JSON.stringify({ version: 1, defaults, connections }));
  return loadConfiguredConnections(file);
}
describe('one server, independent database instances', () => {
  it('keeps credentials, databases, policies and limits separate', () => {
    vi.stubEnv('TEST_SALES_PASSWORD', 'sales-only');
    vi.stubEnv(
      'TEST_METRICS_URL',
      'postgresql://metrics:metrics-only@localhost:5433/reporting?sslmode=verify-full'
    );
    const [sales, metrics] = load({
      sales: {
        driver: 'postgresql',
        host: 'localhost',
        database: 'sales',
        user: 'sales',
        passwordEnv: 'TEST_SALES_PASSWORD',
        policy: { allowTables: ['public.orders'] },
        limits: { maxRows: 5, timeoutMs: 2000 },
      },
      metrics: {
        driver: 'postgresql',
        urlEnv: 'TEST_METRICS_URL',
        readOnly: false,
        policy: { allowTables: ['public.metrics'] },
        limits: { maxRows: 50, poolMax: 2 },
      },
    });
    const p = new AccessPolicy();
    expect(sales.readonly).toBe(true);
    expect(metrics.readonly).toBe(false);
    expect(sales.properties?.password).toBe('sales-only');
    expect(metrics.properties?.password).toBe('metrics-only');
    expect(metrics.database).toBe('reporting');
    expect(metrics.port).toBe(5433);
    expect(metrics.properties?.sslmode).toBe('verify-full');
    expect(sales.limits?.maxRows).toBe(5);
    expect(metrics.limits?.maxRows).toBe(50);
    expect(p.allowsTable(sales, 'public.orders')).toBe(true);
    expect(p.allowsTable(metrics, 'public.orders')).toBe(false);
    expect(() => p.assertQuery(sales, 'DELETE FROM public.orders WHERE id=1', false)).toThrow(
      /read.only/
    );
    expect(() =>
      p.assertQuery(metrics, 'DELETE FROM public.metrics WHERE id=1', false)
    ).not.toThrow();
  });
  it('defaults apply without allowing a connection to widen table access', () => {
    const [c] = load(
      { sales: { driver: 'postgres', policy: { allowTables: ['*.*'] } } },
      { policy: { allowTables: ['public.orders'] } }
    );
    expect(new AccessPolicy().allowsTable(c, 'private.payroll')).toBe(false);
  });
  it('rejects typoed settings, invalid types, traversal IDs, and missing credentials', () => {
    for (const cfg of [
      { sales: { driver: 'postgres', readonly: true } },
      { sales: { driver: 'postgres', readOnly: 'false' } },
      { '../sales': { driver: 'postgres' } },
      { sales: { driver: 'postgres', limits: { poolMax: 0 } } },
      { sales: { driver: 'postgres', passwordEnv: 'OMNISQL_MISSING_TEST_CREDENTIAL' } },
    ])
      expect(() => load(cfg)).toThrow();
  });
});
