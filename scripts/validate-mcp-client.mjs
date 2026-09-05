#!/usr/bin/env node
/**
 * End-to-end MCP client test: spawns the real server (dist/index.js, stdio
 * mode) as a child process and drives it through the actual MCP protocol —
 * initialize, tools/list, tools/call — using the SDK's Client class.
 *
 * This is the layer validate-live.mjs skips: zod schema validation, tool
 * registration/listing, and the stdio transport itself. Requires prior
 * "npm run auth".
 *
 * SAFETY: only read-shaped tools (list_*, search_*, get_*) and compound
 * overview tools are exercised here — see validate-live.mjs for why write
 * tools must never be part of an automated validation script against a
 * real tenant.
 *
 * Usage: node scripts/validate-mcp-client.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "validate-mcp-client", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
});

console.log("\n=== Intune MCP Write — Real MCP Client Test ===\n");

await client.connect(transport);
console.log("Connected. Server info:", client.getServerVersion());

const toolsResp = await client.listTools();
console.log(`\ntools/list: ${toolsResp.tools.length} tools registered\n`);
for (const t of toolsResp.tools) {
  console.log(`  - ${t.name}`);
}

const results = [];
function ok(tool, detail) {
  results.push({ tool, status: "OK" });
  console.log(`\n[OK]   ${tool} — ${detail}`);
}
function fail(tool, detail) {
  results.push({ tool, status: "FAIL" });
  console.log(`\n[FAIL] ${tool} — ${detail}`);
}

async function callTool(name, args) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    if (res.isError) {
      fail(name, text.slice(0, 300));
      return null;
    }
    ok(name, text.split("\n")[0]?.slice(0, 150));
    return text;
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
    return null;
  }
}

console.log("\n--- Exercising tool calls through real zod validation ---");

// Valid call
const devicesText = await callTool("list_devices", { top: 3, format: "compact" });

// Zod validation: invalid enum value should be rejected before the handler runs
await callTool("list_devices", { format: "yaml" });

// Zod validation: malformed UUID should be rejected before the handler runs
await callTool("get_device", { deviceId: "not-a-guid" });

// Valid compound tool call
let deviceId;
if (devicesText) {
  const line = devicesText.split("\n").find((l) => l.includes(" | "));
  deviceId = line?.split(" | ")[1];
}
if (deviceId) {
  await callTool("get_device_overview", { deviceId, format: "compact" });
} else {
  fail("get_device_overview", "no device ID available");
}

// Missing required field
await callTool("get_device", {});

console.log("\n=== Summary ===\n");
const passed = results.filter((r) => r.status === "OK").length;
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${passed} passed, ${failed} failed (${results.length} total)\n`);

await client.close();
process.exit(0);
