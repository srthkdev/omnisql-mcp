import crypto from 'crypto';
import { PoolClient as PgPoolClient } from 'pg';
import { PoolConnection as MySqlPoolConnection } from 'mysql2/promise';
import sql from 'mssql';
import { Transaction, TransactionResult, DatabaseConnection } from '../types.js';
import { ConnectionPoolManager } from '../pools/connection-pool.js';

interface ActiveTransaction {
  transaction: Transaction;
  client: PgPoolClient | MySqlPoolConnection | sql.Transaction;
  type: 'postgres' | 'mysql' | 'mssql';
}

export class TransactionManager {
  private transactions: Map<string, ActiveTransaction> = new Map();
  private poolManager: ConnectionPoolManager;
  private debug: boolean;

  constructor(poolManager: ConnectionPoolManager, debug = false) {
    this.poolManager = poolManager;
    this.debug = debug;
  }

  private log(message: string): void {
    if (this.debug) {
      console.error(`[TransactionManager] ${message}`);
    }
  }

  private generateTransactionId(): string {
    return `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<TransactionResult> {
    const transactionId = this.generateTransactionId();
    const driver = connection.driver.toLowerCase();

    this.log(`Beginning transaction ${transactionId} for ${connection.name}`);

    try {
      const poolEntry = await this.poolManager.getPool(connection);

      if (!poolEntry) {
        throw new Error(`No pool available for driver: ${connection.driver}`);
      }

      let client: PgPoolClient | MySqlPoolConnection | sql.Transaction;
      let type: 'postgres' | 'mysql' | 'mssql';

      if (driver.includes('postgres')) {
        const pgPool = poolEntry.pool as import('pg').Pool;
        const pgClient = await pgPool.connect();
        await pgClient.query('BEGIN');
        client = pgClient;
        type = 'postgres';
      } else if (driver.includes('mysql') || driver.includes('mariadb')) {
        const mysqlPool = poolEntry.pool as import('mysql2/promise').Pool;
        const mysqlConn = await mysqlPool.getConnection();
        await mysqlConn.beginTransaction();
        client = mysqlConn;
        type = 'mysql';
      } else if (driver.includes('mssql') || driver.includes('sqlserver')) {
        const mssqlPool = poolEntry.pool as sql.ConnectionPool;
        const mssqlTxn = new sql.Transaction(mssqlPool);
        await mssqlTxn.begin();
        client = mssqlTxn;
        type = 'mssql';
      } else {
        throw new Error(`Transactions not supported for driver: ${connection.driver}`);
      }

      const transaction: Transaction = {
        id: transactionId,
        connectionId: connection.id,
        startedAt: new Date(),
        status: 'active',
      };

      this.transactions.set(transactionId, { transaction, client, type });

      return {
        transactionId,
        status: 'started',
        message: `Transaction ${transactionId} started successfully`,
      };
    } catch (error) {
      this.log(`Failed to begin transaction: ${error}`);
      throw error;
    }
  }

  async executeInTransaction(
    transactionId: string,
    query: string
  ): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number }> {
    const active = this.transactions.get(transactionId);

    if (!active) {
      throw new Error(`Transaction ${transactionId} not found or expired`);
    }

    if (active.transaction.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is ${active.transaction.status}`);
    }

    this.log(`Executing query in transaction ${transactionId}`);

    try {
      if (active.type === 'postgres') {
        const pgClient = active.client as PgPoolClient;
        const result = await pgClient.query(query);
        return {
          columns: result.fields?.map((f) => f.name) || [],
          rows: result.rows.map((row) => Object.values(row)),
          rowCount: result.rowCount || 0,
        };
      } else if (active.type === 'mysql') {
        const mysqlConn = active.client as MySqlPoolConnection;
        const [rows, fields] = await mysqlConn.execute(query);
        const rowArray = Array.isArray(rows) ? rows : [];
        return {
          columns: (fields as { name: string }[])?.map((f) => f.name) || [],
          rows: rowArray.map((row) => Object.values(row as object)),
          rowCount: rowArray.length,
        };
      } else if (active.type === 'mssql') {
        const mssqlTxn = active.client as sql.Transaction;
        const request = new sql.Request(mssqlTxn);
        const result = await request.query(query);
        const columns = result.recordset?.columns ? Object.keys(result.recordset.columns) : [];
        return {
          columns,
          rows: result.recordset?.map((row) => Object.values(row)) || [],
          rowCount: result.rowsAffected?.[0] || 0,
        };
      }

      throw new Error('Unknown transaction type');
    } catch (error) {
      this.log(`Query execution failed in transaction: ${error}`);
      throw error;
    }
  }

  async commitTransaction(transactionId: string): Promise<TransactionResult> {
    const active = this.transactions.get(transactionId);

    if (!active) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    if (active.transaction.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is already ${active.transaction.status}`);
    }

    this.log(`Committing transaction ${transactionId}`);

    try {
      if (active.type === 'postgres') {
        const pgClient = active.client as PgPoolClient;
        await pgClient.query('COMMIT');
        pgClient.release();
      } else if (active.type === 'mysql') {
        const mysqlConn = active.client as MySqlPoolConnection;
        await mysqlConn.commit();
        mysqlConn.release();
      } else if (active.type === 'mssql') {
        const mssqlTxn = active.client as sql.Transaction;
        await mssqlTxn.commit();
      }

      active.transaction.status = 'committed';
      this.transactions.delete(transactionId);

      return {
        transactionId,
        status: 'committed',
        message: `Transaction ${transactionId} committed successfully`,
      };
    } catch (error) {
      this.log(`Failed to commit transaction: ${error}`);
      // Release the client back to pool even on failure to prevent resource leak
      this.releaseClient(active);
      this.transactions.delete(transactionId);
      throw error;
    }
  }

  async rollbackTransaction(transactionId: string): Promise<TransactionResult> {
    const active = this.transactions.get(transactionId);

    if (!active) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    if (active.transaction.status !== 'active') {
      throw new Error(`Transaction ${transactionId} is already ${active.transaction.status}`);
    }

    this.log(`Rolling back transaction ${transactionId}`);

    try {
      if (active.type === 'postgres') {
        const pgClient = active.client as PgPoolClient;
        await pgClient.query('ROLLBACK');
        pgClient.release();
      } else if (active.type === 'mysql') {
        const mysqlConn = active.client as MySqlPoolConnection;
        await mysqlConn.rollback();
        mysqlConn.release();
      } else if (active.type === 'mssql') {
        const mssqlTxn = active.client as sql.Transaction;
        await mssqlTxn.rollback();
      }

      active.transaction.status = 'rolled_back';
      this.transactions.delete(transactionId);

      return {
        transactionId,
        status: 'rolled_back',
        message: `Transaction ${transactionId} rolled back successfully`,
      };
    } catch (error) {
      this.log(`Failed to rollback transaction: ${error}`);
      // Release the client back to pool even on failure to prevent resource leak
      this.releaseClient(active);
      this.transactions.delete(transactionId);
      throw error;
    }
  }

  /**
   * Safely release a transaction client back to the pool.
   * Used as a safety net when commit/rollback fails.
   */
  private releaseClient(active: ActiveTransaction): void {
    try {
      if (active.type === 'postgres') {
        (active.client as PgPoolClient).release(true); // true = destroy the connection
      } else if (active.type === 'mysql') {
        (active.client as MySqlPoolConnection).release();
      }
      // MSSQL transactions don't hold a separate client reference
    } catch (releaseError) {
      this.log(`Failed to release client after error: ${releaseError}`);
    }
  }

  /**
   * Roll back all active transactions. Called during shutdown.
   */
  async rollbackAll(): Promise<number> {
    let count = 0;
    const ids = Array.from(this.transactions.keys());
    for (const id of ids) {
      try {
        await this.rollbackTransaction(id);
        count++;
      } catch {
        // Already cleaned up or failed - force remove
        this.transactions.delete(id);
        count++;
      }
    }
    return count;
  }

  getTransaction(transactionId: string): Transaction | null {
    const active = this.transactions.get(transactionId);
    return active?.transaction || null;
  }

  getActiveTransactions(): Transaction[] {
    return Array.from(this.transactions.values())
      .filter((t) => t.transaction.status === 'active')
      .map((t) => t.transaction);
  }

  async cleanupStaleTransactions(maxAgeMs: number = 3600000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, active] of this.transactions) {
      const age = now - active.transaction.startedAt.getTime();
      if (age > maxAgeMs) {
        this.log(`Cleaning up stale transaction ${id} (age: ${age}ms)`);
        try {
          await this.rollbackTransaction(id);
          cleaned++;
        } catch {
          // Already cleaned up or failed
          this.transactions.delete(id);
          cleaned++;
        }
      }
    }

    return cleaned;
  }
}
