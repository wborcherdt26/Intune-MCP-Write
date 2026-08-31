import { describe, it, expect, vi } from "vitest";
import { registerGroupMembershipTools } from "../tools/group-membership.js";
import { GraphError } from "../graph.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const mockGroup = {
  id: "group-uuid-1",
  displayName: "Test Group",
  description: "A test group",
  groupTypes: [],
  membershipRule: null,
  membershipRuleProcessingState: null,
  mailEnabled: false,
  securityEnabled: true,
};

const mockDynamicGroup = {
  ...mockGroup,
  id: "dynamic-group-uuid",
  displayName: "Dynamic Group",
  groupTypes: ["DynamicMembership"],
  membershipRule: "(user.department -eq \"IT\")",
  membershipRuleProcessingState: "On",
};

const mockUser = {
  id: "user-uuid-1",
  displayName: "Alice Smith",
  userPrincipalName: "alice@contoso.com",
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
    delete: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(),
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("add_user_to_group", () => {
  it("adds a user by UPN to an assigned group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User added to group successfully");
    expect(getText(result)).toContain("Alice Smith");
    expect(getText(result)).toContain("alice@contoso.com");
    expect(getText(result)).toContain("Test Group");
    expect(graph.post).toHaveBeenCalledWith(
      "/groups/group-uuid-1/members/$ref",
      { "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/user-uuid-1" },
      { tool: "add_user_to_group" }
    );
  });

  it("adds a user by object ID", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "user-uuid-1" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User added to group successfully");
  });

  it("rejects adding to a dynamic group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDynamicGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "dynamic-group-uuid", userId: "alice@contoso.com" });

    expect(getText(result)).toContain("dynamic group");
    expect(getText(result)).toContain("membership controlled by a rule");
    expect(graph.post).not.toHaveBeenCalled();
  });

  it("returns error when user not found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockRejectedValueOnce(new GraphError(404, "Not found"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "nobody@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Could not resolve");
  });

  it("returns error on 403 forbidden", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    graph.post.mockRejectedValueOnce(new GraphError(403, "Insufficient privileges"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Access denied");
  });
});

describe("remove_user_from_group", () => {
  it("removes a user by UPN from a group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User removed from group successfully");
    expect(getText(result)).toContain("Alice Smith");
    expect(graph.delete).toHaveBeenCalledWith(
      "/groups/group-uuid-1/members/user-uuid-1/$ref",
      { tool: "remove_user_from_group" }
    );
  });

  it("rejects removing from a dynamic group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDynamicGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "dynamic-group-uuid", userId: "alice@contoso.com" });

    expect(getText(result)).toContain("dynamic group");
    expect(graph.delete).not.toHaveBeenCalled();
  });

  it("returns error when member not found (404)", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    graph.delete.mockRejectedValueOnce(new GraphError(404, "Resource not found"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Not found");
  });
});
