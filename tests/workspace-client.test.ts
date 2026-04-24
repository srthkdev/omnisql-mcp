import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkspaceClient } from '../src/workspace-client.js';
import type { DatabaseConnection } from '../src/types.js';

const ORIGINAL_FETCH = globalThis.fetch;

function clickhouseConn(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'clickhouse-1',
    name: 'test-ch',
    driver: 'com_clickhouse',
    url: 'jdbc:clickhouse://ch.example:443',
    host: 'ch.example',
    port: 443,
    database: 'default',
    user: 'nemo',
    properties: { password: 'secret', ssl: 'true', sslmode: 'none' },
    ...overrides,
  };
}

describe('WorkspaceClient.executeQuery — driver routing', () => {
  let client: WorkspaceClient;

  beforeEach(() => {
    client = new WorkspaceClient(undefined, 5000, false, '/tmp/fake-ws');
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('routes ClickHouse driver to HTTPS endpoint with auth headers and JSON format', async () => {
    const capturedUrls: string[] = [];
    const capturedInit: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrls.push(String(url));
      capturedInit.push(init ?? {});
      return new Response(
        JSON.stringify({
          meta: [
            { name: 'one', type: 'UInt8' },
            { name: 'label', type: 'String' },
          ],
          data: [{ one: 1, label: 'hello' }],
          rows: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const result = await client.executeQuery(clickhouseConn(), "SELECT 1 AS one, 'hello' AS label");

    expect(result.columns).toEqual(['one', 'label']);
    expect(result.rows).toEqual([[1, 'hello']]);
    expect(result.rowCount).toBe(1);

    expect(capturedUrls[0]).toMatch(/^https:\/\/ch\.example:443\//);
    expect(capturedUrls[0]).toContain('default_format=JSON');
    expect(capturedUrls[0]).toContain('database=default');

    const headers = (capturedInit[0]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-ClickHouse-User']).toBe('nemo');
    expect(headers['X-ClickHouse-Key']).toBe('secret');
    expect(capturedInit[0]?.method).toBe('POST');
    expect(capturedInit[0]?.body).toBe("SELECT 1 AS one, 'hello' AS label");
  });

  it('uses HTTPS when port is 443 even without explicit ssl flag', async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 });
    }) as typeof fetch;

    await client.executeQuery(clickhouseConn({ properties: { password: 'p' } }), 'SELECT 1');

    expect(capturedUrls[0].startsWith('https://')).toBe(true);
  });

  it('uses HTTP when SSL explicitly disabled and non-TLS port', async () => {
    const capturedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ meta: [], data: [], rows: 0 }), { status: 200 });
    }) as typeof fetch;

    await client.executeQuery(
      clickhouseConn({ port: 8123, properties: { ssl: 'false' } }),
      'SELECT 1'
    );

    expect(capturedUrls[0].startsWith('http://')).toBe(true);
    expect(capturedUrls[0]).toContain(':8123');
  });

  it('surfaces ClickHouse error responses as thrown errors', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("Code: 62. DB::Exception: Syntax error near 'FROM'", {
          status: 400,
        })
    ) as typeof fetch;

    await expect(client.executeQuery(clickhouseConn(), 'SELECT FROM broken')).rejects.toThrow(
      /ClickHouse HTTP 400/
    );
  });

  it('returns empty result for DDL responses with empty body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch;

    const result = await client.executeQuery(
      clickhouseConn(),
      'CREATE TABLE t (x Int32) ENGINE = Memory'
    );
    expect(result).toEqual({
      columns: [],
      rows: [],
      rowCount: 0,
      executionTime: expect.any(Number),
    });
  });

  it('throws a clear error for unsupported drivers instead of attempting a CLI fallback', async () => {
    const oracleConn: DatabaseConnection = {
      id: 'oracle-1',
      name: 'orcl',
      driver: 'oracle_thin',
      url: 'jdbc:oracle:thin:@//x:1521/ORCL',
    };

    await expect(client.executeQuery(oracleConn, 'SELECT 1 FROM dual')).rejects.toThrow(
      /driver "oracle_thin" is not supported/
    );
  });
});
