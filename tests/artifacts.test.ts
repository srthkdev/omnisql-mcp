import { afterEach, describe, it, expect, vi } from 'bun:test';
import { ResultArtifacts } from '../src/runtime/artifacts.js';
import fs from 'node:fs/promises';
const stores: ResultArtifacts[] = [];
function store(ttl?: number, quota?: number) {
  const s = new ResultArtifacts(ttl, quota);
  stores.push(s);
  return s;
}
const source = {
  scopes: [
    {
      connectionId: 'fixture',
      access: { kind: 'sql' as const, query: 'SELECT * FROM public.orders' },
      connectionFingerprint: 'private-fixture-identity',
      policyRevision: 'private-fixture-revision',
    },
  ],
};

const result = {
  columns: ['id', 'note'],
  rows: [
    [1, 'first'],
    [2, 'second'],
    [3, 'third'],
  ],
  rowCount: 3,
  executionTime: 1,
};
afterEach(async () => {
  for (const s of stores) await s.close();
  stores.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('private result artifacts', () => {
  it('pages by stored row offset without re-running SQL', async () => {
    const s = store();
    const saved = await s.save(result, source);
    expect(await s.page(saved.resultId, 0, 2)).toMatchObject({
      rows: [
        [1, 'first'],
        [2, 'second'],
      ],
      nextOffset: 2,
      storedRows: 3,
    });
    expect(await s.page(saved.resultId, 2, 2)).toMatchObject({
      rows: [[3, 'third']],
      nextOffset: null,
    });
    expect(s.source(saved.resultId)).toEqual(source);
  });
  it('clips previews and reads full long cells in chunks', async () => {
    const s = store();
    const text = 'a'.repeat(8000) + '💾';
    const saved = await s.save({ ...result, rows: [[1, text]], rowCount: 1 }, source);
    const page = await s.page(saved.resultId);
    expect(page.clippedCells).toEqual([
      { row: 0, column: 1, length: text.length, encoding: 'text' },
    ]);
    expect((await s.cell(saved.resultId, 0, 1, 7900, 200)).text).toBe(text.slice(7900));
  });
  it('keeps escaped wide previews within the page budget and labels JSON cells', async () => {
    const s = store();
    const value = { text: '\u0000'.repeat(8000) + 'नमस्ते🙂' };
    const saved = await s.save(
      { ...result, columns: Array(50).fill('same'), rows: [Array(50).fill(value)], rowCount: 1 },
      source
    );
    const page = await s.page(saved.resultId);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    expect(page.clippedCells[0]).toMatchObject({ encoding: 'json' });
    const pieces: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const cell = await s.cell(saved.resultId, 0, 0, offset);
      expect(cell.encoding).toBe('json');
      expect(Buffer.byteLength(JSON.stringify(cell))).toBeLessThanOrEqual(65536);
      pieces.push(cell.text);
      offset = cell.nextOffset;
    }
    expect(JSON.parse(pieces.join(''))).toEqual(value);
  });
  it('bounds concurrent page, cell, and export reads instead of multiplying row allocations', async () => {
    const s = store();
    const saved = await s.save(result, source);
    const exported = await s.export('synthetic', 'csv', source);
    const realOpen = fs.open.bind(fs);
    let active = 0,
      maximum = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await realOpen(...args);
      } finally {
        active--;
      }
    });
    const calls = await Promise.allSettled(
      Array.from({ length: 24 }, (_, i) =>
        i % 3 === 0
          ? s.page(saved.resultId)
          : i % 3 === 1
            ? s.cell(saved.resultId, 0, 1)
            : s.readExport(exported.resultId)
      )
    );
    expect(maximum).toBeLessThanOrEqual(2);
    expect(calls.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(calls.some((r) => r.status === 'rejected' && /queue/.test(r.reason.message))).toBe(true);
  });
  it('pages wide columns without dropping duplicate names', async () => {
    const s = store();
    const saved = await s.save(
      { ...result, columns: Array(120).fill('same'), rows: [Array(120).fill('x')] },
      source
    );
    expect(await s.page(saved.resultId, 0, 1, 50, 50)).toMatchObject({
      columnOffset: 50,
      nextColumnOffset: 100,
      columns: Array(50).fill('same'),
      rows: [Array(50).fill('x')],
    });
  });
  it('paginates large column headers and reports clipping only for returned rows', async () => {
    const s = store();
    const columns = Array.from({ length: 80 }, (_, i) => `${i}_` + 'क'.repeat(120));
    const saved = await s.save(
      {
        ...result,
        columns,
        rows: Array.from({ length: 10 }, () => Array(80).fill('\u0000'.repeat(2000))),
        rowCount: 10,
      },
      source
    );
    const first = await s.page(saved.resultId, 0, 10, 0, 80);
    expect(first.nextColumnOffset).not.toBeNull();
    expect(first.nextOffset).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65536);
    expect(first.clippedCells.every((cell) => cell.row < first.rows.length)).toBe(true);
    const second = await s.page(saved.resultId, 0, 1, first.nextColumnOffset!, 80);
    expect([...first.columns, ...second.columns]).toEqual(columns);
  });
  it('waits for active file reads before shutdown and refuses new reads', async () => {
    const s = store();
    const saved = await s.save(result, source);
    const realOpen = fs.open.bind(fs);
    let unblock!: () => void, opened!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      opened();
      await blocked;
      return realOpen(...args);
    });
    const reading = s.cell(saved.resultId, 0, 1);
    await started;
    let done = false;
    const closing = s.close().then(() => {
      done = true;
    });
    try {
      await Promise.resolve();
      expect(done).toBe(false);
    } finally {
      unblock();
    }
    expect((await reading).text).toBe('first');
    await closing;
    await expect(s.page(saved.resultId)).rejects.toThrow(/closed/);
  });
  it('expires handles, rejects traversal, and never accepts paths', async () => {
    vi.useFakeTimers();
    const s = store(100);
    const saved = await s.save(result, source);
    vi.advanceTimersByTime(101);
    await Promise.resolve();
    expect(() => s.source(saved.resultId)).toThrow(/expired/);
    expect(() => s.source('../../etc/passwd')).toThrow(/Invalid/);
  });
  it('applies quota during concurrent writes', async () => {
    const s = store(10000, 55);
    const saved = await Promise.all(Array.from({ length: 4 }, () => s.save(result, source)));
    const alive = saved.filter((e) => {
      try {
        s.source(e.resultId);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive.length).toBe(1);
  });
  it('exports bytes exactly and honors independent formats', async () => {
    const s = store();
    const text = 'name\n💾';
    const saved = await s.export(text, 'csv', source);
    const chunk = await s.readExport(saved.resultId);
    expect(Buffer.from(chunk.data, 'base64').toString()).toBe(text);
    expect(chunk.nextOffset).toBe(null);
  });
});
