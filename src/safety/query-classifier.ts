import { identify } from 'sql-query-identifier';
import type { Dialect, Result as IdentifyResult } from 'sql-query-identifier';
import type { DriverDialect } from '../types.js';

export interface QueryClassification {
  /** Statement type, e.g. 'SELECT', 'INSERT', 'CREATE_TABLE', 'DROP_DATABASE' */
  type: string;
  /** Execution type from sql-query-identifier */
  executionType: string;
  /** True for SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA, and WITH...SELECT */
  isReadOnly: boolean;
  /** True for DROP DATABASE, TRUNCATE, DELETE/UPDATE without WHERE, GRANT, REVOKE, user management */
  isDangerous: boolean;
  /** Number of statements detected in the input */
  statements: number;
}

/**
 * Read-only statement types that never modify data.
 */
const READ_ONLY_TYPES = new Set<string>([
  'SELECT',
  'SHOW_BINARY',
  'SHOW_BINLOG',
  'SHOW_CHARACTER',
  'SHOW_COLLATION',
  'SHOW_CREATE',
  'SHOW_ENGINE',
  'SHOW_ENGINES',
  'SHOW_ERRORS',
  'SHOW_EVENTS',
  'SHOW_FUNCTION',
  'SHOW_GRANTS',
  'SHOW_MASTER',
  'SHOW_OPEN',
  'SHOW_PLUGINS',
  'SHOW_PRIVILEGES',
  'SHOW_PROCEDURE',
  'SHOW_PROCESSLIST',
  'SHOW_PROFILE',
  'SHOW_PROFILES',
  'SHOW_RELAYLOG',
  'SHOW_REPLICAS',
  'SHOW_SLAVE',
  'SHOW_REPLICA',
  'SHOW_STATUS',
  'SHOW_TRIGGERS',
  'SHOW_VARIABLES',
  'SHOW_WARNINGS',
  'SHOW_DATABASES',
  'SHOW_KEYS',
  'SHOW_INDEX',
  'SHOW_TABLE',
  'SHOW_TABLES',
  'SHOW_COLUMNS',
]);

/**
 * Dangerous statement types that should always be blocked or flagged.
 */
const DANGEROUS_TYPES = new Set<string>(['DROP_DATABASE', 'DROP_SCHEMA', 'TRUNCATE']);

/**
 * Map our DriverDialect enum values to sql-query-identifier dialect strings.
 */
function mapDialect(dialect?: DriverDialect): Dialect {
  if (!dialect) return 'generic';
  const mapping: Record<DriverDialect, Dialect> = {
    postgres: 'psql',
    mysql: 'mysql',
    mssql: 'mssql',
    sqlite: 'sqlite',
  };
  return mapping[dialect] ?? 'generic';
}

/**
 * Strip SQL comments from a string for safe regex analysis.
 * Removes both inline (--) and block comments.
 */
function stripComments(sql: string): string {
  // Remove block comments (non-greedy, handles nested poorly but sufficient for safety checks)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove inline comments
  result = result.replace(/--[^\n]*/g, ' ');
  return result;
}

/**
 * Check whether a statement text appears to be missing a WHERE clause
 * for DELETE or UPDATE operations. This is a heuristic for safety.
 */
function isMissingWhereClause(statementText: string, type: string): boolean {
  if (type !== 'DELETE' && type !== 'UPDATE') return false;

  const stripped = stripComments(statementText);
  // Normalize whitespace for reliable matching
  const normalized = stripped.replace(/\s+/g, ' ').trim().toLowerCase();

  return !normalized.includes(' where ');
}

/**
 * Check whether a statement involves user management operations
 * (GRANT, REVOKE, CREATE USER, DROP USER, ALTER USER).
 * These are not always captured as distinct types by sql-query-identifier
 * so we supplement with text analysis.
 */
