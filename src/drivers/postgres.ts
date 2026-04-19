import fs from 'fs';
import { Pool } from 'pg';
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
 * Check whether a DBeaver driver string represents a Postgres-compatible database.
 *
 * Compatible databases include CockroachDB, TimescaleDB, Amazon Redshift,
 * YugabyteDB, AlloyDB, Aurora (Postgres), Supabase, Neon, and Citus.
 */
export function isPostgresCompatible(driver: string): boolean {
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

/**
 * Driver implementation for PostgreSQL and compatible databases.
 *
 * Uses the `pg` package with connection pooling. SSL configuration is ported
 * from the original `executePostgreSQLQuery` method and supports all DBeaver
 * SSL property variants (ssl.mode, sslmode, ssl, sslrootcert, sslcert, sslkey,
 * verify-ca, verify-full, require, disable).
 */
export class PostgresDriver extends BaseDriver {
  readonly dialect: DriverDialect = 'postgres';

  private pool!: Pool;

  constructor(connection: DBeaverConnection, config?: Partial<ConnectionConfig>) {
    super(connection, config);
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    const conn = this.connection;
    const props = conn.properties ?? {};

    const host = conn.host || props.host || 'localhost';
    const port = conn.port || (props.port ? parseInt(props.port, 10) : 5432);
    const database = conn.database || props.database || 'postgres';
    const user = conn.user || props.user || process.env.PGUSER || 'postgres';
    const password = props.password || process.env.PGPASSWORD;

    const ssl = this.buildSslConfig(props);

    this.log(`Connecting to ${host}:${port}/${database} as ${user}`);

    this.pool = new Pool({
      host,
      port,
      database,
      user,
      password,
      ssl,
      min: this.poolConfig.min,
      max: this.poolConfig.max,
      idleTimeoutMillis: this.poolConfig.idleTimeoutMs,
      connectionTimeoutMillis: this.poolConfig.acquireTimeoutMs,
    });

    // Attach an error handler so idle-client errors don't crash the process.
    this.pool.on('error', (err) => {
      this.log(`Idle pool client error: ${err.message}`);
    });

    // Verify the connection is reachable.
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
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
    const res = await this.pool.query(sql);
    const columns: string[] = (res.fields || []).map((f) => f.name);
    const rows: unknown[][] = (res.rows || []).map((row: Record<string, unknown>) =>
      columns.map((col) => row[col])
    );

    return {
      columns,
      rows,
      rowCount: typeof res.rowCount === 'number' ? res.rowCount : rows.length,
      executionTime: 0,
    };
  }

  async rawExecute(sql: string): Promise<ExecuteResult> {
    const res = await this.pool.query(sql);
    return {
      affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
    };
  }

  // ── Pool stats ────────────────────────────────────────────────────

  getPoolStats(): PoolStats | null {
    if (!this.pool) return null;

    return {
      connectionId: this.connectionId,
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      activeConnections: this.pool.totalCount - this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
    };
  }

  // ── SSL configuration (ported from executePostgreSQLQuery) ────────

  /**
   * Build the SSL config object from DBeaver connection properties.
   *
   * Supports the following property keys (case-insensitive lookups):
   *   ssl.mode, sslmode, ssl      — mode string
   *   sslrootcert, ssl.root.cert  — CA certificate path
   *   sslcert, ssl.cert           — Client certificate path
   *   sslkey, ssl.key             — Client key path
   *
   * Modes:
   *   require       — encrypt, but do not verify the server certificate
   *   verify-ca     — encrypt and verify CA
   *   verify-full   — encrypt and verify CA + hostname
   *   true / 1      — same as require
   *   disable / false / 0 — explicitly disable SSL
   *   (empty)       — undefined (pg driver default behavior)
   */
  private buildSslConfig(props: Record<string, string>): any {
    const sslModeRaw = props['ssl.mode'] || props['sslmode'] || props['ssl'];
    const sslMode = String(sslModeRaw ?? '').toLowerCase();

    const sslRootCert = props['sslrootcert'] || props['ssl.root.cert'] || props['sslRootCert'];
    const sslCert = props['sslcert'] || props['ssl.cert'] || props['sslCert'];
    const sslKey = props['sslkey'] || props['ssl.key'] || props['sslKey'];

    const requireSsl = ['require', 'verify-ca', 'verify-full', 'true', '1'].includes(sslMode);
    const verifyModes = ['verify-ca', 'verify-full'];
    const disableSsl = ['disable', 'false', '0'].includes(sslMode);

    if (requireSsl) {
      const sslObj: Record<string, unknown> = {};

      // Read certificate files if they exist.
      try {
        if (sslRootCert && fs.existsSync(String(sslRootCert))) {
          sslObj.ca = fs.readFileSync(String(sslRootCert)).toString();
        }
        if (sslCert && fs.existsSync(String(sslCert))) {
          sslObj.cert = fs.readFileSync(String(sslCert)).toString();
        }
        if (sslKey && fs.existsSync(String(sslKey))) {
          sslObj.key = fs.readFileSync(String(sslKey)).toString();
        }
      } catch {
        // Ignore file read errors; fall back to defaults.
      }

      if (verifyModes.includes(sslMode)) {
        // Enforce certificate verification.
        sslObj.rejectUnauthorized = true;
        const hasCa = typeof sslObj.ca === 'string' && (sslObj.ca as string).length > 0;
        if (this.debug && !hasCa) {
          this.log(
            'sslMode set to verify-ca/verify-full but no sslrootcert provided; using system CA store'
          );
        }
      } else {
        // "require" mode: encrypt without verification.
        sslObj.rejectUnauthorized = false;
      }

      return sslObj;
    }

    if (disableSsl) {
      return false;
    }

    // No explicit SSL mode set — return undefined so the pg driver uses its default.
    return undefined;
  }
}
