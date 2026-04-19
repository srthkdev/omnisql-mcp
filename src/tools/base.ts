import { z } from 'zod';
import { ToolResult, ToolContext } from '../types.js';

/**
 * Tool categories used for filtering and access control.
 *
 * - `read`     – tools that only read data (SELECT, EXPLAIN, list, etc.)
 * - `write`    – tools that modify rows (INSERT, UPDATE, DELETE)
 * - `ddl`      – tools that modify schema (CREATE, ALTER, DROP)
 * - `admin`    – tools for administrative tasks (pool stats, transactions)
 * - `analysis` – tools for analysis and insights (explain, compare, insights)
 */
export type ToolCategory = 'read' | 'write' | 'ddl' | 'admin' | 'analysis';

/**
 * Complete definition of a single MCP tool, including its metadata,
 * validation schema, and handler function.
 */
export interface ToolDefinition {
  /** Unique tool name used in MCP `CallToolRequest`. */
  name: string;

  /** Human-readable description shown to LLMs. */
  description: string;

  /** Logical category for filtering (e.g. read-only mode hides write/ddl). */
  category: ToolCategory;

  /**
   * JSON Schema representation of the input for MCP tool registration.
   * This is sent verbatim in the `ListToolsResponse`.
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };

  /**
   * Zod schema used for runtime input validation before the handler runs.
   * Must be kept in sync with `inputSchema`.
   */
  zodSchema: z.ZodObject<any>;

  /**
   * Async handler that executes the tool logic.
   *
   * @param input  - The validated (parsed) input object.
   * @param ctx    - Shared context providing access to registries, config, etc.
   * @returns A `ToolResult` containing the response content.
   */
  handler: (input: any, ctx: ToolContext) => Promise<ToolResult>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Response helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wrap an arbitrary value as a pretty-printed JSON text response.
 * This is the most common response format for structured data.
 */
export function jsonResponse(data: any): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Wrap a plain string as a text response.
 * Useful for CSV exports, migration scripts, or simple messages.
 */
export function textResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create a standardised error response without throwing.
 * Use this when you want to return an error message to the LLM
 * rather than raising an MCP error that terminates the call.
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: true, message }, null, 2),
      },
    ],
  };
}
