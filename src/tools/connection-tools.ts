import type { ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from './base.js';
import { jsonResponse } from './base.js';
import { redactConnection, sanitizeConnectionId } from '../utils.js';
import {
  ListConnectionsSchema,
  ListConnectionsInput,
  GetConnectionInfoSchema,
  GetConnectionInfoInput,
  TestConnectionSchema,
  TestConnectionInput,
} from './schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Connection tools – list, inspect, and test DBeaver connections.
// ---------------------------------------------------------------------------

type ListConnectionsParams = z.infer<typeof ListConnectionsInput>;
type GetConnectionInfoParams = z.infer<typeof GetConnectionInfoInput>;
type TestConnectionParams = z.infer<typeof TestConnectionInput>;

export const connectionTools: ToolDefinition[] = [
  // -----------------------------------------------------------------------
  // list_connections
  // -----------------------------------------------------------------------
  {
    name: 'list_connections',
    description: 'List all available DBeaver database connections',
    category: 'read',
    inputSchema: ListConnectionsSchema.jsonSchema,
    zodSchema: ListConnectionsSchema.zodSchema,

    async handler(input: ListConnectionsParams, ctx: ToolContext): Promise<ToolResult> {
      const connections = await ctx.connectionRegistry.getAllConnections();

      if (input.includeDetails) {
        const redacted = connections.map((conn) => redactConnection(conn));
        return jsonResponse(redacted);
      }

      const simplified = connections.map((conn) => ({
        id: conn.id,
        name: conn.name,
        driver: conn.driver,
        host: conn.host,
        database: conn.database,
        folder: conn.folder,
      }));

      return jsonResponse(simplified);
    },
  },

  // -----------------------------------------------------------------------
  // get_connection_info
  // -----------------------------------------------------------------------
  {
    name: 'get_connection_info',
    description: 'Get detailed information about a specific DBeaver connection',
    category: 'read',
    inputSchema: GetConnectionInfoSchema.jsonSchema,
    zodSchema: GetConnectionInfoSchema.zodSchema,

    async handler(input: GetConnectionInfoParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const connection = await ctx.connectionRegistry.getConnection(connectionId);

      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      return jsonResponse(redactConnection(connection));
    },
  },

  // -----------------------------------------------------------------------
  // test_connection
  // -----------------------------------------------------------------------
  {
    name: 'test_connection',
    description: 'Test connectivity to a DBeaver connection',
    category: 'read',
    inputSchema: TestConnectionSchema.jsonSchema,
    zodSchema: TestConnectionSchema.zodSchema,

    async handler(input: TestConnectionParams, ctx: ToolContext): Promise<ToolResult> {
      const connectionId = sanitizeConnectionId(input.connectionId);
      const connection = await ctx.connectionRegistry.getConnection(connectionId);

      if (!connection) {
        throw new Error(`Connection not found: ${connectionId}`);
      }

      const driver = await ctx.driverRegistry.getDriver(connection);
      const testResult = await driver.testConnection();

      return jsonResponse(testResult);
    },
  },
];
