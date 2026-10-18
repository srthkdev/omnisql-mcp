import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, watch } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { build, output, base, root } from './build.mjs';
await build();
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jxl': 'image/jxl',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.sh': 'text/plain',
};
const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') {
    res.writeHead(302, { Location: base }).end();
    return;
  }
  if (!pathname.startsWith(base)) {
    res.writeHead(404).end();
    return;
  }
  let file = resolve(output, pathname.slice(base.length));
  if (!file.startsWith(output + '/') && file !== output) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end(readFileSync(join(output, '404.html')));
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(file));
});
const port = Number(process.env.PORT || 4321);
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}${base}`));
let pending;
for (const directory of ['docs', 'styles', 'client', 'data', 'scripts'])
  watch(join(root, directory), { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        await build();
      } catch (error) {
        console.error(error.message);
      }
    }, 150);
  });
