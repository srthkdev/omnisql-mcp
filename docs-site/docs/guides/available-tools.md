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

## Values and large results

Results use positional `columns` and `rows`, preserving repeated column names. Unsafe integers return as strings. PostgreSQL JSON/JSONB (including arrays), recognized MySQL/MariaDB JSON values, native Oracle JSON, and DuckDB values preserve nested large integers and decimal text. Fractional JSON numbers on these paths return as strings, including small fractions. Ordinary text columns containing JSON remain text. PostgreSQL NUMERIC arrays also retain exact text. PostgreSQL dates/timestamps and MySQL/MariaDB dates/times return native text, preserving sub-millisecond fields. Timestamp text follows the database session's timezone and formatting; it does not imply a timezone where the type has none. Driver-provided non-finite numbers return as `"Infinity"`, `"-Infinity"`, or `"NaN"`, including inside arrays.

Oracle CLOB/NCLOB and BLOB locators are read in bounded pieces before their sessions are released. Text stays text and BLOBs use uppercase hex. A LOB that cannot fit in the configured result budget truncates the result with `limitReason: "bytes"`; it is not fetched in full. Every fetched locator is closed, including skipped rows. External BFILE retrieval is unavailable. Native JSON text conversion is limited to 32,767 bytes on the tested Oracle 23 server; oversized conversions fail with a CLOB hint. Both this limit and the explicit CLOB path are covered by the real fixture; use `JSON_SERIALIZE(expression RETURNING CLOB)` when a document requires an explicit large text representation. These choices avoid the numeric conversion described in the [PostgreSQL driver](https://node-postgres.com/features/types), [MySQL2 driver](https://sidorares.github.io/node-mysql2/docs/documentation), and [Oracle driver](https://node-oracledb.readthedocs.io/en/stable/user_guide/sql_execution.html) documentation.

SQLite, DuckDB, and ClickHouse reject invalid UTF-8 instead of substituting characters. Select hex/base64 text for binary values. Incomplete JSON output and inconsistent columns fail the query. The embedded-engine process must close before its file lock is released, including after errors and timeouts.

Larger responses return an expiring private result handle with a bounded preview. Follow `read_result.nextOffset` for more rows, `nextColumnOffset` for wide results, or `read_result_cell` for complete long values. Export chunks use base64 and byte offsets: concatenate decoded chunks before interpreting text or decompressing them. Every handle read rechecks access against the original connection and application policy scope.

The Oracle fixture also compares a large JSON document constructed from concatenated Unicode CLOBs with the native driver. Oracle 23 Free produces replacement characters at some supplementary-character boundaries in that construction; OmniSQL returns the native value unchanged. Plain Unicode CLOB reads are separately checked against their complete original text. This is an engine conversion limitation, not a guarantee that database-generated JSON matches its pre-conversion source.
