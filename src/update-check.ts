import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function isNewerVersion(current: string, latest: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(latest)) return false;
  const installed = current.split('-')[0].split('.').map(Number);
  const available = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (available[i] !== installed[i]) return available[i] > installed[i];
  }
  return false;
}

/** Best-effort notice on stderr; never delays MCP startup or writes to stdout. */
export async function checkForUpdate(
  current: string,
  options: { cacheDir?: string; fetch?: typeof fetch; notify?: (message: string) => void } = {}
): Promise<void> {
  if (process.env.OMNISQL_UPDATE_NOTIFIER === 'false' || process.env.CI) return;
  const cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'omnisql-mcp');
  const cacheFile = join(cacheDir, 'update.json');
  const notify = options.notify ?? ((message: string) => console.error(message));
  try {
    let latest: string | undefined;
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (
        typeof cached.version === 'string' &&
        Date.now() - cached.checkedAt < 24 * 60 * 60 * 1000
      ) {
        latest = cached.version;
      }
    } catch {
      /* A missing or invalid cache triggers a registry check. */
    }
    if (!latest) {
      const response = await (options.fetch ?? fetch)(
        'https://registry.npmjs.org/omnisql-mcp/latest',
        {
          signal: AbortSignal.timeout(3000),
        }
      );
      if (!response.ok) return;
      const data = (await response.json()) as { version?: unknown };
      if (typeof data.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version)) return;
      latest = data.version;
      try {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ version: latest, checkedAt: Date.now() }), {
          mode: 0o600,
        });
      } catch {
        /* A read-only home must not suppress the notice. */
      }
    }
    if (isNewerVersion(current, latest)) {
      notify(
        `OmniSQL ${latest} is available (running ${current}). With npx @latest, restart your MCP client to update. Standalone installs: rerun the installer. Set OMNISQL_UPDATE_NOTIFIER=false to disable notices.`
      );
    }
  } catch {
    /* Offline registries and unwritable caches must not affect the server. */
  }
}
