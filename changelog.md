# Intune MCP Write — Changelog

Record of changes, decisions, and releases for the Intune Admin MCP Server (write-capable).

---

## 2026-08-31 — v1.4.0: User Group Management & Bulk Operations

### Summary

Phases 4 and 5: Added user group management tools (add/remove users from groups) and bulk
operation wrappers for sync, rename, and group add with per-item error handling and throttle
pacing.

### Phase 4 — User Group Management

- **`add_user_to_group`** — Add a user to an assigned-membership group. Accepts a UPN (email)
  or user object ID. Validates the group is not dynamic before attempting the add. Uses the
  same `POST /groups/{id}/members/$ref` pattern as `add_device_to_group`.
- **`remove_user_from_group`** — Remove a user from a group. Accepts a UPN or user object ID.
  Same dynamic-group check. Uses `DELETE /groups/{id}/members/{userId}/$ref`.

Both tools resolve the user via `/users/{identifier}` which accepts either a UPN or object ID.

### Phase 5 — Bulk Operations

- **`bulk_sync_devices`** — Trigger sync on up to 50 devices. Sequential execution with
  configurable pacing (default 200ms). Returns per-device success/failure status.
- **`bulk_rename_devices`** — Rename up to 50 devices. Returns before/after name per device.
- **`bulk_group_add`** — Add up to 50 members (users or devices) to a single group. Validates
  group is not dynamic before starting. Returns per-member success/failure status.

All bulk tools use Zod `z.array().max(50)` for input validation, sequential execution with
`await sleep(pacingMs)` between calls, and return structured summaries with per-item status.

### File Structure (changes from v1.3.1)

```
src/
  server.ts                      MODIFIED — registers bulk operation tools
  tools/group-membership.ts      MODIFIED — added add_user_to_group, remove_user_from_group,
                                            resolveToUserId helper
  tools/bulk-operations.ts       NEW — bulk_sync_devices, bulk_rename_devices, bulk_group_add
  __tests__/group-membership.test.ts   NEW — 8 tests (user group add/remove)
  __tests__/bulk-operations.test.ts    NEW — 9 tests (bulk sync, rename, group add)
README.md                        MODIFIED — added user group tools, bulk ops section, updated
                                            known limitations and project structure
package.json                     MODIFIED — v1.4.0
```

---

## 2026-08-31 — v1.3.1: Verification Fixes

### Summary

Bugfixes and consistency improvements found during post-implementation verification of
Phases 1–3.

### Fixes

