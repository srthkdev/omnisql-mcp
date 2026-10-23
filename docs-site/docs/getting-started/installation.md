# Install & connect

You need Bun 1.4.3 or newer, or Node.js 22.15 or newer with npm, an MCP client, and either an instance configuration file or a DBeaver-compatible workspace with saved, working connections. The standalone installer uses Bun; npm/npx setups use Node.

## Guided setup

```bash
npx -y omnisql-mcp@latest install
```

The installer asks you to choose a client and a connection source: direct database setup, an existing configuration file, or an optional DBeaver workspace. Direct setup accepts multiple instances, read-only settings and table rules. Credentials stay in a private configuration file or referenced environment variables; they are not placed in the client registration command. No OmniSQL token is needed.

It calls the selected client's own registration command and refuses to overwrite an existing OmniSQL entry. Start a new client session, then ask it to list your database connections.

## Set up one client directly

Provide an existing configuration file, or select specific saved workspace connections:

```bash
npx -y omnisql-mcp@latest install claude --config /absolute/path/connections.json
npx -y omnisql-mcp@latest install codex --config /absolute/path/connections.json
npx -y omnisql-mcp@latest install opencode --config /absolute/path/connections.json
# Optional DBeaver discovery, restricted to the selected IDs:
npx -y omnisql-mcp@latest install codex --workspace /absolute/path/workspace6 --allow reports,analytics
```

Read-only is the default. `--allow-writes` explicitly enables write tools; direct configuration entries must also set `readOnly: false`. An operator policy or database role can still deny writes. Append `--dry-run` to inspect the command. Running `install <client>` in an interactive terminal opens guided setup for that client.

The OpenCode installer uses the v2 CLI; older versions can use manual MCP configuration.

## Native registration commands

If you prefer your client's own CLI:

```bash
# Claude Code — user scope, across projects
claude mcp add --transport stdio --scope user omnisql \
  --env OMNISQL_CONFIG_FILE=/absolute/path/connections.json --env OMNISQL_READ_ONLY=true -- npx -y omnisql-mcp@latest

# Codex
codex mcp add omnisql --env OMNISQL_CONFIG_FILE=/absolute/path/connections.json --env OMNISQL_READ_ONLY=true \
  -- npx -y omnisql-mcp@latest

# OpenCode v2
opencode mcp add omnisql --global --env OMNISQL_CONFIG_FILE=/absolute/path/connections.json --env OMNISQL_READ_ONLY=true \
  -- npx -y omnisql-mcp@latest
```

The installed client stores its own configuration. Restart the client session after registering.

## Claude Desktop and Cursor

Add this entry to Claude Desktop's `claude_desktop_config.json`, or Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "omnisql": {
      "command": "npx",
      "args": ["-y", "omnisql-mcp@latest"],
      "env": {
        "OMNISQL_CONFIG_FILE": "/absolute/path/connections.json",
        "OMNISQL_READ_ONLY": "true"
      }
    }
  }
}
```

On Windows, if the client cannot launch `npx` directly, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "omnisql-mcp@latest"]`.

## Standalone executable

For macOS and Linux, including machines without Node.js:

```bash
curl -fsSL https://omnisql.srthkdev.com/install.sh | bash
```

This installs under `~/.local/share/omnisql-mcp` and creates a launcher at `~/.local/bin/omnisql-mcp`. If Bun 1.4.3+ is unavailable, the installer downloads a private Bun runtime and verifies its SHA-256 checksum. It does not use sudo.

Use the printed absolute launcher path as your MCP client's command. Rerun the installer to update, or specify a version:

```bash
curl -fsSL https://omnisql.srthkdev.com/install.sh | bash -s -- 3.0.0
```

`OMNISQL_INSTALL_DIR` and `OMNISQL_BIN_DIR` let you choose other directories.

## Check the connection

Ask your assistant to call `list_connections`, then `test_connection` on a connection you intend to expose. If the connection is missing, check the [workspace settings](configuration.md). If authentication fails, check the configured credentials and database grants, then follow the [troubleshooting guide](../troubleshooting.md).

## Run with Bun

```sh
bunx --bun omnisql-mcp@latest install
```

Bun setup registers the absolute Bun executable and uses `bun x --bun --yes omnisql-mcp@latest` so GUI clients do not need a shell PATH entry for Bun. Node-based setup continues to register `npx`. The standalone curl installer uses an existing Bun 1.4.3+ runtime or downloads a private, checksum-verified one; it does not change your global runtime.
