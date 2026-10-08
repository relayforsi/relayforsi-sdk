import {
  createOpenAICompatible,
  type MetadataExtractor,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import {
  LoadAPIKeyError,
  NoSuchModelError,
  type EmbeddingModelV4,
  type ImageModelV4,
  type ImageModelV4CallOptions,
  type ImageModelV4File,
  type ImageModelV4Result,
  type LanguageModelV4,
  type ProviderV4,
  type SharedV4Warning,
} from "@ai-sdk/provider";
import {
  combineHeaders,
  convertUint8ArrayToBase64,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  getFromApi,
  loadApiKey,
  postJsonToApi,
  withoutTrailingSlash,
  type FetchFunction,
} from "@ai-sdk/provider-utils";
import { z } from "zod/v4";

/** Package version, sent in the `x-relayforsi-sdk` header. */
export const VERSION: string = "1.0.0"; // x-release-please-version

export const DEFAULT_BASE_URL: string = "https://relayfor.si/api/v1";

/** The key of this provider's `providerOptions` and `providerMetadata`. */
const NAME = "relayforsi";

/** A model id served by the router. See `GET https://relayfor.si/api/v1/models`. */
export type RelayForSIModelId = string;

/** An image model id. See `GET https://relayfor.si/api/v1/images/models`. */
export type RelayForSIImageModelId = string;

export interface RelayForSIProviderSettings {
  /** A router key (`rf_ai_...`). Defaults to `RELAYFOR_ROUTER_KEY`. */
  apiKey?: string | undefined;
  /** Defaults to `https://relayfor.si/api/v1`. */
  baseURL?: string | undefined;
  /** Headers sent with every request. */
  headers?: Record<string, string> | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: FetchFunction | undefined;
}

/** Contents of `providerMetadata.relayforsi` for language models. */
export interface RelayForSIProviderMetadata {
  /** USD charged for the call: exactly what left the balance. */
  cost?: number | undefined;
}

/**
 * `providerOptions.relayforsi` for image models: fields of `POST /images` the model lists in
 * `parameters` (see `GET /images/models`). A field the model does not list is refused.
 */
export interface RelayForSIImageProviderOptions {
  /** The size tier, such as `"1K"`. Left out, the call reserves the largest tier. */
  resolution?: string | undefined;
  /** Lower quality reserves and costs less. Left out, the call reserves the highest. */
  quality?: string | undefined;
  /** `png`, `jpeg`, `webp` or `svg`, where the model offers a choice. */
  output_format?: string | undefined;
  /** `transparent` or `opaque`. */
  background?: string | undefined;
  [field: string]: unknown;
}

/**
 * Contents of `providerMetadata.relayforsi` of each image model call: with `generateImage`,
 * `result.calls[i].providerMetadata.relayforsi`.
 */
export interface RelayForSIImageProviderMetadata {
  /** Each image's media type, in order. */
  images: { mediaType: string | null }[];
  /** USD charged for the call. */
  cost?: number | undefined;
}

export interface RelayForSIProvider extends ProviderV4 {
  (modelId: RelayForSIModelId): LanguageModelV4;
  languageModel(modelId: RelayForSIModelId): LanguageModelV4;
  chatModel(modelId: RelayForSIModelId): LanguageModelV4;
  /** An image model of `POST /images`, for `generateImage`. */
  imageModel(modelId: RelayForSIImageModelId): ImageModelV4;
}

function costOf(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = Reflect.get(value, "usage");
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = Reflect.get(usage, "cost");
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

/** Exposes the router's `usage.cost` (the amount charged) as `providerMetadata.relayforsi.cost`. */
const costExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => {
    const cost = costOf(parsedBody);
    return cost === undefined ? undefined : { [NAME]: { cost } };
  },
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk(parsedChunk) {
        // With includeUsage, usage arrives in the last chunk.
        cost = costOf(parsedChunk) ?? cost;
      },
      buildMetadata: () => (cost === undefined ? undefined : { [NAME]: { cost } }),
    };
  },
};

