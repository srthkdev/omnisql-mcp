# Tool reference

These tool definitions were exported from the OmniSQL server. The tables below describe the advertised input schemas. Your client may expose fewer tools when read-only mode or tool filtering is enabled.

## A few conventions

- `connectionId` accepts a saved connection ID or name.
- An optional `database` selects a database on the same server for supported tools.
- Queries must use the syntax of the target database.
- `execute_query` accepts a single read-only statement. Use `write_query` for permitted writes.
- Transaction tools require a supported pooled driver and are disabled in read-only mode.
- Schema migration scripts are returned as text; schema comparison does not apply them.

Tool schema options do not imply identical driver support. Oracle has no transaction or pool support, and detailed index/constraint introspection is limited. Check results before using a generated migration.
