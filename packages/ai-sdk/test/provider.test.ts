import { APICallError, generateImage, generateText, streamText } from "ai";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createRelayForSI, DEFAULT_BASE_URL } from "../src";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const KEY = `rf_ai_${"b".repeat(40)}`;
const URL = `${DEFAULT_BASE_URL}/chat/completions`;

function completion(text: string, cost: number): Record<string, unknown> {
  return {
    id: "gen-1",
    object: "chat.completion",
    created: 1_791_201_600,
    model: "vendor/model",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost },
  };
}

function sse(events: readonly unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("@relayforsi/ai-sdk", () => {
  it("calls the router and reports the cost", async () => {
    const seen: Request[] = [];
    server.use(
      http.post(URL, ({ request }) => {
        seen.push(request.clone());
        return HttpResponse.json(completion("Hello.", 0.000_42));
      }),
    );
    const relayForSI = createRelayForSI({ apiKey: KEY });
    const result = await generateText({ model: relayForSI("vendor/model"), prompt: "Hi" });
    expect(result.text).toBe("Hello.");
    expect(result.providerMetadata?.["relayforsi"]).toEqual({ cost: 0.000_42 });
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.headers.get("x-relayforsi-sdk")).toMatch(/^relayforsi-ai-sdk\//);
    expect(await seen[0]?.json()).toMatchObject({ model: "vendor/model" });
  });

  it("streams and reports the cost", async () => {
    const base = {
      id: "gen-2",
      object: "chat.completion.chunk",
      created: 1,
      model: "vendor/model",
    };
    server.use(
      http.post(URL, () =>
        sse([
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null },
            ],
          },
          { ...base, choices: [{ index: 0, delta: { content: "lo." }, finish_reason: "stop" }] },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.001 },
          },
        ]),
      ),
    );
    const result = streamText({
      model: createRelayForSI({ apiKey: KEY })("vendor/model"),
      prompt: "Hi",
    });
    expect(await result.text).toBe("Hello.");
    expect((await result.providerMetadata)?.["relayforsi"]).toEqual({ cost: 0.001 });
  });

  it("surfaces mid-stream errors", async () => {
    const base = {
      id: "gen-3",
      object: "chat.completion.chunk",
      created: 1,
      model: "vendor/model",
    };
    server.use(
      http.post(URL, () =>
        sse([
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Par" }, finish_reason: null },
            ],
          },
          {
            ...base,
            error: {
              message: "The upstream stream broke.",
              type: "server_error",
              code: "upstream_stream_broken",
            },
            choices: [{ index: 0, delta: {}, finish_reason: "error" }],
          },
        ]),
      ),
    );
    const errors: unknown[] = [];
    const result = streamText({
      model: createRelayForSI({ apiKey: KEY })("vendor/model"),
      prompt: "Hi",
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await result.consumeStream();
    expect(await result.finishReason).toBe("error");
    expect(JSON.stringify(errors)).toContain("upstream_stream_broken");
  });

  it("reads RELAYFOR_ROUTER_KEY when a model is created", () => {
    vi.stubEnv("RELAYFOR_ROUTER_KEY", "");
    const relayForSI = createRelayForSI();
    expect(() => relayForSI("vendor/model")).toThrow(/RELAYFOR_ROUTER_KEY/);
    vi.stubEnv("RELAYFOR_ROUTER_KEY", `${KEY}\n`);
    expect(() => createRelayForSI()("vendor/model")).not.toThrow();
  });

  it("rejects a secret key", () => {
    expect(() => createRelayForSI({ apiKey: `rf_sk_${"a".repeat(40)}` })("vendor/model")).toThrow(
      /secret key/,
    );
  });

  it("throws for embedding models", () => {
    const relayForSI = createRelayForSI({ apiKey: KEY });
    expect(() => relayForSI.embeddingModel("x")).toThrow(/does not serve embedding models/);
    expect(relayForSI.specificationVersion).toBe("v4");
  });

  it("reads providerOptions.relayforsi and names the provider relayforsi", async () => {
    const seen: Request[] = [];
    server.use(
      http.post(URL, ({ request }) => {
        seen.push(request.clone());
        return HttpResponse.json(completion("ok", 0.1));
      }),
    );
    const model = createRelayForSI({ apiKey: KEY })("vendor/model");
    expect(model.provider).toBe("relayforsi.chat");
    await generateText({
      model,
      prompt: "Hi",
      providerOptions: { relayforsi: { reasoningEffort: "low", user: "agent-7" } },
    });
    expect(await seen[0]?.json()).toMatchObject({ reasoning_effort: "low", user: "agent-7" });
  });

  it("accepts a custom base URL", async () => {
    server.use(
      http.post("https://proxy.test/relayfor/chat/completions", () =>
        HttpResponse.json(completion("ok", 0)),
      ),
    );
    const relayForSI = createRelayForSI({ apiKey: KEY, baseURL: "https://proxy.test/relayfor/" });
    expect((await generateText({ model: relayForSI("vendor/model"), prompt: "Hi" })).text).toBe(
      "ok",
    );
  });
});

