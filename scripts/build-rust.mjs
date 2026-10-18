import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
const result = spawnSync(
  'wasm-pack',
  [
    'build',
    'native/sql-policy',
    '--target',
    'nodejs',
    '--out-dir',
    '../../src/native',
    '--release',
    '--locked',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUSTFLAGS: [
        process.env.RUSTFLAGS ?? '',
        `--remap-path-prefix=${process.env.HOME}=~`,
        `--remap-path-prefix=${process.cwd()}=omnisql-mcp`,
      ].join(' '),
    },
  }
);
if (result.status !== 0) process.exit(result.status ?? 1);
if (existsSync('src/native/.gitignore')) unlinkSync('src/native/.gitignore');
const file = 'src/native/package.json';
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.type = 'commonjs';
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');

const format = spawnSync(
  'npm',
  ['exec', '--', 'prettier', '--write', 'src/native/*.d.ts', 'src/native/*.js'],
  { stdio: 'inherit' }
);
if (format.status !== 0) process.exit(format.status ?? 1);
