import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphClient } from "../graph.js";
import { GraphError } from "../graph.js";
import { registerGenericTools } from "../tools/generic.js";
import { validateGraphPath, formatGeneric } from "../tools/shared.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function captureHandlers(register: (server: McpServer, graph: GraphClient) => void, graph: GraphClient) {
  const handlers = new Map<string, Handler>();
  const mockServer = {
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1] as Handler;
      handlers.set(name, handler);
    }),
  } as unknown as McpServer;
  register(mockServer, graph);
  return handlers;
}

function mockGraph(overrides: Partial<GraphClient> = {}) {
  return {
    get: vi.fn(),
    getBeta: vi.fn(),
    getAll: vi.fn(),
    getAllBeta: vi.fn(),
    ...overrides,
  } as unknown as GraphClient;
}

const SAMPLE_DEVICE = {
  id: "00000000-0000-0000-0000-000000000001",
  deviceName: "DESKTOP-TEST01",
  complianceState: "compliant",
  osVersion: "10.0.22631.1",
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#deviceManagement/managedDevices/$entity",
};

describe("validateGraphPath", () => {
  it.each([
    "/deviceManagement/managedDevices",
    "/deviceManagement/managedDevices/00000000-0000-0000-0000-000000000001",
    "/users",
    "/users/u1",
    "/users/u1/managedDevices",
    "/groups",
    "/groups/g1/members", // this repo covers groups (GroupMember + Directory.Read scopes)
    "/devices",
    "/devices/d1",
    "/devices/d1/memberOf", // and Entra device objects (Device.Read.All)
    "/DeviceManagement/managedDevices", // mixed case accepted
  ])("accepts %s", (path) => {
    expect(() => validateGraphPath(path)).not.toThrow();
  });

  it.each([
    "",
    "deviceManagement/managedDevices", // no leading slash
    "/servicePrincipals",
    "/directoryObjects",
    "/organization",
    "/deviceManagementFoo", // delimiter discipline
    "/devicesX", // delimiter discipline
    "//evil",
    "https://graph.microsoft.com/v1.0/users",
    "/users/..%2f/groups", // contains ".."
    "/deviceManagement/x?$top=1", // query in path
    "/deviceManagement\\x", // backslash
    "/deviceManagement/\x01x", // control char
  ])("rejects %j", (path) => {
    expect(() => validateGraphPath(path)).toThrow();
  });

  it("surfaces the guidance message verbatim (plain Error, not rewritten by status)", () => {
    expect(() => validateGraphPath("/servicePrincipals")).toThrow(/only covers/);
    // Prove it is NOT a GraphError (which errorText would rewrite to "Access denied").
    try {
      validateGraphPath("/servicePrincipals");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GraphError);
    }
  });
});

describe("formatGeneric", () => {
  it("compact: scalars as k=v joined by |, nested collapsed, odata stripped", () => {
    const out = formatGeneric(
      { id: "1", name: "x", nested: { a: 1 }, list: [1, 2], "@odata.context": "ctx" },
      "compact"
    );
    expect(out).toBe("id=1 | name=x | nested=[object] | list=[array]");
    expect(out).not.toContain("@odata.context");
  });

  it("full: pretty JSON with odata noise removed, real fields intact", () => {
    const out = formatGeneric(
      {
        id: "1",
        deviceName: "x",
        "@odata.context": "ctx",
        "@odata.nextLink": "n",
        "@odata.count": 5,
      },
      "full"
    );
    expect(out).not.toContain("@odata.context");
    expect(out).not.toContain("@odata.nextLink");
    expect(out).not.toContain("@odata.count");
    expect(out).toContain('"id": "1"');
    expect(out).toContain('"deviceName": "x"');
  });

  it("returns String() for non-objects", () => {
    expect(formatGeneric(null, "full")).toBe("null");
    expect(formatGeneric(42, "compact")).toBe("42");
  });
});

