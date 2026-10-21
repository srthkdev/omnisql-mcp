import { tableNameParts } from './metadata/identifiers.js';
import { registerConnectionPrivacy, sanitizeDiagnostic } from './privacy.js';
import { clickhouseAdapter } from './runtime/clickhouse.js';
import { duckdbAdapter } from './runtime/duckdb.js';
import {
  assertQueryAccess as authorizeQuery,
  assertIdentityAccess,
  identityPredicate,
} from './policy/identities.js';
import { devNull } from 'node:os';
import { acquireLease } from './runtime/lease.js';
import { readPostgres, readMysql, readSqlServer } from './runtime/sql-sessions.js';
import { tableStatistics, type TableStatistics, visibleStorage } from './metadata/statistics.js';
import { indexesAndConstraints } from './metadata/catalog.js';
import { QueryGate } from './runtime/concurrency.js';
import { AdapterRegistry } from './runtime/adapter.js';
import { sqlDialect } from './policy/analyzer.js';
import { ResultCollector } from './runtime/results.js';
import { AccessPolicy } from './policy/access.js';
import { booleanSetting } from './runtime-config.js';
import { runJsonCli } from './runtime/cli.js';
import { Pool as PgPool } from 'pg';
import { ConnectionPoolManager } from './pools/connection-pool.js';
import type sql from 'mssql';
import mysql from 'mysql2/promise';
import type {
  DatabaseConnection,
  QueryResult,
  SchemaInfo,
  ConnectionTest,
  DatabaseStats,
} from './types.js';
import {
  getTestQuery,
  parseVersionFromResult,
  buildSchemaQuery,
  buildListTablesQuery,
} from './utils.js';
import { sshTunnelManager } from './net/ssh-tunnel.js';
import type oracledb from 'oracledb';
import {
  resolveOracleConnectOptions,
  oracleFetchTypeHandler,
  explainStatementId,
  normalizeOracleStatement,
  collectOracleRow,
  closeOracleLobs,
} from './oracle.js';

export class WorkspaceClient {
  private policy = new AccessPolicy();
  private gate = new QueryGate();
  private adapters = new AdapterRegistry([
    clickhouseAdapter({
      timeout: () => this.timeout,
      endpoint: (connection, port) => this.resolveEndpoint(connection, port),
    }),
    duckdbAdapter(() => this.timeout),
    {
      id: 'postgres',
      capabilities: { databaseOverride: true, readOnly: 'transaction', transactions: true },
      execute: (c, q, o) => this.executePostgreSQLQuery(c, q, o.readOnly, o.maxRows),
    },
    {
      id: 'mysql',
      capabilities: { databaseOverride: true, readOnly: 'transaction', transactions: true },
      execute: (c, q, o) => this.executeMySQLQuery(c, q, o.readOnly, o.maxRows),
    },
    {
      id: 'mssql',
      capabilities: { databaseOverride: true, readOnly: 'permissions', transactions: true },
      execute: (c, q, o) => this.executeSQLServerQuery(c, q, o.maxRows),
    },
    {
      id: 'sqlite',
      capabilities: { databaseOverride: false, readOnly: 'file', transactions: false },
      execute: (c, q, o) => this.executeSQLiteQuery(c, q, o.readOnly, o.maxRows),
    },
    {
      id: 'oracle',
      capabilities: { databaseOverride: false, readOnly: 'transaction', transactions: false },
      execute: (c, q, o) => this.executeOracleQuery(c, q, o.maxRows, o.readOnly),
    },
  ]);
  getCapabilities(connection: DatabaseConnection) {
    return this.adapters.get(sqlDialect(connection.driver))?.capabilities ?? null;
  }
  private timeout: number;
  private debug: boolean;

  constructor(
    _executablePath?: string,
    timeout: number = 30000,
    debug: boolean = false,
    _workspacePath?: string,
    private poolManager = new ConnectionPoolManager(
      { min: 0, max: 4, acquireTimeoutMs: timeout },
      false,
      timeout
    )
  ) {
    this.timeout = timeout;
    this.debug = debug;
  }

