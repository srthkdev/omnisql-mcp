import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Requires bun install --frozen-lockfile && bun run build in the repository root. No database is opened.
const workspace = mkdtempSync(join(tmpdir(), 'omnisql-docs-'));
mkdirSync(join(workspace, 'General/.dbeaver'), { recursive: true });
writeFileSync(join(workspace, 'General/.dbeaver/data-sources.json'), '{"connections":{}}');
const server = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const client = new Client({ name: 'omnisql-docs', version: '1.0.0' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: {
        ...process.env,
        OMNISQL_WORKSPACE: workspace,
        OMNISQL_PROJECT: '',
        OMNISQL_READ_ONLY: 'false',
        OMNISQL_DISABLED_TOOLS: '',
        OMNISQL_UPDATE_NOTIFIER: 'false',
      },
    })
  );
  const { tools } = await client.listTools();
  writeFileSync(
    new URL('../data/tools.json', import.meta.url),
    JSON.stringify(tools, null, 2) + '\n'
  );
  console.log(`Exported ${tools.length} tool schemas from ${resolve(server)}.`);
} finally {
  await client.close();
  rmSync(workspace, { recursive: true, force: true });
}
