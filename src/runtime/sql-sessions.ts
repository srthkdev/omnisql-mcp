import { withDeadline } from './lease.js';
import type { PoolClient } from 'pg';
import type { PoolConnection } from 'mysql2/promise';
import type sql from 'mssql';
import type { Readable } from 'node:stream';
import type { DatabaseConnection, QueryResult } from '../types.js';
import { ResultCollector, parseJsonValue } from './results.js';
export interface SessionOptions {
  connection: DatabaseConnection;
  maxRows?: number;
  timeout: number;
  /** Destroy the physical connection; the lease owner must never release it again. */
  abort: () => void;
  /** Existing transactions drain extra rows to preserve transaction state. */
  preserveSession?: boolean;
}
export async function readPostgres(
  client: PoolClient,
  query: string,
  options: SessionOptions
): Promise<QueryResult> {
  const { default: Cursor } = await import('pg-cursor');
  const collector = new ResultCollector(options.connection, options.maxRows);
  const cursor = client.query(new Cursor(query, [], { rowMode: 'array' }));
  let timedOut = false;
  try {
    return await withDeadline(
      (async () => {
        let done = false;
        while (!done) {
          const rows = await cursor.read(Math.min(64, collector.maxRows + 1));
          if (!collector.columns.length)
            collector.columns = (
              cursor as unknown as { _result: { fields: { name: string }[] } }
            )._result.fields.map((f) => f.name);
          for (const row of rows)
            if (!collector.add(row)) {
              done = true;
              break;
            }
          if (!rows.length) done = true;
        }
        const metadata = (
          cursor as unknown as { _result: { fields: { name: string }[]; rowCount: number } }
        )._result;
        return collector.result(metadata.rowCount);
      })(),
      options.timeout,
      () => {
        timedOut = true;
        options.abort();
      }
    );
  } catch (error) {
    if (timedOut) throw new Error(`PostgreSQL query timed out after ${options.timeout}ms`);
    throw error;
  } finally {
    if (!timedOut) await cursor.close();
  }
}
export async function readMysql(
  client: PoolConnection,
  query: string,
  options: SessionOptions
): Promise<QueryResult> {
  const collector = new ResultCollector(options.connection, options.maxRows);
  let stream: Readable | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error(`MySQL query timed out after ${options.timeout}ms`);
    stream?.destroy(error);
    options.abort();
    rejectDeadline(error);
  }, options.timeout);
  const work = async () => {
    const raw = (client as unknown as { connection: import('mysql2').PoolConnection }).connection;
    const request = raw.query({ sql: query, rowsAsArray: true });
    let jsonColumns: number[] = [];
    request.on('fields', (fields: import('mysql2').FieldPacket[] | undefined) => {
      collector.columns = fields?.map((f) => f.name) ?? [];
      jsonColumns = (fields ?? []).flatMap((field, i) =>
        field.columnType === 245 || field.type === 245 || field.extendedFormat === 'json' ? [i] : []
      );
    });
    let affected = 0;
    stream = request.stream({ highWaterMark: 16 });
    for await (const row of stream) {
      if (Array.isArray(row)) {
        for (const i of jsonColumns)
          if (typeof row[i] === 'string') row[i] = parseJsonValue(row[i], true);
        if (!collector.truncated && !collector.add(row) && !options.preserveSession) {
          options.abort();
          break;
        }
      } else affected = (row as { affectedRows?: number }).affectedRows ?? 0;
    }
    return collector.result(affected);
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
export async function readSqlServer(
  request: sql.Request,
  query: string,
  options: SessionOptions
): Promise<QueryResult> {
  request.stream = true;
  request.arrayRowMode = true;
  let requestError: (Error & { code?: string }) | undefined;
  // mssql resolves its query promise in streaming mode even on server errors.
  request.on('error', (error: Error & { code?: string }) => {
    requestError ??= error;
  });
  const collector = new ResultCollector(options.connection, options.maxRows);
  let rowError: Error | undefined;
  let numericColumns: { index: number; scale: number }[] = [];
  let preciseTimeColumns: number[] = [];
  request.on(
    'recordset',
    (columns: { name: string; precision?: number; scale?: number; type?: { name?: string } }[]) => {
      numericColumns = columns
        .map((c, index) => ({ c, index }))
        .filter(
          ({ c }) => /decimal|numeric|money/i.test(c.type?.name ?? '') && (c.precision ?? 0) > 15
        )
        .map(({ c, index }) => ({ index, scale: c.scale ?? 0 }));
      // JavaScript Date cannot represent SQL Server's 100 ns timestamp values.
      // Reject potentially lossy dates; callers can select exact native text.
      preciseTimeColumns = columns.flatMap((c, index) =>
        /^(?:datetime2|datetimeoffset|time)$/i.test(c.type?.name ?? '') && (c.scale ?? 7) > 3
          ? [index]
          : []
      );
      collector.columns = columns.map((c) => c.name);
    }
  );
  request.on('row', (value: unknown) => {
    if (rowError || collector.truncated) return;
    const row = Array.isArray(value) ? value : Object.values(value as object);
    try {
      if (
        preciseTimeColumns.some((index) => row[index] instanceof Date) ||
        row.some(
          (value) =>
            value instanceof Date &&
            Number((value as Date & { nanosecondsDelta?: number }).nanosecondsDelta ?? 0) !== 0
        )
      )
        throw new Error(
          'SQL Server timestamp exceeds exact millisecond driver precision; CAST it to VARCHAR(40) in SQL (style 126 or 127 with CONVERT)'
        );
      if (
        numericColumns.some(
          ({ index, scale }) =>
            typeof row[index] === 'number' &&
            Math.abs((row[index] as number) * 10 ** scale) > Number.MAX_SAFE_INTEGER
        )
      )
        throw new Error(
          'SQL Server decimal exceeds exact driver precision; CAST it to VARCHAR in SQL'
        );
      if (!collector.add(row) && !options.preserveSession) request.cancel();
    } catch (error) {
      rowError = error instanceof Error ? error : new Error(String(error));
      request.cancel();
    }
  });
  let timedOut = false;
  try {
    const result = await withDeadline(request.query(query), options.timeout, () => {
      timedOut = true;
      request.cancel();
    });
    if (rowError) throw rowError;
    if (requestError) throw requestError;
    if (timedOut) throw new Error('SQL Server query timed out');
    return collector.result(result.rowsAffected?.[0]);
  } catch (error) {
    if (rowError) throw rowError;
    if (timedOut) throw new Error('SQL Server query timed out');
    if (collector.truncated && (error as { code?: string }).code === 'ECANCEL')
      return collector.result();
    throw error;
  }
}
