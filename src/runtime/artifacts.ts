import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { QueryResult } from '../types.js';

interface Entry {
  id: string;
  file: string;
  bytes: number;
  offsets: number[];
  columns: string[];
  expiresAt: number;
  connectionId: string;
  database?: string;
  query: string;
  truncated: boolean;
  format: string;
}
export interface ArtifactSource {
  connectionId: string;
  database?: string;
  query: string;
}
export class ResultArtifacts {
  private directory = mkdtempSync(join(tmpdir(), 'omnisql-results-'));
  private waitingWrites = 0;
  private entries = new Map<string, Entry>();
  private writes: Promise<void> = Promise.resolve();
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    private ttl = 15 * 60 * 1000,
    private quota = 64 * 1024 * 1024
  ) {
    chmodSync(this.directory, 0o700);
    this.sweep = setInterval(() => {
      void this.expire();
    }, 60000);
    this.sweep.unref();
  }
  private async expire() {
    for (const entry of this.entries.values())
      if (entry.expiresAt <= Date.now()) await this.remove(entry);
  }
  private async remove(entry: Entry) {
    this.entries.delete(entry.id);
    await fs.unlink(entry.file).catch(() => {});
  }
  private async reserve(bytes: number) {
    if (bytes > this.quota) throw new Error('Result exceeds artifact storage quota');
    await this.expire();
    const used = () => [...this.entries.values()].reduce((total, e) => total + e.bytes, 0);
    while (this.entries.size >= 32 || used() + bytes > this.quota) {
      const first = this.entries.values().next().value;
      if (!first) break;
      await this.remove(first);
    }
  }
  async save(result: QueryResult, source: ArtifactSource) {
    const buffers: Buffer[] = [];
    const offsets = [0];
    let bytes = 0;
    for (const row of result.rows) {
      const b = Buffer.from(JSON.stringify(row) + '\n');
      buffers.push(b);
      bytes += b.length;
      offsets.push(bytes);
    }
    return this.write(Buffer.concat(buffers), {
      ...source,
      offsets,
      columns: result.columns,
      truncated: result.truncated === true,
      format: 'jsonl',
    });
  }
  async export(text: string, format: 'csv' | 'json', source: ArtifactSource) {
    return this.write(Buffer.from(text), {
      ...source,
      offsets: [],
      columns: [],
      truncated: false,
      format,
    });
  }
  private write(data: Buffer, details: Omit<Entry, 'id' | 'file' | 'bytes' | 'expiresAt'>) {
    if (this.waitingWrites >= 8) throw new Error('Result storage queue is full; retry later');
    this.waitingWrites++;
    const pending = this.writes
      .then(() => this.writeNow(data, details))
      .finally(() => {
        this.waitingWrites--;
      });
    this.writes = pending.then(
      () => {},
      () => {}
    );
    return pending;
  }
  private async writeNow(
    data: Buffer,
    details: Omit<Entry, 'id' | 'file' | 'bytes' | 'expiresAt'>
  ) {
    await this.reserve(data.length);
    const id = randomBytes(16).toString('hex');
    const file = join(this.directory, id + '.' + details.format);
    const handle = await fs.open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    const entry: Entry = {
      ...details,
      id,
      file,
      bytes: data.length,
      expiresAt: Date.now() + this.ttl,
    };
    this.entries.set(id, entry);
    return this.describe(entry);
  }
  private describe(e: Entry) {
    return {
      resultId: e.id,
      expiresAt: new Date(e.expiresAt).toISOString(),
      storedRows: Math.max(0, e.offsets.length - 1),
      bytes: e.bytes,
      format: e.format,
      truncated: e.truncated,
    };
  }
  source(id: string): ArtifactSource {
    const e = this.get(id);
    return { connectionId: e.connectionId, database: e.database, query: e.query };
  }
  private get(id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid result ID');
    const e = this.entries.get(id);
    if (!e || e.expiresAt <= Date.now())
      throw new Error('Result not found or expired; run the query again');
    return e;
  }
  private async bytes(e: Entry, start: number, end: number) {
    const handle = await fs.open(e.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const b = Buffer.alloc(end - start);
      const read = await handle.read(b, 0, b.length, start);
      if (read.bytesRead !== b.length) throw new Error('Result artifact is incomplete');
      return b.toString('utf8');
    } finally {
      await handle.close();
    }
  }
  async page(id: string, offset = 0, limit = 100, columnOffset = 0, columnLimit = 50) {
    const e = this.get(id);
    if (e.format !== 'jsonl') throw new Error('Use read_export to read this export');
    const total = e.offsets.length - 1;
    if (offset > total) throw new Error('Row offset exceeds stored result');
    const columns = e.columns.slice(columnOffset, columnOffset + Math.min(columnLimit, 100));
    const rows: unknown[][] = [];
    const clippedCells: { row: number; column: number; length: number }[] = [];
    let bytes = 0;
    let cursor = offset;
    while (cursor < total && rows.length < Math.min(limit, 1000)) {
      const row = JSON.parse(
        await this.bytes(e, e.offsets[cursor], e.offsets[cursor + 1])
      ) as unknown[];
      const preview = row
        .slice(columnOffset, columnOffset + Math.min(columnLimit, 100))
        .map((v, index) => {
          const column = columnOffset + index;
          const text = typeof v === 'string' ? v : JSON.stringify(v);
          if (
            text &&
            text.length > Math.min(4000, Math.floor(12000 / Math.max(1, columns.length)))
          ) {
            clippedCells.push({ row: cursor, column, length: text.length });
            return (
              text.slice(0, Math.min(4000, Math.floor(12000 / Math.max(1, columns.length)))) + '…'
            );
          }
          return v;
        });
      const size = Buffer.byteLength(JSON.stringify(preview));
      if (bytes + size > 65536 && rows.length) break;
      if (size > 65536)
        throw new Error('Row has too many columns for a page; select fewer columns');
      rows.push(preview);
      bytes += size;
      cursor++;
    }
    return {
      ...this.describe(e),
      columns,
      columnOffset,
      nextColumnOffset:
        columnOffset + columns.length < e.columns.length ? columnOffset + columns.length : null,
      offset,
      rows,
      clippedCells,
      nextOffset: cursor < total ? cursor : null,
    };
  }
  async cell(id: string, row: number, column: number, offset = 0, length = 16000) {
    const e = this.get(id);
    if (e.format !== 'jsonl' || row >= e.offsets.length - 1 || column >= e.columns.length)
      throw new Error('Result cell does not exist');
    const values = JSON.parse(await this.bytes(e, e.offsets[row], e.offsets[row + 1]));
    const value = values[column];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (offset > text.length) throw new Error('Cell offset exceeds its length');
    const end = Math.min(offset + Math.min(length, 16000), text.length);
    return {
      resultId: id,
      row,
      column,
      offset,
      text: text.slice(offset, end),
      length: text.length,
      nextOffset: end < text.length ? end : null,
    };
  }
  async readExport(id: string, offset = 0, length = 16000) {
    const e = this.get(id);
    if (e.format === 'jsonl') throw new Error('Use read_result to read rows');
    if (offset > e.bytes) throw new Error('Export offset exceeds its length');
    // Base64 chunks use byte offsets; UTF-8 characters may cross chunk boundaries.
    const end = Math.min(offset + Math.min(length, 48000), e.bytes);
    const handle = await fs.open(e.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const b = Buffer.alloc(end - offset);
      await handle.read(b, 0, b.length, offset);
      return {
        ...this.describe(e),
        offset,
        encoding: 'base64',
        data: b.toString('base64'),
        nextOffset: end < e.bytes ? end : null,
      };
    } finally {
      await handle.close();
    }
  }
  async close() {
    clearInterval(this.sweep);
    await this.writes;
    this.entries.clear();
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}
