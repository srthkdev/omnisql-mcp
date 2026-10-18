# Configuration

OmniSQL reads configuration from environment variables. The guided installer sets the workspace, read-only mode, and optional connection allowlist for your client.

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
| `OMNISQL_WORKSPACE` | Directory containing the DB client workspace | OS default |
| `OMNISQL_PROJECT` | Read only this workspace project | All projects |
| `OMNISQL_READ_ONLY` | Disable write and transaction tools | `false` |
| `OMNISQL_ALLOWED_CONNECTIONS` | Comma-separated connection IDs or names | All connections |
| `OMNISQL_DISABLED_TOOLS` | Comma-separated tool names to disable | None |
| `OMNISQL_TIMEOUT` | Query timeout in milliseconds, where supported by the driver | `30000` |
| `OMNISQL_DEBUG` | Write diagnostic logs to stderr | `false` |
| `OMNISQL_UPDATE_NOTIFIER` | Enable the daily npm version check and update notice | `true` |
| `OMNISQL_CLI_PATH` | External client CLI for unsupported-driver fallback | Unset |
| `OMNISQL_POOL_MIN` | Minimum pooled connections | `2` |
| `OMNISQL_POOL_MAX` | Maximum pooled connections | `10` |
| `OMNISQL_POOL_IDLE_TIMEOUT` | Idle connection timeout, milliseconds | `30000` |
| `OMNISQL_POOL_ACQUIRE_TIMEOUT` | Connection acquisition timeout, milliseconds | `10000` |
| `OMNISQL_AWS_CLI_PATH` | AWS CLI executable used for IAM authentication | `aws` |
| `OMNISQL_IAM_TOKEN_TIMEOUT` | IAM token generation timeout, milliseconds | `20000` |
| `OMNISQL_SSH_KNOWN_HOSTS` | SSH host-key file | `~/.ssh/known_hosts` |
| `OMNISQL_SSH_STRICT_HOST_KEY` | Reject unrecorded SSH hosts | `false` |

A configured SSH host key must match even when strict mode is off. Strict mode also rejects hosts that have no entry.

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
