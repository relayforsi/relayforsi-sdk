// Public names for the generated OpenAPI types. Only these names are part of the API.
import type { components, operations } from "./generated/schema";

type Schemas = components["schemas"];
// Interfaces can only extend a named type, not an indexed access type.
type Schema<K extends keyof Schemas> = Schemas[K];
type QueryOf<K extends keyof operations> = NonNullable<operations[K]["parameters"]["query"]>;

/** Adds bigint to fields that accept a digit string or a number (amounts). */
type Widen<T> = string extends T ? (number extends T ? T | bigint : T) : T;

/**
 * Request params: optional fields also accept `undefined` (for `exactOptionalPropertyTypes`),
 * and amounts also accept a bigint.
 */
export type Loose<T> = [T] extends [string | number | boolean | null | undefined]
  ? Widen<T>
  : T extends readonly (infer U)[]
    ? Loose<U>[]
    : T extends object
      ? { [K in keyof T]: {} extends Pick<T, K> ? Loose<T[K]> | undefined : Loose<T[K]> }
      : T;

/** A page of results, newest first. Pass `next_cursor` as `cursor` to get the next page. */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Project extends Schema<"Project"> {}
export interface Launch extends Schema<"Launch"> {}
export interface Token extends Schema<"Token"> {}
/** A token with its market state (`market` is null when it could not be read). */
export interface TokenDetail extends Schema<"TokenDetail"> {}
/** A token as events and statements name it. */
export interface TokenRef extends Schema<"TokenRef"> {}
export interface Account extends Schema<"Account"> {}
export interface LedgerEntry extends Schema<"LedgerEntry"> {}
export interface KeyLimit extends Schema<"KeyLimit"> {}
export interface RouterKey extends Schema<"RouterKey"> {}
/** A newly created router key. `key` is only returned once (and to a retry within 24 hours). */
export interface NewRouterKey extends Schema<"NewRouterKey"> {}
export interface Purchase extends Schema<"Purchase"> {}
export interface Payout extends Schema<"Payout"> {}
export interface Usage extends Schema<"Usage"> {}
export interface Statement extends Schema<"Statement"> {}
export interface Webhook extends Schema<"Webhook"> {}
/** A newly created or rotated webhook. `secret` is only returned once (and to a retry). */
export interface NewWebhook extends Schema<"NewWebhook"> {}
export interface Delivery extends Schema<"Delivery"> {}
/** A fee preset (fee strategy): how the project's part of each creator fee splits. */
export interface Preset extends Schema<"Preset"> {}

export interface LaunchList extends Schema<"LaunchList"> {}
export interface TokenList extends Schema<"TokenList"> {}
export interface AccountList extends Schema<"AccountList"> {}
export interface LedgerList extends Schema<"LedgerList"> {}
export interface PurchaseList extends Schema<"PurchaseList"> {}
export interface RouterKeyList extends Schema<"RouterKeyList"> {}
export interface WebhookList extends Schema<"WebhookList"> {}
export interface DeliveryList extends Schema<"DeliveryList"> {}
export interface PresetList extends Schema<"PresetList"> {}
export interface PresetTemplateList extends Schema<"PresetTemplateList"> {}

/** A webhook event type a webhook can subscribe to. */
export type WebhookEventType = Schemas["Webhook"]["events"][number];

export type LaunchPrepareParams = Loose<Schemas["WalletLaunchRequest"]>;
export type LaunchSubmitParams = Loose<Schemas["SubmitLaunchRequest"]>;
export type TokenImportParams = Loose<Schemas["ImportTokenRequest"]>;
export type PurchaseCreateParams = Loose<Schemas["CreatePurchaseRequest"]>;
export type KeyCreateParams = Loose<Schemas["CreateRouterKeyRequest"]>;
export type KeyUpdateParams = Loose<Schemas["UpdateRouterKeyRequest"]>;
export type WebhookCreateParams = Loose<Schemas["CreateWebhookRequest"]>;
export type PresetCreateParams = Loose<Schemas["CreatePresetRequest"]>;
export type PresetUpdateParams = Loose<Schemas["UpdatePresetRequest"]>;

/** `limit` (1 to 100, default 20) and `cursor`. */
export type ListParams = Loose<QueryOf<"listLaunches">>;
export type KeyListParams = Loose<QueryOf<"listRouterKeys">>;
export type DeliveryListParams = Loose<QueryOf<"listDeliveries">>;
export type UsageParams = Loose<QueryOf<"getUsage">>;

// Router (/api/v1) types, which are not part of the OpenAPI document.

/** `GET /api/v1/balance`. Amounts are USD as exact decimal strings. */
export interface RouterBalance {
  object: "balance";
  /** The key's credit account, and the token whose fees fund it (null for none). */
  account: { id: string; token: { mint: string; symbol: string; name: string } | null };
  /** USD new calls can reserve now: the balance less what running calls hold. */
  spendable_usd: string;
  /** Total USD balance. */
  balance_usd: string;
  /** USD reserved by calls in progress. */
  reserved_usd: string;
  running_calls: number;
  /** The key's own spending limit, or null for none. */
  key_limit: KeyLimit | null;
}

