import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DBeaverConfigParser } from './config-parser.js';
import { DBeaverConnectionSource, ConnectionRegistry } from './connections/index.js';
import { DriverRegistry } from './drivers/index.js';
import { SafetyLayer } from './safety/index.js';
import { ToolRegistry } from './tools/index.js';
import { ConnectionPoolManager } from './pools/connection-pool.js';
import { TransactionManager } from './managers/index.js';
import type { ServerConfig, ToolContext } from './types.js';
import { formatError, redactArgs } from './utils.js';

// ── Version ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);
const VERSION = packageJson.version;

// ── CLI ──────────────────────────────────────────────────────────────────
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`
DBeaver MCP Server v${VERSION}

Usage: dbeaver-mcp-server [options]

Options:
  -h, --help     Show this help message
  --version      Show version information
  --debug        Enable debug logging

Environment Variables:
  DBEAVER_PATH                 Path to DBeaver executable
  DBEAVER_WORKSPACE            Path to DBeaver workspace
  DBEAVER_TIMEOUT              Query timeout in milliseconds (default: 30000)
  DBEAVER_DEBUG                Enable debug logging (true/false)
  DBEAVER_READ_ONLY            Disable all write operations (true/false)
  DBEAVER_ALLOWED_CONNECTIONS  Comma-separated whitelist of connection IDs or names
  DBEAVER_DISABLED_TOOLS       Comma-separated list of tools to disable

For more information, visit: https://github.com/srthkdev/dbeaver-mcp-server
`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.error(VERSION);
  process.exit(0);
}

// ── Config ───────────────────────────────────────────────────────────────
const config: ServerConfig = {
  debug: process.env.DBEAVER_DEBUG === 'true' || process.argv.includes('--debug'),
  readOnly: process.env.DBEAVER_READ_ONLY === 'true',
  disabledTools: (process.env.DBEAVER_DISABLED_TOOLS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  allowedConnections: (() => {
    const raw = (process.env.DBEAVER_ALLOWED_CONNECTIONS || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    return raw.length > 0 ? new Set(raw) : null;
  })(),
  timeout: parseInt(process.env.DBEAVER_TIMEOUT || '30000'),
};

const STALE_TRANSACTION_CHECK_MS = 5 * 60 * 1000;

function log(message: string, level: 'info' | 'error' | 'debug' = 'info') {
  if (level === 'debug' && !config.debug) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// ── Components ───────────────────────────────────────────────────────────
const configParser = new DBeaverConfigParser({
  debug: config.debug,
  timeout: config.timeout,
  executablePath: process.env.DBEAVER_PATH,
  workspacePath: process.env.DBEAVER_WORKSPACE,
});

const dbeaverSource = new DBeaverConnectionSource(configParser);
const connectionRegistry = new ConnectionRegistry([dbeaverSource], config.allowedConnections);

const poolConfig = {
  min: parseInt(process.env.DBEAVER_POOL_MIN || '2'),
  max: parseInt(process.env.DBEAVER_POOL_MAX || '10'),
  idleTimeoutMs: parseInt(process.env.DBEAVER_POOL_IDLE_TIMEOUT || '30000'),
  acquireTimeoutMs: parseInt(process.env.DBEAVER_POOL_ACQUIRE_TIMEOUT || '10000'),
};

const driverRegistry = new DriverRegistry({ poolConfig }, config.debug);
const safetyLayer = new SafetyLayer();

// Transaction manager still uses the old ConnectionPoolManager
// (will be migrated to driver-based transactions in Phase 2)
const poolManager = new ConnectionPoolManager(poolConfig, config.debug);
const transactionManager = new TransactionManager(poolManager, config.debug);

const toolRegistry = new ToolRegistry(config);

const ctx: ToolContext = {
  connectionRegistry,
  driverRegistry,
  safetyLayer,
  transactionManager,
  config,
  log,
};

// ── MCP Server ───────────────────────────────────────────────────────────
const server = new Server(
  { name: 'dbeaver-mcp-server', version: VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

// Resources: table schemas
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const connections = await connectionRegistry.getAllConnections();
    const resources: Array<{ uri: string; mimeType: string; name: string; description: string }> =
      [];

    for (const connection of connections) {
      try {
        const driver = await driverRegistry.getDriver(connection);
        const tables = await driver.listTables(undefined, false);
        for (const table of tables) {
          resources.push({
            uri: `dbeaver://${connection.id}/${table.name}/schema`,
            mimeType: 'application/json',
            name: `"${table.name}" schema (${connection.name})`,
            description: `Schema information for table ${table.name} in ${connection.name}`,
          });
        }
      } catch (error) {
        log(`Failed to list tables for ${connection.name}: ${error}`, 'debug');
      }
    }
    return { resources };
  } catch (error) {
    log(`Failed to list resources: ${error}`, 'error');
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const uri = new URL(request.params.uri);
    const pathParts = uri.pathname.split('/').filter((p) => p);
    if (pathParts.length < 2 || pathParts[pathParts.length - 1] !== 'schema') {
      throw new Error('Invalid resource URI format');
    }
    const connectionId = uri.hostname;
    const tableName = pathParts[pathParts.length - 2];

    const connection = await connectionRegistry.getConnection(connectionId);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);

    const driver = await driverRegistry.getDriver(connection);
    const schema = await driver.getSchema(tableName);

    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new McpError(ErrorCode.InvalidParams, `Failed to read resource: ${formatError(error)}`);
  }
});

// Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolRegistry.listTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    log(`Executing tool: ${name} with args: ${JSON.stringify(redactArgs(args || {}))}`, 'debug');
    return await toolRegistry.executeTool(name, args, ctx);
  } catch (error: any) {
    log(`Tool execution failed: ${error}`, 'error');
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${formatError(error)}`);
  }
});

// ── Error handling & shutdown ────────────────────────────────────────────
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`, 'error');
});

let staleCleanupInterval: ReturnType<typeof setInterval> | null = null;

const shutdown = async () => {
  log('Shutting down gracefully...');
  try {
    const rolledBack = await transactionManager.rollbackAll();
    if (rolledBack > 0) log(`Rolled back ${rolledBack} active transaction(s)`);
  } catch (error) {
    log(`Error rolling back transactions: ${formatError(error)}`, 'error');
  }
  try {
    await driverRegistry.closeAll();
  } catch (error) {
    log(`Error closing drivers: ${formatError(error)}`, 'error');
  }
  try {
    await poolManager.closeAllPools();
  } catch (error) {
    log(`Error closing pools: ${formatError(error)}`, 'error');
  }
  if (staleCleanupInterval) clearInterval(staleCleanupInterval);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ────────────────────────────────────────────────────────────────
async function run() {
  if (!configParser.isWorkspaceValid()) {
    log('DBeaver workspace not found. Server will start but cannot access connections.', 'error');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('DBeaver MCP server started successfully');

  staleCleanupInterval = setInterval(async () => {
    try {
      const cleaned = await transactionManager.cleanupStaleTransactions();
      if (cleaned > 0) log(`Cleaned up ${cleaned} stale transaction(s)`);
    } catch (error) {
      log(`Stale transaction cleanup error: ${formatError(error)}`, 'debug');
    }
  }, STALE_TRANSACTION_CHECK_MS);
  staleCleanupInterval.unref();

  if (config.readOnly) log('Read-only mode enabled: write operations are disabled');
  if (config.allowedConnections) {
    log(`Connection whitelist active: ${Array.from(config.allowedConnections).join(', ')}`);
  }
  if (config.debug) {
    log(`Debug info: ${JSON.stringify(configParser.getDebugInfo(), null, 2)}`, 'debug');
  }
}

run().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
