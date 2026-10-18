import fs from 'node:fs';
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .version as string;
// Handle CLI arguments
if (process.argv[2] === 'install') {
  try {
    const { runInstall } = await import('./install.js');
    await runInstall(process.argv.slice(3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error(`
OmniSQL MCP Server v${VERSION}

Usage: omnisql-mcp [options]
       omnisql-mcp install [claude|codex|opencode] [--read-only] [--dry-run]

Quick setup:
  npx -y omnisql-mcp@latest install
  npx -y omnisql-mcp@latest install claude
  npx -y omnisql-mcp@latest install codex
  npx -y omnisql-mcp@latest install opencode

Options:
  -h, --help     Show this help message
  --version      Show version information
  --debug        Enable debug logging

Environment Variables:
  OMNISQL_CONFIG_FILE          JSON file containing database instances and their settings
  OMNISQL_POLICY_FILE          Additional operator access rules
  OMNISQL_WORKSPACE            Path to local DB client workspace directory
  OMNISQL_PROJECT              Read only this workspace project (default: all projects)
  OMNISQL_TIMEOUT              Query timeout in milliseconds (default: 30000)
  OMNISQL_DEBUG                Enable debug logging (true/false)
  OMNISQL_UPDATE_NOTIFIER      Check npm for updates (default: true; set false to disable)
  OMNISQL_READ_ONLY            Disable all write operations (true/false)
  OMNISQL_ALLOWED_CONNECTIONS  Comma-separated whitelist of connection IDs or names
  OMNISQL_DISABLED_TOOLS       Comma-separated list of tools to disable
  OMNISQL_SSH_KNOWN_HOSTS      known_hosts used to verify SSH tunnel hosts (default: ~/.ssh/known_hosts)
  OMNISQL_SSH_STRICT_HOST_KEY  Refuse SSH tunnel hosts with no known_hosts entry (true/false)

Features:
  - Universal database support via your local DB client's saved connections
  - SSH tunnels and URL-mode connections honoured as the DB client configures them
  - Read and write operations with safety checks
  - Schema introspection and table management
  - Data export in multiple formats
  - Business insights tracking
  - Resource-based schema browsing

For more information, visit: https://github.com/srthkdev/omnisql-mcp
`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.error(VERSION);
  process.exit(0);
}

try {
  const { startServer } = await import('./server.js');
  await startServer();
} catch (error) {
  console.error('Server startup failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
