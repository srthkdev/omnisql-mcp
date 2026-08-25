import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import csv from 'csv-parser';
import { Client } from 'pg';
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
import { isIamAuthConnection, resolveIamCredentials } from './auth/iam-auth.js';
import { sshTunnelManager } from './net/ssh-tunnel.js';
import { resolvePostgresSsl, resolveMysqlSsl } from './auth/ssl.js';

export class WorkspaceClient {
  private executablePath: string;
  private timeout: number;
  private debug: boolean;
  private workspacePath?: string;

  constructor(
    executablePath?: string,
    timeout: number = 30000,
    debug: boolean = false,
    workspacePath?: string
  ) {
    this.executablePath = executablePath || findCliExecutable();
    this.timeout = timeout;
    this.debug = debug;
    this.workspacePath = workspacePath;
  }

  async executeQuery(connection: DatabaseConnection, query: string): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      // Use native database drivers; fall back to the CLI for unsupported drivers
      const result = await this.executeWithNativeTool(connection, query);
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
    }
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
    const schemaQuery = this.buildSchemaQuery(connection.driver, tableName);
    const result = await this.executeQuery(connection, schemaQuery);

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
    query: string
  ): Promise<QueryResult> {
    const driver = connection.driver.toLowerCase();

    if (driver.includes('sqlite')) {
      return this.executeSQLiteQuery(connection, query);
    } else if (this.isPostgresCompatible(driver)) {
      return this.executePostgreSQLQuery(connection, query);
    } else if (
      driver.includes('mssql') ||
      driver.includes('sqlserver') ||
      driver.includes('microsoft')
    ) {
      return this.executeSQLServerQuery(connection, query);
    } else if (driver.includes('mysql') || driver.includes('mariadb')) {
      return this.executeMySQLQuery(connection, query);
    } else {
      // Unsupported driver – try the CLI as a best-effort fallback, but
      // wrap with a clear error message listing the natively supported drivers.
      try {
        return await this.executeViaCli(connection, query);
      } catch (cliError) {
        const driverName = connection.driver;
        const nativeDrivers =
          'PostgreSQL (+ CockroachDB, TimescaleDB, Redshift, YugabyteDB, Supabase, Neon, Citus, AlloyDB), MySQL/MariaDB, SQL Server (MSSQL), SQLite';
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
    query: string
  ): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const dbPath = connection.properties?.database || connection.database;
      if (!dbPath) {
        reject(new Error('SQLite database path not found'));
        return;
      }

      const proc = spawn('sqlite3', [dbPath, '-header', '-csv'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // A failed spawn surfaces twice: once as 'error' on the child, and again
      // as EPIPE on the stdin we write to below. Both are 'error' events with
      // no listener, which Node turns into an uncaught throw that takes the
      // whole MCP server down instead of failing this one tool call.
      let settled = false;
      const fail = (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
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

      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(`SQLite error: ${error}`));
          return;
        }

        const lines = output.trim().split('\n');
        if (lines.length === 0) {
          resolve({ columns: [], rows: [], rowCount: 0, executionTime: 0 });
          return;
        }

        const columns = lines[0].split(',');
        const rows = lines.slice(1).map((line) => line.split(','));

        resolve({ columns, rows, rowCount: rows.length, executionTime: 0 });
      });

      try {
        proc.stdin.write(query);
        proc.stdin.end();
      } catch (err) {
        fail(err as NodeJS.ErrnoException);
      }
    });
  }

  private async executePostgreSQLQuery(
    connection: DatabaseConnection,
    query: string
  ): Promise<QueryResult> {
    const { host, port } = await this.resolveEndpoint(connection, 5432);
    const database = connection.database || connection.properties?.database || 'postgres';

    // IAM-authenticated connections store no credential, so mint a short-lived
    // token and authenticate with that. This also resolves the username, which
    // such connections frequently omit.
    const iamAuth = isIamAuthConnection(connection);
    const iamCreds = iamAuth
      ? await resolveIamCredentials(connection, 5432, { debug: this.debug })
      : undefined;

    const user =
      iamCreds?.user ||
      connection.user ||
      connection.properties?.user ||
      process.env.PGUSER ||
      'postgres';
    const password =
      iamCreds?.password || connection.properties?.password || process.env.PGPASSWORD;

    const ssl = resolvePostgresSsl(connection, iamAuth, this.debug);

    const client = new Client({ host, port, database, user, password, ssl });
    try {
      await client.connect();
      const res = await client.query(query);
      const columns: string[] = (res.fields || []).map((f: any) => f.name as string);
      const rows: any[][] = (res.rows || []).map((r: any) => columns.map((c: string) => r[c]));
      return {
        columns,
        rows,
        rowCount: typeof res.rowCount === 'number' ? res.rowCount : rows.length,
        executionTime: 0,
      };
    } finally {
      try {
        await client.end();
      } catch (closeError) {
        // ALWAYS log connection cleanup failures - they indicate resource leaks
        console.error('Failed to close PostgreSQL connection:', {
          error: closeError instanceof Error ? closeError.message : String(closeError),
          host,
          database,
        });
      }
    }
  }

  private async executeSQLServerQuery(
    connection: DatabaseConnection,
    query: string
  ): Promise<QueryResult> {
    const { host, port } = await this.resolveEndpoint(connection, 1433);
    const database = connection.database || connection.properties?.database || 'master';
    const user = connection.user || connection.properties?.user;
    const password = connection.properties?.password;

    if (!user || !password) {
      throw new Error('User and password are required for SQL Server connection');
    }

    // Judge Azure from the configured host: through a tunnel `host` is a
    // loopback address and would read as an ordinary on-prem server.
    const isAzure = (connection.host || host).includes('.database.windows.net');
    const config = {
      user,
      password,
      server: host,
      port,
      database,
      options: {
        encrypt: isAzure,
        trustServerCertificate: !isAzure,
      },
    };

    try {
      const pool = await sql.connect(config);
      const result = await pool.request().query(query);

      const columns: string[] = [];
      const rows: any[][] = [];
      let rowCount = 0;

      if (result.recordset) {
        if (result.recordset.length > 0) {
          columns.push(...Object.keys(result.recordset[0]));
          rows.push(...result.recordset.map((row) => Object.values(row)));
        } else if (result.recordset.columns) {
          Object.values(result.recordset.columns).forEach((col: any) => {
            columns.push(col.name);
          });
        }
        rowCount = result.rowsAffected[0] || result.recordset.length;
      } else {
        rowCount = result.rowsAffected[0] || 0;
      }

      await pool.close();

      return {
        columns,
        rows,
        rowCount,
        executionTime: 0,
      };
    } catch (error) {
      throw new Error(
        `SQL Server error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async executeMySQLQuery(
    connection: DatabaseConnection,
    query: string
  ): Promise<QueryResult> {
    const { host, port } = await this.resolveEndpoint(connection, 3306);
    const database = connection.database || connection.properties?.database;

    // IAM-authenticated connections store no credential, so mint a short-lived
    // token and authenticate with that. mysql2 answers RDS's auth-plugin switch
    // with mysql_clear_password out of the box, safe over the TLS we force below.
    const iamAuth = isIamAuthConnection(connection);
    const iamCreds = iamAuth
      ? await resolveIamCredentials(connection, 3306, { debug: this.debug })
      : undefined;

    const user =
      iamCreds?.user ||
      connection.user ||
      connection.properties?.user ||
      process.env.MYSQL_USER ||
      'root';
    const password =
      iamCreds?.password ||
      connection.properties?.password ||
      process.env.MYSQL_PWD ||
      process.env.MYSQL_PASSWORD;

    const ssl = resolveMysqlSsl(connection, iamAuth);

    const connectTimeout = Math.max(1000, this.timeout);
    const connectionConfig: mysql.ConnectionOptions = {
      host,
      port,
      user,
      password,
      database,
      ssl,
      connectTimeout,
      // Important: avoid multi-statement execution for safety
      multipleStatements: false,
    };

    const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${this.timeout}ms`)),
          this.timeout
        );
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    let conn: mysql.Connection | undefined;
    try {
      conn = await withTimeout(mysql.createConnection(connectionConfig), 'MySQL connect');
      const [rows, fields] = await withTimeout(conn.query(query), 'MySQL query');

      // SELECT/SHOW/DESCRIBE return rows as array of objects; fields includes column metadata
      if (Array.isArray(rows)) {
        const columns: string[] = Array.isArray(fields)
          ? (fields as any[]).map((f: any) => String(f.name))
          : rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null
            ? Object.keys(rows[0] as any)
            : [];
        const dataRows: any[][] = rows.map((r: any) => columns.map((c: string) => (r as any)[c]));
        return { columns, rows: dataRows, rowCount: rows.length, executionTime: 0 };
      }

      // Non-SELECT returns OkPacket-like object
      const ok: any = rows;
      const affected = typeof ok?.affectedRows === 'number' ? ok.affectedRows : 0;
      return { columns: [], rows: [], rowCount: affected, executionTime: 0 };
    } finally {
      if (conn) {
        try {
          await conn.end();
        } catch (closeError) {
          console.error('Failed to close MySQL connection:', {
            error: closeError instanceof Error ? closeError.message : String(closeError),
            host,
            database,
          });
        }
      }
    }
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
            case 'is_nullable':
            case 'nullable':
              columnInfo.nullable = value === 'YES' || value === 'Y' || value === true;
              break;
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
            case 'character_maximum_length':
            case 'length':
              columnInfo.length = parseInt(value) || undefined;
              break;
            case 'numeric_precision':
            case 'precision':
              columnInfo.precision = parseInt(value) || undefined;
              break;
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

  async listTables(
    connection: DatabaseConnection,
    schema?: string,
    includeViews: boolean = false
  ): Promise<any[]> {
    try {
      const query = buildListTablesQuery(connection.driver, schema, includeViews);
      const result = await this.executeQuery(connection, query);

      // Convert result to table objects
      return result.rows.map((row) => {
        const tableObj: any = {};
        result.columns.forEach((col, idx) => {
          tableObj[col] = row[idx];
        });
        return tableObj;
      });
    } catch (error) {
      if (this.debug) {
        console.error(`Failed to list tables: ${error}`);
      }
      // Return empty array instead of crashing
      return [];
    }
  }
}
