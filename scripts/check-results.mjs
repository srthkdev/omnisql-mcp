import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dir = mkdtempSync(join(tmpdir(), 'omnisql-result-check-'));
let client;
try {
  const db = join(dir, 'fixture.db');
  execFileSync('sqlite3', [
    db,
    "CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO messages VALUES(1,replace(hex(zeroblob(50000)),'0','x')); INSERT INTO messages VALUES(2,'second');",
  ]);
  const file = join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      connections: {
        fixture: {
          driver: 'sqlite',
          database: db,
          policy: { allowTables: ['messages'] },
          limits: { maxRows: 10, maxBytes: 1048576 },
        },
      },
    }),
    { mode: 0o600 }
  );
  client = new Client({ name: 'omnisql-result-check', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      stderr: 'pipe',
      env: {
        ...process.env,
        OMNISQL_CONFIG_FILE: file,
        OMNISQL_WORKSPACE: dir,
        OMNISQL_ALLOWED_CONNECTIONS: 'fixture',
        OMNISQL_READ_ONLY: 'true',
        OMNISQL_DISABLED_TOOLS: '',
        OMNISQL_UPDATE_NOTIFIER: 'false',
      },
    })
  );
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError);
    return JSON.parse(response.content[0].text);
  };
  const result = await call('execute_query', {
    connectionId: 'fixture',
    query: 'SELECT * FROM messages',
  });
  assert.equal(result.storedRows, 2);
  assert.equal(result.clippedCells[0].length, 100000);
  const page = await call('read_result', { resultId: result.resultId, offset: 1, limit: 1 });
  assert.deepEqual(page.rows, [[2, 'second']]);
  const cell = await call('read_result_cell', {
    resultId: result.resultId,
    row: 0,
    column: 1,
    offset: 99000,
    length: 1000,
  });
  assert.equal(cell.text, 'x'.repeat(1000));
  assert.equal(cell.nextOffset, null);
  const exported = await call('export_data', {
    connectionId: 'fixture',
    query: 'SELECT * FROM messages',
    format: 'csv',
    includeHeaders: false,
  });
  let data = [],
    offset = 0;
  do {
    const chunk = await call('read_export', { resultId: exported.resultId, offset, length: 48000 });
    data.push(Buffer.from(chunk.data, 'base64'));
    offset = chunk.nextOffset;
  } while (offset !== null);
  assert.equal(Buffer.concat(data).toString(), '1,' + 'x'.repeat(100000) + '\n2,second\n');
  await assert.rejects(() => call('read_result', { resultId: '../../etc/passwd' }));
  await call('append_insight', { connection: 'fixture', insight: 'Synthetic test note' });
  assert.equal((await call('list_insights', {})).length, 1);
  // Revoking a connection table rule also revokes existing handles.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      connections: { fixture: { driver: 'sqlite', database: db, policy: { allowTables: [] } } },
    })
  );
  await assert.rejects(() => call('read_result', { resultId: result.resultId }), /policy/);
  assert.equal((await call('list_insights', {})).length, 0);
  console.log('Stored MCP result pages, long cells, exports, and access revocation passed.');
} finally {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
}
