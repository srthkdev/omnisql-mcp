# Installation Guide

## Requirements

- Node.js 18+ with npm, and Claude Code, Codex, or OpenCode installed
- DBeaver-compatible workspace with saved, tested database connections

## Guided setup

```bash
npx -y omnisql-mcp@latest install
```

Choose a client, your workspace directory, read-only or read/write access, and an optional connection allowlist. The installer registers OmniSQL in the selected client for your user account. It reuses saved database and SSH credentials. Start a new client session after setup.

For direct setup:

```bash
npx -y omnisql-mcp@latest install claude
npx -y omnisql-mcp@latest install codex
npx -y omnisql-mcp@latest install opencode
```

Add `--read-only` to disable writes. Add `--dry-run` to preview the native registration command without changing configuration. Direct setup uses the default workspace; use the guided setup for a custom path.

## Native registration

```bash
claude mcp add --transport stdio --scope user omnisql -- npx -y omnisql-mcp@latest
codex mcp add omnisql -- npx -y omnisql-mcp@latest
opencode mcp add omnisql --global -- npx -y omnisql-mcp@latest
```

The OpenCode command requires v2. See the [configuration guide](./configuration.md) for Claude Desktop, Cursor, and manual setup.

## Standalone executable (macOS / Linux)

```bash
curl -fsSL https://srthkdev.github.io/omnisql-mcp/install.sh | bash
```

Installs without sudo to `~/.local/share/omnisql-mcp` and creates `~/.local/bin/omnisql-mcp`. If Node.js or npm is missing, the installer downloads a private Node.js 22 runtime and verifies its SHA-256 checksum. Use the printed absolute launcher path as the command in your MCP client.

Rerun to upgrade, or pin a version:

```bash
curl -fsSL https://srthkdev.github.io/omnisql-mcp/install.sh | bash -s -- 2.2.0
```

Set `OMNISQL_INSTALL_DIR` and `OMNISQL_BIN_DIR` to choose other directories.

## Development

```bash
git clone https://github.com/srthkdev/omnisql-mcp.git
cd omnisql-mcp
npm ci
npm run build
node dist/index.js --help
```
