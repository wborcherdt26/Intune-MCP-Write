#!/usr/bin/env node
/**
 * Live validation for the compact-format + compound-tool work ported from
 * Intune MCP (read). Drives the actual MCP tool handlers registered in
 * src/tools/*.ts — closer to what a real MCP client invocation exercises,
 * short of the zod/transport layer.
 *
 * SAFETY: this script only ever calls read-shaped tools (list_*, search_*,
 * get_*, resolve_*) and the compound overview tools against the real tenant.
 * It must NEVER call update_*, delete_device, restart_device, retire_device,
 * wipe_device, sync_device, remote_lock_device, rotate_bitlocker_keys,
 * add_*_to_group / remove_*_from_group, update_primary_user, or any bulk_*
 * tool — those mutate real production devices (POS terminals, laptops) with
 * no undo. Write-path validation is a manual, explicitly-approved exercise
 * against a disposable test device — not something to automate here. The
 * READ_ONLY_ALLOWLIST below is the hard enforcement of that rule: call()
 * refuses anything not on it.
 *
 * Usage: node scripts/validate-live.mjs
 */
import "dotenv/config";
import { AuthManager } from "../dist/auth.js";
import { GraphClient } from "../dist/graph.js";
import { registerDevicePropertyTools } from "../dist/tools/device-properties.js";
import { registerGroupMembershipTools } from "../dist/tools/group-membership.js";
import { registerUserOperationTools } from "../dist/tools/user-operations.js";
import { registerCompoundTools } from "../dist/tools/compound.js";
import { registerGenericTools } from "../dist/tools/generic.js";

const READ_ONLY_ALLOWLIST = new Set([
  "list_devices", "get_device", "search_devices", "list_device_categories",
  "search_groups", "list_group_members", "resolve_device_object_id", "list_device_groups",
  "search_users",
  "get_device_overview", "search_device_overview", "get_group_overview", "search_group_overview",
  "intune_graph_get", // read-only GET escape hatch (v1.6.0)
]);

const results = [];

function ok(tool, detail) {
  results.push({ tool, status: "OK", detail });
  console.log(`  [OK]   ${tool} — ${detail}`);
}
function fail(tool, err) {
  const msg = err instanceof Error ? err.message : String(err);
  results.push({ tool, status: "FAIL", detail: msg });
  console.log(`  [FAIL] ${tool} — ${msg}`);
}
function skip(tool, reason) {
  results.push({ tool, status: "SKIP", detail: reason });
  console.log(`  [SKIP] ${tool} — ${reason}`);
}

function captureHandlers(register, graph) {
  const handlers = new Map();
  const mockServer = {
    tool: (...args) => {
      const name = args[0];
      const handler = args[args.length - 1];
      handlers.set(name, handler);
    },
  };
  register(mockServer, graph);
  return handlers;
}

function firstLine(text, max = 200) {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

// Compact list items always look like "col1 | col2 | ...". The pagination
// header (count + optional "Next page cursor:" line) never contains " | ",
// so this skips past it regardless of how many header lines there are.
function firstCompactColumn(text, colIndex) {
  const line = text.split("\n").find((l) => l.includes(" | "));
  if (!line) return undefined;
  return line.split(" | ")[colIndex];
}

async function call(handlers, tool, args, detailFn) {
  if (!READ_ONLY_ALLOWLIST.has(tool)) {
    throw new Error(
      `Refusing to call "${tool}" — not on the read-only allowlist for live validation. ` +
      `Write/destructive tools must never be exercised by this script.`
    );
  }
  const handler = handlers.get(tool);
  if (!handler) {
    fail(tool, "Tool not registered");
    return null;
  }
  try {
    const result = await handler(args);
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) {
      fail(tool, text.length > 500 ? text.slice(0, 500) + "…" : text);
      return null;
    }
    ok(tool, detailFn ? detailFn(text, result) : firstLine(text));
    return text;
  } catch (err) {
    fail(tool, err.stack ?? err);
    return null;
  }
}

console.log("\n=== Intune MCP Write — Live Handler Validation (read-only tools) ===\n");

let graph;
try {
  const authManager = new AuthManager();
  const account = await authManager.getFirstAccount();
  if (!account) {
    console.error('No cached credentials. Run "npm run auth" first.');
    process.exit(1);
  }
  const token = await authManager.getAccessToken(account);
  console.log(`Authenticated as: ${account.username}`);
  console.log(`Token length: ${token.length} chars\n`);
  graph = new GraphClient(
    () => authManager.getAccessToken(account),
    () => account.username
  );
} catch (err) {
  console.error("Auth failed:", err.message);
  process.exit(1);
}

