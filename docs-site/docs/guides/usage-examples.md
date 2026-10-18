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
bun install --frozen-lockfile
bun run build
bun run demo
```

The demo creates two SQLite files under `.demo/` and exercises the MCP tools against synthetic customers and orders. It leaves your saved workspaces untouched.

To also test a temporary PostgreSQL cluster, provide the directory containing `initdb` and `pg_ctl`:

```bash
OMNISQL_DEMO_PG_BIN=/path/to/postgres/bin bun run demo -- --postgres
```

That cluster uses a random password, listens on loopback, and is stopped and removed after the run.

## Read a large result in pages

Queries return inline results up to 64 KiB. Larger bounded results return an opaque `resultId`, a preview, and `nextOffset`. Use `read_result` with that ID and row offset to continue. `columnOffset` and `columnLimit` page wide tables. `clippedCells` identifies long values; `read_result_cell` retrieves those in chunks using its returned `nextOffset`.

Handles expire after 15 minutes, belong to the current server process, and are checked against current connection rules on every read. Storage is limited to 32 artifacts and 64 MiB; old results may be evicted sooner. `truncated` means a query reached its configured fetch budget: paging reads the stored subset, not additional database rows. Narrow the query or increase an operator-controlled limit to fetch more.

Large CSV and JSON exports return a handle. `read_export` returns base64 chunks with byte offsets. Concatenate the decoded bytes before decoding UTF-8 or saving the file. Exports never accept an arbitrary filesystem path. CSV respects `includeHeaders: false`. JSON uses positional columns and rows when column names repeat, preserving every value.

Result files use a process-private temporary directory and are removed on shutdown. On Unix, directories use mode 0700 and files 0600. Query output may contain sensitive database values; it is still sent to your MCP client when read.

## Inspect indexes and table size

`get_table_schema` returns columns, ordered index keys, primary/foreign/unique/check constraints, and available definitions. Indexes are included by default; `includeIndexes: false` removes them. Use `schema.table` to disambiguate objects on server databases. SQLite foreign-key names are generated because PRAGMA metadata does not expose declared constraint names.

`get_table_stats` reads catalog row estimates and data/index byte counts without scanning the application table. `get_database_stats` sums visible table storage using a bounded catalog query. Missing catalog permissions produce null size values and explanatory notes. Row estimates depend on database statistics; they are not exact counts. Oracle storage covers the connected user's visible segments and may omit LOB segments. PostgreSQL partitioned parents exclude child storage; visible child relations are counted separately.

Schema comparison keeps schema-qualified names, identifier case, lengths, numeric precision/scale, indexes, and constraints. Cross-database type spellings can still differ. Migration output is a commented review outline: it does not generate incomplete executable DDL or apply changes.

## Browse resources on demand

Resource discovery lists connections without opening every database. Read a connection resource for its public settings and `tablesUri`. Reading that URI lists allowed tables and their `schemaUri` links. Table schema templates also support direct access to a selected table. The same connection and table policies apply to resources and tools.

`explain_query` uses a pinned SQL Server session for estimated plans so SHOWPLAN cannot leak to another query. SQL Server JSON output parses its XML plan into the common response. SQL Server and Oracle actual-plan execution is unavailable through `analyze`. MySQL ANALYZE uses text format; MariaDB uses its own ANALYZE syntax. Oracle NUMBER values are returned as strings to preserve decimal and large-integer precision.

SQL Server driver decimals whose scaled values exceed JavaScript's exact integer range are rejected with a CAST instruction. Use `CAST(expression AS VARCHAR(50))` for exact high-precision output. Unsafe integer values from any driver are rejected instead of silently returning rounded data. Binary values use explicit base64 objects; timestamps use ISO strings.
