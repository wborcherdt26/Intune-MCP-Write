import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult } from "./shared.js";

const DEFAULT_PACING_MS = 200;
const MAX_ITEMS = 50;

interface ItemResult {
  id: string;
  success: boolean;
  detail: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSummary(label: string, results: ItemResult[]): string {
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;
  const lines = [
    `${label}: ${succeeded}/${results.length} succeeded${failed > 0 ? `, ${failed} failed` : ""}`,
    "",
    ...results.map((r) => `  ${r.success ? "[OK]" : "[FAIL]"} ${r.id} — ${r.detail}`),
  ];
  return lines.join("\n");
}

export function registerBulkOperationTools(
  server: McpServer,
  graph: GraphClient
): void {

  server.tool(
    "bulk_sync_devices",
    "Trigger a sync for multiple managed devices. Runs sequentially with throttle pacing to avoid Graph API rate limits. " +
      "Returns per-device success/failure status. WRITE OPERATION.",
    {
      deviceIds: z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_ITEMS)
        .describe(`Array of Intune managed device IDs (GUIDs). Max ${MAX_ITEMS}.`),
      pacingMs: z
        .number()
        .min(0)
        .max(5000)
        .optional()
        .describe("Delay between API calls in milliseconds (default 200)"),
    },
    async ({ deviceIds, pacingMs }) => {
      try {
        const delay = pacingMs ?? DEFAULT_PACING_MS;
        const results: ItemResult[] = [];

        for (let i = 0; i < deviceIds.length; i++) {
          const id = deviceIds[i];
          try {
            const device = await graph.get<{ id: string; deviceName: string }>(
              `/deviceManagement/managedDevices/${id}`,
              { $select: "id,deviceName" },
              { tool: "bulk_sync_devices" }
            );

            await graph.post(
              `/deviceManagement/managedDevices/${id}/syncDevice`,
              {},
              { tool: "bulk_sync_devices" }
            );

            results.push({ id, success: true, detail: `${device.deviceName} — sync requested` });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ id, success: false, detail: msg });
          }

          if (i < deviceIds.length - 1 && delay > 0) {
            await sleep(delay);
          }
        }

        return textResult(formatSummary("Bulk sync", results));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "bulk_rename_devices",
    "Rename multiple managed devices. Runs sequentially with throttle pacing to avoid Graph API rate limits. " +
      "Returns before/after name for each device. WRITE OPERATION.",
    {
      devices: z
        .array(
          z.object({
            deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
            newName: z.string().min(1).max(255).describe("The new device name"),
          })
        )
        .min(1)
        .max(MAX_ITEMS)
        .describe(`Array of { deviceId, newName } objects. Max ${MAX_ITEMS}.`),
      pacingMs: z
        .number()
        .min(0)
        .max(5000)
        .optional()
        .describe("Delay between API calls in milliseconds (default 200)"),
    },
    async ({ devices, pacingMs }) => {
      try {
        const delay = pacingMs ?? DEFAULT_PACING_MS;
        const results: ItemResult[] = [];

        for (let i = 0; i < devices.length; i++) {
          const { deviceId, newName } = devices[i];
          try {
            const before = await graph.get<{ id: string; deviceName: string }>(
              `/deviceManagement/managedDevices/${deviceId}`,
              { $select: "id,deviceName" },
              { tool: "bulk_rename_devices" }
            );

            await graph.patch(
              `/deviceManagement/managedDevices/${deviceId}`,
              { deviceName: newName },
              { tool: "bulk_rename_devices" }
            );

            results.push({
              id: deviceId,
              success: true,
              detail: `"${before.deviceName}" → "${newName}"`,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ id: deviceId, success: false, detail: msg });
          }

          if (i < devices.length - 1 && delay > 0) {
            await sleep(delay);
          }
        }

        return textResult(formatSummary("Bulk rename", results));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "bulk_group_add",
    "Add multiple members (devices or users) to a group. Runs sequentially with throttle pacing to avoid Graph API rate limits. " +
      "The group must be an assigned-membership group, not a dynamic group. " +
      "Members are added as directory objects — provide directory object IDs or user object IDs. " +
      "Returns per-member success/failure status. WRITE OPERATION.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      memberIds: z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_ITEMS)
        .describe(`Array of directory object IDs (user or device object IDs). Max ${MAX_ITEMS}.`),
      pacingMs: z
        .number()
        .min(0)
        .max(5000)
        .optional()
        .describe("Delay between API calls in milliseconds (default 200)"),
    },
    async ({ groupId, memberIds, pacingMs }) => {
      try {
        const group = await graph.get<{ id: string; displayName: string; groupTypes: string[] }>(
          `/groups/${groupId}`,
          { $select: "id,displayName,groupTypes" },
          { tool: "bulk_group_add" }
        );

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot add members to "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule. Change the membership rule instead.`
          );
        }

        const delay = pacingMs ?? DEFAULT_PACING_MS;
        const results: ItemResult[] = [];

        for (let i = 0; i < memberIds.length; i++) {
          const memberId = memberIds[i];
          try {
            await graph.post(
              `/groups/${groupId}/members/$ref`,
              { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${memberId}` },
              { tool: "bulk_group_add" }
            );

            results.push({ id: memberId, success: true, detail: "added" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ id: memberId, success: false, detail: msg });
          }

          if (i < memberIds.length - 1 && delay > 0) {
            await sleep(delay);
          }
        }

        return textResult(
          `Group: ${group.displayName} (${groupId})\n\n` +
          formatSummary("Bulk group add", results)
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
