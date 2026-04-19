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
        throw new Error(
          `Database driver "${driverName}" is not natively supported. ` +
            `Natively supported drivers: ${nativeDrivers}. ` +
            `CLI fallback also failed: ${cliMsg}. ` +
            `To use "${driverName}", consider connecting through a supported driver ` +
            `(e.g. via an ODBC/JDBC bridge) or ensure a compatible DB client CLI is installed and ` +
            `the connection is configured in your workspace.`
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

      let output = '';
      let error = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        error += data.toString();
      });

      proc.on('close', (code) => {
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

      proc.stdin.write(query);
      proc.stdin.end();
    });
  }

  private async executePostgreSQLQuery(
    connection: DatabaseConnection,
    query: string
  ): Promise<QueryResult> {
    const host = connection.host || connection.properties?.host || 'localhost';
    const port =
      connection.port ||
      (connection.properties?.port ? parseInt(connection.properties.port) : 5432);
    const database = connection.database || connection.properties?.database || 'postgres';
    const user = connection.user || connection.properties?.user || process.env.PGUSER || 'postgres';
    const password = connection.properties?.password || process.env.PGPASSWORD;

    // SSL handling
    // The workspace JSON config format stores driver properties under a nested `properties` key,
    // and SSL handler config under `handlers.postgre_ssl`. Check all locations.
    const nestedProps =
      (connection.properties?.['properties'] as unknown as Record<string, unknown>) || {};
    const sslHandler = (
      connection.properties?.['handlers'] as unknown as Record<string, unknown> | undefined
    )?.['postgre_ssl'] as Record<string, unknown> | undefined;
    const sslModeRaw =
      connection.properties?.['ssl.mode'] ||
      connection.properties?.['sslmode'] ||
      connection.properties?.['ssl'] ||
      nestedProps['sslmode'] ||
      nestedProps['ssl'] ||
      (sslHandler?.enabled
        ? (sslHandler?.properties as Record<string, unknown>)?.['sslMode'] || 'require'
        : undefined);
    const sslMode = String(sslModeRaw ?? '').toLowerCase();
    const sslRootCert =
      connection.properties?.['sslrootcert'] ||
      connection.properties?.['ssl.root.cert'] ||
      connection.properties?.['sslRootCert'];
    const sslCert =
      connection.properties?.['sslcert'] ||
      connection.properties?.['ssl.cert'] ||
      connection.properties?.['sslCert'];
    const sslKey =
      connection.properties?.['sslkey'] ||
      connection.properties?.['ssl.key'] ||
      connection.properties?.['sslKey'];

    let ssl: any = undefined;
    const requireSsl = ['require', 'verify-ca', 'verify-full', 'true', '1'].includes(sslMode);
    const verifyModes = ['verify-ca', 'verify-full'];
    const disableSsl = ['disable', 'false', '0'].includes(sslMode);
    if (requireSsl) {
      const sslObj: any = {};
      try {
        if (sslRootCert && fs.existsSync(String(sslRootCert)))
          sslObj.ca = fs.readFileSync(String(sslRootCert)).toString();
        if (sslCert && fs.existsSync(String(sslCert)))
          sslObj.cert = fs.readFileSync(String(sslCert)).toString();
        if (sslKey && fs.existsSync(String(sslKey)))
          sslObj.key = fs.readFileSync(String(sslKey)).toString();
      } catch {
        // ignore errors, we'll set a reasonable default below
      }
      const hasCa = typeof sslObj.ca === 'string' && sslObj.ca.length > 0;
      if (verifyModes.includes(sslMode)) {
        // Enforce certificate verification. If no custom CA is provided, fallback to system trust store.
        sslObj.rejectUnauthorized = true;
        if (this.debug && !hasCa) {
          console.warn(
            'sslMode set to verify-ca/verify-full but no sslrootcert provided; using system CA store'
          );
        }
      } else {
        // "require" mode: encrypt without verification
        sslObj.rejectUnauthorized = false;
      }
      ssl = sslObj;
    } else if (disableSsl) {
      ssl = false;
    }

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
    const host = connection.host || connection.properties?.host || 'localhost';
    const port = parseInt(String(connection.port || connection.properties?.port || '1433'));
    const database = connection.database || connection.properties?.database || 'master';
    const user = connection.user || connection.properties?.user;
    const password = connection.properties?.password;

    if (!user || !password) {
      throw new Error('User and password are required for SQL Server connection');
    }

    const isAzure = host.includes('.database.windows.net');
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
    const host = connection.host || connection.properties?.host || 'localhost';
    const port =
      connection.port ||
      (connection.properties?.port ? parseInt(connection.properties.port) : 3306);
    const database = connection.database || connection.properties?.database;
    const user = connection.user || connection.properties?.user || process.env.MYSQL_USER || 'root';
    const password =
      connection.properties?.password || process.env.MYSQL_PWD || process.env.MYSQL_PASSWORD;

    // SSL handling (best-effort; varies across workspace driver configs)
    const sslModeRaw =
      connection.properties?.['ssl.mode'] ||
      connection.properties?.['sslMode'] ||
      connection.properties?.['sslmode'] ||
      connection.properties?.['useSSL'] ||
      connection.properties?.['ssl'];
    const sslMode = String(sslModeRaw ?? '').toLowerCase();
    const sslCa =
      connection.properties?.['ssl.ca'] ||
      connection.properties?.['sslCA'] ||
      connection.properties?.['sslrootcert'];
    const sslCert =
      connection.properties?.['ssl.cert'] ||
      connection.properties?.['sslCert'] ||
      connection.properties?.['sslcert'];
    const sslKey =
      connection.properties?.['ssl.key'] ||
      connection.properties?.['sslKey'] ||
      connection.properties?.['sslkey'];

    let ssl: any = undefined;
    const requireSsl = [
      'require',
      'verify-ca',
      'verify-full',
      'true',
      '1',
      'preferred',
      'enabled',
      'yes',
    ].includes(sslMode);
    const disableSsl = ['disable', 'false', '0', 'none', 'off', 'no'].includes(sslMode);
    if (requireSsl) {
      const sslObj: any = {};
      try {
        if (sslCa && fs.existsSync(String(sslCa)))
          sslObj.ca = fs.readFileSync(String(sslCa)).toString();
        if (sslCert && fs.existsSync(String(sslCert)))
          sslObj.cert = fs.readFileSync(String(sslCert)).toString();
        if (sslKey && fs.existsSync(String(sslKey)))
          sslObj.key = fs.readFileSync(String(sslKey)).toString();
      } catch {
        // ignore and let mysql2 use defaults
      }
      // For MySQL, verification behavior depends on the TLS layer. If CA is provided, mysql2 will verify.
      ssl = sslObj;
    } else if (disableSsl) {
      ssl = undefined;
    }

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
