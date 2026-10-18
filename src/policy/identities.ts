import { mysqlNameEquals, duckdbFold, duckdbNameEquals } from '../metadata/names.js';
import type { DatabaseConnection, QueryResult } from '../types.js';
import type { SqlNamePart } from './analyzer.js';
import { sqlDialect } from './analyzer.js';
import { AccessPolicy, type AccessRule } from './access.js';

export type IdentityKind = 'table' | 'function';
export type IdentityQuery = (sql: string) => Promise<QueryResult>;
interface IdentityColumns {
  schema: string;
  name: string;
  database: string;
}

function literal(dialect: string, value: string): string {
  if (dialect === 'mysql')
    return value ? `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)` : "''";
  const text = value.replace(/'/g, "''");
  return dialect === 'mssql'
    ? `N'${text}'`
    : dialect === 'postgres'
      ? `E'${text.replace(/\\/g, '\\\\')}'`
      : `'${text}'`;
}
function sqlName(dialect: string, parts: SqlNamePart[]): string {
  return parts
    .map((p) => {
      const value =
        dialect === 'postgres' && !p.quoted
          ? p.value.replace(/[A-Z]/g, (x) => x.toLowerCase())
          : p.value;
      return dialect === 'mysql'
        ? '`' + value.replace(/`/g, '``') + '`'
        : dialect === 'mssql'
          ? '[' + value.replace(/]/g, ']]') + ']'
          : '"' + value.replace(/"/g, '""') + '"';
    })
    .join('.');
}
function like(dialect: string, column: string, glob: string, kind: IdentityKind): string {
  const pattern = literal(dialect, glob.replace(/[!%_[\]]/g, (c) => '!' + c).replace(/\*/g, '%'));
  if (dialect === 'duckdb') return `(${duckdbFold(column)} LIKE ${duckdbFold(pattern)} ESCAPE '!')`;
  if (dialect === 'mssql') return `(${column} LIKE ${pattern} ESCAPE N'!')`;
  if (dialect === 'mysql') {
    const insensitive = `(BINARY LOWER(${column}) LIKE BINARY LOWER(${pattern}) ESCAPE '!')`;
    return kind === 'function'
      ? insensitive
      : `(CASE WHEN @@lower_case_table_names=0 THEN BINARY ${column} LIKE BINARY ${pattern} ESCAPE '!' ELSE ${insensitive} END)`;
  }
  return `(${column} LIKE ${pattern} ESCAPE '!')`;
}
function anyPattern(
  dialect: string,
  patterns: string[],
  forms: string[][],
  kind: IdentityKind
): string {
  const predicates = patterns.flatMap((pattern) => {
    const parts = pattern.split('.');
    return forms
      .filter((form) => form.length === parts.length)
      .map(
        (form) =>
          '(' + form.map((column, i) => like(dialect, column, parts[i], kind)).join(' AND ') + ')'
      );
  });
  return predicates.length ? '(' + predicates.join(' OR ') + ')' : '1=0';
}
/** Delegate identifier comparisons to engines whose naming follows a collation. */
export function identityPredicate(
  c: DatabaseConnection,
  rules: readonly AccessRule[],
  columns: IdentityColumns,
  kind: IdentityKind,
  allowBare: boolean
): string {
  const dialect = sqlDialect(c.driver);
  const qualified = [columns.schema, columns.name];
  const all = [[columns.name], qualified, [columns.database, ...qualified]];
  const allowed = allowBare ? all : all.slice(1);
  const checks: string[] = [];
  if (kind === 'function' && !rules.some((r) => r.allowFunctions)) return '1=0';
  for (const rule of rules) {
    if (rule.schemas && (kind === 'table' || dialect !== 'sqlite'))
      checks.push(anyPattern(dialect, rule.schemas, [[columns.schema]], kind));
    const allow = kind === 'table' ? rule.allowTables : rule.allowFunctions;
    const deny = kind === 'table' ? rule.denyTables : rule.denyFunctions;
    if (allow) checks.push(anyPattern(dialect, allow, allowed, kind));
    if (deny) checks.push('NOT ' + anyPattern(dialect, deny, all, kind));
  }
  return checks.length ? checks.map((c) => '(' + c + ')').join(' AND ') : '1=1';
}
function queryFor(
  c: DatabaseConnection,
  parts: SqlNamePart[],
  kind: IdentityKind,
  policy: AccessPolicy
): string {
  const d = sqlDialect(c.driver),
    last = parts.at(-1)!;
  if (
    parts.some(
      (p) =>
        p.value.length > 512 ||
        [...p.value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
  )
    throw new Error('Unsupported identifier in access policy lookup');
  const nativeMatch = ['mysql', 'mssql', 'sqlite', 'duckdb'].includes(d);
  let schema: string, name: string, database: string, from: string, where: string;
  if (d === 'mysql') {
    schema = kind === 'table' ? 'TABLE_SCHEMA' : 'ROUTINE_SCHEMA';
    name = kind === 'table' ? 'TABLE_NAME' : 'ROUTINE_NAME';
    database = schema;
    from = kind === 'table' ? 'information_schema.TABLES' : 'information_schema.ROUTINES';
    const match = (column: string, value: string) =>
      kind === 'function'
        ? `BINARY LOWER(${column})=BINARY LOWER(${value})`
        : mysqlNameEquals(column, value);
    where =
      `${match(schema, 'DATABASE()')} AND ${match(name, literal(d, last.value))}` +
      (kind === 'function' ? " AND ROUTINE_TYPE='FUNCTION'" : '');
  } else if (d === 'duckdb') {
    schema = 'schema_name';
    name = kind === 'table' ? 'table_name' : 'function_name';
    database = 'current_database()';
    from =
      kind === 'table'
        ? '(SELECT database_name,schema_name,table_name FROM duckdb_tables() UNION ALL SELECT database_name,schema_name,view_name AS table_name FROM duckdb_views()) objects'
        : 'duckdb_functions()';
    where = `${kind === 'table' ? 'database_name=current_database() AND ' : ''}${duckdbNameEquals(schema, parts.length > 1 ? literal(d, parts.at(-2)!.value) : 'current_schema()')} AND ${duckdbNameEquals(name, literal(d, last.value))}`;
  } else if (d === 'mssql') {
    schema = 's.name';
    name = 'o.name';
    database = '(SELECT name FROM sys.databases WHERE database_id=DB_ID())';
    from = 'sys.all_objects o JOIN sys.schemas s ON s.schema_id=o.schema_id';
    where = `o.object_id=OBJECT_ID(${literal(d, sqlName(d, parts))}) AND o.type IN (${kind === 'table' ? "'U','V'" : "'FN','IF','TF','FS','FT'"})`;
  } else if (d === 'sqlite') {
    schema = "'main'";
    name = 'name';
    database = literal(d, c.database ?? '');
    from = kind === 'table' ? 'sqlite_schema' : 'pragma_function_list';
    where =
      `name=${literal(d, last.value)} COLLATE NOCASE` +
      (kind === 'table' ? " AND type IN ('table','view')" : '');
  } else if (d === 'postgres') {
    schema = 'n.nspname';
    database = 'current_database()';
    if (kind === 'table') {
      name = 'o.relname';
      from = 'pg_class o JOIN pg_namespace n ON n.oid=o.relnamespace';
      where = `o.oid=to_regclass(${literal(d, sqlName(d, parts))}) AND o.relkind IN ('r','p','v','m','f')`;
    } else {
      name = 'o.proname';
      from = 'pg_proc o JOIN pg_namespace n ON n.oid=o.pronamespace';
      const nameValue = last.quoted
        ? last.value
        : last.value.replace(/[A-Z]/g, (c) => c.toLowerCase());
      where =
        `o.proname=${literal(d, nameValue)} AND ` +
        (parts.length > 1
          ? `n.nspname=${literal(d, parts.at(-2)!.quoted ? parts.at(-2)!.value : parts.at(-2)!.value.replace(/[A-Z]/g, (c) => c.toLowerCase()))}`
          : 'pg_function_is_visible(o.oid)');
    }
  } else if (d === 'oracle') {
    if (parts.some((p) => /[^\x20-\x7e]/.test(p.value)))
      throw new Error('Non-ASCII Oracle identifiers are not supported under access policies');
    const value = (p: SqlNamePart) =>
      p.quoted ? literal(d, p.value) : `UPPER(${literal(d, p.value)})`;
    schema = 'owner';
    database = literal(d, c.database ?? '');
    if (kind === 'table') {
      name = 'object_name';
      from = 'all_objects';
      where = `owner=${parts.length > 1 ? value(parts[0]) : "SYS_CONTEXT('USERENV','CURRENT_SCHEMA')"} AND object_name=${value(last)} AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')`;
    } else {
      name = "object_name || CASE WHEN procedure_name IS NOT NULL THEN '.' || procedure_name END";
      from = 'all_procedures';
      if (parts.length === 3)
        where = `owner=${value(parts[0])} AND object_name=${value(parts[1])} AND procedure_name=${value(parts[2])}`;
      else if (parts.length === 2)
        where = `(owner=${value(parts[0])} AND object_name=${value(parts[1])} AND procedure_name IS NULL) OR (owner=SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AND object_name=${value(parts[0])} AND procedure_name=${value(parts[1])})`;
      else
        where = `owner=SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AND object_name=${value(last)} AND procedure_name IS NULL`;
    }
  } else throw new Error('Database-aware access policies are not available for this driver');
  const permitted = nativeMatch
    ? `CASE WHEN ${identityPredicate(c, policy.rulesFor(c), { schema, name, database }, kind, parts.length === 1)} THEN 1 ELSE 0 END`
    : '1';
  return `SELECT DISTINCT ${schema} AS resolved_schema,${name} AS resolved_name,${permitted} AS permitted FROM ${from} WHERE ${where}`;
}
export async function assertIdentityAccess(
  policy: AccessPolicy,
  c: DatabaseConnection,
  parts: SqlNamePart[],
  kind: IdentityKind,
  query: IdentityQuery
): Promise<void> {
  const result = await query(queryFor(c, parts, kind, policy));
  if (result.truncated || result.rows.length !== 1)
    throw new Error(
      'Object not found, ambiguous, or metadata is not visible; qualify its schema in SQL'
    );
  assertResolved(policy, c, parts, kind, result.rows[0]);
}
function assertResolved(
  policy: AccessPolicy,
  c: DatabaseConnection,
  parts: SqlNamePart[],
  kind: IdentityKind,
  row: unknown[]
): void {
  const [schema, name, allowed] = row;
  if (
    Number(allowed) !== 1 ||
    (!['mysql', 'mssql', 'sqlite', 'duckdb'].includes(sqlDialect(c.driver)) &&
      !policy.allowsResolved(
        c,
        String(schema),
        String(name),
        kind,
        parts.length === 1 ||
          (sqlDialect(c.driver) === 'oracle' && parts.length === 2 && String(name).includes('.'))
      ))
  )
    throw new Error(
      `${kind === 'table' ? 'Table' : 'Function'} is not allowed by the access policy`
    );
}
export async function assertQueryAccess(
  policy: AccessPolicy,
  c: DatabaseConnection,
  sql: string,
  readOnly: boolean,
  metadata: IdentityQuery
): Promise<void> {
  const analysis = policy.assertQuery(c, sql, readOnly, { deferNames: true });
  if (!analysis) return;
  const identities = new Map<string, { parts: SqlNamePart[]; kind: IdentityKind }>();
  for (const parts of analysis.relations)
    identities.set('table:' + JSON.stringify(parts), { parts, kind: 'table' });
  for (const parts of analysis.functions)
    if (!policy.isBuiltin(parts))
      identities.set('function:' + JSON.stringify(parts), { parts, kind: 'function' });
  if (identities.size > 64)
    throw new Error('Queries under access policies support at most 64 distinct object references');
  const references = [...identities.values()];
  if (!references.length) return;
  // One round trip for joins and repeated sources, including on pinned transaction leases.
  const lookupSql = references
    .map(
      ({ parts, kind }, index) =>
        `SELECT ${index} AS ref,omnisql_identity.* FROM (${queryFor(c, parts, kind, policy)}) omnisql_identity`
    )
    .join(' UNION ALL ');
  if (Buffer.byteLength(lookupSql) > 2 * 1024 * 1024)
    throw new Error('Access policy lookup exceeds the 2 MiB SQL budget; narrow its rules or query');
  const result = await metadata(lookupSql);
  if (result.truncated) throw new Error('Access policy metadata exceeded its result budget');
  for (const [index, { parts, kind }] of references.entries()) {
    const rows = result.rows.filter((row) => Number(row[0]) === index);
    if (rows.length !== 1)
      throw new Error(
        'Object not found, ambiguous, or metadata is not visible; qualify its schema in SQL'
      );
    assertResolved(policy, c, parts, kind, rows[0].slice(1));
  }
}