describe("@relayforsi/ai-sdk images", () => {
  const IMAGES = `${DEFAULT_BASE_URL}/images`;
  const MODELS = `${DEFAULT_BASE_URL}/images/models`;
  const png = "iVBORw0KGgo=";

  function imageModels(n: Record<string, number | undefined>): Response {
    return HttpResponse.json({
      object: "list",
      data: Object.entries(n).map(([id, max]) => ({
        id,
        object: "model",
        name: id,
        reads_images: true,
        streaming: false,
        parameters: max === undefined ? {} : { n: { type: "range", min: 1, max } },
        pricing: [],
      })),
    });
  }

  function images(count: number, cost = 0.04): Response {
    return HttpResponse.json({
      created: 1,
      data: Array.from({ length: count }, () => ({ b64_json: png, media_type: "image/png" })),
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15, cost },
    });
  }

  it("generates images with the router's fields and reports the cost", async () => {
    const seen: Request[] = [];
    server.use(
      http.get(MODELS, () => imageModels({ "vendor/image": 4 })),
      http.post(IMAGES, ({ request }) => {
        seen.push(request.clone());
        return images(2);
      }),
    );
    const result = await generateImage({
      model: createRelayForSI({ apiKey: KEY }).imageModel("vendor/image"),
      prompt: "A lighthouse",
      n: 2,
      size: "1024x1024",
      aspectRatio: "16:9",
      seed: 7,
      providerOptions: { relayforsi: { quality: "low" } },
    });
    expect(result.images).toHaveLength(2);
    expect(result.images[0]?.base64).toBe(png);
    expect(result.calls[0]?.providerMetadata?.["relayforsi"]).toEqual({
      cost: 0.04,
      images: [{ mediaType: "image/png" }, { mediaType: "image/png" }],
    });
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 10, totalTokens: 15 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(await seen[0]?.json()).toEqual({
      model: "vendor/image",
      prompt: "A lighthouse",
      n: 2,
      size: "1024x1024",
      aspect_ratio: "16:9",
      seed: 7,
      quality: "low",
      stream: false,
    });
  });

  it("splits n into calls the model allows", async () => {
    let calls = 0;
    server.use(
      http.get(MODELS, () => imageModels({ "vendor/one": 1 })),
      http.post(IMAGES, async ({ request }) => {
        calls++;
        const body = (await request.json()) as { n: number };
        return images(body.n);
      }),
    );
    const result = await generateImage({
      model: createRelayForSI({ apiKey: KEY }).imageModel("vendor/one"),
      prompt: "p",
      n: 3,
    });
    expect(result.images).toHaveLength(3);
    expect(calls).toBe(3);
  });

  it("makes one image a call when the model list cannot be read", async () => {
    let calls = 0;
    server.use(
      http.get(MODELS, () => HttpResponse.json({ error: { message: "down" } }, { status: 503 })),
      http.post(IMAGES, () => {
        calls++;
        return images(1);
      }),
    );
    await generateImage({
      model: createRelayForSI({ apiKey: KEY }).imageModel("vendor/x"),
      prompt: "p",
      n: 2,
      maxRetries: 0,
    });
    expect(calls).toBe(2);
  });

  it("sends files as input_references", async () => {
    const seen: Request[] = [];
    server.use(
      http.get(MODELS, () => imageModels({ "vendor/edit": 1 })),
      http.post(IMAGES, ({ request }) => {
        seen.push(request.clone());
        return images(1);
      }),
    );
    await generateImage({
      model: createRelayForSI({ apiKey: KEY }).imageModel("vendor/edit"),
      prompt: {
        text: "Make it night",
        images: ["https://example.test/a.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      },
    });
    const body = (await seen[0]?.json()) as { input_references: unknown[] };
    expect(body.input_references).toEqual([
      { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
    ]);
  });

  it("surfaces the router's error message", async () => {
    server.use(
      http.get(MODELS, () => imageModels({ "vendor/image": 1 })),
      http.post(IMAGES, () =>
        HttpResponse.json(
          {
            error: {
              message: "vendor/image makes one image a call.",
              type: "invalid_request_error",
              code: "invalid_request",
              param: null,
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await generateImage({
      model: createRelayForSI({ apiKey: KEY }).imageModel("vendor/image"),
      prompt: "p",
    }).catch((caught: unknown) => caught);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).message).toBe("vendor/image makes one image a call.");
    expect((error as APICallError).isRetryable).toBe(false);
  });

  it("rejects a missing key when the image model is created", () => {
    vi.stubEnv("RELAYFOR_ROUTER_KEY", "");
    expect(() => createRelayForSI().imageModel("vendor/image")).toThrow(/RELAYFOR_ROUTER_KEY/);
  });
});
