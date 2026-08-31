import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerDevicePropertyTools } from "../tools/device-properties.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const mockDevice = {
  id: "device-uuid-1",
  deviceName: "LAPTOP-TEST01",
  userPrincipalName: "test@contoso.com",
  userDisplayName: "Test User",
  operatingSystem: "Windows",
  osVersion: "10.0.19045",
  serialNumber: "SN12345",
  deviceCategoryDisplayName: "Corporate Laptops",
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
    get registeredTools() {
      return [...tools.keys()];
    },
  };
}

function createMockGraph() {
  return {
    get: vi.fn().mockResolvedValue(mockDevice),
    getAll: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: undefined }),
    getBeta: vi.fn(),
    getAllBeta: vi.fn(),
    post: vi.fn().mockResolvedValue(undefined),
    postBeta: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
    patchBeta: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("list_device_categories", () => {
  it("lists available categories", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({
      items: [
        { id: "cat-1", displayName: "Corporate Laptops", description: "Company-issued laptops" },
        { id: "cat-2", displayName: "BYOD", description: "Personal devices" },
      ],
      hasMore: false,
    });
    // Need to handle list_devices getAll call as well
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("list_device_categories");
    const result = await handler({});

    expect(getText(result)).toContain("Corporate Laptops");
    expect(getText(result)).toContain("BYOD");
    expect(getText(result)).toContain("2 device category");
  });

  it("returns message when no categories exist", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [], hasMore: false });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("list_device_categories");
    const result = await handler({});

    expect(getText(result)).toContain("No device categories");
  });
});

describe("update_device_category", () => {
  it("assigns category by name", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValue({
      items: [
        { id: "cat-1", displayName: "Corporate Laptops" },
        { id: "cat-2", displayName: "BYOD" },
      ],
      hasMore: false,
    });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("update_device_category");
    const result = await handler({ deviceId: "device-uuid-1", categoryName: "BYOD" });

    expect(graph.put).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/device-uuid-1/deviceCategory/$ref",
      { "@odata.id": "https://graph.microsoft.com/v1.0/deviceManagement/deviceCategories/cat-2" },
      { tool: "update_device_category" }
    );
    expect(getText(result)).toContain("Device category updated successfully");
    expect(getText(result)).toContain("BYOD");
  });

  it("assigns category by ID", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("update_device_category");
    const result = await handler({ deviceId: "device-uuid-1", categoryId: "cat-direct" });

    expect(graph.put).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/device-uuid-1/deviceCategory/$ref",
      { "@odata.id": "https://graph.microsoft.com/v1.0/deviceManagement/deviceCategories/cat-direct" },
      { tool: "update_device_category" }
    );
    expect(getText(result)).toContain("Device category updated successfully");
  });

  it("returns error when category name not found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValue({
      items: [{ id: "cat-1", displayName: "Corporate Laptops" }],
      hasMore: false,
    });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("update_device_category");
    const result = await handler({ deviceId: "device-uuid-1", categoryName: "Nonexistent" });

    expect(getText(result)).toContain("not found");
    expect(getText(result)).toContain("Corporate Laptops");
    expect(graph.put).not.toHaveBeenCalled();
  });

  it("returns error when neither name nor ID provided", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("update_device_category");
    const result = await handler({ deviceId: "device-uuid-1" });

    expect(getText(result)).toContain("Provide either categoryName or categoryId");
  });
});

describe("delete_device", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ENABLE_DESTRUCTIVE_ACTIONS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    } else {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = originalEnv;
    }
  });

  it("is not registered when ENABLE_DESTRUCTIVE_ACTIONS is not set", () => {
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    const server = createMockServer();
    const graph = createMockGraph();
    registerDevicePropertyTools(server as never, graph as never);

    expect(server.registeredTools).not.toContain("delete_device");
  });

  it("is registered when ENABLE_DESTRUCTIVE_ACTIONS=true", () => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
    const server = createMockServer();
    const graph = createMockGraph();
    registerDevicePropertyTools(server as never, graph as never);

    expect(server.registeredTools).toContain("delete_device");
  });

  it("deletes when confirmDeviceName matches", async () => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
    const server = createMockServer();
    const graph = createMockGraph();
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("delete_device");
    const result = await handler({
      deviceId: "device-uuid-1",
      confirmDeviceName: "LAPTOP-TEST01",
    });

    expect(graph.delete).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/device-uuid-1",
      { tool: "delete_device" }
    );
    expect(getText(result)).toContain("Device deleted from Intune management");
  });

  it("rejects when confirmDeviceName does not match", async () => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
    const server = createMockServer();
    const graph = createMockGraph();
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("delete_device");
    const result = await handler({
      deviceId: "device-uuid-1",
      confirmDeviceName: "WRONG-NAME",
    });

    expect(getText(result)).toContain("Safety check failed");
    expect(graph.delete).not.toHaveBeenCalled();
  });
});
