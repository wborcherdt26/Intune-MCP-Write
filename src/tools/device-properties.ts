import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult } from "./errors.js";

interface ManagedDevice {
  id: string;
  deviceName: string;
  userPrincipalName: string;
  userDisplayName: string;
  operatingSystem: string;
  osVersion: string;
  complianceState: string;
  managementAgent: string;
  enrolledDateTime: string;
  lastSyncDateTime: string;
  serialNumber: string;
  model: string;
  manufacturer: string;
  totalStorageSpaceInBytes: number;
  freeStorageSpaceInBytes: number;
  managedDeviceOwnerType: string;
  deviceEnrollmentType: string;
  isEncrypted: boolean;
  azureADRegistered: boolean;
  azureADDeviceId: string;
  notes: string;
  deviceCategoryDisplayName: string;
}

const DEVICE_SELECT = [
  "id", "deviceName", "userPrincipalName", "userDisplayName",
  "operatingSystem", "osVersion", "complianceState", "managementAgent",
  "enrolledDateTime", "lastSyncDateTime", "serialNumber", "model",
  "manufacturer", "totalStorageSpaceInBytes", "freeStorageSpaceInBytes",
  "managedDeviceOwnerType", "deviceEnrollmentType", "isEncrypted",
  "azureADRegistered", "azureADDeviceId", "notes", "deviceCategoryDisplayName",
].join(",");

