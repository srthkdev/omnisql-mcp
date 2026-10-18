import { afterEach, describe, it, expect, vi } from 'bun:test';
import { ResultArtifacts } from '../src/runtime/artifacts.js';
const stores: ResultArtifacts[] = [];
function store(ttl?: number, quota?: number) {
  const s = new ResultArtifacts(ttl, quota);
  stores.push(s);
  return s;
}
const source = {
  connectionId: 'fixture',
  query: 'SELECT * FROM public.orders',
  connectionFingerprint: 'private-fixture-identity',
  policyRevision: 'private-fixture-revision',
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
    expect(page.clippedCells).toEqual([{ row: 0, column: 1, length: text.length }]);
    expect((await s.cell(saved.resultId, 0, 1, 7900, 200)).text).toBe(text.slice(7900));
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
