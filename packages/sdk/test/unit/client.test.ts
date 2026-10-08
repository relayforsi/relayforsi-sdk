import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  APIError,
  RelayForSI,
  RelayForSIError,
  TimeoutError,
  isAPIError,
  isRelayForSIError,
} from "../../src";
import { API, BASE, ROUTER_KEY, SECRET_KEY, client, recorder, sequence, server } from "../helpers";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected it to throw");
}

const project = { id: "prj_1", name: "P", created_at: "2026-10-05T12:00:00.000Z" };

describe("RelayForSI", () => {
  it("requires the key at the first request, not in the constructor", async () => {
    vi.stubEnv("RELAYFOR_SECRET_KEY", "");
    const relayForSI = new RelayForSI({ baseURL: BASE });
    expect(await caught(relayForSI.project.get())).toMatchObject({ code: "missing_api_key" });
  });

  it("reads and trims RELAYFOR_SECRET_KEY", async () => {
    vi.stubEnv("RELAYFOR_SECRET_KEY", `${SECRET_KEY}\n`);
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json(project)], log);
    await new RelayForSI({ baseURL: BASE }).project.get();
    expect(log.seen[0]?.headers.get("authorization")).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("calls a key function once per request", async () => {
    let turns = 0;
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json(project)], log);
    const relayForSI = new RelayForSI({
      baseURL: BASE,
      apiKey: async () => `rf_sk_${String(++turns).repeat(40)}`,
    });
    await relayForSI.project.get();
    await relayForSI.project.get();
    expect(log.seen.map((seen) => seen.headers.get("authorization"))).toEqual([
      `Bearer rf_sk_${"1".repeat(40)}`,
      `Bearer rf_sk_${"2".repeat(40)}`,
    ]);
  });

  it.each([
    ["a router key as apiKey", { apiKey: ROUTER_KEY }, "wrong_key_type"],
    ["a secret key as routerKey", { routerKey: SECRET_KEY }, "wrong_key_type"],
    ["a webhook secret as apiKey", { apiKey: `whsec_${"c".repeat(43)}` }, "wrong_key_type"],
    ["an unknown key", { apiKey: "sk_live_123" }, "wrong_key_type"],
    ["a key with a space inside", { apiKey: "rf_sk_abc def" }, "invalid_argument"],
  ])("rejects %s", (_, options, code) => {
    const error = thrown(() => new RelayForSI({ baseURL: BASE, ...options }));
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain("c".repeat(43));
  });

  it.each([
    ["not a URL", "relayfor.si", "invalid_base_url"],
    ["plain http off localhost", "http://relayfor.si", "insecure_base_url"],
    ["a query", "https://relayfor.si?x=1", "invalid_base_url"],
    ["another scheme", "ftp://relayfor.si", "invalid_base_url"],
  ])("rejects a baseURL that is %s", (_, baseURL, code) => {
    expect(thrown(() => new RelayForSI({ apiKey: SECRET_KEY, baseURL }))).toMatchObject({ code });
  });

  it("allows http for localhost and keeps a base path", async () => {
    expect(
      () => new RelayForSI({ apiKey: SECRET_KEY, baseURL: "http://localhost:8080" }),
    ).not.toThrow();
    expect(
      () => new RelayForSI({ apiKey: SECRET_KEY, baseURL: "http://relayfor.localhost" }),
    ).not.toThrow();
    const log = recorder();
    sequence(
      "get",
      `${BASE}/proxy/relayfor/api/project/v1/project`,
      [() => HttpResponse.json(project)],
      log,
    );
    const relayForSI = new RelayForSI({ apiKey: SECRET_KEY, baseURL: `${BASE}/proxy/relayfor///` });
    await relayForSI.project.get();
    expect(log.seen).toHaveLength(1);
    expect(relayForSI.ai.baseURL).toBe(`${BASE}/proxy/relayfor/api/v1`);
    expect(relayForSI.ai.anthropicBaseURL).toBe(`${BASE}/proxy/relayfor/api`);
  });

  it("refuses to run in a browser unless allowed", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(thrown(() => new RelayForSI({ apiKey: SECRET_KEY }))).toMatchObject({
      code: "browser_not_allowed",
    });
    expect(
      () => new RelayForSI({ apiKey: SECRET_KEY, dangerouslyAllowBrowser: true }),
    ).not.toThrow();
  });

  it("keeps the key out of inspect and JSON output", () => {
    const relayForSI = new RelayForSI({ apiKey: SECRET_KEY });
    const inspect = (relayForSI as unknown as Record<symbol, () => string>)[
      Symbol.for("nodejs.util.inspect.custom")
    ];
    expect(inspect?.()).toBe("RelayForSI { baseURL: 'https://relayfor.si' }");
    expect(JSON.stringify(relayForSI)).toBe('{"baseURL":"https://relayfor.si"}');
    const reachable = JSON.stringify(relayForSI, (_, value: unknown) =>
      typeof value === "function" ? "fn" : value,
    );
    expect(reachable).not.toContain(SECRET_KEY);
    expect(
      Object.values(relayForSI).some((value) => JSON.stringify(value)?.includes(SECRET_KEY)),
    ).toBe(false);
  });

  it("creates an independent client with withOptions", async () => {
    const other = `rf_sk_${"z".repeat(40)}`;
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json(project)], log);
    const first = client();
    const second = first.withOptions({ apiKey: other });
    await second.project.get();
    await first.project.get();
    expect(log.seen.map((seen) => seen.headers.get("authorization"))).toEqual([
      `Bearer ${other}`,
      `Bearer ${SECRET_KEY}`,
    ]);
  });

  it("sends appInfo in x-relayforsi-sdk", async () => {
    const log = recorder();
    sequence("get", `${API}/project`, [() => HttpResponse.json(project)], log);
    await client({
      appInfo: { name: "Moon Pad\u2028", version: "1.2.0", url: "https://moonpad.test" },
    }).project.get();
    expect(log.seen[0]?.headers.get("x-relayforsi-sdk")).toMatch(
      /^relayfor\.si-js\/\S+ Moon Pad\/1\.2\.0 \(\+https:\/\/moonpad\.test\)$/,
    );
  });

  it("uses the router key for balance and no key for models", async () => {
    const log = recorder();
    server.use(
      http.get(`${BASE}/api/v1/balance`, async ({ request }) => {
        await log.record(request);
        return HttpResponse.json({ object: "balance", spendable_usd: "4.5" });
      }),
      http.get(`${BASE}/api/v1/models`, async ({ request }) => {
        await log.record(request);
        return HttpResponse.json({ object: "list", data: [] });
      }),
    );
    const agent = new RelayForSI({ baseURL: BASE, routerKey: ROUTER_KEY });
    expect((await agent.ai.balance()).spendable_usd).toBe("4.5");
    expect((await agent.ai.models()).object).toBe("list");
    expect(log.seen[0]?.headers.get("authorization")).toBe(`Bearer ${ROUTER_KEY}`);
    expect(log.seen[1]?.headers.get("authorization")).toBeNull();
  });
});

describe("errors", () => {
  it("match across SDK copies", () => {
    const fromAnotherCopy = Object.defineProperty(new Error("x"), Symbol.for("relayfor.si.error"), {
      value: ["error", "api"],
    });
    expect(fromAnotherCopy).toBeInstanceOf(RelayForSIError);
    expect(fromAnotherCopy).toBeInstanceOf(APIError);
    expect(fromAnotherCopy).not.toBeInstanceOf(TimeoutError);
    expect(isAPIError(fromAnotherCopy)).toBe(true);
    expect(isRelayForSIError(new Error("plain"))).toBe(false);
    expect(new Error("plain")).not.toBeInstanceOf(RelayForSIError);
  });

  it("have a name and a stack", () => {
    const error = new TimeoutError("slow");
    expect(error.name).toBe("TimeoutError");
    expect(error.code).toBe("timeout");
    expect(error.stack).toContain("TimeoutError");
  });
});
