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

export function odataTypeLabel(
  odataType: string,
  labels: Record<string, string>
): string {
  return labels[odataType] ?? odataType.replace("#microsoft.graph.", "");
}
