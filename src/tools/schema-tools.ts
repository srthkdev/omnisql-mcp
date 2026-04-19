import type { ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse } from './base.js';
import { sanitizeConnectionId } from '../utils.js';
import {
  ListTablesSchema,
  ListTablesInput,
  GetTableSchemaSchema,
  GetTableSchemaInput,
  CreateTableSchema,
  CreateTableInput,
  AlterTableSchema,
  AlterTableInput,
  DropTableSchema,
  DropTableInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

type ListTablesParams = z.infer<typeof ListTablesInput>;
type GetTableSchemaParams = z.infer<typeof GetTableSchemaInput>;
type CreateTableParams = z.infer<typeof CreateTableInput>;
type AlterTableParams = z.infer<typeof AlterTableInput>;
type DropTableParams = z.infer<typeof DropTableInput>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleListTables(input: ListTablesParams, ctx: ToolContext): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);
  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const driver = await ctx.driverRegistry.getDriver(connection);
  const tables = await driver.listTables(input.schema, input.includeViews);
  return jsonResponse(tables);
}

async function handleGetTableSchema(
  input: GetTableSchemaParams,
  ctx: ToolContext
): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);
  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const driver = await ctx.driverRegistry.getDriver(connection);
  const schema = await driver.getSchema(input.tableName);

  if (!input.includeIndexes) {
    (schema as any).indexes = undefined;
  }

  return jsonResponse(schema);
}

async function handleCreateTable(input: CreateTableParams, ctx: ToolContext): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);
  const query = input.query.trim();

  if (!query.toLowerCase().startsWith('create table')) {
    throw new Error('Only CREATE TABLE statements are allowed');
  }

  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const driver = await ctx.driverRegistry.getDriver(connection);
  await driver.execute(query);

  return jsonResponse({ success: true, message: 'Table created successfully' });
}

async function handleAlterTable(input: AlterTableParams, ctx: ToolContext): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);
  const query = input.query.trim();

  if (!query.toLowerCase().startsWith('alter table')) {
    throw new Error('Only ALTER TABLE statements are allowed');
  }

  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const driver = await ctx.driverRegistry.getDriver(connection);
  await driver.execute(query);

  return jsonResponse({ success: true, message: 'Table altered successfully' });
}

async function handleDropTable(input: DropTableParams, ctx: ToolContext): Promise<ToolResult> {
  const connectionId = sanitizeConnectionId(input.connectionId);

  if (!input.confirm) {
    return jsonResponse({
      success: false,
      message: 'Safety confirmation required. Set confirm=true to proceed with dropping the table.',
    });
  }

  const connection = await ctx.connectionRegistry.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const driver = await ctx.driverRegistry.getDriver(connection);

  // Use the safety layer to properly quote the identifier (SQL injection fix)
  const quotedTableName = ctx.safetyLayer.quoteIdentifier(input.tableName, driver.dialect);

  // Verify the table exists before attempting to drop it
  try {
    await driver.getSchema(input.tableName);
  } catch {
    throw new Error(`Table '${input.tableName}' does not exist or cannot be accessed`);
  }

  await driver.execute(`DROP TABLE ${quotedTableName}`);

  return jsonResponse({
    success: true,
    message: `Table '${input.tableName}' dropped successfully`,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Exported tool definitions
// ═══════════════════════════════════════════════════════════════════════════

export const schemaTools: ToolDefinition[] = [
  {
    name: 'list_tables',
    description: 'List all tables in a database',
    category: 'read',
    inputSchema: ListTablesSchema.jsonSchema,
    zodSchema: ListTablesSchema.zodSchema,
    handler: handleListTables,
  },
  {
    name: 'get_table_schema',
    description: 'Get schema information for a specific table',
    category: 'read',
    inputSchema: GetTableSchemaSchema.jsonSchema,
    zodSchema: GetTableSchemaSchema.zodSchema,
    handler: handleGetTableSchema,
  },
  {
    name: 'create_table',
    description: 'Create new tables in the database',
    category: 'ddl',
    inputSchema: CreateTableSchema.jsonSchema,
    zodSchema: CreateTableSchema.zodSchema,
    handler: handleCreateTable,
  },
  {
    name: 'alter_table',
    description: 'Modify existing table schema (add columns, rename tables, etc.)',
    category: 'ddl',
    inputSchema: AlterTableSchema.jsonSchema,
    zodSchema: AlterTableSchema.zodSchema,
    handler: handleAlterTable,
  },
  {
    name: 'drop_table',
    description: 'Remove a table from the database with safety confirmation',
    category: 'ddl',
    inputSchema: DropTableSchema.jsonSchema,
    zodSchema: DropTableSchema.zodSchema,
    handler: handleDropTable,
  },
];