  /**
   * Run a query against a connection.
   *
   * `maxRows` caps the fetch for engines that bound rows in the driver rather
   * than through a LIMIT/TOP clause the caller adds (Oracle).
   */
  async executeQuery(
    connection: DatabaseConnection,
    query: string,
    options: { maxRows?: number; readOnly?: boolean; trustedMetadata?: boolean } = {}
  ): Promise<QueryResult> {
    registerConnectionPrivacy(connection);
    const startTime = Date.now();
    const release = await this.gate.acquire(connection.limits?.timeoutMs ?? this.timeout);

    try {
      // Adapters own fetching, normalization, and result budgets.
      const readOnly =
        options.readOnly === true ||
        this.policy.isReadOnly(connection) ||
        booleanSetting(process.env.OMNISQL_READ_ONLY, 'OMNISQL_READ_ONLY', true);
      if (!options.trustedMetadata) await this.checkQueryAccess(connection, query, readOnly);
      else this.policy.assertConnection(connection);
      const target = options.trustedMetadata
        ? {
            ...connection,
            limits: { ...connection.limits, maxRows: 10000, maxBytes: 8 * 1024 * 1024 },
          }
        : connection;
      const result = await this.executeWithNativeTool(
        target,
        query,
        options.trustedMetadata ? 10000 : options.maxRows,
        readOnly
      );
      result.executionTime = Date.now() - startTime;
      return result;
    } catch (error) {
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        /^[A-Z0-9_]{2,64}$/.test(String(error.code))
          ? String(error.code)
          : undefined;
      const message = sanitizeDiagnostic(error);
      if (this.debug) console.error('Query execution failed:', message, code ?? '');
      throw new Error(`Query execution failed: ${message}${code ? ` (${code})` : ''}`);
    } finally {
      release();
    }
  }

  private metadataAccessQuery(connection: DatabaseConnection, query: string): Promise<QueryResult> {
    return this.executeWithNativeTool(
      {
        ...connection,
        limits: { ...connection.limits, maxRows: 10000, maxBytes: 8 * 1024 * 1024 },
      },
      query,
      10000,
      true
    );
  }
  private checkQueryAccess(
    connection: DatabaseConnection,
    query: string,
    readOnly: boolean
  ): Promise<void> {
    return authorizeQuery(this.policy, connection, query, readOnly, (sql) =>
      this.metadataAccessQuery(connection, sql)
    );
  }
  async assertQueryAccess(
    connection: DatabaseConnection,
    query: string,
    readOnly: boolean
  ): Promise<void> {
    const release = await this.gate.acquire(connection.limits?.timeoutMs ?? this.timeout);
    try {
      await this.checkQueryAccess(connection, query, readOnly);
    } finally {
      release();
    }
  }
  async assertTableAccess(connection: DatabaseConnection, name: string): Promise<void> {
    this.policy.assertConnection(connection);
    this.policy.assertTableScope(connection, name);
    if (!this.policy.hasTableRestrictions(connection)) return;
    const release = await this.gate.acquire(connection.limits?.timeoutMs ?? this.timeout);
    try {
      await assertIdentityAccess(
        this.policy,
        connection,
        tableNameParts(name).map((value) => ({ value, quoted: true })),
        'table',
        (sql) => this.metadataAccessQuery(connection, sql)
      );
    } finally {
      release();
    }
  }
  async close(): Promise<void> {
    this.adapters.close();
    await this.poolManager.closeAllPools();
  }

  async testConnection(connection: DatabaseConnection): Promise<ConnectionTest> {
    const startTime = Date.now();

    try {
      // Simple test query based on database type
      const testQuery = this.getTestQuery(connection.driver);
      const result = await this.executeQuery(connection, testQuery, {
        trustedMetadata: true,
        readOnly: true,
      });

      return {
        connectionId: connection.id,
        success: true,
        responseTime: Date.now() - startTime,
        databaseVersion: this.extractVersionFromResult(result),
      };
    } catch (error) {
      return {
        connectionId: connection.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        responseTime: Date.now() - startTime,
      };
    }
  }

