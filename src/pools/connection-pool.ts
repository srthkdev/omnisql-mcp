import { createHash } from 'node:crypto';
import { readConnectionProp } from '../auth/connection-props.js';
import { booleanSetting } from '../runtime-config.js';
import type { Pool as PgPool } from 'pg';
import type mysql from 'mysql2/promise';
import type { Pool as MySqlPool } from 'mysql2/promise';
import type { ConnectionPool as MssqlPool } from 'mssql';
import { DatabaseConnection, PoolConfig, PoolStats } from '../types.js';
import { isIamAuthConnection, resolveIamCredentials } from '../auth/iam-auth.js';
import { sshTunnelManager } from '../net/ssh-tunnel.js';
import { resolvePostgresSsl, resolveMysqlSsl } from '../auth/ssl.js';

const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 0,
  max: 4,
  idleTimeoutMs: 30000,
  acquireTimeoutMs: 10000,
};

interface PoolEntry {
  pool: PgPool | MySqlPool | MssqlPool;
  type: 'postgres' | 'mysql' | 'mssql';
  config: PoolConfig;
  createdAt: Date;
  connectionId: string;
}

export class ConnectionPoolManager {
  private pools: Map<string, PoolEntry> = new Map();
  private pendingCreation: Map<string, Promise<PoolEntry | null>> = new Map();
  private config: PoolConfig;
  private debug: boolean;

