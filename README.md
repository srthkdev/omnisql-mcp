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

## Features

- Reuses connections already configured in your local DB client workspace — no duplicate setup
- Native query execution for PostgreSQL, MySQL/MariaDB, SQLite, SQL Server
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
| `OMNISQL_TIMEOUT` | Query timeout (ms) | `30000` |
| `OMNISQL_DEBUG` | Enable debug logging | `false` |
| `OMNISQL_READ_ONLY` | Disable all write operations | `false` |
| `OMNISQL_ALLOWED_CONNECTIONS` | Comma-separated whitelist of connection IDs or names | All |
| `OMNISQL_DISABLED_TOOLS` | Comma-separated tools to disable | None |
| `OMNISQL_POOL_MIN` | Minimum connections per pool | `2` |
| `OMNISQL_POOL_MAX` | Maximum connections per pool | `10` |
| `OMNISQL_POOL_IDLE_TIMEOUT` | Idle connection timeout (ms) | `30000` |
| `OMNISQL_POOL_ACQUIRE_TIMEOUT` | Connection acquire timeout (ms) | `10000` |

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

Credentials are automatically decrypted from the workspace `credentials-config.json`.

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
