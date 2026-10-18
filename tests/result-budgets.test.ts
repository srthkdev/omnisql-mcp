import { describe, it, expect } from 'vitest';
import { ResultCollector, SQLiteRowStream, parseSQLiteRows } from '../src/runtime/results.js';
const connection = { id: 'fixture', name: 'fixture', driver: 'postgresql', url: '' };
describe('bounded results', () => {
  it('detects truncation only when an additional row exists', () => {
    const r = new ResultCollector(connection, 2);
    r.columns = ['n'];
    expect(r.add([1])).toBe(true);
    expect(r.add([2])).toBe(true);
    expect(r.result().truncated).toBe(false);
    expect(r.add([3])).toBe(false);
    expect(r.result()).toMatchObject({
      rows: [[1], [2]],
      rowCount: 2,
      truncated: true,
      limitReason: 'rows',
    });
  });
  it('applies the instance limit and byte budget independently', () => {
    const rows = new ResultCollector({ ...connection, limits: { maxRows: 1 } }, 100);
    rows.columns = ['n'];
    rows.add([1]);
    expect(rows.add([2])).toBe(false);
    const bytes = new ResultCollector({ ...connection, limits: { maxBytes: 32 } }, 100);
    bytes.columns = ['text'];
    expect(bytes.add(['okay'])).toBe(true);
    expect(bytes.add(['x'.repeat(100)])).toBe(false);
    expect(bytes.result().limitReason).toBe('bytes');
  });
  it('serializes binary and bigint values without crashing JSON responses', () => {
    const r = new ResultCollector(connection);
    r.add([9007199254740993n, Buffer.from('hello')]);
    expect(JSON.stringify(r.result())).toContain('9007199254740993');
    expect(r.rows[0][1]).toEqual({ encoding: 'base64', data: 'aGVsbG8=' });
  });
  it('rejects unsafe driver numbers instead of returning rounded integers', () => {
    const r = new ResultCollector(connection);
    expect(() => r.add([Number('9007199254740993')])).toThrow(/inexact integer/);
  });
  it('preserves SQLite duplicate columns and large integers', () => {
    expect(
      parseSQLiteRows('[{"id":1,"id":9007199254740993,"text":"a,\\n\\"b\\"","nothing":null}]')
    ).toEqual({
      columns: ['id', 'id', 'text', 'nothing'],
      rows: [[1, '9007199254740993', 'a,\n"b"', null]],
    });
  });
  it('frames rows across arbitrary chunks and stops before buffering the rest', () => {
    const r = new ResultCollector(connection, 1);
    const s = new SQLiteRowStream(r);
    for (const part of ['[{"i', 'd":1,"tex', 't":"a}\\', '"b"},']) expect(s.write(part)).toBe(true);
    expect(s.write('{"id":2,"text":"other"}]')).toBe(false);
    expect(r.result()).toMatchObject({
      columns: ['id', 'text'],
      rows: [[1, 'a}"b']],
      truncated: true,
    });
  });
});
