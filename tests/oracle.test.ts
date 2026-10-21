import { describe, it, expect, afterEach, vi } from 'bun:test';
import oracledb from 'oracledb';
import {
  resolveOracleConnectOptions,
  formatOracleLocalDate,
  oracleFetchTypeHandler,
  normalizeOracleStatement,
} from '../src/oracle.js';
import { buildListTablesQuery, buildSchemaQuery, getTestQuery } from '../src/utils.js';
import { DatabaseConnection } from '../src/types.js';

function oracleConnection(
  overrides: Partial<DatabaseConnection> = {},
  providerProperties: Record<string, string> = {}
): DatabaseConnection {
  return {
    id: 'oracle_thin-1',
    name: 'ora',
    driver: 'oracle_thin',
    url: '',
    host: 'ora.example.com',
    port: 1521,
    database: 'ORCLPDB',
    properties: { 'provider-properties': providerProperties as unknown as string },
    ...overrides,
  };
}

describe('resolveOracleConnectOptions', () => {
  const originalTnsAdmin = process.env.TNS_ADMIN;
  afterEach(() => {
    if (originalTnsAdmin === undefined) {
      delete process.env.TNS_ADMIN;
    } else {
      process.env.TNS_ADMIN = originalTnsAdmin;
    }
  });

  it('connects to a service name with Easy Connect', () => {
    const options = resolveOracleConnectOptions(oracleConnection(), 'ora.example.com', 1521);
    expect(options).toEqual({ connectString: 'ora.example.com:1521/ORCLPDB' });
  });

  it('uses explicit TCPS with server certificate matching for direct connections', () => {
    const connection = oracleConnection({ properties: { protocol: 'tcps' } });
    expect(resolveOracleConnectOptions(connection, 'ora.example.com', 2484).connectString).toBe(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=ora.example.com)(PORT=2484))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))'
    );
  });

  it('fails closed for invalid TCPS descriptors, protocols and unsupported tunnel combinations', () => {
    expect(() =>
      resolveOracleConnectOptions(oracleConnection({ properties: { protocol: 'udp' } }), 'h', 1)
    ).toThrow(/protocol/);
    expect(() =>
      resolveOracleConnectOptions(
        oracleConnection({
          properties: { protocol: 'tcps' },
          database: 'x)(SECURITY=(SSL_SERVER_DN_MATCH=NO))',
        }),
        'h',
        1
      )
    ).toThrow(/Invalid Oracle/);
    expect(() =>
      resolveOracleConnectOptions(
        oracleConnection({
          properties: { protocol: 'tcps' },
          sshTunnel: { enabled: true, host: 'bastion', port: 22 },
        }),
        'h',
        1
      )
    ).toThrow(/without an SSH/);
  });

  it('dials the given endpoint rather than the recorded host', () => {
    // Through an SSH tunnel the endpoint is a local forward.
    const options = resolveOracleConnectOptions(oracleConnection(), '127.0.0.1', 40123);
    expect(options.connectString).toBe('127.0.0.1:40123/ORCLPDB');
  });

  it('uses a descriptor for a SID chosen in the connection settings', () => {
    const connection = oracleConnection({ database: 'ORCL' }, { '@dbeaver-sid-service@': 'SID' });
    expect(resolveOracleConnectOptions(connection, 'h', 1521).connectString).toBe(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))'
    );
  });

  it('recognises the host:port:SID JDBC spelling', () => {
    const connection = oracleConnection({
      database: 'ORCL',
      url: 'jdbc:oracle:thin:@ora.example.com:1521:ORCL',
    });
    expect(resolveOracleConnectOptions(connection, 'h', 1521).connectString).toContain(
      '(SID=ORCL)'
    );
  });

  it('passes a connect descriptor URL through verbatim', () => {
    const descriptor =
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=a)(PORT=1))(CONNECT_DATA=(SERVICE_NAME=s)))';
    const connection = oracleConnection({ url: `jdbc:oracle:thin:@${descriptor}`, database: '' });
    expect(resolveOracleConnectOptions(connection, 'h', 1521).connectString).toBe(descriptor);
  });

  it('refuses a descriptor URL behind an SSH tunnel', () => {
    const connection = oracleConnection({
      url: 'jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=a)))',
      sshTunnel: { enabled: true, host: 'bastion', port: 22 },
    });
    expect(() => resolveOracleConnectOptions(connection, 'h', 1521)).toThrow(/SSH tunnel/);
  });

  it('resolves a TNS alias against the configured tnsnames.ora directory', () => {
    const connection = oracleConnection(
      { database: 'PROD_ALIAS' },
      { '@dbeaver-connection-type@': 'TNS', '@dbeaver-tns-path@': '/opt/oracle/network/admin' }
    );
    expect(resolveOracleConnectOptions(connection, 'h', 1521)).toEqual({
      connectString: 'PROD_ALIAS',
      configDir: '/opt/oracle/network/admin',
    });
  });

  it('falls back to TNS_ADMIN for a TNS alias', () => {
    process.env.TNS_ADMIN = '/etc/oracle';
    const connection = oracleConnection(
      { database: 'PROD_ALIAS' },
      { '@dbeaver-connection-type@': 'TNS' }
    );
    expect(resolveOracleConnectOptions(connection, 'h', 1521).configDir).toBe('/etc/oracle');
  });

  it('rejects a TNS alias with no tnsnames.ora location', () => {
    delete process.env.TNS_ADMIN;
    const connection = oracleConnection({}, { '@dbeaver-connection-type@': 'TNS' });
    expect(() => resolveOracleConnectOptions(connection, 'h', 1521)).toThrow(/tnsnames/);
  });

  it('maps an administrative logon role', () => {
    const connection = oracleConnection({}, { '@dbeaver-internal-logon@': 'SYSDBA' });
    expect(resolveOracleConnectOptions(connection, 'h', 1521).privilege).toBe(oracledb.SYSDBA);
  });

  it('ignores the NORMAL logon role', () => {
    const connection = oracleConnection({}, { '@dbeaver-internal-logon@': 'NORMAL' });
    expect(resolveOracleConnectOptions(connection, 'h', 1521).privilege).toBeUndefined();
  });

  it('brackets an IPv6 host', () => {
    expect(resolveOracleConnectOptions(oracleConnection(), '::1', 1521).connectString).toBe(
      '[::1]:1521/ORCLPDB'
    );
  });

  it('requires a SID or service name', () => {
    expect(() =>
      resolveOracleConnectOptions(oracleConnection({ database: '' }), 'h', 1521)
    ).toThrow(/SID or service/);
  });
});

