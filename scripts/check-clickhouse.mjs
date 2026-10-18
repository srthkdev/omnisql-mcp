import { benchmarkHttpCompression } from './benchmark-clickhouse-http.mjs';
import { benchmarkReadScopes } from './benchmark-mcp.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startFixture } from './mcp-fixture.mjs';

const directory = mkdtempSync(join(tmpdir(), 'omnisql-clickhouse-'));
const name = 'omnisql-it-clickhouse-' + randomBytes(4).toString('hex');
const password = randomBytes(24).toString('hex');
const docker = (args) =>
  execFileSync(
    'docker',
    [
      ...(process.env.OMNISQL_DOCKER_HOST ? ['--host', process.env.OMNISQL_DOCKER_HOST] : []),
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let client,
  started = false,
  port;
let requests = 0;
const canary = createServer((_, response) => {
  requests++;
  response.end('canary\nprivate\n');
});
try {
  await new Promise((resolveListen) => canary.listen(0, '127.0.0.1', resolveListen));
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    'io.omnisql.integration=true',
    '--cpus',
    '2',
    '--memory',
    '2g',
    '-p',
    '127.0.0.1::8123',
    '-e',
    'CLICKHOUSE_USER=omnisql',
    '-e',
    'CLICKHOUSE_PASSWORD=' + password,
    '-e',
    'CLICKHOUSE_DB=sales',
    '-e',
    'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    'clickhouse/clickhouse-server:26.8-alpine',
  ]);
  started = true;
  const native = async (sql, settings = {}, user = 'omnisql', credential = password) => {
    const response = await fetch(`http://127.0.0.1:${port}/?` + new URLSearchParams(settings), {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(user + ':' + credential).toString('base64'),
      },
      body: sql,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text);
    return text;
  };
  let ready = false;
  for (let i = 0; i < 120; i++) {
    const bindings = JSON.parse(
      docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])
    );
    port = Number(bindings?.['8123/tcp']?.[0]?.HostPort);
    if (port)
      try {
        await native('SELECT 1');
        ready = true;
        break;
      } catch {}
    await delay(500);
  }
  assert(ready, 'ClickHouse did not become ready');
  console.log('ClickHouse: seeding two databases');
  await native('CREATE DATABASE warehouse');
  for (const [database, total] of [
    ['sales', '1.2500'],
    ['warehouse', '2.5000'],
  ]) {
    await native(
      `CREATE TABLE ${database}.orders(id UInt64,total Decimal(20,4),status LowCardinality(String),note Nullable(String),CONSTRAINT positive CHECK total>=0,INDEX orders_total total TYPE minmax GRANULARITY 1) ENGINE=MergeTree PRIMARY KEY id ORDER BY (id,total)`
    );
    await native(
      `INSERT INTO ${database}.orders SELECT number+1,toDecimal128('${total}',4),'paid',NULL FROM numbers(10000)`
    );
    await native(`CREATE TABLE ${database}.Orders(secret String) ENGINE=Memory`);
    await native(`INSERT INTO ${database}.Orders VALUES('hidden')`);
  }
  await assert.rejects(
    () =>
      native("INSERT INTO sales.orders VALUES(999999,1.0000,'invalid',NULL)", { readonly: '1' }),
    /readonly|read.only/i
  );
  await assert.rejects(
    () =>
      native("INSERT INTO sales.orders VALUES(999999,1.0000,'invalid',NULL)", { readonly: '2' }),
    /readonly|read.only/i
  );
  const readerPassword = randomBytes(24).toString('hex');
  await native(`CREATE USER fixture_reader IDENTIFIED BY '${readerPassword}' SETTINGS readonly=2`);
  await native('GRANT SELECT ON sales.orders TO fixture_reader');
  await native(
    `CREATE USER fixture_strict IDENTIFIED BY '${readerPassword}' SETTINGS readonly=1,replace_running_query=1,max_execution_time=5 MIN 1 MAX 30 CHANGEABLE_IN_READONLY,max_memory_usage=268435456 MIN 16777216 MAX 268435456 CHANGEABLE_IN_READONLY,cancel_http_readonly_queries_on_client_close=1,output_format_json_quote_64bit_integers=1,output_format_json_quote_decimals=1,output_format_decimal_trailing_zeros=1,output_format_json_map_as_array_of_tuples=1,enable_http_compression=1`
  );
  await native('GRANT SELECT ON sales.orders TO fixture_strict');
  await assert.rejects(
    () => native('SELECT 1', { readonly: '0' }, 'fixture_reader', readerPassword),
    /readonly/i
  );
  const file = join(directory, 'instances.json');
  const base = {
    driver: 'clickhouse',
    host: '127.0.0.1',
    port,
    user: 'omnisql',
    passwordEnv: 'OMNISQL_CLICKHOUSE_FIXTURE_PASSWORD',
    database: 'sales',
    limits: { maxRows: 10000, maxBytes: 8388608, timeoutMs: 5000 },
  };
  const policy = {
    databases: ['sales', 'warehouse'],
    allowTables: ['orders', 'sales.orders', 'warehouse.orders'],
  };
  const connections = {
    sales: { ...base, policy },
    warehouse: { ...base, database: 'warehouse', policy },
    edits: { ...base, readOnly: false, policy },
    raw: { ...base },
    tiny: { ...base, limits: { maxRows: 2, maxBytes: 1024, timeoutMs: 5000 } },
    fast: { ...base, limits: { maxRows: 10, maxBytes: 1024, timeoutMs: 100 } },
    reader: {
      ...base,
      user: 'fixture_reader',
      readOnly: false,
      properties: { 'clickhouse.readonlyMode': '2' },
      passwordEnv: 'OMNISQL_CLICKHOUSE_READER_PASSWORD',
      policy: { allowTables: ['orders', 'sales.orders'] },
    },
    strict: {
      ...base,
      user: 'fixture_strict',
      passwordEnv: 'OMNISQL_CLICKHOUSE_READER_PASSWORD',
      properties: { 'clickhouse.readonlyMode': '1' },
      policy: { allowTables: ['orders', 'sales.orders'] },
    },
  };
  connections.fastStrict = {
    ...connections.strict,
    limits: { maxRows: 10, maxBytes: 1024, timeoutMs: 100 },
  };
  connections.fastReader = {
    ...connections.reader,
    limits: { maxRows: 10, maxBytes: 1024, timeoutMs: 100 },
  };
  const configure = () =>
    writeFileSync(file, JSON.stringify({ version: 1, connections }), { mode: 0o600 });
  configure();
  const fixture = await startFixture({
    OMNISQL_CONFIG_FILE: file,
    OMNISQL_WORKSPACE: directory,
    OMNISQL_ALLOWED_CONNECTIONS: Object.keys(connections).join(','),
    OMNISQL_CLICKHOUSE_FIXTURE_PASSWORD: password,
    OMNISQL_CLICKHOUSE_READER_PASSWORD: readerPassword,
  });
  client = fixture.client;
  const call = fixture.call;
  const query = (connectionId, text, extra = {}) =>
    call('execute_query', { connectionId, query: text, maxRows: 10000, ...extra });
  const totals = await Promise.all(
    ['sales', 'warehouse', 'sales', 'warehouse'].map((id) =>
      query(id, 'SELECT SUM(total) FROM orders')
    )
  );
  assert.equal((await query('reader', 'SELECT SUM(total) FROM orders')).rows[0][0], '12500.0000');
  const partial = await call('get_table_schema', { connectionId: 'reader', tableName: 'orders' });
  assert(partial.partial);
  assert(partial.notes.some((note) => note.includes('system.constraints')));
  await assert.rejects(
    () =>
      call('write_query', {
        connectionId: 'reader',
        query: "INSERT INTO orders VALUES(20009,1,'blocked',NULL)",
      }),
    /readonly/i
  );
  assert.equal((await query('strict', 'SELECT SUM(total) FROM orders')).rows[0][0], '12500.0000');
  assert.deepEqual(
    totals.map((r) => r.rows[0][0]),
    ['12500.0000', '25000.0000', '12500.0000', '25000.0000']
  );
  assert.equal(
    (await query('sales', 'SELECT SUM(total) FROM orders', { database: 'warehouse' })).rows[0][0],
    '25000.0000'
  );
  assert.deepEqual(await call('list_databases', { connectionId: 'sales' }), ['sales', 'warehouse']);
  const typed = await query(
    'raw',
    "SELECT 1 AS id,1 AS id,9007199254740993 AS exact,toDecimal128('123456789012345.6789',4) AS price,map('key',1,'key',2) AS pairs,[9007199254740993] AS nested"
  );
  assert.deepEqual(typed.columns, ['id', 'id', 'exact', 'price', 'pairs', 'nested']);
  assert.deepEqual(typed.rows, [
    [
      1,
      1,
      '9007199254740993',
      '123456789012345.6789',
      [
        { keys: 'key', values: 1 },
        { keys: 'key', values: 2 },
      ],
      ['9007199254740993'],
    ],
  ]);
  await assert.rejects(() => query('raw', "SELECT unhex('ff')"), /invalid UTF-8/);
  for (const text of [
    'SELECT * FROM Orders',
    'SELECT * FROM sales.Orders',
    'SELECT * FROM warehouse.orders',
    'WITH orders AS (SELECT id FROM sales.orders) SELECT * FROM Orders',
  ])
    await assert.rejects(() => query('sales', text), /Table.*policy|selected database/);
  const schema = await call('get_table_schema', {
    connectionId: 'sales',
    tableName: 'sales.orders',
  });
  assert.equal(schema.columns.length, 4);
  assert(schema.columns.find((c) => c.name === 'note').nullable);
  assert(schema.indexes.some((i) => i.name === 'orders_total' && i.type === 'minmax' && !i.unique));
  assert(schema.constraints.some((k) => k.name === 'positive' && k.type === 'CHECK'));
  assert.equal(schema.physicalKeys.primary, 'id');
  assert.equal(schema.physicalKeys.sorting, 'id, total');
  assert(!schema.constraints.some((k) => k.type === 'PRIMARY_KEY' || k.type === 'UNIQUE'));
  assert.deepEqual(
    (await call('list_tables', { connectionId: 'sales' })).map((t) => t.name),
    ['orders']
  );
  await assert.rejects(
    () => call('get_table_schema', { connectionId: 'sales', tableName: 'sales.Orders' }),
    /Table.*policy/
  );
  const resources = (await client.listResources()).resources.filter((r) =>
    r.uri.includes('/sales/')
  );
  if (resources.length) await client.readResource({ uri: resources[0].uri });
  const stats = await call('get_table_stats', { connectionId: 'sales', tableName: 'orders' });
  assert.equal(stats.rowEstimate, '10000');
  assert(BigInt(stats.totalBytes) > 0n);
  assert.equal(stats.indexBytes, null);
  const databaseStats = await call('get_database_stats', { connectionId: 'sales' });
  assert.equal(databaseStats.tableCount, 1);
  assert.match(databaseStats.serverVersion, /^\d+\.\d+\./);
  for (const format of ['text', 'json']) {
    const plan = await call('explain_query', {
      connectionId: 'sales',
      query: 'SELECT * FROM orders WHERE id=1',
      format,
    });
    assert.equal(plan.format, format);
    assert(JSON.stringify(plan).includes('MergeTree'));
  }
  await assert.rejects(
    () =>
      call('explain_query', {
        connectionId: 'sales',
        query: 'SELECT * FROM orders',
        analyze: true,
      }),
    /unavailable/
  );
  const bounded = await query('tiny', 'SELECT * FROM orders');
  assert.equal(bounded.rows.length, 2);
  assert(bounded.truncated);
  const stored = await query(
    'sales',
    "SELECT id,'" + 'x'.repeat(100) + "' AS payload FROM orders ORDER BY id"
  );
  assert.equal(stored.storedRows, 10000);
  assert.equal(
    (await call('read_result', { resultId: stored.resultId, offset: 9999, limit: 1 })).rows[0][0],
    '10000'
  );
  const archive = await call('export_data', {
    connectionId: 'sales',
    query: 'SELECT * FROM orders LIMIT 3',
    format: 'csv',
    compression: 'gzip',
  });
  assert.equal(archive.compression, 'gzip');
  await assert.rejects(
    () =>
      call('write_query', {
        connectionId: 'sales',
        query: "INSERT INTO orders VALUES(20001,1,'blocked',NULL)",
      }),
    /read.only/
  );
  assert.equal(
    (
      await call('write_query', {
        connectionId: 'edits',
        query: "INSERT INTO orders VALUES(20001,1,'inserted',NULL)",
      })
    ).affectedRows,
    null
  );
  await assert.rejects(
    () =>
      call('write_query', {
        connectionId: 'edits',
        query: "INSERT INTO orders VALUES(20002,-1,'invalid',NULL)",
      }),
    /CHECK|constraint/i
  );
  assert.equal(
    (await query('sales', 'SELECT status FROM orders WHERE id=20001')).rows[0][0],
    'inserted'
  );
  await assert.rejects(
    () => call('begin_transaction', { connectionId: 'edits' }),
    /not supported|unsupported/i
  );
  for (const text of [
    `SELECT * FROM url('http://127.0.0.1:${canary.address().port}/','CSV','canary String')`,
    "SELECT * FROM file('/omnisql-fixture/blocked.txt','RawBLOB')",
    'SELECT * FROM orders SETTINGS max_execution_time=0',
    'SELECT * FROM orders FORMAT CSV',
  ])
    await assert.rejects(() => query('raw', text), /disabled|not allowed/i);
  assert.equal(requests, 0);
  // A large SQL body takes the compressed request path without changing its value.
  const long = 's'.repeat(70000);
  const large = await query('raw', "SELECT '" + long + "' AS payload");
  const cell = await call('read_result_cell', {
    resultId: large.resultId,
    row: 0,
    column: 0,
    offset: 69000,
    length: 1000,
  });
  assert.equal(cell.text, 's'.repeat(1000));
  for (const connectionId of ['fast', 'fastStrict', 'fastReader']) {
    const before = Date.now();
    await assert.rejects(
      () =>
        query(
          connectionId,
          'SELECT SUM(a.id+b.id+c.id) FROM orders a CROSS JOIN orders b CROSS JOIN orders c'
        ),
      (error) =>
        /timed out/.test(error.message) &&
        !error.message.includes('server cancellation could not be confirmed')
    );
    assert(Date.now() - before < 5000);
    await delay(300);
    const running = await native(
      "SELECT count() FROM system.processes WHERE startsWith(query,'SELECT SUM(a.id+b.id+c.id) FROM orders a CROSS')"
    );
    assert.equal(
      Number(running.trim()),
      0,
      'The timed-out read must stop on the database server too'
    );
  }
  assert.equal((await query('sales', 'SELECT count(*) FROM orders')).rows[0][0], '10001');
  await benchmarkReadScopes(
    query,
    'clickhouse',
    'Warm MCP SUM(total) calls over 10,001 seeded ClickHouse rows, including HTTP keep-alive, native zstd transport, and one additional batched catalog request for table policies. Excludes client initialization and first parser loading. Same query, account, and table; alternating order.'
  );
  await benchmarkHttpCompression(port, 'omnisql', password);
  connections.sales.policy = { allowTables: [] };
  configure();
  await assert.rejects(() => call('read_result', { resultId: stored.resultId }), /policy/);
  await assert.rejects(() => call('read_export', { resultId: archive.resultId }), /policy/);
  console.log(
    'ClickHouse MCP: instances, database selection, policies, exact values/maps, catalogs, plans, gzip/zstd, result caps, writes, external-function denials, and deadlines passed.'
  );
} finally {
  await client?.close();
  await new Promise((resolveClose) => canary.close(resolveClose));
  if (started) docker(['rm', '-f', '-v', name]);
  rmSync(directory, { recursive: true, force: true });
}
