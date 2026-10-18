import type { DatabaseConnection, QueryResult } from '../types.js';

/** Do not replace non-UTF-8 database bytes with a different value. */
export class ResultTextDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  decode(chunk?: Uint8Array): string {
    try {
      return this.decoder.decode(chunk, { stream: chunk !== undefined });
    } catch {
      throw new Error(
        'Database result contains invalid UTF-8; select hex/base64 text for binary values'
      );
    }
  }
}

/** Shared row and byte budget, applied while each native driver fetches rows. */
export class ResultCollector {
  readonly rows: unknown[][] = [];
  private names: string[] = [];
  private nameBytes = 2;
  get columns(): string[] {
    return this.names;
  }
  set columns(value: string[]) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.bytes += bytes - this.nameBytes;
    this.nameBytes = bytes;
    this.names = value;
  }
  truncated = false;
  limitReason?: 'rows' | 'bytes';
  private bytes = 2;
  readonly maxRows: number;
  readonly maxBytes: number;
  constructor(connection: DatabaseConnection, maxRows?: number) {
    this.maxRows = Math.min(maxRows ?? 1000, connection.limits?.maxRows ?? 100000);
    this.maxBytes = connection.limits?.maxBytes ?? 1024 * 1024;
  }
  add(row: unknown[]): boolean {
    this.checkColumns();
    if (this.rows.length >= this.maxRows) {
      this.truncated = true;
      this.limitReason = 'rows';
      return false;
    }
    if (row.some((v) => typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)))
      throw new Error(
        'Driver returned an inexact integer; CAST this expression to a string in SQL'
      );
    const normalized = row.map((v) =>
      v instanceof Date
        ? v.toISOString()
        : typeof v === 'bigint'
          ? v.toString()
          : Buffer.isBuffer(v)
            ? { encoding: 'base64', data: v.toString('base64') }
            : v
    );
    const size = Buffer.byteLength(JSON.stringify(normalized));
    if (this.bytes + size > this.maxBytes) {
      this.truncated = true;
      this.limitReason = 'bytes';
      return false;
    }
    this.rows.push(normalized);
    this.bytes += size;
    return true;
  }
  result(affectedRows?: number): QueryResult {
    this.checkColumns();
    return {
      columns: this.columns,
      rows: this.rows,
      rowCount: this.columns.length ? this.rows.length : (affectedRows ?? 0),
      executionTime: 0,
      truncated: this.truncated,
      ...(this.limitReason ? { limitReason: this.limitReason } : {}),
    };
  }
  private checkColumns(): void {
    if (this.nameBytes > 65536 || this.nameBytes > this.maxBytes)
      throw new Error(
        'Result column names exceed the byte limit; select fewer columns or shorter aliases'
      );
  }
}

