#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AuthManager } from "./auth.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./http.js";
import { closeLogger, logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const useHttp =
  process.argv.includes("--http") ||
  process.env.TRANSPORT === "http";

let shuttingDown = false;

async function shutdown(cleanup: () => Promise<void>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await cleanup();
  closeLogger();
  process.exit(0);
}

if (useHttp) {
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag !== -1
    ? Number(process.argv[portFlag + 1])
    : Number(process.env.PORT) || 3001;

  const { shutdown: httpShutdown } = startHttpServer(pkg, port);

  process.on("SIGINT", () => shutdown(httpShutdown));
  process.on("SIGTERM", () => shutdown(httpShutdown));
} else {
  const authManager = new AuthManager();
  const account = await authManager.getFirstAccount();
  if (!account) {
    console.error(
      'No cached credentials found. Run "npm run auth" to sign in first.'
    );
    process.exit(1);
  }

  const server = createMcpServer(pkg, {
    getToken: () => authManager.getAccessToken(account),
    getActor: () => account.username ?? undefined,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", () => shutdown(() => server.close()));
  process.on("SIGTERM", () => shutdown(() => server.close()));
}
