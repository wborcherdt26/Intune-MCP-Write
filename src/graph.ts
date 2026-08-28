import { logger, type LogContext } from "./logger.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS_CODES = new Set([401, 429, 500, 502, 503, 504]);
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
}

export class GraphClient {
  constructor(
    private getToken: () => Promise<string>,
    private getActor: () => string | undefined
  ) {}

  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
    logContext?: LogContext
  ): Promise<T> {
    const url = this.buildUrl("v1.0", path, params);
    return this.requestUrl(url, "GET", path, "v1.0", logContext);
  }

  async getBeta<T = unknown>(
    path: string,
    params?: Record<string, string>,
    logContext?: LogContext
  ): Promise<T> {
    const url = this.buildUrl("beta", path, params);
    return this.requestUrl(url, "GET", path, "beta", logContext);
  }

  async getAll<T = unknown>(
    path: string,
    params?: Record<string, string>,
    logContext?: LogContext,
    maxItems: number = MAX_PAGE_SIZE
  ): Promise<PaginatedResult<T>> {
    return this.paginate("v1.0", path, params, logContext, maxItems);
  }

  async getAllBeta<T = unknown>(
    path: string,
    params?: Record<string, string>,
    logContext?: LogContext,
    maxItems: number = MAX_PAGE_SIZE
  ): Promise<PaginatedResult<T>> {
    return this.paginate("beta", path, params, logContext, maxItems);
  }

  async patch<T = unknown>(
    path: string,
    body: unknown,
    logContext?: LogContext
  ): Promise<T | void> {
    const url = this.buildUrl("v1.0", path);
    return this.requestUrl(url, "PATCH", path, "v1.0", logContext, body);
  }

  async patchBeta<T = unknown>(
    path: string,
    body: unknown,
    logContext?: LogContext
  ): Promise<T | void> {
    const url = this.buildUrl("beta", path);
    return this.requestUrl(url, "PATCH", path, "beta", logContext, body);
  }

  async post<T = unknown>(
    path: string,
    body: unknown,
    logContext?: LogContext
  ): Promise<T | void> {
    const url = this.buildUrl("v1.0", path);
    return this.requestUrl(url, "POST", path, "v1.0", logContext, body);
  }

  async postBeta<T = unknown>(
    path: string,
    body: unknown,
    logContext?: LogContext
  ): Promise<T | void> {
    const url = this.buildUrl("beta", path);
    return this.requestUrl(url, "POST", path, "beta", logContext, body);
  }

  async delete(
    path: string,
    logContext?: LogContext
  ): Promise<void> {
    const url = this.buildUrl("v1.0", path);
    await this.requestUrl(url, "DELETE", path, "v1.0", logContext);
  }

  private async paginate<T>(
    version: string,
    path: string,
    params: Record<string, string> | undefined,
    logContext: LogContext | undefined,
    maxItems: number
  ): Promise<PaginatedResult<T>> {
    const pageSize = Math.min(maxItems, MAX_PAGE_SIZE);
    const effectiveParams = { ...params, $top: String(pageSize) };

    const url = this.buildUrl(version, path, effectiveParams);
    const firstPage = await this.requestUrl<GraphPagedResponse<T>>(
      url, "GET", path, version, logContext
    );

    const items = [...firstPage.value];
    let nextLink = firstPage["@odata.nextLink"];
    let pages = 1;

    while (nextLink && items.length < maxItems && pages < MAX_PAGES) {
      const page = await this.requestUrl<GraphPagedResponse<T>>(
        nextLink, "GET", path, version, logContext
      );
      items.push(...page.value);
      nextLink = page["@odata.nextLink"];
      pages++;
    }

    const truncated = items.length > maxItems;
    if (truncated) items.length = maxItems;

    return { items, hasMore: !!nextLink || truncated };
  }

  private buildUrl(
    version: string,
    path: string,
    params?: Record<string, string>
  ): string {
    const url = new URL(`https://graph.microsoft.com/${version}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private async requestUrl<T>(
    url: string,
    method: string,
    logPath: string,
    logVersion: string,
    logContext?: LogContext,
    body?: unknown
  ): Promise<T> {
    let token = await this.getToken();
    const startTime = Date.now();
    let lastError: GraphError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = this.getRetryDelay(attempt, lastError?.retryAfter);
        logger.info("graph_retry", {
          ...logContext,
          method,
          path: logPath,
          attempt,
          delayMs: delay,
          reason: lastError?.status === 401
            ? "token_expired"
            : lastError?.status === 429
              ? "throttled"
              : lastError?.status
                ? `status_${lastError.status}`
                : "network_error",
        });
        await sleep(delay);

        if (lastError?.status === 401) {
          token = await this.getToken();
        }
      }

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const fetchInit: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };
        if (body !== undefined) {
          fetchInit.body = JSON.stringify(body);
        }
        response = await fetch(url, fetchInit);
        clearTimeout(timer);
      } catch (err) {
        const message = err instanceof Error && err.name === "AbortError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : err instanceof Error ? err.message : "Network error";
        lastError = new GraphError(0, message);
        if (attempt === MAX_RETRIES) {
          const durationMs = Date.now() - startTime;
          logger.error("graph_request", {
            actor: this.getActor(),
            ...logContext,
            method,
            path: logPath,
            version: logVersion,
            status: 0,
            durationMs,
            attempts: attempt + 1,
            error: lastError.message,
          });
          throw lastError;
        }
        continue;
      }

      if (response.ok) {
        const durationMs = Date.now() - startTime;
        logger.info("graph_request", {
          actor: this.getActor(),
          ...logContext,
          method,
          path: logPath,
          version: logVersion,
          status: response.status,
          durationMs,
          attempts: attempt + 1,
        });
        if (response.status === 204) {
          return undefined as T;
        }
        return response.json() as Promise<T>;
      }

      const respBody = await response.text();
      let message: string;
      try {
        const parsed = JSON.parse(respBody);
        message = parsed.error?.message || respBody;
      } catch {
        message = respBody;
      }

      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      lastError = new GraphError(response.status, message, retryAfter);

      if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === MAX_RETRIES) {
        const durationMs = Date.now() - startTime;
        logger.error("graph_request", {
          actor: this.getActor(),
          ...logContext,
          method,
          path: logPath,
          version: logVersion,
          status: response.status,
          durationMs,
          attempts: attempt + 1,
          error: message,
        });
        throw lastError;
      }
    }

    throw lastError!;
  }

  private getRetryDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs) {
      return retryAfterMs;
    }
    return BASE_DELAY_MS * Math.pow(2, attempt - 1);
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: number
  ) {
    super(`Graph API ${status}: ${message}`);
    this.name = "GraphError";
  }
}

export interface GraphPagedResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}
