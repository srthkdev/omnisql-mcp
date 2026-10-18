# Database support

OmniSQL reads your workspace connection settings and selects a native execution path when one is supported. A connection working in DBeaver does not imply that every DBeaver driver has a native OmniSQL equivalent.

## Native engines

| Engine | Driver | Notes |
| --- | --- | --- |
| PostgreSQL | `pg` | Also used for compatible PostgreSQL wire-protocol servers. |
| MySQL / MariaDB | `mysql2` | Reads driver properties and DBeaver's enabled MySQL SSL handler. |
| SQL Server / MSSQL | `mssql` | Native queries and pooled transactions. |
| SQLite | `sqlite3` CLI | Requires a local CLI supporting JSON output and safe mode. Each saved connection points to a file. |
| Oracle | `oracledb` | Thin mode; no Oracle Instant Client required. Service names, SIDs, TNS aliases, and descriptors are supported. Oracle transactions and pooling are not supported. |

PostgreSQL-compatible routing includes CockroachDB, TimescaleDB, Amazon Redshift, YugabyteDB, AlloyDB, Supabase, Neon, and Citus. SQL compatibility still depends on the server you are connecting to.

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
