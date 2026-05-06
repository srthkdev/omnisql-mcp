import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  enforceReadOnly,
  sanitizeConnectionId,
  sanitizeIdentifier,
  getTestQuery,
  parseConnectionId,
} from '../src/utils.js';

describe('validateQuery', () => {
  it('should allow SELECT queries', () => {
    expect(validateQuery('SELECT * FROM users')).toBeNull();
  });

  it('should allow SELECT with WHERE', () => {
    expect(validateQuery('SELECT * FROM users WHERE id = 1')).toBeNull();
  });

  it('should block DROP DATABASE', () => {
    expect(validateQuery('DROP DATABASE test')).not.toBeNull();
  });

  it('should block TRUNCATE', () => {
    expect(validateQuery('TRUNCATE TABLE users')).not.toBeNull();
  });

  it('should block DELETE without WHERE', () => {
    expect(validateQuery('DELETE FROM users')).not.toBeNull();
  });

  it('should allow DELETE with WHERE', () => {
    expect(validateQuery('DELETE FROM users WHERE id = 1')).toBeNull();
  });

  it('should block UPDATE without WHERE', () => {
    expect(validateQuery('UPDATE users SET name = "test"')).not.toBeNull();
  });

  it('should allow UPDATE with WHERE', () => {
    expect(validateQuery('UPDATE users SET name = "test" WHERE id = 1')).toBeNull();
  });

  it('should block UPDATE without WHERE even with complex SET', () => {
    expect(validateQuery('UPDATE users SET name = "test", age = 30')).not.toBeNull();
  });

  it('should return error for empty query', () => {
    expect(validateQuery('')).not.toBeNull();
  });

  it('should block GRANT statements', () => {
    expect(validateQuery('GRANT ALL ON users TO admin')).not.toBeNull();
  });

  it('should block REVOKE statements', () => {
    expect(validateQuery('REVOKE ALL ON users FROM admin')).not.toBeNull();
  });

  it('should allow INSERT statements', () => {
    expect(validateQuery('INSERT INTO users (name) VALUES ("test")')).toBeNull();
  });
});

