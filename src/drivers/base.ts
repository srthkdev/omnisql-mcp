import type {
  DatabaseDriverInterface,
  DriverDialect,
  DBeaverConnection,
  ConnectionConfig,
  QueryResult,
  ExecuteResult,
  SchemaInfo,
  ColumnInfo,
  TableInfo,
  DatabaseStats,
  ConnectionTest,
  PoolStats,
  PoolConfig,
} from '../types.js';
import {
  getTestQuery,
  buildSchemaQuery,
  buildListTablesQuery,
  parseVersionFromResult,
  sanitizeIdentifier,
} from '../utils.js';

/**
 * Default pool configuration used when no explicit config is provided.
 */
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeoutMs: 30000,
  acquireTimeoutMs: 10000,
};

/**
 * Abstract base class for all database drivers.
 *
 * Subclasses must implement the abstract methods for connecting, disconnecting,
 * and executing raw queries. The base class provides concrete implementations
 * of higher-level operations (schema introspection, stats, connection testing)
 * that delegate to the raw query methods.
 */
export abstract class BaseDriver implements DatabaseDriverInterface {
  abstract readonly dialect: DriverDialect;

  protected readonly connectionId: string;
  protected readonly connectionName: string;
  protected readonly connection: DBeaverConnection;
  protected readonly poolConfig: PoolConfig;
  protected readonly debug: boolean;

  constructor(connection: DBeaverConnection, config?: Partial<ConnectionConfig>) {
    this.connectionId = connection.id;
    this.connectionName = connection.name;
    this.connection = connection;
    this.debug = config?.properties?.debug === 'true' || false;
    this.poolConfig = config?.poolConfig ?? { ...DEFAULT_POOL_CONFIG };
  }

  get name(): string {
    return this.connectionName;
  }

  // ── Logging ───────────────────────────────────────────────────────

  protected log(message: string): void {
    if (this.debug) {
      console.error(`[${this.constructor.name}:${this.connectionName}] ${message}`);
    }
  }

  // ── Abstract methods that subclasses must implement ───────────────

  /** Establish the underlying database connection / pool. */
  abstract connect(): Promise<void>;

  /** Close the underlying database connection / pool. */
  abstract disconnect(): Promise<void>;

  /**
   * Execute a SQL statement that returns rows (SELECT, SHOW, etc.).
   * Must return a fully populated QueryResult.
   */
  abstract rawQuery(sql: string): Promise<QueryResult>;

  /**
   * Execute a SQL statement that modifies data (INSERT, UPDATE, DELETE, DDL).
   * Must return an ExecuteResult with the number of affected rows.
   */
  abstract rawExecute(sql: string): Promise<ExecuteResult>;

  /** Return pool statistics, or null if the driver does not use a pool. */
  abstract getPoolStats(): PoolStats | null;

  // ── Concrete implementations ──────────────────────────────────────

