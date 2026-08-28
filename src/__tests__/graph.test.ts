import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphClient, GraphError } from "../graph.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

type MockResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function mockFetch(responses: MockResponse[]) {
  let i = 0;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    const r = responses[i++] ?? responses[responses.length - 1];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
      headers: new Headers(r.headers ?? {}),
    } as Response;
  });
}

describe("GraphClient", () => {
  let getToken: ReturnType<typeof vi.fn>;
  let getActor: ReturnType<typeof vi.fn>;
  let client: GraphClient;

  beforeEach(() => {
    getToken = vi.fn(async () => "test-token");
    getActor = vi.fn(() => "user@test.com");
    client = new GraphClient(getToken, getActor);
    vi.useFakeTimers();
  });

  describe("get", () => {
    it("builds a v1.0 URL", async () => {
      const fetch = mockFetch([{ status: 200, body: { value: [] } }]);
      vi.stubGlobal("fetch", fetch);

      await client.get("/deviceManagement/managedDevices");

      expect(fetch.mock.calls[0][0]).toContain(
        "graph.microsoft.com/v1.0/deviceManagement/managedDevices"
      );
    });

    it("sends Bearer token", async () => {
      const fetch = mockFetch([{ status: 200, body: {} }]);
      vi.stubGlobal("fetch", fetch);

      await client.get("/test");

      const opts = fetch.mock.calls[0][1] as RequestInit;
      expect((opts.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-token"
      );
    });
  });

  describe("patch", () => {
    it("sends PATCH with JSON body", async () => {
      const fetch = mockFetch([{ status: 204, body: null }]);
      vi.stubGlobal("fetch", fetch);

      await client.patch("/test/123", { name: "updated" });

      const [url, opts] = fetch.mock.calls[0];
      expect(url).toContain("graph.microsoft.com/v1.0/test/123");
      expect((opts as RequestInit).method).toBe("PATCH");
      expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ name: "updated" });
    });

    it("returns undefined for 204 No Content", async () => {
      const fetch = mockFetch([{ status: 204, body: null }]);
      vi.stubGlobal("fetch", fetch);

      const result = await client.patch("/test/123", { name: "updated" });
      expect(result).toBeUndefined();
    });
  });

  describe("post", () => {
    it("sends POST with JSON body", async () => {
      const fetch = mockFetch([{ status: 204, body: null }]);
      vi.stubGlobal("fetch", fetch);

      await client.post("/test/action", { param: "value" });

      const opts = fetch.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body as string)).toEqual({ param: "value" });
    });
  });

  describe("delete", () => {
    it("sends DELETE", async () => {
      const fetch = mockFetch([{ status: 204, body: null }]);
      vi.stubGlobal("fetch", fetch);

      await client.delete("/test/123");

      const opts = fetch.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe("DELETE");
    });
  });

  describe("retry", () => {
    it("retries 429 and succeeds", async () => {
      const fetch = mockFetch([
        { status: 429, body: { error: { message: "throttled" } } },
        { status: 200, body: { ok: true } },
      ]);
      vi.stubGlobal("fetch", fetch);

      const promise = client.get("/test");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: true });
    });

    it("does not retry 400", async () => {
      const fetch = mockFetch([
        { status: 400, body: { error: { message: "bad request" } } },
      ]);
      vi.stubGlobal("fetch", fetch);

      await expect(client.get("/test")).rejects.toThrow(GraphError);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("refreshes token on 401", async () => {
      getToken
        .mockResolvedValueOnce("expired")
        .mockResolvedValueOnce("fresh");
      const fetch = mockFetch([
        { status: 401, body: { error: { message: "unauthorized" } } },
        { status: 200, body: { ok: true } },
      ]);
      vi.stubGlobal("fetch", fetch);

      const promise = client.get("/test");
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ ok: true });
      expect(getToken).toHaveBeenCalledTimes(2);
    });
  });

  describe("pagination", () => {
    it("follows nextLink", async () => {
      const fetch = mockFetch([
        {
          status: 200,
          body: {
            value: [{ id: "1" }, { id: "2" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next",
          },
        },
        {
          status: 200,
          body: { value: [{ id: "3" }] },
        },
      ]);
      vi.stubGlobal("fetch", fetch);

      const result = await client.getAll("/test", undefined, undefined, 10);

      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });
  });
});

describe("GraphError", () => {
  it("includes status in message", () => {
    const err = new GraphError(404, "Not Found");
    expect(err.message).toContain("404");
    expect(err.status).toBe(404);
    expect(err.name).toBe("GraphError");
  });

  it("extends Error", () => {
    expect(new GraphError(500, "fail")).toBeInstanceOf(Error);
  });
});
