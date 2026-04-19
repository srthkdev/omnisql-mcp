# Configuration Guide

## Claude Desktop Integration

To use OmniSQL MCP with Claude Desktop, add the following to your configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### Basic Configuration
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

### Advanced Configuration
```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_DEBUG": "true",
        "OMNISQL_TIMEOUT": "60000",
        "OMNISQL_CLI_PATH": "/path/to/your/db-client/cli"
      }
    }
  }
}
```

### Read-Only Configuration
```json
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_READ_ONLY": "true",
        "OMNISQL_TIMEOUT": "30000"
      }
    }
  }
}
```

## Environment Variables

### Core Variables
- `OMNISQL_CLI_PATH`: Path to external DB client CLI binary (required only for the unsupported-driver CLI fallback)
- `OMNISQL_WORKSPACE`: Path to your local DB client workspace directory (defaults to the OS-standard location)
- `OMNISQL_TIMEOUT`: Query timeout in milliseconds (default: 30000)
- `OMNISQL_DEBUG`: Set to `true` to enable debug logging

### Security Variables
- `OMNISQL_READ_ONLY`: Set to `true` to disable all write operations (blocks `write_query`, `create_table`, `alter_table`, `drop_table`)
- `OMNISQL_DISABLED_TOOLS`: Comma-separated list of tool names to disable (e.g., `drop_table,alter_table`)

### Configuration Examples
```bash
# Development with debug logging
export OMNISQL_DEBUG=true
export OMNISQL_TIMEOUT=60000
omnisql-mcp

# Production with custom timeout
export OMNISQL_DEBUG=false
export OMNISQL_TIMEOUT=120000
omnisql-mcp

# Read-only mode (disable all write operations)
export OMNISQL_READ_ONLY=true
omnisql-mcp

# Disable specific tools
export OMNISQL_DISABLED_TOOLS="drop_table,alter_table"
omnisql-mcp
```

## Cursor IDE Integration

For Cursor IDE, add to your settings:

```json
{
  "mcp.servers": {
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

## Advanced MCP Client Configuration

### Command Line Usage
```bash
# Basic usage
omnisql-mcp

# With environment variables
OMNISQL_DEBUG=true omnisql-mcp

# Test MCP server
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | omnisql-mcp
```

### Docker Configuration
```dockerfile
FROM node:18-alpine
RUN npm install -g omnisql-mcp
ENV OMNISQL_DEBUG=false
ENV OMNISQL_TIMEOUT=30000
CMD ["omnisql-mcp"]
```

## Troubleshooting Configuration

### Common Issues
1. **CLI fallback fails**: Set `OMNISQL_CLI_PATH` to your DB client CLI binary
2. **Timeout errors**: Increase `OMNISQL_TIMEOUT` value
3. **Debug information needed**: Set `OMNISQL_DEBUG=true`

### Verification Commands
```bash
# Test MCP server
omnisql-mcp --help

# Check environment variables
echo $OMNISQL_CLI_PATH
echo $OMNISQL_DEBUG
echo $OMNISQL_TIMEOUT
```
