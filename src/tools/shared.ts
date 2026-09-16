import { GraphError } from "../graph.js";

export function errorText(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.status === 401) return "Authentication failed — token may have expired. Try running \"intune-mcp-write-auth\" to re-authenticate.";
    if (err.status === 403) return "Access denied — your account lacks permission for this operation. Verify the app registration has the required write permissions and admin consent has been granted.";
    if (err.status === 404) return "Not found — the requested resource does not exist. Verify the ID is correct.";
    if (err.status === 409) return "Conflict — the resource was modified by another process. Retry the operation.";
    return `Graph API error (${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(err: unknown) {
  return { ...textResult(errorText(err)), isError: true as const };
}

export function paginationHeader(count: number, label: string, hasMore: boolean, nextCursor?: string): string {
  const more = hasMore ? " (more available)" : "";
  const cursor = nextCursor ? `\nNext page cursor: ${nextCursor}\n` : "";
  return `${count} ${label}${more}:${cursor}\n`;
}

export function sanitizeSearchQuery(query: string): string {
  const cleaned = query.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255);
  return cleaned.replace(/'/g, "''");
}

export function odataTypeLabel(
  odataType: string | undefined,
  labels: Record<string, string>
): string {
  if (!odataType) return "Unknown";
  return labels[odataType] ?? odataType.replace("#microsoft.graph.", "");
}

export type ResponseFormat = "compact" | "full";

export function formatList(items: string[], format: ResponseFormat): string {
  return items.join(format === "compact" ? "\n" : "\n\n---\n\n");
}

export function isDestructiveActionsEnabled(): boolean {
  return process.env.ENABLE_DESTRUCTIVE_ACTIONS === "true";
}

// Allowlist for the intune_graph_get read-only escape hatch. Tracks this repo's
// granted delegated scopes (DeviceManagement*.ReadWrite.All, Device.Read.All,
// Directory.Read.All, GroupMember.ReadWrite.All, User.Read.All) — broader than the
// read repo because this server also GETs /groups and /devices for group membership
// and device-object resolution. The tool only ever issues GET requests, so it cannot
// write even though the token could; that method boundary is the core safety argument.
// Lowercased on purpose — validateGraphPath compares against a lowercased copy of the path.
const ALLOWED_PREFIXES = ["/devicemanagement", "/users", "/groups", "/devices"] as const;
// Human-readable form for the rejection message (case is cosmetic; the server is case-insensitive).
const ALLOWED_PREFIXES_LABEL = "/deviceManagement, /users, /groups and /devices";

/**
 * Safety boundary for intune_graph_get. Throws a plain Error (NOT GraphError) on
 * reject: errorText rewrites GraphError messages by status code (403 → "Access
 * denied…", plus 401/404/409), which would swallow this guidance text. A plain Error
 * hits errorText's fallback and surfaces the message verbatim while errorResult still
 * sets isError. Validation never touches Graph, so a Graph status would mislead.
 */
export function validateGraphPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Path must be a Graph-relative path starting with '/'.");
  }
  // Reject absolute URLs, protocol-relative, traversal, embedded query, control chars, backslash.
  if (
    path.includes("://") ||
    path.startsWith("//") ||
    path.includes("..") ||
    path.includes("?") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path)
  ) {
    throw new Error(
      "Path contains a disallowed sequence (query string, traversal, or absolute URL). Put OData options in `params`."
    );
  }
  // Graph paths are case-insensitive server-side: compare on a lowercased copy so
  // /DeviceManagement/... is accepted, but callers pass the ORIGINAL path to Graph.
  const lower = path.toLowerCase();
  const allowed = ALLOWED_PREFIXES.some((p) => lower === p || lower.startsWith(p + "/"));
  if (!allowed) {
    throw new Error(
      `Path not permitted — this Intune escape hatch only covers ${ALLOWED_PREFIXES_LABEL}. Use a dedicated tool for anything else.`
    );
  }
}

const ODATA_NOISE = new Set(["@odata.context", "@odata.nextLink", "@odata.count"]);

/**
 * Generic renderer for intune_graph_get. compact = top-level scalar fields on one
 * line (nested objects/arrays collapsed to a placeholder); full = pretty JSON with
 * Graph @odata noise stripped.
 */
export function formatGeneric(obj: unknown, format: ResponseFormat): string {
  if (obj === null || typeof obj !== "object") return String(obj);
  const record = obj as Record<string, unknown>;
  if (format === "compact") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(record)) {
      if (ODATA_NOISE.has(k)) continue;
      if (v === null || typeof v !== "object") parts.push(`${k}=${v}`);
      else parts.push(`${k}=[${Array.isArray(v) ? "array" : "object"}]`);
    }
    return parts.join(" | ");
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!ODATA_NOISE.has(k)) clean[k] = v;
  return JSON.stringify(clean, null, 2);
}