  constructor(
    config?: Partial<PoolConfig>,
    debug = false,
    private queryTimeoutMs = 30000
  ) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    if (
      !Number.isInteger(this.config.min) ||
      this.config.min < 0 ||
      !Number.isInteger(this.config.max) ||
      this.config.max < 1 ||
      this.config.max > 32 ||
      this.config.min > this.config.max ||
      !Number.isFinite(this.config.idleTimeoutMs) ||
      this.config.idleTimeoutMs < 1 ||
      !Number.isFinite(this.config.acquireTimeoutMs) ||
      this.config.acquireTimeoutMs < 1
    )
      throw new Error('Invalid connection pool limits');
    this.debug = debug;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[ConnectionPool] ${message}`);
    }
  }

  async getPool(connection: DatabaseConnection): Promise<PoolEntry | null> {
    const port = this.isPostgresCompatible(connection.driver)
      ? 5432
      : /mysql|mariadb/.test(connection.driver)
        ? 3306
        : 1433;
    const endpoint = await this.resolveEndpoint(connection, port);
    const poolKey = createHash('sha256')
      .update(
        JSON.stringify([
          {
            ...connection,
            accessRules: undefined,
            limits: {
              timeoutMs: connection.limits?.timeoutMs,
              poolMax: connection.limits?.poolMax,
            },
          },
          endpoint,
        ])
      )
      .digest('hex');

    // Return existing pool
    if (this.pools.has(poolKey)) {
      this.log(`Reusing existing pool for ${connection.name}`);
      return this.pools.get(poolKey)!;
    }

    // If another call is already creating this pool, wait for it
    if (this.pendingCreation.has(poolKey)) {
      this.log(`Waiting for pending pool creation for ${connection.name}`);
      return this.pendingCreation.get(poolKey)!;
    }

    // Create the pool with deduplication
    if (this.pools.size + this.pendingCreation.size >= 32)
      throw new Error('Connection pool limit reached; close unused connections');
    const creationPromise = this.createPool(connection).then((entry) => {
      if (entry) this.pools.set(poolKey, entry);
      return entry;
    });
    this.pendingCreation.set(poolKey, creationPromise);

    try {
      return await creationPromise;
    } finally {
      this.pendingCreation.delete(poolKey);
    }
  }

  private async createPool(connection: DatabaseConnection): Promise<PoolEntry | null> {
    const driver = connection.driver.toLowerCase();

    try {
      if (this.isPostgresCompatible(driver)) {
        return await this.createPostgresPool(connection);
      } else if (driver.includes('mysql') || driver.includes('mariadb')) {
        return await this.createMysqlPool(connection);
      } else if (driver.includes('mssql') || driver.includes('sqlserver')) {
        return await this.createMssqlPool(connection);
      }
    } catch (error) {
      this.log(`Failed to create pool for ${connection.name}: ${error}`);
      throw error;
    }

    return null;
  }

  /**
   * Check if a driver uses the Postgres wire protocol.
   * Includes CockroachDB, TimescaleDB, Redshift, YugabyteDB, AlloyDB, Aurora Postgres, etc.
   */
  isPostgresCompatible(driver: string): boolean {
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
   * Where to actually connect. A tunneled connection's recorded host/port are
   * the database as seen from the SSH server, so they are resolved through the
   * local forward instead; failing to open it throws rather than falling back
   * to an address that would reach something else entirely.
   */
  private async resolveEndpoint(
    connection: DatabaseConnection,
    defaultPort: number
  ): Promise<{ host: string; port: number }> {
    const tunnel = await sshTunnelManager.resolveEndpoint(connection, defaultPort);
    if (tunnel) {
      return tunnel;
    }
    return { host: connection.host || 'localhost', port: connection.port || defaultPort };
  }

  private async createPostgresPool(connection: DatabaseConnection): Promise<PoolEntry> {
    const config = { ...this.config, max: connection.limits?.poolMax ?? this.config.max };
    config.min = Math.min(config.min, config.max);
    const timeout = connection.limits?.timeoutMs ?? this.queryTimeoutMs;
    this.log(`Creating PostgreSQL pool for ${connection.name}`);

    const { host, port } = await this.resolveEndpoint(connection, 5432);
    const iamAuth = isIamAuthConnection(connection);
    const resolvedSsl = resolvePostgresSsl(connection, iamAuth, this.debug);
    const ssl = resolvedSsl;

    let user = connection.user;
    let password: string | (() => Promise<string>) | undefined = connection.properties?.password;

    if (iamAuth) {
      // Resolve the username once, but hand pg a password *function*: it is
      // invoked per physical connection, so a pool outliving the token's
      // 15-minute lifetime still authenticates with a fresh one.
      const creds = await resolveIamCredentials(connection, 5432, { debug: this.debug });
      user = creds.user;
      password = async () =>
        (await resolveIamCredentials(connection, 5432, { debug: this.debug })).password;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({
      host,
      port,
      database: connection.database || connection.properties?.database,
      user: user || connection.properties?.user || process.env.PGUSER || 'postgres',
      password: password || process.env.PGPASSWORD,
      statement_timeout: timeout,
      min: config.min,
      max: config.max,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.acquireTimeoutMs,
      ssl,
    });

    pool.on('error', (error) => this.log(`Idle PostgreSQL connection error: ${error.message}`));
    const entry: PoolEntry = {
      pool,
      type: 'postgres',
      config: config,
      createdAt: new Date(),
      connectionId: connection.id,
    };

    return entry;
  }

  private async createMysqlPool(connection: DatabaseConnection): Promise<PoolEntry> {
    const config = { ...this.config, max: connection.limits?.poolMax ?? this.config.max };
    config.min = Math.min(config.min, config.max);
    const timeout = connection.limits?.timeoutMs ?? this.queryTimeoutMs;
    this.log(`Creating MySQL pool for ${connection.name}`);

    const { host, port } = await this.resolveEndpoint(connection, 3306);
    const iamAuth = isIamAuthConnection(connection);
    const ssl = resolveMysqlSsl(connection, iamAuth);

    let user = connection.user;
    let password = connection.properties?.password;
    let authPlugins: mysql.PoolOptions['authPlugins'];

    if (iamAuth) {
      const creds = await resolveIamCredentials(connection, 3306, { debug: this.debug });
      user = creds.user;
      password = creds.password;
      // RDS switches IAM users to mysql_clear_password. mysql2 invokes this
      // factory per physical connection, so mint a fresh token there and a
      // pool outliving the token's 15-minute lifetime keeps working.
      authPlugins = {
        mysql_clear_password: () => async () => {
          const fresh = await resolveIamCredentials(connection, 3306, { debug: this.debug });
          return Buffer.from(`${fresh.password}\0`);
        },
      };
    }

    const { default: mysql } = await import('mysql2/promise');
    const pool = mysql.createPool({
      host,
      port,
      database: connection.database || connection.properties?.database,
      user: user || connection.properties?.user || process.env.MYSQL_USER || 'root',
      password: password || process.env.MYSQL_PWD || process.env.MYSQL_PASSWORD,
      ssl,
      authPlugins,
      rowsAsArray: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      connectionLimit: config.max,
      waitForConnections: true,
      queueLimit: 32,
      maxIdle: config.max,
      idleTimeout: config.idleTimeoutMs,
      connectTimeout: Math.min(config.acquireTimeoutMs, timeout),
    });

    const entry: PoolEntry = {
      pool,
      type: 'mysql',
      config: config,
      createdAt: new Date(),
      connectionId: connection.id,
    };

    return entry;
  }

  private async createMssqlPool(connection: DatabaseConnection): Promise<PoolEntry> {
    const config = { ...this.config, max: connection.limits?.poolMax ?? this.config.max };
    config.min = Math.min(config.min, config.max);
    const timeout = connection.limits?.timeoutMs ?? this.queryTimeoutMs;
    this.log(`Creating MSSQL pool for ${connection.name}`);

    const { host, port } = await this.resolveEndpoint(connection, 1433);
    // Judge Azure from the configured host: through a tunnel `host` is a
    // loopback address and would read as an ordinary on-prem server.
    const isAzure = (connection.host || host).includes('.database.windows.net');

    const { default: sql } = await import('mssql');
    const pool = new sql.ConnectionPool({
      server: host,
      port,
      database: connection.database || connection.properties?.database,
      user: connection.user,
      password: connection.properties?.password,
      pool: {
        min: config.min,
        max: config.max,
        idleTimeoutMillis: config.idleTimeoutMs,
        acquireTimeoutMillis: config.acquireTimeoutMs,
      },
      connectionTimeout: config.acquireTimeoutMs,
      requestTimeout: timeout,
      arrayRowMode: true,
      options: {
        encrypt: booleanSetting(readConnectionProp(connection, 'encrypt'), 'encrypt', isAzure),
        trustServerCertificate: booleanSetting(
          readConnectionProp(connection, 'trustServerCertificate'),
          'trustServerCertificate',
          !isAzure
        ),
      },
    });

    await pool.connect();

    const entry: PoolEntry = {
      pool,
      type: 'mssql',
      config: config,
      createdAt: new Date(),
      connectionId: connection.id,
    };

    return entry;
  }

  async getStats(connectionId: string): Promise<PoolStats | null> {
    const entry =
      this.pools.get(connectionId) ??
      [...this.pools.values()].find((e) => e.connectionId === connectionId);
    if (!entry) return null;

    const stats: PoolStats = {
      connectionId,
      totalConnections: 0,
      idleConnections: 0,
      activeConnections: 0,
      waitingRequests: 0,
    };

    if (entry.type === 'postgres') {
      const pgPool = entry.pool as PgPool;
      stats.totalConnections = pgPool.totalCount;
      stats.idleConnections = pgPool.idleCount;
      stats.activeConnections = pgPool.totalCount - pgPool.idleCount;
      stats.waitingRequests = pgPool.waitingCount;
    } else if (entry.type === 'mysql') {
      // MySQL pool doesn't expose these stats easily
      const raw = (
        entry.pool as unknown as {
          pool: {
            _allConnections: { length: number };
            _freeConnections: { length: number };
            _connectionQueue: { length: number };
          };
        }
      ).pool;
      stats.totalConnections = raw._allConnections.length;
      stats.idleConnections = raw._freeConnections.length;
      stats.activeConnections = stats.totalConnections - stats.idleConnections;
      stats.waitingRequests = raw._connectionQueue.length;
    } else if (entry.type === 'mssql') {
      const mssqlPool = entry.pool as MssqlPool;
      stats.totalConnections = mssqlPool.size;
      stats.activeConnections = mssqlPool.size - mssqlPool.available;
      stats.idleConnections = mssqlPool.available;
    }

    return stats;
  }

  async closePool(connectionId: string): Promise<void> {
    const entry =
      this.pools.get(connectionId) ??
      [...this.pools.values()].find((e) => e.connectionId === connectionId);
    if (!entry) return;

    this.log(`Closing pool for ${connectionId}`);

    try {
      if (entry.type === 'postgres') {
        await (entry.pool as PgPool).end();
      } else if (entry.type === 'mysql') {
        await (entry.pool as MySqlPool).end();
      } else if (entry.type === 'mssql') {
        await (entry.pool as MssqlPool).close();
      }
    } catch (error) {
      this.log(`Error closing pool: ${error}`);
    }

    for (const [key, value] of this.pools) if (value === entry) this.pools.delete(key);
  }

  async closeAllPools(): Promise<void> {
    this.log('Closing all connection pools');
    await Promise.allSettled(this.pendingCreation.values());
    const closePromises = Array.from(this.pools.keys()).map((id) => this.closePool(id));
    await Promise.all(closePromises);
  }

  getPoolType(connectionId: string): 'postgres' | 'mysql' | 'mssql' | null {
    const entry =
      this.pools.get(connectionId) ??
      [...this.pools.values()].find((e) => e.connectionId === connectionId);
    return entry?.type || null;
  }

  hasPool(connectionId: string): boolean {
    return [...this.pools.values()].some((e) => e.connectionId === connectionId);
  }
}

export const connectionPoolManager = new ConnectionPoolManager();
