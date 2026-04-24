# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **DBeaver 25+ compatibility**: query execution for drivers without a native branch (Oracle, ClickHouse pre-patch, etc.) silently timed out because the CLI fallback passed `-o`/`-of` flags that DBeaver 25 removed. DBeaver would ignore the flags, open the UI, and never exit. The CLI query fallback has been removed in favor of clear errors.
- **`export_data` no longer depends on the CLI**: routed through the existing native drivers; CSV/JSON is produced in-process, fixing the same hang.

### Added
- **ClickHouse native driver**: query execution via the ClickHouse HTTP interface (`default_format=JSON`). TLS is selected automatically when `ssl=true` is set on the DBeaver connection or when the port is 443/8443. Auth uses `X-ClickHouse-User` / `X-ClickHouse-Key` headers.
- **Clear error for unsupported drivers**: `executeQuery` now fails fast with a message listing the natively supported drivers instead of hanging for the full timeout.

### Removed
- Dead CLI plumbing: `executeViaCli`, `executeCli`, `isCliAvailable`, `parseCSVOutput`, `cleanupFiles`, the `csv-parser` usage in `workspace-client.ts`, and the unused `executablePath` field. The `_executablePath` constructor parameter is preserved (ignored) for backward compatibility.

## [2.0.1] - 2026-04-20

### Changed
- **Package size reduced from 306 kB to 60 kB**: added a `files` whitelist in `package.json` so the npm tarball no longer includes `docs-site/`, `tests/`, `scripts/`, `examples/`, or local runtime logs. Only `dist/`, `README.md`, `CHANGELOG.md`, and `LICENSE` are published.

## [2.0.0] - 2026-04-20

### Changed (Breaking)
- **Renamed package**: `dbeaver-mcp-server` → `omnisql-mcp`. The old npm package is deprecated; install `omnisql-mcp` going forward.
- **Renamed binary**: `dbeaver-mcp-server` → `omnisql-mcp`.
- **Renamed environment variables**: All `DBEAVER_*` env vars are now `OMNISQL_*` (for example, the old `DBEAVER_READ_ONLY` is now `OMNISQL_READ_ONLY`, old `DBEAVER_WORKSPACE` is now `OMNISQL_WORKSPACE`, and old `DBEAVER_PATH` is now `OMNISQL_CLI_PATH`). Update your MCP client config.
- **Renamed resource URI scheme**: `dbeaver://` → `omnisql://` for table schema resources.
- **Renamed internal classes**: `DBeaverConfigParser` → `WorkspaceConfigParser`, `DBeaverClient` → `WorkspaceClient`, `DBeaverMCPServer` → `OmniSQLMCPServer`. Interfaces `DBeaverConnection` → `DatabaseConnection`, `DBeaverConfig` → `WorkspaceConfig`.
- **CLI auto-detection removed**: `OMNISQL_CLI_PATH` must now be set explicitly to use the CLI fallback for unsupported drivers. Previously the server attempted to locate the DB client binary in hardcoded install paths.

Functional behavior is otherwise unchanged — the server still reads connections from the same local DB client workspace (DBeaver-compatible).

## [1.3.0] - 2026-02-16

### Added
- **Postgres-compatible driver routing**: CockroachDB, TimescaleDB, Redshift, YugabyteDB, AlloyDB, Supabase, Neon, and Citus now route through the native PostgreSQL driver automatically
- **CI auto-publish**: Every push to `main` with a new version automatically publishes to npm and creates a git tag
- **Stale transaction cleanup**: Periodic cleanup (every 5 minutes) automatically rolls back transactions older than 1 hour
- **Graceful shutdown improvements**: Active transactions are rolled back before connection pools are closed
- `rollbackAll()` method on TransactionManager for shutdown scenarios

### Fixed
- **Credential leak (Security)**: `list_connections` with `includeDetails=true` and `get_connection_info` no longer expose passwords — all sensitive fields are redacted
- **Debug log credential leak (Security)**: Tool arguments are redacted before debug logging to prevent passwords appearing in logs
- **Pool creation race condition**: Concurrent `getPool()` calls for the same connection no longer create duplicate pools — uses a pending-creation map for deduplication
- **Transaction resource leak**: Failed `commit`/`rollback` now releases the database client back to the pool instead of leaking it
- **Insights file unbounded growth**: Capped at 1,000 entries, oldest entries are trimmed on save

