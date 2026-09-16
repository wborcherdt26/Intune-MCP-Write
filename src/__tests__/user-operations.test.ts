import { describe, it, expect, vi } from "vitest";
import { registerUserOperationTools } from "../tools/user-operations.js";
import { GraphError } from "../graph.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const mockUser = {
  id: "user-uuid-1",
  displayName: "Alice Smith",
  userPrincipalName: "alice@contoso.com",
  mail: "alice@contoso.com",
  jobTitle: "Engineer",
  department: "IT",
  officeLocation: "Building A",
  accountEnabled: true,
};

const mockDevice = {
  id: "device-uuid-1",
  deviceName: "LAPTOP-ALICE",
  userPrincipalName: "alice@contoso.com",
  userDisplayName: "Alice Smith",
};

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }),
    getHandler(name: string): ToolHandler {
      const h = tools.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h;
    },
  };
}

function createMockGraph() {
  return {
    get: vi.fn(),
    getAll: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getBeta: vi.fn(),
    getAllBeta: vi.fn(),
    post: vi.fn().mockResolvedValue(undefined),
    postBeta: vi.fn(),
    patch: vi.fn(),
    patchBeta: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("search_users", () => {
  it("returns matching users from server-side filter", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockUser], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "Alice" });

    expect(getText(result)).toContain("Alice Smith");
    expect(getText(result)).toContain("alice@contoso.com");
    expect(graph.getAll).toHaveBeenCalledWith(
      "/users",
      expect.objectContaining({ $filter: "startsWith(displayName,'Alice')" }),
      { tool: "search_users" },
      25
    );
  });

  it("defaults to full format with all fields", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockUser], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "Alice" });

    expect(getText(result)).toContain("Job Title: Engineer");
  });

  it("returns a compact one-liner per user when format is compact", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockUser], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "Alice", format: "compact" });

    expect(getText(result)).toContain("Alice Smith | user-uuid-1 | alice@contoso.com | IT");
    expect(getText(result)).not.toContain("Job Title:");
  });

  it("falls back to UPN filter when displayName returns nothing", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [mockUser], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "alice@" });

    expect(graph.getAll).toHaveBeenCalledTimes(2);
    expect(getText(result)).toContain("Alice Smith");
  });

  it("skips client-side fallback when exactMatch is true", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "nobody", exactMatch: true });

    expect(graph.getAll).toHaveBeenCalledTimes(2);
    expect(getText(result)).toContain("No users found");
  });

  it("uses client-side fallback capped at 200", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [mockUser], hasMore: false });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("search_users");
    const result = await handler({ query: "alice" });

    expect(graph.getAll).toHaveBeenCalledTimes(3);
    const fallbackCall = graph.getAll.mock.calls[2];
    expect(fallbackCall[3]).toBe(200);
    expect(getText(result)).toContain("Alice Smith");
  });
});

describe("update_primary_user", () => {
  it("updates primary user when user is found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice)
      .mockResolvedValueOnce(mockUser);
    graph.getAll.mockResolvedValueOnce({
      items: [{ id: "old-user-id", displayName: "Bob Jones", userPrincipalName: "bob@contoso.com" }],
      hasMore: false,
    });
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("update_primary_user");
    const result = await handler({ deviceId: "device-uuid-1", userUpn: "alice@contoso.com" });

    expect(graph.post).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/device-uuid-1/users/$ref",
      { "@odata.id": `https://graph.microsoft.com/v1.0/users/${mockUser.id}` },
      { tool: "update_primary_user" }
    );
    expect(getText(result)).toContain("Primary user updated successfully");
    expect(getText(result)).toContain("Bob Jones");
    expect(getText(result)).toContain("Alice Smith");
  });

  it("returns error when user not found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice)
      .mockRejectedValueOnce(new Error("Not found"));
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("update_primary_user");
    const result = await handler({ deviceId: "device-uuid-1", userUpn: "nobody@contoso.com" });

    expect(getText(result)).toContain("not found");
    expect(graph.post).not.toHaveBeenCalled();
  });

  it("retries with DELETE then POST on 409 conflict", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice)
      .mockResolvedValueOnce(mockUser);
    graph.getAll.mockResolvedValueOnce({
      items: [{ id: "old-user-id", displayName: "Bob Jones", userPrincipalName: "bob@contoso.com" }],
      hasMore: false,
    });
    graph.post
      .mockRejectedValueOnce(new GraphError(409, "Conflict"))
      .mockResolvedValueOnce(undefined);
    graph.delete.mockResolvedValueOnce(undefined);
    registerUserOperationTools(server as never, graph as never);

    const handler = server.getHandler("update_primary_user");
    const result = await handler({ deviceId: "device-uuid-1", userUpn: "alice@contoso.com" });

    expect(graph.delete).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/device-uuid-1/users/old-user-id/$ref",
      { tool: "update_primary_user" }
    );
    expect(graph.post).toHaveBeenCalledTimes(2);
    expect(getText(result)).toContain("Primary user updated successfully");
  });
});
