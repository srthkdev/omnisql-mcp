import {
  compressText,
  compressionExtension,
  type ExportCompression,
} from './runtime/compression.js';
import { PrivateNotes } from './runtime/notes.js';
import { ResultArtifacts, type ArtifactSource, type ArtifactScope } from './runtime/artifacts.js';
import { connectionFingerprint } from './runtime/connection-identity.js';
import { AccessPolicy } from './policy/access.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { booleanSetting, integerSetting } from './runtime-config.js';
import { validateToolArguments } from './policy/arguments.js';
import { validateStatement } from './policy/sql.js';
import { checkForUpdate } from './update-check.js';
import { WorkspaceConfigParser } from './config-parser.js';
import { WorkspaceClient } from './workspace-client.js';
import type { BusinessInsight, DatabaseConnection, SchemaDiff, QueryResult } from './types.js';
import {
  validateQuery,
  enforceReadOnly,
  sanitizeConnectionId,
  parseConnectionId,
  formatError,
  convertToCSV,
  redactConnection,
  redactArgs,
} from './utils.js';
import { ConnectionPoolManager } from './pools/index.js';
import { sshTunnelManager } from './net/ssh-tunnel.js';
import { TransactionManager } from './managers/index.js';
import { buildExplainQuery, parseExplainOutput } from './utils/query-analyzer.js';
import { compareSchemas, comparableSchema, generateMigrationScript } from './utils/schema-diff.js';
import fs from 'fs';
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

const DATABASE_TOOLS = new Set([
  'write_query',
  'create_table',
  'alter_table',
  'drop_table',
  'begin_transaction',
  'execute_query',
  'export_data',
  'explain_query',
  'list_tables',
  'get_table_schema',
  'get_database_stats',
  'get_table_stats',
  'test_connection',
  'get_pool_stats',
]);

// Limits
const MAX_INSIGHTS = 1000;
const STALE_TRANSACTION_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const MAX_QUERY_ROWS = 100000;
const MAX_EXPORT_ROWS = 1000000;
const DEFAULT_QUERY_ROWS = 1000;
const DEFAULT_EXPORT_ROWS = 10000;

export class OmniSQLMCPServer {
  private artifacts = new ResultArtifacts();
  private accessPolicy = new AccessPolicy();
  private server: Server;
  private configParser: WorkspaceConfigParser;
  private workspaceClient: WorkspaceClient;
  private poolManager: ConnectionPoolManager;
  private transactionManager: TransactionManager;
  private debug: boolean;
  private insights: BusinessInsight[] = [];
  private notes: PrivateNotes;
  private notesScope: string;
  private readOnly: boolean;
  private disabledTools: string[];
  private allowedConnections: Set<string> | null; // null = allow all
  private staleCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.debug = process.env.OMNISQL_DEBUG === 'true';
    this.readOnly = booleanSetting(process.env.OMNISQL_READ_ONLY, 'OMNISQL_READ_ONLY');
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

