import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  statSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(root, '../..');
const bun =
  process.env.OMNISQL_BENCH_BUN ||
  execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
const output = resolve(process.argv[2] || join(root, 'results/size.json'));
function directorySize(directory) {
  const seen = new Set();
  let bytes = 0,
    files = 0;
  function visit(path) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    const key = entry.dev + ':' + entry.ino;
    if (!entry.isFile() || seen.has(key)) return;
    seen.add(key);
    bytes += entry.size;
    files++;
  }
  visit(directory);
  return { bytes, uniqueRegularFiles: files };
}
const temp = mkdtempSync(join(tmpdir(), 'omnisql-language-size-'));
try {
  for (const name of ['package.json', 'bun.lock', 'docs-site/package.json']) {
    mkdirSync(dirname(join(temp, name)), { recursive: true });
    copyFileSync(join(repository, name), join(temp, name));
  }
  execFileSync(bun, ['install', '--production', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: temp,
    stdio: 'pipe',
  });
  const files = {
    node: process.execPath,
    bun,
    rust: join(root, 'rust/target/release/omnisql-language-spike'),
    go: join(root, 'bin/go-server'),
  };
  const executables = Object.fromEntries(
    Object.entries(files).map(([name, file]) => [
      name,
      { bytes: statSync(file).size, gzip9Bytes: gzipSync(readFileSync(file), { level: 9 }).length },
    ])
  );
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repository,
      encoding: 'utf8',
    })
  );
  const report = {
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim(),
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    productionDependencies: directorySize(join(temp, 'node_modules')),
    currentPackage: {
      tarballBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      files: packed.entryCount,
    },
    minimalJsDependencies: directorySize(join(root, 'js/node_modules')),
    executables,
    method:
      'Fresh production frozen install without lifecycle scripts; sum regular-file lengths and deduplicate hardlinks; runtime executable sizes exclude dynamically linked system libraries. Native prototypes include SDK, PostgreSQL driver and SHA256 but omit production features. Gzip sizes are individual executables, not release archives. Do not run concurrently with timing benchmarks.',
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
