import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory = mkdtempSync(join(tmpdir(), 'omnisql-tools-'));
const client = new Client({ name: 'omnisql-docs', version: '1' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        OMNISQL_WORKSPACE: directory,
        OMNISQL_CONFIG_FILE: '',
        OMNISQL_POLICY_FILE: '',
        OMNISQL_READ_ONLY: 'false',
        OMNISQL_DISABLED_TOOLS: '',
        OMNISQL_ALLOWED_CONNECTIONS: '',
        OMNISQL_UPDATE_NOTIFIER: 'false',
      },
    })
  );
  const tools = (await client.listTools()).tools;
  writeFileSync('docs-site/data/tools.json', JSON.stringify(tools, null, 2) + '\n');
  console.error(`Exported ${tools.length} tool schemas`);
} finally {
  await client.close();
  rmSync(directory, { recursive: true, force: true });
}