    this.notesScope = this.currentNotesScope();
    this.notes = new PrivateNotes(this.notesScope);

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
      timeout: integerSetting(process.env.OMNISQL_TIMEOUT, 'OMNISQL_TIMEOUT', 30000),
      executablePath: process.env.OMNISQL_CLI_PATH,
      workspacePath: process.env.OMNISQL_WORKSPACE,
      projectName: process.env.OMNISQL_PROJECT,
    });

    // Initialize connection pool and transaction manager
    sshTunnelManager.setDebug(this.debug);

    this.poolManager = new ConnectionPoolManager(
      {
        min: integerSetting(process.env.OMNISQL_POOL_MIN, 'OMNISQL_POOL_MIN', 0, 0, 32),
        max: integerSetting(process.env.OMNISQL_POOL_MAX, 'OMNISQL_POOL_MAX', 4, 1, 32),
        idleTimeoutMs: integerSetting(
          process.env.OMNISQL_POOL_IDLE_TIMEOUT,
          'OMNISQL_POOL_IDLE_TIMEOUT',
          30000,
          1,
          300000
        ),
        acquireTimeoutMs: integerSetting(
          process.env.OMNISQL_POOL_ACQUIRE_TIMEOUT,
          'OMNISQL_POOL_ACQUIRE_TIMEOUT',
          10000,
          1,
          300000
        ),
      },
      this.debug,
      integerSetting(process.env.OMNISQL_TIMEOUT, 'OMNISQL_TIMEOUT', 30000)
    );
    this.workspaceClient = new WorkspaceClient(
      process.env.OMNISQL_CLI_PATH,
      integerSetting(process.env.OMNISQL_TIMEOUT, 'OMNISQL_TIMEOUT', 30000),
      this.debug,
      process.env.OMNISQL_WORKSPACE || this.configParser.getWorkspacePath(),
      this.poolManager
    );

    this.transactionManager = new TransactionManager(
      this.poolManager,
      this.debug,
      (id) => this.getConnection(id),
      integerSetting(process.env.OMNISQL_TIMEOUT, 'OMNISQL_TIMEOUT', 30000)
    );

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

  private currentNotesScope(): string {
    const policySource = [process.env.OMNISQL_CONFIG_FILE, process.env.OMNISQL_POLICY_FILE]
      .filter(Boolean)
      .map((file) => fs.readFileSync(file!, 'utf8'));
    return JSON.stringify([
      process.env.OMNISQL_WORKSPACE ?? '',
      process.env.OMNISQL_PROJECT ?? '',
      process.env.OMNISQL_ALLOWED_CONNECTIONS ?? '',
      process.env.OMNISQL_READ_ONLY ?? '',
      policySource,
    ]);
  }
  private refreshNotes() {
    const scope = this.currentNotesScope();
    if (scope !== this.notesScope) {
      this.notesScope = scope;
      this.notes = new PrivateNotes(scope);
      this.insights = this.notes.load();
    }
  }
  private loadInsights() {
    try {
      this.insights = this.notes.load();
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
      this.insights = this.notes.save(this.insights);
    } catch (error) {
      this.log(`Failed to save insights: ${error}`, 'error');
    }
  }

  /**
   * Check if a connection is allowed by the whitelist.
   * Matches against both connection ID and name.
   *
   * A database-override lookup ("<id>/<database>") produces a synthetic id, so
   * match on the base id too - otherwise every override would be rejected as
   * an unknown connection whenever a whitelist is configured. Whitelisting a
   * connection therefore grants the databases reachable with its credentials,
   * not just its default one; list explicit "<id>/<database>" entries to pin it.
   */
  private isConnectionAllowed(conn: { id: string; name: string }): boolean {
    if (!this.allowedConnections) return true; // No whitelist = allow all
    if (this.allowedConnections.has(conn.id) || this.allowedConnections.has(conn.name)) {
      return true;
    }

    const { baseId, databaseOverride } = parseConnectionId(conn.id);
    if (databaseOverride === null) return false;

    // The exact "<id>/<database>" entry was already checked above, so listing
    // only pinned entries for a connection - and no bare one - denies every
    // other database on it, which is what writing them that way asks for.
    return this.allowedConnections.has(baseId);
  }

  /**
   * Get all connections, filtered by the whitelist.
   */
  private async getFilteredConnections(): Promise<DatabaseConnection[]> {
    const connections = await this.configParser.parseConnections();
    if (!this.allowedConnections)
      return connections.filter((c) => this.accessPolicy.allowsDatabase(c));
    return connections.filter(
      (conn) => this.isConnectionAllowed(conn) && this.accessPolicy.allowsDatabase(conn)
    );
  }

  /**
   * Get a single connection by ID/name, respecting the whitelist.
   */
  private async getConnection(
    connectionId: string,
    database?: string
  ): Promise<DatabaseConnection | null> {
    const connection = await this.configParser.getConnection(connectionId, database);
    if (!connection) return null;
    if (!this.isConnectionAllowed(connection)) return null;
    this.accessPolicy.assertConnection(connection);
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
      await this.artifacts.close();
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
      try {
        // After the pools, so nothing is still using a forward when it closes.
        await sshTunnelManager.closeAll();
      } catch (error) {
        this.log(`Error closing SSH tunnels during shutdown: ${formatError(error)}`, 'error');
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
        if (
          this.disabledTools.includes('list_connections') ||
          this.disabledTools.includes('list_tables')
        )
          return { resources: [] };
        const connections = await this.getFilteredConnections();
        const resources = connections.map((connection) => ({
          uri: `omnisql:///connections/${encodeURIComponent(connection.id)}`,
          mimeType: 'application/json',
          name: connection.name,
          description: `${connection.driver} connection; browse tables on demand`,
        }));

        return { resources };
      } catch (error) {
        this.log(`Failed to list resources: ${error}`, 'error');
        return { resources: [] };
      }
    });

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: this.disabledTools.includes('get_table_schema')
        ? []
        : [
            {
              uriTemplate: 'omnisql:///connections/{connectionId}/tables/{tableName}/schema',
              name: 'Table schema',
              mimeType: 'application/json',
              description: 'Read a table schema after choosing a connection and an allowed table',
            },
          ],
    }));

    // Get schema information for a specific table
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        const uri = new URL(request.params.uri);
        if (uri.protocol !== 'omnisql:') throw new Error('Invalid resource URI');
        const parts = uri.pathname
          .split('/')
          .filter(Boolean)
          .map((p) => decodeURIComponent(p));
        if (
          parts[0] === 'connections' &&
          (parts.length === 2 || (parts.length === 3 && parts[2] === 'tables'))
        ) {
          const connection = await this.getConnection(parts[1]);
          if (!connection) throw new Error('Connection not found');
          if (parts.length === 2) {
            if (this.disabledTools.includes('get_connection_info'))
              throw new Error('Connection detail access is disabled');
            return {
              contents: [
                {
                  uri: request.params.uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({
                    ...redactConnection(connection),
                    tablesUri: `omnisql:///connections/${encodeURIComponent(connection.id)}/tables`,
                  }),
                },
              ],
            };
          }
          if (this.disabledTools.includes('list_tables'))
            throw new Error('Table listing is disabled');
          const source = this.catalogSource(connection);
          const tables = await this.workspaceClient.listTables(connection, undefined, true);
          const result = tables.map((t) => ({
            ...t,
            schemaUri: `omnisql:///connections/${encodeURIComponent(connection.id)}/tables/${encodeURIComponent([t.table_schema, t.name].filter(Boolean).join('.'))}/schema`,
          }));
          const document = await this.presentDocument(result, source);
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'application/json',
                text: document.content[0].text,
              },
            ],
          };
        }
        if (this.disabledTools.includes('get_table_schema'))
          throw new Error('Schema access is disabled');
        const modern =
          parts.length === 5 &&
          parts[0] === 'connections' &&
          parts[2] === 'tables' &&
          parts[4] === 'schema';
        const legacy = !!uri.hostname && parts.length === 2 && parts[1] === 'schema';
        if (!modern && !legacy) throw new Error('Invalid resource URI format');
        const connectionId = modern ? parts[1] : decodeURIComponent(uri.hostname);
        const tableName = modern ? parts[3] : parts[0];

        const connection = await this.getConnection(connectionId);
        if (!connection) {
          throw new Error(`Connection not found: ${connectionId}`);
        }

        const source = this.catalogSource(connection);
        const schema = await this.workspaceClient.getTableSchema(connection, tableName);
        const document = await this.presentDocument(schema, source);

        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: document.content[0].text,
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
        description: 'Execute INSERT, UPDATE, or DELETE queries on a specific database connection',
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
            compression: {
              type: 'string',
              enum: ['none', 'gzip', 'brotli', 'zstd'],
              default: 'none',
              description:
                'Optional download compression. Compressed exports return a read_export handle; concatenate decoded base64 chunks, then decompress.',
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
              description: 'Include a commented migration review outline; never executed',
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

    tools.push({
      name: 'list_databases',
      description:
        'List databases accessible through a saved PostgreSQL, MySQL/MariaDB, SQL Server, or ClickHouse connection',
      inputSchema: {
        type: 'object',
        properties: {
          connectionId: { type: 'string', description: 'Saved connection ID or name' },
        },
        required: ['connectionId'],
      },
    });
    tools.push({
      name: 'get_table_stats',
      description:
        'Get catalog row estimates and data/index storage without scanning the table; unavailable values are null',
      inputSchema: {
        type: 'object',
        properties: { connectionId: { type: 'string' }, tableName: { type: 'string' } },
        required: ['connectionId', 'tableName'],
      },
    });
    for (const name of ['read_result', 'read_result_cell', 'read_export']) {
      const properties: Record<string, any> = {
        resultId: { type: 'string', minLength: 32, maxLength: 32 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      };
      if (name === 'read_result') {
        properties.columnOffset = { type: 'integer', minimum: 0 };
        properties.columnLimit = { type: 'integer', minimum: 1, maximum: 100 };
      }
      if (name === 'read_result_cell') {
        properties.row = { type: 'integer', minimum: 0 };
        properties.column = { type: 'integer', minimum: 0 };
        delete properties.limit;
        properties.length = { type: 'integer', minimum: 1, maximum: 16000 };
      }
      if (name === 'read_export') {
        delete properties.limit;
        properties.length = { type: 'integer', minimum: 1, maximum: 48000 };
      }
      tools.push({
        name,
        description:
          name === 'read_result'
            ? 'Read a bounded page from a stored query result; follow nextOffset'
            : name === 'read_result_cell'
              ? 'Read a long cell in UTF-16 chunks; follow nextOffset. Concatenate text; parse JSON when encoding is json'
              : 'Read a stored export in base64 byte chunks; concatenate decoded bytes',
        inputSchema: {
          type: 'object',
          properties,
          required: name === 'read_result_cell' ? ['resultId', 'row', 'column'] : ['resultId'],
        },
      });
    }
    for (const tool of tools) {
      if (['append_insight', 'list_insights'].includes(tool.name)) {
        const props = tool.inputSchema.properties as Record<string, any>;
        if (props.insight) props.insight.maxLength = 16384;
        if (props.tags) props.tags.items.maxLength = 128;
      }
      tool.inputSchema.additionalProperties = false;
      const properties = tool.inputSchema.properties as Record<string, any>;
      if (properties?.maxRows) {
        properties.maxRows.type = 'integer';
        properties.maxRows.minimum = 1;
      }
      tool.annotations = {
        readOnlyHint: !WRITE_TOOLS.includes(tool.name) && tool.name !== 'append_insight',
        destructiveHint: WRITE_TOOLS.includes(tool.name),
        openWorldHint: true,
      };
      if (DATABASE_TOOLS.has(tool.name)) {
        tool.inputSchema.properties = {
          ...tool.inputSchema.properties,
          database: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description:
              'Optional database on the same server; reuses saved credentials and settings',
          },
        };
      }
    }

    for (const name of this.disabledTools) {
      if (!tools.some((tool) => tool.name === name))
        throw new Error(`Unknown disabled tool: ${name}`);
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
      const { name } = request.params;
      const definition = tools.find((tool) => tool.name === name);
      if (!definition) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      let args: Record<string, unknown>;
      try {
        args = validateToolArguments(definition, request.params.arguments);
      } catch (error) {
        throw new McpError(ErrorCode.InvalidParams, formatError(error));
      }

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
          case 'list_databases':
            return await this.handleListDatabases(args as { connectionId: string });

          case 'get_table_stats': {
            const connection = await this.getConnection(
              args.connectionId as string,
              args.database as string | undefined
            );
            if (!connection) throw new Error('Connection not found');
            const source = this.catalogSource(connection);
            const result = await this.workspaceClient.getTableStats(
              connection,
              args.tableName as string
            );
            return this.presentDocument(result, source);
          }
          case 'read_result':
          case 'read_result_cell':
          case 'read_export': {
            const source = this.artifacts.source(args.resultId as string);
            const connections = await this.resultConnections(source);
            for (const [i, connection] of connections.entries()) {
              const access = source.scopes[i].access;
              if (access.kind === 'sql')
                await this.workspaceClient.assertQueryAccess(connection, access.query, false);
            }
            const result =
              name === 'read_result'
                ? await this.artifacts.page(
                    args.resultId as string,
                    args.offset as number | undefined,
                    args.limit as number | undefined,
                    args.columnOffset as number | undefined,
                    args.columnLimit as number | undefined
                  )
                : name === 'read_result_cell'
                  ? await this.artifacts.cell(
                      args.resultId as string,
                      args.row as number,
                      args.column as number,
                      args.offset as number | undefined,
                      args.length as number | undefined
                    )
                  : await this.artifacts.readExport(
                      args.resultId as string,
                      args.offset as number | undefined,
                      args.length as number | undefined
                    );
            await this.resultConnections(source);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          }
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

  private async handleListDatabases(args: { connectionId: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }
    const source = this.catalogSource(connection);
    const databases = await this.workspaceClient.listDatabases(connection);
    return this.presentDocument(databases, source);
  }

  private async handleListConnections(args: { includeDetails?: boolean }) {
    const connections = await this.getFilteredConnections();

    if (args.includeDetails) {
      // Always redact credentials before returning to client
      const redacted = connections.map((conn) => ({
        ...redactConnection(conn),
        readonly: this.readOnly || this.accessPolicy.isReadOnly(conn),
        limits: conn.limits,
        capabilities: this.workspaceClient.getCapabilities(conn),
      }));
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
      // Only interesting when the configured id needed resolving to a dialect,
      // as custom drivers with an opaque id do.
      ...(conn.driverId && conn.driverId !== conn.driver
        ? { driverId: conn.driverId, provider: conn.provider }
        : {}),
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
    const redacted = {
      ...redactConnection(connection),
      readonly: this.readOnly || this.accessPolicy.isReadOnly(connection),
      limits: connection.limits,
      capabilities: this.workspaceClient.getCapabilities(connection),
    };

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
    database?: string;
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

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.artifactSource(connection, query);
    const result = await this.workspaceClient.executeQuery(connection, query, {
      maxRows,
      readOnly: true,
    });

    return this.presentResult(result, source, { query, connection: connection.name });
  }

  private artifactScope(
    connection: DatabaseConnection,
    access: ArtifactScope['access'],
    policyRevision = this.accessPolicy.revision()
  ): ArtifactScope {
    return {
      connectionId: connection.id,
      access,
      connectionFingerprint: connectionFingerprint(connection),
      policyRevision,
    };
  }
  private artifactSource(
    connection: DatabaseConnection,
    query: string,
    policyRevision?: string
  ): ArtifactSource {
    return { scopes: [this.artifactScope(connection, { kind: 'sql', query }, policyRevision)] };
  }
  private catalogSource(...connections: DatabaseConnection[]): ArtifactSource {
    return {
      scopes: connections.map((connection) => this.artifactScope(connection, { kind: 'catalog' })),
    };
  }
  private async resultConnections(source: ArtifactSource): Promise<DatabaseConnection[]> {
    const connections = [];
    for (const scope of source.scopes) {
      const connection = await this.getConnection(scope.connectionId, scope.database);
      if (!connection) throw new Error('Result connection is no longer accessible');
      if (
        connectionFingerprint(connection) !== scope.connectionFingerprint ||
        this.accessPolicy.revision() !== scope.policyRevision
      )
        throw new Error('Result connection or access policy changed; run the query again');
      connections.push(connection);
    }
    return connections;
  }
  private async presentDocument(value: object, source: ArtifactSource) {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(text);
    if (bytes <= 65536)
      return {
        content: [{ type: 'text' as const, text }],
        ...(!Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
      };
    if (bytes > 16 * 1024 * 1024)
      throw new Error(
        'Catalog document exceeds 16 MiB; narrow the request with schema or table policies'
      );
    if (this.disabledTools.includes('read_result_cell'))
      throw new Error(
        'Large catalog documents require read_result_cell; enable it or narrow the request'
      );
    const stored = await this.artifacts.save(
      { columns: ['document'], rows: [[value]], rowCount: 1, executionTime: 0 },
      source
    );
    const response = {
      kind: 'document',
      ...(await this.artifacts.page(stored.resultId, 0, 1)),
      readTool: 'read_result_cell',
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async presentResult(
    result: QueryResult,
    source: ArtifactSource,
    metadata: Record<string, unknown> = {}
  ) {
    let response: Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(result)) > 65536) {
      const stored = await this.artifacts.save(result, source);
      response = {
        ...metadata,
        executionTime: result.executionTime,
        ...(await this.artifacts.page(stored.resultId, 0, 25)),
      };
    } else response = { ...metadata, ...result, truncated: result.truncated === true };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      structuredContent: response,
    };
  }

  private async handleWriteQuery(args: { connectionId: string; database?: string; query: string }) {
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

    const connection = await this.getConnection(connectionId, args.database);
    if (connection && this.accessPolicy.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const result = await this.workspaceClient.executeQuery(connection, query);

    const response = {
      query: query,
      connection: connection.name,
      executionTime: result.executionTime,
      affectedRows: result.affectedRows === undefined ? result.rowCount : result.affectedRows,
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

  private async handleCreateTable(args: {
    connectionId: string;
    database?: string;
    query: string;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const statementError = validateStatement(query);
    if (statementError) throw new McpError(ErrorCode.InvalidParams, statementError);

    if (!query.toLowerCase().startsWith('create table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only CREATE TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (connection && this.accessPolicy.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');
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

  private async handleAlterTable(args: { connectionId: string; database?: string; query: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const statementError = validateStatement(query);
    if (statementError) throw new McpError(ErrorCode.InvalidParams, statementError);

    if (!query.toLowerCase().startsWith('alter table')) {
      throw new McpError(ErrorCode.InvalidParams, 'Only ALTER TABLE statements are allowed');
    }

    const connection = await this.getConnection(connectionId, args.database);
    if (connection && this.accessPolicy.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');
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
    database?: string;
    tableName: string;
    confirm: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const tableName = args.tableName;

    if (!tableName) {
      throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
    }

    if (args.confirm !== true) {
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

    const connection = await this.getConnection(connectionId, args.database);
    if (connection && this.accessPolicy.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');
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
    database?: string;
    tableName: string;
    includeIndexes?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const schema = await this.workspaceClient.getTableSchema(connection, args.tableName);

    if (args.includeIndexes === false) {
      (schema as any).indexes = undefined;
    }

    return this.presentDocument(schema, source);
  }

  private async handleExportData(args: {
    connectionId: string;
    database?: string;
    query: string;
    format?: string;
    compression?: ExportCompression;
    includeHeaders?: boolean;
    maxRows?: number;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const query = args.query.trim();

    const policyError = validateQuery(query) || enforceReadOnly(query);
    if (policyError) throw new McpError(ErrorCode.InvalidParams, policyError);

    const connection = await this.getConnection(connectionId, args.database);
    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const requestedRows = args.maxRows || DEFAULT_EXPORT_ROWS;
    const maxRows = Math.min(Math.max(1, requestedRows), MAX_EXPORT_ROWS);
    const format = args.format || 'csv';

    const source = this.artifactSource(connection, query);
    const result = await this.workspaceClient.executeQuery(connection, query, {
      maxRows,
      readOnly: true,
    });

    if (format !== 'csv' && format !== 'json')
      throw new McpError(ErrorCode.InvalidParams, 'Unsupported export format; use csv or json');
    const duplicateColumns = new Set(result.columns).size !== result.columns.length;
    const text =
      format === 'csv'
        ? convertToCSV(result.columns, result.rows, args.includeHeaders !== false)
        : JSON.stringify(
            duplicateColumns
              ? { columns: result.columns, rows: result.rows }
              : result.rows.map((row) =>
                  Object.fromEntries(result.columns.map((name, i) => [name, row[i]]))
                )
          );
    const compression = args.compression ?? 'none';
    const bytes = Buffer.byteLength(text);
    if (compression !== 'none' || bytes > 65536) {
      const data =
        compression === 'none'
          ? text
          : await compressText(text, compression, connection.limits?.timeoutMs);
      const stored = await this.artifacts.export(
        data,
        format + compressionExtension[compression],
        source
      );
      const response = {
        ...stored,
        compression,
        uncompressedBytes: bytes,
        truncated: result.truncated === true,
        rowCount: result.rows.length,
        downloadTool: 'read_export',
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        structuredContent: response,
      };
    }
    return {
      content: [{ type: 'text' as const, text }],
      ...(result.truncated
        ? {
            structuredContent: {
              truncated: true,
              rowCount: result.rows.length,
              limitReason: result.limitReason,
            },
          }
        : {}),
    };
  }

  private async handleTestConnection(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

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

  private async handleGetDatabaseStats(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const stats = await this.workspaceClient.getDatabaseStats(connection);
    return this.presentDocument(stats, source);
  }

  private async handleListTables(args: {
    connectionId: string;
    database?: string;
    schema?: string;
    includeViews?: boolean;
  }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    const source = this.catalogSource(connection);
    const tables = await this.workspaceClient.listTables(
      connection,
      args.schema,
      args.includeViews || false
    );

    return this.presentDocument(tables, source);
  }

  private async handleAppendInsight(args: {
    insight: string;
    connection?: string;
    tags?: string[];
  }) {
    this.refreshNotes();
    if (!args.insight || args.insight.trim().length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'Insight text is required');
    }

    if (args.connection && !(await this.getConnection(args.connection)))
      throw new Error('Insight connection is not accessible');
    const newInsight: BusinessInsight = {
      id: Math.max(Date.now(), ...this.insights.map((n) => n.id)) + 1,
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
    this.refreshNotes();
    const visible = await this.getFilteredConnections();
    let filteredInsights = this.insights.filter(
      (n) => !n.connection || visible.some((c) => c.id === n.connection || c.name === n.connection)
    );

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
  private async handleBeginTransaction(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);
    if (connection && this.accessPolicy.isReadOnly(connection))
      throw new McpError(ErrorCode.InvalidRequest, 'This saved connection is read-only');

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

    const transaction = this.transactionManager.getTransaction(args.transactionId);
    if (!transaction) throw new Error('Transaction not found or expired');
    const scope = this.transactionManager.resultScope(args.transactionId);
    const source = this.artifactSource(scope.connection, args.query, scope.policyRevision);
    const result = await this.transactionManager.executeInTransaction(
      args.transactionId,
      args.query
    );
    return this.presentResult(result, source, { transactionId: args.transactionId });
  }

  // Query analysis handlers
  private async handleExplainQuery(args: {
    connectionId: string;
    database?: string;
    query: string;
    analyze?: boolean;
    format?: 'text' | 'json';
  }) {
    const policyError = validateQuery(args.query) || enforceReadOnly(args.query);
    if (policyError) throw new McpError(ErrorCode.InvalidParams, policyError);
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    if (args.analyze && connection.driver.toLowerCase().includes('oracle')) {
      // An actual plan would mean running the statement; EXPLAIN PLAN never does.
      throw new McpError(
        ErrorCode.InvalidParams,
        'analyze is not supported for Oracle: only the estimated plan (EXPLAIN PLAN) is available'
      );
    }

    const format = args.format || 'text';
    await this.workspaceClient.assertQueryAccess(connection, args.query, true);
    const dialect = connection.driver.toLowerCase();
    const isSqlServer = /mssql|sqlserver|microsoft/.test(dialect);
    if (isSqlServer && args.analyze)
      throw new McpError(
        ErrorCode.InvalidParams,
        'SQL Server supports estimated plans here; analyze is unavailable'
      );
    const result = isSqlServer
      ? await this.workspaceClient.explainSqlServerQuery(connection, args.query, format)
      : dialect.includes('oracle')
        ? await this.workspaceClient.explainOracleQuery(connection, args.query)
        : await this.workspaceClient.executeQuery(
            connection,
            buildExplainQuery(connection.driver, args.query, args.analyze || false, format),
            { readOnly: true, trustedMetadata: true }
          );
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

    const source = this.catalogSource(sourceConn, targetConn);
    const defaultTimeout = integerSetting(process.env.OMNISQL_TIMEOUT, 'OMNISQL_TIMEOUT', 30000);
    const deadline =
      Date.now() +
      Math.min(
        sourceConn.limits?.timeoutMs ?? defaultTimeout,
        targetConn.limits?.timeoutMs ?? defaultTimeout
      );
    const checkDeadline = () => {
      if (Date.now() >= deadline)
        throw new Error(
          'Schema comparison budget exhausted; narrow the request with table policies'
        );
    };
    // Bound total catalog work as well as each native metadata query.
    const sourceTables = await this.workspaceClient.listTables(sourceConn);
    checkDeadline();
    const targetTables = await this.workspaceClient.listTables(targetConn);
    if (sourceTables.length > 1000 || targetTables.length > 1000)
      throw new Error(
        'Schema comparison table limit is 1000 per connection; narrow the request with table policies'
      );

    let bytes = 0;
    const load = async (connection: DatabaseConnection, tables: any[]) => {
      const schemas = [];
      for (let offset = 0; offset < tables.length; offset += 4) {
        checkDeadline();
        const batch = await Promise.all(
          tables.slice(offset, offset + 4).map(async (table) => {
            const name = [table.table_schema, table.name].filter(Boolean).join('.');
            const schema = await this.workspaceClient.getTableSchema(connection, name);
            bytes += Buffer.byteLength(JSON.stringify(schema));
            if (bytes > 16 * 1024 * 1024)
              throw new Error(
                'Schema comparison catalog exceeds 16 MiB; narrow the request with table policies'
              );
            return comparableSchema(schema);
          })
        );
        checkDeadline();
        schemas.push(...batch);
      }
      return schemas;
    };
    const sourceSchemas = await load(sourceConn, sourceTables);
    const targetSchemas = await load(targetConn, targetTables);

    checkDeadline();
    const diff = await compareSchemas(sourceSchemas, targetSchemas, sourceConnId, targetConnId);

    const response: { diff: SchemaDiff; migrationScript?: string } = { diff };

    if (args.includeMigrationScript) {
      response.migrationScript = generateMigrationScript(diff, targetConn.driver);
    }

    return this.presentDocument(response, source);
  }

  // Pool management handlers
  private async handleGetPoolStats(args: { connectionId: string; database?: string }) {
    const connectionId = sanitizeConnectionId(args.connectionId);
    const connection = await this.getConnection(connectionId, args.database);

    if (!connection) {
      throw new McpError(ErrorCode.InvalidParams, `Connection not found: ${connectionId}`);
    }

    // Initialize pool if needed
    await this.poolManager.getPool(connection);
    const stats = await this.poolManager.getStats(connection);

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
      if (!process.env.OMNISQL_CONFIG_FILE && !this.configParser.isWorkspaceValid()) {
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
      void checkForUpdate(VERSION);

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

export async function startServer(): Promise<void> {
  const server = new OmniSQLMCPServer();
  await server.run();
}
