import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".intune-mcp-write", "logs");
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;

export interface LogContext {
  tool?: string;
  actor?: string;
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: "info" | "error";
  event: string;
  [key: string]: unknown;
}

let stream: fs.WriteStream | null = null;
let bytesWritten = 0;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }
}

function currentLogFile(): string {
  return path.join(LOG_DIR, "intune-mcp-write.log");
}

function getOrOpenStream(): fs.WriteStream {
  if (!stream || stream.destroyed) {
    ensureLogDir();
    const logFile = currentLogFile();
    try {
      bytesWritten = fs.statSync(logFile).size;
    } catch {
      bytesWritten = 0;
    }
    stream = fs.createWriteStream(logFile, { flags: "a" });
    stream.on("error", () => {});
  }
  return stream;
}

function rotateIfNeeded(): void {
  if (bytesWritten < MAX_LOG_SIZE) return;

  if (stream) {
    stream.end();
    stream = null;
  }

  const logFile = currentLogFile();
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const older = path.join(LOG_DIR, `intune-mcp-write.${i}.log`);
    const newer = path.join(LOG_DIR, `intune-mcp-write.${i - 1}.log`);
    if (i === 1) {
      if (fs.existsSync(logFile)) {
        fs.renameSync(logFile, path.join(LOG_DIR, "intune-mcp-write.1.log"));
      }
    } else if (fs.existsSync(newer)) {
      fs.renameSync(newer, older);
    }
  }

  bytesWritten = 0;
}

function write(entry: LogEntry): void {
  try {
    rotateIfNeeded();
    const line = JSON.stringify(entry) + "\n";
    getOrOpenStream().write(line);
    bytesWritten += Buffer.byteLength(line);
  } catch {
    // Logging should never crash the server
  }
}

export function closeLogger(): void {
  if (stream) {
    stream.end();
    stream = null;
  }
}

export const logger = {
  info(event: string, context?: LogContext & Record<string, unknown>): void {
    write({
      timestamp: new Date().toISOString(),
      level: "info",
      event,
      ...context,
    });
  },

  error(event: string, context?: LogContext & Record<string, unknown>): void {
    write({
      timestamp: new Date().toISOString(),
      level: "error",
      event,
      ...context,
    });
  },
};
