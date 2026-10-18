import { DatabaseConnection, QueryResult } from '../types.js';

/** Shared row and byte budget, applied while each native driver fetches rows. */
export class ResultCollector {
  readonly rows: unknown[][] = [];
  columns: string[] = [];
  truncated = false;
  limitReason?: 'rows' | 'bytes';
  private bytes = 0;
  readonly maxRows: number;
  readonly maxBytes: number;
  constructor(connection: DatabaseConnection, maxRows?: number) {
    this.maxRows = Math.min(maxRows ?? 1000, connection.limits?.maxRows ?? 100000);
    this.maxBytes = connection.limits?.maxBytes ?? 1024 * 1024;
  }
  add(row: unknown[]): boolean {
    if (this.rows.length >= this.maxRows) {
      this.truncated = true;
      this.limitReason = 'rows';
      return false;
    }
    const normalized = row.map((v) =>
      typeof v === 'bigint'
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
    return {
      columns: this.columns,
      rows: this.rows,
      rowCount: this.columns.length ? this.rows.length : (affectedRows ?? 0),
      executionTime: 0,
      truncated: this.truncated,
      ...(this.limitReason ? { limitReason: this.limitReason } : {}),
    };
  }
}

/** Preserve repeated column names and integers beyond Number's exact range. */
export function parseSQLiteRows(text: string): { columns: string[]; rows: unknown[][] } {
  let offset = 0;
  const skip = () => {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const take = (char: string) => {
    skip();
    if (text[offset++] !== char) throw new Error('Invalid SQLite JSON');
  };
  const value = (): unknown => {
    skip();
    const start = offset;
    if (text[offset] === '"') {
      offset++;
      while (offset < text.length) {
        if (text[offset] === '\\') {
          offset += 2;
          continue;
        }
        if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
      }
      throw new Error('Invalid SQLite JSON string');
    }
    const token = text
      .slice(offset)
      .match(/^(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('Invalid SQLite value');
    offset += token.length;
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return token;
    return JSON.parse(token);
  };
  if (!text.trim()) return { columns: [], rows: [] };
  take('[');
  const rows: unknown[][] = [];
  let columns: string[] = [];
  skip();
  while (text[offset] !== ']') {
    take('{');
    const names: string[] = [];
    const row: unknown[] = [];
    skip();
    while (text[offset] !== '}') {
      const key = value();
      if (typeof key !== 'string') throw new Error('Invalid SQLite column');
      take(':');
      names.push(key);
      row.push(value());
      skip();
      if (text[offset] !== ',') break;
      offset++;
    }
    take('}');
    if (!columns.length) columns = names;
    else if (JSON.stringify(columns) !== JSON.stringify(names))
      throw new Error('Inconsistent SQLite columns');
    rows.push(row);
    skip();
    if (text[offset] !== ',') break;
    offset++;
  }
  take(']');
  skip();
  if (offset !== text.length) throw new Error('Trailing SQLite output');
  return { columns, rows };
}

/** Incremental SQLite JSON framing. Retains at most one unfinished row. */
export class SQLiteRowStream {
  private buffer = '';
  private scan = 0;
  private start = -1;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  constructor(private collector: ResultCollector) {}
  write(chunk: string): boolean {
    this.buffer += chunk;
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
          const parsed = parseSQLiteRows('[' + this.buffer.slice(this.start, this.scan + 1) + ']');
          if (!this.collector.columns.length) this.collector.columns = parsed.columns;
          if (!this.collector.add(parsed.rows[0])) return false;
          this.buffer = this.buffer.slice(this.scan + 1);
          this.scan = -1;
          this.start = -1;
        }
      }
      this.scan++;
    }
    if (Buffer.byteLength(this.buffer) > this.collector.maxBytes)
      throw new Error('SQLite row exceeds the result byte limit; select fewer or smaller columns');
    return true;
  }
}
