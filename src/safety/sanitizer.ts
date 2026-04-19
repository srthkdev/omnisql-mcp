import type { DriverDialect } from '../types.js';

/** Maximum allowed length for a SQL identifier. */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Pattern for a valid SQL identifier: starts with a letter or underscore,
 * followed by letters, digits, or underscores.
 */
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Patterns that indicate possible SQL injection attempts within identifiers.
 */
const INJECTION_PATTERNS = /['";\\]|--|\/\*|\*\/|;/;

/**
 * Validate and sanitize a SQL identifier (table name, column name, schema name).
 *
 * Validates that the identifier:
 * - Is a non-empty string
 * - Contains only safe characters: `[a-zA-Z_][a-zA-Z0-9_]*`
 * - Does not exceed 128 characters
 * - Contains no SQL injection patterns (quotes, comments, semicolons)
 *
 * @param identifier - The raw identifier string to sanitize
 * @returns The sanitized identifier (trimmed)
 * @throws Error if the identifier fails any validation check
 */
export function sanitizeIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Identifier must be a non-empty string');
  }

  const sanitized = identifier.trim();

  if (sanitized.length === 0) {
    throw new Error('Identifier must be a non-empty string');
  }

  // Check for SQL injection patterns before any other validation
  if (INJECTION_PATTERNS.test(sanitized)) {
    throw new Error('Identifier contains invalid characters');
  }

  // Validate length
  if (sanitized.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`Identifier too long (max ${MAX_IDENTIFIER_LENGTH} characters)`);
  }

  // Must start with letter or underscore
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    throw new Error('Identifier must start with a letter or underscore');
  }

  // Only allow safe characters
  if (!IDENTIFIER_PATTERN.test(sanitized)) {
    throw new Error('Identifier contains invalid characters');
  }

  return sanitized;
}

/**
 * Check whether a string is a valid SQL identifier without throwing.
 *
 * @param identifier - The string to check
 * @returns true if the identifier passes all validation checks, false otherwise
 */
export function isValidIdentifier(identifier: string): boolean {
  try {
    sanitizeIdentifier(identifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Quote a SQL identifier using the appropriate dialect-specific quoting mechanism.
 *
 * Handles schema-qualified names (e.g. "myschema.mytable") by splitting on `.`,
 * validating and quoting each part independently, then re-joining with `.`.
 *
 * Quoting rules by dialect:
 * - postgres: `"identifier"` (double quotes, internal double quotes escaped by doubling)
 * - mysql:    `` `identifier` `` (backticks, internal backticks escaped by doubling)
 * - mssql:    `[identifier]` (brackets, internal `]` escaped by doubling)
 * - sqlite:   `"identifier"` (double quotes, same as postgres)
 *
 * @param identifier - The identifier to quote (may include schema prefix with `.`)
 * @param dialect - The database dialect determining quoting style
 * @returns The properly quoted identifier
 * @throws Error if any part of the identifier fails sanitization
 */
export function quoteIdentifier(identifier: string, dialect: DriverDialect): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Identifier must be a non-empty string');
  }

  const trimmed = identifier.trim();

  // Handle schema.table (or catalog.schema.table) notation
  // Split on dots, validate each part, quote each part, join with dots
  if (trimmed.includes('.')) {
    const parts = trimmed.split('.');

    // Validate that we don't have empty parts (e.g. ".table" or "schema..table")
    for (const part of parts) {
      if (part.trim().length === 0) {
        throw new Error('Identifier contains empty parts in dotted notation');
      }
    }

    return parts.map((part) => quoteSingleIdentifier(part.trim(), dialect)).join('.');
  }

  return quoteSingleIdentifier(trimmed, dialect);
}

/**
 * Quote a single (non-dotted) identifier for the given dialect.
 * Validates the identifier first via sanitizeIdentifier().
 */
function quoteSingleIdentifier(identifier: string, dialect: DriverDialect): string {
  // Validate the identifier is safe
  const safe = sanitizeIdentifier(identifier);

  switch (dialect) {
    case 'postgres':
    case 'sqlite':
      // Double quotes; escape any internal double quotes by doubling
      return `"${safe.replace(/"/g, '""')}"`;

    case 'mysql':
      // Backticks; escape any internal backticks by doubling
      return `\`${safe.replace(/`/g, '``')}\``;

    case 'mssql':
      // Square brackets; escape any internal ] by doubling
      return `[${safe.replace(/\]/g, ']]')}]`;

    default:
      // Defensive: treat unknown dialects like postgres (double quotes)
      dialect satisfies never;
      return `"${safe.replace(/"/g, '""')}"`;
  }
}
