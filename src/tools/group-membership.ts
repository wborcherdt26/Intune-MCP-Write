import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult } from "./errors.js";

interface AadGroup {
  id: string;
  displayName: string;
  description: string;
  groupTypes: string[];
  membershipRule: string | null;
  membershipRuleProcessingState: string | null;
  mailEnabled: boolean;
  securityEnabled: boolean;
}

interface AadDevice {
  id: string;
  displayName: string;
  deviceId: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  accountEnabled: boolean;
  trustType: string;
}

interface DirectoryObject {
  "@odata.type": string;
  id: string;
  displayName?: string;
  userPrincipalName?: string;
  deviceId?: string;
  operatingSystem?: string;
}

function formatGroup(g: AadGroup): string {
  const isDynamic = g.groupTypes?.includes("DynamicMembership");
  const lines = [
    `Group: ${g.displayName}`,
    `  ID: ${g.id}`,
    `  Description: ${g.description || "(none)"}`,
    `  Type: ${g.securityEnabled ? "Security" : ""}${g.mailEnabled ? " Mail-enabled" : ""}`.trim(),
    `  Membership: ${isDynamic ? "Dynamic" : "Assigned"}`,
  ];
  if (isDynamic && g.membershipRule) {
    lines.push(`  Rule: ${g.membershipRule}`);
  }
  return lines.join("\n");
}

function formatAadDevice(d: AadDevice): string {
  return [
    `Device: ${d.displayName}`,
    `  Object ID: ${d.id}`,
    `  Device ID: ${d.deviceId}`,
    `  OS: ${d.operatingSystem} ${d.operatingSystemVersion}`,
    `  Enabled: ${d.accountEnabled}`,
    `  Trust Type: ${d.trustType}`,
  ].join("\n");
}

function formatMember(m: DirectoryObject): string {
  const type = m["@odata.type"]?.replace("#microsoft.graph.", "") ?? "unknown";
  if (type === "device") {
    return `[Device] ${m.displayName} (ID: ${m.id}, DeviceID: ${m.deviceId ?? "N/A"})`;
  }
  if (type === "user") {
    return `[User] ${m.displayName} (${m.userPrincipalName ?? m.id})`;
  }
  return `[${type}] ${m.displayName ?? m.id}`;
}

