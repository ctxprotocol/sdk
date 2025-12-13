#!/bin/bash

# Setup and restart all MCP servers
# Run this on the remote server after deploying with deploy.sh
# Usage: ./setup-servers.sh

set -e

echo "🚀 Setting up MCP servers..."

BASE_DIR=~/mcp-servers

# Define servers: name:directory:port
SERVERS=(
  "mcp-blocknative:blocknative-contributor:4001"
  "mcp-hyperliquid:hyperliquid-contributor:4002"
  "mcp-polymarket:polymarket-contributor:4003"
)

for SERVER in "${SERVERS[@]}"; do
  IFS=':' read -r NAME DIR PORT <<< "$SERVER"
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📦 Setting up: $NAME"
  echo "   Directory: $BASE_DIR/$DIR"
  echo "   Port: $PORT"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  cd "$BASE_DIR/$DIR"
  
  # Install dependencies
  echo "📥 Installing dependencies..."
  pnpm install
  
  # Stop existing process if running
  if pm2 describe "$NAME" > /dev/null 2>&1; then
    echo "🔄 Restarting $NAME..."
    pm2 restart "$NAME"
  else
    echo "🆕 Starting $NAME..."
    pm2 start "npx tsx server.ts" --name "$NAME"
  fi
  
  echo "✅ $NAME is running"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💾 Saving PM2 configuration..."
pm2 save

echo ""
echo "🎉 All servers setup complete!"
echo ""
pm2 status
