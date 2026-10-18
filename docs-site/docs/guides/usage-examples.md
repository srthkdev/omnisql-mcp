# Queries & workflows

These examples use MCP tool names and JSON arguments. Ask your assistant to call the tool, or use the arguments in your MCP client's tool inspector.

## Inspect before querying

Begin with `list_connections`. Then list tables on the connection you intend to use:

```json
{
  "connectionId": "analytics",
  "includeViews": true
}
```

Call `get_table_schema` before writing a query against an unfamiliar table:

```json
{
  "connectionId": "analytics",
  "tableName": "customers"
}
```

## Read a result

Call `execute_query` with a small row limit:

```json
{
  "connectionId": "sales",
  "query": "SELECT name, city FROM customers ORDER BY name",
  "maxRows": 20
}
```

The response includes columns, rows, row count, timing, and a truncation indicator. Use an explicit limit or pagination for large queries rather than relying on the default cap for every SQL form.

## Query another database

A saved PostgreSQL connection pointing at `postgres` can discover other accessible databases through `list_databases`:

```json
{
  "connectionId": "my-pg-server"
}
```

Then call `execute_query` with the chosen database:

```json
{
  "connectionId": "my-pg-server",
  "database": "app_logs",
  "query": "SELECT level, count(*) FROM events GROUP BY level"
}
```

This opens the target database with the saved settings. It does not edit your DBeaver connection.

## Export a result

Call `export_data` with a read-only query:

```json
{
  "connectionId": "sales",
  "query": "SELECT name, city FROM customers",
  "format": "csv",
  "maxRows": 1000
}
```

Choose `json` for an array of objects. Review exported data before sharing it with other services.

## Explain a query

```json
{
  "connectionId": "analytics",
  "query": "SELECT * FROM orders WHERE customer_id = 42",
  "analyze": false,
  "format": "text"
}
```

Call `explain_query` with these arguments. `analyze` can execute the query on engines that support it. Oracle provides an estimated plan only and rejects `analyze`.

## Compare two schemas

```json
{
  "sourceConnectionId": "sales",
  "targetConnectionId": "sales-v2",
  "includeMigrationScript": true
}
```

`compare_schemas` returns a diff and an optional SQL migration preview. Review the script and driver limitations before applying it yourself.

## Try the isolated workspace

From a repository checkout:

```bash
npm ci
npm run build
npm run demo
```

The demo creates two SQLite files under `.demo/` and exercises the MCP tools against synthetic customers and orders. It leaves your saved workspaces untouched.

To also test a temporary PostgreSQL cluster, provide the directory containing `initdb` and `pg_ctl`:

```bash
OMNISQL_DEMO_PG_BIN=/path/to/postgres/bin npm run demo -- --postgres
```

That cluster uses a random password, listens on loopback, and is stopped and removed after the run.
