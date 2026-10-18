import fs from 'node:fs';
import { DatabaseConnection } from '../types.js';
import { analyzeSql, canonicalName } from './analyzer.js';
import { validateReadStatement, validateStatement } from './sql.js';

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
  private readonly policy: PolicyFile;
  constructor(file = process.env.OMNISQL_POLICY_FILE) {
    if (!file) {
      this.policy = { version: 1 };
      return;
    }
    if (fs.statSync(file).size > 1_000_000) throw new Error('Policy file exceeds 1 MB');
    const p: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  }
  private rules(c: DatabaseConnection): AccessRule[] {
    const base = c.id.split('/')[0];
    return [
      ...(c.accessRules ?? []),
      this.policy.defaults,
      this.policy.connections?.[base],
      this.policy.connections?.[c.id],
    ].filter((r): r is AccessRule => r !== undefined);
  }
  isReadOnly(c: DatabaseConnection): boolean {
    return c.readonly === true || this.rules(c).some((r) => r.readOnly === true);
  }
  allowsDatabase(c: DatabaseConnection, database = c.database ?? ''): boolean {
    return this.rules(c).every((r) => !r.databases || includes(r.databases, database));
  }
  assertConnection(c: DatabaseConnection): void {
    if (!this.allowsDatabase(c)) throw new Error('Database is not allowed by the access policy');
  }
  allowsTable(c: DatabaseConnection, table: string): boolean {
    const parts = table.split('.');
    const schema = parts.length > 1 ? parts.at(-2)! : '';
    return (
      this.allowsDatabase(c) &&
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
  assertQuery(c: DatabaseConnection, query: string, readOnly: boolean): void {
    this.assertConnection(c);
    const error =
      validateStatement(query) ||
      (readOnly || this.isReadOnly(c) ? validateReadStatement(query) : null);
    if (error) throw new Error(error);
    const rules = this.rules(c);
    const restricted =
      this.hasTableRestrictions(c) || rules.some((r) => r.allowFunctions || r.denyFunctions);
    if (!restricted) return;
    const analysis = analyzeSql(query, c.driver);
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
    for (const relation of analysis.relations)
      this.assertTable(c, canonicalName(relation, c.driver));
    for (const name of analysis.functions) {
      const functionName = canonicalName(name, c.driver);
      const builtIn =
        name.length === 1 && !name[0].quoted && FUNCTIONS.has(functionName.toLowerCase());
      if (
        rules.some((r) => r.denyFunctions && includes(r.denyFunctions, functionName)) ||
        (!builtIn &&
          !rules.some((r) => r.allowFunctions && includes(r.allowFunctions, functionName)))
      )
        throw new Error('Function is not allowed by the access policy');
    }
  }
}
