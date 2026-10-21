import { registerConnectionPrivacy, sanitizeDiagnostic } from '../privacy.js';
import { assertQueryAccess } from '../policy/identities.js';
import { validateStatement } from '../policy/sql.js';
import { AccessPolicy } from '../policy/access.js';
import { randomBytes } from 'node:crypto';
import { connectionFingerprint as fingerprint } from '../runtime/connection-identity.js';
import type { PoolClient as PgPoolClient } from 'pg';
import type { PoolConnection as MySqlPoolConnection } from 'mysql2/promise';
import type sql from 'mssql';
import type { Transaction, TransactionResult, DatabaseConnection, QueryResult } from '../types.js';
import { ConnectionPoolManager } from '../pools/connection-pool.js';
import { readPostgres, readMysql, readSqlServer } from '../runtime/sql-sessions.js';
import { acquireLease, withDeadline } from '../runtime/lease.js';

interface ActiveTransaction {
  connection: DatabaseConnection;
  transaction: Transaction;
  client: PgPoolClient | MySqlPoolConnection | sql.Transaction;
  type: 'postgres' | 'mysql' | 'mssql';
  busy: boolean;
  destroyed: boolean;
  fingerprint: string;
  policyRevision: string;
}
export class TransactionManager {
  private transactions = new Map<string, ActiveTransaction>();
  private pending = 0;

  constructor(
    private poolManager: ConnectionPoolManager,
    private debug = false,
    private resolveConnection?: (id: string) => Promise<DatabaseConnection | null>,
    private defaultTimeout = 30000
  ) {}

