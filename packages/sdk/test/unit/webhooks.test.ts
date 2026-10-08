import { describe, expect, it } from "vitest";

import {
  WebhookVerificationError,
  isWebhookVerificationError,
  signWebhook,
  verifyWebhook,
} from "../../src/webhooks";
import vector from "../fixtures/webhook-vector.json" with { type: "json" };

// Reference vector computed with node:crypto createHmac.
const at = vector.timestamp * 1_000;

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected verification to fail");
}

describe("verifyWebhook", () => {
  it("accepts a valid signature and returns the event", async () => {
    const event = await verifyWebhook({
      body: vector.body,
      header: vector.header,
      secret: vector.secret,
      now: at,
    });
    expect(event).toMatchObject({ type: "ping", data: { message: "Hello from relayfor.si." } });
  });

  it("accepts Uint8Array and ArrayBuffer bodies", async () => {
    const bytes = new TextEncoder().encode(vector.body);
    await expect(
      verifyWebhook({ body: bytes, header: vector.header, secret: vector.secret, now: at }),
    ).resolves.toMatchObject({ id: "evt_0123456789abcdef" });
    await expect(
      verifyWebhook({ body: bytes.buffer, header: vector.header, secret: vector.secret, now: at }),
    ).resolves.toMatchObject({ type: "ping" });
  });

  it("accepts either secret during rotation", async () => {
    await expect(
      verifyWebhook({
        body: vector.body,
        header: vector.rotated,
        secret: vector.previous,
        now: at,
      }),
    ).resolves.toBeTruthy();
    await expect(
      verifyWebhook({
        body: vector.body,
        header: vector.header,
        secret: [vector.previous, vector.secret],
        now: at,
      }),
    ).resolves.toBeTruthy();
  });

  it("ignores unknown signature schemes", async () => {
    const header = `${vector.header},v2=${"0".repeat(64)}`;
    await expect(
      verifyWebhook({ body: vector.body, header, secret: vector.secret, now: at }),
    ).resolves.toBeTruthy();
  });

  it.each([
    ["a changed body", { body: vector.body.replace("Hello", "Hullo") }, "signature_mismatch"],
    ["the wrong secret", { secret: vector.previous }, "signature_mismatch"],
    ["an old signature", { now: at + 301_000 }, "timestamp_outside_tolerance"],
    ["a signature from the future", { now: at - 301_000 }, "timestamp_outside_tolerance"],
    ["no header", { header: null }, "header_missing"],
    ["an empty header", { header: "  " }, "header_missing"],
    ["a header without v1", { header: `t=${vector.timestamp}` }, "header_malformed"],
    ["uppercase hex", { header: vector.header.toUpperCase() }, "header_malformed"],
    ["a parsed body", { body: JSON.parse(vector.body) as never }, "body_not_raw"],
    ["no secret", { secret: "" }, "missing_webhook_secret"],
    ["no secrets", { secret: [] }, "missing_webhook_secret"],
    ["a project key as the secret", { secret: `rf_sk_${"a".repeat(40)}` }, "wrong_key_type"],
  ])("rejects %s", async (_, change, code) => {
    const error = await caught(
      verifyWebhook({
        body: vector.body,
        header: vector.header,
        secret: vector.secret,
        now: at,
        ...change,
      }),
    );
    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect(isWebhookVerificationError(error)).toBe(true);
    expect(error).toMatchObject({ code });
  });

  it("accepts a custom tolerance", async () => {
    await expect(
      verifyWebhook({
        body: vector.body,
        header: vector.header,
        secret: vector.secret,
        now: at + 600_000,
        tolerance: 900_000,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("signWebhook", () => {
  it("matches the reference signature", async () => {
    expect(
      await signWebhook({ secret: vector.secret, body: vector.body, timestamp: vector.timestamp }),
    ).toBe(vector.header);
  });

  it("round-trips with verifyWebhook", async () => {
    const body = JSON.stringify({
      id: "evt_1",
      type: "ping",
      created_at: "x",
      project: "prj_1",
      data: { message: "hi" },
    });
    const header = await signWebhook({ secret: vector.secret, body });
    await expect(verifyWebhook({ body, header, secret: vector.secret })).resolves.toMatchObject({
      id: "evt_1",
    });
  });
});
