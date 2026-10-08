import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { isAPIError, isTimeoutError, type ImageStreamEvent } from "../../src";
import { BASE, ROUTER_KEY, client, recorder, sequence } from "../helpers";

const IMAGES = `${BASE}/api/v1/images`;

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** The router's error shape (OpenAI's), with its code. */
function routerError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): HttpResponse<{ error: { message: string; type: string; code: string; param: null } }> {
  return HttpResponse.json(
    { error: { message: `${code} happened`, type: "server_error", code, param: null } },
    { status, headers },
  );
}

const generation = {
  created: 1_791_201_600,
  data: [{ b64_json: "iVBORw0KGgo=", media_type: "image/png" }],
  usage: { prompt_tokens: 15, completion_tokens: 1584, total_tokens: 1599, cost: 0.057114 },
};

/** A text/event-stream answer sending `chunks` as they are, so events can split anywhere. */
function eventStream(
  chunks: readonly string[],
  options: { cancelled?: { value: boolean }; endless?: boolean } = {},
): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else if (!options.endless) controller.close();
      // An endless stream sends nothing more and never closes.
      else return new Promise<void>(() => undefined);
      return undefined;
    },
    cancel() {
      if (options.cancelled) options.cancelled.value = true;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(
  events: AsyncIterable<ImageStreamEvent>,
): Promise<{ readonly type: string }[]> {
  const seen: { readonly type: string }[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("ai", () => {
  it("lists models and image models without a key", async () => {
    const log = recorder();
    sequence("get", `${BASE}/api/v1/models`, [() => HttpResponse.json({ data: [] })], log);
    sequence("get", `${BASE}/api/v1/images/models`, [() => HttpResponse.json({ data: [] })], log);
    const relayForSI = client({ apiKey: undefined });
    await relayForSI.ai.models();
    await relayForSI.ai.imageModels();
    expect(log.seen.map((seen) => seen.headers.get("authorization"))).toEqual([null, null]);
  });

  it("reads a balance with the router key and maps the router's errors", async () => {
    const log = recorder();
    sequence(
      "get",
      `${BASE}/api/v1/balance`,
      [
        () =>
          HttpResponse.json({
            object: "balance",
            account: { id: "acc_1", token: { mint: "m", symbol: "ACME", name: "Acme" } },
            spendable_usd: "1.5",
          }),
        () => routerError(401, "invalid_api_key"),
      ],
      log,
    );
    const relayForSI = client({ routerKey: ROUTER_KEY });
    expect((await relayForSI.ai.balance()).account.token?.symbol).toBe("ACME");
    expect(log.seen[0]?.headers.get("authorization")).toBe(`Bearer ${ROUTER_KEY}`);
    expect(await caught(relayForSI.ai.balance())).toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("names a router call by its call id", async () => {
    sequence("post", `${BASE}/api/v1/images`, [
      () => routerError(402, "insufficient_balance", { "x-relayfor-call-id": "8812" }),
    ]);
    expect(
      await caught(
        client({ routerKey: ROUTER_KEY }).ai.images.generate({ model: "m", prompt: "p" }),
      ),
    ).toMatchObject({ code: "insufficient_balance", requestId: "8812" });
  });

  it("retries a busy model list after its Retry-After", async () => {
    sequence("get", `${BASE}/api/v1/models`, [
      () => routerError(503, "catalog_unavailable", { "retry-after-ms": "1" }),
      () => HttpResponse.json({ object: "list", data: [] }),
    ]);
    expect((await client().ai.models()).data).toEqual([]);
  });
});

describe("ai.images.generate", () => {
  it("posts with the router key, no Idempotency-Key, and stream off", async () => {
    const log = recorder();
    sequence("post", IMAGES, [() => HttpResponse.json(generation)], log);
    const result = await client({ routerKey: ROUTER_KEY }).ai.images.generate({
      model: "openai/gpt-image-2",
      prompt: "A lighthouse",
      stream: true,
      quality: "low",
    });
    expect(result.usage?.cost).toBe(0.057114);
    const seen = log.seen[0];
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${ROUTER_KEY}`);
    expect(seen?.headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(seen?.body ?? "{}")).toEqual({
      model: "openai/gpt-image-2",
      prompt: "A lighthouse",
      stream: false,
      quality: "low",
    });
  });

  it("takes a router key per call", async () => {
    const log = recorder();
    sequence("post", IMAGES, [() => HttpResponse.json(generation)], log);
    const other = `rf_ai_${"c".repeat(40)}`;
    await client().ai.images.generate({ model: "m", prompt: "p" }, { routerKey: other });
    expect(log.seen[0]?.headers.get("authorization")).toBe(`Bearer ${other}`);
  });

  it("retries refusals that cost nothing", async () => {
    const log = recorder();
    sequence(
      "post",
      IMAGES,
      [
        () => routerError(429, "too_many_running_calls", { "retry-after-ms": "1" }),
        () => routerError(503, "model_busy", { "retry-after-ms": "1" }),
        () => HttpResponse.json(generation),
      ],
      log,
    );
    await client({ routerKey: ROUTER_KEY }).ai.images.generate({ model: "m", prompt: "p" });
    expect(log.seen).toHaveLength(3);
  });

  it.each([
    ["a provider failure that may be billed", () => routerError(502, "provider_error")],
    ["a provider timeout", () => routerError(504, "upstream_timeout")],
    ["a lost connection", () => HttpResponse.error()],
    ["no balance", () => routerError(402, "insufficient_balance")],
  ])("never retries %s", async (_, respond) => {
    const log = recorder();
    sequence("post", IMAGES, [respond, () => HttpResponse.json(generation)], log);
    await caught(client({ routerKey: ROUTER_KEY }).ai.images.generate({ model: "m", prompt: "p" }));
    expect(log.seen).toHaveLength(1);
  });

  it("requires a router key", async () => {
    expect(await caught(client().ai.images.generate({ model: "m", prompt: "p" }))).toMatchObject({
      code: "missing_api_key",
    });
  });
});

describe("ai.images.stream", () => {
  const partial = {
    type: "image_generation.partial_image",
    partial_image_index: 0,
    b64_json: "AAA=",
  };
  const completed = {
    type: "image_generation.completed",
    b64_json: "iVBORw0KGgo=",
    media_type: "image/png",
    created: 1,
    usage: { cost: 0.04 },
  };

  it("yields events split across chunks, until [DONE]", async () => {
    const log = recorder();
    const text = `: comment\r\ndata: ${JSON.stringify(partial)}\r\n\r\nevent: x\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`;
    // Split every 7 characters, cutting events, lines and the CRLF pairs.
    const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
    sequence("post", IMAGES, [() => eventStream(chunks)], log);
    const events = await client({ routerKey: ROUTER_KEY }).ai.images.stream({
      model: "m",
      prompt: "p",
    });
    expect(await collect(events)).toEqual([partial, completed]);
    expect(JSON.parse(log.seen[0]?.body ?? "{}")).toMatchObject({ stream: true });
    expect(log.seen[0]?.headers.get("accept")).toContain("text/event-stream");
  });

  it("turns a whole answer from a model that does not stream into one event", async () => {
    sequence("post", IMAGES, [() => HttpResponse.json(generation)]);
    const events = await client({ routerKey: ROUTER_KEY }).ai.images.stream({
      model: "m",
      prompt: "p",
    });
    expect(await collect(events)).toEqual([
      {
        type: "image_generation.completed",
        b64_json: "iVBORw0KGgo=",
        media_type: "image/png",
        created: generation.created,
        usage: generation.usage,
      },
    ]);
  });

  it("throws a refusal before the stream starts", async () => {
    sequence("post", IMAGES, [() => routerError(400, "invalid_request")]);
    expect(
      await caught(client({ routerKey: ROUTER_KEY }).ai.images.stream({ model: "m", prompt: "p" })),
    ).toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("throws an error event with its code", async () => {
    const error = { type: "error", error: { message: "The host failed.", code: "provider_error" } };
    sequence("post", IMAGES, [
      () =>
        eventStream([`data: ${JSON.stringify(partial)}\n\n`, `data: ${JSON.stringify(error)}\n\n`]),
    ]);
    const seen: unknown[] = [];
    const events = await client({ routerKey: ROUTER_KEY }).ai.images.stream({
      model: "m",
      prompt: "p",
    });
    const thrown = await caught(
      (async () => {
        for await (const event of events) seen.push(event);
      })(),
    );
    expect(seen).toEqual([partial]);
    expect(isAPIError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: "provider_error", message: "The host failed." });
  });

  // These use a fetch that hands the body over as it is and ignores its abort signal, as some
  // custom fetches do: the reader must still end, time out and stop on its own.
  const endless = (cancelled?: { value: boolean }) =>
    client({
      routerKey: ROUTER_KEY,
      fetch: async () =>
        eventStream([`data: ${JSON.stringify(partial)}\n\n`], {
          endless: true,
          ...(cancelled ? { cancelled } : {}),
        }),
    });

  it("ends the request when the loop breaks", async () => {
    const cancelled = { value: false };
    const events = await endless(cancelled).ai.images.stream({ model: "m", prompt: "p" });
    for await (const _ of events) break;
    expect(cancelled.value).toBe(true);
  });

  it("times out when the stream goes quiet", async () => {
    const cancelled = { value: false };
    const events = await endless(cancelled).ai.images.stream(
      { model: "m", prompt: "p" },
      { timeout: 50 },
    );
    const thrown = await caught(collect(events));
    expect(isTimeoutError(thrown)).toBe(true);
    expect(cancelled.value).toBe(true);
  });

  it("rethrows the caller's abort reason mid-stream", async () => {
    const controller = new AbortController();
    const events = await endless().ai.images.stream(
      { model: "m", prompt: "p" },
      { signal: controller.signal },
    );
    const reason = new Error("user left");
    const thrown = await caught(
      (async () => {
        for await (const _ of events) controller.abort(reason);
      })(),
    );
    expect(thrown).toBe(reason);
  });

  it("refuses a body that is not JSON", async () => {
    sequence("post", IMAGES, [() => eventStream(["data: {oops\n\n"])]);
    const events = await client({ routerKey: ROUTER_KEY }).ai.images.stream({
      model: "m",
      prompt: "p",
    });
    expect(await caught(collect(events))).toMatchObject({ code: "unexpected_response" });
  });
});
