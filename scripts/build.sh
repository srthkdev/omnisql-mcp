#!/bin/bash

# OmniSQL MCP Build Script
# Enhanced version with production features

set -e

echo "🔨 Building OmniSQL MCP v1.1.0..."

# Clean previous build
echo "📁 Cleaning previous build..."
npm run clean

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔧 Compiling TypeScript..."
npm run build

# Set executable permissions
echo "⚡ Setting executable permissions..."
chmod +x dist/index.js

# Verify build
echo "✅ Verifying build..."
if [ -f "dist/index.js" ]; then
    echo "✅ Build successful!"
    echo "📊 Build statistics:"
    echo "   - Main executable: dist/index.js"
    echo "   - Size: $(du -h dist/index.js | cut -f1)"
    echo "   - Files generated: $(find dist -name "*.js" | wc -l) JavaScript files"
    echo ""
    echo "🚀 Ready for deployment!"
    echo "   - Global install: npm install -g ."
    echo "   - Local link: npm link"
    echo "   - Direct run: node dist/index.js"
else
    echo "❌ Build failed - dist/index.js not found"
    exit 1
fi

echo "🎉 Build completed successfully!"
