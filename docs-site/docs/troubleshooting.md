# Troubleshooting Guide

## Installation Issues

### "omnisql-mcp command not found"
```bash
# Solution 1: Reinstall the package
npm uninstall -g omnisql-mcp
npm install -g omnisql-mcp@latest

# Solution 2: Check npm global path
npm config get prefix
# Add the bin directory to your PATH

# Solution 3: Use npx
npx omnisql-mcp --help
```

### Permission Errors
```bash
# Linux/macOS permission fix
sudo chown -R $(whoami) ~/.npm
npm install -g omnisql-mcp

# Windows: Run as Administrator
# Open PowerShell as Administrator and run:
npm install -g omnisql-mcp
```

### Node.js Version Issues
```bash
# Check Node.js version
node --version  # Should be >= 18.0.0

# Update Node.js using nvm
nvm install 18
nvm use 18
npm install -g omnisql-mcp
```

## Connection Issues

### Workspace Configuration Issues
- Ensure your DB client has been run at least once so the workspace config exists
- Verify connections work in the DB client GUI
- Check file permissions on the workspace config directory
- Restart your DB client after making configuration changes

### Connection Authentication

#### Password Authentication Issues

**How it works:**
- The DB client (DBeaver-compatible) stores passwords encrypted in `credentials-config.json`
- The MCP server automatically decrypts and uses these credentials
- Passwords are loaded from: `~/.local/share/DBeaverData/workspace6/General/.dbeaver/credentials-config.json` (Linux) or equivalent path on other platforms

**Troubleshooting:**
1. Ensure your connections are saved with passwords in the DB client
2. Test connections in the DB client GUI first to verify they work
3. The MCP server will automatically detect and use stored credentials
4. Enable debug mode to see credential loading logs:
   ```bash
   OMNISQL_DEBUG=true omnisql-mcp
   ```

**Common Issues:**
- **Empty password field**: Make sure you saved the password in the DB client (check "Save password" when creating the connection)
- **SSL/TLS requirements**: The server handles SSL settings from the workspace config
- **Connection properties**: Host, port, and database name are loaded from the workspace config

**Manual credential check:**
```bash
# On Linux/macOS - view decrypted credentials
openssl aes-128-cbc -d \
  -K babb4a9f774ab853c96c2d653dfe544a \
  -iv 00000000000000000000000000000000 \
  -in ~/.local/share/DBeaverData/workspace6/General/.dbeaver/credentials-config.json | \
  dd bs=1 skip=16 2>/dev/null | jq
```

- Verify connection credentials haven't expired
- Check if the database server is accessible
- Ensure firewall settings allow database connections

## Query Execution Issues

### Query Syntax Errors
- Test queries directly in your DB client first
- Verify query syntax for your specific database type
- Check for database-specific SQL dialects

### Timeout Issues
```bash
# Increase timeout
export OMNISQL_TIMEOUT=120000
omnisql-mcp

# Or in Claude Desktop config
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_TIMEOUT": "120000"
      }
    }
  }
}
```

### Large Result Sets
- Use LIMIT clauses for large queries
- Consider pagination for large datasets
- Enable debug mode to monitor query performance

## Platform-Specific Issues

### Windows
- Use PowerShell as Administrator for global installation
- Check Windows Defender firewall settings
- To use the CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

### macOS
- Check System Preferences > Security & Privacy > Privacy > Full Disk Access
- Use Homebrew for Node.js: `brew install node`
- To use the CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

### Linux
- Ensure execute permissions: `chmod +x omnisql-mcp`
- Install via package manager: `sudo apt install nodejs npm` (Ubuntu/Debian)
- To use the CLI fallback, set `OMNISQL_CLI_PATH` to your DB client CLI binary

## MCP Client Issues

### Claude Desktop
- Restart Claude Desktop after configuration changes
- Check config file syntax (valid JSON)
- Verify the command path is correct
- Enable debug mode for troubleshooting

### Cursor IDE
- Check MCP server configuration in settings
- Restart Cursor after configuration changes
- Verify the server is running and accessible

## Debugging

### Enable Debug Mode
```bash
# Command line
OMNISQL_DEBUG=true omnisql-mcp

# Claude Desktop config
{
  "mcpServers": {
    "omnisql": {
      "command": "omnisql-mcp",
      "env": {
        "OMNISQL_DEBUG": "true"
      }
    }
  }
}
```

### Check Logs
- Look for error messages and stack traces
- Monitor query execution times
- Check for connection failures
- Verify MCP protocol communication

### Test MCP Server
```bash
# Test basic functionality
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | omnisql-mcp

# Test tools list
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | omnisql-mcp
```

## Performance Issues

### Slow Query Execution
- Check database server performance
- Optimize query syntax
- Use appropriate indexes
- Consider query timeout settings

### Memory Usage
- Monitor Node.js memory usage
- Close unused database connections
- Restart the MCP server periodically

## Getting Help

### Before Asking for Help
1. Check this troubleshooting guide
2. Enable debug mode and check logs
3. Test with a simple query in your DB client
4. Verify your Node.js version

### Resources
- [Installation Guide](getting-started/installation.md)
- [Configuration Guide](getting-started/configuration.md)
- [GitHub Issues](https://github.com/srthkdev/omnisql-mcp/issues)
- [NPM Package](https://www.npmjs.com/package/omnisql-mcp)

### Reporting Issues
When reporting issues, please include:
- Operating system and version
- Node.js version (`node --version`)
- Error messages and logs
- Steps to reproduce the issue
- Expected vs actual behavior
