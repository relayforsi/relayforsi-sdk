import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../../src/generated/operations";
import type { RelayForSI } from "../../src";
import { API, BASE, client, launch, recorder, sequence, server } from "../helpers";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** One call per operation in the spec, with every path parameter set to a known value. */
const CALLS: Record<string, (relayForSI: RelayForSI) => Promise<unknown>> = {
  getProject: (r) => r.project.get(),
  prepareWalletLaunch: (r) =>
    r.launches.prepare({ creator: "c", name: "n", symbol: "s", image: "i" }),
  submitLaunch: (r) => r.launches.submit("ID", { transaction: "AQID" }),
  getLaunch: (r) => r.launches.get("ID"),
  listLaunches: (r) => r.launches.list(),
  importToken: (r) => r.tokens.import({ mint: "m", creator: "c" }),
  getToken: (r) => r.tokens.get("ID"),
  listTokens: (r) => r.tokens.list(),
  getAccount: (r) => r.accounts.get("ID"),
  listAccounts: (r) => r.accounts.list(),
  listLedger: (r) => r.accounts.ledger.list("ID"),
  createPurchase: (r) => r.accounts.purchases.create("ID", { amount_usd: "20" } as never),
  getPurchase: (r) => r.accounts.purchases.get("ID", "ID"),
  listPurchases: (r) => r.accounts.purchases.list("ID"),
  createRouterKey: (r) => r.keys.create({ account: "a", name: "n" }),
  getRouterKey: (r) => r.keys.get("ID"),
  updateRouterKey: (r) => r.keys.update("ID", { limit: null }),
  revokeRouterKey: (r) => r.keys.revoke("ID"),
  listRouterKeys: (r) => r.keys.list(),
  getUsage: (r) => r.usage.get(),
  getStatement: (r) => r.statements.get("ID"),
  listWebhooks: (r) => r.webhooks.list(),
  createWebhook: (r) => r.webhooks.create({ url: "https://x.test" } as never),
  getWebhook: (r) => r.webhooks.get("ID"),
  deleteWebhook: (r) => r.webhooks.delete("ID"),
  rotateWebhookSecret: (r) => r.webhooks.rotate("ID"),
  testWebhook: (r) => r.webhooks.test("ID"),
  listDeliveries: (r) => r.webhooks.deliveries.list(),
  replayDelivery: (r) => r.webhooks.deliveries.replay("ID"),
  listPresets: (r) => r.presets.list(),
  createPreset: (r) => r.presets.create({ name: "n", ai_share: 9000, creator_share: 0 }),
  listPresetTemplates: (r) => r.presets.templates(),
  getPreset: (r) => r.presets.get("ID"),
  updatePreset: (r) => r.presets.update("ID", {} as never),
  archivePreset: (r) => r.presets.archive("ID"),
};

