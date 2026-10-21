import { tableNameParts } from '../metadata/identifiers.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readPrivateFile } from '../runtime/private-file.js';
import type { DatabaseConnection } from '../types.js';
import {
  analyzeSql,
  canonicalName,
  sqlDialect,
  type SqlNamePart,
  type SqlAnalysis,
} from './analyzer.js';
import { validateReadStatement, validateStatement, sqlTokens } from './sql.js';

export interface AccessRule {
  readOnly?: boolean;
  databases?: string[];
  schemas?: string[];
  allowTables?: string[];
  denyTables?: string[];
  allowFunctions?: string[];
  denyFunctions?: string[];
}
interface PolicyFile {
  version: 1;
  defaults?: AccessRule;
  connections?: Record<string, AccessRule>;
}
const FUNCTIONS = new Set(
  'count sum avg min max coalesce nullif abs round floor ceil ceiling lower upper length char_length character_length concat concat_ws substring substr trim ltrim rtrim replace left right position cast convert try_cast try_convert extract date_trunc date_part now current_date current_timestamp strftime date datetime julianday unixepoch version current_database current_schema pg_typeof typeof json_extract json_array_length json_type json_valid row_number rank dense_rank lag lead first_value last_value ntile percent_rank cume_dist stddev stddev_pop stddev_samp variance var_pop var_samp greatest least iif if ifnull isnull nvl nvl2 to_char to_date to_timestamp dateadd datediff datename datepart format db_name schema_name object_name serverproperty sqlite_version json_build_object json_agg array_agg string_agg group_concat'.split(
    ' '
  )
);
export function validateAccessRule(value: unknown): asserts value is AccessRule {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Policy rules must be objects');
  const allowed = [
    'readOnly',
    'databases',
    'schemas',
    'allowTables',
    'denyTables',
    'allowFunctions',
    'denyFunctions',
  ];
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown policy setting: ${key}`);
    if (key === 'readOnly') {
      if (typeof item !== 'boolean') throw new Error('Policy readOnly must be boolean');
    } else if (
      !Array.isArray(item) ||
      item.length > 1000 ||
      item.some(
        (v) =>
          typeof v !== 'string' ||
          !v ||
          v.length > 512 ||
          [...v].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
    )
      throw new Error(`Policy ${key} must contain valid names`);
  }
}
function matches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split('*')
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}
function includes(patterns: string[], name: string): boolean {
  return patterns.some((p) => matches(p, name));
}
export class AccessPolicy {
  private policy: PolicyFile = { version: 1 };
  private stamp = '';
  constructor(private file = process.env.OMNISQL_POLICY_FILE) {
    this.reload();
  }
  private reload(): void {
    if (!this.file) return;
    const stat = fs.lstatSync(this.file, { bigint: true });
    if (!stat.isFile()) throw new Error('Policy file must be a regular file');
    if (stat.size > 1_000_000n) throw new Error('Policy file exceeds 1 MB');
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stamp === this.stamp) return;
    const file = this.file;
    const p: unknown = JSON.parse(readPrivateFile(file, 1_000_000, 'Policy file'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid access policy');
    const o = p as Record<string, unknown>;
    if (
      o.version !== 1 ||
      Object.keys(o).some((k) => !['version', 'defaults', 'connections'].includes(k))
    )
      throw new Error('Unsupported access policy version or setting');
    if (o.defaults !== undefined) validateAccessRule(o.defaults);
    if (o.connections !== undefined) {
      if (!o.connections || typeof o.connections !== 'object' || Array.isArray(o.connections))
        throw new Error('Policy connections must be an object');
      Object.values(o.connections).forEach(validateAccessRule);
    }
    this.policy = o as unknown as PolicyFile;
    this.stamp = stamp;
  }
  revision(): string {
    this.reload();
    return createHash('sha256').update(JSON.stringify(this.policy)).digest('hex');
  }
  private databaseRules(c: DatabaseConnection): string[] {
    this.reload();
    const prefix = (c.baseId ?? c.id.split('/')[0]) + '/';
    return Object.keys(this.policy.connections ?? {}).filter((key) => key.startsWith(prefix));
  }
  private rules(c: DatabaseConnection, database = c.database): AccessRule[] {
    this.reload();
    const base = c.baseId ?? c.id.split('/')[0];
    const keys = new Set([base, ...(database === undefined ? [] : [base + '/' + database])]);
    return [
      ...(c.accessRules ?? []),
      this.policy.defaults,
      ...[...keys].map((key) => this.policy.connections?.[key]),
    ].filter((r): r is AccessRule => r !== undefined);
  }
  rulesFor(c: DatabaseConnection): readonly AccessRule[] {
    return this.rules(c);
  }
  isBuiltin(parts: SqlNamePart[]): boolean {
    return parts.length === 1 && !parts[0].quoted && FUNCTIONS.has(parts[0].value.toLowerCase());
  }
  allowsResolved(
    c: DatabaseConnection,
    schema: string,
    name: string,
    kind: 'table' | 'function',
    allowBare: boolean
  ): boolean {
    const qualified = schema ? schema + '.' + name : name;
    const all = [name, qualified, [c.database, qualified].filter(Boolean).join('.')];
    const allowed = allowBare ? all : all.slice(1);
    const rules = this.rules(c);
    if (kind === 'function' && !rules.some((r) => r.allowFunctions)) return false;
    return rules.every((r) => {
      const allow = kind === 'table' ? r.allowTables : r.allowFunctions;
      const deny = kind === 'table' ? r.denyTables : r.denyFunctions;
      return (
        (!r.schemas || includes(r.schemas, schema)) &&
        (!allow || allowed.some((name) => includes(allow, name))) &&
        (!deny || !all.some((name) => includes(deny, name)))
      );
    });
  }
  isReadOnly(c: DatabaseConnection): boolean {
    return c.readonly === true || this.rules(c).some((r) => r.readOnly === true);
  }
  allowsDatabase(c: DatabaseConnection, database = c.database ?? ''): boolean {
    const rules = this.rules(c, database);
    // Name aliases depend on server collation (including accents), not just ASCII case.
    // Once per-database rules exist, require an explicit spelling on these engines.
    if (
      ['mysql', 'mssql'].includes(sqlDialect(c.driver)) &&
      this.databaseRules(c).length &&
      !this.databaseRules(c).includes((c.baseId ?? c.id.split('/')[0]) + '/' + database)
    )
      return false;
    return rules.every((r) => !r.databases || includes(r.databases, database));
  }
  assertConnection(c: DatabaseConnection): void {
    if (!this.allowsDatabase(c)) throw new Error('Database is not allowed by the access policy');
  }
  private isDatabaseScoped(c: DatabaseConnection): boolean {
    return (
      c.id.includes('/') ||
      this.databaseRules(c).length > 0 ||
      this.rules(c).some(
        (r) =>
          r.databases ||
          r.schemas ||
          r.allowTables ||
          r.denyTables ||
          r.allowFunctions ||
          r.denyFunctions
      )
    );
  }
  private scopeError(
    c: DatabaseConnection,
    parts: SqlNamePart[],
    kind: 'table' | 'function'
  ): string | null {
    if (!this.isDatabaseScoped(c)) return null;
    const dialect = sqlDialect(c.driver);
    if (dialect === 'duckdb' && parts.length > 2)
      return 'DuckDB catalog-qualified names are outside the database scope; use schema.table';
    if (dialect === 'mssql' && parts.length > 3)
      return 'Linked-server names are outside the database scope';
    const max = dialect === 'mysql' || dialect === 'clickhouse' ? 2 : 3;
    if (parts.length > max) return 'Name is outside the database scope';
    const dbIndex =
      dialect === 'mysql' || dialect === 'clickhouse'
        ? parts.length === 2
          ? 0
          : -1
        : dialect === 'mssql' || dialect === 'postgres'
          ? parts.length === 3
            ? 0
            : -1
          : -1;
    if (dbIndex >= 0) {
      const part = parts[dbIndex];
      const database =
        dialect === 'postgres' && !part.quoted
          ? part.value.replace(/[A-Z]/g, (c) => c.toLowerCase())
          : part.value;
      if (database !== c.database)
        return 'SQL references must stay in the selected database; select another database in the tool arguments';
    }
    if (
      kind === 'table' &&
      dialect === 'sqlite' &&
      parts.length > 1 &&
      parts[0].value.toLowerCase() !== 'main'
    )
      return 'Attached SQLite databases are outside the database scope';
    return null;
  }
  assertTableScope(c: DatabaseConnection, table: string): void {
    const error = this.scopeError(
      c,
      tableNameParts(table).map((value) => ({ value, quoted: true })),
      'table'
    );
    if (error) throw new Error(error);
  }
  allowsTable(c: DatabaseConnection, table: string): boolean {
    const parts = table.split('.');
    const schema = parts.length > 1 ? parts.at(-2)! : '';
    return (
      this.allowsDatabase(c) &&
      !this.scopeError(
        c,
        parts.map((value) => ({ value, quoted: true })),
        'table'
      ) &&
      this.rules(c).every(
        (r) =>
          (!r.schemas || includes(r.schemas, schema)) &&
          (!r.allowTables || includes(r.allowTables, table)) &&
          (!r.denyTables || !includes(r.denyTables, table))
      )
    );
  }
  assertTable(c: DatabaseConnection, table: string): void {
    if (!this.allowsTable(c, table)) throw new Error('Table is not allowed by the access policy');
  }
  hasTableRestrictions(c: DatabaseConnection): boolean {
    return this.rules(c).some((r) => r.schemas || r.allowTables || r.denyTables);
  }
  assertQuery(
    c: DatabaseConnection,
    query: string,
    readOnly: boolean,
    options: { deferNames?: boolean } = {}
  ): SqlAnalysis | undefined {
    this.assertConnection(c);
    const error =
      validateStatement(query, undefined, sqlDialect(c.driver)) ||
      (readOnly || this.isReadOnly(c) ? validateReadStatement(query, sqlDialect(c.driver)) : null);
    if (error) throw new Error(error);
    const rules = this.rules(c);
    const restricted = this.isDatabaseScoped(c);
    if (!restricted) return;
    if (
      sqlDialect(c.driver) === 'oracle' &&
      sqlTokens(query).some((t) => t.kind === 'symbol' && t.value === '@')
    )
      throw new Error('Oracle database links are outside the database scope');
    const analysis = analyzeSql(query, c.driver);
    for (const [kind, names] of [
      ['table', analysis.relations],
      ['function', analysis.functions],
    ] as const)
      for (const parts of names) {
        const error = this.scopeError(c, parts, kind);
        if (error) throw new Error(error);
      }
    if (
      this.hasTableRestrictions(c) &&
      !['select', 'explain', 'insert', 'update', 'delete'].includes(analysis.operation)
    )
      throw new Error(
        'Schema and administrative changes are disabled while table access policies are active'
      );
    if (analysis.opaqueRelations || analysis.settings || analysis.locking)
      throw new Error(
        'Dynamic tables, locking, and query settings are disabled by the access policy'
      );
    if ((readOnly || this.isReadOnly(c)) && analysis.writes)
      throw new Error('Read-only SQL cannot modify data');
    if (analysis.missingPredicate) throw new Error('UPDATE and DELETE require a WHERE clause');
    if (
      [...analysis.relations, ...analysis.functions].some((parts) =>
        parts.some((p) => p.value.includes('.'))
      )
    )
      throw new Error('Identifiers containing dots are unsupported under table policies');
    if (!options.deferNames)
      for (const relation of analysis.relations)
        this.assertTable(c, canonicalName(relation, c.driver));
    for (const name of analysis.functions) {
      const functionName = canonicalName(name, c.driver);
      const builtIn = this.isBuiltin(name);
      if (options.deferNames && !builtIn) continue;
      if (
        rules.some((r) => r.denyFunctions && includes(r.denyFunctions, functionName)) ||
        (!builtIn &&
          !rules.some((r) => r.allowFunctions && includes(r.allowFunctions, functionName)))
      )
        throw new Error('Function is not allowed by the access policy');
    }
    return analysis;
  }
}
