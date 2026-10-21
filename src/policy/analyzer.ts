import { createRequire } from 'node:module';
import { sqlTokens } from './sql.js';

export interface SqlNamePart {
  value: string;
  quoted: boolean;
}
export interface SqlAnalysis {
  operation: string;
  relations: SqlNamePart[][];
  functions: SqlNamePart[][];
  writes: boolean;
  missingPredicate: boolean;
  opaqueRelations: boolean;
  locking: boolean;
  settings: boolean;
}
const require = createRequire(import.meta.url);
let native: { analyze_sql(query: string, dialect: string): string } | undefined;
export function sqlDialect(driver: string): string {
  const d = driver.toLowerCase();
  if (/postgres|cockroach|timescale|redshift|yugabyte|alloydb|supabase|neon|citus/.test(d))
    return 'postgres';
  if (/mysql|mariadb/.test(d)) return 'mysql';
  if (/mssql|sqlserver|microsoft/.test(d)) return 'mssql';
  for (const name of ['sqlite', 'oracle', 'duckdb', 'clickhouse'])
    if (d.includes(name)) return name;
  return 'generic';
}
export function analyzeSql(query: string, driver: string): SqlAnalysis {
  // Reject dialect-ambiguous comments/escapes before handing text to the grammar.
  sqlTokens(query, sqlDialect(driver));
  native ??= require('../native/omnisql_sql_policy.js');
  try {
    const dialect = sqlDialect(driver);
    // sqlparser lacks ClickHouse's fixed EXPLAIN JSON option. Parse its unchanged body.
    const source =
      dialect === 'clickhouse'
        ? query.replace(/^\s*EXPLAIN\s+json\s*=\s*1\s+/i, 'EXPLAIN ')
        : query;
    return JSON.parse(native!.analyze_sql(source, dialect)) as SqlAnalysis;
  } catch {
    throw new Error('SQL cannot be analyzed safely for this database dialect');
  }
}
export function canonicalName(parts: SqlNamePart[], driver: string): string {
  const oracle = sqlDialect(driver) === 'oracle';
  return parts
    .map((p) => (p.quoted ? p.value : oracle ? p.value.toUpperCase() : p.value.toLowerCase()))
    .join('.');
}
