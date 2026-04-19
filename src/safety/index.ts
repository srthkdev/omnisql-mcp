import type { SafetyLayerInterface, AccessRules, DriverDialect } from '../types.js';
import { classifyQuery as _classifyQuery } from './query-classifier.js';
import {
  validateQuery as _validateQuery,
  enforceReadOnly as _enforceReadOnly,
} from './validator.js';
import {
  quoteIdentifier as _quoteIdentifier,
  sanitizeIdentifier as _sanitizeIdentifier,
} from './sanitizer.js';

/**
 * SafetyLayer provides a unified interface for SQL query safety validation.
 *
 * Implements SafetyLayerInterface for dependency injection throughout the MCP server.
 * Replaces the old regex-based validation in utils.ts with proper SQL parsing
 * via sql-query-identifier, which is resistant to comment-injection bypasses.
 */
export class SafetyLayer implements SafetyLayerInterface {
  classifyQuery(sql: string): { type: string; isReadOnly: boolean } {
    const result = _classifyQuery(sql);
    return { type: result.type, isReadOnly: result.isReadOnly };
  }

  validateQuery(sql: string, rules: AccessRules): string | null {
    return _validateQuery(sql, rules);
  }

  enforceReadOnly(sql: string): string | null {
    return _enforceReadOnly(sql);
  }

  quoteIdentifier(identifier: string, dialect: DriverDialect): string {
    return _quoteIdentifier(identifier, dialect);
  }

  sanitizeIdentifier(identifier: string): string {
    return _sanitizeIdentifier(identifier);
  }
}

// Re-export everything for direct imports
export { classifyQuery } from './query-classifier.js';
export type { QueryClassification } from './query-classifier.js';
export { validateQuery, enforceReadOnly } from './validator.js';
export { quoteIdentifier, sanitizeIdentifier, isValidIdentifier } from './sanitizer.js';
