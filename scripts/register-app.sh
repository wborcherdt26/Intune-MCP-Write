#!/usr/bin/env bash
#
# Creates the Entra ID (Azure AD) app registration for the Intune MCP Write Server.
#
# Registers a public client application with delegated Microsoft Graph
# permissions and grants tenant-wide admin consent.
#
# Requires: Azure CLI (az) signed in with Application Administrator (or Global
# Admin) + sufficient Intune admin role.
#
# Usage:
#   ./scripts/register-app.sh                           # interactive — prints values
#   ./scripts/register-app.sh --write-env               # also writes .env
#   ./scripts/register-app.sh --display-name "My App"   # custom name
#
set -euo pipefail

DISPLAY_NAME="Intune MCP Write Server"
WRITE_ENV=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --write-env)    WRITE_ENV=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--display-name NAME] [--write-env]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────
step()  { printf '\n\033[33m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m%s\033[0m\n' "$1"; }
err()   { printf '  \033[31m%s\033[0m\n' "$1"; exit 1; }

# ── Preflight checks ────────────────────────────────────────────────
if ! command -v az &>/dev/null; then
  err "Azure CLI (az) is required. Install from https://aka.ms/installazurecli"
fi

if ! az account show &>/dev/null; then
  echo "Not signed in to Azure CLI. Running 'az login'..."
  az login >/dev/null
fi

TENANT_ID=$(az account show --query tenantId -o tsv)
ACCOUNT=$(az account show --query user.name -o tsv)
printf '\033[36mTenant:  %s\033[0m\n' "$TENANT_ID"
printf '\033[36mAccount: %s\033[0m\n' "$ACCOUNT"
echo ""

# ── Resolve delegated permission GUIDs ───────────────────────────────
GRAPH_RESOURCE_ID="00000003-0000-0000-c000-000000000000"
PERMISSIONS=(
  "DeviceManagementManagedDevices.ReadWrite.All"
  "Device.Read.All"
  "GroupMember.ReadWrite.All"
  "Directory.Read.All"
)

echo "Resolving Microsoft Graph permission IDs..."

RESOURCE_ACCESS="["
FIRST=true
for PERM_NAME in "${PERMISSIONS[@]}"; do
  PERM_ID=$(az ad sp show --id "$GRAPH_RESOURCE_ID" \
    --query "oauth2PermissionScopes[?value=='$PERM_NAME'].id" -o tsv)
  if [ -z "$PERM_ID" ]; then
    err "Permission '$PERM_NAME' not found on the Microsoft Graph service principal."
  fi
  printf '  %s = %s\n' "$PERM_NAME" "$PERM_ID"
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    RESOURCE_ACCESS+=","
  fi
  RESOURCE_ACCESS+="{\"id\":\"$PERM_ID\",\"type\":\"Scope\"}"
done
RESOURCE_ACCESS+="]"

# ── Write manifest to temp file ──────────────────────────────────────
MANIFEST="[{\"resourceAppId\":\"$GRAPH_RESOURCE_ID\",\"resourceAccess\":$RESOURCE_ACCESS}]"
TEMP_FILE=$(mktemp)
echo "$MANIFEST" > "$TEMP_FILE"

cleanup() { rm -f "$TEMP_FILE"; }
trap cleanup EXIT

# ── Create the app registration ──────────────────────────────────────
step "Creating app registration '$DISPLAY_NAME'..."

APP_JSON=$(az ad app create \
  --display-name "$DISPLAY_NAME" \
  --is-fallback-public-client true \
  --sign-in-audience "AzureADMyOrg" \
  --required-resource-accesses "@$TEMP_FILE")

CLIENT_ID=$(echo "$APP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['appId'])" 2>/dev/null \
  || echo "$APP_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).appId))")
ok "App registered. Client ID: $CLIENT_ID"

# ── Create service principal ─────────────────────────────────────────
step "Creating service principal..."
az ad sp create --id "$CLIENT_ID" >/dev/null 2>&1 || echo "  (may already exist — non-fatal)"

echo "  Waiting for service principal propagation (15s)..."
sleep 15

# ── Grant admin consent ──────────────────────────────────────────────
step "Granting admin consent for delegated permissions..."
if az ad app permission admin-consent --id "$CLIENT_ID" 2>/dev/null; then
  ok "Admin consent granted."
else
  printf '  \033[33mAdmin consent grant failed. Grant manually in the Azure portal:\n'
  printf '  Entra ID > App registrations > %s > API permissions > Grant admin consent\033[0m\n' "$DISPLAY_NAME"
fi

# ── Output ───────────────────────────────────────────────────────────
echo ""
printf '\033[36m========================================\033[0m\n'
printf '\033[36m App Registration Complete\033[0m\n'
printf '\033[36m========================================\033[0m\n'
echo "  Display Name:   $DISPLAY_NAME"
echo "  Client ID:      $CLIENT_ID"
echo "  Tenant ID:      $TENANT_ID"
echo "  Public Client:  Enabled (device code flow)"
echo "  Sign-in:        Single tenant (AzureADMyOrg)"
echo ""
echo "Delegated Permissions (admin-consented):"
for PERM_NAME in "${PERMISSIONS[@]}"; do
  echo "  - $PERM_NAME"
done
echo ""

# ── Optionally write .env ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_PATH="$PROJECT_ROOT/.env"

if [ "$WRITE_ENV" = true ]; then
  cat > "$ENV_PATH" <<EOL
# Intune MCP Write Server — Entra ID App Registration
# Created by register-app.sh on $(date +%Y-%m-%d)
AZURE_CLIENT_ID=$CLIENT_ID
AZURE_TENANT_ID=$TENANT_ID
EOL
  ok ".env written to: $ENV_PATH"
else
  printf '\033[33mTo configure the server, create .env at the project root:\033[0m\n'
  echo ""
  echo "  AZURE_CLIENT_ID=$CLIENT_ID"
  echo "  AZURE_TENANT_ID=$TENANT_ID"
  echo ""
  echo "Or re-run with --write-env to write it automatically."
fi

echo ""
printf '\033[33mNext steps:\033[0m\n'
echo "  1. Run 'npm run auth' from the project root to sign in via device code."
echo "  2. Run 'npm start' to start the MCP server (stdio) or 'npm run start:http' for HTTP."
