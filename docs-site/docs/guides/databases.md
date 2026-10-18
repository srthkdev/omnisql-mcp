# Database support

OmniSQL reads your workspace connection settings and selects a native execution path when one is supported. A connection working in DBeaver does not imply that every DBeaver driver has a native OmniSQL equivalent.

## Execution paths

| Engine | Driver | Notes |
| --- | --- | --- |
| PostgreSQL | `pg` | Also used for compatible PostgreSQL wire-protocol servers. |
| MySQL / MariaDB | `mysql2` | Reads driver properties and DBeaver's enabled MySQL SSL handler. |
| SQL Server / MSSQL | `mssql` | Native queries and pooled transactions. |
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

## Select another database

Use `list_databases` to discover databases accessible through a PostgreSQL, MySQL/MariaDB, or SQL Server connection. Pass `database` when calling a supported tool:

```json
{
  "connectionId": "my-pg-server",
  "database": "app_logs",
  "query": "SELECT level, count(*) FROM events GROUP BY level"
}
```

The host, user, saved credentials, TLS settings, IAM model, and SSH settings are inherited. The saved default is unchanged. Pool identities stay separate for each target database.

The argument is supported by `execute_query`, `export_data`, `explain_query`, `list_tables`, `get_table_schema`, `get_database_stats`, `test_connection`, and `get_pool_stats`.

The existing `connectionId: "my-pg-server/app_logs"` shorthand also works. Conflicting targets in the argument and shorthand are rejected. File-backed engines such as SQLite require a separate saved connection for each file.

## SSH tunnels

Enabled `ssh_tunnel` handlers open a local forward to the target configured in the workspace. Password, SSH agent, and public-key authentication are supported.

Known SSH hosts must match their recorded host key. Enable `OMNISQL_SSH_STRICT_HOST_KEY=true` to also reject hosts with no `known_hosts` entry. A failed tunnel does not fall back to a direct database connection.

Oracle TNS aliases and full descriptors cannot be redirected through the SSH tunnel path and are rejected when combined with it. Use a basic Oracle host/service or host/SID connection for that case.

## TLS and URL connections

For URL-mode connections, the JDBC URL supplies the endpoint instead of DBeaver's placeholder host fields. Custom drivers can be resolved through their provider or JDBC subprotocol.

PostgreSQL and MySQL TLS resolution reads nested and top-level driver properties. MySQL also reads the enabled DBeaver SSL handler and its certificate paths. Explicit driver settings take precedence. A mode that requires encryption is distinct from a mode that verifies the server certificate.

## AWS RDS IAM

IAM authentication is recognized from IAM connection settings and AWS Advanced JDBC Wrapper properties. OmniSQL uses the AWS CLI to mint tokens, including configured SSO and role profiles.

Tokens are refreshed for new physical connections. The AWS CLI and an active AWS login must be available to the process that starts OmniSQL. If an SSO session has expired, renew it for the named profile and retry.

## Other engines

Unsupported drivers return an explicit error. OmniSQL does not launch an external GUI or unbounded CLI export as a fallback.
