# Installation Guide

## System Requirements

- **Node.js**: Version 18.0.0 or higher
- **A local DB client** (DBeaver-compatible) with at least one saved connection
- **Operating System**: Windows 10+, macOS 10.15+, or Linux (Ubuntu 18.04+)

## Pre-Installation Steps

### 1. Configure Workspace Connections
- Open your local DB client
- Create and test at least one database connection
- Ensure connections are saved with credentials

## Installation Methods

### Method 1: Global npm Installation (Recommended)
```bash
# Install from npm registry
npm install -g omnisql-mcp

# Verify installation
omnisql-mcp --help
```

### Method 2: Local Development Installation
```bash
git clone https://github.com/srthkdev/omnisql-mcp.git
cd omnisql-mcp
npm install
npm run build
npm link  # Makes the command available globally
```

### Method 3: Direct Download
- Download the latest release from GitHub
- Extract to desired directory
- Run `npm install` in the extracted directory
- Add the directory to your PATH

## Post-Installation Configuration

### Claude Desktop Setup

Locate Config File:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add MCP Server Configuration:
```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_DEBUG": "false",
        "OMNISQL_TIMEOUT": "30000"
      }
    }
  }
}
```

Restart Claude Desktop.

## Verification
Test the installation:
```bash
# Test help command
omnisql-mcp --help

# Test MCP server functionality
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | omnisql-mcp
# Should return available tools
```

## Platform-Specific Notes

### Windows
- Use PowerShell or Command Prompt as Administrator for global installation
- To enable the unsupported-driver CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

### macOS
- Use Homebrew for Node.js installation: `brew install node`
- To enable the unsupported-driver CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

### Linux
- Install via package manager: `sudo apt install nodejs npm` (Ubuntu/Debian)
- To enable the unsupported-driver CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

## Environment Variables

Configure the server behavior with these environment variables:

- `OMNISQL_CLI_PATH`: Path to external DB client CLI (for unsupported-driver fallback)
- `OMNISQL_WORKSPACE`: Path to local DB client workspace directory
- `OMNISQL_TIMEOUT`: Query timeout in milliseconds (default: 30000)
- `OMNISQL_DEBUG`: Enable debug logging (true/false)

Example:
```bash
export OMNISQL_DEBUG=true
export OMNISQL_TIMEOUT=60000
omnisql-mcp
```

## Troubleshooting Installation

### Common Issues

- "omnisql-mcp command not found"
  - Ensure npm global bin directory is in PATH
  - Try `npm config get prefix` to find global directory
  - Add `[prefix]/bin` to PATH
- Permission errors on Linux/macOS
  - `sudo chown -R $(whoami) ~/.npm`
- Node.js version issues
  - Use nvm to manage Node.js versions
  - Install recommended version: `nvm install 18 && nvm use 18`
- Binary execution issues
  - Ensure the package was installed correctly: `npm install -g omnisql-mcp@latest`
  - Check if the binary has execute permissions

## Getting Help
- Check the [Troubleshooting Guide](../troubleshooting.md)
- Open an issue on [GitHub](https://github.com/srthkdev/omnisql-mcp/issues)
- View the package on [npm](https://www.npmjs.com/package/omnisql-mcp)
