import { afterEach, describe, expect, it, vi, mock } from 'bun:test';
import { TransactionManager } from '../src/managers/transaction-manager.js';
import { acquireLease } from '../src/runtime/lease.js';
import type { DatabaseConnection } from '../src/types.js';
import type { ConnectionPoolManager } from '../src/pools/connection-pool.js';
import { readPostgres } from '../src/runtime/sql-sessions.js';
mock.module('../src/runtime/sql-sessions.js', () => ({
  readPostgres: vi.fn(),
  readMysql: vi.fn(),
  readSqlServer: vi.fn(),
}));
const connection: DatabaseConnection = {
  url: '',
  id: 'fixture',
  name: 'fixture',
  driver: 'postgres',
  host: 'localhost',
  database: 'fixture',
  readonly: false,
};
function setup(resolve?: (id: string) => Promise<DatabaseConnection | null>) {
  const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const manager = new TransactionManager(
    {
      getPool: vi.fn().mockResolvedValue({ pool, type: 'postgres' }),
    } as unknown as ConnectionPoolManager,
    false,
    resolve
  );
  return { manager, client, pool };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('transaction lifecycle', () => {
  it('destroys the lease if BEGIN fails', async () => {
    const { manager, client } = setup();
    client.query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(manager.beginTransaction(connection)).rejects.toThrow('connection lost');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(manager.getActiveTransactions()).toEqual([]);
  });
  it('rejects concurrent statements and commit on an occupied session', async () => {
    const { manager, client } = setup();
    const { transactionId } = await manager.beginTransaction(connection);
    let complete!: (value: any) => void;
    readPostgres.mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        })
    );
    const running = manager.executeInTransaction(transactionId, 'SELECT 1');
    await Promise.resolve();
    expect(complete).toBeTypeOf('function');
    await expect(manager.executeInTransaction(transactionId, 'SELECT 2')).rejects.toThrow(
      /operation in progress/
    );
    await expect(manager.commitTransaction(transactionId)).rejects.toThrow(/operation in progress/);
    complete({ columns: ['n'], rows: [[1]], rowCount: 1, executionTime: 0 });
    await running;
    await manager.rollbackTransaction(transactionId);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });
  it('does not commit a session after config revocation', async () => {
    const resolve = vi.fn().mockResolvedValue({ ...connection, readonly: true });
    const { manager, client } = setup(resolve);
    const { transactionId } = await manager.beginTransaction(connection);
    await expect(manager.commitTransaction(transactionId)).rejects.toThrow(/settings changed/);
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(manager.getTransaction(transactionId)).toBeNull();
  });
  it('rolls back query failures and never releases a destroyed client twice', async () => {
    const { manager, client } = setup();
    const { transactionId } = await manager.beginTransaction(connection);
    readPostgres.mockImplementationOnce(async (_client, _query, options) => {
      options.abort();
      throw new Error('query deadline');
    });
    await expect(manager.executeInTransaction(transactionId, 'SELECT 1')).rejects.toThrow(
      'query deadline'
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
    await expect(manager.commitTransaction(transactionId)).rejects.toThrow(/not found/);
  });
  it('bounds pending starts as well as established sessions', async () => {
    const { manager, pool } = setup();
    const unblock: (() => void)[] = [];
    pool.connect.mockImplementation(
      () =>
        new Promise((r) => {
          unblock.push(() => r({ query: vi.fn().mockResolvedValue({}), release: vi.fn() }));
        })
    );
    const starts = Array.from({ length: 32 }, () => manager.beginTransaction(connection));
    await expect(manager.beginTransaction(connection)).rejects.toThrow(/limit reached/);
    await Promise.resolve();
    expect(unblock).toHaveLength(32);
    unblock.forEach((resolve) => resolve());
    await Promise.all(starts);
    expect(await manager.rollbackAll()).toBe(32);
  });
});
describe('connection acquisition deadline', () => {
  it('returns a lease that arrives after the caller timed out', async () => {
    vi.useFakeTimers();
    let resolve!: (value: object) => void;
    const release = vi.fn();
    const lease = {};
    const pending = new Promise<object>((r) => {
      resolve = r;
    });
    const result = acquireLease(pending, 20, release).catch((error) => error);
    vi.advanceTimersByTime(21);
    await Promise.resolve();
    expect((await result).message).toMatch(/acquisition timed out/);
    resolve(lease);
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(lease);
  });
});
