import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
const entry = new URL('../dist/index.js', import.meta.url);
const source = readFileSync(entry, 'utf8');
writeFileSync(entry, source.startsWith('#!') ? source : `#!/usr/bin/env node\n${source}`);
chmodSync(entry, 0o755);
