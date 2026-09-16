import { describe, it, expect, vi } from "vitest";
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
  complianceState: "compliant",
  managementAgent: "mdm",
  enrolledDateTime: "2025-01-01T00:00:00Z",
  lastSyncDateTime: "2026-01-01T00:00:00Z",
  serialNumber: "SN12345",
  model: "Latitude 5420",
  manufacturer: "Dell",
  totalStorageSpaceInBytes: 256000000000,
  freeStorageSpaceInBytes: 128000000000,
  managedDeviceOwnerType: "company",
  deviceEnrollmentType: "windowsAzureADJoin",
  isEncrypted: true,
  azureADRegistered: true,
  azureADDeviceId: "aad-device-id-1",
  notes: "",
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
  };
}

function createMockGraph() {
  return {
    get: vi.fn(),
    getAll: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: undefined }),
    getBeta: vi.fn(),
    getAllBeta: vi.fn(),
    post: vi.fn(),
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

describe("list_devices", () => {
  it("defaults to full format with all fields", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockDevice], hasMore: false, nextCursor: undefined });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("list_devices");
    const result = await handler({});

    expect(getText(result)).toContain("Serial: SN12345");
  });

  it("returns a compact one-liner per device when format is compact", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockDevice], hasMore: false, nextCursor: undefined });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("list_devices");
    const result = await handler({ format: "compact" });

    expect(getText(result)).toContain(
      "LAPTOP-TEST01 | device-uuid-1 | test@contoso.com | Windows 10.0.19045 | compliant"
    );
    expect(getText(result)).not.toContain("Serial:");
  });
});

describe("search_devices", () => {
  it("returns matching devices from server-side filter, full format by default", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockDevice], hasMore: false });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("search_devices");
    const result = await handler({ query: "LAPTOP-TEST01" });

    expect(getText(result)).toContain("Serial: SN12345");
    expect(graph.getAll).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices",
      expect.objectContaining({ $filter: "startsWith(deviceName,'LAPTOP-TEST01')" }),
      { tool: "search_devices" },
      25
    );
  });

  it("returns a compact one-liner per device when format is compact", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockDevice], hasMore: false });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("search_devices");
    const result = await handler({ query: "LAPTOP-TEST01", format: "compact" });

    expect(getText(result)).toContain(
      "LAPTOP-TEST01 | device-uuid-1 | test@contoso.com | Windows 10.0.19045 | compliant"
    );
  });

  it("skips client-side fallback when exactMatch is true", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [], hasMore: false })
      .mockResolvedValueOnce({ items: [], hasMore: false });
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("search_devices");
    const result = await handler({ query: "nobody", exactMatch: true });

    expect(graph.getAll).toHaveBeenCalledTimes(3);
    expect(getText(result)).toContain("No devices found");
  });

  it("matches names with apostrophes via the client-side fallback (v1.3.1 regression)", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    const apostropheDevice = { ...mockDevice, deviceName: "O'Brien-Laptop" };
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false }) // deviceName filter
      .mockResolvedValueOnce({ items: [], hasMore: false }) // userPrincipalName filter
      .mockResolvedValueOnce({ items: [], hasMore: false }) // serialNumber filter
      .mockResolvedValueOnce({ items: [apostropheDevice], hasMore: false }); // 200-item fallback
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    registerDevicePropertyTools(server as never, graph as never);

    const handler = server.getHandler("search_devices");
    const result = await handler({ query: "O'Brien" });

    expect(getText(result)).toContain("O'Brien-Laptop");
  });
});
