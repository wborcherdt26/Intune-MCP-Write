import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import {
  textResult,
  errorResult,
  paginationHeader,
  sanitizeSearchQuery,
  formatList,
  isDestructiveActionsEnabled,
} from "./shared.js";

export interface ManagedDevice {
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

interface DeviceCategory {
  id: string;
  displayName: string;
  description: string;
}

export const DEVICE_SELECT = [
  "id", "deviceName", "userPrincipalName", "userDisplayName",
  "operatingSystem", "osVersion", "complianceState", "managementAgent",
  "enrolledDateTime", "lastSyncDateTime", "serialNumber", "model",
  "manufacturer", "totalStorageSpaceInBytes", "freeStorageSpaceInBytes",
  "managedDeviceOwnerType", "deviceEnrollmentType", "isEncrypted",
  "azureADRegistered", "azureADDeviceId", "notes", "deviceCategoryDisplayName",
].join(",");

export function formatDevice(d: ManagedDevice): string {
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

export function formatDeviceCompact(d: ManagedDevice): string {
  return `${d.deviceName} | ${d.id} | ${d.userPrincipalName || "(none)"} | ${d.operatingSystem} ${d.osVersion} | ${d.complianceState}`;
}

export async function searchDevicesInternal(
  graph: GraphClient,
  query: string,
  limit: number,
  exactMatch?: boolean
): Promise<{ items: ManagedDevice[]; hasMore: boolean }> {
  const sanitized = sanitizeSearchQuery(query);

  const filters = [
    `startsWith(deviceName,'${sanitized}')`,
    `startsWith(userPrincipalName,'${sanitized}')`,
    `serialNumber eq '${sanitized}'`,
  ];

  for (const filter of filters) {
    const result = await graph.getAll<ManagedDevice>(
      "/deviceManagement/managedDevices",
      { $filter: filter, $select: DEVICE_SELECT },
      { tool: "search_devices" },
      limit
    );
    if (result.items.length > 0) return result;
  }

  if (exactMatch) {
    return { items: [], hasMore: false };
  }

  const all = await graph.getAll<ManagedDevice>(
    "/deviceManagement/managedDevices",
    { $select: DEVICE_SELECT },
    { tool: "search_devices" },
    200
  );

  // Use the original query (not the OData-escaped `sanitized` value) for client-side
  // matching — escaping doubles apostrophes, which breaks .includes() for names like
  // "O'Brien" (see v1.3.1 fix for this same bug).
  const lowerQ = query.toLowerCase();
  const filtered = all.items.filter(
    (d) =>
      d.deviceName?.toLowerCase().includes(lowerQ) ||
      d.userPrincipalName?.toLowerCase().includes(lowerQ) ||
      d.serialNumber?.toLowerCase() === lowerQ
  );

  return {
    items: filtered.slice(0, limit),
    hasMore: filtered.length > limit,
  };
}

export function registerDevicePropertyTools(
  server: McpServer,
  graph: GraphClient
): void {
  server.tool(
    "list_devices",
    "List managed devices in Intune. Returns device name, user, OS, compliance state, and sync status. Use $filter for OData filtering (e.g. operatingSystem eq 'Windows'). Supports cursor-based pagination for large result sets.",
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
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' = one line per item, 'full' (default) = all fields"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous response to retrieve the next page of results"),
    },
    async ({ filter, top, orderby, format, cursor }) => {
      try {
        const params: Record<string, string> = { $select: DEVICE_SELECT };
        if (filter) params.$filter = filter;
        if (orderby) params.$orderby = orderby;

        const { items, hasMore, nextCursor } = await graph.getAll<ManagedDevice>(
          "/deviceManagement/managedDevices",
          params,
          { tool: "list_devices" },
          top ?? 25,
          cursor
        );

        if (items.length === 0) {
          return textResult("No devices found matching the criteria.");
        }

        const fmt = format === "compact" ? formatDeviceCompact : formatDevice;
        const header = paginationHeader(items.length, "device(s)", hasMore, nextCursor);
        return textResult(header + formatList(items.map(fmt), format ?? "full"));
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
    "Search for managed devices by device name, user principal name, or serial number. " +
      "Uses server-side OData filters first, then falls back to client-side substring matching (capped at 200 devices). " +
      "Set exactMatch to true to skip the client-side fallback.",
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
      exactMatch: z
        .boolean()
        .optional()
        .describe("If true, only use server-side OData filters (no client-side fallback). Faster in large tenants."),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' = one line per item, 'full' (default) = all fields"),
    },
    async ({ query, top, exactMatch, format }) => {
      try {
        const limit = top ?? 25;
        const { items, hasMore } = await searchDevicesInternal(graph, query, limit, exactMatch);

        if (items.length === 0) {
          return textResult(`No devices found matching "${query}".`);
        }

        const fmt = format === "compact" ? formatDeviceCompact : formatDevice;
        const header = `Found ${items.length} device(s) matching "${query}"${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + formatList(items.map(fmt), format ?? "full"));
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

  server.tool(
    "list_device_categories",
    "List all device categories configured in Intune. Useful for finding the category name or ID before assigning a category to a device.",
    {
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' = one line per item, 'full' (default) = all fields"),
    },
    async ({ format }) => {
      try {
        const { items } = await graph.getAll<DeviceCategory>(
          "/deviceManagement/deviceCategories",
          { $select: "id,displayName,description" },
          { tool: "list_device_categories" },
          100
        );

        if (items.length === 0) {
          return textResult("No device categories are configured in this tenant.");
        }

        const fmtFull = (c: DeviceCategory) =>
          `${c.displayName}\n  ID: ${c.id}\n  Description: ${c.description || "(none)"}`;
        const fmtCompact = (c: DeviceCategory) =>
          `${c.displayName} | ${c.id} | ${c.description || "(none)"}`;
        const fmt = format === "compact" ? fmtCompact : fmtFull;
        return textResult(`${items.length} device category(ies):\n\n${formatList(items.map(fmt), format ?? "full")}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "update_device_category",
    "Assign or change the device category for a managed device. Accepts the category by display name (resolved internally) or by category ID. " +
      "WRITE OPERATION — this modifies the device record.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      categoryName: z
        .string()
        .optional()
        .describe("The display name of the device category (case-insensitive). Provide this OR categoryId."),
      categoryId: z
        .string()
        .optional()
        .describe("The device category ID (GUID). Provide this OR categoryName."),
    },
    async ({ deviceId, categoryName, categoryId }) => {
      try {
        if (!categoryName && !categoryId) {
          return textResult("Provide either categoryName or categoryId.");
        }

        const device = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName,deviceCategoryDisplayName" },
          { tool: "update_device_category" }
        );

        let resolvedId = categoryId;
        let resolvedName = categoryName;

        if (!resolvedId && categoryName) {
          const { items } = await graph.getAll<DeviceCategory>(
            "/deviceManagement/deviceCategories",
            { $select: "id,displayName" },
            { tool: "update_device_category" },
            100
          );

          const match = items.find(
            (c) => c.displayName.toLowerCase() === categoryName.toLowerCase()
          );

          if (!match) {
            const available = items.map((c) => c.displayName).join(", ");
            return textResult(
              `Category "${categoryName}" not found.\n` +
              `  Available categories: ${available || "(none configured)"}`
            );
          }

          resolvedId = match.id;
          resolvedName = match.displayName;
        }

        await graph.put(
          `/deviceManagement/managedDevices/${deviceId}/deviceCategory/$ref`,
          { "@odata.id": `https://graph.microsoft.com/v1.0/deviceManagement/deviceCategories/${resolvedId}` },
          { tool: "update_device_category" }
        );

        return textResult(
          `Device category updated successfully.\n` +
          `  Device: ${device.deviceName}\n` +
          `  Previous category: ${device.deviceCategoryDisplayName || "(none)"}\n` +
          `  New category: ${resolvedName ?? resolvedId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // --- Destructive: delete_device ---

  if (!isDestructiveActionsEnabled()) return;

  server.tool(
    "delete_device",
    "DESTRUCTIVE — Delete a managed device from Intune, removing it from management entirely. " +
      "This does not wipe or retire the device — it only removes the Intune management record. " +
      "Requires confirmDeviceName to match the device's actual name as a safety check. " +
      "WRITE OPERATION — this action cannot be undone.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      confirmDeviceName: z.string().describe(
        "Must exactly match the device's display name. Fetch the device first to confirm the name."
      ),
    },
    async ({ deviceId, confirmDeviceName }) => {
      try {
        const device = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName,userPrincipalName,userDisplayName,operatingSystem,serialNumber" },
          { tool: "delete_device" }
        );

        if (device.deviceName !== confirmDeviceName) {
          return textResult(
            `Safety check failed — device name does not match.\n` +
            `  Expected: "${confirmDeviceName}"\n` +
            `  Actual: "${device.deviceName}"\n` +
            `  Fetch the device details first and use the exact device name.`
          );
        }

        await graph.delete(
          `/deviceManagement/managedDevices/${deviceId}`,
          { tool: "delete_device" }
        );

        return textResult(
          `Device deleted from Intune management.\n` +
          `  Device: ${device.deviceName}\n` +
          `  Serial: ${device.serialNumber}\n` +
          `  OS: ${device.operatingSystem}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  The device is no longer managed by Intune.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
