#!/usr/bin/env bash
# Import + publish a workflow JSON into a local n8n (n8n must be STOPPED; start it afterwards).
#   N8N_HOME=/c/Aman/n8n-runtime bash scripts/n8n_deploy.sh workflow/kesar_support_copilot.json
set -euo pipefail
WF="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
N8N_HOME="${N8N_HOME:-/c/Aman/n8n-runtime}"
export N8N_USER_FOLDER="$N8N_HOME/data" N8N_DIAGNOSTICS_ENABLED=false
cd "$N8N_HOME"
ID=$(node -e "console.log(require(process.argv[1]).id)" "$WF")
npx n8n import:workflow --input="$WF" 2>&1 | grep -v license
npx n8n publish:workflow --id="$ID" 2>&1 | grep -v -E "license|role scopes|applies"
echo "published $ID"
