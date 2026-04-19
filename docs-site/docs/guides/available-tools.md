---
sidebar_position: 2
---

# Available Tools

## Connection Management

### `list_connections`
List all database connections discovered in the workspace.

Parameters:
- `includeDetails` (optional): Include detailed connection info

### `get_connection_info`
Get details about a specific connection.

Parameters:
- `connectionId` (required): Connection ID or name

### `test_connection`
Test if a connection works.

Parameters:
- `connectionId` (required): Connection ID or name

## Data Operations

### `execute_query`
Run SELECT queries (read-only).

Parameters:
- `connectionId` (required): Connection ID or name
- `query` (required): SQL SELECT statement
- `maxRows` (optional): Max rows to return (default: 1000)

### `write_query`
Run INSERT, UPDATE, or DELETE queries.

Parameters:
- `connectionId` (required): Connection ID or name
- `query` (required): SQL statement

### `export_data`
Export query results.

Parameters:
- `connectionId` (required): Connection ID or name
- `query` (required): SQL SELECT statement
- `format` (optional): csv or json (default: csv)
- `includeHeaders` (optional): Include headers (default: true)
- `maxRows` (optional): Max rows (default: 10000)

## Schema Management

### `list_tables`
List tables and views.

Parameters:
- `connectionId` (required): Connection ID or name
- `schema` (optional): Schema to list from
- `includeViews` (optional): Include views (default: false)

### `get_table_schema`
Get table structure.

Parameters:
- `connectionId` (required): Connection ID or name
- `tableName` (required): Table name
- `includeIndexes` (optional): Include indexes (default: true)

### `create_table`
Create a table.

Parameters:
- `connectionId` (required): Connection ID or name
- `query` (required): CREATE TABLE statement

### `alter_table`
Modify a table.

Parameters:
- `connectionId` (required): Connection ID or name
- `query` (required): ALTER TABLE statement

### `drop_table`
Drop a table (requires confirmation).

Parameters:
- `connectionId` (required): Connection ID or name
- `tableName` (required): Table to drop
- `confirm` (required): Must be true

## Other

### `get_database_stats`
Get database statistics.

Parameters:
- `connectionId` (required): Connection ID or name

### `append_insight`
Store an analysis note.

Parameters:
- `insight` (required): Note text
- `connection` (optional): Associated connection
- `tags` (optional): Array of tags

### `list_insights`
Retrieve stored notes.

Parameters:
- `connection` (optional): Filter by connection
- `tags` (optional): Filter by tags

## Safety Levels

- **Safe**: Read-only, no side effects
- **Modifies data**: Changes data, not schema
- **Schema changes**: Modifies database structure
- **Destructive**: Permanently removes data/objects (requires confirmation)
