import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult, formatList, ResponseFormat } from "./shared.js";
import {
  ManagedDevice,
  DEVICE_SELECT,
  formatDevice,
  formatDeviceCompact,
  searchDevicesInternal,
} from "./device-properties.js";
import {
  AadGroup,
  formatGroup,
  formatGroupCompact,
  formatMember,
  formatMemberCompact,
  fetchGroup,
  resolveToObjectId,
  listDeviceGroupsInternal,
  listGroupMembersInternal,
  searchGroupsInternal,
} from "./group-membership.js";

async function buildDeviceOverview(
  graph: GraphClient,
  device: ManagedDevice,
  format: ResponseFormat
): Promise<string> {
  const sections = [format === "compact" ? formatDeviceCompact(device) : formatDevice(device)];

  try {
    const resolved = await resolveToObjectId(graph, device.id, "get_device_overview");
    const { items: groups, hasMore } = await listDeviceGroupsInternal(
      graph, resolved.objectId, "get_device_overview", 50
    );

    if (groups.length === 0) {
      sections.push(`Azure AD Object ID: ${resolved.objectId}\nGroups: Not a member of any groups.`);
    } else {
      const groupFmt = format === "compact" ? formatGroupCompact : formatGroup;
      sections.push(
        `Azure AD Object ID: ${resolved.objectId}\n` +
        `Groups (${groups.length}${hasMore ? "+" : ""}):\n${formatList(groups.map(groupFmt), format)}`
      );
    }
  } catch {
    sections.push("Groups: Unable to resolve directory object ID or retrieve group memberships.");
  }

  return sections.join("\n\n");
}

async function buildGroupOverview(
  graph: GraphClient,
  group: AadGroup,
  format: ResponseFormat
): Promise<string> {
  const sections = [format === "compact" ? formatGroupCompact(group) : formatGroup(group)];

  try {
    const { items: members, hasMore } = await listGroupMembersInternal(
      graph, group.id, "get_group_overview", 50
    );

    if (members.length === 0) {
      sections.push("Members: none.");
    } else {
      const memberFmt = format === "compact" ? formatMemberCompact : formatMember;
      sections.push(`Members (${members.length}${hasMore ? "+" : ""}):\n${formatList(members.map(memberFmt), format)}`);
    }
  } catch {
    sections.push("Members: Unable to retrieve group members.");
  }

  return sections.join("\n\n");
}

export function registerCompoundTools(
  server: McpServer,
  graph: GraphClient
): void {
  server.tool(
    "get_device_overview",
    "Device details + resolved Azure AD object ID + group memberships in one call. " +
      "Use instead of chaining get_device → resolve_device_object_id → list_device_groups.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' (default) = concise one-liners, 'full' = all fields"),
    },
    async ({ deviceId, format }) => {
      try {
        const fmt: ResponseFormat = format ?? "compact";

        const device = await graph.get<ManagedDevice>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SELECT },
          { tool: "get_device_overview" }
        );

        return textResult(await buildDeviceOverview(graph, device, fmt));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "search_device_overview",
    "Search for a device and auto-expand to full overview if exactly one match. " +
      "Returns a disambiguation list for multiple matches.",
    {
      query: z.string().min(1).describe("Search term — matches device name, UPN, or serial number"),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' (default) = concise one-liners, 'full' = all fields"),
    },
    async ({ query, format }) => {
      try {
        const fmt: ResponseFormat = format ?? "compact";
        const { items, hasMore } = await searchDevicesInternal(graph, query, 50);

        if (items.length === 0) {
          return textResult(
            `No devices found matching "${query}". ` +
            `Try the exact device name, full UPN (user@domain.com), or serial number.`
          );
        }

        if (items.length === 1) {
          return textResult(await buildDeviceOverview(graph, items[0], fmt));
        }

        const lines = items.map(formatDeviceCompact);
        return textResult(
          `${items.length} devices match "${query}"${hasMore ? " (more available)" : ""}. ` +
          `Pick one by ID and use get_device_overview:\n\n` +
          lines.join("\n")
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "get_group_overview",
    "Group metadata + members in one call. Use instead of chaining search_groups → list_group_members.",
    {
      groupId: z.string().uuid().describe("The Azure AD group ID (GUID)"),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' (default) = concise one-liners, 'full' = all fields"),
    },
    async ({ groupId, format }) => {
      try {
        const fmt: ResponseFormat = format ?? "compact";
        const group = await fetchGroup(graph, groupId, "get_group_overview");
        return textResult(await buildGroupOverview(graph, group, fmt));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "search_group_overview",
    "Search for a group and auto-expand to full overview if exactly one match. " +
      "Returns a disambiguation list for multiple matches.",
    {
      query: z.string().min(1).describe("Search term — matches against group display name"),
      format: z.enum(["compact", "full"]).optional()
        .describe("'compact' (default) = concise one-liners, 'full' = all fields"),
    },
    async ({ query, format }) => {
      try {
        const fmt: ResponseFormat = format ?? "compact";
        const { items, hasMore } = await searchGroupsInternal(graph, query, 50);

        if (items.length === 0) {
          return textResult(`No groups found matching "${query}".`);
        }

        if (items.length === 1) {
          return textResult(await buildGroupOverview(graph, items[0], fmt));
        }

        const lines = items.map(formatGroupCompact);
        return textResult(
          `${items.length} groups match "${query}"${hasMore ? " (more available)" : ""}. ` +
          `Pick one by ID and use get_group_overview:\n\n` +
          lines.join("\n")
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