  async query(sql: string, _params?: unknown[]): Promise<QueryResult> {
    const startTime = Date.now();
    try {
      const result = await this.rawQuery(sql);
      result.executionTime = Date.now() - startTime;
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Query failed after ${elapsed}ms: ${message}`);
      throw new Error(`Query execution failed: ${message}`);
    }
  }

  async execute(sql: string, _params?: unknown[]): Promise<ExecuteResult> {
    const startTime = Date.now();
    try {
      const result = await this.rawExecute(sql);
      this.log(
        `Execute completed in ${Date.now() - startTime}ms, affected ${result.affectedRows} rows`
      );
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Execute failed after ${elapsed}ms: ${message}`);
      throw new Error(`Execute failed: ${message}`);
    }
  }

  async getSchema(table: string): Promise<SchemaInfo> {
    const safeTable = sanitizeIdentifier(table);
    const schemaQuery = buildSchemaQuery(this.connection.driver, safeTable);
    const result = await this.rawQuery(schemaQuery);
    return this.parseSchemaResult(result, safeTable);
  }

  async listTables(schema?: string, includeViews?: boolean): Promise<TableInfo[]> {
    const query = buildListTablesQuery(this.connection.driver, schema, includeViews ?? false);
    const result = await this.rawQuery(query);
    return this.parseListTablesResult(result);
  }

  async getStats(): Promise<DatabaseStats> {
    const startTime = Date.now();

    try {
      const tables = await this.listTables(undefined, true);
      const tableCount = tables.length;

      const testResult = await this.testConnection();
      const serverVersion = testResult.databaseVersion || 'Unknown';

      return {
        connectionId: this.connectionId,
        tableCount,
        totalSize: 'Unknown',
        connectionTime: Date.now() - startTime,
        serverVersion,
      };
    } catch {
      return {
        connectionId: this.connectionId,
        tableCount: 0,
        totalSize: 'Unknown',
        connectionTime: Date.now() - startTime,
        serverVersion: 'Unknown',
      };
    }
  }

  async testConnection(): Promise<ConnectionTest> {
    const startTime = Date.now();

    try {
      const testQuery = getTestQuery(this.connection.driver);
      const result = await this.rawQuery(testQuery);
      const version = parseVersionFromResult(result);

      return {
        connectionId: this.connectionId,
        success: true,
        responseTime: Date.now() - startTime,
        databaseVersion: version,
      };
    } catch (error) {
      return {
        connectionId: this.connectionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        responseTime: Date.now() - startTime,
      };
    }
  }

  // ── Schema result parsing ─────────────────────────────────────────

  /**
   * Parse the result of a schema introspection query into SchemaInfo.
   * Ported from the old DBeaverClient.parseSchemaResult method.
   */
  protected parseSchemaResult(result: QueryResult, tableName: string): SchemaInfo {
    const columns: ColumnInfo[] = [];

    if (result.rows && result.columns) {
      for (const row of result.rows) {
        const columnInfo: ColumnInfo = {
          name: '',
          type: 'string',
          nullable: true,
          isPrimaryKey: false,
          isAutoIncrement: false,
        };

        result.columns.forEach((colName: string, idx: number) => {
          const value = row[idx];

          switch (colName.toLowerCase()) {
            case 'column_name':
            case 'name':
              columnInfo.name = value != null ? String(value) : '';
              break;
            case 'data_type':
            case 'type':
              columnInfo.type = value != null ? String(value) : 'string';
              break;
            case 'is_nullable':
            case 'nullable':
              columnInfo.nullable =
                value === 'YES' || value === 'Y' || value === true || value === 1;
              break;
            case 'column_default':
            case 'default':
            case 'dflt_value':
              columnInfo.defaultValue = value != null ? String(value) : undefined;
              break;
            case 'column_key':
            case 'key':
              columnInfo.isPrimaryKey = value === 'PRI' || value === 'PRIMARY';
              break;
            case 'extra':
              columnInfo.isAutoIncrement =
                typeof value === 'string' && value.toLowerCase().includes('auto_increment');
              break;
            case 'character_maximum_length':
            case 'length':
              columnInfo.length =
                value != null ? parseInt(String(value), 10) || undefined : undefined;
              break;
            case 'numeric_precision':
            case 'precision':
              columnInfo.precision =
                value != null ? parseInt(String(value), 10) || undefined : undefined;
              break;
            case 'numeric_scale':
            case 'scale':
              columnInfo.scale =
                value != null ? parseInt(String(value), 10) || undefined : undefined;
              break;
            case 'pk':
              // SQLite PRAGMA table_info: pk column (1 = primary key)
              columnInfo.isPrimaryKey = value === 1 || value === '1' || value === true;
              break;
            case 'notnull':
              // SQLite PRAGMA table_info: notnull column (1 = NOT NULL)
              columnInfo.nullable = !(value === 1 || value === '1' || value === true);
              break;
          }
        });

        if (columnInfo.name) {
          columns.push(columnInfo);
        }
      }
    }

    return {
      tableName,
      columns,
      indexes: [],
      constraints: [],
    };
  }

  /**
   * Parse the result of a list-tables query into TableInfo[].
   */
  protected parseListTablesResult(result: QueryResult): TableInfo[] {
    const tables: TableInfo[] = [];

    if (!result.rows || !result.columns) {
      return tables;
    }

    const colMap = new Map<string, number>();
    result.columns.forEach((col, idx) => {
      colMap.set(col.toLowerCase(), idx);
    });

    const nameIdx = colMap.get('table_name') ?? colMap.get('name') ?? -1;
    const typeIdx = colMap.get('table_type') ?? colMap.get('type') ?? -1;
    const schemaIdx = colMap.get('table_schema') ?? colMap.get('schema') ?? -1;

    for (const row of result.rows) {
      const name = nameIdx >= 0 ? String(row[nameIdx] ?? '') : '';
      if (!name) continue;

      const rawType = typeIdx >= 0 ? String(row[typeIdx] ?? '').toUpperCase() : 'TABLE';
      const type: 'table' | 'view' = rawType.includes('VIEW') ? 'view' : 'table';
      const schema = schemaIdx >= 0 ? String(row[schemaIdx] ?? '') || undefined : undefined;

      tables.push({ name, type, schema });
    }

    return tables;
  }
}
