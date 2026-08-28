<#
.SYNOPSIS
    Creates the Entra ID (Azure AD) app registration for the Intune MCP Write Server.

.DESCRIPTION
    Registers a public client application in Entra ID with delegated Microsoft
    Graph permissions required by the Intune MCP Write server:
      - DeviceManagementManagedDevices.ReadWrite.All
      - Device.Read.All
      - GroupMember.ReadWrite.All
      - Directory.Read.All

    Enables "Allow public client flows" for device code authentication,
    creates a service principal, and grants tenant-wide admin consent.

    Requires: Azure CLI (az) signed in with an account that can register
    applications and grant admin consent (typically Global Admin or
    Application Administrator + Intune Administrator).

.PARAMETER DisplayName
    Display name for the app registration. Default: "Intune MCP Write Server"

.PARAMETER TenantId
    Override the tenant ID. Defaults to the current Azure CLI tenant.

.PARAMETER WriteEnv
    Write the .env file to the project root with the new Client ID and Tenant ID.

.EXAMPLE
    .\register-app.ps1
    .\register-app.ps1 -DisplayName "Intune MCP Write - Dev" -WriteEnv
#>

param(
    [string]$DisplayName = "Intune MCP Write Server",
    [string]$TenantId,
    [switch]$WriteEnv
)

$ErrorActionPreference = "Stop"

# --- Preflight checks ---

try { $null = Get-Command az -ErrorAction Stop }
catch {
    Write-Error "Azure CLI (az) is required. Install from https://aka.ms/installazurecli"
    return
}

$acct = az account show 2>$null | ConvertFrom-Json
if (-not $acct) {
    Write-Host "Not signed in to Azure CLI. Running 'az login'..." -ForegroundColor Yellow
    az login | Out-Null
    $acct = az account show | ConvertFrom-Json
}

$tenantId = if ($TenantId) { $TenantId } else { $acct.tenantId }
Write-Host "Tenant:  $tenantId" -ForegroundColor Cyan
Write-Host "Account: $($acct.user.name)" -ForegroundColor Cyan
Write-Host ""

# --- Look up delegated permission IDs from the Graph service principal ---

$graphResourceId = "00000003-0000-0000-c000-000000000000"

Write-Host "Resolving Microsoft Graph permission IDs..." -ForegroundColor Gray
$graphSp = az ad sp show --id $graphResourceId 2>$null | ConvertFrom-Json
if (-not $graphSp) {
    Write-Error "Could not find the Microsoft Graph service principal. Ensure you are signed in to the correct tenant."
    return
}

$permissionNames = @(
    "DeviceManagementManagedDevices.ReadWrite.All"
    "Device.Read.All"
    "GroupMember.ReadWrite.All"
    "Directory.Read.All"
)

$resolvedPerms = @()
foreach ($name in $permissionNames) {
    $scope = $graphSp.oauth2PermissionScopes | Where-Object { $_.value -eq $name }
    if (-not $scope) {
        Write-Error "Permission '$name' not found on the Microsoft Graph service principal."
        return
    }
    $resolvedPerms += @{ id = $scope.id; type = "Scope" }
    Write-Host "  $name = $($scope.id)" -ForegroundColor DarkGray
}

# --- Build required-resource-accesses manifest and write to temp file ---
# Using a temp file avoids PowerShell/az CLI JSON quoting issues on Windows.

$manifest = @(
    @{
        resourceAppId  = $graphResourceId
        resourceAccess = $resolvedPerms
    }
)
$manifestJson = $manifest | ConvertTo-Json -Depth 4 -Compress
$tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "intune-mcp-write-manifest-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"
$manifestJson | Set-Content -Path $tempFile -Encoding UTF8

try {
    # --- Create the app registration ---

    Write-Host ""
    Write-Host "Creating app registration '$DisplayName'..." -ForegroundColor Yellow

    $appJson = az ad app create `
        --display-name $DisplayName `
        --is-fallback-public-client true `
        --sign-in-audience "AzureADMyOrg" `
        --required-resource-accesses "@$tempFile"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to create app registration."
        return
    }

    $app = $appJson | ConvertFrom-Json
    $clientId = $app.appId
    Write-Host "App registered. Client ID: $clientId" -ForegroundColor Green

    # --- Create service principal (required for admin consent) ---

    Write-Host "Creating service principal..." -ForegroundColor Yellow
    az ad sp create --id $clientId 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Service principal may already exist (non-fatal)."
    }

    # Brief pause — the service principal must propagate before admin consent will succeed.
    Write-Host "Waiting for service principal propagation (15s)..." -ForegroundColor Gray
    Start-Sleep -Seconds 15

    # --- Grant admin consent ---

    Write-Host "Granting admin consent for delegated permissions..." -ForegroundColor Yellow
    az ad app permission admin-consent --id $clientId
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Admin consent grant failed. You may need to grant consent manually in the Azure portal:"
        Write-Warning "  Entra ID > App registrations > $DisplayName > API permissions > Grant admin consent"
    } else {
        Write-Host "Admin consent granted." -ForegroundColor Green
    }

}
finally {
    Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
}

# --- Output ---

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " App Registration Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Display Name:  $DisplayName"
Write-Host "  Client ID:     $clientId"
Write-Host "  Tenant ID:     $tenantId"
Write-Host "  Public Client:  Enabled (device code flow)"
Write-Host "  Sign-in:       Single tenant (AzureADMyOrg)"
Write-Host ""
Write-Host "Delegated Permissions (admin-consented):"
foreach ($name in $permissionNames) {
    Write-Host "  - $name"
}
Write-Host ""

# --- Optionally write .env ---

$projectRoot = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $projectRoot ".env"

if ($WriteEnv) {
    @"
# Intune MCP Write Server — Entra ID App Registration
# Created by register-app.ps1 on $(Get-Date -Format 'yyyy-MM-dd')
AZURE_CLIENT_ID=$clientId
AZURE_TENANT_ID=$tenantId
"@ | Set-Content -Path $envPath -Encoding UTF8

    Write-Host ".env written to: $envPath" -ForegroundColor Green
}
else {
    Write-Host "To configure the server, create .env at the project root:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  AZURE_CLIENT_ID=$clientId"
    Write-Host "  AZURE_TENANT_ID=$tenantId"
    Write-Host ""
    Write-Host "Or re-run with -WriteEnv to write it automatically."
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run 'npm run auth' from the project root to sign in via device code."
Write-Host "  2. Run 'npm start' to start the MCP server (stdio) or 'npm run start:http' for HTTP."
