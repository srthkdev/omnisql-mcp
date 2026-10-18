import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const verifyOnly = process.argv.includes('--verify');
const require = createRequire(new URL('./js/package.json', import.meta.url));
const { Client: PgClient } = require('pg');
const reportDirectory = resolve(process.env.OMNISQL_BENCH_REPORT_DIR || join(root, 'results'));
mkdirSync(reportDirectory, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'omnisql-language-'));
const name = 'omnisql-language-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const readerPassword = randomBytes(24).toString('hex');
const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const variants = [
  { name: 'node', command: process.execPath, args: [join(root, 'js/server.mjs')] },
  {
    name: 'bun',
    command:
      process.env.OMNISQL_BENCH_BUN ||
      execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(),
    args: [join(root, 'js/server.mjs')],
  },
  { name: 'rust', command: join(root, 'rust/target/release/omnisql-language-spike'), args: [] },
  { name: 'go', command: join(root, 'bin/go-server'), args: [] },
];
const samples = Object.fromEntries(
  variants.map((v) => [
    v.name,
    { startup: [], echo: [], aggregate: [], copy: [], json: [], cancel: [] },
  ])
);
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samplesMs: values,
  };
};
const sessions = [];
let admin;
let ownedContainer = false;
const log = (message) => console.error(message);
async function start(variant, environment, measureMemory = false) {
  const client = new Client({ name: 'omnisql-language-benchmark', version: '1' });
  const transport = new StdioClientTransport({
    command: measureMemory ? '/usr/bin/time' : variant.command,
    args: measureMemory
      ? [process.platform === 'darwin' ? '-l' : '-v', variant.command, ...variant.args]
      : variant.args,
    stderr: 'pipe',
    env: { ...process.env, ...environment },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const begin = performance.now();
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, 'bench');
    const startup = performance.now() - begin;
    const call = async (mode) => {
      const response = await client.callTool({ name: 'bench', arguments: { mode } });
      assert(!response.isError, variant.name + ': ' + JSON.stringify(response.content));
      return JSON.parse(response.content[0].text);
    };
    return { client, call, startup, stderr: () => stderr };
  } catch (error) {
    await client.close();
    throw new Error(variant.name + ': ' + error.message + '\n' + stderr);
  }
}
try {
  const file = join(directory, 'fixture.jsonl');
  const counts = Array(10).fill(0),
    sums = Array(10).fill(0);
  const payload = 'x'.repeat(96) + 'नमस्ते🙂';
  const lines = [];
  for (let id = 1; id <= 100000; id++) {
    const region = id % 10,
      cents = (id * 97) % 100000;
    counts[region]++;
    sums[region] += cents;
    lines.push(
      JSON.stringify({
        id,
        region,
        cents: String(cents),
        payload,
        nested: { tags: ['a', 'b'], active: id % 2 === 0 },
      })
    );
  }
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  lines.length = 0;
  log('Starting owned PostgreSQL fixture (100,000 rows).');
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'io.omnisql.language-spike=true',
    '--cpus',
    '2',
    '--memory',
    '768m',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_DB=fixture',
    '-e',
    'POSTGRES_PASSWORD=' + password,
    'postgres:17-alpine',
  ]);
  ownedContainer = true;
  let port;
  for (let i = 0; i < 50; i++) {
    const ports = JSON.parse(
      docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])
    );
    port = Number(ports['5432/tcp']?.[0]?.HostPort);
    if (port) break;
    await sleep(100);
  }
  assert(port);
  for (let i = 0; i < 60; i++) {
    const next = new PgClient({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password,
      database: 'fixture',
      connectionTimeoutMillis: 1000,
    });
    try {
      await next.connect();
      admin = next;
      break;
    } catch {
      await next.end().catch(() => {});
      await sleep(500);
    }
  }
  assert(admin, 'PostgreSQL did not become ready');
  await admin.query(
    "CREATE TABLE bench(id INTEGER PRIMARY KEY,region INTEGER NOT NULL,cents BIGINT NOT NULL,payload TEXT NOT NULL);INSERT INTO bench SELECT i,i%10,(i::bigint*97)%100000,repeat('x',96)||'नमस्ते🙂' FROM generate_series(1,100000) i;ANALYZE bench;"
  );
  await admin.query(
    "CREATE ROLE bench_reader LOGIN PASSWORD '" +
      readerPassword +
      "';GRANT CONNECT ON DATABASE fixture TO bench_reader;GRANT USAGE ON SCHEMA public TO bench_reader;GRANT SELECT ON bench TO bench_reader;ALTER ROLE bench_reader SET default_transaction_read_only=on;ALTER ROLE bench_reader SET statement_timeout='5s';"
  );
  const environment = {
    PGHOST: '127.0.0.1',
    PGPORT: String(port),
    PGUSER: 'bench_reader',
    PGPASSWORD: readerPassword,
    PGDATABASE: 'fixture',
    PGSSLMODE: 'disable',
    OMNISQL_BENCH_FILE: file,
  };
  const reader = new PgClient({
    host: environment.PGHOST,
    port,
    user: environment.PGUSER,
    password: readerPassword,
    database: 'fixture',
  });
  await reader.connect();
  try {
    await assert.rejects(
      () => reader.query('DELETE FROM bench'),
      (e) => e.code === '25006'
    );
  } finally {
    await reader.end();
  }
  const expected = {
    rows: counts.map((count, region) => [region, String(count), String(sums[region])]),
  };
  const native = await admin.query(
    'SELECT region,count(*)::text AS count,sum(cents)::text AS total FROM bench GROUP BY region ORDER BY region'
  );
  assert.deepEqual({ rows: native.rows.map((r) => [r.region, r.count, r.total]) }, expected);
  log(
    verifyOnly
      ? 'Verifying MCP initialization.'
      : 'Measuring 16 fresh-process MCP startups per candidate in rotating order.'
  );
  for (let round = 0; round < (verifyOnly ? 1 : 16); round++)
    for (let offset = 0; offset < variants.length; offset++) {
      const variant = variants[(round + offset) % variants.length];
      const session = await start(variant, environment);
      samples[variant.name].startup.push(session.startup);
      assert.deepEqual(await session.call('echo'), { value: 'omnisql' });
      await session.client.close();
    }
  for (const variant of variants)
    sessions.push({ variant, ...(await start(variant, environment, !verifyOnly)) });
  let copyExpected;
  for (const session of sessions) {
    await assert.rejects(() => session.call('unknown'));
    assert.deepEqual(await session.call('aggregate'), expected);
    assert.deepEqual(await session.call('json'), { counts, sums });
    const copied = await session.call('copy');
    if (copyExpected) assert.deepEqual(copied, copyExpected);
    else copyExpected = copied;
  }
  if (verifyOnly) {
    for (const session of sessions)
      assert.deepEqual(await session.call('cancel'), { cancelled: true, recovered: true });
    console.log(
      'All four official-SDK MCP prototypes match aggregates, JSON summaries, streaming bytes/SHA256, and timeout recovery.'
    );
    process.exitCode = 0;
  } else {
    for (const [mode, warmups, repetitions] of [
      ['echo', 30, 200],
      ['aggregate', 3, 30],
      ['copy', 2, 15],
      ['json', 2, 15],
      ['cancel', 0, 1],
    ]) {
      log('Measuring ' + mode + '.');
      for (const session of sessions) for (let i = 0; i < warmups; i++) await session.call(mode);
      for (let round = 0; round < repetitions; round++)
        for (let offset = 0; offset < sessions.length; offset++) {
          const session = sessions[(round + offset) % sessions.length];
          const begin = performance.now();
          const value = await session.call(mode);
          samples[session.variant.name][mode].push(performance.now() - begin);
          if (mode === 'echo') assert.deepEqual(value, { value: 'omnisql' });
          if (mode === 'aggregate') assert.deepEqual(value, expected);
          if (mode === 'copy') assert.deepEqual(value, copyExpected);
          if (mode === 'json') assert.deepEqual(value, { counts, sums });
          if (mode === 'cancel') assert.deepEqual(value, { cancelled: true, recovered: true });
        }
    }
    const active = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='bench_reader' AND state='active' AND query LIKE 'SELECT pg_sleep%'"
    );
    assert.equal(active.rows[0].count, 0);
    const measurements = {};
    for (const session of sessions) {
      await session.client.close();
      await sleep(50);
      const match = session
        .stderr()
        .match(
          process.platform === 'darwin'
            ? /(\d+)\s+maximum resident set size/
            : /Maximum resident set size \(kbytes\):\s*(\d+)/
        );
      assert(match, session.variant.name + ' peak RSS was not reported');
      measurements[session.variant.name] = {
        ...Object.fromEntries(
          Object.entries(samples[session.variant.name]).map(([key, values]) => [
            key,
            summary(values),
          ])
        ),
        processPeakRssBytes: Number(match[1]) * (process.platform === 'darwin' ? 1 : 1024),
        executableBytes: statSync(session.variant.command).size,
      };
    }
    const report = {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      measuredAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      clientRuntime: process.version,
      bun: execFileSync(variants[1].command, ['--version'], { encoding: 'utf8' }).trim(),
      databaseVersion: (await admin.query('SELECT version()')).rows[0].version,
      dataset: { rows: 100000, jsonFileBytes: statSync(file).size, copy: copyExpected },
      method: {
        startup: '16 fresh processes each, warm filesystem; initialize + listTools, no DB connect',
        order: 'rotating',
        latency: 'one active request globally; persistent lazy connection per server',
        rss: 'macOS /usr/bin/time -l peak over all workloads',
        streaming: 'same PostgreSQL COPY CSV bytes, incremental SHA256, no retained rows',
        json: 'same UTF-8 JSONL; generic values including nested payload; aggregate exact safe-range integer cents',
        timeout: 'native PostgreSQL statement_timeout 150ms; SQLSTATE and recovery checked',
        limitations:
          'Minimal official-SDK prototypes, not full OmniSQL/security parity; loopback PostgreSQL only, no TLS; no analytical engine or all-driver size claims',
      },
      measurements,
    };
    writeFileSync(
      join(reportDirectory, 'language-spike.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
    console.log(
      JSON.stringify(
        {
          dataset: report.dataset,
          measurements: Object.fromEntries(
            Object.entries(measurements).map(([name, values]) => [
              name,
              Object.fromEntries(
                Object.entries(values).map(([key, value]) => [
                  key,
                  value?.samplesMs ? { p50Ms: value.p50Ms, p95Ms: value.p95Ms } : value,
                ])
              ),
            ])
          ),
        },
        null,
        2
      )
    );
  }
} finally {
  for (const session of sessions) await session.client.close().catch(() => {});
  await admin?.end().catch(() => {});
  if (ownedContainer)
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      /* Only this run's container. */
    }
  rmSync(directory, { recursive: true, force: true });
}
