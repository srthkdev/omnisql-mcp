import { describe, expect, it } from 'bun:test';
import {
  publicConnection,
  publicConnectionId,
  privateConnectionId,
  registerConnectionPrivacy,
  registerPrivateValue,
  sanitizeDiagnostic,
} from '../src/privacy.js';
import { formatError, redactConnection } from '../src/utils.js';

const connection = {
  id: 'accounting',
  name: 'Accounting',
  driver: 'postgres',
  url: 'jdbc:postgresql://canary-user:canary-url-password@canary-host.internal:5432/ledger',
  host: 'canary-host.internal',
  user: 'canary-user',
  port: 5432,
  database: 'ledger',
  description: 'private endpoint description',
  folder: '/custom/private/workspace',
  driverId: 'private-driver-class',
  provider: 'private-provider',
  properties: { password: 'canary-password', vendorAccessToken: 'canary-token' },
  sshTunnel: {
    enabled: true,
    host: 'canary-jump',
    port: 22,
    user: 'canary-ssh-user',
    privateKeyPath: '/custom/private/id_ed25519',
    passphrase: 'canary-passphrase',
  },
};

describe('connection privacy boundary', () => {
  it('uses an explicit DTO and preserves logical selectors', () => {
    expect(publicConnection(connection)).toEqual({
      id: 'accounting',
      name: 'Accounting',
      driver: 'postgres',
    });
    expect(redactConnection(connection)).toEqual(publicConnection(connection));
    expect(connection.properties.password).toBe('canary-password');
    expect(publicConnectionId({ ...connection, id: '分析 warehouse' })).toBe('分析 warehouse');
  });
  it('sanitizes arbitrary driver properties, encoded credentials and SSH failures', () => {
    registerConnectionPrivacy(connection);
    const message = new Error(
      `28P01 password authentication failed for user "canary-user" at canary-host.internal:5432; canary-password canary-token canary-jump canary-ssh-user /custom/private/id_ed25519 canary-passphrase ${connection.url}`
    );
    const text = formatError(message);
    expect(text).toContain('28P01');
    expect(text).toContain('password authentication failed');
    expect(text).not.toContain('canary-');
    expect(text).not.toContain('/custom/');
    registerPrivateValue('secret / + value');
    expect(sanitizeDiagnostic(encodeURIComponent('secret / + value'))).toBe('[private]');
  });
  it('does not expose file-backed database paths or unsafe configured IDs', () => {
    const file = {
      id: '/custom/db/private.db',
      name: 'Local analysis',
      driver: 'sqlite',
      database: '/custom/db/private.db',
      url: '',
    };
    const id = publicConnectionId(file);
    expect(id).toMatch(/^connection-[a-f0-9]{24}$/);
    expect(privateConnectionId(id)).toBe(file.id);
    expect(JSON.stringify(publicConnection(file))).not.toContain('/custom/');
    expect(sanitizeDiagnostic(`Unable to open ${file.database}`)).not.toContain('/custom/');
  });
  it('redacts unregistered URI, quoted identity and common path forms', () => {
    for (const message of [
      'connect postgres://unknown:password@new-host:5432/db failed',
      'ENOENT /Users/alice/.ssh/new-key',
      'connect 192.168.1.23:4000 failed',
      'login failed for user "new-private-user"',
      'password=another-password token:another-token',
      'open C:\\Users\\alice\\secret.db failed',
    ])
      expect(sanitizeDiagnostic(message)).not.toMatch(
        /new-host|alice|192\.168|new-private|another-/
      );
  });
  it('does not redact legitimate schema selectors or non-secret driver options', () => {
    registerConnectionPrivacy({
      ...connection,
      properties: { schema: 'reporting', database: 'ledger', applicationName: 'analyst' },
    });
    expect(sanitizeDiagnostic('relation reporting.missing does not exist in ledger')).toBe(
      'relation reporting.missing does not exist in ledger'
    );
  });
  it('retains safe SQL errors, without stacks or multiline injection', () => {
    expect(sanitizeDiagnostic(new Error('42601 syntax error near SELECT'))).toBe(
      '42601 syntax error near SELECT'
    );
    expect(sanitizeDiagnostic('error\nforged log\rnext')).toBe('error forged log next');
  });
  it('escapes short private values rather than treating them as regex patterns', () => {
    registerPrivateValue('a+b');
    expect(sanitizeDiagnostic('a+b aaab stable')).toBe('[private] aaab stable');
  });
  it('withholds diagnostics after a hostile oversized private value instead of retaining it', () => {
    registerPrivateValue('x'.repeat(1024 * 1024 + 1));
    expect(sanitizeDiagnostic('arbitrary unregistered error details')).toContain('withheld');
  });
});
