import type { ApiErrorCode } from "../generated/spec";

/**
 * Error codes the router (`/api/v1`) answers to `ai.*` calls, as its error reference lists them.
 * Codes marked "charged" in that reference may have been billed by the model's provider.
 */
export type RouterErrorCode =
  | "invalid_api_key"
  | "account_not_found"
  | "invalid_request"
  | "unknown_model"
  | "model_not_served"
  | "tool_not_served"
  | "model_no_image_input"
  | "image_type_not_served"
  | "request_too_large"
  | "request_over_capacity"
  | "not_found"
  | "insufficient_balance"
  | "key_limit"
  | "rate_limited"
  | "too_many_running_calls"
  | "too_much_reserved"
  | "model_busy"
  | "gateway_busy"
  | "gateway_capacity"
  | "gateway_unavailable"
  | "catalog_unavailable"
  | "service_unavailable"
  | "storage_unavailable"
  | "gateway_error"
  | "upstream_timeout"
  | "upstream_unreachable"
  | "provider_error"
  | "provider_unavailable"
  | "no_provider"
  | "provider_refused"
  | "unprocessable"
  | "timeout"
  | "upstream_error";

/** Error codes raised by the SDK itself. */
export type ClientErrorCode =
  | "connection_error"
  | "timeout"
  | "wait_timeout"
  | "unexpected_response"
  | "unexpected_redirect"
  | "missing_api_key"
  | "wrong_key_type"
  | "browser_not_allowed"
  | "fetch_unavailable"
  | "invalid_argument"
  | "invalid_base_url"
  | "insecure_base_url"
  | "invalid_idempotency_key"
  | "secret_unrecoverable"
  | "file_too_large"
  | "file_type"
  | "stream_error"
  | WebhookErrorCode
  | "wallet_unsupported"
  | "wallet_modified_transaction";

/** Error codes raised by `verifyWebhook()`. */
export type WebhookErrorCode =
  | "missing_webhook_secret"
  | "wrong_key_type"
  | "header_missing"
  | "header_malformed"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "body_not_raw"
  | "body_not_json";

/**
 * Any error code. Known codes autocomplete, and other strings are accepted so codes added by a
 * newer API version do not break the build. Always handle a `default:` case.
 */
export type ErrorCode = ApiErrorCode | RouterErrorCode | ClientErrorCode | (string & {});

type Kind = "error" | "api" | "connection" | "timeout" | "webhook";

// A registry symbol, so `instanceof` and the guards work across duplicate copies of the SDK.
const BRAND: unique symbol = Symbol.for("relayfor.si.error");

function addKind(target: object, kind: Kind): void {
  const holder = target as { [BRAND]?: Kind[] };
  if (holder[BRAND]) {
    holder[BRAND].push(kind);
  } else {
    Object.defineProperty(target, BRAND, { value: [kind], enumerable: false });
  }
}

function hasKind(value: unknown, kind: Kind): boolean {
  if (typeof value !== "object" || value === null) return false;
  const kinds = (value as { [BRAND]?: unknown })[BRAND];
  return Array.isArray(kinds) && kinds.includes(kind);
}

interface V8ErrorConstructor {
  captureStackTrace?: (target: object, constructor: unknown) => void;
}

export interface RelayForSIErrorOptions {
  readonly cause?: unknown;
  readonly idempotencyKey?: string | undefined;
  readonly resourceId?: string | undefined;
}

/** Base class of every error thrown by the SDK. */
export class RelayForSIError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, "error");
  }

  override readonly name: string = "RelayForSIError";
  /** Stable identifier to branch on. `message` is human-readable and may change. */
  readonly code: ErrorCode;
  /** The Idempotency-Key of a failed POST. Retrying with it is safe. */
  readonly idempotencyKey: string | undefined;
  /** For `secret_unrecoverable`: the id of the key or webhook. */
  readonly resourceId: string | undefined;

  constructor(code: ErrorCode, message: string, options: RelayForSIErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.idempotencyKey = options.idempotencyKey;
    this.resourceId = options.resourceId;
    addKind(this, "error");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- V8-only API
    const capture = (Error as V8ErrorConstructor).captureStackTrace;
    capture?.(this, new.target);
  }

  /** Serializable form for logging. */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.idempotencyKey !== undefined) json["idempotencyKey"] = this.idempotencyKey;
    if (this.resourceId !== undefined) json["resourceId"] = this.resourceId;
    return json;
  }
}

