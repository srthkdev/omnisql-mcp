# Access & safety

OmniSQL can access databases using the credentials in your workspace. Configure the process and the database account for the level of access you intend to give your assistant.

## Start read-only

```json
{
  "OMNISQL_READ_ONLY": "true"
}
```

Set this in the client's environment block. Write, schema-change, and transaction tools are disabled. Read, export, and query-plan tools validate SQL. PostgreSQL, MySQL/MariaDB, and Oracle queries also use a read-only transaction; SQLite opens its file read-only. SQL Server requires database permissions as its engine-level boundary. Saved connections marked read-only also reject write tools.

The checks reject stacked statements, write CTEs, `SELECT INTO`, mutating PRAGMAs, and other recognized write operations. SQLite runs with CLI safe mode; a read-only configuration also opens its database file read-only.

> SQL checks are safeguards, not a full SQL sandbox. Use a database account with read-only grants when you need a database-level permission boundary. Functions and database-specific behavior can have effects that a SQL text check cannot fully classify.

## Limit visible connections

```json
{
  "OMNISQL_ALLOWED_CONNECTIONS": "analytics,dev-postgres"
}
```

Entries are comma-separated IDs or names. An unset allowlist exposes all discovered connections.

A bare connection permits other databases reachable with its credentials. To allow only specific databases:

```json
{
  "OMNISQL_ALLOWED_CONNECTIONS": "pg-server/app_logs,pg-server/reporting"
}
```

Queries targeting another database are rejected. Database permissions still decide which operations the credentials can perform.

## Restrict schemas, tables, and functions

Use `policy` in each configured connection, or point `OMNISQL_POLICY_FILE` to an additional JSON policy:

```json
{
  "version": 1,
  "defaults": { "readOnly": true },
  "connections": {
    "sales": {
      "databases": ["sales", "reporting"],
      "schemas": ["public"],
      "allowTables": ["public.orders", "public.customers"],
      "denyTables": ["public.customer_secrets"],
      "denyFunctions": ["pg_sleep"]
    }
  }
}
```

Rules apply to query sources in joins, subqueries, unions, and CTEs, and to exports, transactions, schema resources, and table discovery. Denies take precedence. `*` matches within one name component: `public.*` permits that schema's tables. Names are case-sensitive after database identifier folding; quoted SQL identifiers preserve case. Use schema-qualified names in both SQL and policy. A bare table rule permits only the bare SQL name, whose resolution follows database session settings. Identifiers containing literal dots are rejected under table restrictions.

Restricted SQL is parsed by the bundled Rust WebAssembly analyzer. Unsupported or dynamic table references, query-level settings, locks, and unknown functions are denied. Common aggregate, string, and date functions are permitted; additional functions require exact `allowFunctions` entries. Allowing a function also trusts its database-defined behavior. The parser does not inspect view definitions, row policies, triggers, or stored functions. Use database grants and views to constrain underlying data.

While table rules are active, schema and administrative changes are disabled, including renames and cascading drops that could affect other objects. INSERT, UPDATE, and DELETE remain subject to read-only settings and table rules.

Table rules also filter resource discovery. Disabling `get_table_schema` blocks schema resources as well as the tool. The server does not start a GUI client when read-only access cannot be enforced for an unsupported engine.

## Turn off individual tools

```json
{
  "OMNISQL_DISABLED_TOOLS": "drop_table,alter_table,append_insight"
}
```

Disabled tools are removed from the advertised tool list and blocked if called directly. This is useful when your assistant needs a smaller set of operations.

## Enable writes deliberately

The guided installer defaults to read-only. Direct client setup without `--read-only`, or an unset `OMNISQL_READ_ONLY`, uses the normal read/write configuration.

Write and schema tools apply basic query validation. `drop_table` requires an explicit `confirm: true` argument. That argument is part of the tool call; it is not a separate interactive confirmation dialog.

## Local files and logs

Database credentials and network settings are read locally from the workspace. Connection detail responses expose only a set of public connection fields. Raw property bags, connection strings, and SSH secrets are omitted. SQL and analysis text are omitted from debug argument logs. Debug logs go to stderr.

Query results are returned to your MCP client and can become part of the assistant's context. Local analysis notes are separate from database writes; disable `append_insight` if you do not want notes stored locally.

The optional update check contacts npm for package version information. It sends no connection settings or credentials and can be disabled with `OMNISQL_UPDATE_NOTIFIER=false`.
