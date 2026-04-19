import sql from 'mssql';
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
 * Check whether a DBeaver driver string represents SQL Server.
 */
export function isSQLServer(driver: string): boolean {
  const d = driver.toLowerCase();
  return d.includes('mssql') || d.includes('sqlserver') || d.includes('microsoft');
}

/**
 * Driver implementation for Microsoft SQL Server.
 *
 * Uses the `mssql` package with its built-in connection pooling.
 * Azure SQL detection is ported from the original `executeSQLServerQuery` method
 * and automatically enables encryption for *.database.windows.net hosts.
 */
export class MSSQLDriver extends BaseDriver {
  readonly dialect: DriverDialect = 'mssql';

  private pool!: sql.ConnectionPool;

  constructor(connection: DBeaverConnection, config?: Partial<ConnectionConfig>) {
    super(connection, config);
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    const conn = this.connection;
    const props = conn.properties ?? {};

    const host = conn.host || props.host || 'localhost';
    const port = parseInt(String(conn.port || props.port || '1433'), 10);
    const database = conn.database || props.database || 'master';
    const user = conn.user || props.user;
    const password = props.password;

    if (!user || !password) {
      throw new Error('User and password are required for SQL Server connection');
    }

    const isAzure = host.includes('.database.windows.net');

    this.log(`Connecting to ${host}:${port}/${database} as ${user} (Azure: ${isAzure})`);

    const config: sql.config = {
      user,
      password,
      server: host,
      port,
      database,
      pool: {
        min: this.poolConfig.min,
        max: this.poolConfig.max,
        idleTimeoutMillis: this.poolConfig.idleTimeoutMs,
        acquireTimeoutMillis: this.poolConfig.acquireTimeoutMs,
      },
      options: {
        encrypt: isAzure,
        trustServerCertificate: !isAzure,
      },
    };

    this.pool = new sql.ConnectionPool(config);
    await this.pool.connect();

    this.log('Connection pool established');
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      this.log('Closing connection pool');
      try {
        await this.pool.close();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Error closing pool: ${msg}`);
      }
    }
  }

  // ── Raw query execution ───────────────────────────────────────────

  async rawQuery(queryText: string): Promise<QueryResult> {
    const result = await this.pool.request().query(queryText);

    const columns: string[] = [];
    const rows: unknown[][] = [];
    let rowCount = 0;

    if (result.recordset) {
      if (result.recordset.length > 0) {
        columns.push(...Object.keys(result.recordset[0]));
        rows.push(...result.recordset.map((row) => Object.values(row)));
      } else if (result.recordset.columns) {
        // Empty result set — still extract column names from metadata.
        for (const col of Object.values(result.recordset.columns) as any[]) {
          columns.push(col.name);
        }
      }
      rowCount = result.rowsAffected[0] ?? result.recordset.length;
    } else {
      rowCount = result.rowsAffected[0] ?? 0;
    }

    return {
      columns,
      rows,
      rowCount,
      executionTime: 0,
    };
  }

  async rawExecute(queryText: string): Promise<ExecuteResult> {
    const result = await this.pool.request().query(queryText);
    return {
      affectedRows: result.rowsAffected[0] ?? 0,
    };
  }

  // ── Pool stats ────────────────────────────────────────────────────

  getPoolStats(): PoolStats | null {
    if (!this.pool) return null;

    const inner = (this.pool as any).pool;
    if (!inner) {
      return {
        connectionId: this.connectionId,
        totalConnections: 0,
        idleConnections: 0,
        activeConnections: 0,
        waitingRequests: 0,
      };
    }

    const size = typeof inner.size === 'number' ? inner.size : 0;
    const available = typeof inner.available === 'number' ? inner.available : 0;
    const pending = typeof inner.pending === 'number' ? inner.pending : 0;

    return {
      connectionId: this.connectionId,
      totalConnections: size,
      idleConnections: available,
      activeConnections: size - available,
      waitingRequests: pending,
    };
  }
}
