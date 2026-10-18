import { Transpiler } from 'bun';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { posix } from 'node:path';
const root = new URL('../', import.meta.url);
const source = new URL('src/', root);
const output = new URL('dist/', root);
rmSync(output, { recursive: true, force: true });
const transpiler = new Transpiler({ loader: 'ts', target: 'node' });
function compile(relative = '') {
  for (const entry of readdirSync(new URL(relative, source), { withFileTypes: true })) {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) compile(path + '/');
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const target = new URL(path.replace(/\.ts$/, '.js'), output);
      mkdirSync(new URL('./', target), { recursive: true });
      writeFileSync(target, transpiler.transformSync(readFileSync(new URL(path, source), 'utf8')));
    }
  }
}
compile();
await import('./finalize-build.mjs');