const deviceProps = captureHandlers(registerDevicePropertyTools, graph);
const groups = captureHandlers(registerGroupMembershipTools, graph);
const users = captureHandlers(registerUserOperationTools, graph);
const compound = captureHandlers(registerCompoundTools, graph);
const generic = captureHandlers(registerGenericTools, graph);

let deviceId, deviceUpn, groupId;

// ── Compact format on existing list/search tools ────────────

console.log("Devices:");

await call(deviceProps, "list_devices", { top: 5, format: "compact" }, (t) => {
  deviceId = firstCompactColumn(t, 1);
  deviceUpn = firstCompactColumn(t, 2);
  return firstLine(t, 150);
});

await call(deviceProps, "list_devices", { top: 2, format: "full" }, () => "full format still works");

if (deviceId) {
  await call(deviceProps, "get_device", { deviceId });
  await call(deviceProps, "search_devices", { query: deviceUpn ?? "a", top: 5, format: "compact" });
} else {
  skip("get_device", "no device ID from list_devices");
  skip("search_devices", "no device ID from list_devices");
}

await call(deviceProps, "list_device_categories", { format: "compact" });

console.log("\nGroups:");

await call(groups, "search_groups", { query: "a", top: 5, format: "compact" }, (t) => {
  groupId = firstCompactColumn(t, 1);
  return firstLine(t, 150);
});

if (groupId) {
  await call(groups, "list_group_members", { groupId, top: 5 });
} else {
  skip("list_group_members", "no group ID from search_groups");
}

if (deviceId) {
  await call(groups, "list_device_groups", { deviceId, format: "compact" });
} else {
  skip("list_device_groups", "no device ID from list_devices");
}

console.log("\nUsers:");

await call(users, "search_users", { query: "a", top: 5, format: "compact" });

// ── Compound tools ──────────────────────────────────────────

console.log("\nCompound tools:");

if (deviceId) {
  await call(compound, "get_device_overview", { deviceId, format: "compact" },
    (t) => `${t.split("\n\n").length} section(s), compact`);
  await call(compound, "get_device_overview", { deviceId, format: "full" },
    (t) => `${t.split("\n\n").length} section(s), full`);
  await call(compound, "search_device_overview", { query: deviceUpn ?? "a" },
    () => "search_device_overview returned");
} else {
  skip("get_device_overview", "no device ID from list_devices");
  skip("search_device_overview", "no device ID from list_devices");
}

if (groupId) {
  await call(compound, "get_group_overview", { groupId, format: "compact" },
    (t) => `${t.split("\n\n").length} section(s)`);
  await call(compound, "search_group_overview", { query: "a" },
    () => "search_group_overview returned");
} else {
  skip("get_group_overview", "no group ID from search_groups");
  skip("search_group_overview", "no group ID from search_groups");
}

// ── Generic passthrough (intune_graph_get) ──────────────────

console.log("\nGeneric passthrough:");

// Single GET — a small, always-present Intune resource.
await call(generic, "intune_graph_get",
  { path: "/deviceManagement/managedDeviceOverview" },
  (t) => `single GET → ${firstLine(t, 120)}`);

// List with $select + list:true (paginates & formats items).
await call(generic, "intune_graph_get",
  { path: "/deviceManagement/managedDevices", list: true, top: 3, format: "compact", params: { $select: "id,deviceName" } },
  (t) => firstLine(t, 120));

// Wider allowlist — /groups is covered by this repo's scopes (not the read repo's).
await call(generic, "intune_graph_get",
  { path: "/groups", list: true, top: 3, format: "compact", params: { $select: "id,displayName" } },
  (t) => firstLine(t, 120));

// Negative check: an off-allowlist path must be refused BEFORE any Graph call,
// with the verbatim "only covers" guidance (proving it isn't rewritten to "Access denied").
// call() would report isError as a FAIL, so assert this one directly.
{
  const tool = "intune_graph_get (off-allowlist guard)";
  try {
    const result = await generic.get("intune_graph_get")({ path: "/servicePrincipals" });
    const text = result.content?.[0]?.text ?? "";
    if (result.isError && text.includes("only covers") && !text.includes("Access denied")) {
      ok(tool, "off-allowlist path refused with verbatim guidance");
    } else {
      fail(tool, `expected verbatim 'only covers' guidance, got: ${firstLine(text, 200)}`);
    }
  } catch (err) {
    fail(tool, err.stack ?? err);
  }
}

// ── Summary ─────────────────────────────────────────────────

console.log("\n=== Summary ===\n");
const passed = results.filter((r) => r.status === "OK").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)\n`);

if (failed > 0) {
  console.log("Failures:");
  for (const r of results.filter((r) => r.status === "FAIL")) {
    console.log(`  ${r.tool}: ${r.detail}`);
  }
  console.log();
  process.exitCode = 1;
}
