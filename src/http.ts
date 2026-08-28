import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccountInfo } from "@azure/msal-node";
import type { PackageInfo, AuthContext } from "./server.js";
import { createMcpServer } from "./server.js";
import { AuthManager } from "./auth.js";
import { logger } from "./logger.js";

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  actor?: string;
}

export function startHttpServer(
  pkg: PackageInfo,
  port: number
): { shutdown: () => Promise<void> } {
  const app = express();
  app.use(express.json());

  const authManager = new AuthManager();
  const sessions = new Map<string, Session>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!sessionId && sessions.size >= MAX_SESSIONS) {
      res.status(503).json({ error: "Server at capacity — try again later" });
      return;
    }

    const sessionAuth: { account?: AccountInfo; pendingAuth?: Promise<AccountInfo> } = {};
    let sessionRef: Session | undefined;

    const auth: AuthContext = {
      getToken: async () => {
        if (!sessionAuth.account) {
          if (sessionAuth.pendingAuth) {
            throw new Error(
              "Authentication in progress. Please complete the device code flow shown earlier, " +
                "then retry this tool call."
            );
          }
          throw new Error(
            'Not authenticated. Use the "authenticate" tool to sign in first.'
          );
        }
        return authManager.getAccessToken(sessionAuth.account);
      },

      getActor: () => sessionAuth.account?.username,

      startAuth: () => {
        if (sessionAuth.account) {
          return Promise.resolve(
            `Already authenticated as ${sessionAuth.account.username}. You can use all tools now.`
          );
        }
        if (sessionAuth.pendingAuth) {
          return Promise.resolve(
            "Authentication already in progress. Please complete the device code flow shown earlier."
          );
        }

        return new Promise<string>((resolve, reject) => {
          const authPromise = authManager.authenticate((message) => {
            resolve(message);
          });

          sessionAuth.pendingAuth = authPromise;

          authPromise
            .then((account) => {
              sessionAuth.account = account;
              sessionAuth.pendingAuth = undefined;
              if (sessionRef) {
                sessionRef.actor = account.username;
              }
              logger.info("session_authenticated", {
                actor: account.username,
              });
            })
            .catch((err) => {
              sessionAuth.pendingAuth = undefined;
              reject(err);
            });
        });
      },
    };

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const session: Session = { transport, server, lastActivity: Date.now() };
        sessionRef = session;
        sessions.set(id, session);
        logger.info("session_start", {
          sessionId: id,
          activeSessions: sessions.size,
        });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        logger.info("session_end", {
          sessionId: id,
          activeSessions: sessions.size,
        });
      },
    });

    const server = createMcpServer(pkg, auth);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: pkg.name,
      version: pkg.version,
      activeSessions: sessions.size,
      maxSessions: MAX_SESSIONS,
    });
  });

  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
        session.server.close().catch(() => {});
        logger.info("session_expired", {
          sessionId: id,
          actor: session.actor,
          activeSessions: sessions.size,
        });
      }
    }
  }, 60_000);
  sweepInterval.unref();

  const httpServer = app.listen(port, () => {
    logger.info("http_start", {
      port,
      server: pkg.name,
      version: pkg.version,
    });
    console.error(`Intune MCP Write Server (HTTP) listening on port ${port}`);
    console.error(`  MCP endpoint: http://localhost:${port}/mcp`);
    console.error(`  Health check: http://localhost:${port}/health`);
  });

  return {
    async shutdown() {
      clearInterval(sweepInterval);
      const closing = [...sessions.values()].map((s) =>
        s.server.close().catch(() => {})
      );
      await Promise.all(closing);
      sessions.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info("http_stop", { server: pkg.name });
    },
  };
}