describe("intune_graph_get", () => {
  let graph: GraphClient;
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    graph = mockGraph();
    handlers = captureHandlers(registerGenericTools, graph);
  });

  const call = (args: Record<string, unknown>) => handlers.get("intune_graph_get")!(args);

  it("single: calls get with (path, params, {tool}) and formats the object", async () => {
    (graph.get as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_DEVICE);

    const result = await call({
      path: "/deviceManagement/managedDevices/00000000-0000-0000-0000-000000000001",
      params: { $select: "id,deviceName" },
    });

    expect(graph.get).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices/00000000-0000-0000-0000-000000000001",
      { $select: "id,deviceName" },
      { tool: "intune_graph_get" }
    );
    expect(result.content[0].text).toContain("DESKTOP-TEST01");
    expect(result.content[0].text).not.toContain("@odata.context");
    expect(result.isError).toBeUndefined();
  });

  it("beta:true single → getBeta, not get", async () => {
    (graph.getBeta as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_DEVICE);

    await call({ path: "/deviceManagement/managedDevices/x", beta: true });

    expect(graph.getBeta).toHaveBeenCalled();
    expect(graph.get).not.toHaveBeenCalled();
  });

  it("list:true → getAll with top/cursor forwarded, paginationHeader + formatList", async () => {
    (graph.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [SAMPLE_DEVICE, { ...SAMPLE_DEVICE, id: "2", deviceName: "DESKTOP-TEST02" }],
      hasMore: true,
      nextCursor: "CURSOR123",
    });

    const result = await call({
      path: "/deviceManagement/managedDevices",
      list: true,
      top: 10,
      cursor: "PREV",
      format: "compact",
    });

    expect(graph.getAll).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices",
      undefined,
      { tool: "intune_graph_get" },
      10,
      "PREV"
    );
    const text = result.content[0].text;
    expect(text).toContain("2 item(s)");
    expect(text).toContain("(more available)");
    expect(text).toContain("CURSOR123");
    expect(text).toContain("DESKTOP-TEST01");
    expect(text).toContain("DESKTOP-TEST02");
  });

  it("beta:true + list:true → getAllBeta", async () => {
    (graph.getAllBeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [SAMPLE_DEVICE],
      hasMore: false,
    });

    await call({ path: "/deviceManagement/managedDevices", list: true, beta: true });

    expect(graph.getAllBeta).toHaveBeenCalled();
    expect(graph.getAll).not.toHaveBeenCalled();
  });

  it("list:true defaults top to 25 when omitted", async () => {
    (graph.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [SAMPLE_DEVICE], hasMore: false });

    await call({ path: "/deviceManagement/managedDevices", list: true });

    expect(graph.getAll).toHaveBeenCalledWith(
      "/deviceManagement/managedDevices",
      undefined,
      { tool: "intune_graph_get" },
      25,
      undefined
    );
  });

  it("covers /groups via the wider allowlist (list)", async () => {
    (graph.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ id: "g1", displayName: "IT Admins" }],
      hasMore: false,
    });

    const result = await call({ path: "/groups", list: true, format: "compact" });

    expect(graph.getAll).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("IT Admins");
  });

  it("single GET returning a { value: [...] } envelope → nudges toward list:true", async () => {
    (graph.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      "@odata.context": "ctx",
      value: [SAMPLE_DEVICE],
    });

    const result = await call({ path: "/deviceManagement/managedDevices" });

    expect(result.content[0].text).toContain("Re-call with list:true");
    expect(result.isError).toBeUndefined();
  });

  it("empty list → 'No results.'", async () => {
    (graph.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], hasMore: false });

    const result = await call({ path: "/deviceManagement/managedDevices", list: true });

    expect(result.content[0].text).toBe("No results.");
  });

  it("off-allowlist path → no Graph call, isError with verbatim guidance", async () => {
    const result = await call({ path: "/servicePrincipals" });

    expect(graph.get).not.toHaveBeenCalled();
    expect(graph.getAll).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    // Proves the message was NOT rewritten to the generic "Access denied" text.
    expect(result.content[0].text).toContain("only covers");
    expect(result.content[0].text).not.toContain("Access denied");
  });

  it("GraphError(500) from the client → mapped by errorResult", async () => {
    (graph.get as ReturnType<typeof vi.fn>).mockRejectedValue(new GraphError(500, "boom"));

    const result = await call({ path: "/deviceManagement/managedDevices/x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500");
  });
});
