import { describe, expect, it } from 'bun:test';
import { AccessPolicy } from '../src/policy/access.js';
import type { DatabaseConnection } from '../src/types.js';

function connection(driver: string): DatabaseConnection {
  return {
    id: 'reports',
    name: 'reports',
    driver,
    url: '',
    database: 'reports',
    accessRules: [{ allowTables: [], readOnly: true }],
  };
}

describe('database-specific builtin authorization', () => {
  it.each([
    ['postgres', 'ifnull(1,2)'],
    ['mysql', "date_trunc('day',1)"],
    ['mysql', 'current_database()'],
    ['mysql', "json_array_length('[]')"],
    ['oracle', 'ifnull(1,2)'],
    ['oracle', 'char_length(1)'],
    ['mssql', 'pg_typeof(1)'],
  ])('does not grant %s functions just because another engine has them: %s', (driver, call) => {
    expect(() =>
      new AccessPolicy().assertQuery(connection(driver), `SELECT ${call}`, true)
    ).toThrow(/Function is not allowed/);
  });

  it.each([
    'postgres',
    'mysql',
    'mariadb',
    'microsoft',
    'oracle',
    'sqlite',
    'duckdb',
    'clickhouse',
  ])('retains ordinary aggregate and string expressions on %s', (driver) => {
    expect(() =>
      new AccessPolicy().assertQuery(connection(driver), "SELECT COUNT(*), LOWER('PAID')", true)
    ).not.toThrow();
  });

  it.each(['postgres', 'mysql', 'microsoft', 'oracle', 'sqlite', 'duckdb', 'clickhouse'])(
    'still applies explicit builtin denials on %s',
    (driver) => {
      const target = connection(driver);
      target.accessRules!.push({ denyFunctions: [driver === 'oracle' ? 'COUNT' : 'count'] });
      expect(() => new AccessPolicy().assertQuery(target, 'SELECT COUNT(*)', true)).toThrow(
        /Function is not allowed/
      );
    }
  );
});
