import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve('.demo');
const project = join(root, 'workspace/Examples/.dbeaver');
mkdirSync(project, { recursive: true, mode: 0o700 });
const connections = {};
const frames = [];
const record = (title, output) => {
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  frames.push({ title, output: text });
  console.log(`\n> ${title}\n${text}`);
};
for (const [name, extra] of [
  ['sales', ''],
  ['sales-v2', ", region TEXT DEFAULT 'APAC'"],
]) {
  const database = join(root, `${name}.db`);
  if (!existsSync(database))
    execFileSync('sqlite3', [
      database,
      `
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT${extra});
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL NOT NULL, status TEXT NOT NULL);
    INSERT INTO customers (id,name,city) VALUES (1,'Asha Rao','Bengaluru'),(2,'Noah Chen','Singapore'),(3,'Mira, Inc.','Mumbai');
    INSERT INTO orders VALUES (1,1,240,'paid'),(2,1,180,'paid'),(3,2,95,'pending'),(4,3,320,'paid');
  `,
    ]);
  connections[name] = {
    name: name === 'sales' ? 'Sales · SQLite' : 'Sales v2 · schema comparison',
    provider: 'sqlite',
    driver: 'sqlite',
    configuration: { database },
  };
}
let pgRoot;
let pgStarted = false;
let client;
try {
  if (process.argv.includes('--postgres')) {
    const binaries = process.env.OMNISQL_DEMO_PG_BIN ?? '/opt/homebrew/bin';
    pgRoot = mkdtempSync(join(tmpdir(), 'omnisql-demo-pg-'));
    const password = randomBytes(24).toString('hex');
    const pwfile = join(pgRoot, 'password');
    writeFileSync(pwfile, password, { mode: 0o600 });
    const port = await new Promise((resolvePort) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolvePort(port));
      });
    });
    execFileSync(
      join(binaries, 'initdb'),
      ['-D', join(pgRoot, 'data'), '-U', 'demo', '--auth=scram-sha-256', `--pwfile=${pwfile}`],
      { stdio: 'pipe' }
    );
    execFileSync(
      join(binaries, 'pg_ctl'),
      [
        '-D',
        join(pgRoot, 'data'),
        '-l',
        join(pgRoot, 'server.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k ${pgRoot}`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' }
    );
    pgStarted = true;
    const config = {
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: 'demo',
      password,
      ssl: false,
    };
    const admin = new PgClient(config);
    await admin.connect();
    await admin.query('CREATE DATABASE app_logs');
    await admin.end();
    const app = new PgClient({ ...config, database: 'app_logs' });
    await app.connect();
    await app.query(
      "CREATE TABLE events (id SERIAL PRIMARY KEY, level TEXT NOT NULL); INSERT INTO events(level) VALUES ('info'),('info'),('warn'),('error')"
    );
    await app.end();
    connections['pg-demo'] = {
      name: 'PostgreSQL · database selection',
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      configuration: { ...config, sslmode: 'disable' },
    };
  }
  writeFileSync(join(project, 'data-sources.json'), JSON.stringify({ connections }, null, 2), {
    mode: 0o600,
  });
  client = new Client({ name: 'omnisql-demo', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      env: {
        ...process.env,
        OMNISQL_WORKSPACE: join(root, 'workspace'),
        OMNISQL_PROJECT: 'Examples',
        OMNISQL_READ_ONLY: 'true',
        OMNISQL_ALLOWED_CONNECTIONS: Object.keys(connections).join(','),
        OMNISQL_UPDATE_NOTIFIER: 'false',
        OMNISQL_DEBUG: 'false',
      },
      stderr: 'pipe',
    })
  );
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError);
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const listed = await call('list_connections', {});
  record('Discover saved connections', listed);
  const tables = await call('list_tables', { connectionId: 'sales' });
  assert.equal(tables.length, 2);
  record('List tables · sales', tables);
  const schema = await call('get_table_schema', { connectionId: 'sales', tableName: 'customers' });
  assert(schema.columns.some((column) => column.name === 'id' && column.isPrimaryKey));
  record('Inspect customers schema', schema);
  const query =
    "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON o.customer_id=c.id WHERE o.status='paid' GROUP BY c.name ORDER BY revenue DESC";
  const result = await call('execute_query', { connectionId: 'sales', query });
  assert.deepEqual(result.rows, [
    ['Asha Rao', 420],
    ['Mira, Inc.', 320],
  ]);
  record('Query revenue across tables', result);
  const csv = await call('export_data', {
    connectionId: 'sales',
    query: 'SELECT name,city FROM customers',
    format: 'csv',
  });
  assert.match(csv, /"Mira, Inc\."/);
  record('Export CSV · quoted values preserved', csv);
  const plan = await call('explain_query', {
    connectionId: 'sales',
    query: 'SELECT * FROM orders WHERE customer_id=1',
  });
  record('Explain a query', plan);
  const diff = await call('compare_schemas', {
    sourceConnectionId: 'sales',
    targetConnectionId: 'sales-v2',
    includeMigrationScript: true,
  });
  assert.match(JSON.stringify(diff), /region/);
  record('Compare schemas · migration preview', diff);
  await assert.rejects(
    call('write_query', {
      connectionId: 'sales',
      query: "INSERT INTO customers(id,name) VALUES (99,'Blocked')",
    }),
    /read-only/
  );
  record('Read-only protection', 'write_query rejected. Demo data unchanged.');
  if (pgStarted) {
    const databases = await call('list_databases', { connectionId: 'pg-demo' });
    assert(databases.includes('app_logs'));
    record('Discover PostgreSQL databases', databases);
    const logs = await call('execute_query', {
      connectionId: 'pg-demo',
      database: 'app_logs',
      query: 'SELECT level, count(*) AS count FROM events GROUP BY level ORDER BY level',
    });
    assert.equal(logs.rows.length, 3);
    record('Select app_logs through one saved connection', logs);
    const pool = await call('get_pool_stats', { connectionId: 'pg-demo', database: 'app_logs' });
    assert.equal(pool.connectionId, 'pg-demo/app_logs');
    record('Pool statistics · separate database identity', pool);
  }
  writeFileSync(join(root, 'recording.json'), JSON.stringify(frames, null, 2));
  record(
    'Verified',
    'Connections · tables · schemas · queries · CSV · explain · schema diff · read-only checks' +
      (pgStarted ? ' · PostgreSQL database selection · pool identity' : '')
  );
} finally {
  await client?.close();
  if (pgStarted) {
    const binaries = process.env.OMNISQL_DEMO_PG_BIN ?? '/opt/homebrew/bin';
    execFileSync(
      join(binaries, 'pg_ctl'),
      ['-D', join(pgRoot, 'data'), '-m', 'fast', '-w', 'stop'],
      { stdio: 'pipe' }
    );
    delete connections['pg-demo'];
    writeFileSync(join(project, 'data-sources.json'), JSON.stringify({ connections }, null, 2), {
      mode: 0o600,
    });
  }
  if (pgRoot) rmSync(pgRoot, { recursive: true, force: true });
}