function routerKey(apiKey: string | undefined): string {
  const key = loadApiKey({
    apiKey,
    environmentVariableName: "RELAYFOR_ROUTER_KEY",
    description: "relayfor.si router key",
  }).trim();
  // loadApiKey accepts an empty environment variable.
  if (key === "") {
    throw new LoadAPIKeyError({
      message:
        "relayfor.si router key is missing. Pass it using the apiKey setting or the RELAYFOR_ROUTER_KEY environment variable.",
    });
  }
  if (key.startsWith("rf_ai_")) return key;
  throw new LoadAPIKeyError({
    message: key.startsWith("rf_sk_")
      ? "Expected a router key (rf_ai_...), got a secret key (rf_sk_...). Secret keys must not be used here."
      : "relayfor.si router keys start with rf_ai_.",
  });
}

// The router's error shape (OpenAI's), read loosely.
const errorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
    param: z.unknown().nullish(),
  }),
});

const imageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string(), media_type: z.string().nullish() })),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

const imageModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      parameters: z.record(z.string(), z.object({ type: z.string(), max: z.number().optional() })),
    }),
  ),
});

/** How long the image model list is kept for `maxImagesPerCall`, as the docs advise. */
const IMAGE_MODELS_TTL_MS = 300_000;

interface ImageConfig {
  readonly baseURL: string;
  readonly headers: () => Record<string, string>;
  readonly fetch: FetchFunction | undefined;
  /** Images one call of the model may make, from `GET /images/models`. */
  readonly maxImages: (modelId: string) => Promise<number | undefined>;
}

/** An image to edit or follow, as `input_references` names it: a link, or a data URL. */
function referenceOf(file: ImageModelV4File): { type: "image_url"; image_url: { url: string } } {
  const url =
    file.type === "url"
      ? file.url
      : `data:${file.mediaType};base64,${
          typeof file.data === "string" ? file.data : convertUint8ArrayToBase64(file.data)
        }`;
  return { type: "image_url", image_url: { url } };
}

