import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const temp = mkdtempSync(join(tmpdir(), 'omnisql-package-'));
let client;
try {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
      encoding: 'utf8',
    })
  );
  execFileSync('tar', ['-xzf', join(temp, pack.filename), '-C', temp]);
  const manifest = JSON.parse(readFileSync(join(temp, 'package/package.json'), 'utf8'));
  const entry = join(temp, 'package/dist/index.js');
  assert.match(readFileSync(join(temp, 'package/dist/config-parser.js'), 'utf8'), /projectName/);
  execFileSync('ln', [
    '-s',
    join(process.cwd(), 'node_modules'),
    join(temp, 'package/node_modules'),
  ]);
  // Exercise the Rust WASM extracted from the npm tarball, not the source tree.
  const wasmCheck = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const m=require(${JSON.stringify(join(temp, 'package/dist/native/omnisql_sql_policy.js'))});if(!JSON.parse(m.analyze_sql('SELECT * FROM public.orders','postgres')).relations.length)process.exit(1);`,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(wasmCheck.status, 0, wasmCheck.stderr);
  const version = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal((version.stdout + version.stderr).trim(), manifest.version);
  for (const target of ['claude', 'codex', 'opencode']) {
    const setup = spawnSync(
      process.execPath,
      [entry, 'install', target, '--read-only', '--dry-run'],
      { encoding: 'utf8' }
    );
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stderr, /OMNISQL_READ_ONLY=true/);
    assert.match(setup.stderr, /omnisql-mcp@latest/);
    assert.equal(setup.stdout, '');
  }
  // The CLI writes version output to stderr, preserving stdout for MCP messages.
  const project = join(temp, 'workspace/Custom/.dbeaver');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'data-sources.json'),
    JSON.stringify({
      connections: {
        'pg-1': {
          name: 'dev',
          provider: 'postgresql',
          driver: 'postgres-jdbc',
          configuration: {
            host: '127.0.0.1',
            port: '1',
            database: 'default',
            user: 'test',
          },
        },
        'sqlite-1': {
          name: 'file',
          provider: 'sqlite',
          driver: 'sqlite',
          configuration: { database: '/unused.db' },
        },
      },
    })
  );
  const env = {
    ...process.env,
    OMNISQL_WORKSPACE: join(temp, 'workspace'),
    OMNISQL_PROJECT: 'Custom',
    OMNISQL_READ_ONLY: 'true',
    OMNISQL_ALLOWED_CONNECTIONS: '',
    OMNISQL_DISABLED_TOOLS: '',
    OMNISQL_DEBUG: 'false',
  };
  // Resolve dependencies from the checkout; run only the code extracted from the tarball.
  const connect = async (extra = {}) => {
    const next = new Client({ name: 'package-check', version: '1.0.0' });
    await next.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: { ...env, ...extra },
        stderr: 'pipe',
      })
    );
    return next;
  };
  client = await connect();
  const tools = (await client.listTools()).tools;
  for (const name of [
    'execute_query',
    'export_data',
    'explain_query',
    'list_tables',
    'get_table_schema',
    'get_database_stats',
    'test_connection',
    'get_pool_stats',
  ]) {
    assert.equal(
      tools.find((tool) => tool.name === name)?.inputSchema.properties?.database?.type,
      'string'
    );
  }
  assert(tools.some((tool) => tool.name === 'list_databases'));
  assert(!tools.some((tool) => tool.name === 'write_query'));
  const resources = await client.listResources(undefined, { timeout: 2000 });
  assert.equal(resources.resources.length, 2);
  assert(resources.resources.every((r) => r.uri.startsWith('omnisql:///connections/')));
  const connections = await client.callTool({ name: 'list_connections', arguments: {} });
  assert.match(JSON.stringify(connections), /pg-1/);
  await assert.rejects(
    client.callTool({
      name: 'execute_query',
      arguments: { connectionId: 'sqlite-1', database: 'other', query: 'SELECT 1' },
    }),
    /file-backed/
  );
  await assert.rejects(
    client.callTool({
      name: 'execute_query',
      arguments: { connectionId: 'pg-1', database: 'app', query: 'DELETE FROM users WHERE id = 1' },
    }),
    /read.only|SELECT/i
  );
  await client.close();
  client = await connect({ OMNISQL_ALLOWED_CONNECTIONS: 'pg-1/allowed' });
  await assert.rejects(
    client.callTool({
      name: 'execute_query',
      arguments: { connectionId: 'pg-1', database: 'denied', query: 'SELECT 1' },
    }),
    /Connection not found/
  );
  console.log(
    `Package ${manifest.name}@${manifest.version}: CLI and client setup, custom project, tool schemas, database overrides, read-only checks, and whitelist checks passed.`
  );
} finally {
  await client?.close();
  rmSync(temp, { recursive: true, force: true });
}
