---
sidebar_position: 1
---

# Introduction

OmniSQL MCP is a Model Context Protocol server that connects AI assistants to your databases using connections already configured in your local DB client workspace (DBeaver-compatible).

## Why Use This?

- **No extra config**: Uses connections you've already set up in your local DB client
- **Wide database support**: Works with any database reachable via standard wire protocols
- **Native drivers**: Direct execution for PostgreSQL, MySQL, SQLite, SQL Server
- **Safety built-in**: Query validation, confirmation prompts for destructive ops

## What It Does

- Lists and tests workspace connections
- Executes SELECT, INSERT, UPDATE, DELETE queries
- Manages schema (CREATE/ALTER/DROP tables)
- Exports data to CSV/JSON
- Stores analysis notes for later reference

## Supported Databases

Native execution (fast, no external CLI required):
- PostgreSQL
- MySQL / MariaDB
- SQLite
- SQL Server / MSSQL

Fallback via external CLI (configured with `OMNISQL_CLI_PATH`):
- Oracle, MongoDB, and other drivers not natively supported

## Workspace Format Support

Supports both configuration formats written by DBeaver-compatible DB clients:
- Legacy: XML config format
- Modern: JSON config format

The server auto-detects which format you're using.
