import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult, sanitizeSearchQuery, formatList, odataTypeLabel } from "./shared.js";

export interface AadGroup {
  id: string;
  displayName: string;
  description: string;
  groupTypes: string[];
  membershipRule: string | null;
  membershipRuleProcessingState: string | null;
  mailEnabled: boolean;
  securityEnabled: boolean;
}

export interface AadDevice {
  id: string;
  displayName: string;
  deviceId: string;
  operatingSystem: string;
  operatingSystemVersion: string;
  accountEnabled: boolean;
  trustType: string;
}

export interface DirectoryObject {
  "@odata.type": string;
  id: string;
  displayName?: string;
  userPrincipalName?: string;
  deviceId?: string;
  operatingSystem?: string;
  operatingSystemVersion?: string;
  accountEnabled?: boolean;
}

const MEMBER_SELECT = "id,displayName,userPrincipalName,deviceId,operatingSystem,operatingSystemVersion,accountEnabled";

const MEMBER_TYPE_LABELS: Record<string, string> = {
  "#microsoft.graph.device": "Device",
  "#microsoft.graph.user": "User",
};

export function formatGroup(g: AadGroup): string {
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

export function formatGroupCompact(g: AadGroup): string {
  const isDynamic = g.groupTypes?.includes("DynamicMembership");
  return `${g.displayName} | ${g.id} | ${isDynamic ? "Dynamic" : "Assigned"}`;
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

export function formatMemberCompact(m: DirectoryObject): string {
  const type = odataTypeLabel(m["@odata.type"], MEMBER_TYPE_LABELS);
  if (type === "Device") {
    return `[Device] ${m.displayName} (ID: ${m.id}, DeviceID: ${m.deviceId ?? "N/A"})`;
  }
  if (type === "User") {
    return `[User] ${m.displayName} (${m.userPrincipalName ?? m.id})`;
  }
  return `[${type}] ${m.displayName ?? m.id}`;
}

export function formatMember(m: DirectoryObject): string {
  const type = odataTypeLabel(m["@odata.type"], MEMBER_TYPE_LABELS);
  if (type === "Device") {
    return [
      `[Device] ${m.displayName}`,
      `  ID: ${m.id}`,
      `  Device ID: ${m.deviceId ?? "N/A"}`,
      `  OS: ${m.operatingSystem ?? "N/A"} ${m.operatingSystemVersion ?? ""}`.trim(),
    ].join("\n");
  }
  if (type === "User") {
    return [
      `[User] ${m.displayName}`,
      `  ID: ${m.id}`,
      `  UPN: ${m.userPrincipalName ?? m.id}`,
      `  Account Enabled: ${m.accountEnabled ?? "N/A"}`,
    ].join("\n");
  }
  return `[${type}] ${m.displayName ?? m.id}`;
}

async function resolveToUserId(
  graph: GraphClient,
  identifier: string,
  toolName: string
): Promise<{ userId: string; displayName: string; upn: string }> {
  try {
    const user = await graph.get<{ id: string; displayName: string; userPrincipalName: string }>(
      `/users/${encodeURIComponent(identifier)}`,
      { $select: "id,displayName,userPrincipalName" },
      { tool: toolName }
    );
    return { userId: user.id, displayName: user.displayName, upn: user.userPrincipalName };
  } catch {
    throw new Error(
      `Could not resolve "${identifier}" to a user. Provide a valid UPN (email) or user object ID.`
    );
  }
}

const AAD_GROUP_SELECT = "id,displayName,description,groupTypes,membershipRule,membershipRuleProcessingState,mailEnabled,securityEnabled";

export async function fetchGroup(
  graph: GraphClient,
  groupId: string,
  toolName: string
): Promise<AadGroup> {
  return graph.get<AadGroup>(
    `/groups/${groupId}`,
    { $select: AAD_GROUP_SELECT },
    { tool: toolName }
  );
}

export async function listGroupMembersInternal(
  graph: GraphClient,
  groupId: string,
  toolName: string,
  limit: number
): Promise<{ items: DirectoryObject[]; hasMore: boolean }> {
  return graph.getAll<DirectoryObject>(
    `/groups/${groupId}/members`,
    { $select: MEMBER_SELECT },
    { tool: toolName },
    limit
  );
}

export async function listDeviceGroupsInternal(
  graph: GraphClient,
  objectId: string,
  toolName: string,
  limit: number
): Promise<{ items: AadGroup[]; hasMore: boolean }> {
  const { items, hasMore } = await graph.getAll<AadGroup>(
    `/devices/${objectId}/memberOf`,
    { $select: AAD_GROUP_SELECT },
    { tool: toolName },
    limit
  );

  const groups = items.filter(
    (m) => (m as unknown as DirectoryObject)["@odata.type"] === "#microsoft.graph.group"
  );

  return { items: groups, hasMore };
}

export async function searchGroupsInternal(
  graph: GraphClient,
  query: string,
  limit: number,
  exactMatch?: boolean
): Promise<{ items: AadGroup[]; hasMore: boolean }> {
  const sanitized = sanitizeSearchQuery(query);

  let { items, hasMore } = await graph.getAll<AadGroup>(
    "/groups",
    {
      $filter: `startsWith(displayName,'${sanitized}')`,
      $select: AAD_GROUP_SELECT,
    },
    { tool: "search_groups" },
    limit
  );

  if (items.length === 0 && !exactMatch) {
    const all = await graph.getAll<AadGroup>(
      "/groups",
      {
        $select: AAD_GROUP_SELECT,
        $orderby: "displayName",
      },
      { tool: "search_groups" },
      200
    );

    // Use the original query (not the OData-escaped `sanitized` value) for client-side
    // matching — escaping doubles apostrophes, which breaks .includes() for names like
    // "O'Brien" (see v1.3.1 fix for this same bug in search_devices/search_groups/search_users).
    const lowerQ = query.toLowerCase();
    const filtered = all.items.filter(
      (g) => g.displayName?.toLowerCase().includes(lowerQ)
    );

    items = filtered.slice(0, limit);
    hasMore = filtered.length > limit;
  }

  return { items, hasMore };
}

export async function resolveToObjectId(
  graph: GraphClient,
  idValue: string,
  toolName: string
): Promise<{ objectId: string; deviceName?: string }> {
  // First, try as a directory object ID — if the device exists at /devices/{id}, it's already an object ID
  try {
    const device = await graph.get<AadDevice>(
      `/devices/${idValue}`,
      { $select: "id,displayName,deviceId" },
      { tool: toolName }
    );
    return { objectId: device.id, deviceName: device.displayName };
  } catch {
    // Not a directory object ID — try as an Azure AD device ID
  }

  const { items } = await graph.getAll<AadDevice>(
    "/devices",
    {
      $filter: `deviceId eq '${idValue}'`,
      $select: "id,displayName,deviceId",
    },
    { tool: toolName },
    1
  );

  if (items.length > 0) {
    return { objectId: items[0].id, deviceName: items[0].displayName };
  }

  // Try as an Intune managed device ID — fetch its azureADDeviceId, then resolve that
  try {
    const managed = await graph.get<{ id: string; deviceName: string; azureADDeviceId: string }>(
      `/deviceManagement/managedDevices/${idValue}`,
      { $select: "id,deviceName,azureADDeviceId" },
      { tool: toolName }
    );

    if (managed.azureADDeviceId) {
      const { items: aadItems } = await graph.getAll<AadDevice>(
        "/devices",
        {
          $filter: `deviceId eq '${managed.azureADDeviceId}'`,
          $select: "id,displayName,deviceId",
        },
        { tool: toolName },
        1
      );
      if (aadItems.length > 0) {
        return { objectId: aadItems[0].id, deviceName: managed.deviceName };
      }
    }
  } catch {
    // Not an Intune managed device ID either
  }

  throw new Error(
    `Could not resolve "${idValue}" to a directory object ID. ` +
    `Provide a valid directory object ID, Azure AD device ID, or Intune managed device ID.`
  );
}

export function registerGroupMembershipTools(
  server: McpServer,
  graph: GraphClient
): void {
  server.tool(
    "search_groups",
    "Search for Azure AD / Entra ID groups by display name. Useful for finding the group ID before adding or removing members. " +
      "Uses server-side startsWith filter first, then falls back to client-side substring matching (capped at 200 groups). " +
      "Set exactMatch to true to skip the client-side fallback.",
    {
      query: z.string().describe("Search term — matches against group display name"),
      top: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default 25, max 100)"),
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
        const { items, hasMore } = await searchGroupsInternal(graph, query, limit, exactMatch);

        if (items.length === 0) {
          return textResult(`No groups found matching "${query}".`);
        }

        const fmt = format === "compact" ? formatGroupCompact : formatGroup;
        const header = `Found ${items.length} group(s) matching "${query}"${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + formatList(items.map(fmt), format ?? "full"));
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
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' (default) = one line per item, 'full' = adds account status and OS version"),
    },
    async ({ groupId, top, format }) => {
      try {
        const group = await fetchGroup(graph, groupId, "list_group_members");

        const { items, hasMore } = await listGroupMembersInternal(graph, groupId, "list_group_members", top ?? 100);

        if (items.length === 0) {
          return textResult(`Group "${group.displayName}" has no members.`);
        }

        const fmt = format === "full" ? formatMember : formatMemberCompact;
        const header = `Members of "${group.displayName}" (${items.length}${hasMore ? "+" : ""}):\n\n`;
        return textResult(header + formatList(items.map(fmt), format === "full" ? "full" : "compact"));
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
    "Add a device to an Azure AD / Entra ID group. Accepts a directory object ID, Azure AD device ID, or Intune managed device ID — the tool resolves it automatically. " +
      "The group must be an assigned-membership group, not a dynamic group. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      deviceId: z.string().uuid().describe(
        "The device ID — can be a directory object ID, Azure AD device ID, or Intune managed device ID (GUID). The tool resolves it automatically."
      ),
    },
    async ({ groupId, deviceId }) => {
      try {
        const [group, resolved] = await Promise.all([
          fetchGroup(graph, groupId, "add_device_to_group"),
          resolveToObjectId(graph, deviceId, "add_device_to_group"),
        ]);

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot add members to "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule. Change the membership rule instead.`
          );
        }

        await graph.post(
          `/groups/${groupId}/members/$ref`,
          { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${resolved.objectId}` },
          { tool: "add_device_to_group" }
        );

        return textResult(
          `Device added to group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  Device: ${resolved.deviceName ?? "(unknown)"}\n` +
          `  Resolved object ID: ${resolved.objectId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "remove_device_from_group",
    "Remove a device from an Azure AD / Entra ID group. Accepts a directory object ID, Azure AD device ID, or Intune managed device ID — the tool resolves it automatically. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      deviceId: z.string().uuid().describe(
        "The device ID — can be a directory object ID, Azure AD device ID, or Intune managed device ID (GUID). The tool resolves it automatically."
      ),
    },
    async ({ groupId, deviceId }) => {
      try {
        const [group, resolved] = await Promise.all([
          fetchGroup(graph, groupId, "remove_device_from_group"),
          resolveToObjectId(graph, deviceId, "remove_device_from_group"),
        ]);

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot remove members from "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule.`
          );
        }

        await graph.delete(
          `/groups/${groupId}/members/${resolved.objectId}/$ref`,
          { tool: "remove_device_from_group" }
        );

        return textResult(
          `Device removed from group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  Device: ${resolved.deviceName ?? "(unknown)"}\n` +
          `  Resolved object ID: ${resolved.objectId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "list_device_groups",
    "List the Azure AD / Entra ID groups that a device belongs to. Accepts a directory object ID, Azure AD device ID, or Intune managed device ID — the tool resolves it automatically.",
    {
      deviceId: z.string().uuid().describe(
        "The device ID — can be a directory object ID, Azure AD device ID, or Intune managed device ID (GUID). The tool resolves it automatically."
      ),
      top: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of groups to return (default 100, max 500)"),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' = one line per item, 'full' (default) = all fields"),
    },
    async ({ deviceId, top, format }) => {
      try {
        const resolved = await resolveToObjectId(graph, deviceId, "list_device_groups");

        const device = await graph.get<AadDevice>(
          `/devices/${resolved.objectId}`,
          { $select: "id,displayName,deviceId" },
          { tool: "list_device_groups" }
        );

        const { items: groups, hasMore } = await listDeviceGroupsInternal(graph, resolved.objectId, "list_device_groups", top ?? 100);

        if (groups.length === 0) {
          return textResult(`Device "${device.displayName}" is not a member of any groups.`);
        }

        const fmt = format === "compact" ? formatGroupCompact : formatGroup;
        const header = `Device "${device.displayName}" is a member of ${groups.length} group(s)${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + formatList(groups.map(fmt), format ?? "full"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "add_user_to_group",
    "Add a user to an Azure AD / Entra ID group. Accepts a user principal name (UPN/email) or user object ID. " +
      "The group must be an assigned-membership group, not a dynamic group. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      userId: z.string().describe(
        "The user principal name (UPN/email) or user object ID (GUID)"
      ),
    },
    async ({ groupId, userId }) => {
      try {
        const [group, resolved] = await Promise.all([
          fetchGroup(graph, groupId, "add_user_to_group"),
          resolveToUserId(graph, userId, "add_user_to_group"),
        ]);

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot add members to "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule. Change the membership rule instead.`
          );
        }

        await graph.post(
          `/groups/${groupId}/members/$ref`,
          { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${resolved.userId}` },
          { tool: "add_user_to_group" }
        );

        return textResult(
          `User added to group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  User: ${resolved.displayName} (${resolved.upn})\n` +
          `  User ID: ${resolved.userId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "remove_user_from_group",
    "Remove a user from an Azure AD / Entra ID group. Accepts a user principal name (UPN/email) or user object ID. " +
      "WRITE OPERATION — this modifies group membership.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      userId: z.string().describe(
        "The user principal name (UPN/email) or user object ID (GUID)"
      ),
    },
    async ({ groupId, userId }) => {
      try {
        const [group, resolved] = await Promise.all([
          fetchGroup(graph, groupId, "remove_user_from_group"),
          resolveToUserId(graph, userId, "remove_user_from_group"),
        ]);

        if (group.groupTypes?.includes("DynamicMembership")) {
          return textResult(
            `Cannot remove members from "${group.displayName}" — it is a dynamic group ` +
            `with membership controlled by a rule.`
          );
        }

        await graph.delete(
          `/groups/${groupId}/members/${resolved.userId}/$ref`,
          { tool: "remove_user_from_group" }
        );

        return textResult(
          `User removed from group successfully.\n` +
          `  Group: ${group.displayName} (${groupId})\n` +
          `  User: ${resolved.displayName} (${resolved.upn})\n` +
          `  User ID: ${resolved.userId}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