describe('formatOracleLocalDate', () => {
  it('renders the stored wall-clock fields', () => {
    expect(formatOracleLocalDate(new Date(2024, 0, 15))).toBe('2024-01-15 00:00:00');
  });

  it('keeps milliseconds when present', () => {
    expect(formatOracleLocalDate(new Date(2025, 5, 1, 13, 4, 5, 7))).toBe(
      '2025-06-01 13:04:05.007'
    );
  });
});

describe('oracleFetchTypeHandler', () => {
  const handle = (dbType: unknown) =>
    oracleFetchTypeHandler({ dbType, precision: 3 } as unknown as oracledb.Metadata<unknown>);

  it('keeps LOB locators lazy until the result budget is checked', () => {
    expect(handle(oracledb.DB_TYPE_CLOB)?.type).toBe(oracledb.DB_TYPE_CLOB);
    expect(handle(oracledb.DB_TYPE_NCLOB)?.type).toBe(oracledb.DB_TYPE_NCLOB);
    expect(handle(oracledb.DB_TYPE_BLOB)?.type).toBe(oracledb.DB_TYPE_BLOB);
  });

  it('renders binary data as hex', () => {
    const converter = handle(oracledb.DB_TYPE_RAW)?.converter;
    expect(converter?.(Buffer.from([0xca, 0xfe]))).toBe('CAFE');
    expect(converter?.(null)).toBeNull();
  });

  it('renders zoned timestamps as UTC instants', () => {
    const converter = handle(oracledb.DB_TYPE_TIMESTAMP_TZ)?.converter;
    expect(converter?.(new Date(Date.UTC(2026, 9, 5, 18, 0, 0)))).toBe('2026-10-05T18:00:00.000Z');
  });

  it('rejects sub-millisecond and unknown timestamp precision before conversion', () => {
    for (const dbType of [
      oracledb.DB_TYPE_TIMESTAMP,
      oracledb.DB_TYPE_TIMESTAMP_TZ,
      oracledb.DB_TYPE_TIMESTAMP_LTZ,
    ]) {
      for (const precision of [undefined, 6, 9])
        expect(() =>
          oracleFetchTypeHandler({ dbType, precision } as oracledb.Metadata<unknown>)
        ).toThrow(/TO_CHAR/);
    }
  });

  it('leaves other types to the driver', () => {
    expect(handle(oracledb.DB_TYPE_NUMBER)).toEqual({ type: oracledb.DB_TYPE_VARCHAR });
  });
});

