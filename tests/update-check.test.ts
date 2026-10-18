import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkForUpdate, isNewerVersion } from '../src/update-check.js';
afterEach(() => vi.unstubAllEnvs());

describe('update notices', () => {
  it('compares stable versions numerically', () => {
    expect(isNewerVersion('2.2.0', '2.10.0')).toBe(true);
    expect(isNewerVersion('2.2.0', '2.2.0')).toBe(false);
    expect(isNewerVersion('2.2.0', '2.1.9')).toBe(false);
    expect(isNewerVersion('2.2.0', '3.0.0-beta.1')).toBe(false);
  });
  it('caches registry checks and notifies without touching stdout', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('OMNISQL_UPDATE_NOTIFIER', 'true');
    const cacheDir = await mkdtemp(join(tmpdir(), 'omnisql-update-'));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '2.3.0' })));
    const notify = vi.fn();
    try {
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('2.3.0 is available'));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  it('allows opt-out and silently tolerates network errors', async () => {
    vi.stubEnv('CI', '');
    vi.stubEnv('OMNISQL_UPDATE_NOTIFIER', 'false');
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const notify = vi.fn();
    await checkForUpdate('2.2.0', { fetch: fetcher, notify });
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('OMNISQL_UPDATE_NOTIFIER', 'true');
    const cacheDir = await mkdtemp(join(tmpdir(), 'omnisql-offline-'));
    try {
      await checkForUpdate('2.2.0', { cacheDir, fetch: fetcher, notify });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
    expect(notify).not.toHaveBeenCalled();
  });
});
