import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const entries = process.argv.slice(2);
if (!entries.length) entries.push('dist/index.js');
const directory = mkdtempSync(join(tmpdir(), 'omnisql-bench-'));
const percentile = (values, f) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * f) - 1)];
const report = [];
try {
  for (const entry of entries) {
    const cli = [],
      mcp = [];
    for (let i = 0; i < 12; i++) {
      const started = performance.now();
      const p = spawnSync(process.execPath, [resolve(entry), '--version'], { encoding: 'utf8' });
      if (p.status !== 0) throw new Error(p.stderr);
      cli.push(performance.now() - started);
      const client = new Client({ name: 'omnisql-benchmark', version: '1' });
      const start = performance.now();
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [resolve(entry)],
            stderr: 'pipe',
            env: {
              ...process.env,
              OMNISQL_WORKSPACE: directory,
              OMNISQL_CONFIG_FILE: '',
              OMNISQL_POLICY_FILE: '',
              OMNISQL_READ_ONLY: 'true',
              OMNISQL_DISABLED_TOOLS: '',
              OMNISQL_ALLOWED_CONNECTIONS: '',
              OMNISQL_UPDATE_NOTIFIER: 'false',
            },
          })
        );
        await client.listTools();
        mcp.push(performance.now() - start);
      } finally {
        await client.close();
      }
    }
    report.push({
      entry,
      samples: 12,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cliMsP50: percentile(cli, 0.5),
      cliMsP95: percentile(cli, 0.95),
      mcpReadyMsP50: percentile(mcp, 0.5),
      mcpReadyMsP95: percentile(mcp, 0.95),
      cliSamplesMs: cli,
      mcpSamplesMs: mcp,
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
