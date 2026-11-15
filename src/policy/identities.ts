import { mysqlNameEquals, duckdbFold, duckdbNameEquals } from '../metadata/names.js';
import type { DatabaseConnection, QueryResult } from '../types.js';
import type { SqlNamePart } from './analyzer.js';
import { sqlDialect } from './analyzer.js';
import { AccessPolicy, type AccessRule } from './access.js';

// These are grammar expressions, not shadowable routine names in these engines.
const GRAMMAR_EXPRESSIONS: Record<string, ReadonlySet<string>> = {
  postgres: new Set([
    'coalesce',
    'nullif',
    'greatest',
    'least',
    'current_date',
    'current_timestamp',
  ]),
  duckdb: new Set(['coalesce', 'if', 'ifnull', 'current_timestamp']),
};

export type IdentityKind = 'table' | 'function';
export type IdentityQuery = (sql: string) => Promise<QueryResult>;
interface IdentityColumns {
  schema: string;
  name: string;
  database: string;
}

function literal(dialect: string, value: string): string {
  if (dialect === 'clickhouse') return `unhex('${Buffer.from(value).toString('hex')}')`;
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
  allowBare: boolean,
  builtin = false
): string {
  const dialect = sqlDialect(c.driver);
  const qualified = [columns.schema, columns.name];
  const all =
    dialect === 'clickhouse' && kind === 'function'
      ? [[columns.name], [columns.database, columns.name]]
      : [[columns.name], qualified, [columns.database, ...qualified]];
  const allowed = allowBare ? all : all.slice(1);
  const checks: string[] = [];
  if (kind === 'function' && !builtin && !rules.some((r) => r.allowFunctions)) return '1=0';
  for (const rule of rules) {
    if (!builtin && rule.schemas && (kind === 'table' || dialect !== 'sqlite'))
      checks.push(anyPattern(dialect, rule.schemas, [[columns.schema]], kind));
    const allow = kind === 'table' ? rule.allowTables : rule.allowFunctions;
    const deny = kind === 'table' ? rule.denyTables : rule.denyFunctions;
    if (allow && !builtin) checks.push(anyPattern(dialect, allow, allowed, kind));
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
  if (
    kind === 'function' &&
    parts.length === 1 &&
    !last.quoted &&
    GRAMMAR_EXPRESSIONS[d]?.has(last.value.toLowerCase())
  ) {
    const schema = literal(d, d === 'postgres' ? 'pg_catalog' : 'main');
    const name = literal(d, last.value.toLowerCase());
    const permission = identityPredicate(
      c,
      policy.rulesFor(c),
      {
        schema,
        name,
        database:
          d === 'duckdb' ? 'system.main.current_database()' : 'pg_catalog.current_database()',
      },
      kind,
      true,
      policy.isBuiltin(parts, c.driver)
    );
    return `SELECT ${schema} AS resolved_schema,${name} AS resolved_name,CASE WHEN ${permission} THEN 1 ELSE 0 END AS permitted,1 AS native_builtin`;
  }
  const nativeMatch =
    ['mysql', 'mssql', 'sqlite', 'duckdb'].includes(d) ||
    (d === 'clickhouse' && kind === 'function');
  let nativeBuiltin = '0';
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
  } else if (d === 'clickhouse') {
    schema = kind === 'table' ? 'database' : "''";
    name = 'name';
    database = 'currentDatabase()';
    from = kind === 'table' ? 'system.tables' : 'system.functions';
    if (kind === 'function') nativeBuiltin = `CASE WHEN origin='System' THEN 1 ELSE 0 END`;
    where =
      kind === 'table'
        ? `database=currentDatabase() AND name=${literal(d, last.value)}`
        : `name=${literal(d, last.value)} OR (case_insensitive=1 AND lowerASCII(name)=lowerASCII(${literal(d, last.value)}))`;
  } else if (d === 'duckdb') {
    schema = 'schema_name';
    name = kind === 'table' ? 'table_name' : 'function_name';
    database = kind === 'table' ? 'system.main.current_database()' : 'database_name';
    from =
      kind === 'table'
        ? '(SELECT database_name,schema_name,table_name FROM system.main.duckdb_tables() UNION ALL SELECT database_name,schema_name,view_name AS table_name FROM system.main.duckdb_views()) objects'
        : 'system.main.duckdb_functions()';
    const match = duckdbNameEquals(name, literal(d, last.value));
    if (kind === 'function') {
      nativeBuiltin = 'CASE WHEN internal THEN 1 ELSE 0 END';
      // Include every active namespace, without guessing which overload will bind.
      // An untrusted same-name candidate makes implicit native use ambiguous.
      where =
        parts.length === 1
          ? `${match} AND database_name IN (system.main.current_database(),'system','temp') AND system.main.list_contains(system.main.current_schemas(true),schema_name)`
          : `${match} AND database_name=system.main.current_database() AND ${duckdbNameEquals(schema, literal(d, parts.at(-2)!.value))}`;
    } else {
      where = `database_name=system.main.current_database() AND ${duckdbNameEquals(schema, parts.length > 1 ? literal(d, parts.at(-2)!.value) : 'system.main.current_schema()')} AND ${match}`;
    }
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
    from = kind === 'table' ? 'sqlite_schema' : 'pragma_function_list()';
    if (kind === 'function') nativeBuiltin = 'CASE WHEN builtin=1 THEN 1 ELSE 0 END';
    where =
      `name=${literal(d, last.value)} COLLATE NOCASE` +
      (kind === 'table' ? " AND type IN ('table','view')" : '');
  } else if (d === 'postgres') {
    schema = 'n.nspname';
    database = 'pg_catalog.current_database()';
    if (kind === 'table') {
      name = 'o.relname';
      from = 'pg_catalog.pg_class o JOIN pg_catalog.pg_namespace n ON n.oid=o.relnamespace';
      where = `o.oid=pg_catalog.to_regclass(${literal(d, sqlName(d, parts))}) AND o.relkind IN ('r','p','v','m','f')`;
    } else {
      name = 'o.proname';
      nativeBuiltin = `CASE WHEN n.nspname='pg_catalog' THEN 1 ELSE 0 END`;
      from = 'pg_catalog.pg_proc o JOIN pg_catalog.pg_namespace n ON n.oid=o.pronamespace';
      const nameValue = last.quoted
        ? last.value
        : last.value.replace(/[A-Z]/g, (c) => c.toLowerCase());
      where =
        `o.prokind IN ('f','a','w') AND o.proname=${literal(d, nameValue)} AND ` +
        (parts.length > 1
          ? `n.nspname=${literal(d, parts.at(-2)!.quoted ? parts.at(-2)!.value : parts.at(-2)!.value.replace(/[A-Z]/g, (c) => c.toLowerCase()))}`
          : 'pg_catalog.pg_function_is_visible(o.oid)');
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
      from = 'SYS.ALL_OBJECTS';
      where = `owner=${parts.length > 1 ? value(parts[0]) : "SYS_CONTEXT('USERENV','CURRENT_SCHEMA')"} AND object_name=${value(last)} AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW')`;
    } else {
      name = "object_name || CASE WHEN procedure_name IS NOT NULL THEN '.' || procedure_name END";
      from = 'SYS.ALL_PROCEDURES';
      if (parts.length === 3)
        where = `owner=${value(parts[0])} AND object_name=${value(parts[1])} AND procedure_name=${value(parts[2])}`;
      else if (parts.length === 2)
        where = `(owner=${value(parts[0])} AND object_name=${value(parts[1])} AND procedure_name IS NULL) OR (owner=SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AND object_name=${value(parts[0])} AND procedure_name=${value(parts[1])})`;
      else
        where = `owner=SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AND object_name=${value(last)} AND procedure_name IS NULL`;
    }
  } else throw new Error('Database-aware access policies are not available for this driver');
  let permission = identityPredicate(
    c,
    policy.rulesFor(c),
    { schema, name, database },
    kind,
    parts.length === 1
  );
  if (d === 'duckdb' && kind === 'function')
    permission = `(database_name=system.main.current_database() AND (${permission}))`;
  if (kind === 'function' && policy.isBuiltin(parts, c.driver)) {
    const builtinPermission = identityPredicate(
      c,
      policy.rulesFor(c),
      { schema, name, database },
      kind,
      true,
      true
    );
    permission = `((${permission}) OR (${nativeBuiltin}=1 AND (${builtinPermission})))`;
  }
  const permitted = nativeMatch ? `CASE WHEN ${permission} THEN 1 ELSE 0 END` : '1';
  return `SELECT DISTINCT ${schema} AS resolved_schema,${name} AS resolved_name,${permitted} AS permitted,${nativeBuiltin} AS native_builtin FROM ${from} WHERE ${where}`;
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
  const [schema, name, allowed, nativeBuiltin] = row;
  if (
    Number(allowed) !== 1 ||
    (!['mysql', 'mssql', 'sqlite', 'duckdb'].includes(sqlDialect(c.driver)) &&
      !(
        kind === 'function' &&
        policy.allowsResolvedBuiltin(
          c,
          parts,
          String(schema),
          String(name),
          Number(nativeBuiltin) === 1
        )
      ) &&
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
    if (
      ['postgres', 'duckdb', 'sqlite', 'clickhouse'].includes(sqlDialect(c.driver)) ||
      !policy.isBuiltin(parts, c.driver)
    )
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
