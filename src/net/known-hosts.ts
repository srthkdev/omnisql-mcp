/**
 * Host key checking against the user's OpenSSH `known_hosts`.
 *
 * ssh2 accepts whatever key a server presents unless it is given a verifier,
 * and this tunnel carries database credentials - so a server we cannot
 * recognise is worth noticing. The rule matches what a user already expects
 * from `ssh`: a host we have an entry for must match it, and a host we have
 * never seen is accepted unless strict mode says otherwise.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type HostKeyVerdict =
  | { status: 'match' }
  | { status: 'unknown' }
  | { status: 'mismatch'; expectedTypes: string[] };

/** Entries are `[markers] host-pattern keytype base64key [comment]`. */
interface KnownHostEntry {
  patterns: string[];
  keyType: string;
  key: string;
  revoked: boolean;
}

export function knownHostsPath(): string {
  return process.env.OMNISQL_SSH_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts');
}

export function parseKnownHosts(contents: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    let fields = line.split(/\s+/);
    let revoked = false;

    // A leading @marker qualifies the entry rather than naming a host.
    if (fields[0]?.startsWith('@')) {
      const marker = fields[0];
      // @cert-authority entries delegate trust to a CA key, which is not a
      // comparison we can make here. Skipping them means such a host reads as
      // unknown rather than as a mismatch.
      if (marker === '@cert-authority') {
        continue;
      }
      revoked = marker === '@revoked';
      fields = fields.slice(1);
    }

    const [hostField, keyType, key] = fields;
    if (!hostField || !keyType || !key) {
      continue;
    }

    entries.push({ patterns: hostField.split(','), keyType, key, revoked });
  }

  return entries;
}

/**
 * OpenSSH may store the host as `|1|<salt>|<hash>`, an HMAC-SHA1 of the name
 * keyed by the salt, so the file does not disclose which hosts were visited.
 */
function hashedPatternMatches(pattern: string, host: string): boolean {
  const parts = pattern.split('|');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== '1') {
    return false;
  }

  try {
    const salt = Buffer.from(parts[2], 'base64');
    const expected = parts[3];
    const actual = crypto.createHmac('sha1', salt).update(host).digest('base64');
    return actual === expected;
  } catch {
    return false;
  }
}

/** `*` and `?` wildcards, as OpenSSH allows in an unhashed pattern. */
function wildcardMatches(pattern: string, host: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === host;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expr}$`).test(host);
}

function patternMatches(pattern: string, host: string, port: number): boolean {
  if (pattern.startsWith('|')) {
    // Non-default ports are hashed in their bracketed form.
    return (
      hashedPatternMatches(pattern, host) ||
      (port !== 22 && hashedPatternMatches(pattern, `[${host}]:${port}`))
    );
  }

  const target = port === 22 ? host : `[${host}]:${port}`;
  if (wildcardMatches(pattern, target)) {
    return true;
  }
  // A default-port entry still applies when written without brackets.
  return port !== 22 ? false : wildcardMatches(pattern, host);
}

/**
 * Compare the key a server presented against the recorded entries for it.
 *
 * `key` is the raw host key blob ssh2 hands the verifier.
 */
export function verifyHostKey(
  host: string,
  port: number,
  keyType: string,
  key: Buffer,
  entries: KnownHostEntry[]
): HostKeyVerdict {
  const matching = entries.filter((entry) =>
    entry.patterns.some((pattern) => patternMatches(pattern, host, port))
  );

  if (matching.length === 0) {
    return { status: 'unknown' };
  }

  const presented = key.toString('base64');
  const accepted = matching.filter(
    (entry) => !entry.revoked && entry.keyType === keyType && entry.key === presented
  );

  if (accepted.length > 0) {
    return { status: 'match' };
  }

  return {
    status: 'mismatch',
    expectedTypes: Array.from(new Set(matching.map((entry) => entry.keyType))),
  };
}

/** Read and parse known_hosts, treating an unreadable file as empty. */
export function loadKnownHosts(): KnownHostEntry[] {
  const file = knownHostsPath();
  try {
    if (!fs.existsSync(file)) {
      return [];
    }
    return parseKnownHosts(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/** The `SHA256:...` form `ssh` prints, for error messages. */
export function keyFingerprint(key: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}