- **Client-side search fallback used OData-escaped query** — All three search tools
  (`search_devices`, `search_groups`, `search_users`) used the OData-escaped query string
  (with `'` escaped to `''`) for client-side `.includes()` matching. Names containing
  apostrophes (e.g., O'Brien) would never match in the fallback path. Fixed to use the
  original query for client-side filtering.

- **`restart_device` returned a warning instead of an error for unsupported OS** — When
  the device OS is unsupported (e.g., iOS), the tool now returns `isError: true` with an
  explicit "No reboot command was sent" message instead of a soft warning that could be
  mistaken for a successful action.

- **`update_primary_user` failed with 409 on tenants with existing primary user** — The
  `POST $ref` call can return 409 Conflict when a primary user is already assigned. The
  tool now catches 409, removes the existing user ref(s) with DELETE, and retries the POST.

- **`list_device_groups` required a directory object ID** — Unlike `add_device_to_group`
  and `remove_device_from_group` (which auto-resolve any ID type since v1.1.0),
  `list_device_groups` still required the caller to pass a directory object ID. Now accepts
  any device ID type (directory object ID, Azure AD device ID, or Intune managed device ID)
  and resolves via `resolveToObjectId()`. Parameter renamed from `deviceObjectId` to
  `deviceId`.

### File Structure (changes from v1.3.0)

```
src/
  tools/device-properties.ts     MODIFIED — fixed escapedQuery in search_devices fallback
  tools/group-membership.ts      MODIFIED — fixed escapedQuery in search_groups fallback,
                                            list_device_groups now auto-resolves device IDs
  tools/user-operations.ts       MODIFIED — fixed escapedQuery in search_users fallback,
                                            update_primary_user handles 409 with DELETE+retry
  tools/remote-actions.ts        MODIFIED — restart_device returns isError for unsupported OS
  __tests__/user-operations.test.ts       MODIFIED — added 409 retry test (7 tests total)
  __tests__/remote-actions.test.ts        MODIFIED — updated unsupported OS assertion
```

---

## 2026-08-31 — v1.3.0: Expanded Properties & User Operations

### Summary

Added user search, primary user management, device category assignment, and device deletion.
This phase rounds out device property management and adds the user lookup tools needed for
Phase 4 (user group management).

### New Scope

Added `User.Read.All` to required delegated permissions for user search and primary user
resolution.

### New Tools

- **`search_users`** — Search Entra ID users by display name or UPN with server-side OData
  filtering, UPN fallback, and capped client-side fallback (200 items)
- **`update_primary_user`** — Change the primary user assigned to a managed device. Accepts
  a UPN, resolves to user ID, and reports before/after state
- **`list_device_categories`** — List all device categories configured in the tenant
- **`update_device_category`** — Assign a device category by display name (resolved internally)
  or by category ID. Uses `PUT` to the `$ref` endpoint
- **`delete_device`** — DESTRUCTIVE: removes device from Intune management entirely. Requires
  `ENABLE_DESTRUCTIVE_ACTIONS=true` and `confirmDeviceName` safety check

### GraphClient Changes

- Added `put()` method to support `$ref` assignment endpoints that require HTTP PUT

### File Structure (changes from v1.2.0)

```
src/
  graph.ts                       MODIFIED — added put() method
  auth.ts                        MODIFIED — added User.Read.All scope
  server.ts                      MODIFIED — registers user operation tools
  tools/device-properties.ts     MODIFIED — list_device_categories, update_device_category, delete_device
  tools/user-operations.ts       NEW — search_users, update_primary_user
  __tests__/user-operations.test.ts          NEW — 6 tests
  __tests__/device-properties-extended.test.ts  NEW — 10 tests
.env.example                     MODIFIED — documented User.Read.All
README.md                        MODIFIED — added new tools, updated permissions and structure
package.json                     MODIFIED — v1.3.0
```

---

## 2026-08-31 — v1.2.0: Remote Device Actions

### Summary

Added 5 remote device action tools: restart, remote lock, BitLocker key rotation, retire, and
wipe. Destructive actions (retire, wipe) are gated behind the `ENABLE_DESTRUCTIVE_ACTIONS` env
var and require a `confirmDeviceName` safety check that must match the device's actual display name.

### New Scope

Added `DeviceManagementManagedDevices.PrivilegedOperations.All` to required delegated permissions.
This scope is required for remote actions and must have admin consent granted.

### New Tools

- **`restart_device`** — Sends a reboot command (Windows, Android, macOS)
- **`remote_lock_device`** — Sends a remote lock command (iOS, Android, macOS)
- **`rotate_bitlocker_keys`** — Rotates BitLocker recovery keys (Windows only)
- **`retire_device`** — DESTRUCTIVE: removes company data, preserves personal data
- **`wipe_device`** — DESTRUCTIVE: factory reset with optional `keepUserData` and `keepEnrollmentData`

### Safety Design

- Destructive tools (`retire_device`, `wipe_device`) only register when `ENABLE_DESTRUCTIVE_ACTIONS=true`
- Both require a `confirmDeviceName` parameter that must exactly match the device's display name
- Non-destructive actions (restart, lock, BitLocker) check platform compatibility and warn for unsupported OS

### File Structure (changes from v1.1.0)

```
src/
  tools/remote-actions.ts    NEW — 5 remote action tools
  server.ts                  MODIFIED — registers remote action tools
  auth.ts                    MODIFIED — added PrivilegedOperations.All scope
  __tests__/remote-actions.test.ts  NEW — 16 tests
.env.example                 MODIFIED — documented new scope and ENABLE_DESTRUCTIVE_ACTIONS
README.md                    MODIFIED — added remote actions section and scope warning
package.json                 MODIFIED — v1.2.0
```

---

## 2026-08-31 — v1.1.0: Foundation Improvements

### Summary

Phase 1 improvements addressing pagination, ID resolution UX, a filter bug, search performance,
and documentation.

### Changes

**Cursor-based pagination for `list_devices`** (`src/graph.ts`, `src/tools/device-properties.ts`, `src/tools/errors.ts`)
- Added client-facing cursor pagination so MCP callers can page through large result sets across
  separate tool calls. The `list_devices` tool now accepts an optional `cursor` parameter and
  returns a `nextCursor` value when more results are available.
- Added `encodeCursor` / `decodeCursor` helpers to `graph.ts` and modified the `paginate()` method
  to accept an optional starting `nextLink` URL for cursor resumption.
- Added `paginationHeader()` formatter to `errors.ts`.

**Auto-resolve device IDs in group operations** (`src/tools/group-membership.ts`)
- `add_device_to_group` and `remove_device_from_group` now accept any device ID type — directory
  object ID, Azure AD device ID, or Intune managed device ID — and resolve it automatically.
  Eliminates the previous 3-call chain (search → get azureADDeviceId → resolve_device_object_id).
- Parameter renamed from `deviceObjectId` to `deviceId` with updated descriptions.
- Added internal `resolveToObjectId()` helper that tries each ID type in sequence.

**Fixed `list_device_groups` filter bug** (`src/tools/group-membership.ts`)
- The `memberOf` results were filtered with `@odata.type === "#microsoft.graph.group" || displayName !== undefined`.
  The `||` was too loose — roles, administrative units, and other directory objects with a `displayName`
  leaked into results. Changed to use only the `@odata.type` check.

**Capped client-side search fallbacks** (`src/tools/device-properties.ts`, `src/tools/group-membership.ts`)
- Reduced client-side fallback fetch from 1000 to 200 items in both `search_devices` and `search_groups`.
  In large tenants the previous 1000-item fetch was slow and wasteful.
- Added `exactMatch` boolean parameter to both search tools to skip client-side fallback entirely.

**Documentation**
- Created `README.md` with setup instructions, tool reference, architecture overview, and known limitations.
- Updated `changelog.md` with Phase 1 entries.

### File Structure (changes from v1.0.1)

```
src/
  graph.ts                    MODIFIED — cursor encode/decode, paginate() accepts cursor
  tools/device-properties.ts  MODIFIED — cursor pagination, exactMatch, capped fallback
  tools/group-membership.ts   MODIFIED — auto-resolve IDs, filter bugfix, exactMatch, capped fallback
  tools/errors.ts             MODIFIED — paginationHeader()
README.md                     NEW
package.json                  MODIFIED — v1.1.0
```

---

## 2026-08-28 — v1.0.1: Device & Group Search Fix

### Summary

Fixed `search_devices` and `search_groups` silently returning empty results for devices and
groups that exist in the tenant. The root cause was the same across both tools: the Graph API
`/deviceManagement/managedDevices` and `/groups` endpoints do not support combining OData
filter functions with `or`, and `contains()` is not supported at all on managed devices.

### Root Cause — search_devices

The original `search_devices` filter was:
```
contains(deviceName,'LAPTOP-X') or contains(userPrincipalName,'LAPTOP-X') or serialNumber eq 'LAPTOP-X'
```

Three compounding issues on the `/deviceManagement/managedDevices` endpoint:
1. **`contains()` is not supported** — silently returns empty results instead of erroring.
2. **`or` combining filter functions is not supported** — even valid functions like
   `startsWith()` return empty when joined with `or` on different properties.

### Root Cause — search_groups

The original `search_groups` filter was:
```
startsWith(displayName,'CODESOFT 2025') or contains(displayName,'CODESOFT 2025')
```

Two issues on the `/groups` endpoint:
1. **`contains()` is not supported** — poisons the entire `or` expression.
2. **`$orderby` is not supported alongside `startsWith`** — returns HTTP 400.

### Fix

**search_devices — separate filter queries** (`src/tools/device-properties.ts`)
- No longer builds a single `$filter` expression with `or` clauses. Instead, runs each
  filter as a separate API call and stops at the first one that returns results:
  1. `startsWith(deviceName,'...')` — catches exact names and prefixes
  2. `startsWith(userPrincipalName,'...')` — catches email-based searches
  3. `serialNumber eq '...'` — catches serial number searches
- Client-side fallback: if all server-side filters return nothing, fetches up to 1000
  devices and filters client-side with case-insensitive `includes()` matching.

**search_groups — removed contains and $orderby** (`src/tools/group-membership.ts`)
- Removed `contains()` from the filter, keeping only `startsWith(displayName,'...')`.
- Removed `$orderby: "displayName"` which is not compatible with `startsWith` on `/groups`.
- Client-side fallback: if `startsWith` returns nothing, fetches up to 1000 groups and
  filters client-side with case-insensitive `includes()` matching.

### File Structure (changes from v1.0.0)

```
src/
  tools/device-properties.ts  MODIFIED — separate filter queries, client-side fallback
  tools/group-membership.ts   MODIFIED — removed contains/or/$orderby, client-side fallback
package.json                   MODIFIED — v1.0.1
```
