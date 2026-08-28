# Intune MCP Write — Changelog

Record of changes, decisions, and releases for the Intune Admin MCP Server (write-capable).

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
