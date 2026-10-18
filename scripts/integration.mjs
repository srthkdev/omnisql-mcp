import assert from 'node:assert/strict';
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
async function startMcp(workspace, readOnly) {
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
      for (const statement of [
        'CREATE TABLE customers(id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL)',
        'CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total DECIMAL(12,2), status VARCHAR(16))',
        'CREATE INDEX orders_customer_idx ON orders(customer_id)',
        "INSERT INTO customers VALUES (1, 'Asha Rao')",
        "INSERT INTO customers VALUES (2, 'Noah Chen')",
        "INSERT INTO orders VALUES (1, 1, 240, 'paid')",
        "INSERT INTO orders VALUES (2, 1, 180, 'paid')",
        "INSERT INTO orders VALUES (3, 2, 95, 'pending')",
      ])
        await admin.query(statement);
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
      const result = await call(client, 'execute_query', {
        connectionId: 'fixture',
        query:
          "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id=o.customer_id WHERE o.status='paid' GROUP BY c.name",
        maxRows: 20,
      });
      assert.equal(result.rows[0][0], 'Asha Rao');
      assert.equal(Number(result.rows[0][1]), 420);
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
