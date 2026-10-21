import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { QueryResult } from '../types.js';
import { QueryGate } from './concurrency.js';

function previewText(text: string, budget: number): string {
  let low = 0,
    high = Math.min(text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, middle) + '…')) <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + '…';
}
interface ClippedCell {
  row: number;
  column: number;
  length: number;
  encoding: 'text' | 'json';
}

interface Entry extends ArtifactSource {
  id: string;
  file: string;
  bytes: number;
  offsets: number[];
  columns: string[];
  expiresAt: number;
  truncated: boolean;
  format: string;
}
export interface ArtifactScope {
  connectionId: string;
  database?: string;
  access: { kind: 'sql'; query: string } | { kind: 'catalog' };
  connectionFingerprint: string;
  policyRevision: string;
}
export interface ArtifactSource {
  stateRevision?: string;
  scopes: ArtifactScope[];
}
export class ResultArtifacts {
  private directory = mkdtempSync(join(tmpdir(), 'omnisql-results-'));
  private waitingWrites = 0;
  private closed = false;
  private readGate = new QueryGate(2, 8);
  private reads = new Set<Promise<unknown>>();
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
  private read<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Result storage is closed'));
    const pending = (async () => {
      const release = await this.readGate.acquire(30000);
      try {
        if (this.closed) throw new Error('Result storage is closed');
        return await work();
      } finally {
        release();
      }
    })();
    this.reads.add(pending);
    void pending.then(
      () => this.reads.delete(pending),
      () => this.reads.delete(pending)
    );
    return pending;
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
    if (this.closed) throw new Error('Result storage is closed');
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
  async export(text: string | Buffer, format: string, source: ArtifactSource) {
    if (this.closed) throw new Error('Result storage is closed');
    return this.write(typeof text === 'string' ? Buffer.from(text) : text, {
      ...source,
      offsets: [],
      columns: [],
      truncated: false,
      format,
    });
  }
  private write(data: Buffer, details: Omit<Entry, 'id' | 'file' | 'bytes' | 'expiresAt'>) {
    if (this.closed) throw new Error('Result storage is closed');
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
    return {
      ...(e.stateRevision === undefined ? {} : { stateRevision: e.stateRevision }),
      scopes: e.scopes.map((scope) => ({ ...scope, access: { ...scope.access } })),
    };
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
      return b;
    } finally {
      await handle.close();
    }
  }
  page(id: string, offset = 0, limit = 100, columnOffset = 0, columnLimit = 50) {
    return this.read(() => this.pageNow(id, offset, limit, columnOffset, columnLimit));
  }
  private async pageNow(
    id: string,
    offset: number,
    limit: number,
    columnOffset: number,
    columnLimit: number
  ) {
    const e = this.get(id);
    if (e.format !== 'jsonl') throw new Error('Use read_export to read this export');
    const total = e.offsets.length - 1;
    if (offset > total) throw new Error('Row offset exceeds stored result');
    const columns: string[] = [];
    let columnBytes = 2;
    for (const column of e.columns.slice(columnOffset, columnOffset + Math.min(columnLimit, 100))) {
      const size = Buffer.byteLength(JSON.stringify(column)) + 1;
      if (columnBytes + size > 16384) break;
      columns.push(column);
      columnBytes += size;
    }
    if (!columns.length && columnOffset < e.columns.length)
      throw new Error('Result column name is too long to page; use a shorter SQL alias');
    const rows: unknown[][] = [];
    const clippedCells: ClippedCell[] = [];
    const metadata = {
      ...this.describe(e),
      columns,
      columnOffset,
      nextColumnOffset:
        columnOffset + columns.length < e.columns.length ? columnOffset + columns.length : null,
      offset,
    };
    let bytes = Buffer.byteLength(
      JSON.stringify({ ...metadata, rows, clippedCells, nextOffset: offset })
    );
    let cursor = offset;
    while (cursor < total && rows.length < Math.min(limit, 1000)) {
      const row = JSON.parse(
        (await this.bytes(e, e.offsets[cursor], e.offsets[cursor + 1])).toString('utf8')
      ) as unknown[];
      const rowClipped: ClippedCell[] = [];
      const budget = Math.min(4000, Math.floor(12000 / Math.max(1, columns.length)));
      const preview = row.slice(columnOffset, columnOffset + columns.length).map((value, index) => {
        const serialized =
          typeof value === 'string' && value.length > budget ? undefined : JSON.stringify(value);
        if (serialized !== undefined && Buffer.byteLength(serialized) <= budget) return value;
        const text = typeof value === 'string' ? value : serialized!;
        rowClipped.push({
          row: cursor,
          column: columnOffset + index,
          length: text.length,
          encoding: typeof value === 'string' ? 'text' : 'json',
        });
        return previewText(text, budget);
      });
      const size =
        Buffer.byteLength(JSON.stringify(preview)) +
        (rows.length ? 1 : 0) +
        Buffer.byteLength(JSON.stringify(rowClipped)) -
        2 +
        (clippedCells.length && rowClipped.length ? 1 : 0);
      if (bytes + size > 65500 && rows.length) break;
      if (bytes + size > 65500)
        throw new Error('Row has too many columns for a page; select fewer columns');
      rows.push(preview);
      clippedCells.push(...rowClipped);
      bytes += size;
      cursor++;
    }
    return {
      ...metadata,
      rows,
      clippedCells,
      nextOffset: cursor < total ? cursor : null,
    };
  }
  cell(id: string, row: number, column: number, offset = 0, length = 16000) {
    return this.read(() => this.cellNow(id, row, column, offset, length));
  }
  private async cellNow(id: string, row: number, column: number, offset: number, length: number) {
    const e = this.get(id);
    if (e.format !== 'jsonl' || row >= e.offsets.length - 1 || column >= e.columns.length)
      throw new Error('Result cell does not exist');
    const values = JSON.parse(
      (await this.bytes(e, e.offsets[row], e.offsets[row + 1])).toString('utf8')
    );
    const value = values[column];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (offset > text.length) throw new Error('Cell offset exceeds its length');
    let end = Math.min(offset + Math.min(length, 16000), text.length);
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > 48000) {
      let low = offset,
        high = end;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(text.slice(offset, middle))) <= 48000) low = middle;
        else high = middle - 1;
      }
      end = low;
    }
    return {
      resultId: id,
      row,
      column,
      offset,
      encoding: typeof value === 'string' ? ('text' as const) : ('json' as const),
      text: text.slice(offset, end),
      length: text.length,
      nextOffset: end < text.length ? end : null,
    };
  }
  readExport(id: string, offset = 0, length = 16000) {
    return this.read(() => this.readExportNow(id, offset, length));
  }
  private async readExportNow(id: string, offset: number, length: number) {
    const e = this.get(id);
    if (e.format === 'jsonl') throw new Error('Use read_result to read rows');
    if (offset > e.bytes) throw new Error('Export offset exceeds its length');
    // Base64 chunks use byte offsets; UTF-8 characters may cross chunk boundaries.
    const end = Math.min(offset + Math.min(length, 45000), e.bytes);
    const b = await this.bytes(e, offset, end);
    return {
      ...this.describe(e),
      offset,
      encoding: 'base64',
      data: b.toString('base64'),
      nextOffset: end < e.bytes ? end : null,
    };
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    await this.writes;
    await Promise.allSettled([...this.reads]);
    this.entries.clear();
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}
