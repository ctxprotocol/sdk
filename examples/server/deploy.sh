#!/bin/bash

# This script uploads the Blocknative and Hyperliquid MCP servers
# Usage: ./deploy.sh

echo "🚀 Starting deployment to Hostinger KVM2..."

# --- Configuration ---
SERVER_USER_HOST="ubuntu@62.72.22.174"
REMOTE_BASE_DIR="~/mcp-servers"

# --- Dynamic Path Detection ---
# Assumes this script is inside /examples/server/
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Define the two project directories
PROJECTS=("blocknative-contributor" "hyperliquid-contributor")

for PROJECT in "${PROJECTS[@]}"; do
    SOURCE_DIR="${SCRIPT_DIR}/${PROJECT}"
    
    echo "--------------------------------------------------"
    echo "📂 Deploying: ${PROJECT}"
    echo "   Source: ${SOURCE_DIR}"
    echo "   Target: ${SERVER_USER_HOST}:${REMOTE_BASE_DIR}/${PROJECT}"

    # --- rsync Deployment ---
    rsync -avz \
      --exclude=".git/" \
      --exclude=".vscode/" \
      --exclude=".DS_Store" \
      --exclude="node_modules/" \
      --exclude="dist/" \
      --exclude="*.log" \
      --exclude=".env" \
      --exclude=".env.local" \
      --exclude="test-scenario.ts" \
      "${SOURCE_DIR}/" \
      "${SERVER_USER_HOST}:${REMOTE_BASE_DIR}/${PROJECT}/"
      
    echo "✅ ${PROJECT} synced."
done

echo "--------------------------------------------------"
echo "🎉 All files uploaded successfully!"
echo "   Next steps:"
echo "   1. SSH into server"
echo "   2. Go to ~/mcp-servers/<project>"
echo "   3. Run 'pnpm install'"
echo "   4. Create .env files"
echo "   5. Start with PM2"