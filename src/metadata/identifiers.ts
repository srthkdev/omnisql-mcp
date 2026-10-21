import { sqlDialect } from '../policy/analyzer.js';

/** Names from catalog tools are exact names, optionally schema-qualified and quoted. */
export function tableNameParts(name: string): string[] {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 1024 ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('Invalid table name');
  const source = name.trim();
  const parts: string[] = [];
  let i = 0;
  while (i < source.length) {
    while (source[i] === ' ') i++;
    const opening = source[i];
    let value = '';
    if (['"', '`', '['].includes(opening)) {
      const closing = opening === '[' ? ']' : opening;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === closing) {
          if (source[i + 1] === closing) {
            value += closing;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += source[i++];
      }
      if (!closed) throw new Error('Unterminated table name');
      while (source[i] === ' ') i++;
      if (i < source.length && source[i] !== '.') throw new Error('Invalid qualified table name');
    } else {
      const start = i;
      while (i < source.length && source[i] !== '.') i++;
      value = source.slice(start, i).trim();
    }
    if (!value || parts.length === 2) throw new Error('Expected table or schema.table');
    parts.push(value);
    if (source[i] === '.') {
      i++;
      if (i === source.length) throw new Error('Expected table or schema.table');
    }
  }
  return parts;
}

/** Escape values, never identifiers, for metadata statements without bound parameters. */
export function catalogLiteral(value: string, driver: string): string {
  const dialect = sqlDialect(driver);
  if ([...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new Error('Invalid catalog name');
  if (value.includes('\\')) {
    if (dialect === 'mysql')
      return `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;
    if (dialect === 'clickhouse') return `unhex('${Buffer.from(value).toString('hex')}')`;
    if (dialect === 'postgres') return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  return `${dialect === 'mssql' ? 'N' : ''}'${value.replace(/'/g, "''")}'`;
}

/** Quote each name part separately so schema.table never becomes one table. */
export function quoteQualifiedIdentifier(name: string, driver: string): string {
  const dialect = sqlDialect(driver);
  const parts = tableNameParts(name);
  if (parts.some((part) => part.includes('\\')))
    throw new Error('Backslashes in write identifiers are unsupported');
  return parts
    .map((part) =>
      dialect === 'mysql' || dialect === 'clickhouse'
        ? '`' + part.replace(/`/g, '``') + '`'
        : dialect === 'mssql'
          ? '[' + part.replace(/]/g, ']]') + ']'
          : '"' + part.replace(/"/g, '""') + '"'
    )
    .join('.');
}
