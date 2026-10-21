import type * as OracleTypes from 'oracledb';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
type OracleModule = typeof import('oracledb') & { Lob: new () => OracleTypes.Lob };
let cached: OracleModule | undefined;
const oracleDriver = () => (cached ??= require('oracledb') as OracleModule);
import type { DatabaseConnection } from './types.js';
import { parseJsonValue, type ResultCollector } from './runtime/results.js';
import { finished } from 'node:stream/promises';

/**
 * Oracle connection settings derived from a workspace connection.
 *
 * Runs in node-oracledb's Thin mode: pure JavaScript, no Instant Client.
 */
export interface OracleConnectOptions {
  connectString: string;
  /** Directory holding tnsnames.ora, for TNS-alias connections. */
  configDir?: string;
  /** Administrative privilege (SYSDBA, SYSOPER, ...) requested at logon. */
  privilege?: number;
}

/**
 * DBeaver keeps its Oracle-specific settings in `provider-properties`; the
 * workspace parser copies the whole configuration block into `properties`.
 */
function providerProperties(connection: DatabaseConnection): Record<string, string> {
  const raw = (connection.properties as Record<string, unknown> | undefined)?.[
    'provider-properties'
  ];
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

function connectDescriptor(host: string, port: number, sid: string): string {
  return (
    `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
    `(CONNECT_DATA=(SID=${sid})))`
  );
}

/**
 * Work out how to reach an Oracle connection.
 *
 * DBeaver offers three connection types: BASIC (host, port, and a SID or a
 * service name), TNS (an alias resolved through tnsnames.ora) and CUSTOM (a
 * raw JDBC URL). `host`/`port` are the endpoint to dial, which differs from
 * the recorded one when the connection goes through an SSH tunnel.
 */
export function resolveOracleConnectOptions(
  connection: DatabaseConnection,
  host: string,
  port: number
): OracleConnectOptions {
  const props = providerProperties(connection);
  const connectionType = String(props['@dbeaver-connection-type@'] || 'BASIC').toUpperCase();
  const options: OracleConnectOptions = { connectString: '' };
  const protocol = connection.properties?.protocol?.toLowerCase();
  if (protocol && !['tcp', 'tcps'].includes(protocol))
    throw new Error('Oracle protocol must be tcp or tcps');
  if (protocol === 'tcps' && (connectionType === 'TNS' || connection.sshTunnel?.enabled))
    throw new Error(
      'Direct Oracle TCPS requires a basic connection without an SSH tunnel; configure advanced TLS with an explicit descriptor instead'
    );

  const role = String(props['@dbeaver-internal-logon@'] || '').toUpperCase();
  if (role && role !== 'NORMAL') {
    const privilege = (oracleDriver() as unknown as Record<string, unknown>)[role];
    if (typeof privilege !== 'number') {
      throw new Error(`Unsupported Oracle logon role "${role}"`);
    }
    options.privilege = privilege;
  }

  if (connectionType === 'TNS') {
    if (connection.sshTunnel?.enabled) {
      throw new Error('Oracle TNS aliases cannot be combined with an SSH tunnel');
    }
    const configDir = props['@dbeaver-tns-path@'] || process.env.TNS_ADMIN;
    if (!configDir) {
      throw new Error(
        'Oracle TNS connection has no tnsnames.ora location: set it in DBeaver or export TNS_ADMIN'
      );
    }
    options.connectString = connection.database || '';
    options.configDir = configDir;
    return options;
  }

  // A full descriptor (failover lists, load balancing...) is used verbatim;
  // it names its own hosts, so it cannot be redirected through a tunnel.
  const target = (connection.url || '').replace(/^jdbc:oracle:[a-z]*:?@/i, '');
  if (target.startsWith('(')) {
    if (protocol)
      throw new Error(
        'Oracle descriptors define their own protocol; remove the separate protocol setting'
      );
    if (connection.sshTunnel?.enabled) {
      throw new Error('Oracle connect descriptors cannot be combined with an SSH tunnel');
    }
    options.connectString = target;
    return options;
  }

  const database = connection.database || '';
  if (!database) {
    throw new Error('Oracle connection has no SID or service name');
  }

  // `host:port:SID` is the JDBC spelling of a SID; `//host:port/service` of a service.
  const isSid =
    String(props['@dbeaver-sid-service@'] || '').toUpperCase() === 'SID' ||
    /^[^/:]+:\d+:[^/]+$/.test(target);
  const dialHost = host.includes(':') ? `[${host}]` : host;

  if (protocol === 'tcps') {
    if (
      [dialHost, database].some(
        (value) =>
          value.includes('(') ||
          value.includes(')') ||
          [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
    )
      throw new Error('Invalid Oracle TCPS hostname or database name');
    // Thin mode supports SSL_SERVER_DN_MATCH and verifies the certificate chain.
    options.connectString = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCPS)(HOST=${dialHost})(PORT=${port}))(CONNECT_DATA=(${isSid ? 'SID' : 'SERVICE_NAME'}=${database}))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))`;
    return options;
  }

  options.connectString = isSid
    ? connectDescriptor(dialHost, port, database)
    : `${dialHost}:${port}/${database}`;
  return options;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Render a DATE/TIMESTAMP the way the database stores it.
 *
 * Thin mode builds a JS Date from the stored wall-clock fields in the local
 * time zone, so the local getters give those fields back. Serialising the
 * Date instead (toISOString/JSON) would shift it by the UTC offset.
 */
export function formatOracleLocalDate(value: Date): string {
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  const ms = value.getMilliseconds();
  return ms ? `${date} ${time}.${pad(ms, 3)}` : `${date} ${time}`;
}

// The typings declare converters as generic over the fetched value; each one
// below is only attached to columns whose fetched type it handles.
const toHex = <T>(value: T | null): string | null =>
  value === null ? null : (value as Buffer).toString('hex').toUpperCase();

const toLocalDate = <T>(value: T | null): string | null =>
  value === null ? null : formatOracleLocalDate(value as Date);

const toInstant = <T>(value: T | null): string | null =>
  value === null ? null : (value as Date).toISOString();

/**
 * Fetch every column as a JSON-friendly value.
 *
 * LOB locators stay lazy so the result collector can enforce its byte budget.
 * Native JSON is fetched as text before any numeric conversion; binary data is hex.
 */
export function oracleFetchTypeHandler(
  metadata: OracleTypes.Metadata<unknown>
): OracleTypes.FetchTypeResponse | undefined {
  const timestampTypes: OracleTypes.DbType[] = [
    oracleDriver().DB_TYPE_TIMESTAMP,
    oracleDriver().DB_TYPE_TIMESTAMP_TZ,
    oracleDriver().DB_TYPE_TIMESTAMP_LTZ,
  ];
  if (
    timestampTypes.includes(metadata.dbType!) &&
    (!Number.isInteger(metadata.precision) || metadata.precision! > 3 || metadata.precision! < 0)
  )
    throw new Error(
      "Oracle timestamps above millisecond precision must be selected as text with TO_CHAR(..., 'YYYY-MM-DD HH24:MI:SS.FF9') (include TZH:TZM for time zones); unknown precision is also rejected to prevent data loss"
    );
  switch (metadata.dbType) {
    case oracleDriver().DB_TYPE_NUMBER:
      return { type: oracleDriver().DB_TYPE_VARCHAR };
    case oracleDriver().DB_TYPE_JSON:
      return {
        type: oracleDriver().DB_TYPE_VARCHAR,
        converter: (value) => {
          if (value === null) return null;
          if (typeof value !== 'string')
            throw new Error(
              'Oracle JSON text conversion failed; use JSON_SERIALIZE RETURNING CLOB'
            );
          return parseJsonValue(value, true);
        },
      };
    case oracleDriver().DB_TYPE_CLOB:
    case oracleDriver().DB_TYPE_NCLOB:
    case oracleDriver().DB_TYPE_BLOB:
      return { type: metadata.dbType, converter: (value) => value };
    case oracleDriver().DB_TYPE_RAW:
    case oracleDriver().DB_TYPE_LONG_RAW:
      return { converter: toHex };
    case oracleDriver().DB_TYPE_DATE:
    case oracleDriver().DB_TYPE_TIMESTAMP:
      return { converter: toLocalDate };
    case oracleDriver().DB_TYPE_TIMESTAMP_TZ:
    case oracleDriver().DB_TYPE_TIMESTAMP_LTZ:
      // These denote an instant, so UTC is the unambiguous rendering.
      return { converter: toInstant };
    default:
      return undefined;
  }
}

/** Close every locator fetched in a batch, including rows skipped by the result budget. */
export async function closeOracleLobs(rows: unknown[][]): Promise<void> {
  for (const row of rows)
    for (const value of row)
      if (value instanceof oracleDriver().Lob && !value.destroyed) {
        const closed = finished(value, { cleanup: true }).catch(() => {});
        value.destroy();
        await closed;
      }
}

/** Read LOBs in bounded pieces, checking the whole-row serialized budget as we go. */
export async function collectOracleRow(
  row: unknown[],
  collector: ResultCollector,
  beforeRead: () => void
): Promise<boolean> {
  if (collector.rows.length >= collector.maxRows) return collector.add([]);
  let remaining = collector.remainingBytes - row.length - 1 - (collector.rows.length ? 1 : 0);
  const values = [...row];
  const overBudget = () => {
    collector.truncated = true;
    collector.limitReason = 'bytes';
    return false;
  };
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!(value instanceof oracleDriver().Lob)) {
      remaining -= Buffer.byteLength(JSON.stringify(value) ?? 'null');
      if (remaining < 0) return overBudget();
      continue;
    }
    const binary = value.type === oracleDriver().DB_TYPE_BLOB;
    if (
      !binary &&
      value.type !== oracleDriver().DB_TYPE_CLOB &&
      value.type !== oracleDriver().DB_TYPE_NCLOB
    )
      throw new Error('External Oracle BFILE reads are unsupported');
    remaining -= 2; // JSON string quotes.
    if (value.length * (binary ? 2 : 1) > remaining) return overBudget();
    const pieces: string[] = [];
    let offset = 1;
    while (offset <= value.length) {
      beforeRead();
      const piece = await value.getData(offset, Math.min(65536, value.length - offset + 1));
      if (!piece?.length) throw new Error('Oracle LOB ended before its reported length');
      offset += piece.length;
      const text = Buffer.isBuffer(piece) ? piece.toString('hex').toUpperCase() : piece;
      remaining -= Buffer.byteLength(JSON.stringify(text)) - 2;
      if (remaining < 0) return overBudget();
      pieces.push(text);
    }
    values[i] = pieces.join('');
  }
  return collector.add(values);
}

/** Statement id for EXPLAIN PLAN, so concurrent plans in PLAN_TABLE stay apart. */
export function explainStatementId(): string {
  return `omnisql_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove client delimiters from SQL while preserving PL/SQL block terminators. */
export function normalizeOracleStatement(query: string): string {
  const statement = query
    .trim()
    .replace(/\n\s*\/\s*$/, '')
    .trimEnd();
  const plsql =
    /^(?:begin|declare|create\s+(?:or\s+replace\s+)?(?:procedure|function|trigger|package|type))\b/i;
  return plsql.test(statement) ? statement : statement.replace(/;\s*$/, '');
}