function formatDevice(d: ManagedDevice): string {
  const lines = [
    `Device: ${d.deviceName}`,
    `  ID: ${d.id}`,
    `  User: ${d.userDisplayName} (${d.userPrincipalName})`,
    `  OS: ${d.operatingSystem} ${d.osVersion}`,
    `  Model: ${d.manufacturer} ${d.model}`,
    `  Serial: ${d.serialNumber}`,
    `  Compliance: ${d.complianceState}`,
    `  Management: ${d.managementAgent}`,
    `  Ownership: ${d.managedDeviceOwnerType}`,
    `  Encrypted: ${d.isEncrypted}`,
    `  Azure AD Registered: ${d.azureADRegistered}`,
    `  Enrolled: ${d.enrolledDateTime}`,
    `  Last Sync: ${d.lastSyncDateTime}`,
    `  Notes: ${d.notes || "(none)"}`,
    `  Category: ${d.deviceCategoryDisplayName || "(none)"}`,
    `  Storage: ${formatBytes(d.freeStorageSpaceInBytes)} free / ${formatBytes(d.totalStorageSpaceInBytes)} total`,
  ];
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

export function registerDevicePropertyTools(
  server: McpServer,
  graph: GraphClient
): void {
  server.tool(
    "list_devices",
    "List managed devices in Intune. Returns device name, user, OS, compliance state, and sync status. Use $filter for OData filtering (e.g. operatingSystem eq 'Windows').",
    {
      filter: z
        .string()
        .optional()
        .describe(
          "OData $filter expression, e.g. \"operatingSystem eq 'Windows'\" or \"complianceState eq 'noncompliant'\""
        ),
      top: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of devices to return (default 25, max 500)"),
      orderby: z
        .string()
        .optional()
        .describe(
          "OData $orderby expression, e.g. \"deviceName\" or \"lastSyncDateTime desc\""
        ),
    },
    async ({ filter, top, orderby }) => {
      try {
        const params: Record<string, string> = { $select: DEVICE_SELECT };
        if (filter) params.$filter = filter;
        if (orderby) params.$orderby = orderby;

        const { items, hasMore } = await graph.getAll<ManagedDevice>(
          "/deviceManagement/managedDevices",
          params,
          { tool: "list_devices" },
          top ?? 25
        );

        if (items.length === 0) {
          return textResult("No devices found matching the criteria.");
        }

        const text = items.map(formatDevice).join("\n\n---\n\n");
        const header = `Found ${items.length} device(s)${hasMore ? " (more available — increase top to retrieve more)" : ""}:\n\n`;
        return textResult(header + text);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "get_device",
    "Get full details for a specific managed device by its Intune device ID.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
    },
    async ({ deviceId }) => {
      try {
        const device = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SELECT },
          { tool: "get_device" }
        );
        return textResult(formatDevice(device));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "search_devices",
    "Search for managed devices by device name, user principal name, or serial number.",
    {
      query: z
        .string()
        .describe(
          "Search term — matches against device name, user email (UPN), or serial number"
        ),
      top: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of results (default 25, max 500)"),
    },
    async ({ query, top }) => {
      try {
        const escapedQuery = query.replace(/'/g, "''");
        const limit = top ?? 25;

        // The managedDevices endpoint silently returns empty results when
        // filter functions are combined with 'or'. Run each filter
        // separately and stop at the first one that returns results.
        const filters = [
          `startsWith(deviceName,'${escapedQuery}')`,
          `startsWith(userPrincipalName,'${escapedQuery}')`,
          `serialNumber eq '${escapedQuery}'`,
        ];

        let items: ManagedDevice[] = [];
        let hasMore = false;

        for (const filter of filters) {
          const result = await graph.getAll<ManagedDevice>(
            "/deviceManagement/managedDevices",
            { $filter: filter, $select: DEVICE_SELECT },
            { tool: "search_devices" },
            limit
          );
          if (result.items.length > 0) {
            items = result.items;
            hasMore = result.hasMore;
            break;
          }
        }

        // Fallback: if server-side filters found nothing, fetch devices and
        // filter client-side for substring and case-insensitive matches.
        if (items.length === 0) {
          const all = await graph.getAll<ManagedDevice>(
            "/deviceManagement/managedDevices",
            { $select: DEVICE_SELECT },
            { tool: "search_devices" },
            1000
          );

          const lowerQ = escapedQuery.toLowerCase();
          const filtered = all.items.filter(
            (d) =>
              d.deviceName?.toLowerCase().includes(lowerQ) ||
              d.userPrincipalName?.toLowerCase().includes(lowerQ) ||
              d.serialNumber?.toLowerCase() === lowerQ
          );

          items = filtered.slice(0, limit);
          hasMore = filtered.length > limit;
        }

        if (items.length === 0) {
          return textResult(`No devices found matching "${query}".`);
        }

        const text = items.map(formatDevice).join("\n\n---\n\n");
        const header = `Found ${items.length} device(s) matching "${query}"${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + text);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "update_device_name",
    "Rename a managed device in Intune. Changes the deviceName property. " +
      "WRITE OPERATION — this modifies the device record.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      deviceName: z.string().min(1).max(255).describe("The new device name"),
    },
    async ({ deviceId, deviceName }) => {
      try {
        const before = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName" },
          { tool: "update_device_name" }
        );

        await graph.patch(
          `/deviceManagement/managedDevices/${deviceId}`,
          { deviceName },
          { tool: "update_device_name" }
        );

        return textResult(
          `Device renamed successfully.\n` +
          `  Previous name: ${before.deviceName}\n` +
          `  New name: ${deviceName}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "update_device_notes",
    "Update the notes/description field on a managed device in Intune. " +
      "WRITE OPERATION — this modifies the device record.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      notes: z.string().max(1024).describe("New notes content (use empty string to clear)"),
    },
    async ({ deviceId, notes }) => {
      try {
        await graph.patchBeta(
          `/deviceManagement/managedDevices/${deviceId}`,
          { notes },
          { tool: "update_device_notes" }
        );

        return textResult(
          `Device notes updated successfully.\n` +
          `  Device ID: ${deviceId}\n` +
          `  Notes: ${notes || "(cleared)"}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "update_device_ownership",
    "Change the ownership type of a managed device (corporate vs. personal). " +
      "WRITE OPERATION — this modifies the device record and may affect which policies apply.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      ownerType: z.enum(["company", "personal"]).describe("The new ownership type"),
    },
    async ({ deviceId, ownerType }) => {
      try {
        const before = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName,managedDeviceOwnerType" },
          { tool: "update_device_ownership" }
        );

        await graph.patch(
          `/deviceManagement/managedDevices/${deviceId}`,
          { managedDeviceOwnerType: ownerType },
          { tool: "update_device_ownership" }
        );

        return textResult(
          `Device ownership updated successfully.\n` +
          `  Device: ${before.deviceName}\n` +
          `  Previous ownership: ${before.managedDeviceOwnerType}\n` +
          `  New ownership: ${ownerType}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "sync_device",
    "Trigger a sync for a managed device, causing it to check in with Intune for the latest policies and configurations. " +
      "WRITE OPERATION — this sends a sync request to the device.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
    },
    async ({ deviceId }) => {
      try {
        const device = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName,lastSyncDateTime" },
          { tool: "sync_device" }
        );

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/syncDevice`,
          {},
          { tool: "sync_device" }
        );

        return textResult(
          `Sync requested successfully.\n` +
          `  Device: ${device.deviceName}\n` +
          `  Last sync before request: ${device.lastSyncDateTime}\n` +
          `  The device will check in on its next connection.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
