import { afterEach, beforeEach, describe, expect, it, mock, vi } from 'bun:test';
import { ConnectionPoolManager } from '../src/pools/connection-pool.js';
import type { DatabaseConnection } from '../src/types.js';

const created: FakeMssqlPool[] = [];
const managers: ConnectionPoolManager[] = [];
let connect: () => Promise<void>;

class FakeMssqlPool {
  size = 2;
  available = 1;
  connect = vi.fn(async () => {
    await connect();
    return this;
  });
  close = vi.fn(async () => {});
  constructor(readonly config: Record<string, unknown>) {
    created.push(this);
  }
}
mock.module('mssql', () => ({ default: { ConnectionPool: FakeMssqlPool } }));

const connection = (driver: string): DatabaseConnection => ({
  id: 'sql-server',
  name: 'SQL Server',
  driver,
  url: '',
  host: 'database.example.invalid',
  database: 'reports',
  user: 'report-reader',
});
function manager(): ConnectionPoolManager {
  const instance = new ConnectionPoolManager();
  managers.push(instance);
  return instance;
}
beforeEach(() => {
  created.length = 0;
  connect = async () => {};
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.closeAllPools()));
});

describe('SQL Server pool dispatch', () => {
  it.each(['microsoft', 'Microsoft', 'mssql', 'sqlserver'])(
    'creates a native SQL Server pool for driver %s (issue #87)',
    async (driver) => {
      const entry = await manager().getPool(connection(driver));
      expect(entry?.type).toBe('mssql');
      expect(created).toHaveLength(1);
      expect(entry?.pool).toBe(created[0]);
      expect(created[0].connect).toHaveBeenCalledOnce();
      expect(created[0].config).toMatchObject({
        server: 'database.example.invalid',
        port: 1433,
        database: 'reports',
        user: 'report-reader',
        arrayRowMode: true,
      });
    }
  );

  it('deduplicates concurrent microsoft driver requests and reuses the connected pool', async () => {
    const pools = manager();
    const target = connection('microsoft');
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const connecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    connect = async () => {
      started();
      await ready;
    };
    const pending = Array.from({ length: 8 }, () => pools.getPool(target));
    try {
      await connecting;
      expect(created).toHaveLength(1);
      expect(created[0].connect).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    const entries = await Promise.all(pending);
    expect(entries[0]?.type).toBe('mssql');
    expect(entries.every((entry) => entry === entries[0])).toBe(true);
    expect(await pools.getPool(target)).toBe(entries[0]);
    expect(created).toHaveLength(1);
    expect(pools.getPoolType(target.id)).toBe('mssql');
    expect(await pools.getStats(target)).toMatchObject({
      totalConnections: 2,
      idleConnections: 1,
      activeConnections: 1,
    });
    await pools.closePool(target.id);
    expect(created[0].close).toHaveBeenCalledOnce();
    expect(pools.hasPool(target.id)).toBe(false);
  });

  it('allows retry after a microsoft driver pool fails to connect', async () => {
    const pools = manager();
    const target = connection('microsoft');
    connect = async () => {
      throw new Error('synthetic connection failure');
    };
    await expect(pools.getPool(target)).rejects.toThrow('synthetic connection failure');
    expect(pools.hasPool(target.id)).toBe(false);
    connect = async () => {};
    const retry = await pools.getPool(target);
    expect(retry?.type).toBe('mssql');
    expect(created).toHaveLength(2);
    expect(retry?.pool).toBe(created[1]);
  });

  it('keeps file-backed engines out of the SQL Server pool path', async () => {
    expect(await manager().getPool(connection('sqlite'))).toBeNull();
    expect(created).toHaveLength(0);
  });
});
