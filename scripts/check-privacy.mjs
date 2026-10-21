import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = mkdtempSync(join(tmpdir(), 'omnisql-private-canary-'));
const database = join(directory, 'private-database.db');
const unavailable = join(directory, 'missing', 'private-database.db');
const password = 'canary-private-password';
const host = 'canary-private-host.invalid';
const user = 'canary-private-user';
const key = '/custom/canary-private-key';
const values = [directory, database, unavailable, password, host, user, key];
const noPrivateValues = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of values)
    assert(!text.includes(secret), `Private fixture value leaked: ${secret}`);
};
let client;
let stderr = '';
try {
  for (const setting of ['OMNISQL_CONFIG_FILE', 'OMNISQL_POLICY_FILE']) {
    const missing = 'canary-missing-startup-file-' + randomBytes(8).toString('hex');
    const failure = spawnSync(process.execPath, [resolve('dist/index.js')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OMNISQL_CONFIG_FILE: '',
        OMNISQL_POLICY_FILE: '',
        OMNISQL_UPDATE_NOTIFIER: 'false',
        [setting]: missing,
      },
      timeout: 10000,
    });
    assert.equal(failure.status, 1);
    assert(!failure.stderr.includes(missing), 'Startup errors must hide private operator paths');
    assert.equal(failure.stdout, '');
  }
  execFileSync('sqlite3', [database], {
    input: `CREATE TABLE sample(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO sample VALUES(1,'${password}'); CREATE TRIGGER deny_write BEFORE INSERT ON sample BEGIN SELECT RAISE(ABORT,'${password}'); END;`,
  });
  const config = join(directory, 'connections.json');
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      connections: {
        primary: {
          name: 'Accounting',
          driver: 'sqlite',
          database,
          readOnly: false,
          properties: { password, clientKeyPath: key },
        },
        [user]: { name: 'Private selector', driver: 'sqlite', database, readOnly: true },
        inaccessible: { driver: 'sqlite', database: unavailable, readOnly: true },
        offline: {
          name: 'Offline',
          driver: 'postgres',
          host,
          user,
          passwordEnv: 'OMNISQL_FIXTURE_PASSWORD',
          database: 'ledger',
          readOnly: false,
          limits: { timeoutMs: 1000 },
        },
      },
    }),
    { mode: 0o600 }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js')],
    stderr: 'pipe',
    env: {
      ...process.env,
      OMNISQL_CONFIG_FILE: config,
      OMNISQL_WORKSPACE: directory,
      OMNISQL_POLICY_FILE: '',
      OMNISQL_ALLOWED_CONNECTIONS: '',
      OMNISQL_DISABLED_TOOLS: '',
      OMNISQL_DEBUG: 'true',
      OMNISQL_READ_ONLY: 'false',
      OMNISQL_UPDATE_NOTIFIER: 'false',
      OMNISQL_FIXTURE_PASSWORD: password,
    },
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: 'omnisql-privacy-fixture', version: '1' });
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  for (const includeDetails of [false, true]) {
    const result = await call('list_connections', { includeDetails });
    noPrivateValues(result);
    const connections = JSON.parse(result.content[0].text);
    assert.equal(connections.find((c) => c.id === 'primary').name, 'Accounting');
    for (const connection of connections) {
      assert.deepEqual(
        Object.keys(connection).sort(),
        ['capabilities', 'driver', 'id', 'limits', 'name', 'readonly']
          .filter((k) => connection[k] !== undefined)
          .sort()
      );
    }
  }
  const discovered = JSON.parse((await call('list_connections', {})).content[0].text);
  const alias = discovered.find((connection) => connection.name === 'Private selector').id;
  assert.match(alias, /^connection-[a-f0-9]{24}$/);
  noPrivateValues(await call('get_connection_info', { connectionId: alias }));
  noPrivateValues(await call('get_pool_stats', { connectionId: alias }));
  await call('append_insight', { connection: alias, insight: 'Fixture analytical observation' });
  const notes = await call('list_insights', { connection: alias });
  noPrivateValues(notes);
  assert(JSON.stringify(notes).includes(alias));
  noPrivateValues(
    await call('execute_query', { connectionId: alias, query: 'SELECT id FROM sample' })
  );
  noPrivateValues(await call('get_connection_info', { connectionId: 'primary' }));
  const resources = await client.listResources();
  noPrivateValues(resources);
  for (const resource of resources.resources) {
    noPrivateValues(await client.readResource({ uri: resource.uri }));
  }
  noPrivateValues(await call('get_table_schema', { connectionId: 'primary', tableName: 'sample' }));
  noPrivateValues(await call('get_database_stats', { connectionId: 'primary' }));
  noPrivateValues(await call('test_connection', { connectionId: 'inaccessible' }));
  for (const [name, args] of [
    ['execute_query', { connectionId: 'inaccessible', query: 'SELECT 1' }],
    ['write_query', { connectionId: 'primary', query: "INSERT INTO sample VALUES(2,'value')" }],
    ['begin_transaction', { connectionId: 'offline' }],
  ]) {
    await assert.rejects(async () => {
      try {
        await call(name, args);
      } catch (error) {
        noPrivateValues(error.message);
        throw error;
      }
    });
  }
  // Authorized database values stay exact, even when they happen to equal a credential.
  const data = await call('execute_query', {
    connectionId: 'primary',
    query: 'SELECT body FROM sample',
  });
  assert(JSON.stringify(data).includes(password));
  const tools = await client.listTools();
  assert(
    !tools.tools.some((tool) =>
      /^(?:install|set_credentials|create_connection|set_policy)$/.test(tool.name)
    )
  );
  await client.close();
  client = undefined;
  noPrivateValues(stderr);
  assert(!stderr.includes('node_modules/'));
  console.log(
    'Privacy MCP: logical connection DTOs, resources, metadata, native failures, transaction failures and debug stderr passed; authorized row values preserved.'
  );
} finally {
  await client?.close();
  rmSync(directory, { recursive: true, force: true });
}
