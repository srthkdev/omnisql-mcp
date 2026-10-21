import { describe, expect, it } from 'bun:test';
import { safeDatabaseVersion, sanitizeDiagnostic } from '../src/privacy.js';

describe('public database version', () => {
  it.each([
    ['26.8.1.1234', '26.8.1.1234'],
    ['PostgreSQL 17.6 on canary-private-host, compiled by gcc 14.2.1', '17.6'],
    ['8.0.43-0ubuntu0.22.04.1', '8.0.43'],
    ['11.8.3-MariaDB-ubu2404', '11.8.3'],
    ['Microsoft SQL Server 2022 (RTM) - 16.0.1000.6 (X64) canary-private-user', '16.0.1000.6'],
    ['Oracle Database 23ai Free Release 23.0.0.0.0 - Development', '23.0.0.0.0'],
    ['v1.4.3 (Andium) canary-private-host', '1.4.3'],
    ['3.50.4', '3.50.4'],
  ])('extracts only the numeric version from %s', (banner, expected) => {
    expect(safeDatabaseVersion(banner)).toBe(expected);
    expect(safeDatabaseVersion(banner)).not.toContain('canary-');
  });
  it('does not relax endpoint redaction when four-part engine versions are public', () => {
    expect(sanitizeDiagnostic('connect 192.168.1.123:5432 failed')).not.toContain('192.168');
    expect(safeDatabaseVersion('26.8.1.1234')).toBe('26.8.1.1234');
  });
  it('omits unknown versions and rejects unbounded numeric components', () => {
    expect(safeDatabaseVersion(undefined)).toBeUndefined();
    expect(safeDatabaseVersion('Unavailable')).toBeUndefined();
    expect(safeDatabaseVersion('x'.repeat(4096) + '1.2.3')).toBeUndefined();
    expect(safeDatabaseVersion('123456789.123456789')).toBeUndefined();
  });
});
