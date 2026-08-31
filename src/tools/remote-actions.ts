import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphClient } from "../graph.js";
import { textResult, errorResult } from "./errors.js";

interface ManagedDeviceSummary {
  id: string;
  deviceName: string;
  operatingSystem: string;
  osVersion: string;
  userPrincipalName: string;
  userDisplayName: string;
  managementAgent: string;
  lastSyncDateTime: string;
}

const DEVICE_SUMMARY_SELECT = [
  "id", "deviceName", "operatingSystem", "osVersion",
  "userPrincipalName", "userDisplayName", "managementAgent", "lastSyncDateTime",
].join(",");

function destructiveActionsEnabled(): boolean {
  return process.env.ENABLE_DESTRUCTIVE_ACTIONS === "true";
}

export function registerRemoteActionTools(
  server: McpServer,
  graph: GraphClient
): void {

  // --- Non-destructive actions ---

  server.tool(
    "restart_device",
    "Restart (reboot) a managed device remotely. Supported on Windows, Android, and macOS. " +
      "WRITE OPERATION — this sends a reboot command to the device.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
    },
    async ({ deviceId }) => {
      try {
        const device = await graph.get<ManagedDeviceSummary>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SUMMARY_SELECT },
          { tool: "restart_device" }
        );

        const supportedOs = ["windows", "android", "macos"];
        const os = device.operatingSystem?.toLowerCase() ?? "";
        if (!supportedOs.some((s) => os.includes(s))) {
          return {
            ...textResult(
              `Restart is not supported on ${device.operatingSystem || "unknown OS"}. ` +
              `No reboot command was sent.\n` +
              `  Supported platforms: Windows, Android, macOS.\n` +
              `  Device: ${device.deviceName} (${device.operatingSystem} ${device.osVersion})`
            ),
            isError: true as const,
          };
        }

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/rebootNow`,
          {},
          { tool: "restart_device" }
        );

        return textResult(
          `Restart command sent successfully.\n` +
          `  Device: ${device.deviceName}\n` +
          `  OS: ${device.operatingSystem} ${device.osVersion}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  The device will reboot on its next connection.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "remote_lock_device",
    "Remotely lock a managed device. Supported on iOS, Android, and macOS. " +
      "On Windows, use this only for devices enrolled with an EAS password. " +
      "WRITE OPERATION — this sends a lock command to the device.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
    },
    async ({ deviceId }) => {
      try {
        const device = await graph.get<ManagedDeviceSummary>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SUMMARY_SELECT },
          { tool: "remote_lock_device" }
        );

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/remoteLock`,
          {},
          { tool: "remote_lock_device" }
        );

        return textResult(
          `Remote lock command sent successfully.\n` +
          `  Device: ${device.deviceName}\n` +
          `  OS: ${device.operatingSystem} ${device.osVersion}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  The device will lock on its next connection.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "rotate_bitlocker_keys",
    "Rotate the BitLocker recovery keys for a Windows device. The device must be encrypted with BitLocker. " +
      "WRITE OPERATION — this triggers key rotation on the device.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
    },
    async ({ deviceId }) => {
      try {
        const device = await graph.get<ManagedDeviceSummary>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SUMMARY_SELECT },
          { tool: "rotate_bitlocker_keys" }
        );

        const os = device.operatingSystem?.toLowerCase() ?? "";
        if (!os.includes("windows")) {
          return textResult(
            `BitLocker key rotation is only supported on Windows devices.\n` +
            `  Device: ${device.deviceName}\n` +
            `  OS: ${device.operatingSystem} ${device.osVersion}`
          );
        }

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/rotateBitLockerKeys`,
          {},
          { tool: "rotate_bitlocker_keys" }
        );

        return textResult(
          `BitLocker key rotation initiated.\n` +
          `  Device: ${device.deviceName}\n` +
          `  OS: ${device.operatingSystem} ${device.osVersion}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  New recovery keys will be escrowed to Azure AD.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // --- Destructive actions (gated by ENABLE_DESTRUCTIVE_ACTIONS) ---

  if (!destructiveActionsEnabled()) return;

  server.tool(
    "retire_device",
    "DESTRUCTIVE — Retire a managed device, removing all company data while preserving personal data. " +
      "This removes company email, apps, and settings. Personal files and apps are kept. " +
      "Requires confirmDeviceName to match the device's actual name as a safety check. " +
      "WRITE OPERATION — this action cannot be undone.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      confirmDeviceName: z.string().describe(
        "Must exactly match the device's display name. Fetch the device first to confirm the name."
      ),
    },
    async ({ deviceId, confirmDeviceName }) => {
      try {
        const device = await graph.get<ManagedDeviceSummary>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SUMMARY_SELECT },
          { tool: "retire_device" }
        );

        if (device.deviceName !== confirmDeviceName) {
          return textResult(
            `Safety check failed — device name does not match.\n` +
            `  Expected: "${confirmDeviceName}"\n` +
            `  Actual: "${device.deviceName}"\n` +
            `  Fetch the device details first and use the exact device name.`
          );
        }

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/retire`,
          {},
          { tool: "retire_device" }
        );

        return textResult(
          `Device retire command sent.\n` +
          `  Device: ${device.deviceName}\n` +
          `  OS: ${device.operatingSystem} ${device.osVersion}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  Company data will be removed. Personal data will be preserved.`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "wipe_device",
    "DESTRUCTIVE — Factory reset a managed device, removing ALL data including personal files. " +
      "This restores the device to its out-of-box state. " +
      "Set keepUserData to true to preserve the user profile (Windows only). " +
      "Requires confirmDeviceName to match the device's actual name as a safety check. " +
      "WRITE OPERATION — this action cannot be undone.",
    {
      deviceId: z.string().uuid().describe("The Intune managed device ID (GUID)"),
      confirmDeviceName: z.string().describe(
        "Must exactly match the device's display name. Fetch the device first to confirm the name."
      ),
      keepUserData: z.boolean().optional().describe(
        "If true, keep the user's profile data during wipe (Windows only). Default: false (full wipe)."
      ),
      keepEnrollmentData: z.boolean().optional().describe(
        "If true, keep the device enrolled in Intune after wipe. Default: false."
      ),
    },
    async ({ deviceId, confirmDeviceName, keepUserData, keepEnrollmentData }) => {
      try {
        const device = await graph.get<ManagedDeviceSummary>(
          `/deviceManagement/managedDevices/${deviceId}`,
          { $select: DEVICE_SUMMARY_SELECT },
          { tool: "wipe_device" }
        );

        if (device.deviceName !== confirmDeviceName) {
          return textResult(
            `Safety check failed — device name does not match.\n` +
            `  Expected: "${confirmDeviceName}"\n` +
            `  Actual: "${device.deviceName}"\n` +
            `  Fetch the device details first and use the exact device name.`
          );
        }

        const body: Record<string, boolean> = {};
        if (keepUserData === true) body.keepUserData = true;
        if (keepEnrollmentData === true) body.keepEnrollmentData = true;

        await graph.post(
          `/deviceManagement/managedDevices/${deviceId}/wipe`,
          body,
          { tool: "wipe_device" }
        );

        const mode = keepUserData ? "wipe (preserving user data)" : "full factory reset";
        const enrollment = keepEnrollmentData ? "Device will remain enrolled." : "Device enrollment will be removed.";

        return textResult(
          `Device wipe command sent — ${mode}.\n` +
          `  Device: ${device.deviceName}\n` +
          `  OS: ${device.operatingSystem} ${device.osVersion}\n` +
          `  User: ${device.userDisplayName} (${device.userPrincipalName})\n` +
          `  ${enrollment}`
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
