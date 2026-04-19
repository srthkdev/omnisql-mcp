import type { AccessRules, DriverDialect } from '../types.js';
import { classifyQuery } from './query-classifier.js';

/**
 * DDL statement type prefixes. Used to detect CREATE, ALTER, DROP operations
 * from the classified statement type string.
 */
const DDL_PREFIXES = ['CREATE', 'ALTER', 'DROP'];

/**
 * Checks if a classified statement type represents a DDL operation.
 */
function isDDLType(type: string): boolean {
  return DDL_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * Validate a SQL query against the provided access rules.
 *
 * Uses sql-query-identifier-based classification (not regex on raw SQL)
 * to prevent comment-injection bypasses (e.g. hiding DROP TABLE inside SQL comments).
 *
 * @param sql - The SQL query to validate
 * @param rules - Access control rules to enforce
 * @param dialect - Optional database dialect for more accurate parsing
 * @returns null if the query is valid, or an error message string if invalid
 */
export function validateQuery(
  sql: string,
  rules: AccessRules,
  dialect?: DriverDialect
): string | null {
  if (!sql || sql.trim().length === 0) {
    return 'Query cannot be empty';
  }

  const classification = classifyQuery(sql, dialect);

  // Always block dangerous operations regardless of rules
  if (classification.isDangerous) {
    return getDangerousQueryMessage(classification.type, sql);
  }

  // Enforce read-only mode
  if (rules.readOnly && !classification.isReadOnly) {
    return `Query blocked: read-only mode is enabled. Statement type '${classification.type}' is not a read-only operation.`;
  }

  // Check INSERT permission
  if (classification.type === 'INSERT' && !rules.allowInsert) {
    return 'INSERT operations are not allowed by the current access rules.';
  }

  // Check UPDATE permission
  if (classification.type === 'UPDATE' && !rules.allowUpdate) {
    return 'UPDATE operations are not allowed by the current access rules.';
  }

  // Check DELETE permission
  if (classification.type === 'DELETE' && !rules.allowDelete) {
    return 'DELETE operations are not allowed by the current access rules.';
  }

  // Check DDL permission (CREATE, ALTER, DROP of tables/views/indexes/etc.)
  if (isDDLType(classification.type) && !rules.allowDDL) {
    return `DDL operations (${classification.type}) are not allowed by the current access rules.`;
  }

  return null;
}

/**
 * Build a specific error message for dangerous query types.
 */
function getDangerousQueryMessage(type: string, sql: string): string {
  switch (type) {
    case 'DROP_DATABASE':
      return 'Blocked: DROP DATABASE is a destructive operation that is never allowed.';
    case 'DROP_SCHEMA':
      return 'Blocked: DROP SCHEMA is a destructive operation that is never allowed.';
    case 'TRUNCATE':
      return 'Blocked: TRUNCATE is a destructive operation that removes all data from a table.';
    default:
      break;
  }

  // Check for specific dangerous patterns via text analysis
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

  if (/^\s*grant\b/.test(normalized)) {
    return 'Blocked: GRANT statements that modify database permissions are not allowed.';
  }
  if (/^\s*revoke\b/.test(normalized)) {
    return 'Blocked: REVOKE statements that modify database permissions are not allowed.';
  }
  if (/create\s+user\b/.test(normalized)) {
    return 'Blocked: CREATE USER is a privileged operation that is not allowed.';
  }
  if (/drop\s+user\b/.test(normalized)) {
    return 'Blocked: DROP USER is a privileged operation that is not allowed.';
  }
  if (/alter\s+user\b/.test(normalized)) {
    return 'Blocked: ALTER USER is a privileged operation that is not allowed.';
  }
  if (type === 'DELETE') {
    return 'Blocked: DELETE without a WHERE clause would affect all rows in the table. Add a WHERE clause to proceed.';
  }
  if (type === 'UPDATE') {
    return 'Blocked: UPDATE without a WHERE clause would affect all rows in the table. Add a WHERE clause to proceed.';
  }
  if (/drop\s+database\b/.test(normalized) || /drop\s+schema\b/.test(normalized)) {
    return 'Blocked: DROP DATABASE/SCHEMA is a destructive operation that is never allowed.';
  }

  return 'Potentially dangerous query detected. Query blocked for safety.';
}

/**
 * Enforce that a query is read-only. Used by execute_query to ensure
 * only SELECT, EXPLAIN, SHOW, DESCRIBE, etc. are accepted.
 *
 * This uses proper SQL parsing rather than prefix-regex matching to prevent
 * comment-injection bypasses.
 *
 * @param sql - The SQL query to check
 * @param dialect - Optional database dialect for more accurate parsing
 * @returns null if the query is read-only, or an error message string if not
 */
export function enforceReadOnly(sql: string, dialect?: DriverDialect): string | null {
  if (!sql || sql.trim().length === 0) {
    return 'Query cannot be empty';
  }

  const classification = classifyQuery(sql, dialect);

  // Allow read-only queries
  if (classification.isReadOnly) {
    return null;
  }

  // Special case: allow SET search_path for PostgreSQL (safe configuration command)
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (/^\s*set\s+search_path\b/.test(stripped)) {
    return null;
  }

  return 'Only read-only queries (SELECT, EXPLAIN, SHOW, DESCRIBE) are allowed. Use write_query for data modifications.';
}
