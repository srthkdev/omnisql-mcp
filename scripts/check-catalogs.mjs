import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from './mcp-fixture.mjs';

const directory = mkdtempSync(join(tmpdir(), 'omnisql-catalogs-'));
let client;
try {
  const databases = [join(directory, 'source.db'), join(directory, 'target.db')];
  for (const [index, file] of databases.entries()) {
    const columns = Array.from(
      { length: 800 },
      (_, i) => `c${i} TEXT DEFAULT '${String(index).repeat(80)}'`
    );
    execFileSync('sqlite3', [file], {
      input: 'CREATE TABLE wide(' + columns.join(',') + ');CREATE TABLE small(id INTEGER);',
    });
  }
  const file = join(directory, 'config.json');
  const connections = Object.fromEntries(
    ['source', 'target'].map((id, i) => [
      id,
      {
        driver: 'sqlite',
        database: databases[i],
        readOnly: true,
        policy: { allowTables: ['*', 'main.*'] },
        limits: { timeoutMs: 15000 },
      },
    ])
  );
  const configure = () =>
    writeFileSync(file, JSON.stringify({ version: 1, connections }), { mode: 0o600 });
  configure();
  const fixture = await startFixture({
    OMNISQL_CONFIG_FILE: file,
    OMNISQL_WORKSPACE: directory,
    OMNISQL_ALLOWED_CONNECTIONS: 'source,target',
  });
  client = fixture.client;
  const call = fixture.call;
  const small = await call('get_table_schema', { connectionId: 'source', tableName: 'small' });
  assert.equal(small.columns.length, 1);
  assert.equal(small.resultId, undefined);
  const readDocument = async (handle) => {
    assert.equal(handle.kind, 'document');
    assert(handle.resultId);
    assert.equal(handle.clippedCells[0].encoding, 'json');
    const pieces = [];
    let offset = 0;
    do {
      const cell = await call('read_result_cell', {
        resultId: handle.resultId,
        row: 0,
        column: 0,
        offset,
      });
      assert.equal(cell.encoding, 'json');
      assert(cell.nextOffset === null || cell.nextOffset > offset);
      pieces.push(cell.text);
      offset = cell.nextOffset;
    } while (offset !== null);
    return JSON.parse(pieces.join(''));
  };
  const schema = await call('get_table_schema', { connectionId: 'source', tableName: 'wide' });
  assert(Buffer.byteLength(JSON.stringify(schema)) < 65536);
  assert.equal((await readDocument(schema)).columns.length, 800);
  const resource = await client.readResource({
    uri: 'omnisql:///connections/source/tables/wide/schema',
  });
  const resourceHandle = JSON.parse(resource.contents[0].text);
  assert.equal((await readDocument(resourceHandle)).columns.length, 800);
  const comparison = await call('compare_schemas', {
    sourceConnectionId: 'source',
    targetConnectionId: 'target',
    includeMigrationScript: true,
  });
  const diff = await readDocument(comparison);
  assert(diff.diff.differences.some((table) => table.status === 'modified'));
  assert(diff.migrationScript.length > 65536);
  // Repointing only the target revokes comparison output, while a source-only schema stays valid.
  connections.target.database = databases[0];
  configure();
  await assert.rejects(
    () => call('read_result_cell', { resultId: comparison.resultId, row: 0, column: 0 }),
    /connection or access policy changed/
  );
  assert.equal((await readDocument(schema)).columns.length, 800);
  connections.target.database = databases[1];
  configure();
  const names = Array.from({ length: 1100 }, (_, i) => 'table_' + i + '_' + 'x'.repeat(80));
  execFileSync('sqlite3', [databases[0]], {
    input: 'BEGIN;' + names.map((name) => `CREATE TABLE ${name}(id INTEGER);`).join('') + 'COMMIT;',
  });
  const tables = await call('list_tables', { connectionId: 'source' });
  assert.equal((await readDocument(tables)).length, 1102);
  const listResource = await client.readResource({ uri: 'omnisql:///connections/source/tables' });
  assert.equal((await readDocument(JSON.parse(listResource.contents[0].text))).length, 1102);
  await assert.rejects(
    () => call('compare_schemas', { sourceConnectionId: 'source', targetConnectionId: 'target' }),
    /table.*limit|narrow/i
  );
  const restricted = await startFixture({
    OMNISQL_CONFIG_FILE: file,
    OMNISQL_WORKSPACE: directory,
    OMNISQL_ALLOWED_CONNECTIONS: 'source,target',
    OMNISQL_DISABLED_TOOLS: 'read_result_cell',
  });
  try {
    await assert.rejects(
      () => restricted.call('get_table_schema', { connectionId: 'source', tableName: 'wide' }),
      /require read_result_cell/
    );
    assert.equal(
      (await restricted.call('get_table_schema', { connectionId: 'source', tableName: 'small' }))
        .columns.length,
      1
    );
  } finally {
    await restricted.client.close();
  }
  console.log(
    'Catalog MCP: large schemas, resource documents, table discovery, bounded comparisons, and both-source revocation passed.'
  );
} finally {
  await client?.close();
  rmSync(directory, { recursive: true, force: true });
}
