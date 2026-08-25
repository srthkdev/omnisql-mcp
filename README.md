# OmniSQL MCP

Universal database MCP server — give AI assistants read/write access to your databases using connections already saved in your local DB client workspace (DBeaver-compatible).

[![npm version](https://badge.fury.io/js/omnisql-mcp.svg)](https://www.npmjs.com/package/omnisql-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

## Database Support

**Natively supported** (direct driver, fast):
- PostgreSQL (via `pg`)
- MySQL / MariaDB (via `mysql2`)
- SQL Server / MSSQL (via `mssql`)
- SQLite (via `sqlite3` CLI)

**Postgres-compatible** (routed through `pg` driver automatically):
- CockroachDB, TimescaleDB, Amazon Redshift, YugabyteDB, AlloyDB, Supabase, Neon, Citus

**Other databases**: Fall back to an external CLI configured via `OMNISQL_CLI_PATH`. Results vary by CLI.

**Custom drivers** wrapping any of the above are detected automatically — see [Custom and IAM-Authenticated Drivers](#custom-and-iam-authenticated-drivers).

## Features

- Reuses connections already configured in your local DB client workspace — no duplicate setup
- Native query execution for PostgreSQL, MySQL/MariaDB, SQLite, SQL Server
- AWS RDS IAM authentication, including custom drivers built on the AWS Advanced JDBC Wrapper
- Connection pooling with configurable pool size and timeouts
- Transaction support (BEGIN/COMMIT/ROLLBACK)
- Query execution plan analysis (EXPLAIN)
- Schema comparison between connections with migration script generation
- Read-only mode with enforced SELECT-only on `execute_query`
- Connection whitelist to restrict which databases are accessible
- Tool filtering to disable specific operations
- Query validation to block dangerous operations (DROP DATABASE, TRUNCATE, DELETE/UPDATE without WHERE)
- Data export to CSV/JSON
- Graceful shutdown with connection pool cleanup

## Requirements

- Node.js 18+
- A local DB client (DBeaver-compatible) with at least one configured connection

## Installation

```bash
npm install -g omnisql-mcp
```

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Cursor

Add to Cursor Settings > MCP Servers:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp"
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OMNISQL_CLI_PATH` | Path to external DB client CLI (used for unsupported-driver fallback) | Unset |
| `OMNISQL_WORKSPACE` | Path to local DB client workspace directory | OS default |
| `OMNISQL_PROJECT` | Name of the DB client project/workspace folder (e.g. custom-named DBeaver project) | `General` |
| `OMNISQL_TIMEOUT` | Query timeout (ms) | `30000` |
| `OMNISQL_DEBUG` | Enable debug logging | `false` |
| `OMNISQL_READ_ONLY` | Disable all write operations | `false` |
| `OMNISQL_ALLOWED_CONNECTIONS` | Comma-separated whitelist of connection IDs or names | All |
| `OMNISQL_DISABLED_TOOLS` | Comma-separated tools to disable | None |
| `OMNISQL_POOL_MIN` | Minimum connections per pool | `2` |
| `OMNISQL_POOL_MAX` | Maximum connections per pool | `10` |
| `OMNISQL_POOL_IDLE_TIMEOUT` | Idle connection timeout (ms) | `30000` |
| `OMNISQL_POOL_ACQUIRE_TIMEOUT` | Connection acquire timeout (ms) | `10000` |
| `OMNISQL_AWS_CLI_PATH` | Path to the AWS CLI (used for RDS IAM authentication) | `aws` |
| `OMNISQL_IAM_TOKEN_TIMEOUT` | Timeout for minting an RDS IAM auth token (ms) | `20000` |
| `OMNISQL_SSH_KNOWN_HOSTS` | known_hosts file used to verify SSH tunnel hosts | `~/.ssh/known_hosts` |
| `OMNISQL_SSH_STRICT_HOST_KEY` | Refuse SSH tunnel hosts with no `known_hosts` entry | `false` |

### Read-Only Mode

Blocks all write operations. The `execute_query` tool only allows SELECT, EXPLAIN, SHOW, and DESCRIBE statements. Transaction tools are disabled entirely.

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_READ_ONLY": "true"
      }
    }
  }
}
```

### Connection Whitelist

Restrict which workspace connections are visible. Accepts connection IDs or display names, comma-separated:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_ALLOWED_CONNECTIONS": "dev-postgres,staging-mysql"
      }
    }
  }
}
```

### Disable Specific Tools

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_DISABLED_TOOLS": "drop_table,alter_table,write_query"
      }
    }
  }
}
```

## Available Tools

### Connection Management
- `list_connections` - List all database connections
- `get_connection_info` - Get connection details
- `test_connection` - Test connectivity

### Data Operations
- `execute_query` - Run read-only queries (SELECT, EXPLAIN, SHOW, DESCRIBE only)
- `write_query` - Run INSERT/UPDATE/DELETE
- `export_data` - Export to CSV/JSON

### Schema Management
- `list_tables` - List tables and views
- `get_table_schema` - Get table structure
- `create_table` - Create tables
- `alter_table` - Modify tables
- `drop_table` - Drop tables (requires confirmation)

### Transactions
- `begin_transaction` - Start a new transaction
- `execute_in_transaction` - Execute query within a transaction
- `commit_transaction` - Commit a transaction
- `rollback_transaction` - Roll back a transaction