function isUserManagementStatement(statementText: string): boolean {
  const stripped = stripComments(statementText);
  const normalized = stripped.replace(/\s+/g, ' ').trim().toLowerCase();

  const userManagementPatterns = [
    /^\s*grant\s+/,
    /^\s*revoke\s+/,
    /^\s*create\s+user\b/,
    /^\s*drop\s+user\b/,
    /^\s*alter\s+user\b/,
  ];

  return userManagementPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Check if a statement type represents a read-only operation.
 * Handles both sql-query-identifier types and text-based fallback detection.
 */
function isReadOnlyType(type: string, statementText: string): boolean {
  if (READ_ONLY_TYPES.has(type)) return true;

  // Check for EXPLAIN, DESCRIBE, DESC, PRAGMA via text analysis
  // (sql-query-identifier may classify these as UNKNOWN)
  const stripped = stripComments(statementText);
  const normalized = stripped.replace(/\s+/g, ' ').trim().toLowerCase();

  if (/^\s*explain\b/.test(normalized)) return true;
  if (/^\s*describe\b/.test(normalized)) return true;
  if (/^\s*desc\b/.test(normalized)) return true;
  if (/^\s*pragma\b/.test(normalized)) return true;

  // SHOW without a specific type detected
  if (type === 'UNKNOWN' && /^\s*show\b/.test(normalized)) return true;

  return false;
}

/**
 * Check if a statement is dangerous based on its type and text content.
 */
function isDangerousStatement(type: string, statementText: string): boolean {
  if (DANGEROUS_TYPES.has(type)) return true;

  // Check for missing WHERE on DELETE/UPDATE
  if (isMissingWhereClause(statementText, type)) return true;

  // Check for user management statements
  if (isUserManagementStatement(statementText)) return true;

  return false;
}

/**
 * Fallback classifier for when sql-query-identifier throws on malformed SQL.
 * Uses basic text analysis after stripping comments.
 */
function fallbackClassify(sql: string): QueryClassification {
  const stripped = stripComments(sql);
  const normalized = stripped.replace(/\s+/g, ' ').trim().toLowerCase();

  // Determine type from the first keyword
  let type = 'UNKNOWN';
  let isReadOnly = false;
  let isDangerous = false;

  if (/^\s*select\b/.test(normalized)) {
    type = 'SELECT';
    isReadOnly = true;
  } else if (/^\s*with\b/.test(normalized)) {
    // CTEs: check if it ends up being a SELECT
    type = 'SELECT';
    isReadOnly = !/(insert|update|delete|merge)\s+/i.test(normalized);
  } else if (/^\s*explain\b/.test(normalized)) {
    type = 'EXPLAIN';
    isReadOnly = true;
  } else if (/^\s*show\b/.test(normalized)) {
    type = 'SHOW';
    isReadOnly = true;
  } else if (/^\s*describe\b/.test(normalized) || /^\s*desc\b/.test(normalized)) {
    type = 'DESCRIBE';
    isReadOnly = true;
  } else if (/^\s*pragma\b/.test(normalized)) {
    type = 'PRAGMA';
    isReadOnly = true;
  } else if (/^\s*insert\b/.test(normalized)) {
    type = 'INSERT';
  } else if (/^\s*update\b/.test(normalized)) {
    type = 'UPDATE';
  } else if (/^\s*delete\b/.test(normalized)) {
    type = 'DELETE';
  } else if (/^\s*create\b/.test(normalized)) {
    type = 'CREATE';
  } else if (/^\s*alter\b/.test(normalized)) {
    type = 'ALTER';
  } else if (/^\s*drop\b/.test(normalized)) {
    type = 'DROP';
  } else if (/^\s*truncate\b/.test(normalized)) {
    type = 'TRUNCATE';
    isDangerous = true;
  } else if (/^\s*grant\b/.test(normalized)) {
    type = 'GRANT';
    isDangerous = true;
  } else if (/^\s*revoke\b/.test(normalized)) {
    type = 'REVOKE';
    isDangerous = true;
  }

  // Check for dangerous patterns
  if (/drop\s+database\b/.test(normalized) || /drop\s+schema\b/.test(normalized)) {
    isDangerous = true;
  }
  if (type === 'DELETE' && !normalized.includes(' where ')) {
    isDangerous = true;
  }
  if (type === 'UPDATE' && !normalized.includes(' where ')) {
    isDangerous = true;
  }
  if (isUserManagementStatement(sql)) {
    isDangerous = true;
  }

  // Count statements by semicolons (rough approximation)
  const statementCount = Math.max(
    1,
    stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length
  );

  return {
    type,
    executionType: isReadOnly ? 'LISTING' : 'MODIFICATION',
    isReadOnly,
    isDangerous,
    statements: statementCount,
  };
}

/**
 * Classify a SQL query using sql-query-identifier with fallback to text analysis.
 *
 * @param sql - The SQL string to classify
 * @param dialect - Optional database dialect for more accurate parsing
 * @returns Classification details including type, read-only status, and danger flags
 */
export function classifyQuery(sql: string, dialect?: DriverDialect): QueryClassification {
  if (!sql || sql.trim().length === 0) {
    return {
      type: 'UNKNOWN',
      executionType: 'UNKNOWN',
      isReadOnly: false,
      isDangerous: false,
      statements: 0,
    };
  }

  let results: IdentifyResult[];
  try {
    results = identify(sql, { dialect: mapDialect(dialect) });
  } catch {
    // sql-query-identifier could not parse the SQL; fall back to text analysis
    return fallbackClassify(sql);
  }

  if (results.length === 0) {
    return fallbackClassify(sql);
  }

  // Analyze each statement
  let overallIsReadOnly = true;
  let overallIsDangerous = false;

  for (const stmt of results) {
    const stmtReadOnly = isReadOnlyType(stmt.type, stmt.text);
    const stmtDangerous = isDangerousStatement(stmt.type, stmt.text);

    if (!stmtReadOnly) {
      overallIsReadOnly = false;
    }
    if (stmtDangerous) {
      overallIsDangerous = true;
    }
  }

  // Use the first statement's type as the primary type
  const primaryResult = results[0];

  return {
    type: primaryResult.type,
    executionType: primaryResult.executionType,
    isReadOnly: overallIsReadOnly,
    isDangerous: overallIsDangerous,
    statements: results.length,
  };
}
