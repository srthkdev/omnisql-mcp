import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const node = process.argv.find((a) => a.startsWith('--node='))?.slice(7) ?? 'node';
const bun = process.argv.find((a) => a.startsWith('--bun='))?.slice(6) ?? 'bun';
const directory = mkdtempSync(join(tmpdir(), 'omnisql-build-bench-'));
const cases = {
  previousTypecheckAndEmit: [
    node,
    [resolve('node_modules/typescript/bin/tsc'), '--outDir', directory],
  ],
  bunTranspileAndCopy: [bun, ['scripts/build.mjs']],
  independentTypecheck: [node, [resolve('node_modules/typescript/bin/tsc'), '--noEmit']],
};
const results = {};
try {
  for (const [name, [command, args]] of Object.entries(cases)) {
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const process = spawnSync(command, args, { encoding: 'utf8' });
      if (process.status !== 0) throw new Error(process.stderr || process.stdout);
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results[name] = { p50Ms: sorted[4], p95Ms: sorted[9], samplesMs: samples };
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        samples: 10,
        results,
        scope:
          'Local warm-cache builds. The previous compiler combines type checking and emit. Bun transpiles without checking types; the independent typecheck remains required. Do not present transpile-only time as complete validation time.',
      },
      null,
      2
    )
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
