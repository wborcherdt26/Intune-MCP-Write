#!/usr/bin/env node
import "dotenv/config";
import { AuthManager } from "./auth.js";

async function main() {
  console.log("Intune MCP Write — Sign in to Microsoft Graph\n");
  console.log(
    "This will open a device code flow. Follow the instructions below to authenticate.\n"
  );
  console.log(
    "Note: This server requires WRITE permissions. Ensure admin consent has been granted for:\n" +
    "  - DeviceManagementManagedDevices.ReadWrite.All\n" +
    "  - Device.Read.All\n" +
    "  - GroupMember.ReadWrite.All\n" +
    "  - Directory.Read.All\n"
  );

  try {
    const authManager = new AuthManager();
    const account = await authManager.authenticate((message) => {
      console.log("\n" + message + "\n");
    });
    console.log(`\nAuthenticated as: ${account.username}`);
    console.log("Token cached. The MCP server can now access Intune with write capabilities.\n");
    console.log(
      'You can now start the MCP server with "npm start" or configure it in your MCP client.'
    );
  } catch (err) {
    console.error(
      "Authentication failed:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
}

main();
