#!/bin/bash

# This script uploads the MCP server examples to the deployment server
# Usage: ./deploy.sh

echo "🚀 Starting deployment to Hostinger KVM2..."

# --- Configuration ---
SERVER_USER_HOST="ubuntu@62.72.22.174"
REMOTE_BASE_DIR="~/mcp-servers"

# --- Dynamic Path Detection ---
# Assumes this script is inside /examples/server/
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Define the project directories to deploy
PROJECTS=("blocknative-contributor" "hyperliquid-contributor" "polymarket-contributor")

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

# --- Upload setup script ---
echo "--------------------------------------------------"
echo "📜 Uploading setup-servers.sh..."
rsync -avz \
  "${SCRIPT_DIR}/setup-servers.sh" \
  "${SERVER_USER_HOST}:${REMOTE_BASE_DIR}/setup-servers.sh"

# Make it executable on the remote server
ssh "${SERVER_USER_HOST}" "chmod +x ${REMOTE_BASE_DIR}/setup-servers.sh"
echo "✅ setup-servers.sh uploaded and made executable."

echo "--------------------------------------------------"
echo "🎉 All files uploaded successfully!"
echo ""
echo "   Next steps:"
echo "   1. SSH into server: ssh ${SERVER_USER_HOST}"
echo "   2. Run: cd ~/mcp-servers && ./setup-servers.sh"
echo ""
echo "   Or run directly:"
echo "   ssh ${SERVER_USER_HOST} 'cd ~/mcp-servers && ./setup-servers.sh'"