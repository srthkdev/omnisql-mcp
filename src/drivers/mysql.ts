import fs from 'fs';
import mysql from 'mysql2/promise';
import type { Pool as MySQLPool } from 'mysql2/promise';
import type {
  DBeaverConnection,
  ConnectionConfig,
  QueryResult,
  ExecuteResult,
  PoolStats,
  DriverDialect,
} from '../types.js';
import { BaseDriver } from './base.js';

/**
 * Check whether a DBeaver driver string represents a MySQL-compatible database.
 *
 * Compatible databases include MariaDB, TiDB, Vitess, SingleStore (MemSQL),
 * PlanetScale, and Amazon Aurora (MySQL-flavored, i.e. when the driver string
 * does NOT also contain "postgres").
 */
export function isMySQLCompatible(driver: string): boolean {
  const d = driver.toLowerCase();
  return (
    d.includes('mysql') ||
    d.includes('mariadb') ||
    d.includes('tidb') ||
    d.includes('vitess') ||
    d.includes('singlestore') ||
    d.includes('memsql') ||
    d.includes('planetscale') ||
    (d.includes('aurora') && !d.includes('postgres'))
  );
}

/**
 * Driver implementation for MySQL and compatible databases.
 *
 * Uses the `mysql2/promise` package with connection pooling. SSL configuration
 * is ported from the original `executeMySQLQuery` method.
 */
export class MySQLDriver extends BaseDriver {
  readonly dialect: DriverDialect = 'mysql';

  private pool!: MySQLPool;

  constructor(connection: DBeaverConnection, config?: Partial<ConnectionConfig>) {
    super(connection, config);
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    const conn = this.connection;
    const props = conn.properties ?? {};

    const host = conn.host || props.host || 'localhost';
    const port = conn.port || (props.port ? parseInt(props.port, 10) : 3306);
    const database = conn.database || props.database;
    const user = conn.user || props.user || process.env.MYSQL_USER || 'root';
    const password = props.password || process.env.MYSQL_PWD || process.env.MYSQL_PASSWORD;

    const ssl = this.buildSslConfig(props);

    this.log(`Connecting to ${host}:${port}/${database ?? '(default)'} as ${user}`);

    this.pool = mysql.createPool({
      host,
      port,
      database,
      user,
      password,
      ssl,
      connectionLimit: this.poolConfig.max,
      waitForConnections: true,
      queueLimit: 0,
      connectTimeout: this.poolConfig.acquireTimeoutMs,
      // Prevent multi-statement injection.
      multipleStatements: false,
    });

    // Verify the connection is reachable.
    const testConn = await this.pool.getConnection();
    try {
      await testConn.query('SELECT 1');
    } finally {
      testConn.release();
    }

    this.log('Connection pool established');
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      this.log('Closing connection pool');
      try {
        await this.pool.end();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Error closing pool: ${msg}`);
      }
    }
  }

  // ── Raw query execution ───────────────────────────────────────────

  async rawQuery(sql: string): Promise<QueryResult> {
    const [rows, fields] = await this.pool.query(sql);

    // SELECT / SHOW / DESCRIBE returns an array of row objects + FieldPacket[].
    if (Array.isArray(rows)) {
      const columns: string[] = Array.isArray(fields)
        ? (fields as any[]).map((f: any) => String(f.name))
        : rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null
          ? Object.keys(rows[0] as Record<string, unknown>)
          : [];

      const dataRows: unknown[][] = (rows as any[]).map((r: any) =>
        columns.map((c: string) => r[c])
      );

      return {
        columns,
        rows: dataRows,
        rowCount: dataRows.length,
        executionTime: 0,
      };
    }

    // Non-SELECT (INSERT/UPDATE/DELETE) returns an OkPacket-like object.
    const ok: any = rows;
    const affected = typeof ok?.affectedRows === 'number' ? ok.affectedRows : 0;
    return {
      columns: [],
      rows: [],
      rowCount: affected,
      executionTime: 0,
    };
  }

  async rawExecute(sql: string): Promise<ExecuteResult> {
    const [result] = await this.pool.query(sql);
    const ok: any = result;
    return {
      affectedRows: typeof ok?.affectedRows === 'number' ? ok.affectedRows : 0,
    };
  }

  // ── Pool stats ────────────────────────────────────────────────────

  getPoolStats(): PoolStats | null {
    if (!this.pool) return null;

    // mysql2 Pool does not expose detailed stats through a public API.
    // Return what we can infer from configuration.
    const pool = this.pool as any;
    const totalConnections = pool?.pool?._allConnections?.length ?? this.poolConfig.max;
    const freeConnections = pool?.pool?._freeConnections?.length ?? 0;
    const queueLength = pool?.pool?._connectionQueue?.length ?? 0;

    return {
      connectionId: this.connectionId,
      totalConnections,
      idleConnections: freeConnections,
      activeConnections: totalConnections - freeConnections,
      waitingRequests: queueLength,
    };
  }

  // ── SSL configuration (ported from executeMySQLQuery) ─────────────

  /**
   * Build the SSL config from DBeaver connection properties.
   *
   * Supports property keys:
   *   ssl.mode, sslMode, sslmode, useSSL, ssl — mode string
   *   ssl.ca, sslCA, sslrootcert              — CA certificate path
   *   ssl.cert, sslCert, sslcert              — Client certificate path
   *   ssl.key, sslKey, sslkey                 — Client key path
   *
   * Modes:
   *   require / verify-ca / verify-full / true / 1 / preferred / enabled / yes — enable SSL
   *   disable / false / 0 / none / off / no — disable SSL
   */
  private buildSslConfig(props: Record<string, string>): any {
    const sslModeRaw =
      props['ssl.mode'] || props['sslMode'] || props['sslmode'] || props['useSSL'] || props['ssl'];
    const sslMode = String(sslModeRaw ?? '').toLowerCase();

    const sslCa = props['ssl.ca'] || props['sslCA'] || props['sslrootcert'];
    const sslCert = props['ssl.cert'] || props['sslCert'] || props['sslcert'];
    const sslKey = props['ssl.key'] || props['sslKey'] || props['sslkey'];

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
      const sslObj: Record<string, unknown> = {};

      try {
        if (sslCa && fs.existsSync(String(sslCa))) {
          sslObj.ca = fs.readFileSync(String(sslCa)).toString();
        }
        if (sslCert && fs.existsSync(String(sslCert))) {
          sslObj.cert = fs.readFileSync(String(sslCert)).toString();
        }
        if (sslKey && fs.existsSync(String(sslKey))) {
          sslObj.key = fs.readFileSync(String(sslKey)).toString();
        }
      } catch {
        // Ignore and let mysql2 use defaults.
      }

      return sslObj;
    }

    if (disableSsl) {
      return undefined;
    }

    // No explicit mode — return undefined so mysql2 uses its default behavior.
    return undefined;
  }
}
