import type { ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse, textResponse } from './base.js';
import { sanitizeConnectionId, convertToCSV } from '../utils.js';
import {
  ExecuteQuerySchema,
  ExecuteQueryInput,
  WriteQuerySchema,
  WriteQueryInput,
  ExportDataSchema,
  ExportDataInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query tools – execute read queries, write queries, and export data.
// ---------------------------------------------------------------------------

type ExecuteQueryParams = z.infer<typeof ExecuteQueryInput>;
type WriteQueryParams = z.infer<typeof WriteQueryInput>;
type ExportDataParams = z.infer<typeof ExportDataInput>;

export const queryTools: ToolDefinition[] = [
  // -----------------------------------------------------------------------
  // execute_query
  // -----------------------------------------------------------------------
  {
    name: 'execute_query',
    description: 'Execute a SQL query on a specific DBeaver connection (read-only queries)',
    category: 'read',
    inputSchema: ExecuteQuerySchema.jsonSchema,
    zodSchema: ExecuteQuerySchema.zodSchema,

    async handler(input: ExecuteQueryParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const query = input.query.trim();
      const maxRows = Math.min(Math.max(1, input.maxRows), 100000);

      // Enforce read-only: only SELECT / EXPLAIN / SHOW / etc.
      const readOnlyError = ctx.safetyLayer.enforceReadOnly(query);
      if (readOnlyError) {
        throw new Error(readOnlyError);
      }

      // Additional validation through the safety layer
      const validationError = ctx.safetyLayer.validateQuery(query, {
        readOnly: true,
        allowInsert: false,
        allowUpdate: false,
        allowDelete: false,
        allowDDL: false,
      });
      if (validationError) {
        throw new Error(validationError);
      }

      const connection = await ctx.connectionRegistry.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);

      // Add LIMIT / TOP clause if it is a SELECT without one
      let finalQuery = query;
      const lowerQuery = query.toLowerCase().trimStart();

      if (lowerQuery.startsWith('select')) {
        if (driver.dialect === 'mssql') {
          // SQL Server uses TOP instead of LIMIT
          if (
            !lowerQuery.includes('top ') &&
            !lowerQuery.includes('offset ') &&
            !lowerQuery.includes('fetch next')
          ) {
            finalQuery = query.replace(/^select/i, `SELECT TOP ${maxRows}`);
          }
        } else {
          if (!lowerQuery.includes('limit')) {
            const withoutTrailingSemicolon = query.replace(/;+\s*$/g, '');
            finalQuery = `${withoutTrailingSemicolon} LIMIT ${maxRows}`;
          }
        }
      }

      const result = await driver.query(finalQuery);

      return jsonResponse({
        query: finalQuery,
        connection: connection.name,
        executionTime: result.executionTime,
        rowCount: result.rowCount,
        columns: result.columns,
        rows: result.rows,
        truncated: result.rows.length >= maxRows,
      });
    },
  },

  // -----------------------------------------------------------------------
  // write_query
  // -----------------------------------------------------------------------
  {
    name: 'write_query',
    description: 'Execute INSERT, UPDATE, or DELETE queries on a specific DBeaver connection',
    category: 'write',
    inputSchema: WriteQuerySchema.jsonSchema,
    zodSchema: WriteQuerySchema.zodSchema,

    async handler(input: WriteQueryParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const query = input.query.trim();
      const lowerQuery = query.toLowerCase();

      // Must be INSERT, UPDATE, or DELETE
      if (lowerQuery.startsWith('select')) {
        throw new Error('Use execute_query for SELECT operations');
      }

      if (
        !(
          lowerQuery.startsWith('insert') ||
          lowerQuery.startsWith('update') ||
          lowerQuery.startsWith('delete')
        )
      ) {
        throw new Error('Only INSERT, UPDATE, or DELETE operations are allowed with write_query');
      }

      // Validate through the safety layer
      const validationError = ctx.safetyLayer.validateQuery(query, {
        readOnly: false,
        allowInsert: true,
        allowUpdate: true,
        allowDelete: true,
        allowDDL: false,
      });
      if (validationError) {
        throw new Error(validationError);
      }

      const connection = await ctx.connectionRegistry.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);
      const result = await driver.execute(query);

      return jsonResponse({
        query,
        connection: connection.name,
        affectedRows: result.affectedRows,
        success: true,
      });
    },
  },

  // -----------------------------------------------------------------------
  // export_data
  // -----------------------------------------------------------------------
  {
    name: 'export_data',
    description: 'Export query results to various formats (CSV, JSON, etc.)',
    category: 'read',
    inputSchema: ExportDataSchema.jsonSchema,
    zodSchema: ExportDataSchema.zodSchema,

    async handler(input: ExportDataParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const query = input.query.trim();

      // Only SELECT queries are allowed for export
      if (!query.toLowerCase().trimStart().startsWith('select')) {
        throw new Error('Only SELECT queries are allowed for export');
      }

      const maxRows = Math.min(Math.max(1, input.maxRows), 1000000);
      const format = input.format;

      const connection = await ctx.connectionRegistry.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);

      // Add LIMIT clause if not present
      let finalQuery = query;
      if (!query.toLowerCase().includes('limit')) {
        const withoutTrailingSemicolon = query.replace(/;+\s*$/g, '');
        finalQuery = `${withoutTrailingSemicolon} LIMIT ${maxRows}`;
      }

      const result = await driver.query(finalQuery);

      if (format === 'csv') {
        const csv = convertToCSV(result.columns, result.rows);
        return textResponse(csv);
      }

      if (format === 'json') {
        const jsonData = result.rows.map((row) => {
          const obj: Record<string, unknown> = {};
          result.columns.forEach((col, idx) => {
            obj[col] = row[idx];
          });
          return obj;
        });
        return jsonResponse(jsonData);
      }

      throw new Error(`Unsupported export format: ${format}. Use 'csv' or 'json'`);
    },
  },
];
