import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { gzipSync, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clickhouseAdapter } from '../dist/runtime/clickhouse.js';

const directory = mkdtempSync(join(tmpdir(), 'omnisql-http-'));
const openssl = (args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
const adapters = [];
const servers = [];
let mode = 'ok',
  requests = 0,
  redirected = 0,
  last;
const transcript = '["value"]\n["UInt8"]\n[1]\n';
async function listen(server) {
  servers.push(server);
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server.address().port;
}
try {
  const destination = await listen(
    http.createServer((_, response) => {
      redirected++;
      response.end('unexpected');
    })
  );
  const handler = (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        requests++;
        const body = Buffer.concat(chunks);
        last = {
          compressed: ['gzip', 'zstd'].includes(request.headers['content-encoding']),
          sql: (request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(body)
            : request.headers['content-encoding'] === 'zstd'
              ? zstdDecompressSync(body)
              : body
          ).toString(),
          readonly: new URL(request.url, 'http://fixture').searchParams.get('readonly'),
        };
        if (mode === 'redirect') {
          response.writeHead(302, { Location: `http://127.0.0.1:${destination}/` });
          response.end();
          return;
        }
        if (mode === 'empty') {
          response.end();
          return;
        }
        if (mode === 'late') {
          response.write(transcript);
          setImmediate(() => response.end('Code: 241. DB::Exception: synthetic late failure\n'));
          return;
        }
        if (mode === 'abort') {
          response.write(transcript);
          setImmediate(() => response.socket?.destroy());
          return;
        }
        const data =
          mode === 'unicode'
            ? '["value"]\n["String"]\n' + JSON.stringify(['a'.repeat(16383) + 'नमस्ते🙂']) + '\n'
            : mode === 'wide'
              ? '["value"]\n["String"]\n["' + 'x'.repeat(1048576) + '"]\n'
              : mode === 'rows'
                ? '["value"]\n["UInt8"]\n[1]\n[2]\n[3]\n'
                : transcript;
        const zstd = mode === 'zstd';
        response.writeHead(200, { 'Content-Encoding': zstd ? 'zstd' : 'gzip' });
        response.end(zstd ? zstdCompressSync(Buffer.from(data)) : gzipSync(data));
      } catch {
        response.statusCode = 400;
        response.end('Invalid fixture request');
      }
    });
  };
  const port = await listen(http.createServer(handler));
  const adapter = clickhouseAdapter({
    timeout: () => 3000,
    endpoint: async () => ({ host: '127.0.0.1', port }),
  });
  adapters.push(adapter);
  const connection = {
    id: 'fixture',
    name: 'fixture',
    driver: 'clickhouse',
    host: '127.0.0.1',
    database: 'fixture',
    url: '',
  };
  const options = { readOnly: true };
  assert.deepEqual((await adapter.execute(connection, 'SELECT 1', options)).rows, [[1]]);
  assert.equal(last.readonly, '1');
  mode = 'unicode';
  assert.deepEqual((await adapter.execute(connection, 'SELECT 1', options)).rows, [
    ['a'.repeat(16383) + 'नमस्ते🙂'],
  ]);
  mode = 'ok';
  mode = 'zstd';
  assert.deepEqual((await adapter.execute(connection, 'SELECT 1', options)).rows, [[1]]);
  mode = 'ok';
  await adapter.execute(connection, "SELECT '" + 'q'.repeat(70000) + "'", options);
  assert(last.compressed);
  assert.equal(last.sql, "SELECT '" + 'q'.repeat(70000) + "'");
  mode = 'rows';
  assert.equal(
    (await adapter.execute({ ...connection, limits: { maxRows: 2 } }, 'SELECT 1', options))
      .truncated,
    true
  );
  mode = 'wide';
  await assert.rejects(
    () => adapter.execute({ ...connection, limits: { maxBytes: 1024 } }, 'SELECT 1', options),
    /byte limit/
  );
  mode = 'late';
  await assert.rejects(
    () => adapter.execute(connection, 'SELECT 1', options),
    /synthetic late failure/
  );
  mode = 'abort';
  await assert.rejects(
    () => adapter.execute(connection, 'SELECT 1', options),
    /ended before|aborted|reset|closed/i
  );
  mode = 'empty';
  await assert.rejects(() => adapter.execute(connection, 'SELECT 1', options), /Missing.*headers/);
  mode = 'redirect';
  await assert.rejects(() => adapter.execute(connection, 'SELECT 1', options), /redirects/);
  assert.equal(redirected, 0);
  mode = 'ok';
  assert.deepEqual((await adapter.execute(connection, 'SELECT 1', options)).rows, [[1]]);
  const before = requests;
  for (const query of [
    "SELECT * FROM url('http://example.invalid/','CSV','value String')",
    'SELECT 1 SETTINGS readonly=0',
    "EXPLAIN json=1 SELECT * FROM file('/omnisql-fixture/blocked.txt','RawBLOB')",
  ])
    await assert.rejects(
      () => adapter.execute(connection, query, options),
      /disabled|analyzed safely/
    );
  assert.equal(requests, before);
  await assert.rejects(
    () =>
      adapter.execute(
        { ...connection, properties: { 'clickhouse.readonlyMode': '0' } },
        'SELECT 1',
        options
      ),
    /readonlyMode/
  );
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-days',
    '1',
    '-subj',
    '/CN=OmniSQL HTTP fixture CA',
  ]);
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=db.synthetic.invalid',
  ]);
  writeFileSync(join(directory, 'extensions'), 'subjectAltName=DNS:db.synthetic.invalid\n');
  openssl([
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.crt',
    '-days',
    '1',
    '-extfile',
    'extensions',
  ]);
  const securePort = await listen(
    https.createServer(
      {
        key: readFileSync(join(directory, 'server.key')),
        cert: readFileSync(join(directory, 'server.crt')),
      },
      handler
    )
  );
  const secure = clickhouseAdapter({
    timeout: () => 3000,
    endpoint: async () => ({ host: '127.0.0.1', port: securePort }),
  });
  adapters.push(secure);
  const tls = {
    ...connection,
    host: 'db.synthetic.invalid',
    properties: { ssl: 'true', sslrootcert: join(directory, 'ca.crt') },
  };
  assert.deepEqual((await secure.execute(tls, 'SELECT 1', options)).rows, [[1]]);
  await assert.rejects(
    () => secure.execute({ ...tls, host: 'wrong.synthetic.invalid' }, 'SELECT 1', options),
    /hostname|altname|certificate/i
  );
  await assert.rejects(
    () => secure.execute({ ...tls, properties: { ssl: 'true' } }, 'SELECT 1', options),
    /certificate|issuer|self.signed/i
  );
  await assert.rejects(
    () =>
      secure.execute(
        { ...tls, properties: { ssl: 'true', sslrootcert: join(directory, 'missing.crt') } },
        'SELECT 1',
        options
      ),
    /Cannot read configured TLS/
  );
  const mutualPort = await listen(
    https.createServer(
      {
        key: readFileSync(join(directory, 'server.key')),
        cert: readFileSync(join(directory, 'server.crt')),
        ca: readFileSync(join(directory, 'ca.crt')),
        requestCert: true,
        rejectUnauthorized: true,
      },
      handler
    )
  );
  const mutual = clickhouseAdapter({
    timeout: () => 3000,
    endpoint: async () => ({ host: '127.0.0.1', port: mutualPort }),
  });
  adapters.push(mutual);
  await assert.rejects(
    () => mutual.execute(tls, 'SELECT 1', options),
    /certificate|alert|socket|reset|closed/i
  );
  const authenticated = {
    ...tls,
    properties: {
      ...tls.properties,
      sslcert: join(directory, 'server.crt'),
      sslkey: join(directory, 'server.key'),
    },
  };
  assert.deepEqual((await mutual.execute(authenticated, 'SELECT 1', options)).rows, [[1]]);
  console.log(
    'HTTP transport: zstd/gzip requests/responses, decoded-byte/row caps, late errors, aborted bodies, redirects, external-function guards, and original-host TLS validation passed.'
  );
} finally {
  for (const adapter of adapters) adapter.close();
  await Promise.all(
    servers.map((server) => new Promise((resolveClose) => server.close(resolveClose)))
  );
  rmSync(directory, { recursive: true, force: true });
}
