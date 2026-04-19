import type { ToolContext, ToolResult, SchemaDiff } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse } from './base.js';
import { sanitizeConnectionId } from '../utils.js';
import { buildExplainQuery, parseExplainOutput } from '../utils/query-analyzer.js';
import { compareSchemas, parseTableSchema, generateMigrationScript } from '../utils/schema-diff.js';
import {
  ExplainQuerySchema,
  ExplainQueryInput,
  CompareSchemasSchema,
  CompareSchemasInput,
  GetPoolStatsSchema,
  GetPoolStatsInput,
  GetDatabaseStatsSchema,
  GetDatabaseStatsInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

type ExplainQueryParams = z.infer<typeof ExplainQueryInput>;
type CompareSchemasParams = z.infer<typeof CompareSchemasInput>;
type GetPoolStatsParams = z.infer<typeof GetPoolStatsInput>;
type GetDatabaseStatsParams = z.infer<typeof GetDatabaseStatsInput>;

// ═══════════════════════════════════════════════════════════════════════════
// Analysis tools – explain queries, compare schemas, inspect pool & DB stats.
// ═══════════════════════════════════════════════════════════════════════════

export const analysisTools: ToolDefinition[] = [
  // -----------------------------------------------------------------------
  // explain_query
  // -----------------------------------------------------------------------
  {
    name: 'explain_query',
    description: 'Explain a SQL query execution plan for performance analysis',
    category: 'analysis',
    inputSchema: ExplainQuerySchema.jsonSchema,
    zodSchema: ExplainQuerySchema.zodSchema,

    async handler(input: ExplainQueryParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const connection = await ctx.connectionRegistry.getConnection(connectionId);

      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);
      const explainQuery = buildExplainQuery(
        connection.driver,
        input.query,
        input.analyze,
        input.format
      );
      const result = await driver.query(explainQuery);
      const explainResult = parseExplainOutput(
        connection.driver,
        result.rows,
        input.query,
        input.format
      );

      return jsonResponse(explainResult);
    },
  },

  // -----------------------------------------------------------------------
  // compare_schemas
  // -----------------------------------------------------------------------
  {
    name: 'compare_schemas',
    description:
      'Compare database schemas between two connections and optionally generate a migration script',
    category: 'analysis',
    inputSchema: CompareSchemasSchema.jsonSchema,
    zodSchema: CompareSchemasSchema.zodSchema,

    async handler(input: CompareSchemasParams, ctx: ToolContext): Promise<ToolResult> {
      const sourceConnId = sanitizeConnectionId(input.sourceConnectionId);
      const targetConnId = sanitizeConnectionId(input.targetConnectionId);

      const sourceConn = await ctx.connectionRegistry.getConnection(sourceConnId);
      if (!sourceConn) {
        throw new Error(`Source connection not found: ${sourceConnId}`);
      }

      const targetConn = await ctx.connectionRegistry.getConnection(targetConnId);
      if (!targetConn) {
        throw new Error(`Target connection not found: ${targetConnId}`);
      }

      const sourceDriver = await ctx.driverRegistry.getDriver(sourceConn);
      const targetDriver = await ctx.driverRegistry.getDriver(targetConn);

      const sourceTables = await sourceDriver.listTables();
      const targetTables = await targetDriver.listTables();

      // Build structured schemas for source tables
      const sourceSchemas = await Promise.all(
        sourceTables.map(async (table) => {
          const schema = await sourceDriver.getSchema(table.name);
          const rows = schema.columns.map((col) => [
            col.name,
            col.type,
            col.nullable ? 'YES' : 'NO',
            col.defaultValue || null,
          ]);
          const columns = ['column_name', 'data_type', 'is_nullable', 'column_default'];
          return parseTableSchema(table.name, rows, columns);
        })
      );

      // Build structured schemas for target tables
      const targetSchemas = await Promise.all(
        targetTables.map(async (table) => {
          const schema = await targetDriver.getSchema(table.name);
          const rows = schema.columns.map((col) => [
            col.name,
            col.type,
            col.nullable ? 'YES' : 'NO',
            col.defaultValue || null,
          ]);
          const columns = ['column_name', 'data_type', 'is_nullable', 'column_default'];
          return parseTableSchema(table.name, rows, columns);
        })
      );

      const diff: SchemaDiff = await compareSchemas(
        sourceSchemas,
        targetSchemas,
        sourceConnId,
        targetConnId
      );

      const response: { diff: SchemaDiff; migrationScript?: string } = { diff };

      if (input.includeMigrationScript) {
        response.migrationScript = generateMigrationScript(diff, targetConn.driver);
      }

      return jsonResponse(response);
    },
  },

  // -----------------------------------------------------------------------
  // get_pool_stats
  // -----------------------------------------------------------------------
  {
    name: 'get_pool_stats',
    description: 'Get connection pool statistics for a database connection',
    category: 'analysis',
    inputSchema: GetPoolStatsSchema.jsonSchema,
    zodSchema: GetPoolStatsSchema.zodSchema,

    async handler(input: GetPoolStatsParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const connection = await ctx.connectionRegistry.getConnection(connectionId);

      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);
      const stats = driver.getPoolStats();

      if (!stats) {
        return jsonResponse({
          connectionId,
          message: 'No pool available for this connection type',
        });
      }

      return jsonResponse(stats);
    },
  },

  // -----------------------------------------------------------------------
  // get_database_stats
  // -----------------------------------------------------------------------
  {
    name: 'get_database_stats',
    description: 'Get database statistics such as table count, size, and version info',
    category: 'analysis',
    inputSchema: GetDatabaseStatsSchema.jsonSchema,
    zodSchema: GetDatabaseStatsSchema.zodSchema,

    async handler(input: GetDatabaseStatsParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const connection = await ctx.connectionRegistry.getConnection(connectionId);

      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);
      const stats = await driver.getStats();

      return jsonResponse(stats);
    },
  },
];