describe('enforceReadOnly', () => {
  it('should allow SELECT queries', () => {
    expect(enforceReadOnly('SELECT * FROM users')).toBeNull();
  });

  it('should allow SELECT with subqueries', () => {
    expect(enforceReadOnly('SELECT * FROM (SELECT id FROM users) sub')).toBeNull();
  });

  it('should allow EXPLAIN queries', () => {
    expect(enforceReadOnly('EXPLAIN SELECT * FROM users')).toBeNull();
  });

  it('should allow WITH (CTE) queries', () => {
    expect(enforceReadOnly('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBeNull();
  });

  it('should allow SHOW queries', () => {
    expect(enforceReadOnly('SHOW TABLES')).toBeNull();
  });

  it('should allow DESCRIBE queries', () => {
    expect(enforceReadOnly('DESCRIBE users')).toBeNull();
  });

  it('should allow PRAGMA queries', () => {
    expect(enforceReadOnly('PRAGMA table_info(users)')).toBeNull();
  });

  it('should block INSERT queries', () => {
    expect(enforceReadOnly('INSERT INTO users (name) VALUES ("test")')).not.toBeNull();
  });

  it('should block UPDATE queries', () => {
    expect(enforceReadOnly('UPDATE users SET name = "test" WHERE id = 1')).not.toBeNull();
  });

  it('should block DELETE queries', () => {
    expect(enforceReadOnly('DELETE FROM users WHERE id = 1')).not.toBeNull();
  });

  it('should block CREATE TABLE queries', () => {
    expect(enforceReadOnly('CREATE TABLE test (id INT)')).not.toBeNull();
  });

  it('should block DROP TABLE queries', () => {
    expect(enforceReadOnly('DROP TABLE users')).not.toBeNull();
  });

  it('should block ALTER TABLE queries', () => {
    expect(enforceReadOnly('ALTER TABLE users ADD COLUMN age INT')).not.toBeNull();
  });

  it('should return error for empty query', () => {
    expect(enforceReadOnly('')).not.toBeNull();
  });
});

describe('sanitizeConnectionId', () => {
  it('should allow valid connection IDs', () => {
    expect(sanitizeConnectionId('my-connection')).toBe('my-connection');
    expect(sanitizeConnectionId('conn_123')).toBe('conn_123');
    expect(sanitizeConnectionId('db.local')).toBe('db.local');
  });

  it('should remove invalid characters', () => {
    expect(sanitizeConnectionId('conn;DROP TABLE')).toBe('connDROPTABLE');
    expect(sanitizeConnectionId('test<script>')).toBe('testscript');
  });

  it('should preserve "/" for the database-override suffix', () => {
    expect(sanitizeConnectionId('my-conn/analytics')).toBe('my-conn/analytics');
    expect(sanitizeConnectionId('postgres-jdbc-abc/orders')).toBe('postgres-jdbc-abc/orders');
  });
});

describe('parseConnectionId', () => {
  it('should return baseId and null override when no slash is present', () => {
    expect(parseConnectionId('my-conn')).toEqual({
      baseId: 'my-conn',
      databaseOverride: null,
    });
  });

  it('should split on the first slash into base and override', () => {
    expect(parseConnectionId('my-conn/analytics')).toEqual({
      baseId: 'my-conn',
      databaseOverride: 'analytics',
    });
  });

  it('should treat empty halves as no override', () => {
    expect(parseConnectionId('/analytics')).toEqual({
      baseId: '/analytics',
      databaseOverride: null,
    });
    expect(parseConnectionId('my-conn/')).toEqual({
      baseId: 'my-conn/',
      databaseOverride: null,
    });
  });

  it('should preserve later slashes inside the database name', () => {
    expect(parseConnectionId('my-conn/foo/bar')).toEqual({
      baseId: 'my-conn',
      databaseOverride: 'foo/bar',
    });
  });
});

describe('sanitizeIdentifier', () => {
  it('should allow valid identifiers', () => {
    expect(sanitizeIdentifier('users')).toBe('users');
    expect(sanitizeIdentifier('my_table')).toBe('my_table');
    expect(sanitizeIdentifier('Table123')).toBe('Table123');
    expect(sanitizeIdentifier('_private')).toBe('_private');
  });

  it('should reject identifiers with SQL injection patterns', () => {
    expect(() => sanitizeIdentifier("users'; DROP TABLE--")).toThrow();
    expect(() => sanitizeIdentifier('table"name')).toThrow();
    expect(() => sanitizeIdentifier('name;')).toThrow();
    expect(() => sanitizeIdentifier('/* comment */')).toThrow();
  });

  it('should reject identifiers starting with numbers', () => {
    expect(() => sanitizeIdentifier('123table')).toThrow();
  });

  it('should reject empty identifiers', () => {
    expect(() => sanitizeIdentifier('')).toThrow();
  });

  it('should reject identifiers that are too long', () => {
    const longName = 'a'.repeat(129);
    expect(() => sanitizeIdentifier(longName)).toThrow();
  });

  it('should trim whitespace', () => {
    expect(sanitizeIdentifier('  users  ')).toBe('users');
  });
});

describe('getTestQuery', () => {
  it('should return correct query for postgres', () => {
    expect(getTestQuery('postgresql')).toContain('SELECT');
  });

  it('should return correct query for mysql', () => {
    expect(getTestQuery('mysql')).toContain('SELECT');
  });

  it('should return correct query for sqlite', () => {
    expect(getTestQuery('sqlite')).toContain('SELECT');
  });

  it('should return correct query for SAP HANA', () => {
    expect(getTestQuery('sap_hana')).toContain('DUMMY');
  });

  it('should return correct query for DB2', () => {
    expect(getTestQuery('db2_zos')).toContain('SYSIBM');
  });

  it('should return default query for unknown driver', () => {
    expect(getTestQuery('unknown')).toContain('SELECT');
  });
});