### Query Analysis
- `explain_query` - Analyze query execution plan
- `compare_schemas` - Compare schemas between two connections
- `get_pool_stats` - Get connection pool statistics

### Other
- `get_database_stats` - Database statistics
- `append_insight` - Store analysis notes
- `list_insights` - Retrieve stored notes

## Security

- **Read-only enforcement**: `execute_query` only accepts read-only statements (SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA). Write operations must use `write_query`.
- **Query validation**: Blocks DROP DATABASE, DROP SCHEMA, TRUNCATE, DELETE/UPDATE without WHERE, GRANT, REVOKE, and user management statements.
- **Connection whitelist**: Restrict which connections are exposed via `OMNISQL_ALLOWED_CONNECTIONS`.
- **Tool filtering**: Disable any tool via `OMNISQL_DISABLED_TOOLS`.
- **Input sanitization**: Connection IDs and SQL identifiers are sanitized to prevent injection.
- **Recommendation**: For production use, also use a database-level read-only user for defense in depth.

## Workspace Format Support

Supports both configuration formats written by DBeaver-compatible DB clients:
- Legacy: XML config in `.metadata/.plugins/org.jkiss.dbeaver.core/`
- Modern: JSON config in `General/.dbeaver/`

The project/workspace folder name (`General` by default) is configurable via `OMNISQL_PROJECT`,
so workspaces using a custom or renamed DBeaver project (e.g. `DataPlatform`) are discovered
without needing to rename the project or symlink the folder.

### Connection modes

DBeaver connections are configured either **manually** (host, port, database fields) or by
**URL** (a JDBC URL). Both work. In URL mode DBeaver leaves the host/port fields at placeholder
values — usually `localhost` — and reads only the URL, so the URL is what is used here too.

### SSH tunnels

Connections that DBeaver reaches through an SSH tunnel are tunneled here as well. The tunnel is
opened on first use and reused for the lifetime of the server, with a loopback-only local
forward, and the connection's host/port are treated the way DBeaver treats them: as the database
*as seen from the SSH server*.

- Agent, password and public-key authentication are supported, taken from the connection's SSH
  tab. Credentials saved in the workspace (including the tunnel's own, stored separately from
  the database credentials) are decrypted and used.
- Agent authentication needs `SSH_AUTH_SOCK` set **in the MCP server's environment**. MCP clients
  usually do not inherit your shell, so set it explicitly in the client's server config if you
  use an agent.
- The SSH host key is checked against `known_hosts`. A host recorded there must match, or the
  tunnel is refused; a host that is not recorded is accepted, unless
  `OMNISQL_SSH_STRICT_HOST_KEY=true`.
- If a tunnel cannot be opened the connection fails with that reason. It never falls back to
  connecting directly to the recorded host, which would reach an unrelated local database.

### Querying another database on the same server

A connection id may carry a database override — `my-connection/analytics` — to run against a
different database on the same server without adding a second connection in DBeaver. This does
not apply to file-backed engines such as SQLite, where the "database" is a file path.

With `OMNISQL_ALLOWED_CONNECTIONS` set, whitelisting a connection allows the databases its
credentials can reach. To pin it to specific databases, list `connection/database` entries
instead of the bare connection.

Credentials are automatically decrypted from the workspace `credentials-config.json`.

## Custom and IAM-Authenticated Drivers

### Custom drivers

Native routing normally keys off the driver id (`postgres-jdbc`, `mysql8`). Custom drivers often use an
opaque id instead — a UUID, say — which names no engine. Those connections are resolved by falling back
to the connection's `provider` (`postgresql`, `mysql`, …) and then to the JDBC URL's sub-protocol,
including wrapped ones such as `jdbc:aws-wrapper:postgresql://…`. A custom driver wrapping a supported
engine therefore works with no extra configuration.

If an engine still cannot be identified, the resulting error names both the driver id and the provider
so you can see what was missing.

### AWS RDS IAM authentication

Connections that authenticate with an RDS IAM token instead of a stored password are detected and
handled automatically. Both shapes are recognised:

- **AWS Advanced JDBC Wrapper** drivers, which record `wrapperPlugins: "iam"` alongside `awsProfile`
  and `iamRegion`.
- The DB client's own **AWS IAM auth models**.

For these connections OmniSQL:

1. Mints a token with `aws rds generate-db-auth-token` (via the AWS CLI, so SSO and role-chained
   profiles work as configured) and uses it as the password.
2. Caches each token for 13 minutes, under its 15-minute lifetime, and re-mints per physical
   connection so long-lived pools keep working.
3. Forces TLS, which RDS requires for IAM tokens.
4. Resolves the database username from the connection when present. Where it is absent, the username is
   derived from your AWS identity: either the per-developer role name (`<profile>-<user>`) or the
   assumed SSO session name.

**Requirements**: the AWS CLI on `PATH` (or `OMNISQL_AWS_CLI_PATH`), a valid session for the
connection's profile (`aws sso login --profile <profile>`), and network reachability to the endpoint.
An expired SSO session produces an error naming the profile to re-authenticate.

## Development

```bash
git clone https://github.com/srthkdev/omnisql-mcp.git
cd omnisql-mcp
npm install
npm run build
npm test
npm run lint
```

## License

MIT
