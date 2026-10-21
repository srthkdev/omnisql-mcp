# Database support

OmniSQL reads your workspace connection settings and selects a native execution path when one is supported. A connection working in DBeaver does not imply that every DBeaver driver has a native OmniSQL equivalent.

## Execution paths

| Engine | Driver | Notes |
| --- | --- | --- |
| PostgreSQL | `pg` | Also used for compatible PostgreSQL wire-protocol servers. |
| MySQL / MariaDB | `mysql2` | Reads driver properties and DBeaver's enabled MySQL SSL handler. |
| SQL Server / MSSQL | `mssql` | Native queries and pooled transactions. |
| ClickHouse | HTTP/HTTPS | Verified TLS, keep-alive, zstd/gzip transport, exact decimals/maps, and native read-only requests. |
| DuckDB | DuckDB CLI 1.5.6+ | Existing local files, locked safe mode, concurrent reads, and coordinated writes. |
| SQLite | `sqlite3` CLI | Requires a local CLI supporting JSON output and safe mode. Each saved connection points to a file. |
| Oracle | `oracledb` | Thin mode; no Oracle Instant Client required. Service names, SIDs, TNS aliases, and descriptors are supported. Ordinary queries use bounded pools; privileged sessions stay standalone. Explicit multi-call transactions are unavailable. |

PostgreSQL-compatible routing includes CockroachDB, TimescaleDB, Amazon Redshift, YugabyteDB, AlloyDB, Supabase, Neon, and Citus. SQL compatibility still depends on the server you are connecting to.

## DuckDB local analytics