  async getTableSchema(connection: DatabaseConnection, tableName: string): Promise<SchemaInfo> {
    await this.assertTableAccess(connection, tableName);
    const schemaQuery = this.buildSchemaQuery(connection.driver, tableName);
    const result = await this.executeQuery(connection, schemaQuery, { trustedMetadata: true });

    const schema = this.parseSchemaResult(result, tableName);
    if (!schema.columns.length)
      throw new Error('Table not found or column metadata is not accessible');
    const details = await indexesAndConstraints(connection, tableName, (sql) =>
      this.executeQuery(connection, sql, { trustedMetadata: true, readOnly: true })
    );
    schema.indexes = details.indexes;
    schema.constraints = details.constraints;
    if (details.physicalKeys) schema.physicalKeys = details.physicalKeys;
    if (details.notes?.length) schema.notes = details.notes;
    if (result.truncated || details.partial) schema.partial = true;
    const primary = new Set(
      schema.constraints.filter((k) => k.type === 'PRIMARY_KEY').flatMap((k) => k.columns)
    );
    for (const column of schema.columns)
      if (primary.has(column.name)) {
        column.isPrimaryKey = true;
        column.nullable = false;
      }
    if (
      sqlDialect(connection.driver) === 'sqlite' &&
      !schema.constraints.some((k) => k.type === 'PRIMARY_KEY')
    ) {
      const columns = schema.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
      if (columns.length)
        schema.constraints.push({
          name: 'primary_key',
          type: 'PRIMARY_KEY',
          columns,
          nameIsGenerated: true,
        });
    }
    return schema;
  }

  /**
   * Check if a driver uses the Postgres wire protocol.
   * CockroachDB, TimescaleDB, Redshift, YugabyteDB, AlloyDB, Supabase, Neon, Citus
   * all speak Postgres wire protocol and work with the pg driver.
   */
  private isPostgresCompatible(driver: string): boolean {
    return sqlDialect(driver) === 'postgres';
  }

  private async executeWithNativeTool(
    connection: DatabaseConnection,
    query: string,
    maxRows?: number,
    readOnly = false
  ): Promise<QueryResult> {
    const driver = connection.driver.toLowerCase();

    const adapter = this.adapters.get(sqlDialect(driver));
    if (adapter) return adapter.execute(connection, query, { maxRows, readOnly });
    throw new Error(
      `Database driver ${connection.driver} is not natively supported; configure a supported engine. GUI/CLI fallback is disabled because it cannot enforce access and output policies.`
    );
  }

  /**
   * Work out where to actually connect for this connection.
   *
   * For a tunneled connection the recorded host/port describe the database as
   * seen from the SSH server, so they are not an address this process can use.
   * Opening the tunnel yields a loopback endpoint that is. Failing to open it
   * throws rather than falling through to the recorded host, which for a
   * tunneled connection is usually `localhost` and would quietly reach some
   * unrelated local database.
   */
  private async resolveEndpoint(
    connection: DatabaseConnection,
    defaultPort: number
  ): Promise<{ host: string; port: number }> {
    const tunnel = await sshTunnelManager.resolveEndpoint(connection, defaultPort);
    if (tunnel) {
      return tunnel;
    }

    const port =
      connection.port ||
      (connection.properties?.port ? parseInt(String(connection.properties.port)) : defaultPort);

    return {
      host: connection.host || connection.properties?.host || 'localhost',
      port: Number.isNaN(port) ? defaultPort : port,
    };
  }

