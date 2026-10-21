import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { output, base, build, pages, root, legacyRoutes } from './build.mjs';

await build();
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else files.push(file);
  }
}
walk(output);
const ids = new Map();
const htmlFiles = files.filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  assert.equal([...html.matchAll(/<h1[ >]/g)].length, 1, `${file}: expected one h1`);
  assert.match(html, /<main id="main"/);
  const pageIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(pageIds.length, new Set(pageIds).size, `${file}: duplicate IDs`);
  ids.set(file, new Set(pageIds));
  assert(!/docusaurus|undraw_/i.test(html));
}
function checkLink(href, from) {
  if (!href.startsWith(base) && !href.startsWith('#')) return;
  const [path, fragment] = href.split('#');
  let target = path ? join(output, path.slice(base.length)) : from;
  assert(existsSync(target), `${from}: missing ${href}`);
  if (statSync(target).isDirectory()) target = join(target, 'index.html');
  if (fragment) assert(ids.get(target)?.has(fragment), `${from}: missing fragment ${href}`);
}
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const [, href] of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)) checkLink(href, file);
}
for (const item of JSON.parse(readFileSync(join(output, 'search.json'), 'utf8')))
  checkLink(item.url, 'search.json');
assert.equal(files.filter((file) => file.endsWith('/index.html')).length, pages.length + legacyRoutes.length + 1);
assert.equal(
  readFileSync(join(output, 'install.sh'), 'utf8'),
  readFileSync(join(root, '../scripts/install.sh'), 'utf8')
);
for (const asset of [
  'logo.svg',
  'codex-session.mp4',
  'mcp-instance-calls.webp',
  'mcp-multiple-instances.webp',
  'social-card.png',
])
  assert(existsSync(join(output, 'media', asset)), `Missing asset: ${asset}`);
console.log('All pages, fragments, search destinations, media, and installer paths checked.');
