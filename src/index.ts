import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { WorkspaceConfigParser } from './config-parser.js';
import { WorkspaceClient } from './workspace-client.js';
import { BusinessInsight, DatabaseConnection, SchemaDiff } from './types.js';
import {
  validateQuery,
  enforceReadOnly,
  sanitizeConnectionId,
  formatError,
  convertToCSV,
  redactConnection,
  redactArgs,
} from './utils.js';
import { ConnectionPoolManager } from './pools/index.js';
import { TransactionManager } from './managers/index.js';
import { buildExplainQuery, parseExplainOutput } from './utils/query-analyzer.js';
import { compareSchemas, parseTableSchema, generateMigrationScript } from './utils/schema-diff.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);
const VERSION = packageJson.version;

// Tool categories for filtering
const WRITE_TOOLS = [
  'write_query',
  'create_table',
  'alter_table',
  'drop_table',
  'begin_transaction',
  'commit_transaction',
  'rollback_transaction',
  'execute_in_transaction',
];

// Limits
const MAX_INSIGHTS = 1000;
const STALE_TRANSACTION_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const MAX_QUERY_ROWS = 100000;
const MAX_EXPORT_ROWS = 1000000;
const DEFAULT_QUERY_ROWS = 1000;
const DEFAULT_EXPORT_ROWS = 10000;

