import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Real catalog comparisons: these must run against the engine, not mocked rows. */
export async function checkIdentifierPolicies({
  engine,
  admin,
  base,
  password,
  workspace,
  startMcp,
  call,
}) {
  const file = join(workspace, 'identifier-policies.json');
  const databasePolicyFile = join(workspace, 'database-policies.json');
  writeFileSync(databasePolicyFile, JSON.stringify({ version: 1 }), { mode: 0o600 });
  const owner =
    engine === 'postgres'
      ? 'public'
      : engine === 'mssql'
        ? 'dbo'
        : engine === 'oracle'
          ? 'OMNISQL'
          : 'omnisql';
  const orders = engine === 'oracle' ? 'ORDERS' : 'orders';
  const customers = engine === 'oracle' ? 'CUSTOMERS' : 'customers';
  const policy = { allowTables: [owner + '.*', '*'], denyTables: [owner + '.' + customers] };
  function configure(rule = policy) {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        connections: {
          scope: {
            ...base,
            readOnly: false,
            policy: rule,
            limits: { poolMax: 1, maxRows: 1000, maxBytes: 1048576, timeoutMs: 5000 },
          },
        },
      }),
      { mode: 0o600 }
    );
  }
  configure();
  const client = await startMcp(workspace, false, {
    OMNISQL_CONFIG_FILE: file,
    OMNISQL_ALLOWED_CONNECTIONS: 'scope',
    OMNISQL_INTEGRATION_PASSWORD: password,
    OMNISQL_POLICY_FILE: databasePolicyFile,
  });
  const query = (text) => call(client, 'execute_query', { connectionId: 'scope', query: text });
  const denied = (text) =>
    assert.rejects(
      () => query(text),
      /Table.*policy|selected database|database scope|Linked-server/
    );
  try {
    await query('SELECT * FROM ' + orders);
    // A schema-qualified deny must also cover search-path resolution and quoted case aliases.
    await denied('SELECT * FROM ' + customers);
    await denied(`SELECT o.id FROM ${orders} o JOIN ${customers} c ON c.id=o.customer_id`);
    const quoted =
      engine === 'mssql'
        ? '[dbo].[CUSTOMERS]'
        : engine === 'mysql' || engine === 'mariadb'
          ? '`omnisql`.`customers`'
          : engine === 'oracle'
            ? '"OMNISQL"."CUSTOMERS"'
            : '"public"."customers"';
    await denied('SELECT * FROM ' + quoted);
    await assert.rejects(
      () =>
        call(client, 'export_data', {
          connectionId: 'scope',
          query: 'SELECT * FROM ' + quoted,
          format: 'csv',
          compression: 'gzip',
        }),
      /Table.*policy/
    );
    await assert.rejects(
      () =>
        call(client, 'get_table_schema', {
          connectionId: 'scope',
          tableName: engine === 'mssql' ? 'dbo.CUSTOMERS' : owner + '.' + customers,
        }),
      /Table.*policy/
    );
    const visible = await call(client, 'list_tables', { connectionId: 'scope' });
    assert(visible.every((t) => t.name.toLowerCase() !== 'customers'));
    if (['postgres', 'mysql', 'mariadb', 'mssql'].includes(engine)) {
      const { transactionId } = await call(client, 'begin_transaction', { connectionId: 'scope' });
      await call(client, 'execute_in_transaction', {
        transactionId,
        query: 'SELECT COUNT(*) FROM orders',
      });
      await assert.rejects(
        () =>
          call(client, 'execute_in_transaction', {
            transactionId,
            query: 'SELECT * FROM ' + quoted,
          }),
        /Table.*policy/
      );
      await assert.rejects(
        () => call(client, 'commit_transaction', { transactionId }),
        /not found/
      );
    }
    // Handles retain the original SQL and must resolve it under the current policy again.
    const payload = engine === 'oracle' ? null : "'" + 'x'.repeat(70000) + "'";
    if (payload) {
      configure({ allowTables: ['*', owner + '.*'] });
      const joined = await query(
        `SELECT o.id FROM ${orders} o JOIN ${customers} c ON c.id=o.customer_id`
      );
      assert.equal(joined.rows.length, 3);
      const stored = await query('SELECT ' + payload + ' AS payload FROM ' + quoted);
      assert(stored.resultId);
      const archive = await call(client, 'export_data', {
        connectionId: 'scope',
        query: 'SELECT * FROM ' + quoted,
        format: 'csv',
        compression: 'gzip',
      });
      configure(policy);
      await assert.rejects(
        () => call(client, 'read_result', { resultId: stored.resultId }),
        /Table.*policy|access policy changed/
      );
      await assert.rejects(
        () => call(client, 'read_export', { resultId: archive.resultId }),
        /Table.*policy|access policy changed/
      );
    }
    if (['postgres', 'mysql', 'mariadb', 'mssql'].includes(engine)) {
      configure({});
      const setDatabaseRules = (connections) =>
        writeFileSync(databasePolicyFile, JSON.stringify({ version: 1, connections }));
      setDatabaseRules({ ['scope/' + base.database]: { readOnly: true } });
      await query('SELECT 1 AS value');
      await assert.rejects(
        () =>
          call(client, 'write_query', {
            connectionId: 'scope',
            query: 'DELETE FROM orders WHERE id=-1',
          }),
        /read.only/i
      );
      await assert.rejects(
        () => call(client, 'begin_transaction', { connectionId: 'scope' }),
        /read.only/i
      );
      if (['mysql', 'mariadb', 'mssql'].includes(engine)) {
        await assert.rejects(
          () =>
            call(client, 'execute_query', {
              connectionId: 'scope',
              database: base.database.toUpperCase(),
              query: 'SELECT 1',
            }),
          /Database.*policy/
        );
        const other = engine === 'mssql' ? 'omnisql_other' : 'information_schema';
        setDatabaseRules({
          ['scope/' + base.database]: {},
          ['scope/' + other]: { readOnly: true },
        });
        const foreignTable = engine === 'mssql' ? other + '.dbo.orders' : other + '.TABLES';
        await assert.rejects(
          () =>
            call(client, 'write_query', {
              connectionId: 'scope',
              query: `DELETE FROM ${foreignTable} WHERE 1=0`,
            }),
          /selected database/
        );
        await call(client, 'execute_query', {
          connectionId: 'scope',
          database: other,
          query: 'SELECT 1',
        });
        for (const [name, args] of [
          ['write_query', { query: 'DELETE FROM orders WHERE id=-1' }],
          ['create_table', { query: 'CREATE TABLE policy_probe(id INTEGER)' }],
          ['alter_table', { query: 'ALTER TABLE orders ADD policy_probe INTEGER' }],
          ['drop_table', { tableName: 'orders', confirm: true }],
          ['begin_transaction', {}],
        ])
          await assert.rejects(
            () => call(client, name, { connectionId: 'scope', database: other, ...args }),
            /read.only/i
          );
      }
      setDatabaseRules({});
      configure(policy);
    }
    if (['mysql', 'mariadb'].includes(engine)) {
      assert.equal(
        Number((await admin.query('SELECT @@lower_case_table_names AS mode'))[0].mode),
        0
      );
      await admin.query('CREATE TABLE `Orders` (secret INTEGER PRIMARY KEY)');
      await admin.query('INSERT INTO `Orders` VALUES (999)');
      configure({ allowTables: ['orders', 'omnisql.orders'] });
      await query('SELECT * FROM orders');
      await denied('SELECT * FROM Orders');
      await denied('SELECT * FROM `omnisql`.`Orders`');
      const schema = await call(client, 'get_table_schema', {
        connectionId: 'scope',
        tableName: 'orders',
      });
      assert.equal(schema.columns.length, 4);
      assert(schema.columns.every((c) => c.name !== 'secret'));
      assert.equal(schema.indexes.filter((i) => i.primary).length, 1);
      await assert.rejects(
        () => call(client, 'get_table_schema', { connectionId: 'scope', tableName: 'Orders' }),
        /Table.*policy/
      );
      assert.deepEqual(
        (await call(client, 'list_tables', { connectionId: 'scope' })).map((t) => t.name),
        ['orders']
      );
      await admin.query('DROP TABLE `Orders`');
      configure({
        databases: ['omnisql', 'information_schema'],
        allowTables: ['*', 'information_schema.*'],
      });
      await denied('SELECT * FROM information_schema.TABLES');
    }
    if (engine === 'oracle') {
      await admin.query('CREATE TABLE "orders" ("secret" INTEGER PRIMARY KEY)');
      // Oracle read-only snapshots cannot span a recent DDL timestamp.
      configure({ allowTables: ['orders'] });
      const deadline = Date.now() + 10000;
      while (true) {
        try {
          await query('SELECT * FROM "orders"');
          break;
        } catch (error) {
          if (!error.message.includes('ORA-01466') || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      await denied('SELECT * FROM ORDERS');
      const exact = await call(client, 'get_table_schema', {
        connectionId: 'scope',
        tableName: 'orders',
      });
      assert.deepEqual(
        exact.columns.map((c) => c.name),
        ['secret']
      );
      await assert.rejects(
        () => call(client, 'get_table_schema', { connectionId: 'scope', tableName: 'ORDERS' }),
        /Table.*policy/
      );
      await admin.query('DROP TABLE "orders"');
    }
    if (engine === 'postgres') {
      const exactNames = ['my-table', "owner's table", 'two words', '123table'];
      for (const name of exactNames) {
        await admin.query(
          'CREATE TABLE "' + name.replace(/"/g, '""') + '" (id INTEGER PRIMARY KEY)'
        );
        configure({ allowTables: ['public.*', '*'] });
        for (const tableName of [name, '"public"."' + name + '"']) {
          const schema = await call(client, 'get_table_schema', {
            connectionId: 'scope',
            tableName,
          });
          assert.deepEqual(
            schema.columns.map((c) => c.name),
            ['id']
          );
          assert.equal(schema.indexes.filter((i) => i.primary).length, 1);
        }
        configure({ allowTables: ['public.*', '*'], denyTables: ['public.' + name] });
        await assert.rejects(
          () => call(client, 'get_table_schema', { connectionId: 'scope', tableName: name }),
          /Table.*policy/
        );
        await admin.query('DROP TABLE "' + name.replace(/"/g, '""') + '"');
      }
      configure({});
      await admin.query('CREATE SCHEMA drop_fixture');
      await admin.query('CREATE TABLE drop_fixture."my-table"(id INTEGER)');
      await admin.query('CREATE TABLE "drop_fixture.my-table"(id INTEGER)');
      await call(client, 'drop_table', {
        connectionId: 'scope',
        tableName: '"drop_fixture"."my-table"',
        confirm: true,
      });
      const targets = await admin.query(
        `SELECT to_regclass('drop_fixture."my-table"') AS intended,
                to_regclass('public."drop_fixture.my-table"') AS separate`
      );
      assert.equal(targets[0].intended, null);
      assert(targets[0].separate, 'Qualified DROP must not target a literal dotted table name');
      await admin.query('DROP TABLE "drop_fixture.my-table"');
      await admin.query('DROP SCHEMA drop_fixture');
      await assert.rejects(
        () => query("SELECT ARRAY[nextval('missing_sequence')]"),
        /not permitted/
      );
      await assert.rejects(
        () => query("SELECT (ARRAY[1])[nextval('missing_sequence')]"),
        /not permitted/
      );
      await admin.query('CREATE TABLE "ä"(secret INTEGER)');
      await admin.query('INSERT INTO "ä" VALUES(999)');
      configure({ allowTables: ['orders', 'public.orders'] });
      const text = 'WITH Ä AS (SELECT id FROM orders) SELECT * FROM ä';
      assert.equal((await admin.query(text))[0].secret, 999);
      await denied(text);
      assert.equal(
        (await query('WITH Ä AS (SELECT id FROM orders) SELECT * FROM Ä')).rows.length,
        3
      );
      await admin.query('DROP TABLE "ä"');
    }
    if (engine === 'mssql') {
      await admin.query('CREATE TABLE omnisql_other.dbo.orders(secret INTEGER)');
      await admin.query('INSERT INTO omnisql_other.dbo.orders VALUES(999)');
      configure({ databases: ['omnisql', 'omnisql_other'], allowTables: ['*', 'dbo.*'] });
      await denied('SELECT * FROM omnisql_other.dbo.orders');
      await denied('SELECT * FROM remote.omnisql.dbo.orders');
      await admin.query('CREATE DATABASE omnisql_case COLLATE Latin1_General_100_CS_AS');
      await admin.query('CREATE TABLE omnisql_case.dbo.orders(id INTEGER)');
      await admin.query('CREATE TABLE omnisql_case.dbo.Orders(secret INTEGER)');
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          connections: {
            scope: {
              ...base,
              database: 'omnisql_case',
              policy: { allowTables: ['orders', 'dbo.orders'] },
            },
          },
        })
      );
      await query('SELECT * FROM dbo.orders');
      await denied('SELECT * FROM dbo.Orders');
      await admin.query('INSERT INTO omnisql_case.dbo.Orders VALUES(999)');
      const text = 'WITH orders AS (SELECT id FROM dbo.orders) SELECT * FROM Orders';
      await admin.query('USE omnisql_case');
      assert.equal((await admin.query(text))[0].secret, 999);
      await denied(text);
      assert.deepEqual(
        (await call(client, 'list_tables', { connectionId: 'scope' })).map((t) => t.name),
        ['orders']
      );
      await admin.query('CREATE FUNCTION dbo.allowed() RETURNS int AS BEGIN RETURN 42 END');
      await admin.query('CREATE FUNCTION dbo.ALLOWED() RETURNS int AS BEGIN RETURN 99 END');
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          connections: {
            scope: {
              ...base,
              database: 'omnisql_case',
              policy: { allowFunctions: ['dbo.allowed'] },
            },
          },
        })
      );
      assert.equal(Number((await query('SELECT dbo.allowed() AS n')).rows[0][0]), 42);
      await assert.rejects(() => query('SELECT dbo.ALLOWED() AS n'), /Function.*policy/);
    }
    console.log(
      `${engine}: actual identifier case, qualified denies, pinned transactions, and handle revocation passed`
    );
  } finally {
    await client.close();
  }
}
