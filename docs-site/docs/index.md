# Your workspace, in your assistant.

OmniSQL is a local MCP server for the database connections you have already saved in a DBeaver-compatible workspace. It gives your assistant tools to discover connections, inspect tables, run queries, and export results.

It works with Claude Code, Codex, OpenCode, and other clients that can start an MCP server over stdio.

## Start with one command

```bash
npx -y omnisql-mcp@latest install
```

Choose a client, a workspace directory, and the access you want to allow. The guided installer defaults to read-only access. There is no OmniSQL account or API key.

[Set up your client](getting-started/installation.md)

## What happens when you connect

1. Your MCP client starts the OmniSQL process on your machine.
2. OmniSQL discovers saved connections and reads the credentials and network settings from the workspace.
3. Your assistant selects a tool. OmniSQL opens the database connection with the appropriate native driver.
4. The result returns to your MCP client as structured data.

The server does not route queries through an OmniSQL cloud service. Your assistant can receive query results through its MCP tools; treat those results according to your assistant provider's data policy.

## Native database drivers

| Engine | Execution path |
| --- | --- |
| PostgreSQL and compatible servers | `pg` |
| MySQL and MariaDB | `mysql2` |
| SQL Server | `mssql` |
| Oracle | `oracledb`, Thin mode |
| SQLite | Local `sqlite3` CLI |

[Database support and connection details](guides/databases.md)

## Choose the access you need

For inspection and analysis, begin with read-only mode and a connection allowlist. For a database-level permission boundary, also use a database account with read-only grants.

Write tools, transaction support, and schema changes are available when enabled and supported by the driver. Read the [access guide](guides/access.md) before enabling them.

## Explore the tools

The tool reference covers connection discovery, queries, schemas, exports, execution plans, transactions, and local analysis notes.

The [tool reference](guides/available-tools.md) contains the input schemas exported from the server. [Queries and workflows](guides/usage-examples.md) shows how they fit together.
