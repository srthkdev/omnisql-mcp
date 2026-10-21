# Access & safety

OmniSQL can access databases using the credentials in your workspace. Configure the process and the database account for the level of access you intend to give your assistant.

## Start read-only

```json
{
  "OMNISQL_READ_ONLY": "true"
}
```

Set this in the client's environment block. Write, schema-change, and transaction tools are disabled. Read, export, and query-plan tools validate SQL. PostgreSQL, MySQL/MariaDB, and Oracle queries also use a read-only transaction; SQLite and DuckDB open their files read-only. ClickHouse read requests use its server read-only setting and disallow caller-selected query settings and external table functions. SQL Server requires database permissions as its engine-level boundary. Saved connections marked read-only also reject write tools.

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

Rules apply to query sources in joins, subqueries, unions, and CTEs, and to exports, transactions, schema resources, and table discovery. Denies take precedence. `*` matches within one name component: `public.*` permits that schema's tables. Object checks resolve the catalog identity before applying rules. PostgreSQL and Oracle rules match the resolved, case-sensitive name; MySQL/MariaDB follow `lower_case_table_names`; SQL Server follows its catalog collation; SQLite uses its identifier case rules. This prevents a quoted or differently cased spelling from bypassing a deny. MySQL metadata also distinguishes `orders` from `Orders` on case-sensitive servers. Metadata arguments use exact catalog names: for Oracle, pass `ORDERS` for a table created with unquoted `orders`, and `orders` for a table created as `"orders"`.

Use schema-qualified names in SQL and policy. A bare allow rule permits only a bare SQL reference; qualified denies also protect that reference after catalog resolution. All configured allowlists intersect, and a deny on any spelling of the resolved identity wins. Restricted queries need catalog visibility and support at most 64 distinct object references. Missing, ambiguous, or unsupported identities fail closed. Oracle synonyms and non-ASCII Oracle identifiers currently require database grants without application table rules; they are not resolved by this policy layer. Identifiers containing literal dots are rejected under restrictions.

With database/table/function restrictions, any database-qualified policy for an instance, or a `connectionId/database` target, SQL references must stay inside the selected database. Choose another database using the tool's `database` argument, even if both names appear in a policy's `databases` list. Cross-database joins, SQL Server linked-server names, Oracle database links, and attached SQLite databases are rejected in this scope. Each selected database keeps its own settings and pool.

Database-qualified policy keys also apply when that database is the connection's configured default. Base and database rules intersect:

```json
{
  "version": 1,
  "connections": {
    "server": { "denyTables": ["private.*"] },
    "server/prod": { "readOnly": true },
    "server/dev": {}
  }
}
```

On MySQL/MariaDB and SQL Server, once database-qualified rules exist for an instance, list every selectable database with its exact spelling, using `{}` when no additional restrictions are needed. Unlisted spellings are denied, including case or accent aliases that the server might otherwise resolve to the same database. This keeps database selection independent of the server's configurable name collation. Use separate configured instance IDs when different database defaults or credentials are needed.

Stored result and export handles recheck these resolved identities on every read. Handles also bind to the original connection configuration and application policy revision, captured before execution. Changing the target, credentials, limits, or application policy requires running the query again; repointing an instance ID cannot expose its previous results. This concerns application configuration and does not retroactively retract data already delivered to the client. Transaction authorization uses the transaction's existing lease, so a pool size of one does not deadlock while checking metadata.

Restricted SQL is parsed by the bundled Rust WebAssembly analyzer. PostgreSQL folds only ASCII letters in unquoted CTE aliases; quoted PostgreSQL aliases preserve case. SQLite and DuckDB fold ASCII alias letters even when quoted. On MySQL/MariaDB and SQL Server, spell CTE aliases identically in their definition and references: the parser cannot infer the live catalog collation and keeps differently spelled names as physical references to check. Unsupported or dynamic table references, query-level settings, locks, and unknown functions are denied. Common aggregate, string, and date functions are permitted; additional functions require exact `allowFunctions` entries. Allowing a function also trusts its database-defined behavior. The parser does not inspect view definitions, row policies, triggers, or stored functions. Use database grants and views to constrain underlying data.

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

All setup paths and an unset `OMNISQL_READ_ONLY` default to read-only access. Writes require `OMNISQL_READ_ONLY=false`; explicitly configured connections also require `readOnly: false`. An operator policy that requires read-only access cannot be overridden by either setting.

Write and schema tools apply basic query validation. `drop_table` requires an explicit `confirm: true` argument. That argument is part of the tool call; it is not a separate interactive confirmation dialog.

## Local files and logs

Database credentials and network settings are read locally from the workspace. Connection detail responses expose only a set of public connection fields. Raw property bags, connection strings, and SSH secrets are omitted. SQL and analysis text are omitted from debug argument logs. Debug logs go to stderr.

Query results are returned to your MCP client and can become part of the assistant's context. Local analysis notes are separate from database writes. They are stored under a private workspace and access-policy scope, limited to 1 MiB and 1,000 entries. Changing that scope starts a separate note collection. Disable `append_insight` if you do not want notes stored locally. Old shared temporary notes are not imported.

The optional update check contacts npm for package version information. It sends no connection settings or credentials and can be disabled with `OMNISQL_UPDATE_NOTIFIER=false`.

## Verify encrypted connections

Certificate-verification modes check the database hostname through SSH as well as on direct connections. An explicitly configured certificate or key path must be readable; OmniSQL fails instead of silently choosing another trust store. PostgreSQL SSL handler certificate properties are supported alongside driver properties. MySQL `VERIFY_IDENTITY` performs both chain and hostname checks; `VERIFY_CA` checks the chain only.

IAM connections without an explicit TLS mode default to verified TLS. Configure the database CA bundle when the issuing CA is absent from the system trust store. Explicit mode choices retain their documented driver semantics; disabling TLS is incompatible with IAM authentication. `ssl.serverName` can select the certificate hostname when it differs from the database host recorded for an SSH target.

Policy-file edits are reloaded before access checks. Invalid or missing configured policy files fail closed. Active transactions cannot commit after their policy or instance settings change; start a new transaction after reviewing the change.
