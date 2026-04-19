#!/bin/bash

# OmniSQL MCP Publish Script
# This script helps with publishing new versions to npm

set -e

echo "🚀 OmniSQL MCP - Publishing to npm"
echo "=========================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the project root."
    exit 1
fi

# Check if git is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ Error: Git working directory is not clean. Please commit all changes first."
    echo "Current status:"
    git status --short
    exit 1
fi

# Check if logged into npm
if ! npm whoami > /dev/null 2>&1; then
    echo "❌ Error: Not logged into npm. Please run 'npm login' first."
    exit 1
fi

echo "✅ Git working directory is clean"
echo "✅ Logged into npm as: $(npm whoami)"

# Determine version type
if [ "$1" = "major" ]; then
    VERSION_TYPE="major"
    echo "📦 Publishing MAJOR version"
elif [ "$1" = "minor" ]; then
    VERSION_TYPE="minor"
    echo "📦 Publishing MINOR version"
else
    VERSION_TYPE="patch"
    echo "📦 Publishing PATCH version"
fi

# Build and publish
echo "🔨 Building project..."
npm run build

echo "📤 Publishing to npm..."
# Use the direct npm publish command instead of the npm run publish script to avoid recursion
if [ "$VERSION_TYPE" = "major" ]; then
    npm version major && npm publish
elif [ "$VERSION_TYPE" = "minor" ]; then
    npm version minor && npm publish
else
    npm version patch && npm publish
fi

echo ""
echo "🎉 Successfully published omnisql-mcp!"
echo "📋 Package info:"
npm info omnisql-mcp version
echo ""
echo "🔗 Install with: npm install -g omnisql-mcp@latest"
echo "🌐 View on npm: https://www.npmjs.com/package/omnisql-mcp"