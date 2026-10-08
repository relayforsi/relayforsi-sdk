import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  APIError,
  ConnectionError,
  RelayForSIError,
  TimeoutError,
  isAPIError,
  isConnectionError,
  isTimeoutError,
  type Fetch,
} from "../../src";
import {
  API,
  BASE,
  ROUTER_KEY,
  SECRET_KEY,
  apiError,
  client,
  launch,
  recorder,
  sequence,
  server,
} from "../helpers";

const prepare = {
  creator: launch.creator,
  name: "Acme",
  symbol: "ACME",
  image: "data:image/png;base64,AA==",
};

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("requests", () => {
  it("sends GET requests with auth and SDK headers", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/project`,
      [() => HttpResponse.json({ id: "prj_1", name: "P", created_at: "x" })],
      log,
    );
    const project = await client().project.get();
    expect(project.id).toBe("prj_1");
    const [seen] = log.seen;
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    expect(seen?.headers.get("accept")).toBe("application/json");
    expect(seen?.headers.get("x-relayforsi-sdk")).toMatch(/^relayfor\.si-js\/\d+\.\d+\.\d+$/);
    expect(seen?.headers.get("user-agent")).toMatch(/^relayfor\.si-js\/\S+ node\//);
    expect(seen?.headers.get("content-type")).toBeNull();
    expect(seen?.headers.get("idempotency-key")).toBeNull();
  });

  it("sends POST bodies as JSON with an Idempotency-Key and bigints as strings", async () => {
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [() => HttpResponse.json(launch, { status: 201 })],
      log,
    );
    await client().launches.prepare({ ...prepare, opening_buy_lamports: 9_007_199_254_740_993n });
    const [seen] = log.seen;
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(seen?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(seen?.body ?? "")).toMatchObject({
      opening_buy_lamports: "9007199254740993",
    });
  });

  it("reuses the idempotency key and body across retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [
        () => apiError(500, "internal"),
        () => apiError(502, "internal"),
        () => HttpResponse.json(launch, { status: 201 }),
      ],
      log,
    );
    await client().launches.prepare(prepare);
    expect(log.seen).toHaveLength(3);
    const keys = new Set(log.seen.map((seen) => seen.headers.get("idempotency-key")));
    const bodies = new Set(log.seen.map((seen) => seen.body));
    expect(keys.size).toBe(1);
    expect(bodies.size).toBe(1);
  });

  it("uses a caller-provided Idempotency-Key and validates it", async () => {
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [() => HttpResponse.json(launch, { status: 201 })],
      log,
    );
    await client().launches.prepare(prepare, { idempotencyKey: "launch:order-42" });
    expect(log.seen[0]?.headers.get("idempotency-key")).toBe("launch:order-42");
    const error = await caught(client().launches.prepare(prepare, { idempotencyKey: "has space" }));
    expect(error).toMatchObject({ code: "invalid_idempotency_key" });
    expect(log.seen).toHaveLength(1);
  });

  it("maps the error envelope to an APIError", async () => {
    sequence("post", `${API}/launches/prepare`, [
      () =>
        apiError(422, "insufficient_funds", "The creator needs 0.05 SOL.", {
          param: "creator",
          requestId: "req_A",
        }),
    ]);
    const error = await caught(client().launches.prepare(prepare, { idempotencyKey: "k1" }));
    expect(error).toBeInstanceOf(APIError);
    expect(error).toBeInstanceOf(RelayForSIError);
    expect(error).not.toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({
      status: 422,
      code: "insufficient_funds",
      message: "The creator needs 0.05 SOL.",
      param: "creator",
      requestId: "req_A",
      idempotencyKey: "k1",
    });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      code: "insufficient_funds",
      status: 422,
      requestId: "req_A",
    });
  });

  it("exposes the original request id of a replayed response", async () => {
    server.use(
      http.post(`${API}/launches/prepare`, () =>
        HttpResponse.json(
          { error: { code: "launch_refused", message: "No.", request_id: "req_FIRST" } },
          { status: 422, headers: { "request-id": "req_REPLAY" } },
        ),
      ),
    );
    const error = await caught(client().launches.prepare(prepare));
    expect(error).toMatchObject({ requestId: "req_REPLAY", originalRequestId: "req_FIRST" });
  });

  it.each([
    [
      "an HTML 404",
      () =>
        new HttpResponse("<html>Not found</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        }),
    ],
    ["an empty 405", () => new HttpResponse(null, { status: 405 })],
    ["a platform text 413", () => new HttpResponse("Request Entity Too Large", { status: 413 })],
  ])("treats %s as unexpected_response without retrying", async (_, respond) => {
    const log = recorder();
    sequence("get", `${API}/project`, [respond], log);
    const error = await caught(client().project.get());
    expect(error).toMatchObject({ code: "unexpected_response" });
    expect(isAPIError(error)).toBe(true);
    expect(log.seen).toHaveLength(1);
  });

  it("rejects a 2xx response that is not JSON", async () => {
    sequence("get", `${API}/project`, [
      () => new HttpResponse("<html>captive portal</html>", { status: 200 }),
    ]);
    expect(await caught(client().project.get())).toMatchObject({
      code: "unexpected_response",
      status: 200,
    });
  });

  it("does not follow redirects", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/project`,
      [
        () =>
          new HttpResponse(null, {
            status: 308,
            headers: { location: "https://relayfor.si/api/project/v1/project" },
          }),
      ],
      log,
    );
    const error = await caught(client().project.get());
    expect(error).toMatchObject({ code: "unexpected_redirect", status: 308 });
    expect((error as Error).message).toContain("https://relayfor.si/api/project/v1/project");
    expect(log.seen).toHaveLength(1);
  });

  it("does not retry a closed feature", async () => {
    const log = recorder();
    sequence("post", `${API}/launches/prepare`, [() => apiError(503, "launches_closed")], log);
    expect(await caught(client().launches.prepare(prepare))).toMatchObject({
      code: "launches_closed",
    });
    expect(log.seen).toHaveLength(1);
  });

  it("retries 503 and 429 using retry-after", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/project`,
      [
        () => apiError(503, "unavailable", "busy", { headers: { "retry-after-ms": "5" } }),
        () => apiError(429, "rate_limited", "slow down", { headers: { "retry-after": "0" } }),
        () => HttpResponse.json({ id: "prj_1", name: "P", created_at: "x" }),
      ],
      log,
    );
    expect((await client().project.get()).id).toBe("prj_1");
    expect(log.seen).toHaveLength(3);
  });

  it("throws immediately when retry-after exceeds a minute", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/project`,
      [() => apiError(429, "rate_limited", "later", { headers: { "retry-after": "120" } })],
      log,
    );
    const error = await caught(client().project.get());
    expect(error).toMatchObject({ code: "rate_limited", retryAfter: 120_000 });
    expect(log.seen).toHaveLength(1);
  });

  it("waits on idempotency_in_progress outside maxRetries", async () => {
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [
        () =>
          apiError(409, "idempotency_in_progress", "running", { headers: { "retry-after": "0" } }),
        () =>
          apiError(409, "idempotency_in_progress", "running", { headers: { "retry-after": "0" } }),
        () => HttpResponse.json(launch, { status: 201 }),
      ],
      log,
    );
    const result = await client({ maxRetries: 0 }).launches.prepare(prepare);
    expect(result.id).toBe(launch.id);
    expect(log.seen).toHaveLength(3);
  });

  it("stops waiting on idempotency_in_progress after its budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      sequence("post", `${API}/launches/prepare`, [
        () =>
          apiError(409, "idempotency_in_progress", "running", { headers: { "retry-after": "0" } }),
      ]);
      const pending = caught(client().launches.prepare(prepare, { idempotencyKey: "k-stuck" }));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await pending).toMatchObject({
        code: "idempotency_in_progress",
        idempotencyKey: "k-stuck",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries network failures, then throws a ConnectionError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const log = recorder();
    sequence("post", `${API}/launches/prepare`, [() => HttpResponse.error()], log);
    const error = await caught(client().launches.prepare(prepare, { idempotencyKey: "k-net" }));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(isConnectionError(error)).toBe(true);
    expect(isTimeoutError(error)).toBe(false);
    expect(error).toMatchObject({ code: "connection_error", idempotencyKey: "k-net" });
    expect(log.seen).toHaveLength(3);
  });

  it("times out attempts, retries, then throws a TimeoutError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // A fetch that never answers and rejects on abort, as a real one does. (msw's emulated
    // socket sometimes fails a request on its own after an earlier abort, which made this
    // timing test flaky.)
    let attempts = 0;
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        attempts++;
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    const error = await caught(client({ timeout: 20, maxRetries: 1, fetch: hang }).project.get());
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: "timeout" });
    expect(attempts).toBe(2);
  });

  it("rethrows the caller's abort reason without retrying", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/project`,
      [
        async () => {
          await delay(500);
          return HttpResponse.json({ id: "late" });
        },
      ],
      log,
    );
    const controller = new AbortController();
    const reason = new Error("user left");
    setTimeout(() => controller.abort(reason), 20);
    expect(await caught(client().project.get({ signal: controller.signal }))).toBe(reason);
    expect(log.seen).toHaveLength(1);
  });

  it("rejects immediately on an aborted signal", async () => {
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json({})], log);
    const error = await caught(client().project.get({ signal: AbortSignal.abort() }));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(log.seen).toHaveLength(0);
  });

  it("cancels the backoff delay on abort", async () => {
    sequence("get", `${API}/project`, [
      () => apiError(503, "unavailable", "x", { headers: { "retry-after": "30" } }),
    ]);
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 30);
    const error = await caught(client().project.get({ signal: controller.signal }));
    expect(error).toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("removes its abort listener after each request", async () => {
    sequence("get", `${API}/project`, [() => HttpResponse.json({ id: "prj_1" })]);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const relayForSI = client();
    for (let index = 0; index < 20; index++)
      await relayForSI.project.get({ signal: controller.signal });
    expect(add).toHaveBeenCalledTimes(20);
    expect(remove).toHaveBeenCalledTimes(20);
  });

  it("calls hooks without exposing the key and ignores hook errors", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    sequence("get", `${API}/project`, [
      () => apiError(500, "internal"),
      () => HttpResponse.json({ id: "prj_1" }),
    ]);
    const events: unknown[] = [];
    const relayForSI = client({
      hooks: {
        onRequest: (event) => {
          events.push(["request", event]);
          throw new Error("hook bug");
        },
        onResponse: async (event) => {
          events.push(["response", event.status]);
          throw new Error("async hook bug");
        },
        onRetry: (event) => events.push(["retry", event.attempt, event.error.code]),
      },
    });
    expect((await relayForSI.project.get()).id).toBe("prj_1");
    expect(events.map((event) => (event as unknown[])[0])).toEqual([
      "request",
      "response",
      "retry",
      "request",
      "response",
    ]);
    expect(JSON.stringify(events)).not.toContain(SECRET_KEY);
  });

  it("rejects invalid header values without sending", async () => {
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json({})], log);
    const error = await caught(client().project.get({ headers: { "x-note": "line\nbreak" } }));
    expect(error).toMatchObject({ code: "invalid_argument" });
    expect(log.seen).toHaveLength(0);
  });

  it("does not let headers override authorization or Idempotency-Key", async () => {
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [() => HttpResponse.json(launch, { status: 201 })],
      log,
    );
    await client({ headers: { authorization: "Bearer stolen" } }).launches.prepare(prepare, {
      headers: { "idempotency-key": "ignored" },
      idempotencyKey: "chosen",
    });
    expect(log.seen[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
    expect(log.seen[0]?.headers.get("idempotency-key")).toBe("chosen");
  });

  it.each([
    ["an unsafe integer", 2 ** 60],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s in a body", async (_, value) => {
    const log = recorder();
    sequence(
      "post",
      `${API}/launches/prepare`,
      [() => HttpResponse.json(launch, { status: 201 })],
      log,
    );
    const error = await caught(
      client().launches.prepare({ ...prepare, opening_buy_lamports: value }),
    );
    expect(error).toMatchObject({ code: "invalid_argument" });
    expect(log.seen).toHaveLength(0);
  });

  it("rejects empty and dot path parameters and encodes others", async () => {
    const log = recorder();
    server.use(
      http.get(`${API}/launches/*`, async ({ request }) => {
        await log.record(request);
        return HttpResponse.json(launch);
      }),
    );
    for (const id of ["", ".", ".."]) {
      expect(await caught(client().launches.get(id))).toMatchObject({ code: "invalid_argument" });
    }
    expect(await caught(client().launches.get(undefined as unknown as string))).toMatchObject({
      code: "invalid_argument",
    });
    await client().launches.get("a/b?c");
    expect(log.seen).toHaveLength(1);
    expect(log.seen[0]?.url.pathname).toBe("/api/project/v1/launches/a%2Fb%3Fc");
  });

  it("uses a custom fetch and merges fetchOptions", async () => {
    const calls: { url: string; init: Record<string, unknown> }[] = [];
    const relayForSI = client({
      fetchOptions: { cache: "no-store", method: "DELETE" } as never,
      fetch: async (url, init) => {
        calls.push({ url, init: init as unknown as Record<string, unknown> });
        return new Response(JSON.stringify({ id: "prj_1" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await relayForSI.project.get();
    expect(calls[0]?.url).toBe(`${API}/project`);
    expect(calls[0]?.init).toMatchObject({ method: "GET", cache: "no-store", redirect: "manual" });
  });

  it("parses router errors in OpenAI format", async () => {
    server.use(
      http.get(`${BASE}/api/v1/balance`, () =>
        HttpResponse.json(
          {
            error: {
              message: "Invalid API key.",
              type: "authentication_error",
              code: "invalid_api_key",
              param: null,
            },
          },
          { status: 401 },
        ),
      ),
    );
    const error = await caught(client().ai.balance({ routerKey: ROUTER_KEY }));
    expect(error).toMatchObject({
      status: 401,
      code: "invalid_api_key",
      message: "Invalid API key.",
    });
  });
});
