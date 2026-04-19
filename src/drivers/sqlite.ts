import Database from 'better-sqlite3';
import type {
  DBeaverConnection,
  ConnectionConfig,
  QueryResult,
  ExecuteResult,
  SchemaInfo,
  ColumnInfo,
  TableInfo,
  PoolStats,
  DriverDialect,
} from '../types.js';
import { BaseDriver } from './base.js';
import { sanitizeIdentifier } from '../utils.js';

/**
 * Check whether a DBeaver driver string represents SQLite.
 */
export function isSQLite(driver: string): boolean {
  return driver.toLowerCase().includes('sqlite');
}

/**
 * Driver implementation for SQLite databases.
 *
 * Uses the `better-sqlite3` package which provides synchronous access.
 * Methods are wrapped in async signatures to satisfy the DatabaseDriverInterface.
 * SQLite does not use connection pooling, so `getPoolStats()` always returns null.
 */
export class SQLiteDriver extends BaseDriver {
  readonly dialect: DriverDialect = 'sqlite';

  private db!: Database.Database;

  constructor(connection: DBeaverConnection, config?: Partial<ConnectionConfig>) {
    super(connection, config);
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    const conn = this.connection;
    const dbPath = conn.properties?.database || conn.database;

    if (!dbPath) {
      throw new Error(
        'SQLite database path not found. Provide it via connection.database or connection.properties.database.'
      );
    }

    this.log(`Opening SQLite database: ${dbPath}`);

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrency and set a busy timeout.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.log('SQLite database opened');
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.log('Closing SQLite database');
      try {
        this.db.close();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Error closing database: ${msg}`);
      }
    }
  }

  // ── Raw query execution ───────────────────────────────────────────

  async rawQuery(sql: string): Promise<QueryResult> {
    const stmt = this.db.prepare(sql);

    // better-sqlite3 throws on `.all()` for statements that don't return data.
    // Use `.reader` to distinguish SELECT-like statements.
    if (stmt.reader) {
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]) : stmt.columns().map((c) => c.name);
      const dataRows = rows.map((row) => columns.map((col) => row[col]));

      return {
        columns,
        rows: dataRows,
        rowCount: dataRows.length,
        executionTime: 0,
      };
    }

    // Non-reader statement (INSERT, UPDATE, DELETE, DDL executed via rawQuery).
    const info = stmt.run();
    return {
      columns: [],
      rows: [],
      rowCount: info.changes,
      executionTime: 0,
    };
  }

  async rawExecute(sql: string): Promise<ExecuteResult> {
    const stmt = this.db.prepare(sql);
    const info = stmt.run();
    return {
      affectedRows: info.changes,
    };
  }

  // ── Pool stats ────────────────────────────────────────────────────

  getPoolStats(): PoolStats | null {
    // SQLite does not use connection pooling.
    return null;
  }

  // ── Schema introspection overrides ────────────────────────────────

  /**
   * Override getSchema to handle SQLite's PRAGMA table_info() format.
   *
   * PRAGMA table_info returns columns:
   *   cid | name | type | notnull | dflt_value | pk
   */
  async getSchema(table: string): Promise<SchemaInfo> {
    const safeTable = sanitizeIdentifier(table);

    const pragmaRows = this.db.prepare(`PRAGMA table_info(${safeTable})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    const columns: ColumnInfo[] = pragmaRows.map((row) => ({
      name: row.name,
      type: row.type || 'TEXT',
      nullable: row.notnull === 0,
      defaultValue: row.dflt_value ?? undefined,
      isPrimaryKey: row.pk > 0,
      isAutoIncrement: row.pk > 0 && row.type.toUpperCase() === 'INTEGER',
      length: undefined,
      precision: undefined,
      scale: undefined,
    }));

    // Retrieve index information.
    const indexListRows = this.db.prepare(`PRAGMA index_list(${safeTable})`).all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;

    const indexes = indexListRows.map((idx) => {
      let indexColumns: string[];
      try {
        // Quote the index name with double-quotes, escaping any embedded double-quotes.
        const quotedName = `"${idx.name.replace(/"/g, '""')}"`;
        const infoRows = this.db.prepare(`PRAGMA index_info(${quotedName})`).all() as Array<{
          seqno: number;
          cid: number;
          name: string;
        }>;
        indexColumns = infoRows.map((r) => r.name);
      } catch {
        indexColumns = [];
      }

      return {
        name: idx.name,
        columns: indexColumns,
        unique: idx.unique === 1,
        type: idx.origin === 'pk' ? 'PRIMARY' : 'INDEX',
      };
    });

    return {
      tableName: safeTable,
      columns,
      indexes,
      constraints: [],
    };
  }

  /**
   * Override listTables to handle SQLite's sqlite_master format.
   */
  async listTables(_schema?: string, includeViews?: boolean): Promise<TableInfo[]> {
    const types = includeViews ? "'table', 'view'" : "'table'";
    const sql = `
      SELECT name, type
      FROM sqlite_master
      WHERE type IN (${types})
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

    const rows = this.db.prepare(sql).all() as Array<{ name: string; type: string }>;

    return rows.map((row) => ({
      name: row.name,
      type: row.type === 'view' ? ('view' as const) : ('table' as const),
    }));
  }
}
