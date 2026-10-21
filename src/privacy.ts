import { createHash } from 'node:crypto';
import { sqlDialect } from './policy/analyzer.js';
import type { DatabaseConnection } from './types.js';

// Diagnostics are shared by drivers and startup code. Retain old values on reload
// so delayed errors from an old pool cannot disclose its credentials.
const privateValues = new Set<string>();
let orderedValues: string[] = [];
const aliases = new Map<string, string>();
let saturated = false;
let privateBytes = 0;
const REDACTED = '[private]';

export function registerPrivateValue(value: unknown): void {
  if (typeof value !== 'string' || !value) return;
  if (privateValues.has(value)) return;
  let encoded = value;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    /* Invalid Unicode is still masked verbatim. */
  }
  const bytes = Buffer.byteLength(value) + Buffer.byteLength(encoded);
  if (privateValues.size >= 10000 || bytes > 1024 * 1024 - privateBytes) {
    saturated = true;
    return;
  }
  privateBytes += bytes;
  privateValues.add(value);
  privateValues.add(encoded);
  orderedValues = [];
}

export function registerConnectionPrivacy(connection: DatabaseConnection): void {
  const sensitive =
    /password|passwd|passphrase|pwd|user|host|endpoint|url|uri|dsn|credential|secret|token|key|cert|path|file|auth/i;
  const visit = (value: unknown, inherited = false): void => {
    if (typeof value === 'string' && inherited) registerPrivateValue(value);
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        visit(item, inherited || sensitive.test(key));
  };
  for (const value of [connection.url, connection.host, connection.user])
    registerPrivateValue(value);
  visit(connection.sshTunnel);
  visit(connection.properties);
  // A database selector is public; a file-backed database path is not.
  if (['sqlite', 'duckdb'].includes(sqlDialect(connection.driver ?? 'generic')))
    registerPrivateValue(connection.database);
  if (connection.url) {
    try {
      const url = new URL(connection.url.replace(/^jdbc:/, ''));
      for (const value of [
        url.hostname,
        url.username,
        url.password,
        decodeURIComponent(url.username),
        decodeURIComponent(url.password),
      ])
        registerPrivateValue(value);
    } catch {
      /* Driver-specific DSNs are still redacted as complete strings. */
    }
  }
}

/** Safe diagnostics only. Never apply this to authorized query rows. */
export function sanitizeDiagnostic(value: unknown): string {
  if (saturated) return 'Diagnostic details withheld; check connection configuration locally';
  let text = value instanceof Error ? value.message : String(value);
  // Longest first prevents a hostname replacement leaving a credentialed URI tail.
  if (!orderedValues.length) orderedValues = [...privateValues].sort((a, b) => b.length - a.length);
  for (const secret of orderedValues) {
    if (secret.length > 3) text = text.split(secret).join(REDACTED);
    else
      text = text.replace(
        new RegExp(`(?<!\\w)${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g'),
        REDACTED
      );
  }
  return text
    .replace(/(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, REDACTED)
    .replace(
      /(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|etc|opt|Volumes)\/)[^\s'"<>),;]*/g,
      REDACTED
    )
    .replace(/\barn:aws[a-z-]*:[^\s'"<>]+/gi, REDACTED)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, REDACTED)
    .replace(
      /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:com|net|org|io|dev|local|internal|cloud|amazonaws|azure)(?::\d+)?\b/gi,
      REDACTED
    )
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|user(?:name)?|host(?:name)?)\s*(?:=|:|is)?\s*["']([^"']*)["']/gi,
      '$1 [private]'
    )
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[private]')
    .replace(/\[private\](?::\d+)?/g, REDACTED)
    .replace(/\bport\s+\d+\b/gi, 'port [private]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2048);
}

export function publicConnectionId(connection: DatabaseConnection): string {
  registerConnectionPrivacy(connection);
  const id = connection.id;
  if (
    id.length <= 512 &&
    !/[:/\\@]/.test(id) &&
    ![...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !/^connection-[a-f0-9]{24}$/.test(id) &&
    sanitizeDiagnostic(id) === id
  )
    return id;
  const alias = 'connection-' + createHash('sha256').update(id).digest('hex').slice(0, 24);
  if (aliases.size >= 10000 && !aliases.has(alias))
    throw new Error('Connection alias limit reached');
  aliases.set(alias, id);
  return alias;
}

export function privateConnectionId(id: string): string {
  const slash = id.indexOf('/');
  if (slash > 0 && aliases.has(id.slice(0, slash)))
    return aliases.get(id.slice(0, slash)) + id.slice(slash);
  return aliases.get(id) ?? id;
}

/** The only public representation of connection configuration. */
export function publicConnection(connection: DatabaseConnection): Record<string, unknown> {
  return {
    id: publicConnectionId(connection),
    name: sanitizeDiagnostic(connection.name),
    driver: sqlDialect(connection.driver ?? 'generic'),
    ...(connection.readonly === undefined ? {} : { readonly: connection.readonly }),
  };
}

/** Present the numeric engine version, without exposing its platform/build banner. */
export function safeDatabaseVersion(banner: string | undefined): string | undefined {
  return banner
    ?.slice(0, 4096)
    .match(/(?:^|[^\d.])(\d{1,6}\.\d{1,6}(?:\.\d{1,6}){0,3})(?![\d.])/)?.[1];
}
