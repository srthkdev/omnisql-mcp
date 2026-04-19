import type {
  DBeaverConnection,
  ConnectionConfig,
  DatabaseDriverInterface,
  DriverDialect,
  DriverRegistryInterface,
} from '../types.js';
import { PostgresDriver, isPostgresCompatible } from './postgres.js';
import { MySQLDriver, isMySQLCompatible } from './mysql.js';
import { MSSQLDriver, isSQLServer } from './mssql.js';
import { SQLiteDriver, isSQLite } from './sqlite.js';

/**
 * List of natively supported database families, shown in error messages.
 */
const SUPPORTED_DATABASES =
  'PostgreSQL (+ CockroachDB, TimescaleDB, Redshift, YugabyteDB, AlloyDB, Aurora Postgres, Supabase, Neon, Citus), ' +
  'MySQL (+ MariaDB, TiDB, Vitess, SingleStore, PlanetScale, Aurora MySQL), ' +
  'SQL Server (MSSQL), ' +
  'SQLite';

/**
 * Registry that creates, caches, and manages database driver instances.
 *
 * Each DBeaverConnection gets at most one driver instance. The driver is created
 * on first access and then reused for subsequent requests. When the server shuts
 * down, `closeAll()` should be called to cleanly disconnect all drivers.
 */
export class DriverRegistry implements DriverRegistryInterface {
  private drivers: Map<string, DatabaseDriverInterface> = new Map();
  private pendingConnections: Map<string, Promise<DatabaseDriverInterface>> = new Map();
  private config: Partial<ConnectionConfig>;
  private debug: boolean;

  constructor(config?: Partial<ConnectionConfig>, debug: boolean = false) {
    this.config = config ?? {};
    this.debug = debug;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Get (or create) a driver for the given connection.
   *
   * If a driver is already cached for this connection ID, it is returned
   * immediately. Otherwise a new driver is created based on the connection's
   * driver string, connected, cached, and returned.
   *
   * Concurrent calls for the same connection ID are de-duplicated so the
   * driver is only created once.
   */
  async getDriver(connection: DBeaverConnection): Promise<DatabaseDriverInterface> {
    const key = connection.id;

    // Return cached driver.
    const existing = this.drivers.get(key);
    if (existing) {
      return existing;
    }

    // De-duplicate concurrent creation requests.
    const pending = this.pendingConnections.get(key);
    if (pending) {
      return pending;
    }

    const creationPromise = this.createDriver(connection);
    this.pendingConnections.set(key, creationPromise);

    try {
      const driver = await creationPromise;
      this.drivers.set(key, driver);
      return driver;
    } catch (error) {
      // Don't cache failed drivers.
      this.drivers.delete(key);
      throw error;
    } finally {
      this.pendingConnections.delete(key);
    }
  }

  /**
   * Disconnect and remove all cached drivers.
   */
  async closeAll(): Promise<void> {
    const entries = Array.from(this.drivers.entries());
    this.drivers.clear();

    const results = await Promise.allSettled(
      entries.map(async ([id, driver]) => {
        try {
          await driver.disconnect();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.log(`Error disconnecting driver ${id}: ${msg}`);
        }
      })
    );

    // Log any failures that were not caught above.
    for (const result of results) {
      if (result.status === 'rejected') {
        this.log(`Unexpected error during closeAll: ${result.reason}`);
      }
    }
  }

  /**
   * Detect the dialect for a given driver string.
   * Returns null if the driver is not recognized.
   */
  getDialect(driverString: string): DriverDialect | null {
    if (isSQLite(driverString)) return 'sqlite';
    if (isPostgresCompatible(driverString)) return 'postgres';
    if (isSQLServer(driverString)) return 'mssql';
    if (isMySQLCompatible(driverString)) return 'mysql';
    return null;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private async createDriver(connection: DBeaverConnection): Promise<DatabaseDriverInterface> {
    const driverString = connection.driver;
    const dialect = this.getDialect(driverString);

    if (!dialect) {
      throw new Error(
        `Database driver "${driverString}" is not supported. ` +
          `Supported databases: ${SUPPORTED_DATABASES}.`
      );
    }

    const configWithDebug: Partial<ConnectionConfig> = {
      ...this.config,
      properties: {
        ...this.config.properties,
        debug: this.debug ? 'true' : 'false',
      },
    };

    let driver: DatabaseDriverInterface;

    switch (dialect) {
      case 'sqlite':
        driver = new SQLiteDriver(connection, configWithDebug);
        break;
      case 'postgres':
        driver = new PostgresDriver(connection, configWithDebug);
        break;
      case 'mssql':
        driver = new MSSQLDriver(connection, configWithDebug);
        break;
      case 'mysql':
        driver = new MySQLDriver(connection, configWithDebug);
        break;
      default: {
        // Exhaustiveness check — should never reach here.
        const _exhaustive: never = dialect;
        throw new Error(`Unhandled dialect: ${_exhaustive}`);
      }
    }

    this.log(`Creating ${dialect} driver for "${connection.name}" (${connection.id})`);

    await (driver as any).connect();

    this.log(`Driver for "${connection.name}" connected successfully`);

    return driver;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[DriverRegistry] ${message}`);
    }
  }
}
