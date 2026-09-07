# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Branch note:** This is the `feature/token-efficiency-compact-format` working branch (package version `1.5.0`). Relative to `master` it renames `tools/errors.ts` → `tools/shared.ts` (and centralizes the destructive-action gate there), adds a **compact response format**, and adds a **compound "overview" tools** module. Sections marked _(this branch)_ describe work not yet on `master`.

## Overview

MCP server giving read-write access to Microsoft Intune device properties and Entra ID group memberships via the Microsoft Graph API. TypeScript, ESM, Node >= 18.

## Commands

```bash
npm run build        # tsc -> dist/
npm run dev          # tsc --watch
npm test             # vitest run (all tests)
npm start            # run stdio server (requires prior `npm run auth`)
npm run start:http   # run HTTP/Streamable server (default port 3001, --port N to override)
npm run auth         # interactive device-code sign-in, caches token
```

Run a single test file or test:

```bash
npx vitest run src/__tests__/compound.test.ts
npx vitest run -t "get_group_overview"
```

There is no linter configured; `tsc` (via `npm run build`) is the type-check gate.

### Live validation scripts _(this branch)_

Require a prior `npm run auth` and a built `dist/`:

- `node scripts/validate-live.mjs` — drives the actual registered tool handlers (compact-format + compound-tool work), close to a real MCP invocation short of the zod/transport layer.
- `node scripts/validate-mcp-client.mjs` — end-to-end: spawns the real stdio server as a child and drives it through the MCP protocol (`initialize`, `tools/list`, `tools/call`) via the SDK `Client`.

## ESM / import rule

`tsconfig.json` uses `module`/`moduleResolution: Node16`. **All relative imports must include the `.js` extension even though the source is `.ts`** (e.g. `import { GraphClient } from "./graph.js"`). Omitting it breaks the build and runtime.

## Architecture

Request flow: **MCP client → tool handler → `GraphClient` → Microsoft Graph**.

- [src/index.ts](src/index.ts) — entry point. Chooses transport: stdio by default, HTTP if `--http` or `TRANSPORT=http`. Stdio requires a cached account (fails fast telling the user to run `npm run auth`).
- [src/server.ts](src/server.ts) — `createMcpServer(pkg, auth)` factory. Constructs one `GraphClient` and calls each `registerXxxTools(server, graph)`; `registerCompoundTools` is wired in last. **This is where every tool module is wired in.** In HTTP mode it also registers an `authenticate` tool (only when `auth.startAuth` is provided).
- [src/graph.ts](src/graph.ts) — `GraphClient`, the sole HTTP layer. Every Graph call goes through it. Provides `get/post/patch/put/delete` for `v1.0` and `*Beta` variants for the beta endpoint. Handles: retries (3x on 401/429/5xx with exponential backoff, honoring `Retry-After`; re-fetches token on 401), 30s timeout, and cursor-based pagination (`getAll`/`getAllBeta` return `{items, hasMore, nextCursor}`; cursor is a base64url-encoded `nextLink`, capped at `MAX_PAGE_SIZE=100`/`MAX_PAGES=10`). Throws `GraphError` (carries `status`).
- [src/auth.ts](src/auth.ts) — `AuthManager`, MSAL public-client device-code flow. Token cache at `~/.intune-mcp-write/token-cache.json` (mode 0600). `SCOPES` array is the single source of truth for required Graph permissions.
- [src/http.ts](src/http.ts) — Express Streamable-HTTP transport. Per-session auth (each session authenticates independently via the `authenticate` tool), session TTL sweep, `MAX_SESSIONS=100`, `/health` endpoint.
- [src/logger.ts](src/logger.ts) — JSON structured file logger, `~/.intune-mcp-write/logs/`, rotation (10MB, 5 files).
- [src/tools/](src/tools/) — one module per domain (device-properties, group-membership, remote-actions, user-operations, bulk-operations, and _(this branch)_ compound). **[shared.ts](src/tools/shared.ts)** _(this branch; was `errors.ts`)_ holds the shared result/error helpers, the compact-format helpers, and `isDestructiveActionsEnabled()`.

## Compact response format _(this branch)_

`src/tools/shared.ts` defines `type ResponseFormat = "compact" | "full"` and `formatList(items, format)` (compact → newline-joined; full → joined by `\n\n---\n\n`). List/detail tools accept an optional `format: z.enum(["compact", "full"])` param, **defaulting to `"full"`** — compact is opt-in. Each domain module exports both a verbose formatter and a compact one; the handler selects one and renders through `formatList`.

## Compound "overview" tools _(this branch)_

`src/tools/compound.ts` (`registerCompoundTools`) bundles several Graph calls into one response to save round-trips and tokens: `get_device_overview`, `search_device_overview`, `get_group_overview`, `search_group_overview`. They **reuse exported internals** (`DEVICE_SELECT`, `formatDevice`, and search/format helpers) from the domain modules rather than reimplementing Graph calls — export a reusable helper from the domain module and import it here when a compound tool needs its behavior.

## Tool conventions

Follow the existing pattern when adding or editing tools:

- Register via `server.tool(name, description, zodSchema, handler)`. Wrap the handler body in `try/catch` and return `errorResult(err)` from the catch. Use `textResult(...)` for success and for *validation/precondition failures* (add `isError: true as const` for validation failures that aren't thrown).
- Pass `{ tool: "<tool_name>" }` as the `logContext` argument to every `GraphClient` call — this is what ties structured logs to the acting tool and user.
- For list output, render items via `formatList(items.map(fmt), format ?? "full")` (see compact-format section).
- Device notes use the **beta** API (`patchBeta`); most other reads/writes use `v1.0`.
- **Group `$ref` operations resolve IDs first.** An Intune managed device ID is not the directory object ID needed for group membership. See `resolve_device_object_id` and the resolution helper in [group-membership.ts](src/tools/group-membership.ts): managed device → `azureADDeviceId` → directory `deviceId` filter → object ID. Adds use `put(...$ref, { "@odata.id": ".../directoryObjects/<id>" })`.
- **Destructive actions** are registered **only when `isDestructiveActionsEnabled()`** _(this branch; reads `ENABLE_DESTRUCTIVE_ACTIONS === "true"`, centralized in [shared.ts](src/tools/shared.ts))_. An early `return` skips registration otherwise: `retire_device` and `wipe_device` are gated in [remote-actions.ts](src/tools/remote-actions.ts), and `delete_device` is gated separately at the end of [device-properties.ts](src/tools/device-properties.ts). Each requires a `confirmDeviceName` parameter that must exactly match the fetched device's `deviceName`, or the handler returns early (a plain `textResult` explaining the mismatch) without issuing the Graph write.
- Bulk operations run **sequentially** with a throttle delay (default 200ms) between Graph calls and cap at 50 items — they do not use Graph `$batch`.

## Testing conventions

- Vitest, tests in [src/\_\_tests\_\_/](src/__tests__/). Import the `registerXxxTools` function directly.
- Mock the logger: `vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))`.
- Pass a hand-rolled mock `GraphClient` object (an object with `vi.fn()` for `get/getAll/getBeta/getAllBeta/post/postBeta/patch/patchBeta/put/delete`) into the register function, and capture the registered tool handlers from the mocked `server.tool` calls to invoke them. Cover both compact and full format output where a tool supports `format`.

## Configuration

`.env` (see [.env.example](.env.example)): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` required; `ENABLE_DESTRUCTIVE_ACTIONS=true` opt-in. The Azure AD app registration needs delegated permissions matching `SCOPES` in [auth.ts](src/auth.ts) with admin consent. `scripts/register-app.{ps1,sh}` help create the app registration.
