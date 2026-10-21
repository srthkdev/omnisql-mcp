import type { DatabaseConnection } from './types.js';
import { validateAccessRule } from './policy/access.js';
import { readPrivateFile } from './runtime/private-file.js';

const KEYS = [
  'name',
  'driver',
  'host',
  'port',
  'database',
  'user',
  'urlEnv',
  'readOnly',
  'policy',
  'limits',
  'properties',
  'passwordEnv', // Environment variable reference, never a literal credential.
];
const LIMITS: Record<string, [number, number]> = {
  maxRows: [1, 100000],
  maxBytes: [1024, 8388608],
  timeoutMs: [1, 300000],
  poolMax: [1, 32],
};
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function env(name: unknown): string | undefined {
  if (name === undefined) return;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error('Invalid credential environment variable name');
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}
/** One server can use explicitly configured instances and discovered workspace connections. */
export function loadConfiguredConnections(
  file = process.env.OMNISQL_CONFIG_FILE
): DatabaseConnection[] {
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateFile(file, 1_000_000, 'Connection config'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Invalid connection config JSON; check it locally');
    throw error;
  }
  const config = object(parsed, 'Connection config');
  if (
    config.version !== 1 ||
    Object.keys(config).some((k) => !['version', 'defaults', 'connections'].includes(k))
  )
    throw new Error('Unsupported connection config version or setting');
  const defaults =
    config.defaults === undefined ? {} : object(config.defaults, 'Connection defaults');
  if (Object.keys(defaults).some((k) => !['readOnly', 'policy', 'limits'].includes(k)))
    throw new Error('Unknown connection default');
  const connections = object(config.connections, 'Connections');
  if (Object.keys(connections).length > 128)
    throw new Error('At most 128 connections can be configured');
  return Object.entries(connections).map(([id, value]) => {
    if (
      !id ||
      id.length > 128 ||
      /[\\/]/.test(id) ||
      [...id].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      ['.', '..'].includes(id)
    )
      throw new Error('Invalid configured connection ID');
    const entry = object(value, `Connection ${id}`);
    if (Object.keys(entry).some((k) => !KEYS.includes(k)))
      throw new Error(`Unknown setting on connection ${id}`);
    const merged = { ...defaults, ...entry };
    if (typeof merged.driver !== 'string' || !merged.driver)
      throw new Error(`Connection ${id} requires a driver`);
    for (const k of ['name', 'host', 'database', 'user'])
      if (merged[k] !== undefined && typeof merged[k] !== 'string')
        throw new Error(`Connection ${id}: ${k} must be a string`);
    if (
      merged.port !== undefined &&
      (!Number.isInteger(merged.port) || Number(merged.port) < 1 || Number(merged.port) > 65535)
    )
      throw new Error(`Connection ${id}: invalid port`);
    if (merged.readOnly !== undefined && typeof merged.readOnly !== 'boolean')
      throw new Error(`Connection ${id}: readOnly must be boolean`);
    if (defaults.policy !== undefined) validateAccessRule(defaults.policy);
    if (entry.policy !== undefined) validateAccessRule(entry.policy);
    const limits = {
      ...(defaults.limits === undefined ? {} : object(defaults.limits, 'Default limits')),
      ...(entry.limits === undefined ? {} : object(entry.limits, 'Connection limits')),
    };
    for (const [k, v] of Object.entries(limits))
      if (
        !LIMITS[k] ||
        !Number.isInteger(v) ||
        Number(v) < LIMITS[k][0] ||
        Number(v) > LIMITS[k][1]
      )
        throw new Error(`Connection ${id}: invalid ${k} limit`);
    const properties =
      merged.properties === undefined ? {} : object(merged.properties, 'Connection properties');
    if (Object.values(properties).some((value) => typeof value !== 'string'))
      throw new Error(`Connection ${id}: property values must be strings`);
    let parsed: Partial<DatabaseConnection> = {};
    const rawUrl = env(merged.urlEnv);
    if (rawUrl) {
      const url = new URL(rawUrl);
      if (
        ![
          'postgres:',
          'postgresql:',
          'mysql:',
          'mariadb:',
          'mssql:',
          'clickhouse:',
          'http:',
          'https:',
          'mongodb:',
          'mongodb+srv:',
          'redis:',
          'rediss:',
        ].includes(url.protocol)
      )
        throw new Error(`Connection ${id}: unsupported URL protocol`);
      parsed = {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : undefined,
        database: decodeURIComponent(url.pathname.slice(1)) || undefined,
        user: decodeURIComponent(url.username) || undefined,
      };
      for (const [key, value] of url.searchParams) properties[key] = value;
      if (url.password) properties.password = decodeURIComponent(url.password);
    }
    const password = env(merged.passwordEnv);
    if (password) properties.password = password;
    return {
      id,
      name: (merged.name as string | undefined) ?? id,
      driver: merged.driver as string,
      url: rawUrl ?? '',
      ...parsed,
      ...(merged.host === undefined ? {} : { host: merged.host as string }),
      ...(merged.port === undefined ? {} : { port: merged.port as number }),
      ...(merged.database === undefined ? {} : { database: merged.database as string }),
      ...(merged.user === undefined ? {} : { user: merged.user as string }),
      readonly: merged.readOnly !== false,
      properties: properties as Record<string, string>,
      accessRules: [defaults.policy, entry.policy].filter(
        (v) => v !== undefined
      ) as DatabaseConnection['accessRules'],
      limits: limits as DatabaseConnection['limits'],
    };
  });
}
