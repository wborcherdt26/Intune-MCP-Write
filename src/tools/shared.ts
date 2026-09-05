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