class RelayForSIImageModel implements ImageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider: string = `${NAME}.image`;
  // References are sent as `input_references`, on models with `reads_images: true`.
  readonly supportsFileInputs: boolean = true;
  readonly supportsMaskInputs: boolean = false;
  readonly maxImagesPerCall: (options: { modelId: string }) => Promise<number | undefined>;
  readonly modelId: RelayForSIImageModelId;
  private readonly config: ImageConfig;

  constructor(modelId: RelayForSIImageModelId, config: ImageConfig) {
    this.modelId = modelId;
    this.config = config;
    this.maxImagesPerCall = ({ modelId: id }) => config.maxImages(id);
  }

  async doGenerate(options: ImageModelV4CallOptions): Promise<ImageModelV4Result> {
    const warnings: SharedV4Warning[] = [];
    if (options.mask !== undefined) {
      warnings.push({ type: "unsupported", feature: "mask", details: "Masks are not taken." });
    }
    const { value, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/images`,
      headers: combineHeaders(this.config.headers(), options.headers),
      body: {
        model: this.modelId,
        prompt: options.prompt,
        n: options.n,
        ...(options.size === undefined ? {} : { size: options.size }),
        ...(options.aspectRatio === undefined ? {} : { aspect_ratio: options.aspectRatio }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.files?.length ? { input_references: options.files.map(referenceOf) } : {}),
        ...options.providerOptions[NAME],
        // One answer with every image: streaming is for the SDK's ai.images.stream().
        stream: false,
      },
      failedResponseHandler: createJsonErrorResponseHandler({
        errorSchema,
        errorToMessage: (data) => data.error.message,
      }),
      successfulResponseHandler: createJsonResponseHandler(imageResponseSchema),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    });
    const cost = value.usage?.cost ?? undefined;
    return {
      images: value.data.map((image) => image.b64_json),
      warnings,
      usage: {
        inputTokens: value.usage?.prompt_tokens ?? undefined,
        outputTokens: value.usage?.completion_tokens ?? undefined,
        totalTokens: value.usage?.total_tokens ?? undefined,
      },
      providerMetadata: {
        [NAME]: {
          images: value.data.map((image) => ({ mediaType: image.media_type ?? null })),
          ...(cost === undefined ? {} : { cost }),
        },
      },
      response: { timestamp: new Date(), modelId: this.modelId, headers: responseHeaders },
    };
  }
}

/**
 * Creates a relayfor.si provider for the AI SDK.
 *
 * ```ts
 * const relayForSI = createRelayForSI({ apiKey: process.env.RELAYFOR_ROUTER_KEY });
 * const { text } = await generateText({ model: relayForSI("<model id>"), prompt });
 * const { image } = await generateImage({ model: relayForSI.imageModel("<image model id>"), prompt });
 * ```
 */
export function createRelayForSI(settings: RelayForSIProviderSettings = {}): RelayForSIProvider {
  const baseURL = withoutTrailingSlash(settings.baseURL) ?? DEFAULT_BASE_URL;
  const sdkHeader = { "x-relayforsi-sdk": `relayforsi-ai-sdk/${VERSION}` };
  let inner: OpenAICompatibleProvider | undefined;
  // Created lazily so a missing key fails when a model is created, not at import.
  const provider = (): OpenAICompatibleProvider =>
    (inner ??= createOpenAICompatible({
      // Also the key of providerOptions and providerMetadata.
      name: NAME,
      baseURL,
      apiKey: routerKey(settings.apiKey),
      headers: { ...settings.headers, ...sdkHeader },
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
      includeUsage: true,
      supportsStructuredOutputs: true,
      metadataExtractor: costExtractor,
    }));

  let imageModels: { at: number; limits: Promise<Map<string, number>> } | undefined;
  /** Each image model's most images a call, read once per IMAGE_MODELS_TTL_MS; no key needed. */
  const maxImages = async (modelId: string): Promise<number | undefined> => {
    const now = Date.now();
    if (!imageModels || now - imageModels.at > IMAGE_MODELS_TTL_MS) {
      const limits = getFromApi({
        url: `${baseURL}/images/models`,
        headers: { ...settings.headers, ...sdkHeader },
        failedResponseHandler: createJsonErrorResponseHandler({
          errorSchema,
          errorToMessage: (data) => data.error.message,
        }),
        successfulResponseHandler: createJsonResponseHandler(imageModelsSchema),
        ...(settings.fetch ? { fetch: settings.fetch } : {}),
      }).then(
        ({ value }) =>
          new Map(
            value.data.map((model) => {
              // The router's rule: a model without an `n` range makes one image a call.
              const n = model.parameters["n"];
              return [model.id, n?.type === "range" && n.max !== undefined ? n.max : 1];
            }),
          ),
      );
      imageModels = { at: now, limits };
      // A failed read is not kept: the next call reads again.
      limits.catch(() => {
        if (imageModels?.limits === limits) imageModels = undefined;
      });
    }
    try {
      return (await imageModels.limits).get(modelId);
    } catch {
      // Unknown: the AI SDK then makes one image a call, which every model takes.
      return undefined;
    }
  };

  const languageModel = (modelId: RelayForSIModelId): LanguageModelV4 =>
    provider().chatModel(modelId);

  const imageModel = (modelId: RelayForSIImageModelId): ImageModelV4 => {
    // Read now, so a missing or wrong key fails when the model is created, as for chat.
    const key = routerKey(settings.apiKey);
    return new RelayForSIImageModel(modelId, {
      baseURL,
      headers: () => ({ ...settings.headers, ...sdkHeader, authorization: `Bearer ${key}` }),
      fetch: settings.fetch,
      maxImages,
    });
  };

  const relayForSI = (modelId: RelayForSIModelId): LanguageModelV4 => languageModel(modelId);
  return Object.assign(relayForSI, {
    specificationVersion: "v4" as const,
    languageModel,
    chatModel: languageModel,
    imageModel,
    embeddingModel: (modelId: string): EmbeddingModelV4 => {
      throw new NoSuchModelError({
        modelId,
        modelType: "embeddingModel",
        message: "relayfor.si does not serve embedding models.",
      });
    },
  });
}

/** Default provider, using `RELAYFOR_ROUTER_KEY`. */
export const relayForSI: RelayForSIProvider = createRelayForSI();
