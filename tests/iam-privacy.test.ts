import { describe, expect, it, spyOn } from 'bun:test';
import { getIamAuthToken, resolveIamUsername, clearIamAuthCache } from '../src/auth/iam-auth.js';
import { sanitizeDiagnostic } from '../src/privacy.js';

describe('IAM diagnostic privacy', () => {
  it('keeps derived identities, AWS ARNs and minted tokens out of debug output and subsequent errors', async () => {
    clearIamAuthCache();
    const host = 'canary-iam-host';
    const arn = 'arn:aws:sts::123456789012:assumed-role/role/canary-derived-user';
    const token = 'canary-freshly-minted-iam-token';
    const connection = { id: 'analytics', name: 'Analytics', driver: 'postgres', url: '', host };
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const user = await resolveIamUsername(connection, {
        debug: true,
        runner: async () => JSON.stringify({ Arn: arn }),
      });
      const value = await getIamAuthToken(
        { host, user, port: 5432 },
        {
          debug: true,
          runner: async () => token,
        }
      );
      expect(value).toBe(token);
      const output = JSON.stringify(log.mock.calls);
      for (const secret of [host, arn, user, token]) {
        expect(output).not.toContain(secret);
        expect(sanitizeDiagnostic(new Error(`Failed authentication ${secret}`))).not.toContain(
          secret
        );
      }
      expect(output).toContain('Resolved IAM');
      expect(output).toContain('Refreshed RDS IAM');
      expect(
        sanitizeDiagnostic('Unexpected arn:aws-us-gov:iam::111111111111:user/private-account')
      ).not.toContain('111111111111');
    } finally {
      log.mockRestore();
      clearIamAuthCache();
    }
  });
});
