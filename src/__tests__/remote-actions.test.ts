import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerRemoteActionTools } from "../tools/remote-actions.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const mockDevice = {
  id: "device-uuid-1234",
  deviceName: "LAPTOP-TEST01",
  operatingSystem: "Windows",
  osVersion: "10.0.19045",
  userPrincipalName: "test@contoso.com",
  userDisplayName: "Test User",
  managementAgent: "mdm",
  lastSyncDateTime: "2026-08-30T10:00:00Z",
};

const macDevice = {
  ...mockDevice,
  id: "device-uuid-mac",
  deviceName: "MAC-TEST01",
  operatingSystem: "macOS",
  osVersion: "14.0",
};

const iosDevice = {
  ...mockDevice,
  id: "device-uuid-ios",
  deviceName: "IPHONE-TEST01",
  operatingSystem: "iOS",
  osVersion: "17.0",
};

function createMockGraph() {
  return {
    get: vi.fn().mockResolvedValue(mockDevice),
    getAll: vi.fn(),
    getBeta: vi.fn(),
    getAllBeta: vi.fn(),
    post: vi.fn().mockResolvedValue(undefined),
    postBeta: vi.fn(),
    patch: vi.fn(),
    patchBeta: vi.fn(),
    delete: vi.fn(),
  };
}

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

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("remote-actions", () => {
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

  describe("tool registration", () => {
    it("registers only non-destructive tools when ENABLE_DESTRUCTIVE_ACTIONS is not set", () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      expect(server.registeredTools).toContain("restart_device");
      expect(server.registeredTools).toContain("remote_lock_device");
      expect(server.registeredTools).toContain("rotate_bitlocker_keys");
      expect(server.registeredTools).not.toContain("retire_device");
      expect(server.registeredTools).not.toContain("wipe_device");
    });

    it("registers all tools when ENABLE_DESTRUCTIVE_ACTIONS=true", () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      expect(server.registeredTools).toContain("restart_device");
      expect(server.registeredTools).toContain("remote_lock_device");
      expect(server.registeredTools).toContain("rotate_bitlocker_keys");
      expect(server.registeredTools).toContain("retire_device");
      expect(server.registeredTools).toContain("wipe_device");
    });

    it("does not register destructive tools when ENABLE_DESTRUCTIVE_ACTIONS=false", () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "false";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      expect(server.registeredTools).not.toContain("retire_device");
      expect(server.registeredTools).not.toContain("wipe_device");
    });
  });

  describe("restart_device", () => {
    it("sends reboot command and returns confirmation", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("restart_device");
      const result = await handler({ deviceId: "device-uuid-1234" });

      expect(graph.get).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234",
        expect.any(Object),
        { tool: "restart_device" }
      );
      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/rebootNow",
        {},
        { tool: "restart_device" }
      );
      expect(getText(result)).toContain("Restart command sent successfully");
      expect(getText(result)).toContain("LAPTOP-TEST01");
    });

    it("warns for unsupported OS", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      graph.get.mockResolvedValue(iosDevice);
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("restart_device");
      const result = await handler({ deviceId: "device-uuid-ios" });

      expect(getText(result)).toContain("not supported on iOS");
      expect(getText(result)).toContain("No reboot command was sent");
      expect(result.isError).toBe(true);
      expect(graph.post).not.toHaveBeenCalled();
    });
  });

  describe("remote_lock_device", () => {
    it("sends lock command", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("remote_lock_device");
      const result = await handler({ deviceId: "device-uuid-1234" });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/remoteLock",
        {},
        { tool: "remote_lock_device" }
      );
      expect(getText(result)).toContain("Remote lock command sent successfully");
    });
  });

  describe("rotate_bitlocker_keys", () => {
    it("sends rotation command for Windows device", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("rotate_bitlocker_keys");
      const result = await handler({ deviceId: "device-uuid-1234" });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/rotateBitLockerKeys",
        {},
        { tool: "rotate_bitlocker_keys" }
      );
      expect(getText(result)).toContain("BitLocker key rotation initiated");
    });

    it("rejects non-Windows device", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      graph.get.mockResolvedValue(macDevice);
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("rotate_bitlocker_keys");
      const result = await handler({ deviceId: "device-uuid-mac" });

      expect(getText(result)).toContain("only supported on Windows");
      expect(graph.post).not.toHaveBeenCalled();
    });
  });

  describe("retire_device", () => {
    it("retires when confirmDeviceName matches", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("retire_device");
      const result = await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "LAPTOP-TEST01",
      });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/retire",
        {},
        { tool: "retire_device" }
      );
      expect(getText(result)).toContain("Device retire command sent");
      expect(getText(result)).toContain("Company data will be removed");
    });

    it("rejects when confirmDeviceName does not match", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("retire_device");
      const result = await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "WRONG-NAME",
      });

      expect(getText(result)).toContain("Safety check failed");
      expect(getText(result)).toContain("WRONG-NAME");
      expect(getText(result)).toContain("LAPTOP-TEST01");
      expect(graph.post).not.toHaveBeenCalled();
    });
  });

  describe("wipe_device", () => {
    it("wipes when confirmDeviceName matches", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("wipe_device");
      const result = await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "LAPTOP-TEST01",
      });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/wipe",
        {},
        { tool: "wipe_device" }
      );
      expect(getText(result)).toContain("full factory reset");
    });

    it("passes keepUserData in body when set", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("wipe_device");
      await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "LAPTOP-TEST01",
        keepUserData: true,
      });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/wipe",
        { keepUserData: true },
        { tool: "wipe_device" }
      );
    });

    it("passes keepEnrollmentData in body when set", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("wipe_device");
      const result = await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "LAPTOP-TEST01",
        keepEnrollmentData: true,
      });

      expect(graph.post).toHaveBeenCalledWith(
        "/deviceManagement/managedDevices/device-uuid-1234/wipe",
        { keepEnrollmentData: true },
        { tool: "wipe_device" }
      );
      expect(getText(result)).toContain("Device will remain enrolled");
    });

    it("rejects when confirmDeviceName does not match", async () => {
      process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
      const server = createMockServer();
      const graph = createMockGraph();
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("wipe_device");
      const result = await handler({
        deviceId: "device-uuid-1234",
        confirmDeviceName: "WRONG-NAME",
      });

      expect(getText(result)).toContain("Safety check failed");
      expect(graph.post).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns error result when Graph API returns 404", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      const { GraphError } = await import("../graph.js");
      graph.get.mockRejectedValue(new GraphError(404, "Not found"));
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("restart_device");
      const result = await handler({ deviceId: "nonexistent-uuid" });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Not found");
    });

    it("returns error result when Graph API returns 403", async () => {
      delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
      const server = createMockServer();
      const graph = createMockGraph();
      const { GraphError } = await import("../graph.js");
      graph.get.mockResolvedValue(mockDevice);
      graph.post.mockRejectedValue(new GraphError(403, "Insufficient privileges"));
      registerRemoteActionTools(server as never, graph as never);

      const handler = server.getHandler("restart_device");
      const result = await handler({ deviceId: "device-uuid-1234" });

      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Access denied");
    });
  });
});
