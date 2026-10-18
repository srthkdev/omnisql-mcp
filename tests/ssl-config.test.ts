import { describe, it, expect } from 'vitest';
import { resolvePostgresSsl, resolveMysqlSsl } from '../src/auth/ssl.js';
import { DatabaseConnection } from '../src/types.js';

function connection(properties: Record<string, unknown>): DatabaseConnection {
  return {
    id: 'c1',
    name: 'test',
    driver: 'postgresql',
    url: '',
    properties: properties as unknown as Record<string, string>,
  };
}

describe('resolvePostgresSsl', () => {
  it('reads sslmode from nested driver properties', () => {
    const ssl = resolvePostgresSsl(connection({ properties: { sslmode: 'require' } }));
    expect(ssl).toEqual({ rejectUnauthorized: false });
  });

  it('reads sslmode from top-level properties', () => {
    expect(resolvePostgresSsl(connection({ sslmode: 'require' }))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verifies the server certificate for verify-full', () => {
    expect(resolvePostgresSsl(connection({ sslmode: 'verify-full' }))).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honours an explicit disable', () => {
    expect(resolvePostgresSsl(connection({ sslmode: 'disable' }))).toBe(false);
  });

  it('leaves the driver default alone when nothing is configured', () => {
    expect(resolvePostgresSsl(connection({}))).toBeUndefined();
  });

  it('forces TLS for IAM auth, which RDS requires', () => {
    expect(resolvePostgresSsl(connection({}), true)).toEqual({ rejectUnauthorized: false });
  });

  it('still respects an explicit disable under IAM auth', () => {
    expect(resolvePostgresSsl(connection({ sslmode: 'disable' }), true)).toBe(false);
  });

  it('treats an enabled ssl handler as require', () => {
    const ssl = resolvePostgresSsl(
      connection({ handlers: { postgre_ssl: { enabled: true, properties: {} } } })
    );
    expect(ssl).toEqual({ rejectUnauthorized: false });
  });
});

describe('resolveMysqlSsl', () => {
  it('encrypts without verifying for REQUIRED, per MySQL ssl-mode semantics', () => {
    // MySQL's REQUIRED does not authenticate the server certificate, and RDS
    // certificates are not in the system trust store.
    expect(resolveMysqlSsl(connection({ properties: { sslMode: 'REQUIRED' } }))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verifies for VERIFY_IDENTITY', () => {
    expect(resolveMysqlSsl(connection({ properties: { sslMode: 'VERIFY_IDENTITY' } }))).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honours an explicit disable', () => {
    expect(resolveMysqlSsl(connection({ sslMode: 'DISABLED' }))).toBeUndefined();
  });

  it('leaves the driver default alone when nothing is configured', () => {
    expect(resolveMysqlSsl(connection({}))).toBeUndefined();
  });

  it('forces TLS for IAM auth, which RDS requires', () => {
    expect(resolveMysqlSsl(connection({}), true)).toEqual({ rejectUnauthorized: false });
  });

  it('reads the enabled DBeaver mysql_ssl handler', () => {
    expect(
      resolveMysqlSsl(
        connection({
          handlers: {
            mysql_ssl: {
              enabled: true,
              properties: {
                'ssl.method': 'CERTIFICATES',
                'ssl.require': true,
                'ssl.verify.server': false,
              },
            },
          },
        })
      )
    ).toEqual({ rejectUnauthorized: false });
  });

  it('verifies the server for a DBeaver mysql_ssl handler that requests verification', () => {
    expect(
      resolveMysqlSsl(
        connection({
          handlers: {
            mysql_ssl: {
              enabled: true,
              properties: {
                'ssl.require': true,
                'ssl.verify.server': true,
              },
            },
          },
        })
      )
    ).toEqual({ rejectUnauthorized: true });
  });

  it('lets an explicit disabled mode override an enabled DBeaver handler', () => {
    expect(
      resolveMysqlSsl(
        connection({
          properties: { sslMode: 'DISABLED' },
          handlers: { mysql_ssl: { enabled: true, properties: {} } },
        })
      )
    ).toBeUndefined();
  });
});
