import { analyzeSql } from './analyzer.js';

export interface SqlToken {
  kind: 'word' | 'identifier' | 'literal' | 'symbol';
  value: string;
}

/** Tokenize policy-relevant SQL without treating quoted values as executable text. */
export function sqlTokens(query: string, dialect = 'generic'): SqlToken[] {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Query cannot be empty');
  if (Buffer.byteLength(query) > 1_000_000) throw new Error('SQL exceeds the 1 MB limit');
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (query.startsWith('--', i)) {
      if (query[i + 2] && !/\s/.test(query[i + 2])) throw new Error('Ambiguous SQL line comment');
      const end = query.indexOf('\n', i);
      i = end < 0 ? query.length : end;
      continue;
    }
    if (query.startsWith('/*', i)) {
      if (query[i + 2] === '!' || /^m!/i.test(query.slice(i + 2, i + 4)))
        throw new Error('Executable SQL comments are not allowed');
      let depth = 1;
      i += 2;
      while (i < query.length && depth) {
        if (query.startsWith('/*', i)) {
          throw new Error('Nested SQL comments are ambiguous across database dialects');
        } else if (query.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      continue;
    }
    const dollar =
      c === '$' ? query.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0] : undefined;
    if (dollar) {
      const end = query.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error('Unterminated SQL string');
      tokens.push({ kind: 'literal', value: '' });
      i = end + dollar.length;
      continue;
    }
    // PostgreSQL/DuckDB subscripts and ARRAY[...] contain executable expressions.
    // Only SQL Server treats every [...] as a quoted identifier. The generic
    // guard recognizes ARRAY too, before the connection-specific guard runs.
    const bracketIdentifier =
      c === '[' &&
      (dialect === 'mssql' || (dialect === 'generic' && tokens.at(-1)?.value !== 'array'));
    if (["'", '"', '`'].includes(c) || bracketIdentifier) {
      const end = c === '[' ? ']' : c;
      let value = '',
        closed = false;
      i++;
      while (i < query.length) {
        if (query.charCodeAt(i) === 92)
          throw new Error('Ambiguous SQL backslash escapes are not supported');
        if (query[i] === end) {
          if (query[i + 1] === end) {
            value += end;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += query[i++];
      }
      if (!closed) throw new Error('Unterminated SQL identifier or string');
      tokens.push({
        kind: c === "'" ? 'literal' : 'identifier',
        value: c === "'" ? '' : value.toLowerCase(),
      });
      continue;
    }
    const word = query.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_$]*/)?.[0];
    if (word) {
      tokens.push({ kind: 'word', value: word.toLowerCase() });
      i += word.length;
    } else {
      tokens.push({ kind: 'symbol', value: c });
      i++;
    }
  }
  if (tokens.at(-1)?.value === ';') tokens.pop();
  if (!tokens.length || tokens.some((token) => token.kind === 'symbol' && token.value === ';'))
    throw new Error('Only a single SQL statement is allowed');
  return tokens;
}

export function validateStatement(
  query: string,
  expected?: string[],
  dialect = 'generic'
): string | null {
  try {
    const tokens = sqlTokens(query, dialect);
    const words = tokens.filter((t) => t.kind === 'word').map((t) => t.value);
    if (
      ![
        'select',
        'with',
        'explain',
        'show',
        'describe',
        'desc',
        'pragma',
        'insert',
        'update',
        'delete',
        'create',
        'alter',
        'drop',
      ].includes(words[0])
    )
      return 'Unsupported SQL operation; use the dedicated transaction tools for transaction control';
    if (expected && !expected.includes(words[0]))
      return `Expected ${expected.join(' or ')} statement`;
    if (
      /\b(drop (?:database|schema|user)|create user|alter user|truncate|grant|revoke|shutdown|restart)\b/.test(
        words.join(' ')
      )
    )
      return 'Potentially dangerous query detected. Query blocked for safety.';
    if (['update', 'delete', 'with'].includes(words[0])) {
      let missing: boolean | undefined;
      for (const dialect of ['postgres', 'mysql', 'mssql', 'sqlite', 'oracle']) {
        try {
          missing = analyzeSql(query, dialect).missingPredicate;
          break;
        } catch {
          /* Try another grammar for this dialect-independent legacy helper. */
        }
      }
      if (missing === undefined) return 'SQL could not be validated with a supported grammar';
      if (missing) return 'UPDATE and DELETE require a WHERE clause';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid SQL';
  }
}

const WRITE_WORDS = new Set(
  'insert update delete merge replace create alter drop truncate grant revoke call exec execute copy into attach detach vacuum reindex load_extension writefile set reset use prepare deallocate lock unlock waitfor'.split(
    ' '
  )
);
const UNSAFE_FUNCTIONS =
  /^(?:nextval|setval|set_config|pg_notify|pg_(?:read|write|append|stat|ls)_.*|pg_advisory_.*|pg_(?:terminate|cancel)_backend|lo_(?:import|export)|dblink.*|load_extension|writefile|readfile|sys_exec|sys_eval|sleep|benchmark|system|shell)$/;

export function validateReadStatement(query: string, dialect = 'generic'): string | null {
  try {
    const tokens = sqlTokens(query, dialect);
    const first = tokens[0];
    const error = 'Only a single read-only query (SELECT, EXPLAIN, SHOW, DESCRIBE) is allowed';
    if (
      first.kind !== 'word' ||
      !['select', 'with', 'explain', 'show', 'describe', 'desc', 'pragma'].includes(first.value)
    )
      return error;
    if (tokens.some((t) => t.kind === 'word' && WRITE_WORDS.has(t.value))) return error;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i + 1]?.value === '(' && UNSAFE_FUNCTIONS.test(tokens[i].value))
        return 'This function is not permitted in read-only queries';
    }
    if (
      first.value === 'pragma' &&
      !/^(?:table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list|database_list|compile_options)$/.test(
        tokens[1]?.value === 'main' && tokens[2]?.value === '.'
          ? tokens[3]?.value
          : tokens[1]?.value
      )
    )
      return error;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid SQL';
  }
}
