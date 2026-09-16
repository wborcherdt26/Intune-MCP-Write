# intune-mcp-write

MCP server providing read-write access to Microsoft Intune device properties and group memberships via the Microsoft Graph API. Allows Claude (or any MCP client) to manage devices, update properties, trigger syncs, and modify group membership.

## Prerequisites

- Node.js >= 18
- An Azure AD (Entra ID) app registration with delegated permissions

## Setup

### 1. Register the Azure AD App

Create a public client app in Entra ID with these delegated permissions:

- `DeviceManagementManagedDevices.ReadWrite.All`
- `DeviceManagementManagedDevices.PrivilegedOperations.All`
- `Device.Read.All`
- `GroupMember.ReadWrite.All`
- `Directory.Read.All`
- `User.Read.All`

Grant admin consent for all permissions.

> **Warning:** `PrivilegedOperations.All` grants the ability to remotely wipe, retire, restart, and lock any managed device the authenticated user has Intune RBAC access to. Use Intune scope tags to limit which devices can be acted on.

Then create `.env`:
```
AZURE_CLIENT_ID=<your-app-client-id>
AZURE_TENANT_ID=<your-tenant-id>
```

To enable destructive actions (retire, wipe), also set:
```
ENABLE_DESTRUCTIVE_ACTIONS=true
```

### 2. Install and Build

```bash
npm install
npm run build
```

### 3. Authenticate

```bash
npm run auth
```

Follow the device code prompt to sign in with your Microsoft account.

### 4. Run

**Stdio mode** (for MCP clients like Claude Desktop):
```bash
npm start
```

**HTTP mode** (for web-based MCP clients):
```bash
npm run start:http
```