export function registerGroupMembershipTools(
  server: McpServer,
  graph: GraphClient
): void {
  server.tool(
    "search_groups",
    "Search for Azure AD / Entra ID groups by display name. Useful for finding the group ID before adding or removing members.",
    {
      query: z.string().describe("Search term — matches against group display name"),
      top: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default 25, max 100)"),
    },
    async ({ query, top }) => {
      try {
        const escapedQuery = query.replace(/'/g, "''");
        const limit = top ?? 25;

        // contains() is NOT supported on the /groups endpoint and poisons the
        // entire $filter expression, causing silent empty results.
        // $orderby is not supported alongside startsWith on /groups
        let { items, hasMore } = await graph.getAll<AadGroup>(
          "/groups",
          {
            $filter: `startsWith(displayName,'${escapedQuery}')`,
            $select: "id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,mailEnabled,securityEnabled",
          },
          { tool: "search_groups" },
          limit
        );

        // Fallback: if startsWith found nothing, fetch groups and filter
        // client-side for substring and case-insensitive matches.
        if (items.length === 0) {
          const all = await graph.getAll<AadGroup>(
            "/groups",
            {
              $select: "id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,mailEnabled,securityEnabled",
              $orderby: "displayName",
            },
            { tool: "search_groups" },
            1000
          );

          const lowerQ = escapedQuery.toLowerCase();
          const filtered = all.items.filter(
            (g) => g.displayName?.toLowerCase().includes(lowerQ)
          );

          items = filtered.slice(0, limit);
          hasMore = filtered.length > limit;
        }

        if (items.length === 0) {
          return textResult(`No groups found matching "${query}".`);
        }

        const text = items.map(formatGroup).join("\n\n");
        const header = `Found ${items.length} group(s) matching "${query}"${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + text);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_group_members",
    "List the members of an Azure AD / Entra ID group. Shows users and devices with their types.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      top: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of members to return (default 100, max 500)"),
    },
    async ({ groupId, top }) => {
      try {
        const group = await graph.get<AadGroup>(
          `/groups/${groupId}`,
          { $select: "id,displayName" },
          { tool: "list_group_members" }
        );

        const { items, hasMore } = await graph.getAll<DirectoryObject>(
          `/groups/${groupId}/members`,
          { $select: "id,displayName,userPrincipalName,deviceId,operatingSystem" },
          { tool: "list_group_members" },
          top ?? 100
        );

        if (items.length === 0) {
          return textResult(`Group "${group.displayName}" has no members.`);
        }

        const lines = items.map(formatMember);
        const header = `Members of "${group.displayName}" (${items.length}${hasMore ? "+" : ""}):\n\n`;
        return textResult(header + lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "resolve_device_object_id",
    "Look up the Azure AD directory object ID for a device given its Intune Azure AD device ID. " +
      "This is needed because group membership operations require the directory object ID, " +
      "not the Intune device ID or Azure AD device ID.",
    {
      azureAdDeviceId: z.string().uuid().describe(
        "The Azure AD device ID (GUID) — found in the azureADDeviceId field of an Intune managed device"
      ),
    },
    async ({ azureAdDeviceId }) => {
      try {
        const { items } = await graph.getAll<AadDevice>(
          "/devices",
          {
            $filter: `deviceId eq '${azureAdDeviceId}'`,
            $select: "id,displayName,deviceId,operatingSystem,operatingSystemVersion,accountEnabled,trustType",
          },
          { tool: "resolve_device_object_id" },
          1
        );

        if (items.length === 0) {
          return textResult(
            `No Azure AD device found with device ID "${azureAdDeviceId}". ` +
            `Verify the device is Azure AD joined or registered.`
          );
        }

        return textResult(formatAadDevice(items[0]));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "add_device_to_group",
    "Add a device to an Azure AD / Entra ID group. Requires the directory object ID of the device (use resolve_device_object_id to find it) and the group ID. " +
      "The group must be an assigned-membership group, not a dynamic group. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      deviceObjectId: z.string().uuid().describe(
        "The directory object ID of the device (NOT the Intune device ID — use resolve_device_object_id first)"
      ),
    },
    async ({ groupId, deviceObjectId }) => {
      try {
        const group = await graph.get<AadGroup>(
          `/groups/${groupId}`,
          { $select: "id,displayName,groupTypes,membershipRule" },
          { tool: "add_device_to_group" }
        );

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot add members to "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule. Change the membership rule instead.`
          );
        }

        await graph.post(
          `/groups/${groupId}/members/$ref`,
          { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${deviceObjectId}` },
          { tool: "add_device_to_group" }
        );

        return textResult(
          `Device added to group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  Device object ID: ${deviceObjectId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "remove_device_from_group",
    "Remove a device from an Azure AD / Entra ID group. Requires the directory object ID of the device and the group ID. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      deviceObjectId: z.string().uuid().describe(
        "The directory object ID of the device to remove"
      ),
    },
    async ({ groupId, deviceObjectId }) => {
      try {
        const group = await graph.get<AadGroup>(
          `/groups/${groupId}`,
          { $select: "id,displayName,groupTypes" },
          { tool: "remove_device_from_group" }
        );

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot remove members from "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule.`
          );
        }

        await graph.delete(
          `/groups/${groupId}/members/${deviceObjectId}/$ref`,
          { tool: "remove_device_from_group" }
        );

        return textResult(
          `Device removed from group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  Device object ID: ${deviceObjectId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_device_groups",
    "List the Azure AD / Entra ID groups that a device belongs to. Requires the directory object ID of the device.",
    {
      deviceObjectId: z.string().uuid().describe(
        "The directory object ID of the device (use resolve_device_object_id to find it)"
      ),
      top: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of groups to return (default 100, max 500)"),
    },
    async ({ deviceObjectId, top }) => {
      try {
        const device = await graph.get<AadDevice>(
          `/devices/${deviceObjectId}`,
          { $select: "id,displayName,deviceId" },
          { tool: "list_device_groups" }
        );

        const { items, hasMore } = await graph.getAll<AadGroup>(
          `/devices/${deviceObjectId}/memberOf`,
          { $select: "id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,mailEnabled,securityEnabled" },
          { tool: "list_device_groups" },
          top ?? 100
        );

        const groups = items.filter(
          (m) => (m as DirectoryObject & AadGroup)["@odata.type" as keyof AadGroup] === "#microsoft.graph.group"
              || m.displayName !== undefined
        );

        if (groups.length === 0) {
          return textResult(`Device "${device.displayName}" is not a member of any groups.`);
        }

        const text = groups.map(formatGroup).join("\n\n");
        const header = `Device "${device.displayName}" is a member of ${groups.length} group(s)${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + text);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
