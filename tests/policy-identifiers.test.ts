import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccessPolicy } from '../src/policy/access.js';
import { assertQueryAccess } from '../src/policy/identities.js';
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
describe('identity resolution for access policies', () => {
  it.each(['mssql', 'sqlserver', 'microsoft'])(
    'skips %s built-ins while still resolving table permissions',
    async (driver) => {
      const p = policy({ readOnly: true, allowTables: ['dbo.orders'] });
      const lookups: string[] = [];
      await assertQueryAccess(
        p,
        connection(driver),
        "SELECT LEN(name), GETDATE(), HASHBYTES('SHA2_256', name) FROM dbo.orders WHERE id = 1",
        false,
        async (sql) => {
          lookups.push(sql);
          return { truncated: false, rows: [[0, 'dbo', 'orders', 1]] };
        }
      );
      expect(lookups).toHaveLength(1);
      expect(lookups[0].match(/ AS ref/g)).toHaveLength(1);
      expect(lookups[0]).toContain('orders');
      expect(lookups[0]).not.toMatch(/LEN|GETDATE|HASHBYTES/);
    }
  );
  it.each(['postgres', 'mysql', 'sqlite', 'oracle', 'duckdb', 'clickhouse'])(
    'requires catalog authorization for SQL Server function names on %s',
    async (driver) => {
      const p = policy({ readOnly: true, allowTables: [] });
      expect(() => p.assertQuery(connection(driver), 'SELECT len(1)', true)).toThrow(
        /Function is not allowed/
      );
      const lookups: string[] = [];
      await expect(
        assertQueryAccess(p, connection(driver), 'SELECT len(1)', true, async (sql) => {
          lookups.push(sql);
          return { truncated: false, rows: [] };
        })
      ).rejects.toThrow(/Object not found/);
      expect(lookups).toHaveLength(1);
      expect(lookups[0].match(/ AS ref/g)).toHaveLength(1);
    }
  );
  it.each(['SELECT dbo.LEN(1)', 'SELECT [LEN](1)', 'SELECT "LEN"(1)'])(
    'resolves qualified or quoted functions: %s',
    async (sql) => {
      const p = policy({ readOnly: true, allowTables: [] });
      const lookups: string[] = [];
      await expect(
        assertQueryAccess(p, connection('mssql'), sql, true, async (lookup) => {
          lookups.push(lookup);
          return { truncated: false, rows: [] };
        })
      ).rejects.toThrow(/Object not found/);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]).toContain('sys.all_objects');
    }
  );
  it.each([['len'], ['getdate'], ['*']])('honors denyFunctions %j for built-ins', async (deny) => {
    const p = policy({ readOnly: true, denyFunctions: [deny] });
    let queried = false;
    await expect(
      assertQueryAccess(p, connection('microsoft'), 'SELECT LEN(1), GETDATE()', true, async () => {
        queried = true;
        return { truncated: false, rows: [] };
      })
    ).rejects.toThrow(/Function is not allowed/);
    expect(queried).toBe(false);
  });
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

