import { booleanSetting } from '../src/runtime-config.js';
import { describe, it, expect } from 'bun:test';
import { enforceReadOnly, validateQuery, redactConnection, redactArgs } from '../src/utils.js';
import { validateToolArguments } from '../src/policy/arguments.js';
import { parseKnownHosts, verifyHostKey } from '../src/net/known-hosts.js';
import { resolveMysqlSsl } from '../src/auth/ssl.js';

describe('SQL policy regression cases', () => {
  it.each([
    "SELECT nextval('counter')",
    'SELECT pg_catalog."setval"(\'counter\', 9)',
    "SELECT set_config('role', 'admin', false)",
    "SELECT pg_read_file('/private/file')",
    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/file' */",
    'SELECT pg_advisory_lock(123)',
    'SELECT 1; /* separate statement */ SELECT 2',
    'SELECT 1 FOR UPDATE',
    "SELECT 1--1 INTO OUTFILE '/tmp/file'",
    "SELECT 1 /*M! INTO OUTFILE '/tmp/file' */",
    "SELECT 1 /* outer /* inner */ INTO OUTFILE '/tmp/file' /* end */",
  ])('rejects a read-path escape: %s', (query) => expect(enforceReadOnly(query)).not.toBeNull());
  it.each([
    'CREATE TABLE example(id int); DROP TABLE important',
    'ALTER TABLE example ADD COLUMN v int; SELECT 1',
    'DELETE FROM example -- WHERE exists only in this comment',
    "UPDATE example SET value = 'a WHERE clause'",
    'DELETE FROM "example" /* WHERE id=1 */',
  ])('rejects a write guard bypass: %s', (query) => expect(validateQuery(query)).not.toBeNull());
  it.each([
    'UPDATE "example" SET value = \'WHERE; DELETE\' WHERE id = 1',
    'DELETE FROM example WHERE id = 1',
    'CREATE TABLE example(id int)',
  ])('allows an explicitly scoped statement: %s', (query) =>
    expect(validateQuery(query)).toBeNull()
  );
  it('does not confuse a literal or quoted column with executable SQL', () => {
    expect(enforceReadOnly('SELECT \'nextval(1); UPDATE\' AS "update"')).toBeNull();
  });
});

describe('public connection details', () => {
  it('never copies arbitrary credential containers or connection strings', () => {
    const input = {
      id: 'test',
      name: 'Test',
      host: 'localhost',
      url: 'jdbc:postgresql://app:secret-url@localhost/db',
      properties: { password: 'secret-db', nested: { password: 'secret-nested' } },
      sshTunnel: {
        enabled: true,
        host: 'jump',
        port: 22,
        password: 'secret-ssh',
        passphrase: 'secret-key',
      },
    };
    const result = redactConnection(input);
    expect(result).toMatchObject({ id: 'test', name: 'Test', driver: 'generic' });
    expect(result).not.toHaveProperty('host');
    expect(result).not.toHaveProperty('sshTunnel');
    expect(JSON.stringify(result)).not.toMatch(/secret-|jdbc:/);
    expect(input.sshTunnel.password).toBe('secret-ssh');
  });
  it('keeps SQL and analysis text out of debug argument logs', () => {
    const logged = redactArgs({
      connectionId: 'test',
      query: 'SELECT sensitive_data',
      insight: 'private analysis',
    });
    expect(logged).toEqual({
      connectionId: 'test',
      query: '***REDACTED***',
      insight: '***REDACTED***',
    });
  });
});

describe('runtime tool arguments', () => {
  const tool = {
    name: 'example',
    inputSchema: {
      type: 'object' as const,
      properties: {
        confirm: { type: 'boolean' },
        maxRows: { type: 'integer', minimum: 1 },
        query: { type: 'string' },
      },
      required: ['confirm'],
    },
  };
  it.each([
    { confirm: 'false' },
    { confirm: 0 },
    { confirm: true, maxRows: -1 },
    { confirm: true, maxRows: 1.5 },
    { confirm: true, maxRows: Infinity },
    { confirm: true, query: [] },
    { confirm: true, unknown: 'value' },
    {},
  ])('rejects invalid values: %j', (input) =>
    expect(() => validateToolArguments(tool, input)).toThrow()
  );
  it('accepts false as a boolean without coercing it to an approval', () =>
    expect(validateToolArguments(tool, { confirm: false })).toEqual({ confirm: false }));
});

describe('transport security', () => {
  it('a revoked key takes precedence over a duplicate trusted entry', () => {
    const key = Buffer.from('synthetic public key');
    const contents = `host ssh-ed25519 ${key.toString('base64')}\n@revoked host ssh-ed25519 ${key.toString('base64')}`;
    expect(verifyHostKey('host', 22, 'ssh-ed25519', key, parseKnownHosts(contents)).status).toBe(
      'mismatch'
    );
  });
  it('refuses cleartext IAM authentication for MySQL', () =>
    expect(() => resolveMysqlSsl({ properties: { sslmode: 'disabled' } } as any, true)).toThrow(
      /requires TLS/
    ));
});

describe('configuration parsing', () => {
  it('never treats a misspelled read-only flag as write access', () => {
    expect(booleanSetting('TRUE', 'read-only')).toBe(true);
    expect(() => booleanSetting('treu', 'read-only')).toThrow(/true or false/);
  });
});