Install the [official DuckDB CLI](https://duckdb.org/install/) version 1.5.6 or newer. On macOS, `brew install duckdb` is also available. Set `OMNISQL_DUCKDB_CLI` to its absolute executable path when a GUI client's PATH does not include it. OmniSQL keeps DuckDB's native binary outside the npm package.

```json
{
  "version": 1,
  "connections": {
    "warehouse": {
      "driver": "duckdb",
      "database": "/absolute/path/warehouse.duckdb",
      "policy": { "allowTables": ["main.orders", "orders"] },
      "properties": { "duckdb.memoryMB": "256", "duckdb.threads": "2" },
      "limits": { "maxRows": 10000, "maxBytes": 8388608, "timeoutMs": 15000 }
    }
  }
}
```

Files must already exist. Each file is a separate connection; remote and in-memory targets are unavailable. Read calls open the file read-only. The server coordinates concurrent readers and exclusive writers to the same file; external processes remain subject to DuckDB's own file locks. Explicit multi-call transactions are unavailable. DuckDB's CLI does not report affected-row counts through this execution path, so write responses return `affectedRows: null`.

Both read-only and write-enabled connections disable external file/network access, automatic extension loading/installation, community extensions, and disk spilling. User startup files are skipped. Safe mode locks configuration after applying memory and thread limits. Defaults are 256 MB and two threads; `duckdb.memoryMB` accepts 16–4096 and `duckdb.threads` accepts 1–32. Result limits and process deadlines still apply. These controls follow [DuckDB's security guidance](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview); operating-system isolation remains the boundary for hostile database files or native engine vulnerabilities.

Tables, views, columns, explicit ART index expressions, primary/foreign/unique/check constraints, row estimates, text/JSON plans, and EXPLAIN ANALYZE are supported. Implicit constraint indexes are represented by their constraints. Per-table storage bytes return `null`: shared database blocks cannot be attributed reliably to individual tables. Metadata compares identifiers using DuckDB's ASCII case rules, including quoted names. Restricted SQL accepts bare or `schema.table` names; catalog-qualified names fail closed.

64-bit integers and nested large integers remain decimal strings. Fractional and exponent-form JSON numbers also remain strings, including inside lists and structs, so nested DECIMAL values keep their exact text. Very large results use the same private paging and compressed exports as other engines. Parquet/CSV/URL scans and extension installation are intentionally unavailable through the server; load data into the local database separately.

## ClickHouse analytics

Use an HTTP or HTTPS endpoint, usually port 8123 or 8443, rather than native TCP port 9000. HTTP(S) URLs retain their standard port defaults when no port is specified. HTTPS always verifies the certificate and original hostname, including through an SSH forward. Optional `sslrootcert`, `sslcert`, `sslkey`, and `ssl.serverName` properties select trust material, client certificates, and the certificate hostname. Explicit unreadable files fail closed.

```json
{
  "version": 1,
  "connections": {
    "events": {
      "driver": "clickhouse",
      "urlEnv": "CLICKHOUSE_DATABASE_URL",
      "policy": { "allowTables": ["events.orders", "orders"] },
      "properties": {
        "clickhouse.compression": "zstd",
        "clickhouse.memoryMB": "256",
        "clickhouse.readonlyMode": "1"
      },
      "limits": { "maxRows": 10000, "maxBytes": 8388608, "timeoutMs": 15000 }
    }
  }
}
```

Set the named variable locally to your HTTP(S) database URL. Authentication travels in request headers; SQL travels in the POST body. Redirects are rejected. Keep-alive connections are bounded and closed with the server. Zstd is the default transport codec, with gzip accepted as a response fallback. SQL bodies larger than 4 KiB use the selected codec when it reduces their size. Set `clickhouse.compression` to `"gzip"` for gzip-only negotiation or `"none"` to disable compression. Streaming decoders enforce the result budget after decompression; zstd also has an 8 MiB window limit. MCP stdio messages keep their normal JSON framing.

Read requests use ClickHouse's native `readonly=1` by default. Mode 1 is the stricter engine setting. Mode 2 is an explicit option for accounts already locked to it: it blocks persistent-table INSERT/UPDATE/DELETE and ordinary DDL, but permits settings changes and operations such as RESTORE and temporary-table writes. Application read guards remain mandatory in both modes; neither setting is a complete SQL sandbox. Query-level `SETTINGS`, caller-selected `FORMAT`, locks, and external/dynamic table functions are blocked before HTTP requests, including on write-enabled connections. Use database grants to restrict engines, dictionaries, views, stored functions, and underlying objects as well. Queries unsupported by the SQL grammar fail closed. Write requests cannot lower a database account's existing read-only setting.

For an existing reader account, a bounded profile can allow the protocol settings:

```sql
GRANT SELECT ON events.orders TO mcp_reader;
ALTER USER mcp_reader SETTINGS
  readonly = 1,
  replace_running_query = 1,
  max_execution_time = 30 MIN 1 MAX 30 CHANGEABLE_IN_READONLY,
  max_memory_usage = 268435456 MIN 16777216 MAX 268435456 CHANGEABLE_IN_READONLY,
  cancel_http_readonly_queries_on_client_close = 1,
  output_format_json_quote_64bit_integers = 1,
  output_format_json_quote_decimals = 1,
  output_format_decimal_trailing_zeros = 1,
  output_format_json_map_as_array_of_tuples = 1,
  enable_http_compression = 1;
```

For mode 1, the profile must already set, or permit changing, the formatting settings `output_format_json_quote_64bit_integers=1`, `output_format_json_quote_decimals=1`, `output_format_decimal_trailing_zeros=1`, `output_format_json_map_as_array_of_tuples=1`, and `enable_http_compression=1`, as well as the execution/memory/cancellation settings above. Match the profile’s compression default when setting `clickhouse.compression` to `"none"`. Set `clickhouse.readonlyMode` to `"2"` only for an account configured for mode 2 after reviewing its broader permissions. OmniSQL reports a rejected setting and does not silently relax the account. `clickhouse.memoryMB` accepts 16–4096; a stricter server profile still takes precedence. These behaviors follow the [ClickHouse HTTP interface](https://clickhouse.com/docs/concepts/features/interfaces/http) and its [query permissions](https://clickhouse.com/docs/operations/settings/permissions-for-queries).

Each call selects a database independently; credentials and transport can serve several configured instances. Table names are case-sensitive. Policy checks resolve native catalog identities, and restricted SQL must stay in the database selected by the tool argument. `list_databases`, table discovery, columns, skipping indexes, CHECK constraints, row/storage catalogs, and estimated text/JSON plans are supported. Explicit multi-call transactions and EXPLAIN ANALYZE are unavailable. Write responses use `affectedRows: null` because this path does not promise an affected-row count.

Schema responses expose `physicalKeys` for primary, sorting, partition, and sampling expressions. A ClickHouse primary key is a sparse storage index; it is not reported as a unique or relational PRIMARY KEY constraint. Storage reports catalog totals without inventing a data/index split. Missing optional catalog permissions return `partial: true` with notes; comparisons reject incomplete schemas. Grant the needed catalog access, such as `SELECT ON system.constraints`, when full details are required.

Positional JSON preserves repeated columns. Large integers and decimals retain their exact text. Maps return a list of key/value entries so repeated keys survive. Response limits apply after decompression; late HTTP errors and interrupted streams fail instead of returning a successful partial query. Read cancellation closes the HTTP connection and uses a bounded replacement request with the same private query ID to stop the original query. This needs `replace_running_query=1` in a locked mode-1 profile and does not require reading other users' process metadata. Cleanup has a 750 ms grace period; an unconfirmed cancellation is reported as an error. A timed-out write may have completed: inspect its status before retrying. [Measured query and transfer costs](https://github.com/srthkdev/omnisql-mcp/blob/main/docs/benchmarks/2026-10-18-clickhouse.md) use seeded local data.

## Select another database

Use `list_databases` to discover databases accessible through a PostgreSQL, MySQL/MariaDB, SQL Server, or ClickHouse connection. Pass `database` when calling a supported tool:

```json
{
  "connectionId": "my-pg-server",
  "database": "app_logs",
  "query": "SELECT level, count(*) FROM events GROUP BY level"
}
```

Write, schema-change, and `begin_transaction` calls accept the same `database` argument and enforce that database's read-only and access rules. Later transaction calls use their transaction ID, which stays pinned to the selected database.

The host, user, saved credentials, TLS settings, IAM model, and SSH settings are inherited. The saved default is unchanged. Pool identities stay separate for each target database.

The argument is supported by `execute_query`, `export_data`, `explain_query`, `list_tables`, `get_table_schema`, `get_database_stats`, `get_table_stats`, `test_connection`, `get_pool_stats`, `write_query`, `create_table`, `alter_table`, `drop_table`, and `begin_transaction`.

The existing `connectionId: "my-pg-server/app_logs"` shorthand also works. Conflicting targets in the argument and shorthand are rejected. File-backed engines such as SQLite require a separate saved connection for each file.

## SSH tunnels

Enabled `ssh_tunnel` handlers open a local forward to the target configured in the workspace. Password, SSH agent, and public-key authentication are supported.

SSH tunnels require a matching `known_hosts` entry by default. Verify and record an unknown host fingerprint before connecting. `OMNISQL_SSH_STRICT_HOST_KEY=false` explicitly allows unknown hosts for legacy setups; mismatched and revoked keys remain blocked. A failed tunnel does not fall back to a direct database connection.

Oracle TNS aliases and full descriptors cannot be redirected through the SSH tunnel path and are rejected when combined with it. Use a basic Oracle host/service or host/SID connection for that case.

## TLS and URL connections

For URL-mode connections, the JDBC URL supplies the endpoint instead of DBeaver's placeholder host fields. Custom drivers can be resolved through their provider or JDBC subprotocol.

PostgreSQL and MySQL TLS resolution reads nested and top-level driver properties. MySQL also reads the enabled DBeaver SSL handler and its certificate paths. Explicit driver settings take precedence. A mode that requires encryption is distinct from a mode that verifies the server certificate.

## AWS RDS IAM

IAM authentication is recognized from IAM connection settings and AWS Advanced JDBC Wrapper properties. OmniSQL uses the AWS CLI to mint tokens, including configured SSO and role profiles.

Tokens are refreshed for new physical connections. The AWS CLI and an active AWS login must be available to the process that starts OmniSQL. If an SSO session has expired, renew it for the named profile and retry.

## Exact timestamp values

PostgreSQL and MySQL/MariaDB timestamps remain exact strings. Oracle timestamps with more than three fractional digits (or unknown precision) require an explicit `TO_CHAR(value, 'YYYY-MM-DD HH24:MI:SS.FF9')`; include `TZH:TZM` for a time zone. SQL Server `DATETIME2`, `DATETIMEOFFSET`, and `TIME` above millisecond precision require text, for example `CONVERT(VARCHAR(40), value, 126)` (style `127` for a zoned instant). These results fail with an actionable error instead of silently discarding fractional digits in JavaScript dates. Millisecond-precision dates still work directly.

## Other engines

Unsupported drivers return an explicit error. OmniSQL does not launch an external GUI or unbounded CLI export as a fallback.
