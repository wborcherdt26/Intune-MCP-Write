import { describe, it, expect, vi } from "vitest";
import { registerCompoundTools } from "../tools/compound.js";

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

const mockAadDeviceForResolve = {
  id: "device-object-id-1",
  displayName: "LAPTOP-TEST01",
  deviceId: "aad-device-id-1",
};

const mockGroup = {
  "@odata.type": "#microsoft.graph.group",
  id: "group-uuid-1",
  displayName: "Test Group",
  description: "A test group",
  groupTypes: [] as string[],
  membershipRule: null,
  membershipRuleProcessingState: null,
  mailEnabled: false,
  securityEnabled: true,
};

const mockMember = {
  "@odata.type": "#microsoft.graph.user",
  id: "user-uuid-1",
  displayName: "Alice Smith",
  userPrincipalName: "alice@contoso.com",
  accountEnabled: true,
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

describe("get_device_overview", () => {
  it("combines device details, resolved object ID, and group memberships, compact by default", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice) // get_device_overview's own device fetch
      .mockResolvedValueOnce(mockAadDeviceForResolve); // resolveToObjectId's direct object-ID hit
    graph.getAll.mockResolvedValueOnce({ items: [mockGroup], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("get_device_overview");
    const result = await handler({ deviceId: "device-uuid-1" });

    expect(getText(result)).toContain("LAPTOP-TEST01");
    expect(getText(result)).toContain("Azure AD Object ID: device-object-id-1");
    expect(getText(result)).toContain("Test Group");
  });

  it("still returns device details when group resolution fails", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice)
      .mockRejectedValue(new Error("not found"));
    graph.getAll.mockRejectedValue(new Error("not found"));
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("get_device_overview");
    const result = await handler({ deviceId: "device-uuid-1" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("LAPTOP-TEST01");
    expect(getText(result)).toContain("Unable to resolve directory object ID");
  });

  it("includes all device fields when format is full", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDevice)
      .mockResolvedValueOnce(mockAadDeviceForResolve);
    graph.getAll.mockResolvedValueOnce({ items: [mockGroup], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("get_device_overview");
    const result = await handler({ deviceId: "device-uuid-1", format: "full" });

    expect(getText(result)).toContain("Serial: SN12345");
    expect(getText(result)).toContain("Description: A test group");
  });
});

describe("search_device_overview", () => {
  it("auto-expands to a full overview on exactly one match", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockAadDeviceForResolve);
    graph.getAll
      .mockResolvedValueOnce({ items: [mockDevice], hasMore: false }) // search match
      .mockResolvedValueOnce({ items: [mockGroup], hasMore: false }); // group memberships
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("search_device_overview");
    const result = await handler({ query: "LAPTOP-TEST01" });

    expect(getText(result)).toContain("LAPTOP-TEST01");
    expect(getText(result)).toContain("Test Group");
  });

  it("returns a disambiguation list for multiple matches", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    const secondDevice = { ...mockDevice, id: "device-uuid-2", deviceName: "LAPTOP-TEST02" };
    graph.getAll.mockResolvedValueOnce({ items: [mockDevice, secondDevice], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("search_device_overview");
    const result = await handler({ query: "LAPTOP" });

    expect(getText(result)).toContain("2 devices match");
    expect(getText(result)).toContain("get_device_overview");
    expect(getText(result)).toContain("LAPTOP-TEST01");
    expect(getText(result)).toContain("LAPTOP-TEST02");
  });

  it("returns a no-match message when nothing matches", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValue({ items: [], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("search_device_overview");
    const result = await handler({ query: "nobody" });

    expect(getText(result)).toContain("No devices found");
  });
});

describe("get_group_overview", () => {
  it("combines group metadata and members, compact by default", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    graph.getAll.mockResolvedValueOnce({ items: [mockMember], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("get_group_overview");
    const result = await handler({ groupId: "group-uuid-1" });

    expect(getText(result)).toContain("Test Group");
    expect(getText(result)).toContain("Alice Smith");
  });

  it("adds account status details for members when format is full", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    graph.getAll.mockResolvedValueOnce({ items: [mockMember], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("get_group_overview");
    const result = await handler({ groupId: "group-uuid-1", format: "full" });

    expect(getText(result)).toContain("Account Enabled: true");
  });
});

describe("search_group_overview", () => {
  it("auto-expands to a full overview on exactly one match", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll
      .mockResolvedValueOnce({ items: [mockGroup], hasMore: false }) // search match
      .mockResolvedValueOnce({ items: [mockMember], hasMore: false }); // members
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("search_group_overview");
    const result = await handler({ query: "Test" });

    expect(getText(result)).toContain("Test Group");
    expect(getText(result)).toContain("Alice Smith");
  });

  it("returns a disambiguation list for multiple matches", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    const secondGroup = { ...mockGroup, id: "group-uuid-2", displayName: "Second Group" };
    graph.getAll.mockResolvedValueOnce({ items: [mockGroup, secondGroup], hasMore: false });
    registerCompoundTools(server as never, graph as never);

    const handler = server.getHandler("search_group_overview");
    const result = await handler({ query: "Group" });

    expect(getText(result)).toContain("2 groups match");
    expect(getText(result)).toContain("get_group_overview");
  });
});
