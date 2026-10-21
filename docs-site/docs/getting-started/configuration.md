# Configuration

OmniSQL reads configuration from environment variables. The guided installer sets the workspace, read-only mode, and optional connection allowlist for your client.

## One MCP server, many database instances

Set `OMNISQL_CONFIG_FILE` to an absolute path to your JSON configuration. Workspace discovery can run alongside it; connection IDs must be unique across both sources. You register OmniSQL once in the MCP client. Each tool call selects a `connectionId`; PostgreSQL, MySQL/MariaDB, SQL Server, and ClickHouse calls can also select a `database` on that instance.

```json
{
  "version": 1,
  "defaults": { "readOnly": true },
  "connections": {
    "sales": {
      "driver": "postgresql",
      "host": "localhost",
      "port": 5432,
      "database": "sales",
      "user": "report_reader",
      "passwordEnv": "SALES_DB_PASSWORD",
      "policy": {
        "databases": ["sales", "reporting"],
        "allowTables": ["public.orders", "public.customers"],
        "denyTables": ["public.customer_secrets"]
      },
      "limits": { "maxRows": 1000, "maxBytes": 1048576, "timeoutMs": 15000, "poolMax": 4 }
    },
    "warehouse": {
      "driver": "mysql",
      "urlEnv": "WAREHOUSE_DATABASE_URL",
      "policy": { "allowTables": ["warehouse.inventory"] },
      "limits": { "maxRows": 200, "timeoutMs": 5000, "poolMax": 2 }
    },
    "local-notes": {
      "driver": "sqlite",
      "database": "/absolute/path/notes.db"
    }
  }
}
```

Credentials come from named environment variables in the server process. `urlEnv` accepts a database URL; `passwordEnv` supplies or overrides its password. SQL connection URL query parameters, such as `sslmode`, become driver properties. Store this file outside your repository and restrict its permissions. Connection responses omit URLs, passwords, and raw properties.

For example, one Codex registration can supply the file and credential variables:

```toml
[mcp_servers.omnisql]
command = "npx"
args = ["-y", "omnisql-mcp@latest"]

[mcp_servers.omnisql.env]
OMNISQL_CONFIG_FILE = "/absolute/path/omnisql.json"
SALES_DB_PASSWORD = "replace-locally"
WAREHOUSE_DATABASE_URL = "mysql://reader:replace-locally@localhost:3306/warehouse"
```

Avoid committing the client configuration if it contains credentials. Use your client's environment or secret storage where available.

Then call `execute_query` with:

```json
{ "connectionId": "sales", "database": "reporting", "query": "SELECT count(*) FROM public.orders" }
```

Explicitly configured connections default to read-only. Set `readOnly: false` on a connection to enable its write tools when the process permits writes. Process-wide read-only mode and policy restrictions always take precedence. Default and connection table rules are intersected; a connection cannot widen a default allowlist. Empty allowlists allow nothing. Unknown settings and invalid booleans fail at load time.

Connection configuration is reloaded when resolving a call. Workspace data is cached until its connection or credential files change. Transactions check configuration and policy changes before every operation and roll back when their original scope is revoked.

## Workspace discovery

By default, OmniSQL looks for the standard DBeaver workspace for your operating system and discovers connections across its project directories.

| System | Default workspace |
| --- | --- |
| macOS | `~/Library/DBeaverData/workspace6` |
| Linux | `~/.local/share/DBeaverData/workspace6` |
| Windows | `~/AppData/Roaming/DBeaverData/workspace6` |

Use `OMNISQL_WORKSPACE` to select another directory. Use `OMNISQL_PROJECT` to restrict discovery to one named project. Without it, discovery includes all project directories.

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "npx",
      "args": ["-y", "omnisql-mcp@latest"],
      "env": {
        "OMNISQL_WORKSPACE": "/path/to/DBeaverData/workspace6",
        "OMNISQL_PROJECT": "Analytics",
        "OMNISQL_READ_ONLY": "true"
      }
    }
  }
}
```

Use absolute paths in client configuration. The path is the workspace directory, not the `data-sources.json` file inside a project.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `OMNISQL_CONFIG_FILE` | JSON file containing explicit database instances and per-instance settings | Unset |
| `OMNISQL_DISCOVER_WORKSPACE` | Include saved workspace connections alongside explicit configuration | `false` with a config file; otherwise `true` |
| `OMNISQL_POLICY_FILE` | Additional operator access policy applied across configuration sources | Unset |
| `OMNISQL_WORKSPACE` | Directory containing the DB client workspace | OS default |
| `OMNISQL_PROJECT` | Read only this workspace project | All projects |
| `OMNISQL_READ_ONLY` | Disable write and transaction tools | `true` |
| `OMNISQL_ALLOWED_CONNECTIONS` | Comma-separated connection IDs or names | All connections |
| `OMNISQL_DISABLED_TOOLS` | Comma-separated tool names to disable | None |
| `OMNISQL_TIMEOUT` | Query timeout in milliseconds, where supported by the driver | `30000` |
| `OMNISQL_DEBUG` | Write diagnostic logs to stderr | `false` |
| `OMNISQL_UPDATE_NOTIFIER` | Enable the daily npm version check and update notice | `true` |
| `OMNISQL_POOL_MIN` | Minimum pooled connections | `0` |
| `OMNISQL_POOL_MAX` | Maximum pooled connections | `4` |
| `OMNISQL_POOL_IDLE_TIMEOUT` | Idle connection timeout, milliseconds | `30000` |
| `OMNISQL_POOL_ACQUIRE_TIMEOUT` | Connection acquisition timeout, milliseconds | `10000` |
| `OMNISQL_AWS_CLI_PATH` | AWS CLI executable used for IAM authentication | `aws` |
| `OMNISQL_IAM_TOKEN_TIMEOUT` | IAM token generation timeout, milliseconds | `20000` |
| `OMNISQL_SSH_KNOWN_HOSTS` | SSH host-key file | `~/.ssh/known_hosts` |
| `OMNISQL_SSH_STRICT_HOST_KEY` | Reject unrecorded SSH hosts | `true` |

SSH tunnels require a matching `known_hosts` entry by default. Verify the host fingerprint through a trusted source and record it with SSH before connecting. `OMNISQL_SSH_STRICT_HOST_KEY=false` explicitly restores legacy acceptance of unknown hosts; mismatched and revoked keys remain blocked. Invalid boolean values fail closed.

Read-only mode is enabled even when `OMNISQL_READ_ONLY` is unset. To allow writes, explicitly set it to `false` and set `readOnly: false` on each writable configured connection. Connection and access-policy read-only restrictions still take precedence.

## Read-only access and allowlists

```json
{
  "OMNISQL_READ_ONLY": "true",
  "OMNISQL_ALLOWED_CONNECTIONS": "dev-postgres,analytics",
  "OMNISQL_DISABLED_TOOLS": "append_insight"
}
```

These entries belong inside the client's `env` block. Read-only mode blocks database writes; analysis notes are stored locally and can be disabled separately.

A bare connection ID permits the databases reachable through that connection's credentials. To pin access to particular databases, list `connectionId/database` entries. See [access and safety](../guides/access.md).

## Updates

Client entries created by the installer use `npx -y omnisql-mcp@latest`. Restart your MCP client to pick up a new release. A running server keeps its current version until it restarts.

The server checks npm at most once a day and writes an update notice to stderr if a newer version exists. The check sends no connection settings or credentials. Set `OMNISQL_UPDATE_NOTIFIER=false` to disable it.

For standalone installations, rerun the curl installer. For global npm installations, run `npm install -g omnisql-mcp@latest`.
