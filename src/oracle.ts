import oracledb from 'oracledb';
import { DatabaseConnection } from './types.js';

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

  const role = String(props['@dbeaver-internal-logon@'] || '').toUpperCase();
  if (role && role !== 'NORMAL') {
    const privilege = (oracledb as unknown as Record<string, unknown>)[role];
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
 * LOBs would otherwise come back as stream objects (not serialisable) and
 * dates as Date objects (serialised in UTC); binary data becomes hex.
 */
export function oracleFetchTypeHandler(
  metadata: oracledb.Metadata<unknown>
): oracledb.FetchTypeResponse | undefined {
  switch (metadata.dbType) {
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.DB_TYPE_LONG };
    case oracledb.DB_TYPE_BLOB:
      return { type: oracledb.DB_TYPE_LONG_RAW, converter: toHex };
    case oracledb.DB_TYPE_RAW:
    case oracledb.DB_TYPE_LONG_RAW:
      return { converter: toHex };
    case oracledb.DB_TYPE_DATE:
    case oracledb.DB_TYPE_TIMESTAMP:
      return { converter: toLocalDate };
    case oracledb.DB_TYPE_TIMESTAMP_TZ:
    case oracledb.DB_TYPE_TIMESTAMP_LTZ:
      // These denote an instant, so UTC is the unambiguous rendering.
      return { converter: toInstant };
    default:
      return undefined;
  }
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
