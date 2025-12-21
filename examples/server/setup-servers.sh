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
  "mcp-exa:exa-contributor:4004"
  "mcp-coinglass:coinglass-contributor:4005"
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
  
  # Install/update dependencies
  echo "📥 Installing and updating dependencies..."
  pnpm install
  pnpm update @ctxprotocol/sdk
  
  # Stop existing process if running
  if pm2 describe "$NAME" > /dev/null 2>&1; then
    echo "🔄 Restarting $NAME..."
    pm2 delete "$NAME" && pm2 start "npx tsx server.ts" --name "$NAME"
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

# Health check all servers
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🏥 Running health checks..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

sleep 5  # Give servers time to start

for SERVER in "${SERVERS[@]}"; do
  IFS=':' read -r NAME DIR PORT <<< "$SERVER"
  
  if curl -sf "http://localhost:$PORT/health" > /dev/null; then
    echo "✅ $NAME (port $PORT) - healthy"
  else
    echo "❌ $NAME (port $PORT) - NOT responding"
  fi
done

echo ""
