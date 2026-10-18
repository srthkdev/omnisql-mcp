import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const command = process.env.OMNISQL_DUCKDB_CLI || 'duckdb';
const dir = mkdtempSync(join(tmpdir(), 'omnisql-duckdb-'));
let client;
let requests = 0;
const http = createServer((_, response) => {
  requests++;
  response.end('canary\nprivate\n');
});
try {
  await new Promise((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const source = join(dir, 'do not read.csv');
  writeFileSync(source, 'canary\nprivate\n');
  const files = [join(dir, 'sales.duckdb'), join(dir, 'warehouse.duckdb')];
  for (const [index, database] of files.entries())
    execFileSync(
      command,
      [
        '-no-init',
        database,
        `
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name VARCHAR NOT NULL);
    INSERT INTO customers VALUES(1,'Asha');
    CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),total DECIMAL(20,4),status VARCHAR);
    INSERT INTO orders SELECT i,1,${index + 1}::DECIMAL(20,4),'paid' FROM range(1,10001) t(i);
    CREATE INDEX orders_customer ON orders(customer_id,id);
    CREATE INDEX orders_expr ON orders((total+1));
    CREATE TABLE secrets(secret VARCHAR);
    INSERT INTO secrets VALUES('hidden');
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  const file = join(dir, 'instances.json');
  const connection = (database, extra = {}) => ({
    driver: 'duckdb',
    database,
    limits: { maxRows: 10000, maxBytes: 8388608, timeoutMs: 5000 },
    ...extra,
  });
  const connections = {
    sales: connection(files[0], { policy: { allowTables: ['orders', 'main.orders'] } }),
    warehouse: connection(files[1], { policy: { allowTables: ['orders', 'main.orders'] } }),
    edits: connection(files[0], {
      readOnly: false,
      policy: { allowTables: ['orders', 'main.orders'] },
    }),
    raw: connection(files[0]),
    tiny: connection(files[0], { limits: { maxRows: 2, maxBytes: 1024, timeoutMs: 5000 } }),
    fast: connection(files[0], { limits: { maxRows: 10, maxBytes: 1024, timeoutMs: 100 } }),
  };
  const configure = () =>
    writeFileSync(file, JSON.stringify({ version: 1, connections }), { mode: 0o600 });
  configure();
  client = new Client({ name: 'omnisql-duckdb-check', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        OMNISQL_CONFIG_FILE: file,
        OMNISQL_WORKSPACE: dir,
        OMNISQL_ALLOWED_CONNECTIONS: Object.keys(connections).join(','),
        OMNISQL_READ_ONLY: 'false',
        OMNISQL_DISABLED_TOOLS: '',
        OMNISQL_UPDATE_NOTIFIER: 'false',
      },
    })
  );
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, JSON.stringify(response.content));
    return JSON.parse(response.content[0].text);
  };
  const query = (connectionId, text) =>
    call('execute_query', { connectionId, query: text, maxRows: 10000 });
  assert.equal((await call('list_connections', {})).length, 6);
  const totals = await Promise.all(
    ['sales', 'warehouse', 'sales', 'warehouse'].map((id) =>
      query(id, 'SELECT SUM(total) FROM orders')
    )
  );
  assert.deepEqual(
    totals.map((r) => r.rows[0][0]),
    ['10000.0000', '20000.0000', '10000.0000', '20000.0000']
  );
  const typed = await query(
    'raw',
    `SELECT 1 AS id,9007199254740993::BIGINT AS id,123456789012345.6789::DECIMAL(30,4) AS price,[9007199254740993::BIGINT,2] AS nested,{'x':9007199254740993::BIGINT} AS object,{'n':123456789012345.6789::DECIMAL(30,4)} AS nested_decimal`
  );
  assert.deepEqual(typed.columns, ['id', 'id', 'price', 'nested', 'object', 'nested_decimal']);
  assert.deepEqual(typed.rows, [
    [
      1,
      '9007199254740993',
      '123456789012345.6789',
      ['9007199254740993', 2],
      { x: '9007199254740993' },
      { n: '123456789012345.6789' },
    ],
  ]);
  await query('sales', 'WITH "Report" AS (SELECT * FROM "ORDERS") SELECT count(*) FROM report');
  for (const sql of [
    'SELECT * FROM secrets',
    'SELECT * FROM "main"."SECRETS"',
    'SELECT * FROM orders o JOIN secrets s ON true',
  ])
    await assert.rejects(() => query('sales', sql), /Table.*policy/);
  await assert.rejects(
    () => call('get_table_schema', { connectionId: 'sales', tableName: 'SECRETS' }),
    /Table.*policy/
  );
  const schema = await call('get_table_schema', {
    connectionId: 'sales',
    tableName: 'MAIN.ORDERS',
  });
  assert.equal(schema.columns.length, 4);
  assert(schema.columns.find((c) => c.name === 'id').isPrimaryKey);
  assert.deepEqual(schema.indexes.find((i) => i.name === 'orders_customer').columns, [
    'customer_id',
    'id',
  ]);
  assert(schema.indexes.find((i) => i.name === 'orders_expr').definition.includes('total'));
  assert(
    schema.constraints.some((k) => k.type === 'FOREIGN_KEY' && k.referencedColumns.includes('id'))
  );
  assert.deepEqual(
    (await call('list_tables', { connectionId: 'sales' })).map((t) => t.name),
    ['orders']
  );
  const resources = (await client.listResources()).resources.filter((r) =>
    r.uri.includes('/sales/')
  );
  assert(resources.every((r) => !r.uri.toLowerCase().includes('secrets')));
  if (resources.length) await client.readResource({ uri: resources[0].uri });
  const stats = await call('get_table_stats', { connectionId: 'sales', tableName: 'orders' });
  assert.equal(stats.rowEstimate, '10000');
  assert.equal(stats.totalBytes, null);
  assert.equal((await call('get_database_stats', { connectionId: 'sales' })).tableCount, 1);
  for (const format of ['text', 'json'])
    for (const analyze of [false, true]) {
      const plan = await call('explain_query', {
        connectionId: 'sales',
        query: 'SELECT * FROM orders WHERE id=1',
        format,
        analyze,
      });
      assert.equal(plan.format, format);
      assert(JSON.stringify(plan.plan).includes('SCAN'));
    }
  const bounded = await query('tiny', 'SELECT id FROM orders ORDER BY id');
  assert.equal(bounded.rows.length, 2);
  assert.equal(bounded.truncated, true);
  const wide = await query('tiny', "SELECT repeat('x',2000)");
  assert.equal(wide.truncated, true);
  assert.equal(wide.limitReason, 'bytes');
  assert.equal(wide.rows.length, 0);
  const stored = await query(
    'sales',
    "SELECT id,status || '" + 'x'.repeat(100) + "' AS payload FROM orders ORDER BY id"
  ).catch((error) => {
    throw new Error('Large output: ' + error.message);
  });
  assert(stored.resultId);
  assert.equal(stored.storedRows, 10000);
  assert.equal(
    (await call('read_result', { resultId: stored.resultId, offset: 9999, limit: 1 })).rows[0][0],
    10000
  );
  const archive = await call('export_data', {
    connectionId: 'sales',
    query: 'SELECT * FROM orders LIMIT 3',
    format: 'csv',
    compression: 'zstd',
  });
  assert.equal(archive.compression, 'zstd');
  await assert.rejects(
    () =>
      call('write_query', {
        connectionId: 'sales',
        query: "UPDATE orders SET status='changed' WHERE id=1",
      }),
    /read.only/
  );
  const writing = () =>
    call('write_query', {
      connectionId: 'edits',
      query: "UPDATE orders SET status='changed' WHERE id=1",
    });
  assert.equal((await writing()).affectedRows, null);
  await Promise.all([
    writing(),
    query('sales', 'SELECT COUNT(*) FROM orders'),
    writing(),
    query('sales', 'SELECT COUNT(*) FROM orders'),
    query('tiny', 'SELECT * FROM orders'),
  ]);
  const updated = await query('sales', 'SELECT status FROM orders WHERE id=1');
  assert.equal(updated.rows[0][0], 'changed');
  if (process.env.OMNISQL_BENCHMARK_REPORT_DIR) {
    const values = { raw: [], sales: [] };
    for (let i = 0; i < 33; i++)
      for (const id of i % 2 ? ['raw', 'sales'] : ['sales', 'raw']) {
        const start = performance.now();
        await query(id, 'SELECT SUM(total) FROM orders');
        if (i >= 3) values[id].push(performance.now() - start);
      }
    const summary = (samples) => ({
      p50Ms: [...samples].sort((a, b) => a - b)[14],
      p95Ms: [...samples].sort((a, b) => a - b)[28],
      samplesMs: samples,
    });
    const report = {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      samples: 30,
      warmupPairs: 3,
      unrestricted: summary(values.raw),
      restricted: summary(values.sales),
      scope:
        'Warm MCP SUM(total) calls over 10,000 seeded DuckDB rows, including a CLI process per query and one additional batched catalog process for table policies. Excludes client initialization and first version/parser loading. Same query and file; alternating order.',
    };
    const directory = resolve(process.env.OMNISQL_BENCHMARK_REPORT_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(
        directory,
        `${new Date().toISOString().slice(0, 10)}-duckdb-${process.versions.bun ? 'bun' : 'node'}.json`
      ),
      JSON.stringify(report, null, 2) + '\n'
    );
  }
  await assert.rejects(
    () => call('begin_transaction', { connectionId: 'edits' }),
    /not supported|unsupported/i
  );
  for (const text of [
    `SELECT * FROM read_text('${source}')`,
    `SELECT * FROM '${source}'`,
    `SELECT * FROM read_csv('http://127.0.0.1:${http.address().port}/canary')`,
  ])
    await assert.rejects(
      () => query('raw', text),
      /disabled|Permission|external|extension|not allowed/i
    );
  assert.equal(requests, 0);
  await assert.rejects(
    () => query('raw', 'SET enable_external_access=true'),
    /Unsupported|read.only|configuration|locked/i
  );
  await assert.rejects(
    () => query('raw', 'SELECT 1;\n.shell echo unsafe'),
    /single SQL|Unsupported/
  );
  const started = Date.now();
  await assert.rejects(
    () =>
      query(
        'fast',
        'SELECT SUM(a.id+b.id+c.id) FROM orders a CROSS JOIN orders b CROSS JOIN orders c'
      ),
    /timed out/
  );
  assert(Date.now() - started < 5000);
  assert.equal(Number((await query('sales', 'SELECT COUNT(*) FROM orders')).rows[0][0]), 10000);
  connections.sales.policy = { allowTables: [] };
  configure();
  await assert.rejects(() => call('read_result', { resultId: stored.resultId }), /policy/);
  await assert.rejects(() => call('read_export', { resultId: archive.resultId }), /policy/);
  console.log(
    'DuckDB MCP: two instances, policies, types, metadata, plans, bounded artifacts, concurrency, file/network denial, and deadlines passed.'
  );
} finally {
  await client?.close();
  await new Promise((resolveClose) => http.close(resolveClose));
  rmSync(dir, { recursive: true, force: true });
}