/** Preserve repeated column names and integers beyond Number's exact range. */
function jsonReader(text: string, decimalText: boolean) {
  let offset = 0;
  const skip = () => {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const take = (char: string) => {
    skip();
    if (text[offset++] !== char) throw new Error('Invalid database JSON');
  };
  const value = (depth = 0): unknown => {
    if (depth > 64) throw new Error('JSON nesting exceeds the result limit');
    skip();
    const start = offset;
    if (text[offset] === '[') {
      take('[');
      const items: unknown[] = [];
      skip();
      while (text[offset] !== ']') {
        items.push(value(depth + 1));
        skip();
        if (text[offset] !== ',') break;
        offset++;
      }
      take(']');
      return items;
    }
    if (text[offset] === '{') {
      take('{');
      const object: Record<string, unknown> = Object.create(null);
      skip();
      while (text[offset] !== '}') {
        const key = value(depth + 1);
        if (typeof key !== 'string') throw new Error('Invalid JSON object key');
        take(':');
        object[key] = value(depth + 1);
        skip();
        if (text[offset] !== ',') break;
        offset++;
      }
      take('}');
      return object;
    }
    if (text[offset] === '"') {
      offset++;
      while (offset < text.length) {
        if (text[offset] === '\\') {
          offset += 2;
          continue;
        }
        if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
      }
      throw new Error('Invalid database JSON string');
    }
    const token = text
      .slice(offset)
      .match(/^(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('Invalid database value');
    offset += token.length;
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return token;
    if (decimalText && /^-?\d/.test(token) && /[.eE]/.test(token)) return token;
    return JSON.parse(token);
  };
  return {
    skip,
    take,
    value,
    get offset() {
      return offset;
    },
    set offset(value: number) {
      offset = value;
    },
  };
}
export function parseJsonValue(text: string, decimalText = false): unknown {
  const reader = jsonReader(text, decimalText);
  const value = reader.value();
  reader.skip();
  if (reader.offset !== text.length) throw new Error('Trailing database JSON');
  return value;
}
export function parseJsonRows(
  text: string,
  decimalText = false
): { columns: string[]; rows: unknown[][] } {
  const reader = jsonReader(text, decimalText);
  if (!text.trim()) return { columns: [], rows: [] };
  reader.take('[');
  const rows: unknown[][] = [];
  let columns: string[] = [];
  reader.skip();
  while (text[reader.offset] !== ']') {
    reader.take('{');
    const names: string[] = [];
    const row: unknown[] = [];
    reader.skip();
    while (text[reader.offset] !== '}') {
      const key = reader.value();
      if (typeof key !== 'string') throw new Error('Invalid database column');
      reader.take(':');
      names.push(key);
      row.push(reader.value());
      reader.skip();
      if (text[reader.offset] !== ',') break;
      reader.offset++;
    }
    reader.take('}');
    if (!columns.length) columns = names;
    else if (JSON.stringify(columns) !== JSON.stringify(names))
      throw new Error('Inconsistent database columns');
    rows.push(row);
    reader.skip();
    if (text[reader.offset] !== ',') break;
    reader.offset++;
  }
  reader.take(']');
  reader.skip();
  if (reader.offset !== text.length) throw new Error('Trailing database output');
  return { columns, rows };
}

/** Incremental CLI JSON framing. Retains at most one unfinished row. */
export class JsonRowStream {
  private buffer = '';
  private bufferBytes = 0;
  private scan = 0;
  private start = -1;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  constructor(
    private collector: ResultCollector,
    private decimalText = false
  ) {}
  write(chunk: string): boolean {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk);
    while (this.scan < this.buffer.length) {
      const c = this.buffer[this.scan];
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.quoted = false;
      } else if (c === '"') this.quoted = true;
      else if (c === '{') {
        if (this.depth === 0) this.start = this.scan;
        this.depth++;
      } else if (c === '}') {
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          const parsed = parseJsonRows(
            '[' + this.buffer.slice(this.start, this.scan + 1) + ']',
            this.decimalText
          );
          if (!this.collector.columns.length) this.collector.columns = parsed.columns;
          if (!this.collector.add(parsed.rows[0])) return false;
          this.bufferBytes -= Buffer.byteLength(this.buffer.slice(0, this.scan + 1));
          this.buffer = this.buffer.slice(this.scan + 1);
          this.scan = -1;
          this.start = -1;
        }
      }
      this.scan++;
    }
    if (this.bufferBytes > this.collector.maxBytes)
      throw new Error(
        'Database row exceeds the result byte limit; select fewer or smaller columns'
      );
    return true;
  }
}

/** Positional NDJSON with name/type header rows; repeated column names stay intact. */
export class CompactRowStream {
  private buffer = '';
  private scan = 0;
  private bufferBytes = 0;
  private headers = 0;
  constructor(private collector: ResultCollector) {}
  write(chunk: string): boolean {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n', this.scan)) >= 0) {
      this.bufferBytes -= Buffer.byteLength(this.buffer.slice(0, newline + 1));
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.scan = 0;
      if (line && !this.line(line)) return false;
    }
    this.scan = this.buffer.length;
    if (this.bufferBytes > this.collector.maxBytes)
      throw new Error('Database row exceeds the result byte limit');
    return true;
  }
  finish(allowEmpty = false): void {
    if (this.buffer.trim() && !this.line(this.buffer.trim())) return;
    if (this.headers === 1) throw new Error('Incomplete database result headers');
    if (!allowEmpty && this.headers === 0) throw new Error('Missing database result headers');
  }
  private line(text: string): boolean {
    if (/^Code:\s*\d+/.test(text)) throw new Error(text.slice(0, 4096));
    const row = parseJsonValue(text, true);
    if (!Array.isArray(row)) throw new Error('Invalid positional database result');
    if (this.headers === 0) {
      if (row.some((v) => typeof v !== 'string')) throw new Error('Invalid database column names');
      this.collector.columns = row as string[];
      this.collector.result();
    } else if (row.length !== this.collector.columns.length)
      throw new Error('Inconsistent database result width');
    else if (this.headers === 1) {
      if (row.some((v) => typeof v !== 'string')) throw new Error('Invalid database column types');
    } else return this.collector.add(row);
    this.headers++;
    return true;
  }
}
