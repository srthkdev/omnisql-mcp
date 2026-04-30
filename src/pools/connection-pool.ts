import { Pool as PgPool } from 'pg';
import mysql, { Pool as MySqlPool } from 'mysql2/promise';
import sql, { ConnectionPool as MssqlPool } from 'mssql';
import { DatabaseConnection, PoolConfig, PoolStats } from '../types.js';

const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeoutMs: 30000,
  acquireTimeoutMs: 10000,
};

interface PoolEntry {
  pool: PgPool | MySqlPool | MssqlPool;
  type: 'postgres' | 'mysql' | 'mssql';
  config: PoolConfig;
  createdAt: Date;
}

export class ConnectionPoolManager {
  private pools: Map<string, PoolEntry> = new Map();
  private pendingCreation: Map<string, Promise<PoolEntry | null>> = new Map();
  private config: PoolConfig;
  private debug: boolean;

  constructor(config?: Partial<PoolConfig>, debug = false) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.debug = debug;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[ConnectionPool] ${message}`);
    }
  }

  async getPool(connection: DatabaseConnection): Promise<PoolEntry | null> {
    const poolKey = connection.id;

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
    const creationPromise = this.createPool(connection);
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

  private async createPostgresPool(connection: DatabaseConnection): Promise<PoolEntry> {
    this.log(`Creating PostgreSQL pool for ${connection.name}`);

    const sslConfig = this.getPostgresSslConfig(connection);

    const pool = new PgPool({
      host: connection.host,
      port: connection.port || 5432,
      database: connection.database,
      user: connection.user,
      password: connection.properties?.password,
      min: this.config.min,
      max: this.config.max,
      idleTimeoutMillis: this.config.idleTimeoutMs,
      connectionTimeoutMillis: this.config.acquireTimeoutMs,
      ...sslConfig,
    });

    const entry: PoolEntry = {
      pool,
      type: 'postgres',
      config: this.config,
      createdAt: new Date(),
    };

    this.pools.set(connection.id, entry);
    return entry;
  }

  private getPostgresSslConfig(connection: DatabaseConnection): object {
    const props = connection.properties || {};
    // The workspace JSON config format stores driver properties under a nested `properties` key,
    // and SSL handler config under `handlers.postgre_ssl`. Check all locations.
    const nestedProps = (props.properties as unknown as Record<string, unknown>) || {};
    const sslHandler = (props.handlers as unknown as Record<string, unknown> | undefined)?.[
      'postgre_ssl'
    ] as Record<string, unknown> | undefined;
    const sslMode =
      props.sslmode ||
      props.ssl ||
      nestedProps['sslmode'] ||
      nestedProps['ssl'] ||
      (sslHandler?.enabled
        ? (sslHandler?.properties as Record<string, unknown>)?.['sslMode'] || 'require'
        : undefined);

    if (sslMode === 'disable' || sslMode === 'false') {
      return { ssl: false };
    }

    if (
      sslMode === 'require' ||
      sslMode === 'true' ||
      sslMode === 'verify-ca' ||
      sslMode === 'verify-full'
    ) {
      return {
        ssl: {
          rejectUnauthorized: sslMode === 'verify-full',
        },
      };
    }

    // Default: try SSL but don't require it
    return { ssl: { rejectUnauthorized: false } };
  }

  private async createMysqlPool(connection: DatabaseConnection): Promise<PoolEntry> {
    this.log(`Creating MySQL pool for ${connection.name}`);

    const pool = mysql.createPool({
      host: connection.host,
      port: connection.port || 3306,
      database: connection.database,
      user: connection.user,
      password: connection.properties?.password,
      connectionLimit: this.config.max,
      waitForConnections: true,
      queueLimit: 0,
      connectTimeout: this.config.acquireTimeoutMs,
    });

    const entry: PoolEntry = {
      pool,
      type: 'mysql',
      config: this.config,
      createdAt: new Date(),
    };

    this.pools.set(connection.id, entry);
    return entry;
  }

  private async createMssqlPool(connection: DatabaseConnection): Promise<PoolEntry> {
    this.log(`Creating MSSQL pool for ${connection.name}`);

    const host = connection.host || 'localhost';
    const isAzure = host.includes('.database.windows.net');
    const props = connection.properties || {};
    const nestedProps = (props['properties'] as unknown as Record<string, string>) || {};
    const encryptProp = props['encrypt'] ?? nestedProps['encrypt'];
    const trustCertProp = props['trustServerCertificate'] ?? nestedProps['trustServerCertificate'];
    const encrypt = encryptProp !== undefined ? encryptProp === 'true' : isAzure;
    const trustServerCertificate =
      trustCertProp !== undefined ? trustCertProp === 'true' : !isAzure;

    const pool = new sql.ConnectionPool({
      server: host,
      port: connection.port || 1433,
      database: connection.database,
      user: connection.user,
      password: connection.properties?.password,
      pool: {
        min: this.config.min,
        max: this.config.max,
        idleTimeoutMillis: this.config.idleTimeoutMs,
        acquireTimeoutMillis: this.config.acquireTimeoutMs,
      },
      options: {
        encrypt,
        trustServerCertificate,
      },
    });

    await pool.connect();

    const entry: PoolEntry = {
      pool,
      type: 'mssql',
      config: this.config,
      createdAt: new Date(),
    };

    this.pools.set(connection.id, entry);
    return entry;
  }

  async getStats(connectionId: string): Promise<PoolStats | null> {
    const entry = this.pools.get(connectionId);
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
      stats.totalConnections = this.config.max;
    } else if (entry.type === 'mssql') {
      const mssqlPool = entry.pool as MssqlPool;
      stats.totalConnections = mssqlPool.size;
      stats.activeConnections = mssqlPool.size - mssqlPool.available;
      stats.idleConnections = mssqlPool.available;
    }

    return stats;
  }

  async closePool(connectionId: string): Promise<void> {
    const entry = this.pools.get(connectionId);
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

    this.pools.delete(connectionId);
  }

  async closeAllPools(): Promise<void> {
    this.log('Closing all connection pools');
    const closePromises = Array.from(this.pools.keys()).map((id) => this.closePool(id));
    await Promise.all(closePromises);
  }

  getPoolType(connectionId: string): 'postgres' | 'mysql' | 'mssql' | null {
    const entry = this.pools.get(connectionId);
    return entry?.type || null;
  }

  hasPool(connectionId: string): boolean {
    return this.pools.has(connectionId);
  }
}

export const connectionPoolManager = new ConnectionPoolManager();
