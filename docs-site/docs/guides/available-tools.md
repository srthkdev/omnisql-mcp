# Tool reference

These tool definitions were exported from the OmniSQL server. The tables below describe the advertised input schemas. Your client may expose fewer tools when read-only mode or tool filtering is enabled.

## A few conventions

- `connectionId` accepts a saved connection ID or name.
- An optional `database` selects a database on the same server for supported tools.
- Queries must use the syntax of the target database.
- `execute_query` accepts a single read-only statement. Use `write_query` for permitted writes.
- Transaction tools require a supported pooled driver and are disabled in read-only mode.
- Schema migration scripts are returned as text; schema comparison does not apply them.

Tool schema options do not imply identical driver support. Explicit transactions support PostgreSQL, MySQL/MariaDB, and SQL Server. Oracle queries use a pool, but multi-call transactions are unavailable. Indexes, constraints, row estimates, and storage use engine catalogs; permissions and engine statistics determine availability. Missing optional catalog permissions produce partial metadata with notes; schema comparisons require complete metadata. ClickHouse storage keys remain distinct from unique constraints. Migration output is a commented review outline; embedded metadata newlines cannot introduce executable lines.

Transaction results use the same row/byte budgets and stored-result readers as ordinary queries. Only one operation may run on a transaction at a time. Query failure, changed connection settings, or an updated access policy rolls the transaction back. Schema operations are excluded to avoid implicit DDL commits. The server caps active plus starting transactions at 32 and cleans up idle transactions after one hour.
