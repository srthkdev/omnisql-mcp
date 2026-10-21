import { afterEach, describe, expect, it, vi } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPrivateFile } from '../src/runtime/private-file.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnisql-private-file-'));
afterEach(() => {
  vi.restoreAllMocks();
  for (const file of fs.readdirSync(root)) fs.rmSync(path.join(root, file), { force: true });
});
describe('bounded private file reads', () => {
  it('preserves UTF-8 spanning read chunks and accepts the exact byte limit', () => {
    const file = path.join(root, 'config.json');
    const text = 'x'.repeat(65535) + '🙂';
    fs.writeFileSync(file, text);
    expect(readPrivateFile(file, Buffer.byteLength(text), 'Fixture')).toBe(text);
    expect(() => readPrivateFile(file, Buffer.byteLength(text) - 1, 'Fixture')).toThrow(/size/);
  });
  it('enforces the read limit even when the file grows after the metadata check', () => {
    const file = path.join(root, 'growing');
    fs.writeFileSync(file, 'x'.repeat(100));
    const original = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
      const stat = original(...args);
      return Object.assign(stat, { size: 1 });
    });
    expect(() => readPrivateFile(file, 10, 'Fixture')).toThrow(/size/);
  });
  it('rejects symlinks and special files without blocking on a FIFO', () => {
    if (process.platform === 'win32') return;
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, link);
    expect(() => readPrivateFile(link, 100, 'Fixture')).toThrow();
    const fifo = path.join(root, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(() => readPrivateFile(fifo, 100, 'Fixture')).toThrow(/regular file/);
  });
});
