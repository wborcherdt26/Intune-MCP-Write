import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import {
  textResult,
  errorResult,
  paginationHeader,
  formatList,
  validateGraphPath,
  formatGeneric,
} from "./shared.js";

export function registerGenericTools(server: McpServer, graph: GraphClient): void {
  server.tool(
    "intune_graph_get",
    "Escape hatch: GET an allowed read-only Intune Graph path when no dedicated tool fits. " +
      "Covers /deviceManagement, /users, /groups and /devices only. Read-only — this tool never writes. " +
      "Prefer a dedicated tool when one exists. " +
      "Put OData options in `params` ($select, $filter, $expand, $orderby); on a list call use the `top` param, not $top. " +
      "NOTE: `params` is passed to Graph verbatim and is NOT sanitized — you author the OData.",
    {
      path: z
        .string()
        .describe(
          "Graph-relative path, e.g. /deviceManagement/managedDevices/{id}. No query string — use `params`."
        ),
      params: z
        .record(z.string())
        .optional()
        .describe(
          'OData query params — VALUES MUST BE STRINGS, e.g. { "$select": "id,deviceName", "$top": "5" }. Prefer the dedicated `top` param over $top ($top in params is ignored on a list call).'
        ),
      beta: z
        .boolean()
        .optional()
        .describe("Use the beta endpoint instead of v1.0 (default false)"),
      list: z
        .boolean()
        .optional()
        .describe(
          "True for a collection endpoint (paginates & formats items). Omit ONLY for a single resource addressed by id, e.g. /deviceManagement/managedDevices/{id}."
        ),
      top: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Max items for a list call (default 25, max 100)"),
      format: z
        .enum(["compact", "full"])
        .optional()
        .describe("'compact' = one line of scalar fields, 'full' (default) = pretty JSON"),
      cursor: z
        .string()
        .optional()
        .describe("Pagination cursor from a previous list response"),
    },
    async ({ path, params, beta, list, top, format, cursor }) => {
      try {
        validateGraphPath(path);
        const fmt = format ?? "full";
        const ctx = { tool: "intune_graph_get" };

        if (list) {
          const page = beta
            ? await graph.getAllBeta(path, params, ctx, top ?? 25, cursor)
            : await graph.getAll(path, params, ctx, top ?? 25, cursor);
          if (page.items.length === 0) return textResult("No results.");
          return textResult(
            paginationHeader(page.items.length, "item(s)", page.hasMore, page.nextCursor) +
              formatList(
                page.items.map((i) => formatGeneric(i, fmt)),
                fmt
              )
          );
        }

        const obj = beta
          ? await graph.getBeta(path, params, ctx)
          : await graph.get(path, params, ctx);
        // Nudge: a single GET on a collection returns a { value: [...] } envelope,
        // which formats uselessly. Point the model at list:true.
        if (obj && typeof obj === "object" && Array.isArray((obj as { value?: unknown }).value)) {
          return textResult(
            "This path returned a collection envelope. Re-call with list:true to paginate and format the items.\n\n" +
              formatGeneric(obj, fmt)
          );
        }
        return textResult(formatGeneric(obj, fmt));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
