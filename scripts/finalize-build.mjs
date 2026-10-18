import { readFileSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
const entry = new URL('../dist/index.js', import.meta.url);
const source = readFileSync(entry, 'utf8');
writeFileSync(entry, source.startsWith('#!') ? source : `#!/usr/bin/env node\n${source}`);
chmodSync(entry, 0o755);

cpSync(new URL('../src/native/', import.meta.url), new URL('../dist/native/', import.meta.url), {
  recursive: true,
});
