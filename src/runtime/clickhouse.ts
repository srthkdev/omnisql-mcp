import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createGunzip, createZstdDecompress, constants } from 'node:zlib';
import type { Transform } from 'node:stream';
import { analyzeSql } from '../policy/analyzer.js';
import { validateReadStatement } from '../policy/sql.js';
import { readConnectionProp as prop } from '../auth/connection-props.js';
import { resolveHttpTls } from '../auth/ssl.js';
import { booleanSetting, integerSetting } from '../runtime-config.js';
import type { DatabaseConnection, QueryResult } from '../types.js';
import type { SqlAdapter } from './adapter.js';
import { ResultCollector, CompactRowStream, ResultTextDecoder } from './results.js';
import { compressText } from './compression.js';

interface Transport {
  timeout: () => number;
  endpoint: (
    connection: DatabaseConnection,
    port: number
  ) => Promise<{ host: string; port: number }>;
}

/** HTTP credentials stay in headers; SQL stays in the POST body. Redirects are rejected. */
export function clickhouseAdapter(transport: Transport): SqlAdapter {
  let plain: http.Agent | undefined, encrypted: https.Agent | undefined;
  let closed = false;
  return {
    id: 'clickhouse',
    capabilities: { databaseOverride: true, readOnly: 'server', transactions: false },
    close() {
      closed = true;
      plain?.destroy();
      encrypted?.destroy();
    },
    async execute(connection, query, options) {
      if (closed) throw new Error('ClickHouse adapter is closed');
      const analysis = analyzeSql(query, 'clickhouse');
      const readOnly = options.readOnly || validateReadStatement(query) === null;
      if (analysis.opaqueRelations || analysis.settings || analysis.locking)
        throw new Error(
          'ClickHouse external/dynamic table functions, query settings, formats, and locks are disabled'
        );
      const originalHost = connection.host || prop(connection, 'host');
      if (!originalHost) throw new Error('ClickHouse requires an explicit host');
      const urlProtocol = connection.url
        .match(/^(?:jdbc:(?:clickhouse|ch):)?(https?):\/\//i)?.[1]
        ?.toLowerCase();
      const queryStart = connection.url.indexOf('?');
      const urlSsl =
        queryStart >= 0
          ? new URLSearchParams(connection.url.slice(queryStart + 1)).get('ssl')
          : undefined;
      const ssl = prop(connection, 'ssl') ?? urlSsl ?? undefined;
      const secure =
        urlProtocol === 'https' ||
        booleanSetting(ssl === '1' ? 'true' : ssl === '0' ? 'false' : ssl, 'ClickHouse ssl', false);
      const port = urlProtocol ? (urlProtocol === 'https' ? 443 : 80) : secure ? 8443 : 8123;
      const endpoint = await transport.endpoint(connection, port);
      const tls = secure ? resolveHttpTls({ ...connection, host: originalHost }) : {};
      const timeout = connection.limits?.timeoutMs ?? transport.timeout();
      const collector = new ResultCollector(connection, options.maxRows);
      const parser = new CompactRowStream(collector);
      const compression = prop(connection, 'clickhouse.compression') ?? 'zstd';
      if (compression !== 'none' && compression !== 'gzip' && compression !== 'zstd')
        throw new Error('clickhouse.compression must be none, gzip, or zstd');
      const compressed = compression !== 'none';
      const readonlyMode = integerSetting(
        prop(connection, 'clickhouse.readonlyMode'),
        'clickhouse.readonlyMode',
        1,
        1,
        2
      );
      const queryId = randomUUID();
      const parameters = new URLSearchParams({
        database: connection.database || 'default',
        query_id: queryId,
        default_format: 'JSONCompactEachRowWithNamesAndTypes',
        readonly: readOnly ? String(readonlyMode) : '0',
        max_execution_time: String(Math.max(1, Math.ceil(timeout / 1000))),
        max_memory_usage: String(
          integerSetting(
            prop(connection, 'clickhouse.memoryMB'),
            'clickhouse.memoryMB',
            256,
            16,
            4096
          ) *
            1024 *
            1024
        ),
        cancel_http_readonly_queries_on_client_close: '1',
        output_format_json_quote_64bit_integers: '1',
        output_format_json_quote_decimals: '1',
        output_format_decimal_trailing_zeros: '1',
        output_format_json_map_as_array_of_tuples: '1',
        enable_http_compression: compressed ? '1' : '0',
      });
      let body: Buffer = Buffer.from(query),
        requestCompressed = false;
      if (compressed && body.length > 4096) {
        const archive = await compressText(query, compression, timeout);
        if (archive.length < body.length) {
          body = archive;
          requestCompressed = true;
        }
      }
      const agentOptions = {
        keepAlive: true,
        maxSockets: 8,
        maxFreeSockets: 2,
        maxTotalSockets: 32,
        timeout: 30000,
      };
      const agent = secure
        ? (encrypted ??= new https.Agent(agentOptions))
        : (plain ??= new http.Agent(agentOptions));
      const username = connection.user || prop(connection, 'user') || 'default';
      if (username.includes(':'))
        throw new Error('ClickHouse HTTP usernames cannot contain a colon');
      const authorization =
        'Basic ' +
        Buffer.from(username + ':' + (prop(connection, 'password') || ''), 'utf8').toString(
          'base64'
        );
      // Replacing our own random ID avoids requiring access to other users' process metadata.
      const cancel = () =>
        new Promise<boolean>((resolveCancel) => {
          if (closed) {
            resolveCancel(false);
            return;
          }
          let kill: http.ClientRequest | undefined,
            done = false;
          const finishCancel = (confirmed: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            kill?.destroy();
            resolveCancel(confirmed);
          };
          const timer = setTimeout(() => finishCancel(false), 750);
          try {
            const parameters = new URLSearchParams({
              database: connection.database || 'default',
              readonly: String(readonlyMode),
              default_format: 'Null',
              query_id: queryId,
              replace_running_query: '1',
            });
            kill = (secure ? https : http).request(
              {
                hostname: endpoint.host,
                port: endpoint.port,
                method: 'POST',
                path: '/?' + parameters,
                agent,
                ...tls,
                headers: {
                  Authorization: authorization,
                  'Content-Type': 'text/plain; charset=utf-8',
                },
              },
              (response) => {
                let bytes = 0,
                  errorText = '';
                response.on('data', (chunk) => {
                  bytes += chunk.length;
                  if (errorText.length < 4096) errorText += chunk.toString();
                  if (bytes > 65536) finishCancel(false);
                });
                response.on('end', () =>
                  finishCancel(
                    response.statusCode === 200 &&
                      !Number(response.headers['x-clickhouse-exception-code'] || 0) &&
                      !/(?:^|\n)Code:\s*\d+/.test(errorText)
                  )
                );
                response.on('error', () => finishCancel(false));
                response.on('aborted', () => finishCancel(false));
              }
            );
            kill.on('error', () => finishCancel(false));
            kill.end('SELECT 1');
          } catch {
            finishCancel(false);
          }
        });
      return new Promise<QueryResult>((resolve, reject) => {
        let settled = false;
        let sent = false;
        let request: http.ClientRequest | undefined;
        let response: http.IncomingMessage | undefined;
        let decoder: Transform | undefined;
        const finish = (error?: Error) => {
          if (settled) return;
          let result: QueryResult | undefined;
          if (!error)
            try {
              result = collector.result();
            } catch (failure) {
              error = failure instanceof Error ? failure : new Error(String(failure));
            }
          settled = true;
          clearTimeout(deadline);
          const needsCancel =
            sent && (!response || response.statusCode === 200) && !response?.complete;
          if (error || needsCancel) {
            decoder?.destroy();
            response?.destroy();
            request?.destroy();
          }
          const complete = (confirmed: boolean) => {
            if (!confirmed) {
              if (error) error.message += '; server cancellation could not be confirmed';
              else
                error = new Error(
                  'Result limit reached but server cancellation could not be confirmed'
                );
            }
            if (error) reject(error);
            else {
              if (!readOnly) result!.affectedRows = null;
              resolve(result!);
            }
          };
          if (needsCancel) void cancel().then(complete);
          else complete(true);
        };
        const deadline = setTimeout(
          () =>
            finish(
              new Error(
                `ClickHouse query timed out after ${timeout}ms${readOnly ? '' : '; write status is unknown, check before retrying'}`
              )
            ),
          timeout
        );
        try {
          request = (secure ? https : http).request(
            {
              hostname: endpoint.host,
              port: endpoint.port,
              method: 'POST',
              path: '/?' + parameters.toString(),
              agent,
              ...tls,
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': body.length,
                Authorization: authorization,
                ...(compressed
                  ? { 'Accept-Encoding': compression === 'zstd' ? 'zstd, gzip;q=0.5' : 'gzip' }
                  : {}),
                ...(requestCompressed ? { 'Content-Encoding': compression } : {}),
              },
            },
            (incoming) => {
              response = incoming;
              const status = incoming.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                finish(new Error('ClickHouse HTTP redirects are not allowed'));
                return;
              }
              const encoding = String(incoming.headers['content-encoding'] || '');
              if (
                encoding &&
                encoding !== 'identity' &&
                encoding !== 'gzip' &&
                encoding !== 'zstd'
              ) {
                finish(new Error('Unsupported ClickHouse HTTP compression'));
                return;
              }
              let stream: http.IncomingMessage | Transform;
              try {
                stream =
                  encoding === 'gzip'
                    ? incoming.pipe((decoder = createGunzip()))
                    : encoding === 'zstd'
                      ? incoming.pipe(
                          (decoder = createZstdDecompress({
                            params: { [constants.ZSTD_d_windowLogMax]: 23 },
                          }))
                        )
                      : incoming;
              } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
                return;
              }
              let errorText = '';
              const textDecoder = new ResultTextDecoder();
              const serverError =
                status !== 200 ||
                Number(incoming.headers['x-clickhouse-exception-code'] || 0) !== 0;
              stream.on('data', (bytes: Buffer) => {
                if (settled) return;
                let chunk: string;
                try {
                  chunk = textDecoder.decode(bytes);
                } catch (error) {
                  finish(error as Error);
                  return;
                }
                if (serverError) {
                  errorText += chunk;
                  if (errorText.length > 65536)
                    finish(new Error(`ClickHouse HTTP ${status}: ${errorText.slice(0, 65536)}`));
                  return;
                }
                try {
                  if (!parser.write(chunk)) {
                    finish();
                    decoder?.destroy();
                    incoming.destroy();
                    request?.destroy();
                  }
                } catch (error) {
                  finish(
                    new Error(
                      `ClickHouse result stream failed: ${error instanceof Error ? error.message : String(error)}`
                    )
                  );
                }
              });
              stream.on('end', () => {
                if (settled) return;
                if (serverError) {
                  finish(new Error(`ClickHouse HTTP ${status}: ${errorText.slice(0, 65536)}`));
                  return;
                }
                try {
                  const tail = textDecoder.decode();
                  if (tail) parser.write(tail);
                  parser.finish(!readOnly);
                  finish();
                } catch (error) {
                  finish(error instanceof Error ? error : new Error(String(error)));
                }
              });
              stream.on('error', (error) => finish(error));
              incoming.on('aborted', () =>
                finish(new Error('ClickHouse HTTP response ended before completion'))
              );
              incoming.on('error', (error) => finish(error));
            }
          );
          request.on('error', (error) => finish(error));
          request.on('finish', () => {
            sent = true;
          });
          request.end(body);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}