  private log(message: string): void {
    if (this.debug) console.error(`[TransactionManager] ${sanitizeDiagnostic(message)}`);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<TransactionResult> {
    registerConnectionPrivacy(connection);
    const policy = new AccessPolicy();
    policy.assertConnection(connection);
    if (policy.isReadOnly(connection)) throw new Error('This connection is read-only');
    if (this.transactions.size + this.pending >= 32)
      throw new Error('Active transaction limit reached (32)');
    this.pending++;
    const id = `txn_${randomBytes(16).toString('hex')}`;
    let active: ActiveTransaction | undefined;
    try {
      const entry = await this.poolManager.getPool(connection);
      if (!entry || entry.type === 'oracle')
        throw new Error(`Transactions not supported for driver: ${connection.driver}`);
      const timeout = connection.limits?.timeoutMs ?? this.defaultTimeout;
      let client: ActiveTransaction['client'];
      if (entry.type === 'postgres') {
        client = await acquireLease((entry.pool as import('pg').Pool).connect(), timeout, (c) =>
          c.release()
        );
      } else if (entry.type === 'mysql') {
        client = await acquireLease(
          (entry.pool as import('mysql2/promise').Pool).getConnection(),
          timeout,
          (c) => c.release()
        );
      } else {
        const { default: sql } = await import('mssql');
        client = new sql.Transaction(entry.pool as sql.ConnectionPool);
      }
      active = {
        connection,
        client,
        type: entry.type,
        busy: false,
        destroyed: false,
        fingerprint: fingerprint(connection),
        policyRevision: policy.revision(),
        transaction: { id, connectionId: connection.id, startedAt: new Date(), status: 'active' },
      };
      if (active.type === 'postgres')
        await withDeadline((client as PgPoolClient).query('BEGIN'), timeout, () =>
          this.destroy(active!)
        );
      else if (active.type === 'mysql')
        await withDeadline((client as MySqlPoolConnection).beginTransaction(), timeout, () =>
          this.destroy(active!)
        );
      else await (client as sql.Transaction).begin();
      this.transactions.set(id, active);
      return {
        transactionId: id,
        status: 'started',
        message: `Transaction ${id} started successfully`,
      };
    } catch (error) {
      if (active) await this.discard(active);
      throw error;
    } finally {
      this.pending--;
    }
  }

  private claim(id: string): ActiveTransaction {
    const active = this.transactions.get(id);
    if (!active) throw new Error(`Transaction ${id} not found or expired`);
    if (active.busy) throw new Error(`Transaction ${id} already has an operation in progress`);
    active.busy = true;
    return active;
  }

  private async authorize(active: ActiveTransaction, query?: string): Promise<void> {
    // A changed target, credential, limit or policy requires a new transaction.
    // In particular, revocation must not leave an older write session usable.
    if (this.resolveConnection) {
      const current = await this.resolveConnection(active.connection.id);
      if (!current || fingerprint(current) !== active.fingerprint)
        throw new Error(
          'Connection settings changed; transaction rolled back, start a new transaction'
        );
    }
    const policy = new AccessPolicy();
    if (policy.revision() !== active.policyRevision)
      throw new Error('Access policy changed; transaction rolled back, start a new transaction');
    policy.assertConnection(active.connection);
    if (policy.isReadOnly(active.connection)) throw new Error('This connection is read-only');
    if (query !== undefined)
      await assertQueryAccess(policy, active.connection, query, false, (sql) =>
        this.read(active, sql, true)
      );
  }

  async executeInTransaction(id: string, query: string): Promise<QueryResult> {
    const active = this.claim(id);
    try {
      await this.authorize(active, query);
      // MySQL DDL commits implicitly; do not promise rollback for schema operations.
      const error = validateStatement(query, [
        'select',
        'with',
        'insert',
        'update',
        'delete',
        'show',
        'describe',
        'desc',
        'explain',
      ]);
      if (error) throw new Error(error);
      const started = Date.now();
      const result = await this.read(active, query);
      result.executionTime = Date.now() - started;
      return result;
    } catch (error) {
      await this.discard(active);
      this.transactions.delete(id);
      throw error;
    } finally {
      active.busy = false;
    }
  }

  private async read(
    active: ActiveTransaction,
    query: string,
    metadata = false
  ): Promise<QueryResult> {
    const options = {
      connection: metadata
        ? {
            ...active.connection,
            limits: { ...active.connection.limits, maxRows: 10000, maxBytes: 8 * 1024 * 1024 },
          }
        : active.connection,
      timeout: active.connection.limits?.timeoutMs ?? this.defaultTimeout,
      preserveSession: true,
      abort: () => this.destroy(active),
    };
    if (active.type === 'postgres')
      return await readPostgres(active.client as PgPoolClient, query, options);
    if (active.type === 'mysql')
      return await readMysql(active.client as MySqlPoolConnection, query, options);
    const { default: sql } = await import('mssql');
    return await readSqlServer(new sql.Request(active.client as sql.Transaction), query, options);
  }

  private destroy(active: ActiveTransaction): void {
    if (active.destroyed) return;
    active.destroyed = true;
    if (active.type === 'postgres') (active.client as PgPoolClient).release(true);
    else if (active.type === 'mysql') (active.client as MySqlPoolConnection).destroy();
  }

  private async discard(active: ActiveTransaction): Promise<void> {
    if (active.destroyed) return;
    if (active.type !== 'mssql') {
      this.destroy(active); // Closing the physical session rolls back all uncommitted writes.
    } else {
      active.destroyed = true;
      await (active.client as sql.Transaction)
        .rollback()
        .catch((error) => this.log(`Rollback failed: ${error}`));
    }
  }

  private async finish(id: string, commit: boolean): Promise<TransactionResult> {
    const active = this.claim(id);
    try {
      if (commit) await this.authorize(active);
      if (active.type === 'postgres') {
        const client = active.client as PgPoolClient;
        await withDeadline(
          client.query(commit ? 'COMMIT' : 'ROLLBACK'),
          active.connection.limits?.timeoutMs ?? this.defaultTimeout,
          () => this.destroy(active)
        );
        client.release();
      } else if (active.type === 'mysql') {
        const client = active.client as MySqlPoolConnection;
        await withDeadline(
          commit ? client.commit() : client.rollback(),
          active.connection.limits?.timeoutMs ?? this.defaultTimeout,
          () => this.destroy(active)
        );
        client.release();
      } else {
        const client = active.client as sql.Transaction;
        if (commit) await client.commit();
        else await client.rollback();
      }
      active.destroyed = true;
      const status = commit ? 'committed' : 'rolled_back';
      active.transaction.status = status;
      return { transactionId: id, status, message: `Transaction ${id} ${status} successfully` };
    } catch (error) {
      await this.discard(active);
      throw error;
    } finally {
      this.transactions.delete(id);
    }
  }

  commitTransaction(id: string): Promise<TransactionResult> {
    return this.finish(id, true);
  }
  rollbackTransaction(id: string): Promise<TransactionResult> {
    return this.finish(id, false);
  }

  async rollbackAll(): Promise<number> {
    const active = [...this.transactions.values()];
    this.transactions.clear();
    await Promise.all(active.map((a) => this.discard(a)));
    return active.length;
  }

  getTransaction(id: string): Transaction | null {
    const active = this.transactions.get(id);
    return active ? { ...active.transaction } : null;
  }

  resultScope(id: string): { connection: DatabaseConnection; policyRevision: string } {
    const active = this.transactions.get(id);
    if (!active) throw new Error(`Transaction ${id} not found or expired`);
    return { connection: active.connection, policyRevision: active.policyRevision };
  }

  getActiveTransactions(): Transaction[] {
    return [...this.transactions.values()].map((a) => ({ ...a.transaction }));
  }

  async cleanupStaleTransactions(maxAgeMs = 3600000): Promise<number> {
    const stale = [...this.transactions.values()].filter(
      (a) => !a.busy && Date.now() - a.transaction.startedAt.getTime() > maxAgeMs
    );
    for (const a of stale) {
      this.transactions.delete(a.transaction.id);
      await this.discard(a);
    }
    return stale.length;
  }
}