/** A model served by the router. Prices are USD per unit, as decimal strings. */
export interface RouterModel {
  /** The id to send as `model`, such as `anthropic/claude-sonnet-5.5`. */
  id: string;
  object: "model";
  owned_by: string;
  name: string;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  context_length: number | null;
  max_output_tokens: number | null;
  reasoning: {
    supported_efforts: string[];
    default_effort: string | null;
    mandatory: boolean;
    supports_max_tokens: boolean;
  } | null;
  /** What callers pay, per token (or per request, image or search). Null for a router model. */
  pricing: {
    prompt: string | null;
    completion: string | null;
    reasoning: string | null;
    request: string | null;
    image: string | null;
    image_output: string | null;
    web_search: string | null;
  } | null;
}

export interface RouterModelList {
  object: "list";
  data: RouterModel[];
}

/** A field an image model takes: its values, its range, or a flag. */
export type ImageModelParameter =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

/** One billed line of an image model's price, in USD as a decimal string. */
export interface ImageModelPrice {
  /** `output_image`, `input_image`, `input_reference` or `input_text`. */
  billable: string;
  /** `image`, `megapixel`, `token` or `request`. */
  unit: string;
  usd: string;
  /** The tier or quality the line applies to, such as `2k` or `low_1k`. */
  variant?: string;
}

/** A model served by `POST /api/v1/images`. */
export interface RouterImageModel {
  /** The id to send as `model`. */
  id: string;
  object: "model";
  name: string;
  /** Whether it takes `input_references`. */
  reads_images: boolean;
  /** Whether it streams partial images. */
  streaming: boolean;
  /** The fields it takes, by name. A field not listed is refused. */
  parameters: Record<string, ImageModelParameter>;
  pricing: ImageModelPrice[];
}

export interface RouterImageModelList {
  object: "list";
  data: RouterImageModel[];
}

/** An image to edit or follow: a link, or a `data:image/...;base64,...` URL. */
export interface ImageReference {
  type: "image_url";
  image_url: { url: string };
}

/**
 * `POST /api/v1/images`. Fields beyond `model` and `prompt` apply only to models that list them
 * in `parameters` (see `ai.imageModels()`); others are refused before anything is reserved.
 */
export interface ImageGenerateParams {
  /** An image model id from `ai.imageModels()`. */
  model: string;
  /** What to draw. */
  prompt: string;
  /** How many images, 1 by default, up to the model's `parameters.n.max` (at most 10). */
  n?: number | undefined;
  /** The size tier. Left out, the call reserves the largest tier the model offers. */
  resolution?: "512" | "1K" | "2K" | "4K" | (string & {}) | undefined;
  /** Such as `"1:1"` or `"16:9"`, from the values the model lists. */
  aspect_ratio?: string | undefined;
  /** Lower quality reserves and costs less. Left out, the call reserves the highest. */
  quality?: string | undefined;
  /** A tier such as `"2K"`, or pixels such as `"2048x2048"`. */
  size?: string | undefined;
  /** `png`, `jpeg`, `webp` or `svg`, where the model offers a choice. */
  output_format?: string | undefined;
  /** `transparent` or `opaque`, for models that list it. */
  background?: string | undefined;
  /** Images to edit or follow, up to the model's `parameters.input_references.max`. */
  input_references?: ImageReference[] | undefined;
  /** The same seed and prompt give the same image, on models that list it. */
  seed?: number | undefined;
  /** Other fields a model lists. */
  [field: string]: unknown;
}

/** Tokens and what the call was charged. */
export interface ImageUsage {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  /** USD charged for the call: exactly what left the balance. */
  cost?: number | undefined;
  [field: string]: unknown;
}

/** One image made by `POST /api/v1/images`. */
export interface GeneratedImage {
  /** The image, base64. */
  b64_json: string;
  /** Its type, such as `image/png`. */
  media_type: string;
  [field: string]: unknown;
}

/** The answer of `POST /api/v1/images`. */
export interface ImageGeneration {
  /** Unix seconds. */
  created: number;
  /** The images, in order. */
  data: GeneratedImage[];
  usage?: ImageUsage | undefined;
  [field: string]: unknown;
}

/** An event of a streamed `POST /api/v1/images` call. Keep a `default:` branch for new types. */
export type ImageStreamEvent =
  | {
      type: "image_generation.partial_image";
      partial_image_index: number;
      b64_json: string;
      [field: string]: unknown;
    }
  | {
      type: "image_generation.completed";
      b64_json: string;
      media_type: string;
      created: number;
      usage?: ImageUsage | undefined;
      [field: string]: unknown;
    };
