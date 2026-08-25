import { describe, it, expect } from 'vitest';
import {
  resolveDriverDialect,
  dialectFromJdbcUrl,
  parseJdbcUrl,
  isRoutableDriverId,
} from '../src/utils.js';

describe('isRoutableDriverId', () => {
  it('accepts stock driver ids that name their engine', () => {
    expect(isRoutableDriverId('postgres-jdbc')).toBe(true);
    expect(isRoutableDriverId('mysql8')).toBe(true);
    expect(isRoutableDriverId('sqlite_jdbc')).toBe(true);
  });

  it('rejects opaque ids used by custom drivers', () => {
    expect(isRoutableDriverId('35379A2C-3AE9-529E-B72B-244C753C055B')).toBe(false);
    expect(isRoutableDriverId('')).toBe(false);
  });
});

describe('dialectFromJdbcUrl', () => {
  it('reads the engine from a plain JDBC URL', () => {
    expect(dialectFromJdbcUrl('jdbc:postgresql://db.example.com:5432/app')).toBe('postgresql');
    expect(dialectFromJdbcUrl('jdbc:mysql://db.example.com:3306/app')).toBe('mysql');
  });

  it('sees past a wrapper sub-protocol to the real engine', () => {
    expect(dialectFromJdbcUrl('jdbc:aws-wrapper:postgresql://db.example.com:5432/app')).toBe(
      'postgresql'
    );
    expect(dialectFromJdbcUrl('jdbc:aws-wrapper:mysql://db.example.com:3306/')).toBe('mysql');
  });

  it('returns null when no engine can be identified', () => {
    expect(dialectFromJdbcUrl('jdbc:acme-proprietary://host/db')).toBeNull();
    expect(dialectFromJdbcUrl('')).toBeNull();
  });
});

describe('resolveDriverDialect', () => {
  it('leaves stock driver ids untouched', () => {
    expect(resolveDriverDialect('postgres-jdbc', 'postgresql', 'jdbc:postgresql://h/d')).toBe(
      'postgres-jdbc'
    );
    expect(resolveDriverDialect('mysql8', 'mysql', '')).toBe('mysql8');
  });

  it('falls back to the provider for an opaque custom driver id', () => {
    expect(
      resolveDriverDialect(
        '35379A2C-3AE9-529E-B72B-244C753C055B',
        'postgresql',
        'jdbc:aws-wrapper:postgresql://h:5432/postgres'
      )
    ).toBe('postgresql');

    expect(
      resolveDriverDialect(
        '8C75BE41-09DC-5868-B24A-9224F6FC750F',
        'mysql',
        'jdbc:aws-wrapper:mysql://h:3306/'
      )
    ).toBe('mysql');
  });

  it('falls back to the JDBC URL when the provider is also unhelpful', () => {
    expect(
      resolveDriverDialect('some-uuid', 'custom-provider', 'jdbc:aws-wrapper:postgresql://h/d')
    ).toBe('postgresql');
  });

  it('returns the raw id when nothing resolves, so errors can name it', () => {
    expect(resolveDriverDialect('acme-driver', 'acme', 'jdbc:acme://h/d')).toBe('acme-driver');
  });

  it('routes resolved dialects the way the native dispatch expects', () => {
    // The dispatch in workspace-client/connection-pool substring-matches these.
    const pg = resolveDriverDialect('UUID-1', 'postgresql', '');
    const my = resolveDriverDialect('UUID-2', 'mysql', '');
    expect(pg.toLowerCase().includes('postgres')).toBe(true);
    expect(my.toLowerCase().includes('mysql')).toBe(true);
  });
});

describe('parseJdbcUrl', () => {
  it('pulls host, port and database out of a wrapper URL', () => {
    expect(
      parseJdbcUrl(
        'jdbc:aws-wrapper:postgresql://shared-int.cluster-x.us-east-1.rds.amazonaws.com:5432/postgres'
      )
    ).toEqual({
      host: 'shared-int.cluster-x.us-east-1.rds.amazonaws.com',
      port: 5432,
      database: 'postgres',
    });
  });

  it('omits an empty database segment', () => {
    expect(
      parseJdbcUrl('jdbc:aws-wrapper:mysql://db.x.us-gov-east-1.rds.amazonaws.com:3306/')
    ).toEqual({
      host: 'db.x.us-gov-east-1.rds.amazonaws.com',
      port: 3306,
    });
  });

  it('tolerates a missing port and trailing properties', () => {
    expect(parseJdbcUrl('jdbc:postgresql://db.example.com/app?sslmode=require')).toEqual({
      host: 'db.example.com',
      database: 'app',
    });
  });

  it('returns nothing for a URL with no authority', () => {
    expect(parseJdbcUrl('jdbc:sqlite:/tmp/local.db')).toEqual({});
    expect(parseJdbcUrl('')).toEqual({});
  });
});

describe('opaque (UUID) driver ids', () => {
  // `db2` is a valid hex triple, so a substring scan judges roughly one UUID in
  // 140 "already routable" and returns it unresolved.
  const uuidContainingDb2 = 'a1db2f3c-9e4d-4a1b-8c7e-000000000000';

  it('should not treat a UUID driver id as carrying a dialect', () => {
    expect(isRoutableDriverId(uuidContainingDb2)).toBe(false);
    expect(isRoutableDriverId('7f3a9c21-1111-2222-3333-444455556666')).toBe(false);
  });

  it('should fall through to the provider for a UUID driver id', () => {
    expect(resolveDriverDialect(uuidContainingDb2, 'postgresql', '')).toBe('postgresql');
  });

  it('should fall through to the JDBC URL when there is no provider', () => {
    expect(resolveDriverDialect(uuidContainingDb2, '', 'jdbc:mysql://h:3306/app')).toBe('mysql');
  });

  it('should accept brace-wrapped and upper-case UUIDs', () => {
    expect(isRoutableDriverId('{A1DB2F3C-9E4D-4A1B-8C7E-000000000000}')).toBe(false);
  });

  it('should still route a driver id that genuinely names db2', () => {
    expect(isRoutableDriverId('db2_luw')).toBe(true);
  });
});
