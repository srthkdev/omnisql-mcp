import { describe, it, expect } from 'bun:test';
import {
  compareSchemas,
  comparableSchema,
  generateMigrationScript,
} from '../src/utils/schema-diff.js';
import { SchemaInfo } from '../src/types.js';
function schema(tableName = 'public.orders', length = 10): SchemaInfo {
  return {
    tableName,
    columns: [
      {
        name: 'Name',
        type: 'varchar',
        length,
        nullable: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
      },
    ],
    indexes: [],
    constraints: [],
  };
}
describe('accurate schema differences', () => {
  it('retains length, decimal precision and zero scale', async () => {
    const a = schema(),
      b = schema('public.orders', 100);
    a.columns.push({
      name: 'amount',
      type: 'numeric',
      precision: 12,
      scale: 0,
      nullable: true,
      isPrimaryKey: false,
      isAutoIncrement: false,
    });
    b.columns.push({ ...a.columns[1], scale: 2 });
    const diff = await compareSchemas([comparableSchema(a)], [comparableSchema(b)], 'a', 'b');
    expect(diff.differences[0].columnDiffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columnName: 'Name',
          changes: ['type: varchar(10) -> varchar(100)'],
        }),
        expect.objectContaining({
          columnName: 'amount',
          changes: ['type: numeric(12,0) -> numeric(12,2)'],
        }),
      ])
    );
  });
  it('keeps schemas and quoted identifier case distinct', async () => {
    const diff = await compareSchemas(
      [comparableSchema(schema('public.orders'))],
      [comparableSchema(schema('private.orders'))],
      'a',
      'b'
    );
    expect(diff.summary.tablesAdded).toBe(1);
    expect(diff.summary.tablesRemoved).toBe(1);
    const a = schema(),
      b = schema();
    b.columns[0].name = 'name';
    const caseDiff = await compareSchemas([comparableSchema(a)], [comparableSchema(b)], 'a', 'b');
    expect(caseDiff.differences[0].columnDiffs).toHaveLength(2);
  });
  it('compares indexes and constraints instead of losing them in conversion', async () => {
    const a = schema(),
      b = schema();
    b.indexes = [{ name: 'idx', columns: ['Name'], unique: true, type: 'BTREE' }];
    b.constraints = [
      {
        name: 'check_name',
        columns: ['Name'],
        type: 'CHECK',
        definition: 'CHECK (length(Name)>0)',
      },
    ];
    const d = await compareSchemas([comparableSchema(a)], [comparableSchema(b)], 'a', 'b');
    expect(d.differences[0].indexDiffs?.[0].status).toBe('added');
    expect(d.differences[0].constraintDiffs?.[0].status).toBe('added');
  });
  it('compares partial index predicates and access methods', async () => {
    const a = schema(),
      b = schema();
    a.indexes = [
      { name: 'idx', columns: ['Name'], unique: false, type: 'BTREE', predicate: 'active=true' },
    ];
    b.indexes = [{ ...a.indexes[0], predicate: 'active=false' }];
    const d = await compareSchemas([comparableSchema(a)], [comparableSchema(b)], 'a', 'b');
    expect(d.differences[0].indexDiffs?.[0].status).toBe('modified');
  });
  it('returns a review outline without generating an incomplete executable migration', async () => {
    const d = await compareSchemas(
      [comparableSchema(schema())],
      [comparableSchema(schema('public.orders', 100))],
      'a',
      'b'
    );
    const text = generateMigrationScript(d, 'postgresql');
    expect(text).toContain('"public"."orders"');
    expect(text.split('\n').every((l) => !l.trim() || l.startsWith('--'))).toBe(true);
  });
});
