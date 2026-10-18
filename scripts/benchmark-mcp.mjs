import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Alternating warm calls keep connection/policy comparisons in the same fixture. */
export async function benchmarkReadScopes(query, engine, scope) {
  if (!process.env.OMNISQL_BENCHMARK_REPORT_DIR) return;
  const values = { raw: [], sales: [] };
  for (let i = 0; i < 33; i++)
    for (const id of i % 2 ? ['raw', 'sales'] : ['sales', 'raw']) {
      const started = performance.now();
      await query(id, 'SELECT SUM(total) FROM orders');
      if (i >= 3) values[id].push(performance.now() - started);
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
    scope,
  };
  const directory = resolve(process.env.OMNISQL_BENCHMARK_REPORT_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(
      directory,
      `${new Date().toISOString().slice(0, 10)}-${engine}-${process.versions.bun ? 'bun' : 'node'}.json`
    ),
    JSON.stringify(report, null, 2) + '\n'
  );
}