describe('native function provenance', () => {
  it('resolves PostgreSQL builtins and tables together without requiring function grants', async () => {
    const p = policy({
      schemas: ['public'],
      allowTables: ['public.orders'],
      allowFunctions: ['safe.only'],
    });
    const lookups: string[] = [];
    await assertQueryAccess(
      p,
      connection('postgres'),
      'SELECT count(*), lower(name) FROM public.orders',
      true,
      async (sql) => {
        lookups.push(sql);
        return {
          truncated: false,
          rows: [
            [0, 'public', 'orders', 1, 0],
            [1, 'pg_catalog', 'count', 1, 1],
            [2, 'pg_catalog', 'lower', 1, 1],
          ],
        };
      }
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0].match(/ AS ref/g)).toHaveLength(3);
    expect(lookups[0]).toContain('pg_catalog.pg_class');
    expect(lookups[0]).toContain('pg_catalog.to_regclass');
    expect(lookups[0]).toContain('pg_catalog.pg_proc');
    expect(lookups[0]).toContain('pg_catalog.pg_function_is_visible');
  });
  it.each([
    [[0, 'public', 'lower', 1, 0]],
    [
      [0, 'pg_catalog', 'lower', 1, 1],
      [0, 'public', 'lower', 1, 0],
    ],
  ])('rejects visible PostgreSQL shadows and ambiguous overloads: %j', async (rows) => {
    const p = policy({ allowTables: [], allowFunctions: ['safe.only'] });
    let queried = false;
    await expect(
      assertQueryAccess(p, connection('postgres'), 'SELECT lower(123::bigint)', true, async () => {
        queried = true;
        return { truncated: false, rows };
      })
    ).rejects.toThrow(/Function is not allowed|ambiguous/);
    expect(queried).toBe(true);
  });
  it.each(['pg_catalog.lower', 'reports.pg_catalog.lower', '*.lower'])(
    'honors resolved PostgreSQL builtin denial %s',
    async (denied) => {
      const p = policy({ allowTables: [], denyFunctions: [denied] });
      await expect(
        assertQueryAccess(p, connection('postgres'), "SELECT lower('a')", true, async () => ({
          truncated: false,
          rows: [[0, 'pg_catalog', 'lower', 1, 1]],
        }))
      ).rejects.toThrow(/Function is not allowed/);
    }
  );
  it.each(['SELECT pg_catalog.lower(1)', 'SELECT "lower"(1)'])(
    'requires explicit grants for qualified or quoted PostgreSQL calls: %s',
    async (sql) => {
      const p = policy({ allowTables: [] });
      const metadata = async () => ({ truncated: false, rows: [[0, 'pg_catalog', 'lower', 1, 1]] });
      await expect(
        assertQueryAccess(p, connection('postgres'), sql, true, metadata)
      ).rejects.toThrow(/Function is not allowed/);
      await assertQueryAccess(
        policy({ allowTables: [], allowFunctions: ['pg_catalog.lower'] }),
        connection('postgres'),
        sql,
        true,
        metadata
      );
    }
  );
  it('allows explicitly approved PostgreSQL UDFs without implicit builtin trust', async () => {
    await assertQueryAccess(
      policy({ allowTables: [], allowFunctions: ['public.lower'] }),
      connection('postgres'),
      'SELECT public.lower(1)',
      true,
      async () => ({
        truncated: false,
        rows: [[0, 'public', 'lower', 1, 0]],
      })
    );
  });
  it('keeps PostgreSQL grammar expressions usable and applies qualified denials', async () => {
    const p = policy({ schemas: ['public'], allowTables: [] });
    await assertQueryAccess(
      p,
      connection('postgres'),
      'SELECT coalesce(NULL,1),nullif(1,2),greatest(1,2),least(1,2),CURRENT_DATE,CURRENT_TIMESTAMP',
      true,
      async (sql) => {
        expect(sql).not.toContain('pg_proc');
        return {
          truncated: false,
          rows: [
            'current_date',
            'current_timestamp',
            'coalesce',
            'greatest',
            'least',
            'nullif',
          ].map((name, i) => [i, 'pg_catalog', name, 1, 1]),
        };
      }
    );
    await expect(
      assertQueryAccess(
        policy({ allowTables: [], denyFunctions: ['pg_catalog.coalesce'] }),
        connection('postgres'),
        'SELECT coalesce(NULL,1)',
        true,
        async () => ({
          truncated: false,
          rows: [[0, 'pg_catalog', 'coalesce', 1, 1]],
        })
      )
    ).rejects.toThrow(/Function is not allowed/);
  });
  it.each(['duckdb', 'sqlite', 'clickhouse'])(
    'does not skip native provenance checks on %s',
    async (driver) => {
      const lookups: string[] = [];
      await expect(
        assertQueryAccess(
          policy({ allowTables: [] }),
          connection(driver),
          "SELECT lower('x')",
          true,
          async (sql) => {
            lookups.push(sql);
            return { truncated: false, rows: [] };
          }
        )
      ).rejects.toThrow(/Object not found/);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]).toContain('native_builtin');
      if (driver === 'duckdb') {
        expect(lookups[0]).toContain('system.main.duckdb_functions()');
        expect(lookups[0]).toContain('system.main.current_schemas(true)');
      } else if (driver === 'sqlite') expect(lookups[0]).toContain('pragma_function_list()');
      else expect(lookups[0]).toContain("origin='System'");
    }
  );
  it('distinguishes DuckDB native and macro candidates in the same schema', async () => {
    await expect(
      assertQueryAccess(
        policy({ allowTables: [] }),
        connection('duckdb'),
        "SELECT lower('x')",
        true,
        async () => ({
          truncated: false,
          rows: [
            [0, 'main', 'lower', 1, 1],
            [0, 'main', 'lower', 0, 0],
          ],
        })
      )
    ).rejects.toThrow(/ambiguous/);
  });
  it('matches database-qualified ClickHouse function rules without an empty schema component', async () => {
    const { identityPredicate } = await import('../src/policy/identities.js');
    const rule = { denyFunctions: ['reports.count'] };
    const p = policy(rule);
    expect(
      p.allowsResolvedBuiltin(
        connection('clickhouse'),
        [{ value: 'count', quoted: false }],
        '',
        'count',
        true
      )
    ).toBe(false);
    const predicate = identityPredicate(
      connection('clickhouse'),
      [rule],
      { schema: "''", name: 'name', database: 'currentDatabase()' },
      'function',
      true,
      true
    );
    expect(predicate).toContain('currentDatabase()');
    expect(predicate).not.toContain("('' LIKE");
    expect(predicate).not.toContain('1=0');
  });
});
