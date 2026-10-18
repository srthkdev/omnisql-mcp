import { describe, it, expect, vi } from 'vitest';
import { QueryGate } from '../src/runtime/concurrency.js';
describe('shared query concurrency', () => {
  it('holds a fixed number of active slots and transfers released slots once', async () => {
    const gate = new QueryGate(1, 1);
    const release = await gate.acquire(1000);
    let started = false;
    const next = gate.acquire(1000).then((done) => {
      started = true;
      return done;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    await expect(gate.acquire(1000)).rejects.toThrow(/queue is full/);
    release();
    release();
    const second = await next;
    expect(started).toBe(true);
    second();
    (await gate.acquire(1000))();
  });
  it('removes timed-out waiters without losing capacity', async () => {
    vi.useFakeTimers();
    try {
      const gate = new QueryGate(1, 1);
      const release = await gate.acquire(50);
      const waiting = expect(gate.acquire(50)).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(51);
      await waiting;
      release();
      (await gate.acquire(50))();
    } finally {
      vi.useRealTimers();
    }
  });
});