describe('Oracle metadata queries', () => {
  it('reads the version from v$version', () => {
    expect(getTestQuery('oracle_thin')).toMatch(/v\$version/);
  });

  it('skips Oracle-maintained schemas when no schema is given', () => {
    expect(buildListTablesQuery('oracle_thin')).toContain("oracle_maintained = 'Y'");
  });

  it('filters on the given schema', () => {
    const query = buildListTablesQuery('oracle_thin', 'hr', true);
    expect(query).toContain("owner = 'hr'");
    expect(query).not.toContain('oracle_maintained');
  });

  it('describes a table in the current schema by default', () => {
    const query = buildSchemaQuery('oracle_thin', 'clients');
    expect(query).toContain("SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')");
    expect(query).toContain("c.table_name = 'clients'");
  });

  it('describes a table in another schema', () => {
    const query = buildSchemaQuery('oracle_thin', 'hr.employees');
    expect(query).toContain("c.owner = 'hr'");
    expect(query).toContain("c.table_name = 'employees'");
  });
});

describe('Oracle execution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('removes SQL delimiters and preserves PL/SQL terminators', () => {
    expect(normalizeOracleStatement('SELECT 1 FROM dual;  ')).toBe('SELECT 1 FROM dual');
    expect(normalizeOracleStatement('BEGIN NULL; END;\n/')).toBe('BEGIN NULL; END;');
    expect(normalizeOracleStatement('SELECT 1 FROM dual; DROP TABLE users;')).toBe(
      'SELECT 1 FROM dual; DROP TABLE users'
    );
  });

  it('rejects TNS aliases that would bypass the SSH tunnel', () => {
    const connection = oracleConnection(
      { sshTunnel: { enabled: true, host: 'bastion', port: 22 } },
      { '@dbeaver-connection-type@': 'TNS' }
    );
    expect(() => resolveOracleConnectOptions(connection, '127.0.0.1', 40000)).toThrow(/SSH tunnel/);
  });

  it('caps the fetch, normalizes SQL, and closes the session after an error', async () => {
    const { WorkspaceClient } = await import('../src/workspace-client.js');
    const execute = vi.fn().mockResolvedValueOnce({}).mockRejectedValue(new Error('ORA-00942'));
    const close = vi.fn().mockResolvedValue(undefined);
    const closePool = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(oracledb, 'createPool').mockResolvedValue({
      getConnection: vi.fn().mockResolvedValue({ execute, close }),
      close: closePool,
    } as never);
    const client = new WorkspaceClient();
    await expect(
      client.executeQuery(oracleConnection({ user: 'app' }), 'SELECT * FROM missing;', {
        maxRows: 10,
      })
    ).rejects.toThrow('ORA-00942');
    expect(execute).toHaveBeenCalledWith(
      'SELECT * FROM missing',
      [],
      expect.objectContaining({ resultSet: true })
    );
    expect(close).toHaveBeenCalledOnce();
    await client.close();
    expect(closePool).toHaveBeenCalledOnce();
  });
});
