/**
 * TLS configuration shared by the direct-query and pooled connection paths.
 *
 * Keeping one implementation avoids the two drifting: they previously read
 * different property locations and disagreed about what "require" means.
 */

import fs from 'fs';
import { DatabaseConnection } from '../types.js';
import { readConnectionProp } from './connection-props.js';

/** Modes that authenticate the server certificate, rather than merely encrypting. */
const PG_VERIFY_MODES = ['verify-ca', 'verify-full'];
const MYSQL_VERIFY_MODES = ['verify-ca', 'verify_ca', 'verify-full', 'verify_identity'];

const PG_REQUIRE_MODES = ['require', 'required', 'true', '1', ...PG_VERIFY_MODES];
const MYSQL_REQUIRE_MODES = [
  'require',
  'required',
  'true',
  '1',
  'preferred',
  'enabled',
  'yes',
  ...MYSQL_VERIFY_MODES,
];

const PG_DISABLE_MODES = ['disable', 'disabled', 'false', '0'];
const MYSQL_DISABLE_MODES = ['disable', 'disabled', 'false', '0', 'none', 'off', 'no'];

/** Read a PEM file, returning undefined when it is missing or unreadable. */
function readPem(pathValue: string | undefined): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  try {
    if (fs.existsSync(pathValue)) {
      return fs.readFileSync(pathValue).toString();
    }
  } catch {
    // Unreadable cert material falls back to the default trust store.
  }
  return undefined;
}

function buildSslMaterial(
  ca: string | undefined,
  cert: string | undefined,
  key: string | undefined
): Record<string, string> {
  const material: Record<string, string> = {};
  const caPem = readPem(ca);
  const certPem = readPem(cert);
  const keyPem = readPem(key);
  if (caPem) material.ca = caPem;
  if (certPem) material.cert = certPem;
  if (keyPem) material.key = keyPem;
  return material;
}

/**
 * Resolve the Postgres SSL mode declared by a connection.
 *
 * Besides plain properties, the workspace can express TLS through an
 * `handlers.postgre_ssl` block, whose mere presence implies TLS.
 */
function postgresSslMode(connection: DatabaseConnection): string {
  const direct = readConnectionProp(connection, 'ssl.mode', 'sslmode', 'sslMode', 'ssl');
  if (direct) {
    return direct.toLowerCase();
  }

  const handlers = connection.properties?.['handlers'] as unknown as
    | Record<string, unknown>
    | undefined;
  const sslHandler = handlers?.['postgre_ssl'] as Record<string, unknown> | undefined;
  if (sslHandler?.enabled) {
    const handlerMode = (sslHandler.properties as Record<string, unknown> | undefined)?.['sslMode'];
    return String(handlerMode ?? 'require').toLowerCase();
  }

  return '';
}

/**
 * Build the `ssl` option for a `pg` client or pool.
 *
 * `iamAuth` forces TLS on, because RDS rejects IAM tokens sent in cleartext.
 * Returns `undefined` to leave the driver at its own default.
 */
export function resolvePostgresSsl(
  connection: DatabaseConnection,
  iamAuth = false,
  debug = false
): Record<string, unknown> | false | undefined {
  const sslMode = postgresSslMode(connection);
  const disable = PG_DISABLE_MODES.includes(sslMode);

  if (disable) {
    return false;
  }

  if (!PG_REQUIRE_MODES.includes(sslMode) && !iamAuth) {
    return undefined;
  }

  const material = buildSslMaterial(
    readConnectionProp(connection, 'sslrootcert', 'ssl.root.cert', 'sslRootCert'),
    readConnectionProp(connection, 'sslcert', 'ssl.cert', 'sslCert'),
    readConnectionProp(connection, 'sslkey', 'ssl.key', 'sslKey')
  );

  const hasCa = typeof material.ca === 'string' && material.ca.length > 0;
  const verify = PG_VERIFY_MODES.includes(sslMode);

  if (verify && !hasCa && debug) {
    console.warn(
      'sslMode set to verify-ca/verify-full but no sslrootcert provided; using system CA store'
    );
  }

  return { ...material, rejectUnauthorized: verify };
}

/**
 * Build the `ssl` option for a `mysql2` connection or pool.
 *
 * MySQL's REQUIRED encrypts without validating the chain; only the VERIFY_*
 * modes authenticate the server certificate. Managed engines such as RDS
 * present certificates signed by their own CA, which is absent from the system
 * trust store, so verifying by default would break them.
 */
export function resolveMysqlSsl(
  connection: DatabaseConnection,
  iamAuth = false
): Record<string, unknown> | undefined {
  const sslMode = (
    readConnectionProp(connection, 'ssl.mode', 'sslMode', 'sslmode', 'useSSL', 'ssl') ?? ''
  ).toLowerCase();

  if (MYSQL_DISABLE_MODES.includes(sslMode)) {
    return undefined;
  }

  if (!MYSQL_REQUIRE_MODES.includes(sslMode) && !iamAuth) {
    return undefined;
  }

  const material = buildSslMaterial(
    readConnectionProp(connection, 'ssl.ca', 'sslCA', 'sslrootcert'),
    readConnectionProp(connection, 'ssl.cert', 'sslCert', 'sslcert'),
    readConnectionProp(connection, 'ssl.key', 'sslKey', 'sslkey')
  );

  const hasCa = typeof material.ca === 'string' && material.ca.length > 0;

  return {
    ...material,
    rejectUnauthorized: MYSQL_VERIFY_MODES.includes(sslMode) || hasCa,
  };
}
