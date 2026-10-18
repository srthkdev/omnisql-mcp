import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type sql from 'mssql';
import { readSqlServer } from '../src/runtime/sql-sessions.js';
import { withDeadline } from '../src/runtime/lease.js';
const connection = { id: 'test', name: 'synthetic', driver: 'mssql', url: '' };
afterEach(() => vi.useRealTimers());
describe('SQL Server streaming errors', () => {
  it('rejects a server error even when the streaming driver resolves its promise', async () => {
    const request = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => {
        request.emit(
          'error',
          Object.assign(new Error('Invalid object name'), { code: 'EREQUEST' })
        );
        return { rowsAffected: [] };
      }),
      cancel: vi.fn(),
    });
    await expect(
      readSqlServer(request as unknown as sql.Request, 'SELECT * FROM missing', {
        connection,
        timeout: 1000,
        abort() {},
      })
    ).rejects.toThrow('Invalid object name');
  });
  it('only treats its own row-budget cancellation as successful truncation', async () => {
    const request = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => {
        request.emit('recordset', [{ name: 'n' }]);
        request.emit('row', [1]);
        request.emit('row', [2]);
        return { rowsAffected: [] };
      }),
      cancel: vi.fn(() =>
        request.emit('error', Object.assign(new Error('cancelled'), { code: 'ECANCEL' }))
      ),
    });
    const result = await readSqlServer(request as unknown as sql.Request, 'SELECT n FROM test', {
      connection,
      maxRows: 1,
      timeout: 1000,
      abort() {},
    });
    expect(result.rows).toEqual([[1]]);
    expect(result.truncated).toBe(true);
    expect(request.cancel).toHaveBeenCalledOnce();
  });
});
describe('driver deadlines', () => {
  it('rejects stalled operations even if cancellation itself fails', async () => {
    vi.useFakeTimers();
    const abort = vi.fn(() => {
      throw new Error('closed already');
    });
    const operation = expect(withDeadline(new Promise(() => {}), 20, abort)).rejects.toThrow(
      /timed out/
    );
    await vi.advanceTimersByTimeAsync(21);
    await operation;
    expect(abort).toHaveBeenCalledOnce();
  });
});
