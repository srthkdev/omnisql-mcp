import { QueryGate } from './runtime/concurrency.js';
import { AdapterRegistry } from './runtime/adapter.js';
import { sqlDialect } from './policy/analyzer.js';
import Cursor from 'pg-cursor';
import { ResultCollector, SQLiteRowStream } from './runtime/results.js';
import { AccessPolicy } from './policy/access.js';
import { booleanSetting } from './runtime-config.js';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import csv from 'csv-parser';
import { Pool as PgPool } from 'pg';
import { ConnectionPoolManager } from './pools/connection-pool.js';
import sql from 'mssql';
import mysql from 'mysql2/promise';
import {
  DatabaseConnection,
  QueryResult,
  SchemaInfo,
  ExportOptions,
  ConnectionTest,
  DatabaseStats,
} from './types.js';
import {
  findCliExecutable,
  getTestQuery,
  parseVersionFromResult,
  buildSchemaQuery,
  buildListTablesQuery,
} from './utils.js';
import { sshTunnelManager } from './net/ssh-tunnel.js';
import oracledb from 'oracledb';
import {
  resolveOracleConnectOptions,
  oracleFetchTypeHandler,
  explainStatementId,
  normalizeOracleStatement,
} from './oracle.js';

export class WorkspaceClient {
  private policy = new AccessPolicy();
  private gate = new QueryGate();
  private adapters = new AdapterRegistry([
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
  private executablePath: string;
  private timeout: number;
  private debug: boolean;
  private workspacePath?: string;

  constructor(
    executablePath?: string,
    timeout: number = 30000,
    debug: boolean = false,
    workspacePath?: string,
    private poolManager = new ConnectionPoolManager(
      { min: 0, max: 4, acquireTimeoutMs: timeout },
      false,
      timeout
    )
  ) {
    this.executablePath = executablePath || findCliExecutable();
    this.timeout = timeout;
    this.debug = debug;
    this.workspacePath = workspacePath;
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
    const startTime = Date.now();
    const release = await this.gate.acquire(connection.limits?.timeoutMs ?? this.timeout);

    try {
      // Use native database drivers; fall back to the CLI for unsupported drivers
      const readOnly =
        options.readOnly === true ||
        this.policy.isReadOnly(connection) ||
        booleanSetting(process.env.OMNISQL_READ_ONLY, 'OMNISQL_READ_ONLY');
      if (!options.trustedMetadata) this.policy.assertQuery(connection, query, readOnly);
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
      const rowLimit = options.trustedMetadata
        ? 10000
        : Math.min(options.maxRows ?? 1000, connection.limits?.maxRows ?? 100000);
      const byteLimit = options.trustedMetadata
        ? 8 * 1024 * 1024
        : (connection.limits?.maxBytes ?? 1024 * 1024);
      let bytes = Buffer.byteLength(JSON.stringify(result.columns));
      const retained: unknown[][] = [];
      for (const row of result.rows) {
        if (retained.length >= rowLimit) {
          result.truncated = true;
          result.limitReason = 'rows';
          break;
        }
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > byteLimit) {
          result.truncated = true;
          result.limitReason = 'bytes';
          break;
        }
        retained.push(row);
        bytes += size;
      }
      result.rows = retained;
      if (result.columns.length) result.rowCount = retained.length;
      result.executionTime = Date.now() - startTime;
      return result;
    } catch (error) {
      const messageRaw = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as any).code)
          : undefined;
      const fallback = code ? `Error (${code})` : String(error);
      const message = messageRaw && messageRaw.trim().length > 0 ? messageRaw : fallback;
      if (this.debug) {
        console.error('Query execution error details:', {
          connectionId: connection.id,
          driver: connection.driver,
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  name: error.name,
                  code: (error as any).code,
                  stack: error.stack,
                }
              : String(error),
        });
      }
      throw new Error(`Query execution failed: ${message}`);
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    await this.poolManager.closeAllPools();
  }

  async testConnection(connection: DatabaseConnection): Promise<ConnectionTest> {
    const startTime = Date.now();

    try {
      // Simple test query based on database type
      const testQuery = this.getTestQuery(connection.driver);
      const result = await this.executeQuery(connection, testQuery);

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
    this.policy.assertTable(connection, tableName);
    const schemaQuery = this.buildSchemaQuery(connection.driver, tableName);
    const result = await this.executeQuery(connection, schemaQuery, { trustedMetadata: true });

    return this.parseSchemaResult(result, tableName);
  }

  async exportData(
    connection: DatabaseConnection,
    query: string,
    options: ExportOptions
  ): Promise<string> {
    const tempDir = os.tmpdir();
    const exportId = `export_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const sqlFile = path.join(tempDir, `${exportId}.sql`);
    const outputFile = path.join(tempDir, `${exportId}_output.${options.format || 'csv'}`);

    try {
      // Write query to temporary file
      fs.writeFileSync(sqlFile, query, 'utf-8');

      // Build CLI command arguments
      const args = [
        '-nosplash',
        '-reuseWorkspace',
        ...(this.workspacePath ? ['-data', this.workspacePath] : []),
        '-con',
        connection.id,
        '-f',
        sqlFile,
        '-o',
        outputFile,
        '-of',
        options.format || 'csv',
        '-quit',
      ];

      await this.executeCli(args);

      // Optionally, you could check if the file exists and return the path
      if (!fs.existsSync(outputFile)) {
        throw new Error('Export failed: output file not found');
      }

      return outputFile;
    } catch (error) {
      throw new Error(`Export failed: ${error}`);
    } finally {
      // Cleanup the SQL file, but keep the output file for the user
      this.cleanupFiles([sqlFile]);
    }
  }

  /**
   * Check if a driver uses the Postgres wire protocol.
   * CockroachDB, TimescaleDB, Redshift, YugabyteDB, AlloyDB, Supabase, Neon, Citus
   * all speak Postgres wire protocol and work with the pg driver.
   */
  private isPostgresCompatible(driver: string): boolean {
    const d = driver.toLowerCase();
    return (
      d.includes('postgres') ||
      d.includes('cockroach') ||
      d.includes('timescale') ||
      d.includes('redshift') ||
      d.includes('yugabyte') ||
      d.includes('alloydb') ||
      (d.includes('aurora') && d.includes('postgres')) ||
      d.includes('supabase') ||
      d.includes('neon') ||
      d.includes('citus')
    );
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
    {
      if (readOnly) throw new Error('CLI fallback cannot enforce read-only access for this driver');
      // Unsupported driver – try the CLI as a best-effort fallback, but
      // wrap with a clear error message listing the natively supported drivers.
      try {
        return await this.executeViaCli(connection, query);
      } catch (cliError) {
        const driverName = connection.driver;
        const nativeDrivers =
          'PostgreSQL (+ CockroachDB, TimescaleDB, Redshift, YugabyteDB, Supabase, Neon, Citus, AlloyDB), MySQL/MariaDB, SQL Server (MSSQL), SQLite, Oracle';
        const cliMsg = cliError instanceof Error ? cliError.message : String(cliError);
        // Custom drivers can carry an opaque id; surfacing it alongside the
        // provider makes an unresolved dialect obvious rather than mysterious.
        const identity =
          connection.driverId && connection.driverId !== driverName
            ? `"${driverName}" (driver id "${connection.driverId}"${
                connection.provider ? `, provider "${connection.provider}"` : ''
              })`
            : `"${driverName}"`;
        throw new Error(
          `Database driver ${identity} is not natively supported. ` +
            `Natively supported drivers: ${nativeDrivers}. ` +
            `CLI fallback also failed: ${cliMsg}. ` +
            `If this is a custom driver wrapping a supported engine, set its connection ` +
            `"provider" (or a JDBC URL such as jdbc:postgresql://...) so the engine can be ` +
            `detected; otherwise connect through a supported driver or ensure a compatible ` +
            `DB client CLI is installed.`
        );
      }
    }
  }

  private async executeViaCli(connection: DatabaseConnection, query: string): Promise<QueryResult> {
    // Verify the CLI executable exists before attempting
    if (!this.isCliAvailable()) {
      throw new Error(
        'DB client CLI executable not found. Install a compatible CLI or set OMNISQL_CLI_PATH environment variable.'
      );
    }

    const tempDir = os.tmpdir();
    const exportId = `query_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const sqlFile = path.join(tempDir, `${exportId}.sql`);
    const outputFile = path.join(tempDir, `${exportId}_output.csv`);

    try {
      fs.writeFileSync(sqlFile, query, 'utf-8');

      // Build connection spec - try name first, then ID
      const conSpec = `name=${connection.name}`;

      const args = [
        '-nosplash',
        '-reuseWorkspace',
        ...(this.workspacePath ? ['-data', this.workspacePath] : []),
        '-con',
        conSpec,
        '-f',
        sqlFile,
        '-o',
        outputFile,
        '-of',
        'csv',
        '-quit',
      ];

      await this.executeCli(args);

      if (!fs.existsSync(outputFile)) {
        // Some non-SELECT statements may not produce a resultset/export file.
        return { columns: [], rows: [], rowCount: 0, executionTime: 0 };
      }

      return await this.parseCSVOutput(outputFile);
    } finally {
      this.cleanupFiles([sqlFile, outputFile]);
    }
  }

  private isCliAvailable(): boolean {
    try {
      // Check if the executable path exists (skip for bare command names that rely on PATH)
      if (this.executablePath.includes('/') || this.executablePath.includes('\\')) {
        return fs.existsSync(this.executablePath);
      }
      // For bare command names on PATH, we cannot easily verify presence here,
      // so assume it might be available and let executeCli surface any error
      return true;
    } catch {
      return false;
    }
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
    return new Promise((resolve, reject) => {
      const dbPath = connection.properties?.database || connection.database;
      if (!dbPath) {
        reject(new Error('SQLite database path not found'));
        return;
      }

      if (query.trimStart().startsWith('.')) {
        reject(new Error('SQLite CLI dot commands are not SQL and are not supported'));
        return;
      }
      const args = [
        '-safe',
        '-json',
        '-cmd',
        '.explain off',
        ...(readOnly ? ['-readonly'] : []),
        dbPath,
        query,
      ];
      const proc = spawn('sqlite3', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // A failed spawn surfaces twice: once as 'error' on the child, and again
      // as EPIPE on the stdin we write to below. Both are 'error' events with
      // no listener, which Node turns into an uncaught throw that takes the
      // whole MCP server down instead of failing this one tool call.
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error(`SQLite query timed out after ${timeout}ms`));
      }, timeout);
      const fail = (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        const hint =
          err.code === 'ENOENT'
            ? 'sqlite3 CLI not found on PATH - install it to query SQLite connections'
            : err.code === 'EACCES'
              ? 'sqlite3 CLI is not executable'
              : 'Failed to run sqlite3 CLI';
        reject(new Error(`${hint}: ${err.message}`));
      };

      proc.on('error', fail);
      proc.stdin.on('error', fail);

      const collector = new ResultCollector(connection, maxRows);
      const stream = new SQLiteRowStream(collector);
      let error = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (data: string) => {
        if (settled) return;
        try {
          if (!stream.write(data)) {
            settled = true;
            clearTimeout(deadline);
            proc.kill('SIGTERM');
            resolve(collector.result());
          }
        } catch (error) {
          settled = true;
          clearTimeout(deadline);
          proc.kill('SIGKILL');
          reject(error);
        }
      });
      proc.stderr.on('data', (data) => {
        if (error.length < 65536) error += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(deadline);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(`SQLite error: ${error}`));
          return;
        }

        resolve(collector.result());
      });
      proc.stdin.end();
    });
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
      const collector = new ResultCollector(connection, maxRows);
      const cursor = client.query(new Cursor(query, [], { rowMode: 'array' }));
      const deadline = setTimeout(() => {
        broken = true;
        timedOut = true;
        released = true;
        client.release(true);
      }, connection.limits?.timeoutMs ?? this.timeout);
      try {
        let done = false;
        while (!done) {
          const rows = await cursor.read(Math.min(64, collector.maxRows + 1));
          for (const row of rows)
            if (!collector.add(row)) {
              done = true;
              break;
            }
          if (rows.length === 0) done = true;
        }
        const metadata = (
          cursor as unknown as { _result: { fields: { name: string }[]; rowCount: number } }
        )._result;
        collector.columns = metadata.fields.map((f) => f.name);
        return collector.result(metadata.rowCount);
      } finally {
        clearTimeout(deadline);
        if (!broken) await cursor.close();
      }
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
    const request = pool.request();
    request.stream = true;
    // The promise reports request failures; streaming also emits error events.
    request.on('error', () => {});
    const collector = new ResultCollector(connection, maxRows);
    request.on('recordset', (columns: { name: string }[]) => {
      collector.columns = columns.map((c) => c.name);
    });
    request.on('row', (row: unknown[]) => {
      if (!collector.truncated && !collector.add(row)) request.cancel();
    });
    const timer = setTimeout(() => request.cancel(), connection.limits?.timeoutMs ?? this.timeout);
    try {
      const result = await request.query(query);
      return collector.result(result.rowsAffected?.[0]);
    } catch (error) {
      if (collector.truncated && (error as { code?: string }).code === 'ECANCEL')
        return collector.result();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeMySQLQuery(
    connection: DatabaseConnection,
    query: string,
    readOnly = false,
    maxRows?: number
  ): Promise<QueryResult> {
    const timeout = connection.limits?.timeoutMs ?? this.timeout;
    const entry = await this.poolManager.getPool(connection);
    const pending = (entry!.pool as mysql.Pool).getConnection();
    let abandoned = false;
    void pending.then(
      (c) => {
        if (abandoned) c.release();
      },
      () => {}
    );
    const acquireTimer = setTimeout(() => {
      abandoned = true;
    }, timeout);
    let conn: mysql.PoolConnection;
    try {
      conn = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error('MySQL connection acquisition timed out')),
            timeout
          );
          pending.finally(() => clearTimeout(t)).catch(() => {});
        }),
      ]);
    } finally {
      clearTimeout(acquireTimer);
    }
    let broken = false;
    const timer = setTimeout(() => {
      broken = true;
      conn.destroy();
    }, timeout);
    try {
      if (readOnly) await conn.query('START TRANSACTION READ ONLY');
      const collector = new ResultCollector(connection, maxRows);
      const raw = (conn as unknown as { connection: import('mysql2').PoolConnection }).connection;
      const request = raw.query({ sql: query, rowsAsArray: true });
      request.on('fields', (fields: { name: string }[]) => {
        collector.columns = fields?.map((f) => f.name) ?? [];
      });
      let affected = 0;
      const stream = request.stream({ highWaterMark: 16 });
      for await (const row of stream) {
        if (Array.isArray(row)) {
          if (!collector.add(row)) {
            broken = true;
            conn.destroy();
            break;
          }
        } else affected = (row as mysql.ResultSetHeader).affectedRows ?? 0;
      }
      return collector.result(affected);
    } catch (error) {
      broken = true;
      conn.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
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
   * Open an Oracle session for one unit of work and always close it.
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

    const conn = await oracledb.getConnection({
      user,
      password,
      connectString: options.connectString,
      configDir: options.configDir,
      privilege: options.privilege,
      connectTimeout: Math.max(1, Math.ceil(timeout / 1000)),
    });
    try {
      // Bounds every round trip, so a slow query fails instead of hanging.
      conn.callTimeout = timeout;
      return await work(conn);
    } finally {
      try {
        await conn.close();
      } catch (closeError) {
        console.error('Failed to close Oracle connection:', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
          host,
          connectString: options.connectString,
        });
      }
    }
  }

  private async executeOracleQuery(
    connection: DatabaseConnection,
    query: string,
    maxRows?: number,
    readOnly = false
  ): Promise<QueryResult> {
    return this.withOracleConnection(connection, async (conn) => {
      if (readOnly) await conn.execute('SET TRANSACTION READ ONLY');
      const res = await conn.execute<unknown[]>(normalizeOracleStatement(query), [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: !readOnly,
        resultSet: true,
        fetchTypeHandler: oracleFetchTypeHandler,
      });
      const collector = new ResultCollector(connection, maxRows);
      collector.columns = (res.metaData ?? []).map((m) => m.name);
      if (!res.resultSet) return collector.result(res.rowsAffected);
      const started = Date.now();
      try {
        let done = false;
        while (!done) {
          if (Date.now() - started > (connection.limits?.timeoutMs ?? this.timeout))
            throw new Error('Oracle query deadline exceeded');
          const rows = await res.resultSet.getRows(Math.min(64, collector.maxRows + 1));
          for (const row of rows)
            if (!collector.add(row)) {
              done = true;
              break;
            }
          if (rows.length === 0) done = true;
        }
        return collector.result();
      } finally {
        await res.resultSet.close();
      }
    });
  }

  /**
   * Estimated execution plan for an Oracle query.
   *
   * EXPLAIN PLAN only parses the statement, never runs it. The plan rows land
   * in the session's PLAN_TABLE and are discarded by the rollback.
   */
  async explainOracleQuery(connection: DatabaseConnection, query: string): Promise<QueryResult> {
    const startTime = Date.now();
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

  private async executeCli(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.executablePath, args, { stdio: this.debug ? 'inherit' : 'ignore' });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`CLI execution timed out after ${this.timeout}ms`));
      }, this.timeout);

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });

      proc.on('exit', (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`CLI process exited with code ${code}`));
        }
      });
    });
  }

  private cleanupFiles(files: string[]): void {
    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // Ignore errors
      }
    }
  }

  private async parseCSVOutput(filePath: string): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const rows: any[] = [];
      let columns: string[] = [];
      let rowCount = 0;

      // Check if file exists first
      if (!fs.existsSync(filePath)) {
        reject(new Error(`Output file not found: ${filePath}`));
        return;
      }

      try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
          resolve({ columns: [], rows: [], rowCount: 0, executionTime: 0 });
          return;
        }
      } catch {
        // If stat fails, continue and let the stream handle errors
      }

      fs.createReadStream(filePath)
        .pipe(csv())
        .on('headers', (headers) => {
          columns = headers;
        })
        .on('data', (data) => {
          rows.push(Object.values(data));
          rowCount++;
        })
        .on('end', () => {
          resolve({ columns, rows, rowCount, executionTime: 0 });
        })
        .on('error', (error) => {
          reject(new Error(`CSV parsing failed: ${error.message}`));
        });
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
              columnInfo.nullable = value === 'YES' || value === 'Y' || value === true;
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
            case 'extra':
              columnInfo.isAutoIncrement = value && value.toLowerCase().includes('auto_increment');
              break;
            case 'data_length':
            case 'character_maximum_length':
            case 'length':
              columnInfo.length = parseInt(value) || undefined;
              break;
            case 'data_precision':
            case 'numeric_precision':
            case 'precision':
              columnInfo.precision = parseInt(value) || undefined;
              break;
            case 'data_scale':
            case 'numeric_scale':
            case 'scale':
              columnInfo.scale = parseInt(value) || undefined;
              break;
          }
        });

        if (columnInfo.name) {
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

  async getDatabaseStats(connection: DatabaseConnection): Promise<DatabaseStats> {
    const startTime = Date.now();

    try {
      // Get table count
      const tables = await this.listTables(connection, undefined, true);
      const tableCount = tables.length;

      // Get server version
      const versionQuery = this.getTestQuery(connection.driver);
      const versionResult = await this.executeQuery(connection, versionQuery);
      const serverVersion = this.extractVersionFromResult(versionResult) || 'Unknown';

      return {
        connectionId: connection.id,
        tableCount,
        totalSize: 'Unknown', // Would need specific queries per database type
        connectionTime: Date.now() - startTime,
        serverVersion,
      };
    } catch {
      return {
        connectionId: connection.id,
        tableCount: 0,
        totalSize: 'Unknown',
        connectionTime: Date.now() - startTime,
        serverVersion: 'Unknown',
      };
    }
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
    } else {
      throw new Error(
        'list_databases supports PostgreSQL, MySQL/MariaDB, and SQL Server connections'
      );
    }
    const result = await this.executeQuery(connection, query, { trustedMetadata: true });
    return result.rows
      .map((row) => String(row[0]))
      .filter((database) => this.policy.allowsDatabase(connection, database));
  }

  async listTables(
    connection: DatabaseConnection,
    schema?: string,
    includeViews: boolean = false
  ): Promise<any[]> {
    try {
      const query = buildListTablesQuery(connection.driver, schema, includeViews);
      const result = await this.executeQuery(connection, query, { trustedMetadata: true });

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
        .filter((table) =>
          this.policy.allowsTable(
            connection,
            [table.table_schema ?? table.schema, table.name].filter(Boolean).join('.')
          )
        );
    } catch (error) {
      throw new Error(
        `Failed to list tables: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
