import assert from 'node:assert/strict';
import { benchmarkSessionReuse } from './benchmark-sessions.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import sql from 'mssql';
import oracledb from 'oracledb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const engines = (
  process.argv.find((arg) => arg.startsWith('--engines='))?.split('=')[1] ?? 'postgres,mysql'
).split(',');
const images = {
  postgres: { image: 'postgres:17-alpine', port: 5432 },
  mysql: { image: 'mysql:8.4', port: 3306 },
  mariadb: { image: 'mariadb:11.4', port: 3306 },
  mssql: {
    image: 'mcr.microsoft.com/mssql/server:2022-latest',
    port: 1433,
    platform: 'linux/amd64',
  },
  oracle: { image: 'gvenzl/oracle-free:23-slim-faststart', port: 1521 },
};
for (const engine of engines) assert(images[engine], `Unknown integration engine: ${engine}`);
const directory = mkdtempSync(join(tmpdir(), 'omnisql-integration-'));
const names = new Set();
const dockerArgs = process.env.OMNISQL_DOCKER_HOST
  ? ['--host', process.env.OMNISQL_DOCKER_HOST]
  : [];
const docker = (args) =>
  execFileSync('docker', [...dockerArgs, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function cleanup() {
  for (const name of names) {
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      /* Container may already have exited. */
    }
  }
  names.clear();
  rmSync(directory, { recursive: true, force: true });
}
process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function connect(engine, config) {
  if (engine === 'postgres') {
    const c = new PgClient({ ...config, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
    } catch (error) {
      await c.end().catch(() => {});
      throw error;
    }
    return { query: async (text) => (await c.query(text)).rows, close: () => c.end() };
  }
  if (['mysql', 'mariadb'].includes(engine)) {
    const c = await mysql.createConnection({
      ...config,
      connectTimeout: 2000,
      multipleStatements: false,
    });
    return { query: async (text) => (await c.query(text))[0], close: () => c.end() };
  }
  if (engine === 'mssql') {
    const c = new sql.ConnectionPool({
      ...config,
      server: config.host,
      connectionTimeout: 2000,
      requestTimeout: 10000,
      options: { encrypt: true, trustServerCertificate: true },
    });
    try {
      await c.connect();
    } catch (error) {
      await c.close().catch(() => {});
      throw error;
    }
    return {
      query: async (text) => (await c.request().query(text)).recordset ?? [],
      close: () => c.close(),
    };
  }
  const c = await oracledb.getConnection({
    user: config.user,
    password: config.password,
    connectString: `${config.host}:${config.port}/FREEPDB1`,
    connectTimeout: 2,
  });
  return {
    query: async (text) =>
      (await c.execute(text, [], { autoCommit: true, outFormat: oracledb.OUT_FORMAT_OBJECT }))
        .rows ?? [],
    close: () => c.close(),
  };
}
async function startMcp(workspace, readOnly, extra = {}) {
  const client = new Client({ name: 'omnisql-integration', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        OMNISQL_WORKSPACE: workspace,
        OMNISQL_PROJECT: 'Synthetic',
        OMNISQL_ALLOWED_CONNECTIONS: 'fixture',
        OMNISQL_READ_ONLY: String(readOnly),
        OMNISQL_UPDATE_NOTIFIER: 'false',
        OMNISQL_DISABLED_TOOLS: '',
        ...extra,
      },
    })
  );
  return client;
}
async function call(client, name, args) {
  let response;
  try {
    response = await client.callTool({ name, arguments: args });
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
  assert(!response.isError, JSON.stringify(response.content));
  const text = response.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
try {
  for (const engine of engines) {
    const { image, port: internalPort, platform } = images[engine];
    const password = 'T_' + randomBytes(18).toString('hex');
    const name = 'omnisql-it-' + engine + '-' + randomBytes(4).toString('hex');
    const variables =
      engine === 'postgres'
        ? { POSTGRES_USER: 'omnisql', POSTGRES_PASSWORD: password, POSTGRES_DB: 'omnisql' }
        : engine === 'mysql'
          ? {
              MYSQL_ROOT_PASSWORD: password,
              MYSQL_DATABASE: 'omnisql',
              MYSQL_USER: 'omnisql',
              MYSQL_PASSWORD: password,
            }
          : engine === 'mariadb'
            ? {
                MARIADB_ROOT_PASSWORD: password,
                MARIADB_DATABASE: 'omnisql',
                MARIADB_USER: 'omnisql',
                MARIADB_PASSWORD: password,
              }
            : engine === 'mssql'
              ? { ACCEPT_EULA: 'Y', MSSQL_PID: 'Developer', MSSQL_SA_PASSWORD: password }
              : { ORACLE_PASSWORD: password, APP_USER: 'omnisql', APP_USER_PASSWORD: password };
    console.log(`${engine}: starting ${image} with synthetic data`);
    const args = [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'io.omnisql.integration=true',
      '-p',
      `127.0.0.1::${internalPort}`,
      ...(platform ? ['--platform', platform] : []),
      ...Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      image,
    ];
    docker(args);
    names.add(name);
    let port;
    for (let attempt = 0; attempt < 50; attempt++) {
      const bindings = JSON.parse(
        docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])
      );
      port = Number(bindings?.[`${internalPort}/tcp`]?.[0]?.HostPort);
      if (port) break;
      await delay(100);
    }
    assert(port, `${engine}: no loopback port was allocated`);
    const config = {
      host: '127.0.0.1',
      port,
      user: engine === 'mssql' ? 'sa' : 'omnisql',
      password,
      database: engine === 'mssql' ? 'master' : engine === 'oracle' ? 'FREEPDB1' : 'omnisql',
    };
    let admin, client;
    try {
      let lastError;
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          admin = await connect(engine, config);
          break;
        } catch (error) {
          lastError = error;
          await delay(2000);
        }
      }
      if (!admin) throw new Error(`${engine} did not become ready: ${lastError?.message}`);
      if (engine === 'mssql') {
        await admin.query('CREATE DATABASE omnisql');
        await admin.query('CREATE DATABASE omnisql_other');
        await admin.close();
        config.database = 'omnisql';
        admin = await connect(engine, config);
      }
      if (process.env.OMNISQL_BENCHMARK_REPORT_DIR) {
        const report = await benchmarkSessionReuse(engine, config, connect);
        const output = resolve(process.env.OMNISQL_BENCHMARK_REPORT_DIR);
        mkdirSync(output, { recursive: true });
        writeFileSync(
          join(output, `2026-10-18-sessions-${engine}.json`),
          JSON.stringify(report, null, 2) + '\n'
        );
        console.log(`${engine}: session benchmark recorded`);
      }
      for (const statement of [
        'CREATE TABLE customers(id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL)',
        'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, total DECIMAL(12,2), status VARCHAR(16), FOREIGN KEY (customer_id) REFERENCES customers(id))',
        'CREATE INDEX orders_customer_idx ON orders(customer_id)',
        "INSERT INTO customers VALUES (1, 'Asha Rao')",
        "INSERT INTO customers VALUES (2, 'Noah Chen')",
        "INSERT INTO orders VALUES (1, 1, 240, 'paid')",
        "INSERT INTO orders VALUES (2, 1, 180, 'paid')",
        "INSERT INTO orders VALUES (3, 2, 95, 'pending')",
      ])
        await admin.query(statement);
      await assert.rejects(() => admin.query("INSERT INTO orders VALUES(99,999,1,'invalid')"));
      if (engine === 'oracle') await delay(1500); // Oracle read-only snapshots cannot span recent DDL timestamps.
      const workspace = join(directory, engine);
      const project = join(workspace, 'Synthetic/.dbeaver');
      mkdirSync(project, { recursive: true, mode: 0o700 });
      const connection = {
        name: `${engine} synthetic fixture`,
        provider: engine === 'postgres' ? 'postgresql' : engine,
        driver: engine === 'postgres' ? 'postgres-jdbc' : engine,
        configuration: {
          ...config,
          sslmode: 'disable',
          properties: { encrypt: 'true', trustServerCertificate: 'true' },
        },
      };
      writeFileSync(
        join(project, 'data-sources.json'),
        JSON.stringify({ connections: { fixture: connection } }),
        { mode: 0o600 }
      );
      client = await startMcp(workspace, true);
      assert.equal((await call(client, 'list_connections', {})).length, 1);
      const schema = await call(client, 'get_table_schema', {
        connectionId: 'fixture',
        tableName: engine === 'oracle' ? 'CUSTOMERS' : 'customers',
      });
      assert(schema.columns.some((column) => column.name.toLowerCase() === 'name'));
      const ordersSchema = await call(client, 'get_table_schema', {
        connectionId: 'fixture',
        tableName: engine === 'oracle' ? 'ORDERS' : 'orders',
      });
      assert(ordersSchema.indexes.some((i) => i.name.toLowerCase() === 'orders_customer_idx'));
      assert(
        ordersSchema.constraints.some(
          (k) =>
            k.type === 'FOREIGN_KEY' && k.columns.some((c) => c.toLowerCase() === 'customer_id')
        )
      );
      assert(ordersSchema.columns.find((c) => c.name.toLowerCase() === 'id').isPrimaryKey);
      const plan = await call(client, 'explain_query', {
        connectionId: 'fixture',
        query: 'SELECT * FROM orders WHERE id=1',
        format: 'text',
      });
      assert(plan.plan.length > 0);
      if (engine === 'mssql') assert(plan.plan.some((p) => /select|scan|seek/i.test(p.operation)));
      if (['postgres', 'mysql', 'mariadb'].includes(engine)) {
        const actual = await call(client, 'explain_query', {
          connectionId: 'fixture',
          query: 'SELECT * FROM orders WHERE id=1',
          analyze: true,
          format: 'text',
        });
        assert(actual.plan.length > 0);
      }
      if (['postgres', 'mysql', 'mariadb', 'mssql'].includes(engine)) {
        const jsonPlan = await call(client, 'explain_query', {
          connectionId: 'fixture',
          query: 'SELECT * FROM orders WHERE id=1',
          format: 'json',
        });
        assert(jsonPlan.plan.length > 0);
      }
      if (engine === 'oracle') {
        const precise = await call(client, 'execute_query', {
          connectionId: 'fixture',
          query: 'SELECT 9007199254740993 AS precise FROM dual',
        });
        assert.equal(precise.rows[0][0], '9007199254740993');
      }
      const tableStats = await call(client, 'get_table_stats', {
        connectionId: 'fixture',
        tableName: engine === 'oracle' ? 'ORDERS' : 'orders',
      });
      assert.equal(tableStats.estimated, true);
      if (tableStats.totalBytes !== null) assert(BigInt(tableStats.totalBytes) >= 0n);
      const dbStats = await call(client, 'get_database_stats', { connectionId: 'fixture' });
      assert.equal(dbStats.tableCount, 2);
      assert.equal(dbStats.serverVersion !== 'Unavailable', true);
      const result = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query:
          "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id=o.customer_id WHERE o.status='paid' GROUP BY c.name",
        maxRows: 20,
      });
      assert.equal(result.rows[0][0], 'Asha Rao');
      assert.equal(Number(result.rows[0][1]), 420);
      const capped = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query: 'WITH subset AS (SELECT * FROM orders) SELECT * FROM subset',
        maxRows: 1,
      });
      assert.equal(capped.rows.length, 1);
      assert.equal(capped.truncated, true);
      const exact = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query: 'SELECT * FROM orders',
        maxRows: 3,
      });
      assert.equal(exact.rows.length, 3);
      assert.equal(exact.truncated, false);
      const duplicates = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query: 'SELECT id AS repeated, id AS repeated FROM orders',
        maxRows: 1,
      });
      assert.equal(duplicates.columns.length, 2);
      assert.equal(duplicates.rows[0].length, 2);
      await assert.rejects(
        () =>
          call(client, 'write_query', {
            connectionId: 'fixture',
            query: 'DELETE FROM orders WHERE id=1',
          }),
        /read.only/
      );
      await assert.rejects(
        () =>
          call(client, 'execute_query', {
            connectionId: 'fixture',
            query: 'SELECT 1; DELETE FROM orders WHERE id=1',
          }),
        /single/
      );
      if (engine === 'postgres') {
        await admin.query('CREATE SEQUENCE audit_counter');
        await assert.rejects(
          () =>
            call(client, 'execute_query', {
              connectionId: 'fixture',
              query: "SELECT nextval('audit_counter')",
            }),
          /function|read.only/
        );
        await admin.query(
          'CREATE FUNCTION audit_touch() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE orders SET total=0; RETURN 1; END $$'
        );
        await assert.rejects(
          () =>
            call(client, 'execute_query', {
              connectionId: 'fixture',
              query: 'SELECT audit_touch()',
            }),
          /read.only/
        );
      }
      if (engine === 'mssql') {
        await assert.rejects(
          () =>
            call(client, 'execute_query', {
              connectionId: 'fixture',
              query: 'SELECT CAST(9007199254740993 AS DECIMAL(38,0)) AS precise',
            }),
          /precision|inexact integer/
        );
        const precise = await call(client, 'execute_query', {
          connectionId: 'fixture',
          query: 'SELECT CAST(CAST(9007199254740993 AS DECIMAL(38,0)) AS VARCHAR(50)) AS precise',
        });
        assert.equal(precise.rows[0][0], '9007199254740993');
      }
      if (engine === 'mssql') {
        const [primary, other] = await Promise.all([
          call(client, 'execute_query', {
            connectionId: 'fixture',
            query: 'SELECT DB_NAME() AS database_name',
          }),
          call(client, 'execute_query', {
            connectionId: 'fixture',
            database: 'omnisql_other',
            query: 'SELECT DB_NAME() AS database_name',
          }),
        ]);
        assert.equal(primary.rows[0][0], 'omnisql');
        assert.equal(other.rows[0][0], 'omnisql_other');
      }
      await client.close();
      client = await startMcp(workspace, false);
      await assert.rejects(
        () =>
          call(client, 'create_table', {
            connectionId: 'fixture',
            query: 'CREATE TABLE injected(id int); DROP TABLE orders',
          }),
        /single/
      );
      await assert.rejects(
        () =>
          call(client, 'write_query', {
            connectionId: 'fixture',
            query: 'DELETE FROM orders -- WHERE only in a comment',
          }),
        /WHERE/
      );
      await assert.rejects(
        () =>
          call(client, 'drop_table', {
            connectionId: 'fixture',
            tableName: 'orders',
            confirm: 'false',
          }),
        /boolean/
      );
      const count = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query: 'SELECT COUNT(*) AS n FROM orders',
      });
      assert.equal(Number(count.rows[0][0]), 3);
      const poolStats = await call(client, 'get_pool_stats', { connectionId: 'fixture' });
      assert(poolStats.totalConnections >= 1 && poolStats.totalConnections <= 4);
      assert.equal(poolStats.activeConnections, 0);
      if (['postgres', 'mysql', 'mariadb', 'mssql'].includes(engine)) {
        const begin = () => call(client, 'begin_transaction', { connectionId: 'fixture' });
        const { transactionId } = await begin();
        await call(client, 'execute_in_transaction', {
          transactionId,
          query: "UPDATE orders SET status='changed' WHERE id=1",
        });
        const aliases = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const query =
          'SELECT a.id AS repeated,b.id AS repeated FROM ' +
          aliases.map((alias) => 'orders ' + alias).join(' CROSS JOIN ');
        const bounded = await call(client, 'execute_in_transaction', { transactionId, query });
        assert.equal(bounded.rows.length, 1000);
        assert.equal(bounded.truncated, true);
        assert.deepEqual(bounded.columns, ['repeated', 'repeated']);
        assert.equal(bounded.rows[0].length, 2);
        const textExpression = engine === 'mssql' ? "REPLICATE('x',100)" : "REPEAT('x',100)";
        const large = await call(client, 'execute_in_transaction', {
          transactionId,
          query: query.replace(
            'a.id AS repeated,b.id AS repeated',
            'a.id AS n,' + textExpression + ' AS payload'
          ),
        });
        assert.match(large.resultId, /^[a-f0-9]{32}$/);
        assert.equal(large.storedRows, 1000);
        const page = await call(client, 'read_result', {
          resultId: large.resultId,
          offset: 990,
          limit: 10,
        });
        assert.equal(page.rows.length, 10);
        assert.equal(page.rows[0][1], 'x'.repeat(100));
        // Truncating a read must keep the transaction usable and its writes uncommitted.
        const afterCap = await call(client, 'execute_in_transaction', {
          transactionId,
          query: 'SELECT COUNT(*) AS n FROM orders',
        });
        assert.equal(Number(afterCap.rows[0][0]), 3);
        await call(client, 'rollback_transaction', { transactionId });
        assert.equal((await admin.query('SELECT status FROM orders WHERE id=1'))[0].status, 'paid');
        const committed = await begin();
        await call(client, 'execute_in_transaction', {
          transactionId: committed.transactionId,
          query: "UPDATE orders SET status='committed' WHERE id=1",
        });
        await call(client, 'commit_transaction', { transactionId: committed.transactionId });
        assert.equal(
          (await admin.query('SELECT status FROM orders WHERE id=1'))[0].status,
          'committed'
        );
        await admin.query("UPDATE orders SET status='paid' WHERE id=1");
        const failed = await begin();
        await call(client, 'execute_in_transaction', {
          transactionId: failed.transactionId,
          query: "UPDATE orders SET status='must_rollback' WHERE id=1",
        });
        await assert.rejects(() =>
          call(client, 'execute_in_transaction', {
            transactionId: failed.transactionId,
            query: 'SELECT * FROM missing_transaction_table',
          })
        );
        await assert.rejects(
          () => call(client, 'commit_transaction', { transactionId: failed.transactionId }),
          /not found/
        );
        assert.equal((await admin.query('SELECT status FROM orders WHERE id=1'))[0].status, 'paid');
      }
      await client.close();
      const instanceFile = join(workspace, 'instances.json');
      const nativeDriver = engine === 'postgres' ? 'postgresql' : engine;
      const owner =
        engine === 'postgres'
          ? 'public'
          : engine === 'mssql'
            ? 'dbo'
            : engine === 'oracle'
              ? 'OMNISQL'
              : 'omnisql';
      const orders = engine === 'oracle' ? 'ORDERS' : 'orders';
      const customers = engine === 'oracle' ? 'CUSTOMERS' : 'customers';
      const passwordEnv = 'OMNISQL_INTEGRATION_PASSWORD';
      const base = {
        driver: nativeDriver,
        host: config.host,
        port: config.port,
        user: config.user,
        database: config.database,
        passwordEnv,
        properties: { sslmode: 'disable', encrypt: 'true', trustServerCertificate: 'true' },
      };
      writeFileSync(
        instanceFile,
        JSON.stringify({
          version: 1,
          connections: {
            reports: {
              ...base,
              readOnly: true,
              policy: { allowTables: [orders, owner + '.' + orders] },
              limits: { poolMax: 1, timeoutMs: 5000, maxRows: 1 },
            },
            edits: {
              ...base,
              readOnly: false,
              policy: {
                allowTables: [orders, owner + '.' + orders],
                denyTables: [customers, owner + '.' + customers],
              },
              limits: { poolMax: 2, timeoutMs: 5000, maxRows: 20 },
            },
          },
        }),
        { mode: 0o600 }
      );
      client = await startMcp(workspace, false, {
        OMNISQL_CONFIG_FILE: instanceFile,
        OMNISQL_ALLOWED_CONNECTIONS: 'reports,edits',
        OMNISQL_INTEGRATION_PASSWORD: password,
      });
      assert.equal((await call(client, 'list_connections', {})).length, 2);
      const concurrent = await Promise.all(
        ['reports', 'edits', 'reports', 'edits'].map((connectionId) =>
          call(client, 'execute_query', {
            connectionId,
            query: 'SELECT COUNT(*) AS count FROM ' + orders,
          })
        )
      );
      assert(concurrent.every((r) => Number(r.rows[0][0]) === 3));
      await assert.rejects(
        () =>
          call(client, 'write_query', {
            connectionId: 'reports',
            query: 'UPDATE ' + orders + " SET status='pending' WHERE id=3",
          }),
        /read.only/
      );
      await call(client, 'write_query', {
        connectionId: 'edits',
        query: 'UPDATE ' + orders + " SET status='pending' WHERE id=3",
      });
      await assert.rejects(
        () =>
          call(client, 'execute_query', {
            connectionId: 'reports',
            query: 'SELECT * FROM ' + customers,
          }),
        /Table.*policy/
      );
      await assert.rejects(
        () => call(client, 'get_table_schema', { connectionId: 'edits', tableName: customers }),
        /Table.*policy/
      );
      const visible = await call(client, 'list_tables', { connectionId: 'reports' });
      assert.equal(visible.length, 1);
      assert.equal(visible[0].name.toLowerCase(), 'orders');
      const resources = (await client.listResources()).resources;
      assert(resources.every((r) => !r.uri.toLowerCase().includes('customers')));
      if (resources.length) await client.readResource({ uri: resources[0].uri });
      await assert.rejects(
        () =>
          client.readResource({
            uri: 'omnisql:///connections/reports/tables/' + customers + '/schema',
          }),
        /Table.*policy/
      );
      console.log(
        `${engine}: independent instances, concurrent pools, table policies, resources, and read-only settings passed`
      );
      await client.close();
      client = await startMcp(workspace, false, {
        OMNISQL_CONFIG_FILE: '',
        OMNISQL_TIMEOUT: '200',
      });
      const operands = Array.from({ length: 18 }, (_, i) => `t${i}`);
      const slow =
        'SELECT SUM(' +
        operands.map((alias) => alias + '.id').join('+') +
        ') FROM ' +
        operands.map((alias) => 'orders ' + alias).join(' CROSS JOIN ');
      const beforeTimeout = Date.now();
      await assert.rejects(
        () => call(client, 'execute_query', { connectionId: 'fixture', query: slow }),
        /timed?\s*out|deadline|cancel|ORA-03156|ORA-01013|DPI-1067|NJS-040/i
      );
      assert(Date.now() - beforeTimeout < 10000, 'Query cancellation must return promptly');
      const recovery = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query: 'SELECT COUNT(*) AS n FROM orders',
      });
      assert.equal(Number(recovery.rows[0][0]), 3);
      console.log(`${engine}: MCP discovery, schema, joins, and security regressions passed`);
    } finally {
      await client?.close();
      await admin?.close();
      docker(['rm', '-f', '-v', name]);
      names.delete(name);
    }
  }
} finally {
  cleanup();
}