class OmniSQLMCPServer {
  private server: Server;
  private configParser: WorkspaceConfigParser;
  private workspaceClient: WorkspaceClient;
  private poolManager: ConnectionPoolManager;
  private transactionManager: TransactionManager;
  private debug: boolean;
  private insights: BusinessInsight[] = [];
  private insightsFile: string;
  private readOnly: boolean;
  private disabledTools: string[];
  private allowedConnections: Set<string> | null; // null = allow all
  private staleCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.debug = process.env.OMNISQL_DEBUG === 'true';
    this.readOnly = process.env.OMNISQL_READ_ONLY === 'true';
    this.disabledTools = (process.env.OMNISQL_DISABLED_TOOLS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Parse allowed connections whitelist
    const allowedRaw = process.env.OMNISQL_ALLOWED_CONNECTIONS || '';
    const allowedList = allowedRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    this.allowedConnections = allowedList.length > 0 ? new Set(allowedList) : null;

    this.insightsFile = path.join(os.tmpdir(), 'omnisql-mcp-insights.json');

    this.server = new Server(
      {
        name: 'omnisql-mcp',
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.configParser = new WorkspaceConfigParser({
      debug: this.debug,
      timeout: parseInt(process.env.OMNISQL_TIMEOUT || '30000'),
      executablePath: process.env.OMNISQL_CLI_PATH,
      workspacePath: process.env.OMNISQL_WORKSPACE,
    });

    this.workspaceClient = new WorkspaceClient(
      process.env.OMNISQL_CLI_PATH,
      parseInt(process.env.OMNISQL_TIMEOUT || '30000'),
      this.debug,
      process.env.OMNISQL_WORKSPACE || this.configParser.getWorkspacePath()
    );

    // Initialize connection pool and transaction manager
    this.poolManager = new ConnectionPoolManager(
      {
        min: parseInt(process.env.OMNISQL_POOL_MIN || '2'),
        max: parseInt(process.env.OMNISQL_POOL_MAX || '10'),
        idleTimeoutMs: parseInt(process.env.OMNISQL_POOL_IDLE_TIMEOUT || '30000'),
        acquireTimeoutMs: parseInt(process.env.OMNISQL_POOL_ACQUIRE_TIMEOUT || '10000'),
      },
      this.debug
    );
    this.transactionManager = new TransactionManager(this.poolManager, this.debug);

    this.loadInsights();
    this.setupResourceHandlers();
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private log(message: string, level: 'info' | 'error' | 'debug' = 'info') {
    if (level === 'debug' && !this.debug) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else {
      console.error(`${prefix} ${message}`);
    }
  }

  private loadInsights() {
    try {
      if (fs.existsSync(this.insightsFile)) {
        const data = fs.readFileSync(this.insightsFile, 'utf-8');
        this.insights = JSON.parse(data);
      }
    } catch (error) {
      this.log(`Failed to load insights: ${error}`, 'debug');
      this.insights = [];
    }
  }

  private saveInsights() {
    try {
      // Cap insights to prevent unbounded growth
      if (this.insights.length > MAX_INSIGHTS) {
        this.insights = this.insights.slice(-MAX_INSIGHTS);
      }
      fs.writeFileSync(this.insightsFile, JSON.stringify(this.insights, null, 2));
    } catch (error) {
      this.log(`Failed to save insights: ${error}`, 'error');
    }
  }

  /**
   * Check if a connection is allowed by the whitelist.
   * Matches against both connection ID and name.
   */
  private isConnectionAllowed(conn: { id: string; name: string }): boolean {
    if (!this.allowedConnections) return true; // No whitelist = allow all
    return this.allowedConnections.has(conn.id) || this.allowedConnections.has(conn.name);
  }

  /**
   * Get all connections, filtered by the whitelist.
   */
  private async getFilteredConnections(): Promise<DatabaseConnection[]> {
    const connections = await this.configParser.parseConnections();
    if (!this.allowedConnections) return connections;
    return connections.filter((conn) => this.isConnectionAllowed(conn));
  }

  /**
   * Get a single connection by ID/name, respecting the whitelist.
   */
  private async getConnection(connectionId: string): Promise<DatabaseConnection | null> {
    const connection = await this.configParser.getConnection(connectionId);
    if (!connection) return null;
    if (!this.isConnectionAllowed(connection)) return null;
    return connection;
  }

  private setupErrorHandling() {
    process.on('uncaughtException', (error) => {
      this.log(`Uncaught exception: ${error.message}`, 'error');
      if (this.debug) {
        this.log(error.stack || '', 'debug');
      }
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, 'error');
      if (this.debug) {
        this.log(String(reason), 'debug');
      }
    });

    // Graceful shutdown: roll back active transactions, then close pools
    const shutdown = async () => {
      this.log('Shutting down gracefully...');
      try {
        const rolledBack = await this.transactionManager.rollbackAll();
        if (rolledBack > 0) {
          this.log(`Rolled back ${rolledBack} active transaction(s) during shutdown`);
        }
      } catch (error) {
        this.log(`Error rolling back transactions during shutdown: ${formatError(error)}`, 'error');
      }
      try {
        await this.poolManager.closeAllPools();
      } catch (error) {
        this.log(`Error closing pools during shutdown: ${formatError(error)}`, 'error');
      }
      if (this.staleCleanupInterval) {
        clearInterval(this.staleCleanupInterval);
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }

  private setupResourceHandlers() {
    // List all available database resources (table schemas)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try {
        const connections = await this.getFilteredConnections();
        const resources: any[] = [];

        for (const connection of connections) {
          try {
            const tables = await this.workspaceClient.listTables(connection, undefined, false);

            for (const table of tables) {
              const tableName = typeof table === 'string' ? table : table.name || table.table_name;
              if (tableName) {
                resources.push({
                  uri: `omnisql://${connection.id}/${tableName}/schema`,
                  mimeType: 'application/json',
                  name: `"${tableName}" schema (${connection.name})`,
                  description: `Schema information for table ${tableName} in ${connection.name}`,
                });
              }
            }
          } catch (error) {
            this.log(`Failed to list tables for connection ${connection.name}: ${error}`, 'debug');
          }
        }

        return { resources };
      } catch (error) {
        this.log(`Failed to list resources: ${error}`, 'error');
        return { resources: [] };
      }
    });

    // Get schema information for a specific table
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        const uri = new URL(request.params.uri);
        const pathParts = uri.pathname.split('/').filter((p) => p);

        if (pathParts.length < 2 || pathParts[pathParts.length - 1] !== 'schema') {
          throw new Error('Invalid resource URI format');
        }

        const connectionId = uri.hostname;
        const tableName = pathParts[pathParts.length - 2];

        const connection = await this.getConnection(connectionId);
        if (!connection) {
          throw new Error(`Connection not found: ${connectionId}`);
        }

        const schema = await this.workspaceClient.getTableSchema(connection, tableName);

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
        throw new McpError(
          ErrorCode.InvalidParams,
          `Failed to read resource: ${formatError(error)}`
        );
      }
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: 'list_connections',
          description: 'List all available database connections',
          inputSchema: {
            type: 'object',
            properties: {
              includeDetails: {
                type: 'boolean',
                description: 'Include detailed connection information',
                default: false,
              },
            },
          },
        },
        {
          name: 'get_connection_info',
          description: 'Get detailed information about a specific database connection',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
            },
            required: ['connectionId'],
          },
        },
        {
          name: 'execute_query',
          description: 'Execute a SQL query on a specific database connection (read-only queries)',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection to use',
              },
              query: {
                type: 'string',
                description: 'The SQL query to execute (SELECT statements only)',
              },
              maxRows: {
                type: 'number',
                description: 'Maximum number of rows to return (default: 1000)',
                default: 1000,
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        {
          name: 'write_query',
          description:
            'Execute INSERT, UPDATE, or DELETE queries on a specific database connection',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection to use',
              },
              query: {
                type: 'string',
                description: 'The SQL query to execute (INSERT, UPDATE, DELETE)',
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        {
          name: 'create_table',
          description: 'Create new tables in the database',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              query: {
                type: 'string',
                description: 'CREATE TABLE statement',
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        {
          name: 'alter_table',
          description: 'Modify existing table schema (add columns, rename tables, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              query: {
                type: 'string',
                description: 'ALTER TABLE statement',
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        {
          name: 'drop_table',
          description: 'Remove a table from the database with safety confirmation',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              tableName: {
                type: 'string',
                description: 'Name of the table to drop',
              },
              confirm: {
                type: 'boolean',
                description: 'Safety confirmation flag (must be true)',
              },
            },
            required: ['connectionId', 'tableName', 'confirm'],
          },
        },
        {
          name: 'get_table_schema',
          description: 'Get schema information for a specific table',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              tableName: {
                type: 'string',
                description: 'The name of the table to describe',
              },
              includeIndexes: {
                type: 'boolean',
                description: 'Include index information',
                default: true,
              },
            },
            required: ['connectionId', 'tableName'],
          },
        },
        {
          name: 'export_data',
          description: 'Export query results to various formats (CSV, JSON, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              query: {
                type: 'string',
                description: 'The SQL query to execute for export (SELECT only)',
              },
              format: {
                type: 'string',
                enum: ['csv', 'json'],
                description: 'Export format (csv or json)',
                default: 'csv',
              },
              includeHeaders: {
                type: 'boolean',
                description: 'Include column headers in export',
                default: true,
              },
              maxRows: {
                type: 'number',
                description: 'Maximum number of rows to export',
                default: 10000,
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        {
          name: 'test_connection',
          description: 'Test connectivity to a database connection',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection to test',
              },
            },
            required: ['connectionId'],
          },
        },
        {
          name: 'get_database_stats',
          description: 'Get statistics and information about a database',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
            },
            required: ['connectionId'],
          },
        },
        {
          name: 'list_tables',
          description: 'List all tables in a database',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              schema: {
                type: 'string',
                description: 'Specific schema to list tables from (optional)',
              },
              includeViews: {
                type: 'boolean',
                description: 'Include views in the results',
                default: false,
              },
            },
            required: ['connectionId'],
          },
        },
        {
          name: 'append_insight',
          description: 'Add a business insight or analysis note to the memo',
          inputSchema: {
            type: 'object',
            properties: {
              insight: {
                type: 'string',
                description: 'The business insight or analysis note to store',
              },
              connection: {
                type: 'string',
                description: 'Optional connection ID to associate with this insight',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags to categorize the insight',
              },
            },
            required: ['insight'],
          },
        },
        {
          name: 'list_insights',
          description: 'List all stored business insights and analysis notes',
          inputSchema: {
            type: 'object',
            properties: {
              connection: {
                type: 'string',
                description: 'Filter insights by connection ID (optional)',
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter insights by tags (optional)',
              },
            },
          },
        },
        // Transaction tools
        {
          name: 'begin_transaction',
          description: 'Start a new database transaction',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
            },
            required: ['connectionId'],
          },
        },
        {
          name: 'commit_transaction',
          description: 'Commit an active transaction',
          inputSchema: {
            type: 'object',
            properties: {
              transactionId: {
                type: 'string',
                description: 'The transaction ID returned by begin_transaction',
              },
            },
            required: ['transactionId'],
          },
        },
        {
          name: 'rollback_transaction',
          description: 'Rollback an active transaction',
          inputSchema: {
            type: 'object',
            properties: {
              transactionId: {
                type: 'string',
                description: 'The transaction ID returned by begin_transaction',
              },
            },
            required: ['transactionId'],
          },
        },
        {
          name: 'execute_in_transaction',
          description: 'Execute a query within an active transaction',
          inputSchema: {
            type: 'object',
            properties: {
              transactionId: {
                type: 'string',
                description: 'The transaction ID returned by begin_transaction',
              },
              query: {
                type: 'string',
                description: 'The SQL query to execute',
              },
            },
            required: ['transactionId', 'query'],
          },
        },
        // Query analysis tools
        {
          name: 'explain_query',
          description: 'Get the execution plan for a SQL query',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
              query: {
                type: 'string',
                description: 'The SQL query to analyze',
              },
              analyze: {
                type: 'boolean',
                description: 'Run EXPLAIN ANALYZE for actual execution stats',
                default: false,
              },
              format: {
                type: 'string',
                enum: ['text', 'json'],
                description: 'Output format for the execution plan',
                default: 'text',
              },
            },
            required: ['connectionId', 'query'],
          },
        },
        // Schema comparison tools
        {
          name: 'compare_schemas',
          description: 'Compare schemas between two database connections',
          inputSchema: {
            type: 'object',
            properties: {
              sourceConnectionId: {
                type: 'string',
                description: 'The source connection ID to compare from',
              },
              targetConnectionId: {
                type: 'string',
                description: 'The target connection ID to compare to',
              },
              includeMigrationScript: {
                type: 'boolean',
                description: 'Generate SQL migration script',
                default: false,
              },
            },
            required: ['sourceConnectionId', 'targetConnectionId'],
          },
        },
        // Pool management tools
        {
          name: 'get_pool_stats',
          description: 'Get connection pool statistics for a connection',
          inputSchema: {
            type: 'object',
            properties: {
              connectionId: {
                type: 'string',
                description: 'The ID or name of the database connection',
              },
            },
            required: ['connectionId'],
          },
        },
      ];

      // Filter tools based on read-only mode and disabled tools
      let filteredTools = tools;

      // Remove write tools if read-only mode is enabled
      if (this.readOnly) {
        filteredTools = filteredTools.filter((tool) => !WRITE_TOOLS.includes(tool.name));
      }

      // Remove explicitly disabled tools
      if (this.disabledTools.length > 0) {
        filteredTools = filteredTools.filter((tool) => !this.disabledTools.includes(tool.name));
      }

      return { tools: filteredTools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Block write tools if read-only mode is enabled
      if (this.readOnly && WRITE_TOOLS.includes(name)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool '${name}' is disabled in read-only mode. Set OMNISQL_READ_ONLY=false to enable write operations.`
        );
      }

      // Block explicitly disabled tools
      if (this.disabledTools.includes(name)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool '${name}' is disabled via OMNISQL_DISABLED_TOOLS configuration.`
        );
      }

      try {
        this.log(
          `Executing tool: ${name} with args: ${JSON.stringify(redactArgs(args || {}))}`,
          'debug'
        );

        switch (name) {
          case 'list_connections':
            return await this.handleListConnections(args as { includeDetails?: boolean });

          case 'get_connection_info':
            return await this.handleGetConnectionInfo(args as { connectionId: string });

          case 'execute_query':
            return await this.handleExecuteQuery(
              args as {
                connectionId: string;
                query: string;
                maxRows?: number;
              }
            );

          case 'write_query':
            return await this.handleWriteQuery(
              args as {
                connectionId: string;
                query: string;
              }
            );

          case 'create_table':
            return await this.handleCreateTable(
              args as {
                connectionId: string;
                query: string;
              }
            );

          case 'alter_table':
            return await this.handleAlterTable(
              args as {
                connectionId: string;
                query: string;
              }
            );

          case 'drop_table':
            return await this.handleDropTable(
              args as {
                connectionId: string;
                tableName: string;
                confirm: boolean;
              }
            );

          case 'get_table_schema':
            return await this.handleGetTableSchema(
              args as {
                connectionId: string;
                tableName: string;
                includeIndexes?: boolean;
              }
            );

          case 'export_data':
            return await this.handleExportData(
              args as {
                connectionId: string;
                query: string;
                format?: string;
                includeHeaders?: boolean;
                maxRows?: number;
              }
            );

          case 'test_connection':
            return await this.handleTestConnection(args as { connectionId: string });

          case 'get_database_stats':
            return await this.handleGetDatabaseStats(args as { connectionId: string });

          case 'list_tables':
            return await this.handleListTables(
              args as {
                connectionId: string;
                schema?: string;
                includeViews?: boolean;
              }
            );

          case 'append_insight':
            return await this.handleAppendInsight(
              args as {
                insight: string;
                connection?: string;
                tags?: string[];
              }
            );

          case 'list_insights':
            return await this.handleListInsights(
              args as {
                connection?: string;
                tags?: string[];
              }
            );

          // Transaction tools
          case 'begin_transaction':
            return await this.handleBeginTransaction(args as { connectionId: string });

          case 'commit_transaction':
            return await this.handleCommitTransaction(args as { transactionId: string });

          case 'rollback_transaction':
            return await this.handleRollbackTransaction(args as { transactionId: string });

          case 'execute_in_transaction':
            return await this.handleExecuteInTransaction(
              args as { transactionId: string; query: string }
            );

          // Query analysis tools
          case 'explain_query':
            return await this.handleExplainQuery(
              args as {
                connectionId: string;
                query: string;
                analyze?: boolean;
                format?: 'text' | 'json';
              }
            );

          // Schema comparison tools
          case 'compare_schemas':
            return await this.handleCompareSchemas(
              args as {
                sourceConnectionId: string;
                targetConnectionId: string;
                includeMigrationScript?: boolean;
              }
            );

          // Pool management tools
          case 'get_pool_stats':
            return await this.handleGetPoolStats(args as { connectionId: string });

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        this.log(`Tool execution failed: ${error}`, 'error');

        if (error instanceof McpError) {
          throw error;
        }

        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${formatError(error)}`);
      }
    });
  }

  private async handleListConnections(args: { includeDetails?: boolean }) {
    const connections = await this.getFilteredConnections();

    if (args.includeDetails) {
      // Always redact credentials before returning to client
      const redacted = connections.map((conn) => redactConnection(conn));
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(redacted, null, 2),
          },
        ],
      };
    }

    const simplified = connections.map((conn) => ({
      id: conn.id,
      name: conn.name,
      driver: conn.driver,
      host: conn.host,
      database: conn.database,
      folder: conn.folder,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(simplified, null, 2),
        },
      ],
    };
  }

  private async handleGetConnectionInfo(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Redact credentials before returning to client
    const redacted = redactConnection(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(redacted, null, 2),
        },
      ],
    };
  }

  private async handleExecuteQuery(args: {
    connectionId: string;
    query: string;
    maxRows?: number;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();
    const requestedRows = args.maxRows || DEFAULT_QUERY_ROWS;
    const maxRows = Math.min(Math.max(1, requestedRows), MAX_QUERY_ROWS);

    // Validate query
    const validationError = validateQuery(query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    // execute_query is for read-only operations - enforce SELECT-only
    const readOnlyError = enforceReadOnly(query);
    if (readOnlyError) {
      throw new McpError(ErrorCode.InvalidParams, readOnlyError);
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Add LIMIT/TOP clause if not present and it's a SELECT query
    let finalQuery = query;
    const lowerQuery = query.toLowerCase().trimStart();

    if (lowerQuery.startsWith('select')) {
      const driver = connection.driver.toLowerCase();
      const isSqlServer =
        driver.includes('mssql') || driver.includes('sqlserver') || driver.includes('microsoft');

      if (isSqlServer) {
        if (
          !lowerQuery.includes('top ') &&
          !lowerQuery.includes('offset ') &&
          !lowerQuery.includes('fetch next')
        ) {
          // Simple injection of TOP for SQL Server
          finalQuery = query.replace(/^select/i, `SELECT TOP ${maxRows}`);
        }
      } else {
        if (!lowerQuery.includes('limit')) {
          // Strip trailing semicolons so we don't produce invalid SQL like `SELECT 1; LIMIT 10`
          const withoutTrailingSemicolon = query.replace(/;+\s*$/g, '');
          finalQuery = `${withoutTrailingSemicolon} LIMIT ${maxRows}`;
        }
      }
    }

    const result = await this.workspaceClient.executeQuery(connection, finalQuery);

    const response = {
      query: finalQuery,
      connection: connection.name,
      executionTime: result.executionTime,
      rowCount: result.rowCount,
      columns: result.columns,
      rows: result.rows,
      truncated: result.rows.length >= maxRows,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleWriteQuery(args: { connectionId: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    // Validate query type
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.startsWith('select')) {
      throw new McpError(ErrorCode.InvalidParams, 'Use execute_query for SELECT operations');
    }

    if (
      !(
        lowerQuery.startsWith('insert') ||
        lowerQuery.startsWith('update') ||
        lowerQuery.startsWith('delete')
      )
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Only INSERT, UPDATE, or DELETE operations are allowed with write_query'
      );
    }

    // Additional validation
    const validationError = validateQuery(query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const result = await this.workspaceClient.executeQuery(connection, query);

    const response = {
      query: query,
      connection: connection.name,
      executionTime: result.executionTime,
      affectedRows: result.rowCount,
      success: true,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  private async handleCreateTable(args: { connectionId: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    if (!query.toLowerCase().startsWith('create table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only CREATE TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const result = await this.workspaceClient.executeQuery(connection, query);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Table created successfully',
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleAlterTable(args: { connectionId: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    if (!query.toLowerCase().startsWith('alter table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only ALTER TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const result = await this.workspaceClient.executeQuery(connection, query);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Table altered successfully',
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleDropTable(args: {
    connectionId: string;
    tableName: string;
    confirm: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const tableName = args.tableName;

    if (!tableName) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    if (!args.confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                success: false,
                message:
                  'Safety confirmation required. Set confirm=true to proceed with dropping the table.',
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Check if table exists first
    try {
      await this.workspaceClient.getTableSchema(connection, tableName);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Table '${tableName}' does not exist or cannot be accessed`
      );
    }

    const dropQuery = `DROP TABLE "${tableName}"`;
    const result = await this.workspaceClient.executeQuery(connection, dropQuery);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: `Table '${tableName}' dropped successfully`,
              executionTime: result.executionTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleGetTableSchema(args: {
    connectionId: string;
    tableName: string;
    includeIndexes?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const schema = await this.workspaceClient.getTableSchema(connection, args.tableName);

    if (!args.includeIndexes) {
      (schema as any).indexes = undefined;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  }

  private async handleExportData(args: {
    connectionId: string;
    query: string;
    format?: string;
    includeHeaders?: boolean;
    maxRows?: number;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    // Validate query - only SELECT queries for export
    if (!query.toLowerCase().trimStart().startsWith('select')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only SELECT queries are allowed for export');
    }

    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const requestedRows = args.maxRows || DEFAULT_EXPORT_ROWS;
    const maxRows = Math.min(Math.max(1, requestedRows), MAX_EXPORT_ROWS);
    const format = args.format || 'csv';

    // Add LIMIT clause if not present
    let finalQuery = query;
    if (!query.toLowerCase().includes('limit')) {
      finalQuery = `${query} LIMIT ${maxRows}`;
    }

    const result = await this.workspaceClient.executeQuery(connection, finalQuery);

    if (format === 'csv') {
      const csvData = convertToCSV(result.columns, result.rows);
      return {
        content: [
          {
            type: 'text' as const,
            text: csvData,
          },
        ],
      };
    } else if (format === 'json') {
      const jsonData = result.rows.map((row) => {
        const obj: any = {};
        result.columns.forEach((col, idx) => {
          obj[col] = row[idx];
        });
        return obj;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(jsonData, null, 2),
          },
        ],
      };
    } else {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unsupported export format: ${format}. Use 'csv' or 'json'`
      );
    }
  }

  private async handleTestConnection(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const testResult = await this.workspaceClient.testConnection(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(testResult, null, 2),
        },
      ],
    };
  }

  private async handleGetDatabaseStats(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const stats = await this.workspaceClient.getDatabaseStats(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  private async handleListTables(args: {
    connectionId: string;
    schema?: string;
    includeViews?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const tables = await this.workspaceClient.listTables(
      connection,
      args.schema,
      args.includeViews || false
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(tables, null, 2),
        },
      ],
    };
  }

  private async handleAppendInsight(args: {
    insight: string;
    connection?: string;
    tags?: string[];
  }) {
    if (!args.insight || args.insight.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Insight text is required');
    }

    const newInsight: BusinessInsight = {
      id: Date.now(),
      insight: args.insight.trim(),
      created_at: new Date().toISOString(),
      connection: args.connection,
      tags: args.tags || [],
    };

    this.insights.push(newInsight);
    this.saveInsights();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              message: 'Insight added successfully',
              id: newInsight.id,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleListInsights(args: { connection?: string; tags?: string[] }) {
    let filteredInsights = [...this.insights];

    if (args.connection) {
      filteredInsights = filteredInsights.filter(
        (insight) => insight.connection === args.connection
      );
    }

    if (args.tags && args.tags.length > 0) {
      filteredInsights = filteredInsights.filter(
        (insight) => insight.tags && args.tags!.some((tag) => insight.tags!.includes(tag))
      );
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(filteredInsights, null, 2),
        },
      ],
    };
  }

  // Transaction handlers
  private async handleBeginTransaction(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const result = await this.transactionManager.beginTransaction(connection);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleCommitTransaction(args: { transactionId: string }) {
    const result = await this.transactionManager.commitTransaction(args.transactionId);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleRollbackTransaction(args: { transactionId: string }) {
    const result = await this.transactionManager.rollbackTransaction(args.transactionId);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleExecuteInTransaction(args: { transactionId: string; query: string }) {
    const validationError = validateQuery(args.query);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    const result = await this.transactionManager.executeInTransaction(
      args.transactionId,
      args.query
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  // Query analysis handlers
  private async handleExplainQuery(args: {
    connectionId: string;
    query: string;
    analyze?: boolean;
    format?: 'text' | 'json';
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const format = args.format || 'text';
    const explainQuery = buildExplainQuery(
      connection.driver,
      args.query,
      args.analyze || false,
      format
    );

    const result = await this.workspaceClient.executeQuery(connection, explainQuery);
    const explainResult = parseExplainOutput(connection.driver, result.rows, args.query, format);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(explainResult, null, 2),
        },
      ],
    };
  }

  // Schema comparison handlers
  private async handleCompareSchemas(args: {
    sourceConnectionId: string;
    targetConnectionId: string;
    includeMigrationScript?: boolean;
  }) {
    const sourceConnId = sanitizeConnectionId(args.sourceConnectionId);
    const targetConnId = sanitizeConnectionId(args.targetConnectionId);

    const sourceConn = await this.getConnection(sourceConnId);
    const targetConn = await this.getConnection(targetConnId);

    if (!sourceConn) {
      throw new McpError(ErrorCode.InvalidParams, `Source connection not found: ${sourceConnId}`);
    }
    if (!targetConn) {
      throw new McpError(ErrorCode.InvalidParams, `Target connection not found: ${targetConnId}`);
    }

    // Get tables from both connections
    const sourceTables = await this.workspaceClient.listTables(sourceConn);
    const targetTables = await this.workspaceClient.listTables(targetConn);

    // Get schema for each table and convert to comparable format
    const sourceSchemas = await Promise.all(
      sourceTables.map(async (table) => {
        const schema = await this.workspaceClient.getTableSchema(sourceConn, table.name);
        // Convert SchemaInfo columns to the format expected by parseTableSchema
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

    const targetSchemas = await Promise.all(
      targetTables.map(async (table) => {
        const schema = await this.workspaceClient.getTableSchema(targetConn, table.name);
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

    const diff = await compareSchemas(sourceSchemas, targetSchemas, sourceConnId, targetConnId);

    const response: { diff: SchemaDiff; migrationScript?: string } = { diff };

    if (args.includeMigrationScript) {
      response.migrationScript = generateMigrationScript(diff, targetConn.driver);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  // Pool management handlers
  private async handleGetPoolStats(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Initialize pool if needed
    await this.poolManager.getPool(connection);
    const stats = await this.poolManager.getStats(connectionId);

    if (!stats) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              connectionId,
              message: 'No pool available for this connection type',
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        },
      ],
    };
  }

  async run() {
    try {
      // Validate DB client workspace
      if (!this.configParser.isWorkspaceValid()) {
        this.log(
          'Workspace not found. Please run your DB client at least once to create the workspace.',
          'error'
        );
        this.log(
          'The server will start but will not be able to access any database connections.',
          'error'
        );
      }

      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      this.log('OmniSQL MCP server started successfully');

      // Periodic cleanup of stale transactions (leaked transactions older than 1 hour)
      this.staleCleanupInterval = setInterval(async () => {
        try {
          const cleaned = await this.transactionManager.cleanupStaleTransactions();
          if (cleaned > 0) {
            this.log(`Cleaned up ${cleaned} stale transaction(s)`);
          }
        } catch (error) {
          this.log(`Stale transaction cleanup error: ${formatError(error)}`, 'debug');
        }
      }, STALE_TRANSACTION_CHECK_MS);
      this.staleCleanupInterval.unref(); // Don't prevent process exit

      if (this.readOnly) {
        this.log('Read-only mode enabled: write operations are disabled');
      }
      if (this.allowedConnections) {
        this.log(`Connection whitelist active: ${Array.from(this.allowedConnections).join(', ')}`);
      }

      if (this.debug) {
        const debugInfo = this.configParser.getDebugInfo();
        this.log(`Debug info: ${JSON.stringify(debugInfo, null, 2)}`, 'debug');
      }
    } catch (error) {
      this.log(`Failed to start server: ${formatError(error)}`, 'error');
      process.exit(1);
    }
  }
}

// Handle CLI arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`
OmniSQL MCP Server v${VERSION}

Usage: omnisql-mcp [options]

Options:
  -h, --help     Show this help message
  --version      Show version information
  --debug        Enable debug logging

Environment Variables:
  OMNISQL_CLI_PATH             Path to local DB client CLI executable (for unsupported-driver fallback)
  OMNISQL_WORKSPACE            Path to local DB client workspace directory
  OMNISQL_TIMEOUT              Query timeout in milliseconds (default: 30000)
  OMNISQL_DEBUG                Enable debug logging (true/false)
  OMNISQL_READ_ONLY            Disable all write operations (true/false)
  OMNISQL_ALLOWED_CONNECTIONS  Comma-separated whitelist of connection IDs or names
  OMNISQL_DISABLED_TOOLS       Comma-separated list of tools to disable

Features:
  - Universal database support via your local DB client's saved connections
  - Read and write operations with safety checks
  - Schema introspection and table management
  - Data export in multiple formats
  - Business insights tracking
  - Resource-based schema browsing

For more information, visit: https://github.com/srthkdev/omnisql-mcp
`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.error(VERSION);
  process.exit(0);
}

// Start the server
const server = new OmniSQLMCPServer();
server.run().catch((error) => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