describe("resources", () => {
  it("cover every operation in the spec", async () => {
    const log = recorder();
    server.use(
      http.all(`${BASE}/*`, async ({ request }) => {
        await log.record(request);
        // Include secrets so create and rotate succeed.
        return HttpResponse.json({
          id: "x",
          key: "rf_ai_x",
          secret: "whsec_x",
          data: [],
          next_cursor: null,
        });
      }),
    );
    const missing = OPERATIONS.filter((operation) => !(operation.id in CALLS)).map(
      (operation) => operation.id,
    );
    expect(missing, "operations with no SDK method").toEqual([]);
    const extra = Object.keys(CALLS).filter(
      (id) => !OPERATIONS.some((operation) => operation.id === id),
    );
    expect(extra, "methods for operations the spec no longer has").toEqual([]);
    for (const operation of OPERATIONS) {
      await CALLS[operation.id]?.(client());
      const seen = log.seen.at(-1);
      const expected = operation.path.replace(/\{[^}]+\}/g, "ID");
      expect(`${seen?.method} ${seen?.url.pathname}`, operation.id).toBe(
        `${operation.method} ${expected}`,
      );
    }
  });

  it("iterate all pages with all()", async () => {
    const log = recorder();
    const pages: Record<string, { data: { mint: string }[]; next_cursor: string | null }> = {
      "": { data: [{ mint: "a" }, { mint: "b" }], next_cursor: "c1" },
      c1: { data: [{ mint: "c" }], next_cursor: "c2" },
      c2: { data: [{ mint: "d" }], next_cursor: null },
    };
    server.use(
      http.get(`${API}/tokens`, async ({ request }) => {
        await log.record(request);
        return HttpResponse.json(pages[new URL(request.url).searchParams.get("cursor") ?? ""]);
      }),
    );
    const mints: string[] = [];
    for await (const token of client().tokens.all()) mints.push(token.mint);
    expect(mints).toEqual(["a", "b", "c", "d"]);
    expect(log.seen.map((seen) => seen.url.searchParams.get("limit"))).toEqual([
      "100",
      "100",
      "100",
    ]);
  });

  it("keeps a caller-provided page size", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/launches`,
      [() => HttpResponse.json({ data: [], next_cursor: null })],
      log,
    );
    for await (const _ of client().launches.all({ limit: 5 })) void _;
    for await (const _ of client().launches.all({ limit: undefined })) void _;
    expect(log.seen.map((seen) => seen.url.searchParams.get("limit"))).toEqual(["5", "100"]);
  });

  it("stops on break and rejects a repeated cursor", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/launches`,
      [() => HttpResponse.json({ data: [launch, launch], next_cursor: "same" })],
      log,
    );
    for await (const _ of client().launches.all()) break;
    expect(log.seen).toHaveLength(1);
    const walk = async (): Promise<void> => {
      for await (const _ of client().launches.all()) void _;
    };
    expect(await caught(walk())).toMatchObject({ code: "unexpected_response" });
  });

  it("waits for a launch to finish and returns failed launches", async () => {
    const log = recorder();
    sequence(
      "get",
      `${API}/launches/${launch.id}`,
      [
        () => HttpResponse.json(launch),
        () => HttpResponse.json({ ...launch, state: "sent" }),
        () => HttpResponse.json({ ...launch, state: "failed", error: "simulation failed" }),
      ],
      log,
    );
    const settled = await client().launches.wait(launch.id, { interval: 1 });
    expect(settled.state).toBe("failed");
    expect(log.seen).toHaveLength(3);
  });

  it("throws wait_timeout with the last launch", async () => {
    sequence("get", `${API}/launches/${launch.id}`, [
      () => HttpResponse.json({ ...launch, state: "sent" }),
    ]);
    const error = await caught(client().launches.wait(launch.id, { interval: 5, timeout: 30 }));
    expect(error).toMatchObject({ code: "wait_timeout", last: { state: "sent" } });
  });

  it("rejects an invalid interval", async () => {
    expect(await caught(client().launches.wait(launch.id, { interval: 0 }))).toMatchObject({
      code: "invalid_argument",
    });
  });

  it("waits for a purchase to be credited", async () => {
    const path = `${API}/accounts/acc_1/purchases/pur_1`;
    sequence("get", path, [
      () => HttpResponse.json({ id: "pur_1", status: "pending" }),
      () => HttpResponse.json({ id: "pur_1", status: "credited", credited_usd: "20" }),
    ]);
    expect((await client().accounts.purchases.wait("acc_1", "pur_1", { interval: 1 })).status).toBe(
      "credited",
    );
  });

  it.each([
    [
      "keys.create",
      "post",
      `${API}/keys`,
      (r: RelayForSI) => r.keys.create({ account: "a", name: "n" }),
      { id: "key_1", key: null },
      "key_1",
    ],
    [
      "webhooks.create",
      "post",
      `${API}/webhooks`,
      (r: RelayForSI) => r.webhooks.create({ url: "https://x.test" } as never),
      { id: "whk_1", secret: null },
      "whk_1",
    ],
    [
      "webhooks.rotate",
      "post",
      `${API}/webhooks/whk_1/rotate`,
      (r: RelayForSI) => r.webhooks.rotate("whk_1"),
      { id: "whk_1", secret: null },
      "whk_1",
    ],
  ] as const)(
    "%s throws secret_unrecoverable when the secret is missing",
    async (_, method, url, run, body, id) => {
      const log = recorder();
      sequence(method, url, [() => HttpResponse.json(body, { status: 201 })], log);
      const error = await caught(run(client()));
      expect(error).toMatchObject({ code: "secret_unrecoverable", resourceId: id });
      // The key the request carried, generated or not, so a retry with it is safe.
      const sent = log.seen[0]?.headers.get("idempotency-key");
      expect(sent).toMatch(/^[0-9a-f-]{36}$/);
      expect((error as { idempotencyKey?: string }).idempotencyKey).toBe(sent);
    },
  );

  it("keeps a caller's idempotency key on a secret_unrecoverable error", async () => {
    sequence("post", `${API}/keys`, [
      () => HttpResponse.json({ id: "key_1", key: null }, { status: 201 }),
    ]);
    const error = await caught(
      client().keys.create({ account: "a", name: "n" }, { idempotencyKey: "key:order-7" }),
    );
    expect(error).toMatchObject({ code: "secret_unrecoverable", idempotencyKey: "key:order-7" });
  });

  it("returns the key from keys.create", async () => {
    sequence("post", `${API}/keys`, [
      () => HttpResponse.json({ id: "key_1", key: "rf_ai_new" }, { status: 201 }),
    ]);
    expect((await client().keys.create({ account: "a", name: "n" })).key).toBe("rf_ai_new");
  });

  it("rejects instead of throwing synchronously", () => {
    const pending = client().launches.get("");
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("files.dataUri", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  const gif = new TextEncoder().encode("GIF89a....");
  const webp = new Uint8Array([
    ...new TextEncoder().encode("RIFF"),
    0,
    0,
    0,
    0,
    ...new TextEncoder().encode("WEBPVP8 "),
  ]);

  it.each([
    ["PNG", png, "image/png"],
    ["JPEG", jpeg, "image/jpeg"],
    ["GIF", gif, "image/gif"],
    ["WebP", webp, "image/webp"],
  ])("detects %s", async (_, bytes, type) => {
    const uri = await client().files.dataUri(bytes);
    expect(uri.startsWith(`data:${type};base64,`)).toBe(true);
    const decoded = Uint8Array.from(atob(uri.split(",")[1] ?? ""), (char) => char.charCodeAt(0));
    expect([...decoded]).toEqual([...bytes]);
  });

  it("accepts a Blob and an ArrayBuffer", async () => {
    expect(await client().files.dataUri(new Blob([png]))).toMatch(/^data:image\/png;base64,/);
    expect(await client().files.dataUri(png.buffer.slice(0))).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects invalid images", async () => {
    const files = client().files;
    expect(await caught(files.dataUri(new Uint8Array(0)))).toMatchObject({
      code: "file_too_large",
    });
    expect(await caught(files.dataUri(new TextEncoder().encode("%PDF-1.7")))).toMatchObject({
      code: "file_type",
    });
    expect(await caught(files.dataUri(png, { type: "image/jpeg" }))).toMatchObject({
      code: "file_type",
    });
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(png);
    expect(await caught(files.dataUri(big))).toMatchObject({ code: "file_too_large" });
    expect(await caught(files.dataUri(new Blob([big])))).toMatchObject({ code: "file_too_large" });
  });

  it("encodes a 2 MiB image", async () => {
    const large = new Uint8Array(2 * 1024 * 1024);
    large.set(png);
    expect((await client().files.dataUri(large)).length).toBeGreaterThan(2_700_000);
  });
});
