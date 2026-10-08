import { requestStream, type Call, type Config, type RequestOptions } from "../core/request";
import type {
  ImageGenerateParams,
  ImageGeneration,
  ImageStreamEvent,
  RouterBalance,
  RouterImageModelList,
  RouterModelList,
} from "../types";
import type { Caller } from "./shared";

/**
 * Default per-attempt timeout for image calls: past the router's own 13 minutes for a whole
 * answer, so the router, not the SDK, says when a generation took too long.
 */
export const IMAGE_TIMEOUT_MS = 900_000;

export interface AIBalanceOptions extends RequestOptions {
  /** Defaults to the client's `routerKey`. */
  routerKey?: string | undefined;
}

/** Options for image calls. `idempotencyKey` does not apply: the router has none. */
export interface AIImageOptions extends Omit<RequestOptions, "idempotencyKey"> {
  /** Defaults to the client's `routerKey`. */
  routerKey?: string | undefined;
}

export interface AIImagesResource {
  /**
   * Makes images from a prompt with an image model, and returns them as base64 with
   * `usage.cost`, the USD charged. Charged calls are never retried after a lost connection or a
   * timeout: only refusals that cost nothing are. Times out after 15 minutes by default.
   * `POST /api/v1/images`
   */
  generate(params: ImageGenerateParams, options?: AIImageOptions): Promise<ImageGeneration>;
  /**
   * Makes one image, streaming partial images as they form, then the finished one (event
   * `image_generation.completed`). A model without `streaming: true` answers the finished image
   * alone. A mid-stream error throws an `APIError` with its code. `timeout` bounds the wait for
   * each chunk. Breaking out of the loop ends the request. `POST /api/v1/images`
   */
  stream(
    params: Omit<ImageGenerateParams, "n" | "stream">,
    options?: AIImageOptions,
  ): Promise<AsyncGenerator<ImageStreamEvent, void, undefined>>;
}

export interface AIResource {
  /** Base URL for OpenAI-compatible clients. Use a router key as their API key. */
  readonly baseURL: string;
  /** Base URL for the Anthropic SDK, which appends `/v1` itself. */
  readonly anthropicBaseURL: string;
  /** Gets the balance and limit of a router key. `GET /api/v1/balance` */
  balance(options?: AIBalanceOptions): Promise<RouterBalance>;
  /** Lists the models the router serves, with prices. No key needed. `GET /api/v1/models` */
  models(options?: RequestOptions): Promise<RouterModelList>;
  /**
   * Lists the image models, the fields each takes and its prices. No key needed.
   * `GET /api/v1/images/models`
   */
  imageModels(options?: RequestOptions): Promise<RouterImageModelList>;
  readonly images: AIImagesResource;
}

/** The finished image of a non-streamed answer, as a stream's last event. */
function completedEvent(answer: unknown): ImageStreamEvent[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the router's answer
  const generation = answer as ImageGeneration;
  return (generation.data ?? []).map((image) => ({
    type: "image_generation.completed",
    b64_json: image.b64_json,
    media_type: image.media_type,
    created: generation.created,
    usage: generation.usage,
  }));
}

async function* events(
  list: ImageStreamEvent[],
): AsyncGenerator<ImageStreamEvent, void, undefined> {
  yield* list;
}

/** `POST /api/v1/images`: charged, with the router key and a long default timeout. */
function imageCall(
  params: Readonly<Record<string, unknown>>,
  options: AIImageOptions | undefined,
): Call {
  return {
    method: "POST",
    path: "/api/v1/images",
    body: params,
    auth: "router",
    key: options?.routerKey,
    options,
    charged: true,
    timeout: IMAGE_TIMEOUT_MS,
  };
}

export function ai(call: Caller, config: Config): AIResource {
  return {
    baseURL: `${config.baseURL}/api/v1`,
    anthropicBaseURL: `${config.baseURL}/api`,
    balance: async (options) =>
      call({
        method: "GET",
        path: "/api/v1/balance",
        auth: "router",
        key: options?.routerKey,
        options,
      }),
    models: async (options) =>
      call({ method: "GET", path: "/api/v1/models", auth: "none", options }),
    imageModels: async (options) =>
      call({ method: "GET", path: "/api/v1/images/models", auth: "none", options }),
    images: {
      generate: async (params, options) => call(imageCall({ ...params, stream: false }, options)),
      stream: async (params, options) => {
        const answer = await requestStream(config, imageCall({ ...params, stream: true }, options));
        if (answer.kind === "json") return events(completedEvent(answer.data));
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the router's events
        return answer.events as AsyncGenerator<ImageStreamEvent, void, undefined>;
      },
    },
  };
}
