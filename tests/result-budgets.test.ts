import { describe, it, expect } from 'bun:test';
import {
  ResultCollector,
  JsonRowStream,
  parseJsonRows,
  parseJsonValue,
} from '../src/runtime/results.js';

it('preserves nested large integers without assigning prototype properties', () => {
  const result = parseJsonRows(
    '[{"data":[9007199254740993,{"__proto__":{"x":1},"n":9007199254740995}]}]'
  );
  expect(JSON.stringify(result.rows[0][0])).toBe(
    '["9007199254740993",{"__proto__":{"x":1},"n":"9007199254740995"}]'
  );
  const nested = (result.rows[0][0] as unknown[])[1];
  expect(Object.getPrototypeOf(nested)).toBeNull();
  expect(() => parseJsonRows('[{"v":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}]')).toThrow(
    /nesting/
  );
});

const connection = { id: 'fixture', name: 'fixture', driver: 'postgresql', url: '' };
describe('bounded results', () => {
  it('rejects incomplete and malformed CLI framing, even after valid rows', () => {
    for (const text of [
      '[{"n":1}',
      '[{"n":1},',
      '[{"n":1}]extra',
      '{"n":1}',
      '[{"n":1},]',
      '[{"n":1}{"n":2}]',
    ]) {
      const stream = new JsonRowStream(new ResultCollector(connection));
      expect(() => {
        stream.write(text);
        stream.finish();
      }).toThrow(/JSON|output/);
    }
    for (const text of ['[1,]', '{"n":1,}', '{"n":[1,]}'])
      expect(() => parseJsonValue(text)).toThrow(/JSON/);
    for (const text of ['[{"n":1,}]', '[{"n":1},]'])
      expect(() => parseJsonRows(text)).toThrow(/JSON/);
  });
  it('validates EOF and column consistency across arbitrary chunks', () => {
    const stream = new JsonRowStream(new ResultCollector(connection));
    for (const part of [' [', '{"n":', '1}', ',', '{"n":2}', '] ', '\n'])
      expect(stream.write(part)).toBe(true);
    expect(() => stream.finish()).not.toThrow();
    const inconsistent = new JsonRowStream(new ResultCollector(connection));
    expect(() => inconsistent.write('[{"n":1},{"other":2}]')).toThrow(/columns/);
    const empty = new JsonRowStream(new ResultCollector(connection));
    expect(() => empty.finish()).not.toThrow();
  });
  it('preserves exponent integers and non-finite JSON numerals as text', () => {
    expect(parseJsonValue('{"big":9007199254740993e0,"infinite":1e999}')).toEqual({
      big: '9007199254740993e0',
      infinite: '1e999',
    });
  });
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
    expect(() => r.add([{ nested: [Number('9007199254740993')] }])).toThrow(/inexact integer/);
  });
  it('preserves non-finite values and nested binary/bigint values without silent nulls', () => {
    const r = new ResultCollector(connection);
    r.add([{ values: [Infinity, -Infinity, NaN, 9007199254740993n, Buffer.from('x')] }]);
    expect(r.rows[0][0]).toEqual({
      values: [
        'Infinity',
        '-Infinity',
        'NaN',
        '9007199254740993',
        { encoding: 'base64', data: 'eA==' },
      ],
    });
  });
  it('preserves SQLite duplicate columns and large integers', () => {
    expect(
      parseJsonRows('[{"id":1,"id":9007199254740993,"text":"a,\\n\\"b\\"","nothing":null}]')
    ).toEqual({
      columns: ['id', 'id', 'text', 'nothing'],
      rows: [[1, '9007199254740993', 'a,\n"b"', null]],
    });
  });
  it('frames rows across arbitrary chunks and stops before buffering the rest', () => {
    const r = new ResultCollector(connection, 1);
    const s = new JsonRowStream(r);
    for (const part of ['[{"i', 'd":1,"tex', 't":"a}\\', '"b"},']) expect(s.write(part)).toBe(true);
    expect(s.write('{"id":2,"text":"other"}]')).toBe(false);
    expect(r.result()).toMatchObject({
      columns: ['id', 'text'],
      rows: [[1, 'a}"b']],
      truncated: true,
    });
  });
});
