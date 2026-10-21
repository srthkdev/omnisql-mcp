import fs from 'node:fs';

/** Read one regular file through the checked descriptor, with a hard allocation limit. */
export function readPrivateFile(file: string, maxBytes: number, label: string): string {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds its size limit`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > maxBytes) throw new Error(`${label} exceeds its size limit`);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