  private async executeSQLiteQuery(
    connection: DatabaseConnection,
    query: string,
    readOnly = false,
    maxRows?: number
  ): Promise<QueryResult> {
    const timeout = connection.limits?.timeoutMs ?? this.timeout;
    const dbPath = connection.properties?.database || connection.database;
    if (!dbPath) throw new Error('SQLite database path not found');
    if (query.trimStart().startsWith('.'))
      throw new Error('SQLite CLI dot commands are not SQL and are not supported');
    return runJsonCli(
      connection,
      'sqlite3',
      [
        '-safe',
        '-init',
        devNull,
        '-json',
        '-cmd',
        '.explain off',
        ...(readOnly ? ['-readonly'] : []),
        dbPath,
        query,
      ],
      'SQLite',
      timeout,
      maxRows
    );
  }

  private async executePostgreSQLQuery(
    connection: DatabaseConnection,
    query: string,
    readOnly = false,
    maxRows?: number
  ): Promise<QueryResult> {
    const entry = await this.poolManager.getPool(connection);
    const client = await (entry!.pool as PgPool).connect();
    let broken = false,
      released = false,
      timedOut = false;
    try {
      if (readOnly) await client.query('BEGIN READ ONLY');
      return await readPostgres(client, query, {
        connection,
        maxRows,
        timeout: connection.limits?.timeoutMs ?? this.timeout,
        abort: () => {
          broken = true;
          released = true;
          timedOut = true;
          client.release(true);
        },
      });
    } catch (error) {
      broken = true;
      if (timedOut)
        throw new Error(
          `PostgreSQL query timed out after ${connection.limits?.timeoutMs ?? this.timeout}ms`
        );
      throw error;
    } finally {
      if (readOnly && !broken) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      if (!released) client.release(broken);
    }
  }

  private async executeSQLServerQuery(
    connection: DatabaseConnection,
    query: string,
    maxRows?: number
  ): Promise<QueryResult> {
    const entry = await this.poolManager.getPool(connection);
    const pool = entry!.pool as sql.ConnectionPool;
    return readSqlServer(pool.request(), query, {
      connection,
      maxRows,
      timeout: connection.limits?.timeoutMs ?? this.timeout,
      abort: () => {},
    });
  }

  private async executeMySQLQuery(
    connection: DatabaseConnection,
    query: string,
    readOnly = false,
    maxRows?: number
  ): Promise<QueryResult> {
    const timeout = connection.limits?.timeoutMs ?? this.timeout;
    const entry = await this.poolManager.getPool(connection);
    const conn = await acquireLease((entry!.pool as mysql.Pool).getConnection(), timeout, (lease) =>
      lease.release()
    );
    let broken = false;
    try {
      if (readOnly) await conn.query('START TRANSACTION READ ONLY');
      return await readMysql(conn, query, {
        connection,
        maxRows,
        timeout,
        abort: () => {
          broken = true;
          conn.destroy();
        },
      });
    } catch (error) {
      broken = true;
      conn.destroy();
      throw error;
    } finally {
      if (!broken && readOnly) {
        try {
          await conn.rollback();
        } catch {
          broken = true;
          conn.destroy();
        }
      }
      if (!broken) conn.release();
    }
  }

  /**
   * Lease an Oracle session for one unit of work; privileged sessions stay standalone.
   */
  private async withOracleConnection<T>(
    connection: DatabaseConnection,
    work: (conn: oracledb.Connection) => Promise<T>
  ): Promise<T> {
    const timeout = connection.limits?.timeoutMs ?? this.timeout;
    const { host, port } = await this.resolveEndpoint(connection, 1521);
    const options = resolveOracleConnectOptions(connection, host, port);
    const user = connection.user || connection.properties?.user;
    const password = connection.properties?.password;

    if (!user) {
      throw new Error('User is required for Oracle connection');
    }

    const { default: oracledb } = await import('oracledb');
    const conn =
      options.privilege !== undefined
        ? await oracledb.getConnection({
            user,
            password,
            connectString: options.connectString,
            configDir: options.configDir,
            privilege: options.privilege,
            connectTimeout: Math.max(1, Math.ceil(timeout / 1000)),
          })
        : await (
            (await this.poolManager.getPool(connection))!.pool as oracledb.Pool
          ).getConnection();
    try {
      // Bounds every round trip, so a slow query fails instead of hanging.
      conn.callTimeout = timeout;
      return await work(conn);
    } finally {
      try {
        await conn.close();
      } catch (closeError) {
        console.error('Failed to release Oracle session:', sanitizeDiagnostic(closeError));
      }
    }
  }