### 5. Claude Desktop Configuration

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "intune-mcp-write": {
      "command": "node",
      "args": ["F:/Repositories/Intune MCP Write/dist/index.js"],
      "env": {
        "AZURE_CLIENT_ID": "<your-client-id>",
        "AZURE_TENANT_ID": "<your-tenant-id>"
      }
    }
  }
}
```

## Tools

### Device Read Operations

| Tool | Description |
|------|-------------|
| `list_devices` | List managed devices with OData filtering and cursor-based pagination |
| `get_device` | Get full details for a device by Intune ID |
| `search_devices` | Search by device name, UPN, or serial number |

### Device Write Operations

| Tool | Description |
|------|-------------|
| `update_device_name` | Rename a managed device |
| `update_device_notes` | Update device notes (uses beta API) |
| `update_device_ownership` | Change ownership type (company/personal) |
| `sync_device` | Trigger a device sync with Intune |
| `list_device_categories` | List available device categories in the tenant |
| `update_device_category` | Assign a device category by name or ID |
| `delete_device` | **Destructive** — Remove a device from Intune management entirely |

### User Operations

| Tool | Description |
|------|-------------|
| `search_users` | Search Entra ID users by display name or UPN |
| `update_primary_user` | Change the primary user assigned to a device |

### Remote Device Actions

| Tool | Description |
|------|-------------|
| `restart_device` | Reboot a device remotely (Windows, Android, macOS) |
| `remote_lock_device` | Lock a device remotely (iOS, Android, macOS) |
| `rotate_bitlocker_keys` | Rotate BitLocker recovery keys (Windows only) |
| `retire_device` | **Destructive** — Remove company data, preserve personal data |
| `wipe_device` | **Destructive** — Factory reset the device |

> `retire_device`, `wipe_device`, and `delete_device` require `ENABLE_DESTRUCTIVE_ACTIONS=true` and a `confirmDeviceName` parameter that must match the device's actual display name.

### Group Read Operations

| Tool | Description |
|------|-------------|
| `search_groups` | Search Entra ID groups by display name |
| `list_group_members` | List members (users and devices) of a group |
| `resolve_device_object_id` | Look up directory object ID from Azure AD device ID |
| `list_device_groups` | List groups a device belongs to |

### Group Write Operations

| Tool | Description |
|------|-------------|
| `add_device_to_group` | Add a device to an assigned-membership group (auto-resolves device IDs) |
| `remove_device_from_group` | Remove a device from a group (auto-resolves device IDs) |
| `add_user_to_group` | Add a user to an assigned-membership group (accepts UPN or user object ID) |
| `remove_user_from_group` | Remove a user from a group (accepts UPN or user object ID) |

### Bulk Operations

| Tool | Description |
|------|-------------|
| `bulk_sync_devices` | Trigger sync on multiple devices with throttle pacing (max 50) |
| `bulk_rename_devices` | Rename multiple devices with throttle pacing (max 50) |
| `bulk_group_add` | Add multiple members (users or devices) to a group with throttle pacing (max 50) |

> Bulk operations run sequentially with a configurable delay (default 200ms) between API calls to avoid Graph API rate limits. Each returns per-item success/failure status.

### Compound Tools

| Tool | Description |
|------|-------------|
| `get_device_overview` | Device details + resolved Azure AD object ID + group memberships in one call |
| `search_device_overview` | Search for a device; auto-expands to a full overview on exactly one match |
| `get_group_overview` | Group metadata + members in one call |
| `search_group_overview` | Search for a group; auto-expands to a full overview on exactly one match |

> `list_devices`, `search_devices`, `list_device_categories`, `search_groups`, `list_group_members`, `list_device_groups`, `search_users`, and the compound tools above all accept an optional `format: "compact"|"full"` parameter — `"compact"` returns one line per item, `"full"` returns every field. Compound tools default to `"compact"`; the rest default to `"full"` (`list_group_members` defaults to `"compact"`).

## Architecture

- **Dual transport:** Supports stdio (for direct MCP client integration) and HTTP/Streamable (Express-based with session management)
- **GraphClient:** Typed HTTP abstraction over Microsoft Graph with retry logic (3 retries for 401/429/5xx), exponential backoff, cursor-based pagination, and PUT support for `$ref` assignments
- **Auth:** MSAL device-code flow with token cache at `~/.intune-mcp-write/token-cache.json`
- **Logging:** JSON structured logs to `~/.intune-mcp-write/logs/` with rotation (10MB max, 5 files)

## Project Structure

```
src/
  index.ts              Entry point (stdio or HTTP transport)
  server.ts             MCP server factory, registers all tool modules
  graph.ts              GraphClient (GET/POST/PATCH/PUT/DELETE with retries, pagination)
  auth.ts               AuthManager (MSAL device-code flow, token cache)
  auth-cli.ts           CLI for interactive sign-in
  http.ts               Express-based HTTP/Streamable transport
  logger.ts             JSON file logger with rotation
  tools/
    device-properties.ts  Device read/write tools
    group-membership.ts   Group membership tools
    remote-actions.ts     Remote device actions (restart, lock, wipe, retire)
    user-operations.ts    User search and primary user management
    bulk-operations.ts    Bulk sync, rename, and group add tools
    compound.ts           Compound overview tools (device/group overview + search-and-expand)
    shared.ts             Error formatting, compact/full formatting, and shared helpers
  __tests__/
    graph.test.ts         GraphClient unit tests
    shared.test.ts        Shared helper unit tests (errors, format, sanitization)
    device-properties.test.ts  list_devices/search_devices tool tests
    device-properties-extended.test.ts  Category, delete tool tests
    group-membership.test.ts  Group read/write tool tests
    remote-actions.test.ts  Remote action tool tests
    user-operations.test.ts  User operation tool tests
    bulk-operations.test.ts   Bulk operation tool tests
    compound.test.ts      Compound overview tool tests
scripts/
  validate-live.mjs       Read-only live validation against a real tenant
  validate-mcp-client.mjs End-to-end MCP client test (spawns the server over stdio)
```

## Known Limitations

- **Dynamic groups** cannot have members added/removed (Graph API constraint)
- **No policy/profile assignment** management
- **No conditional access visibility**
- **Bulk operations use sequential calls** — not Graph API `$batch`; optimize later if throughput becomes an issue
