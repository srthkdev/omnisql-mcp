import { describe, it, expect, vi } from 'bun:test';
import { QueryGate, ReadWriteGate } from '../src/runtime/concurrency.js';
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
      const waiting = gate.acquire(50).catch((error) => error);
      vi.advanceTimersByTime(51);
      await Promise.resolve();
      expect((await waiting).message).toMatch(/timed out/);
      release();
      (await gate.acquire(50))();
    } finally {
      vi.useRealTimers();
    }
  });
});

it('lets readers share access and prevents later readers overtaking a writer', async () => {
  const gate = new ReadWriteGate();
  const r1 = await gate.acquire(false, 1000);
  const r2 = await gate.acquire(false, 1000);
  const order: string[] = [];
  const writer = gate.acquire(true, 1000).then((release) => {
    order.push('write');
    return release;
  });
  const reader = gate.acquire(false, 1000).then((release) => {
    order.push('read');
    return release;
  });
  r1();
  await Promise.resolve();
  expect(order).toEqual([]);
  r2();
  const finishWrite = await writer;
  expect(order).toEqual(['write']);
  finishWrite();
  (await reader)();
  expect(order).toEqual(['write', 'read']);
});
