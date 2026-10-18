# Install & connect

You need Bun 1.4.3 or newer, or Node.js 22.15 or newer with npm, an MCP client, and either an instance configuration file or a DBeaver-compatible workspace with saved, working connections. The standalone installer uses Bun; npm/npx setups use Node.

## Guided setup

```bash
npx -y omnisql-mcp@latest install
```

The installer asks you to:

1. Select Claude Code, Codex, or OpenCode. Installed clients are marked as detected.
2. Choose read-only or read/write access. Read-only is the default in this flow.
3. Confirm your workspace directory.
4. Optionally restrict access to specific connection IDs or names.

It then calls the selected client's own MCP registration command. Database and SSH credentials come from your saved workspace. OmniSQL does not need a separate token.

Start a new session in your client and ask it to list your database connections.

## Set up one client directly

These commands register OmniSQL with read-only access and the default workspace:

```bash
npx -y omnisql-mcp@latest install claude --read-only
npx -y omnisql-mcp@latest install codex --read-only
npx -y omnisql-mcp@latest install opencode --read-only
```

The OpenCode installer uses the v2 CLI. Older OpenCode versions can use a manual local MCP configuration.

Append `--dry-run` to inspect the registration command without changing your client settings. Direct setup does not open the workspace-selection prompts. Omitting `--read-only` in direct setup uses the server's normal read/write configuration.

## Native registration commands

If you prefer your client's own CLI:

```bash
# Claude Code — user scope, across projects
claude mcp add --transport stdio --scope user omnisql \
  --env OMNISQL_READ_ONLY=true -- npx -y omnisql-mcp@latest

# Codex
codex mcp add omnisql --env OMNISQL_READ_ONLY=true \
  -- npx -y omnisql-mcp@latest

# OpenCode v2
opencode mcp add omnisql --global --env OMNISQL_READ_ONLY=true \
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
curl -fsSL https://srthkdev.github.io/omnisql-mcp/install.sh | bash
```

This installs under `~/.local/share/omnisql-mcp` and creates a launcher at `~/.local/bin/omnisql-mcp`. If Bun 1.4.3+ is unavailable, the installer downloads a private Bun runtime and verifies its SHA-256 checksum. It does not use sudo.

Use the printed absolute launcher path as your MCP client's command. Rerun the installer to update, or specify a version:

```bash
curl -fsSL https://srthkdev.github.io/omnisql-mcp/install.sh | bash -s -- 2.2.0
```

`OMNISQL_INSTALL_DIR` and `OMNISQL_BIN_DIR` let you choose other directories.

## Check the connection

Ask your assistant to call `list_connections`, then `test_connection` on a connection you intend to expose. If the connection is missing, check the [workspace settings](configuration.md). If authentication fails, test it in DBeaver first and follow the [troubleshooting guide](../troubleshooting.md).

## Run with Bun

```sh
bunx --bun omnisql-mcp@latest install
```

Bun setup registers the absolute Bun executable and uses `bun x --bun --yes omnisql-mcp@latest` so GUI clients do not need a shell PATH entry for Bun. Node-based setup continues to register `npx`. The standalone curl installer uses an existing Bun 1.4.3+ runtime or downloads a private, checksum-verified one; it does not change your global runtime.
