import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphClient } from "./graph.js";
import { registerDevicePropertyTools } from "./tools/device-properties.js";
import { registerGroupMembershipTools } from "./tools/group-membership.js";
import { registerRemoteActionTools } from "./tools/remote-actions.js";
import { registerUserOperationTools } from "./tools/user-operations.js";
import { registerBulkOperationTools } from "./tools/bulk-operations.js";
import { registerCompoundTools } from "./tools/compound.js";
import { registerGenericTools } from "./tools/generic.js";

export interface PackageInfo {
  name: string;
  version: string;
}

export interface AuthContext {
  getToken: () => Promise<string>;
  getActor: () => string | undefined;
  startAuth?: () => Promise<string>;
}

export function createMcpServer(pkg: PackageInfo, auth: AuthContext): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  const graph = new GraphClient(auth.getToken, auth.getActor);

  if (auth.startAuth) {
    const startAuth = auth.startAuth;
    server.tool(
      "authenticate",
      "Sign in with your Microsoft Entra ID credentials via device code flow. " +
        "Required before using any other tools in HTTP mode.",
      {},
      async () => {
        try {
          const message = await startAuth();
          return { content: [{ type: "text", text: message }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Authentication failed: ${msg}` }], isError: true };
        }
      }
    );
  }

  registerDevicePropertyTools(server, graph);
  registerGroupMembershipTools(server, graph);
  registerRemoteActionTools(server, graph);
  registerUserOperationTools(server, graph);
  registerBulkOperationTools(server, graph);
  registerCompoundTools(server, graph);
  registerGenericTools(server, graph); // last: generic fallback after all curated tools

  return server;
}
