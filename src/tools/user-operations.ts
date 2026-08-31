import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { GraphError } from "../graph.js";
import { textResult, errorResult } from "./errors.js";

interface GraphUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  accountEnabled: boolean;
}

interface PrimaryUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
}

const USER_SELECT = [
  "id", "displayName", "userPrincipalName", "mail",
  "jobTitle", "department", "officeLocation", "accountEnabled",
].join(",");

function formatUser(u: GraphUser): string {
  return [
    `User: ${u.displayName}`,
    `  ID: ${u.id}`,
    `  UPN: ${u.userPrincipalName}`,
    `  Email: ${u.mail || "(none)"}`,
    `  Job Title: ${u.jobTitle || "(none)"}`,
    `  Department: ${u.department || "(none)"}`,
    `  Office: ${u.officeLocation || "(none)"}`,
    `  Account Enabled: ${u.accountEnabled}`,
  ].join("\n");
}

export function registerUserOperationTools(
  server: McpServer,
  graph: GraphClient
): void {

  server.tool(
    "search_users",
    "Search for Azure AD / Entra ID users by display name or user principal name (UPN/email). " +
      "Uses server-side startsWith filter first, then falls back to client-side substring matching (capped at 200 users). " +
      "Set exactMatch to true to skip the client-side fallback.",
    {
      query: z.string().describe("Search term — matches against display name or UPN"),
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
    },
    async ({ query, top, exactMatch }) => {
      try {
        const escapedQuery = query.replace(/'/g, "''");
        const limit = top ?? 25;

        // Try startsWith on displayName first, then userPrincipalName
        const filters = [
          `startsWith(displayName,'${escapedQuery}')`,
          `startsWith(userPrincipalName,'${escapedQuery}')`,
        ];

        let items: GraphUser[] = [];
        let hasMore = false;

        for (const filter of filters) {
          const result = await graph.getAll<GraphUser>(
            "/users",
            { $filter: filter, $select: USER_SELECT, $orderby: "displayName" },
            { tool: "search_users" },
            limit
          );
          if (result.items.length > 0) {
            items = result.items;
            hasMore = result.hasMore;
            break;
          }
        }

        if (items.length === 0 && !exactMatch) {
          const all = await graph.getAll<GraphUser>(
            "/users",
            { $select: USER_SELECT, $orderby: "displayName" },
            { tool: "search_users" },
            200
          );

          const lowerQ = query.toLowerCase();
          const filtered = all.items.filter(
            (u) =>
              u.displayName?.toLowerCase().includes(lowerQ) ||
              u.userPrincipalName?.toLowerCase().includes(lowerQ) ||
              u.mail?.toLowerCase().includes(lowerQ)
          );

          items = filtered.slice(0, limit);
          hasMore = filtered.length > limit;
        }

        if (items.length === 0) {
          return textResult(`No users found matching "${query}".`);
        }

        const text = items.map(formatUser).join("\n\n");
        const header = `Found ${items.length} user(s) matching "${query}"${hasMore ? " (more available)" : ""}:\n\n`;
        return textResult(header + text);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "update_primary_user",
    "Change the primary user assigned to a managed device. Accepts a user by UPN (email) or user ID. " +
      "WRITE OPERATION — this modifies the device's primary user assignment.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      userUpn: z.string().describe(
        "The user principal name (email) or user ID of the new primary user"
      ),
    },
    async ({ deviceId, userUpn }) => {
      try {
        // Fetch device for context
        const device = await graph.get<{ id: string; deviceName: string; userPrincipalName: string; userDisplayName: string }>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: "id,deviceName,userPrincipalName,userDisplayName" },
          { tool: "update_primary_user" }
        );

        // Resolve user — try direct lookup by UPN or ID
        let userId: string;
        let newUserDisplay: string;
        let newUserUpn: string;
        try {
          const user = await graph.get<GraphUser>(
            `/users/${encodeURIComponent(userUpn)}`,
            { $select: USER_SELECT },
            { tool: "update_primary_user" }
          );
          userId = user.id;
          newUserDisplay = user.displayName;
          newUserUpn = user.userPrincipalName;
        } catch {
          return textResult(
            `User "${userUpn}" not found. Verify the UPN or user ID is correct.`
          );
        }

        // Get current primary users to show before state
        const { items: currentUsers } = await graph.getAll<PrimaryUser>(
          `/deviceManagement/managedDevices/${deviceId}/users`,
          { $select: "id,displayName,userPrincipalName" },
          { tool: "update_primary_user" },
          5
        );

        const previousUser = currentUsers.length > 0
          ? `${currentUsers[0].displayName} (${currentUsers[0].userPrincipalName})`
          : "(none)";

        const refBody = { "@odata.id": `https://graph.microsoft.com/v1.0/users/${userId}` };
        try {
          await graph.post(
            `/deviceManagement/managedDevices/${deviceId}/users/$ref`,
            refBody,
            { tool: "update_primary_user" }
          );
        } catch (postErr) {
          if (postErr instanceof GraphError && postErr.status === 409 && currentUsers.length > 0) {
            for (const existing of currentUsers) {
              await graph.delete(
                `/deviceManagement/managedDevices/${deviceId}/users/${existing.id}/$ref`,
                { tool: "update_primary_user" }
              );
            }
            await graph.post(
              `/deviceManagement/managedDevices/${deviceId}/users/$ref`,
              refBody,
              { tool: "update_primary_user" }
            );
          } else {
            throw postErr;
          }
        }

        return textResult(
          `Primary user updated successfully.\n` +
          `  Device: ${device.deviceName}\n` +
          `  Previous primary user: ${previousUser}\n` +
          `  New primary user: ${newUserDisplay} (${newUserUpn})`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