### Changed
- CI workflow now includes a `publish` job that runs after all checks pass on `main`
- Pool manager's `isPostgresCompatible()` is now a public method shared with workspace-client

## [1.2.5] - 2026-02-15

### Added
- Connection whitelist via `OMNISQL_ALLOWED_CONNECTIONS` environment variable — restrict which workspace connections are visible by ID or name
- `enforceReadOnly()` query-level enforcement — `execute_query` now strictly allows only read-only statements (SELECT, EXPLAIN, SHOW, DESCRIBE, PRAGMA)
- Test queries for SAP HANA (`SELECT * FROM DUMMY`) and DB2 (`SYSIBM.SYSDUMMY1`)

### Fixed
- **Read-only mode bypass (Issue #19)**: `execute_query` no longer allows write operations (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP). Transaction tools (`begin_transaction`, `commit_transaction`, `rollback_transaction`, `execute_in_transaction`) are now blocked in read-only mode.
- **Unsupported driver errors (Issue #17)**: CLI fallback now provides clear, actionable error messages listing natively supported drivers and workarounds. CLI availability is checked before attempting fallback.
- **UPDATE validation regex**: `UPDATE ... SET ... WHERE ...` was incorrectly blocked by the dangerous query filter. The regex now correctly allows UPDATE with WHERE clause.

### Changed
- CLI fallback uses connection name-based spec for better compatibility

## [1.2.4] - 2026-01-15

### Added
- Native MySQL/MariaDB support via `mysql2` library
- Read-only mode (`OMNISQL_READ_ONLY=true`) to disable write operations
- Tool filtering via `OMNISQL_DISABLED_TOOLS` environment variable
- GitHub Actions CI/CD pipeline
- ESLint and Prettier configuration
- Pre-commit hooks via Husky
- Vitest test framework
- Issue and PR templates
- Connection pooling for PostgreSQL, MySQL, and MSSQL with configurable pool settings
- Transaction support with `begin_transaction`, `commit_transaction`, `rollback_transaction`, and `execute_in_transaction` tools
- Query explain tool (`explain_query`) for analyzing query execution plans
- Schema comparison tool (`compare_schemas`) for diffing schemas between connections
- Pool statistics tool (`get_pool_stats`) for monitoring connection pool health

### Changed
- Upgraded `@modelcontextprotocol/sdk` from 1.9.0 to 1.25.2 (security fix)
- Improved error messages for unsupported database drivers
- Better trailing semicolon handling in LIMIT clause

### Fixed
- Security vulnerabilities in dependencies
- `@types/mssql` moved to devDependencies
- SQL injection vulnerability in table/schema name handling
- Deprecated `.substr()` replaced with secure `crypto.randomBytes()`
- Added maxRows validation with upper bounds (100k query, 1M export)
- Removed unsupported export formats (xml, excel) from API schema

## [1.2.3] - 2026-01-07

### Added
- Native MSSQL/SQL Server support via `mssql` library
- `xml2js` for legacy XML workspace config parsing

### Fixed
- Missing `xml2js` runtime dependency that broke npm installations
- PostgreSQL connection cleanup logging

## [1.2.2] - 2024-12-XX

### Added
- SSL/TLS support for PostgreSQL connections
- Credential decryption from the workspace credentials-config.json

### Fixed
- Authentication failures with PostgreSQL (Issue #8)

## [1.2.0] - 2024-10-XX

### Added
- Native PostgreSQL support via `pg` library
- Native SQLite support via sqlite3 CLI
- CLI fallback for unsupported drivers
- Business insights tracking feature

### Changed
- Query execution no longer requires the DB client GUI for supported databases

## [1.1.0] - 2024-09-XX

### Added
- Initial MCP server implementation
- Support for legacy XML and modern JSON workspace config formats
- Connection management tools
- Query execution tools
- Schema management tools
- Data export functionality