  private async executeOracleQuery(
    connection: DatabaseConnection,
    query: string,
    maxRows?: number,
    readOnly = false
  ): Promise<QueryResult> {
    const { default: oracledb } = await import('oracledb');
    return this.withOracleConnection(connection, async (conn) => {
      const deadline = Date.now() + (connection.limits?.timeoutMs ?? this.timeout);
      const beforeRead = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Oracle query deadline exceeded');
        conn.callTimeout = remaining;
      };
      if (readOnly) {
        beforeRead();
        await conn.execute('SET TRANSACTION READ ONLY');
      }
      beforeRead();
      const res = await conn.execute<unknown[]>(normalizeOracleStatement(query), [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: !readOnly,
        resultSet: true,
        fetchTypeHandler: oracleFetchTypeHandler,
      });
      const collector = new ResultCollector(connection, maxRows);
      collector.columns = (res.metaData ?? []).map((m) => m.name);
      if (!res.resultSet) return collector.result(res.rowsAffected);
      try {
        let done = false;
        while (!done) {
          beforeRead();
          const rows = await res.resultSet.getRows(Math.min(64, collector.maxRows + 1));
          try {
            for (const row of rows)
              if (!(await collectOracleRow(row, collector, beforeRead))) {
                done = true;
                break;
              }
          } finally {
            await closeOracleLobs(rows);
          }
          if (rows.length === 0) done = true;
        }
        return collector.result();
      } finally {
        await res.resultSet.close();
      }
    }).catch((error: unknown) => {
      if (error instanceof Error && /ORA-40478|ORA-22835/.test(error.message))
        throw new Error(
          error.message +
            '; return large JSON/text explicitly as CLOB, for example JSON_SERIALIZE(expression RETURNING CLOB)'
        );
      throw error;
    });
  }

  async explainSqlServerQuery(
    connection: DatabaseConnection,
    query: string,
    format: 'text' | 'json'
  ): Promise<QueryResult> {
    await this.assertQueryAccess(connection, query, true);
    const { default: sql } = await import('mssql');
    const entry = await this.poolManager.getPool(connection);
    const transaction = new sql.Transaction(entry!.pool as sql.ConnectionPool);
    await transaction.begin();
    const setting = format === 'json' ? 'SHOWPLAN_XML' : 'SHOWPLAN_TEXT';
    let enabled = false;
    try {
      await new sql.Request(transaction).batch(`SET ${setting} ON`);
      enabled = true;
      const request = new sql.Request(transaction);
      request.arrayRowMode = true;
      const result = await request.batch(query);
      return {
        columns:
          (result.recordset?.columns as unknown as { name: string }[] | undefined)?.map(
            (c) => c.name
          ) ?? [],
        rows: result.recordset ?? [],
        rowCount: result.recordset?.length ?? 0,
        executionTime: 0,
      };
    } finally {
      if (enabled) await new sql.Request(transaction).batch(`SET ${setting} OFF`).catch(() => {});
      await transaction.rollback().catch(() => {});
    }
  }

  /**
   * Estimated execution plan for an Oracle query.
   *
   * EXPLAIN PLAN only parses the statement, never runs it. The plan rows land
   * in the session's PLAN_TABLE and are discarded by the rollback.
   */
  async explainOracleQuery(connection: DatabaseConnection, query: string): Promise<QueryResult> {
    const startTime = Date.now();
    const { default: oracledb } = await import('oracledb');
    return this.withOracleConnection(connection, async (conn) => {
      const statementId = explainStatementId();
      try {
        await conn.execute(
          `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${normalizeOracleStatement(query)}`
        );
        const res = await conn.execute<unknown[]>(
          `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))`,
          { id: statementId },
          { outFormat: oracledb.OUT_FORMAT_ARRAY }
        );
        const rows = res.rows || [];
        return {
          columns: ['PLAN_TABLE_OUTPUT'],
          rows,
          rowCount: rows.length,
          executionTime: Date.now() - startTime,
        };
      } finally {
        await conn.rollback();
      }
    });
  }

  private getTestQuery(driver: string): string {
    // Delegate to utils
    return getTestQuery(driver);
  }

  private extractVersionFromResult(result: any): string | undefined {
    return parseVersionFromResult(result);
  }

  private buildSchemaQuery(driver: string, tableName: string): string {
    return buildSchemaQuery(driver, tableName);
  }

  private parseSchemaResult(result: any, tableName: string): SchemaInfo {
    const columns: any[] = [];

    if (result.rows && result.columns) {
      // Parse each row as a column definition
      result.rows.forEach((row: any[]) => {
        const columnInfo: any = {
          name: '',
          type: 'string',
          nullable: true,
          isPrimaryKey: false,
          isAutoIncrement: false,
        };

        // Map columns based on the query result structure
        result.columns.forEach((colName: string, idx: number) => {
          const value = row[idx];

          switch (colName.toLowerCase()) {
            case 'column_name':
            case 'name':
              columnInfo.name = value || '';
              break;
            case 'data_type':
            case 'type':
              columnInfo.type = value || 'string';
              break;
            case 'notnull':
              columnInfo.nullable = Number(value) === 0;
              break;
            case 'pk':
              columnInfo.isPrimaryKey = Number(value) > 0;
              break;
            case 'is_nullable':
            case 'nullable':
              columnInfo.nullable =
                value === 'YES' || value === 'Y' || value === true || value === 1 || value === '1';
              break;
            case 'dflt_value':
            case 'data_default':
            case 'column_default':
            case 'default':
              columnInfo.defaultValue = value;
              break;
            case 'column_key':
            case 'key':
              columnInfo.isPrimaryKey = value === 'PRI' || value === 'PRIMARY';
              break;
            case 'is_identity':
            case 'identity_column':
              columnInfo.isAutoIncrement =
                value === 'YES' || value === 'Y' || value === 1 || value === true;
              break;
            case 'extra':
              columnInfo.isAutoIncrement = value && value.toLowerCase().includes('auto_increment');
              break;
            case 'data_length':
            case 'character_maximum_length':
            case 'length':
              columnInfo.length = value === null || value === undefined ? undefined : Number(value);
              break;
            case 'data_precision':
            case 'numeric_precision':
            case 'precision':
              columnInfo.precision =
                value === null || value === undefined ? undefined : Number(value);
              break;
            case 'data_scale':
            case 'numeric_scale':
            case 'scale':
              columnInfo.scale = value === null || value === undefined ? undefined : Number(value);
              break;
          }
        });

        if (columnInfo.name) {
          if (columnInfo.isPrimaryKey) columnInfo.nullable = false;
          if (
            typeof columnInfo.defaultValue === 'string' &&
            /nextval\s*\(/i.test(columnInfo.defaultValue)
          )
            columnInfo.isAutoIncrement = true;
          columns.push(columnInfo);
        }
      });
    }

    return {
      tableName,
      columns,
      indexes: [],
      constraints: [],
    };
  }

  async getTableStats(connection: DatabaseConnection, tableName: string): Promise<TableStatistics> {
    await this.assertTableAccess(connection, tableName);
    return tableStatistics(connection, tableName, (sql) =>
      this.executeQuery(connection, sql, { trustedMetadata: true, readOnly: true })
    );
  }
  async getDatabaseStats(connection: DatabaseConnection): Promise<DatabaseStats> {
    const start = Date.now();
    const [tables, versionResult] = await Promise.all([
      this.listTables(connection, undefined, false),
      this.executeQuery(connection, this.getTestQuery(connection.driver), {
        trustedMetadata: true,
        readOnly: true,
      }),
    ]);
    const names = new Set<string>(
      tables.map((table) => [table.table_schema, table.name].filter(Boolean).join('.'))
    );
    const storage = await visibleStorage(connection, names, (sql) =>
      this.executeQuery(connection, sql, { trustedMetadata: true, readOnly: true })
    );

    return {
      connectionId: connection.id,
      tableCount: tables.length,
      totalSize: storage.totalSizeBytes ? `${storage.totalSizeBytes} bytes` : 'Unavailable',
      totalSizeBytes: storage.totalSizeBytes,
      sizeScope: 'visible-tables',
      sizeComplete: storage.sizeComplete,
      estimated: true,
      connectionTime: Date.now() - start,
      serverVersion: this.extractVersionFromResult(versionResult) ?? 'Unavailable',
      notes: storage.notes,
    };
  }

  async listDatabases(connection: DatabaseConnection): Promise<string[]> {
    const driver = connection.driver.toLowerCase();
    let query: string;
    if (this.isPostgresCompatible(driver)) {
      query =
        "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT') ORDER BY datname";
    } else if (driver.includes('mysql') || driver.includes('mariadb')) {
      query = 'SHOW DATABASES';
    } else if (
      driver.includes('mssql') ||
      driver.includes('sqlserver') ||
      driver.includes('microsoft')
    ) {
      query =
        'SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name';
    } else if (driver.includes('clickhouse')) {
      query = 'SELECT name FROM system.databases ORDER BY name';
    } else {
      throw new Error(
        'list_databases supports PostgreSQL, MySQL/MariaDB, SQL Server, and ClickHouse connections'
      );
    }
    const result = await this.executeQuery(connection, query, { trustedMetadata: true });
    if (result.truncated)
      throw new Error(
        'Database catalog is incomplete at the result limit; narrow the request with database policies'
      );
    return result.rows
      .map((row) => String(row[0]))
      .filter((database) => this.policy.allowsDatabase(connection, database));
  }

  private filterCatalogSql(connection: DatabaseConnection, sql: string): string {
    if (
      !this.policy.hasTableRestrictions(connection) ||
      !['mysql', 'mssql', 'sqlite', 'duckdb'].includes(sqlDialect(connection.driver))
    )
      return sql;
    const dialect = sqlDialect(connection.driver);
    const database =
      dialect === 'mysql'
        ? 'visible.table_schema'
        : dialect === 'mssql'
          ? '(SELECT name FROM sys.databases WHERE database_id=DB_ID())'
          : dialect === 'duckdb'
            ? 'current_database()'
            : "''";
    const predicate = identityPredicate(
      connection,
      this.policy.rulesFor(connection),
      { schema: 'visible.table_schema', name: 'visible.table_name', database },
      'table',
      true
    );
    const source = sql.replace(/;\s*$/, '').replace(/\s+ORDER BY[\s\S]*$/i, '');
    return `SELECT * FROM (${source}) visible WHERE ${predicate}`;
  }
  async listTables(
    connection: DatabaseConnection,
    schema?: string,
    includeViews: boolean = false
  ): Promise<any[]> {
    try {
      const query = this.filterCatalogSql(
        connection,
        buildListTablesQuery(connection.driver, schema, includeViews)
      );
      const result = await this.executeQuery(connection, query, { trustedMetadata: true });
      if (result.truncated)
        throw new Error(
          'Table catalog is incomplete at the result limit; narrow the request with a schema or table policies'
        );

      // Convert result to table objects
      return result.rows
        .map((row) => {
          const tableObj: any = {};
          result.columns.forEach((col, idx) => {
            tableObj[col.toLowerCase()] = row[idx];
          });
          tableObj.name = tableObj.table_name ?? tableObj.name;
          return tableObj;
        })
        .filter(
          (table) =>
            ['mysql', 'mssql', 'sqlite', 'duckdb'].includes(sqlDialect(connection.driver)) ||
            this.policy.allowsResolved(
              connection,
              table.table_schema ?? table.schema ?? '',
              table.name,
              'table',
              true
            )
        );
    } catch (error) {
      throw new Error(
        `Failed to list tables: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
