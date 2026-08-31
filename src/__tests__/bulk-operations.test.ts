import { describe, it, expect, vi } from "vitest";
import { registerBulkOperationTools } from "../tools/bulk-operations.js";
import { GraphError } from "../graph.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

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
    patch: vi.fn().mockResolvedValue(undefined),
    patchBeta: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("bulk_sync_devices", () => {
  it("syncs all devices successfully", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce({ id: "d1", deviceName: "LAPTOP-01" })
      .mockResolvedValueOnce({ id: "d2", deviceName: "LAPTOP-02" });
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_sync_devices");
    const result = await handler({ deviceIds: ["d1", "d2"], pacingMs: 0 });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("2/2 succeeded");
    expect(getText(result)).toContain("LAPTOP-01");
    expect(getText(result)).toContain("LAPTOP-02");
    expect(graph.post).toHaveBeenCalledTimes(2);
  });

  it("reports partial failures per device", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce({ id: "d1", deviceName: "LAPTOP-01" })
      .mockRejectedValueOnce(new GraphError(404, "Not found"));
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_sync_devices");
    const result = await handler({ deviceIds: ["d1", "d2"], pacingMs: 0 });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("1/2 succeeded");
    expect(getText(result)).toContain("1 failed");
    expect(getText(result)).toContain("[OK]");
    expect(getText(result)).toContain("[FAIL]");
  });

  it("handles all failures gracefully", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockRejectedValueOnce(new GraphError(404, "Not found"))
      .mockRejectedValueOnce(new GraphError(403, "Forbidden"));
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_sync_devices");
    const result = await handler({ deviceIds: ["d1", "d2"], pacingMs: 0 });

    expect(getText(result)).toContain("0/2 succeeded");
    expect(getText(result)).toContain("2 failed");
  });
});

describe("bulk_rename_devices", () => {
  it("renames all devices successfully with before/after", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce({ id: "d1", deviceName: "OLD-NAME-1" })
      .mockResolvedValueOnce({ id: "d2", deviceName: "OLD-NAME-2" });
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_rename_devices");
    const result = await handler({
      devices: [
        { deviceId: "d1", newName: "NEW-NAME-1" },
        { deviceId: "d2", newName: "NEW-NAME-2" },
      ],
      pacingMs: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("2/2 succeeded");
    expect(getText(result)).toContain('"OLD-NAME-1" → "NEW-NAME-1"');
    expect(getText(result)).toContain('"OLD-NAME-2" → "NEW-NAME-2"');
    expect(graph.patch).toHaveBeenCalledTimes(2);
  });

  it("reports failures when PATCH fails", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({ id: "d1", deviceName: "OLD-NAME" });
    graph.patch.mockRejectedValueOnce(new GraphError(400, "Bad Request"));
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_rename_devices");
    const result = await handler({
      devices: [{ deviceId: "d1", newName: "NEW-NAME" }],
      pacingMs: 0,
    });

    expect(getText(result)).toContain("0/1 succeeded");
    expect(getText(result)).toContain("[FAIL]");
  });
});

describe("bulk_group_add", () => {
  const mockGroup = {
    id: "group-uuid-1",
    displayName: "Test Group",
    groupTypes: [],
  };

  it("adds all members successfully", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_group_add");
    const result = await handler({
      groupId: "group-uuid-1",
      memberIds: ["member-1", "member-2", "member-3"],
      pacingMs: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("Test Group");
    expect(getText(result)).toContain("3/3 succeeded");
    expect(graph.post).toHaveBeenCalledTimes(3);
    expect(graph.post).toHaveBeenCalledWith(
      "/groups/group-uuid-1/members/$ref",
      { "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/member-1" },
      { tool: "bulk_group_add" }
    );
  });

  it("rejects adding to a dynamic group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({
      ...mockGroup,
      groupTypes: ["DynamicMembership"],
      displayName: "Dynamic Group",
    });
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_group_add");
    const result = await handler({
      groupId: "group-uuid-1",
      memberIds: ["member-1"],
      pacingMs: 0,
    });

    expect(getText(result)).toContain("dynamic group");
    expect(graph.post).not.toHaveBeenCalled();
  });

  it("reports partial failures for already-existing members", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    graph.post
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new GraphError(400, "One or more added object references already exist"))
      .mockResolvedValueOnce(undefined);
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_group_add");
    const result = await handler({
      groupId: "group-uuid-1",
      memberIds: ["member-1", "member-2", "member-3"],
      pacingMs: 0,
    });

    expect(getText(result)).toContain("2/3 succeeded");
    expect(getText(result)).toContain("1 failed");
    expect(getText(result)).toContain("already exist");
  });

  it("returns error when group not found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockRejectedValueOnce(new GraphError(404, "Not found"));
    registerBulkOperationTools(server as never, graph as never);

    const handler = server.getHandler("bulk_group_add");
    const result = await handler({
      groupId: "nonexistent-group",
      memberIds: ["member-1"],
      pacingMs: 0,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Not found");
  });
});
