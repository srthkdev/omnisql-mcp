import http from 'node:http';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Called only with the seeded fixture's loopback endpoint and generated credentials. */
export async function benchmarkHttpCompression(port, user, password) {
  if (!process.env.OMNISQL_BENCHMARK_REPORT_DIR) return;
  const query = "SELECT id,repeat('x',100) AS payload FROM orders ORDER BY id LIMIT 10000";
  const transfer = (compressed) =>
    new Promise((resolveTransfer, reject) => {
      const parameters = new URLSearchParams({
        database: 'sales',
        default_format: 'JSONCompactEachRowWithNamesAndTypes',
        readonly: '2',
        max_execution_time: '5',
        enable_http_compression: compressed !== 'identity' ? '1' : '0',
      });
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/?' + parameters,
          agent: false,
          headers: {
            Authorization: 'Basic ' + Buffer.from(user + ':' + password).toString('base64'),
            ...(compressed !== 'identity' ? { 'Accept-Encoding': compressed } : {}),
          },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 8388608) request.destroy(new Error('Benchmark output exceeded 8 MiB'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(new Error('Compression benchmark query failed'));
              return;
            }
            try {
              const data = Buffer.concat(chunks),
                encoding = response.headers['content-encoding'] || 'identity';
              const decoded =
                encoding === 'gzip'
                  ? gunzipSync(data, { maxOutputLength: 8388608 })
                  : encoding === 'zstd'
                    ? zstdDecompressSync(data, { maxOutputLength: 8388608 })
                    : data;
              resolveTransfer({
                encoding,
                wireBytes: bytes,
                decodedBytes: decoded.length,
                sha256: createHash('sha256').update(decoded).digest('hex'),
              });
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('Compression benchmark timed out')));
      request.end(query);
    });
  const identity = await transfer('identity'),
    gzip = await transfer('gzip'),
    zstd = await transfer('zstd');
  if (
    identity.sha256 !== gzip.sha256 ||
    identity.sha256 !== zstd.sha256 ||
    gzip.encoding !== 'gzip' ||
    zstd.encoding !== 'zstd'
  )
    throw new Error('HTTP compression changed the query bytes or was not negotiated');
  const report = {
    identity,
    gzip,
    zstd,
    scope:
      'Three native HTTP transfers of the same sorted 10,000-row synthetic ClickHouse result with a repeated 100-character payload. Counts response-body wire bytes, excluding headers; decoded SHA-256 must match. Server gzip/zstd settings remain at their fixture defaults. No latency or general workload speedup claim.',
  };
  const directory = resolve(process.env.OMNISQL_BENCHMARK_REPORT_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(
      directory,
      `${new Date().toISOString().slice(0, 10)}-clickhouse-http-${process.versions.bun ? 'bun' : 'node'}.json`
    ),
    JSON.stringify(report, null, 2) + '\n'
  );
}