/** Any object with a `Headers`-style `get` method. */
export interface HeadersLike {
  get(name: string): string | null;
}

export interface APIErrorInit {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly param?: string | undefined;
  readonly requestId?: string | undefined;
  readonly originalRequestId?: string | undefined;
  readonly retryAfter?: number | undefined;
  readonly headers: HeadersLike;
  readonly body: unknown;
  readonly idempotencyKey?: string | undefined;
}

/** The API returned an error status or a response the SDK could not read. */
export class APIError extends RelayForSIError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, "api");
  }

  override readonly name: string = "APIError";
  readonly status: number;
  /** The request field the error refers to, for example `route.wallets[1].bps`. */
  readonly param: string | undefined;
  /**
   * The answer's id: the `request-id` header, or a router call's `x-relayfor-call-id`. Quote it
   * when contacting support.
   */
  readonly requestId: string | undefined;
  /** On an idempotent replay, the id of the request that produced the stored response. */
  readonly originalRequestId: string | undefined;
  /** The wait the API asked for before retrying, in milliseconds. */
  readonly retryAfter: number | undefined;
  readonly headers: HeadersLike;
  /** The parsed body, or the raw text when it is not JSON. */
  readonly body: unknown;

  constructor(init: APIErrorInit) {
    super(init.code, init.message, { idempotencyKey: init.idempotencyKey });
    this.status = init.status;
    this.param = init.param;
    this.requestId = init.requestId;
    this.originalRequestId = init.originalRequestId;
    this.retryAfter = init.retryAfter;
    this.headers = init.headers;
    this.body = init.body;
    addKind(this, "api");
  }

  override toJSON(): Record<string, unknown> {
    const json = super.toJSON();
    json["status"] = this.status;
    if (this.param !== undefined) json["param"] = this.param;
    if (this.requestId !== undefined) json["requestId"] = this.requestId;
    if (this.originalRequestId !== undefined) json["originalRequestId"] = this.originalRequestId;
    if (this.retryAfter !== undefined) json["retryAfter"] = this.retryAfter;
    return json;
  }
}

/** The request got no response (DNS, TLS, connection reset). */
export class ConnectionError extends RelayForSIError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, "connection");
  }

  override readonly name: string = "ConnectionError";
  // Makes the class nominal, so narrowing with isConnectionError() keeps the else branch typed.
  declare private readonly connectionError: true;

  constructor(
    message: string,
    options: RelayForSIErrorOptions = {},
    code: ErrorCode = "connection_error",
  ) {
    super(code, message, options);
    addKind(this, "connection");
  }
}

export interface TimeoutErrorOptions extends RelayForSIErrorOptions {
  readonly last?: unknown;
}

/**
 * An attempt exceeded `timeout` (code `timeout`), or `wait()` reached its deadline (code
 * `wait_timeout`). Extends ConnectionError.
 */
export class TimeoutError extends ConnectionError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, "timeout");
  }

  override readonly name: string = "TimeoutError";
  /** For `wait_timeout`: the last value `wait()` received. */
  readonly last: unknown;

  constructor(
    message: string,
    options: TimeoutErrorOptions = {},
    code: "timeout" | "wait_timeout" = "timeout",
  ) {
    super(message, options, code);
    this.last = options.last;
    addKind(this, "timeout");
  }
}

/** Thrown by `verifyWebhook()` when a delivery cannot be verified. */
export class WebhookVerificationError extends RelayForSIError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasKind(value, "webhook");
  }

  override readonly name: string = "WebhookVerificationError";
  declare readonly code: WebhookErrorCode;

  constructor(code: WebhookErrorCode, message: string) {
    super(code, message);
    addKind(this, "webhook");
  }
}

export function isRelayForSIError(value: unknown): value is RelayForSIError {
  return hasKind(value, "error");
}

export function isAPIError(value: unknown): value is APIError {
  return hasKind(value, "api");
}

/** True for connection errors, including timeouts. */
export function isConnectionError(value: unknown): value is ConnectionError {
  return hasKind(value, "connection");
}

export function isTimeoutError(value: unknown): value is TimeoutError {
  return hasKind(value, "timeout");
}

export function isWebhookVerificationError(value: unknown): value is WebhookVerificationError {
  return hasKind(value, "webhook");
}
