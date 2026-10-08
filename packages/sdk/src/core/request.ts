import { SDK_VERSION } from "./version";
import {
  APIError,
  ConnectionError,
  RelayForSIError,
  TimeoutError,
  isAPIError,
  isRelayForSIError,
  type HeadersLike,
} from "./errors";
import { checkIdempotencyKey, newIdempotencyKey } from "./idempotency";
import {
  IN_PROGRESS_BUDGET_MS,
  IN_PROGRESS_STEP_MS,
  MAX_RETRY_AFTER_MS,
  MIN_IN_PROGRESS_STEP_MS,
  abortReason,
  backoff,
  classify,
  parseRetryAfter,
  sleep,
} from "./retry";
import { describe, headerSafe, isBrowser, monotonicNow, readEnv, runtimeName } from "./runtime";

/** A key, or a function returning one. Functions are called once per request. */
export type KeySource = string | (() => string | Promise<string>);

/**
 * Extra fetch options for every request, such as `cache`, Next.js `next`, or an undici
 * `dispatcher`. `method`, `body`, `headers`, `signal` and `redirect` are set by the SDK.
 */
export type ExtraRequestInit = Omit<
  RequestInit,
  "method" | "body" | "headers" | "signal" | "redirect"
> & {
  readonly [key: string]: unknown;
};

interface PreparedInit extends ExtraRequestInit {
  method: string;
  headers: Headers;
  body?: string;
  redirect: "manual";
}

/** The init object passed to `fetch`. */
export interface FetchInit extends PreparedInit {
  signal: AbortSignal;
}

/** The parts of a fetch `Response` the SDK reads. */
export interface FetchResponse {
  readonly status: number;
  readonly type?: string;
  readonly headers: HeadersLike;
  /** Read for streamed answers only. */
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface RequestEvent {
  readonly method: string;
  readonly url: string;
  /** Starts at 1. */
  readonly attempt: number;
  readonly idempotencyKey: string | undefined;
}

export interface ResponseEvent extends RequestEvent {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly durationMs: number;
}

export interface RetryEvent extends RequestEvent {
  readonly delayMs: number;
  readonly error: RelayForSIError;
}

/**
 * Observers for logging, metrics and tracing. Hooks are not awaited, and errors they throw are
 * ignored. They never receive the authorization header.
 */
export interface Hooks {
  onRequest?: ((event: RequestEvent) => unknown) | undefined;
  onResponse?: ((event: ResponseEvent) => unknown) | undefined;
  onRetry?: ((event: RetryEvent) => unknown) | undefined;
}

/** Per-request options. They override the client's. */
export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Milliseconds per attempt. */
  timeout?: number | undefined;
  maxRetries?: number | undefined;
  /**
   * POST only. Defaults to a random key reused across this call's retries. Pass a stable key of
   * your own if your code may repeat the whole operation, for example from a job queue.
   */
  idempotencyKey?: string | undefined;
  /** Extra headers. `authorization` and `idempotency-key` cannot be set here. */
  headers?: Readonly<Record<string, string>> | undefined;
  fetchOptions?: ExtraRequestInit | undefined;
}

/** @internal */
export interface Config {
  readonly apiKey: KeySource | undefined;
  readonly routerKey: KeySource | undefined;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly fetch: Fetch | undefined;
  readonly fetchOptions: ExtraRequestInit | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly hooks: Hooks;
  readonly sdkHeader: string;
}

export type Auth = "secret" | "router" | "none";

/** @internal */
export interface Call {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path after the base URL, with parameters already encoded by `segment()`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | null | undefined>> | undefined;
  readonly body?: unknown;
  readonly auth: Auth;
  /** Overrides the client's key for this request. */
  readonly key?: string | undefined;
  readonly options?: RequestOptions | undefined;
  /**
   * A router call that may be charged (`POST /api/v1/images`). It carries no Idempotency-Key
   * and is retried only after a refusal that proves nothing started, never after a lost
   * connection or a timeout, which may already have been charged.
   */
  readonly charged?: boolean | undefined;
  /** Milliseconds per attempt when the request sets none; else the client's `timeout`. */
  readonly timeout?: number | undefined;
}

const PREFIX = { secret: "rf_sk_", router: "rf_ai_" } as const;
const ENV = { secret: "RELAYFOR_SECRET_KEY", router: "RELAYFOR_ROUTER_KEY" } as const;
const OPTION = { secret: "apiKey", router: "routerKey" } as const;

/** Trims a key and checks its prefix, so a swapped or malformed key fails before any request. */
export function checkKey(raw: string, kind: "secret" | "router"): string {
  const key = raw.trim();
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new RelayForSIError(
      "invalid_argument",
      `${OPTION[kind]} contains whitespace or non-ASCII characters.`,
    );
  }
  if (key.startsWith(PREFIX[kind])) return key;
  if (kind === "secret" && key.startsWith(PREFIX.router)) {
    throw new RelayForSIError(
      "wrong_key_type",
      "apiKey expects a secret key (rf_sk_...), got a router key (rf_ai_...). Pass router keys as routerKey.",
    );
  }
  if (kind === "router" && key.startsWith(PREFIX.secret)) {
    throw new RelayForSIError(
      "wrong_key_type",
      "routerKey expects a router key (rf_ai_...), got a secret key (rf_sk_...). Pass secret keys as apiKey.",
    );
  }
  if (key.startsWith("whsec_")) {
    throw new RelayForSIError(
      "wrong_key_type",
      "Got a webhook secret (whsec_...). Pass it to verifyWebhook from relayfor.si/webhooks.",
    );
  }
  throw new RelayForSIError("wrong_key_type", `${OPTION[kind]} must start with ${PREFIX[kind]}.`);
}

async function resolveKey(
  source: KeySource | undefined,
  kind: "secret" | "router",
): Promise<string> {
  const raw = typeof source === "function" ? await source() : (source ?? readEnv(ENV[kind]));
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new RelayForSIError(
      "missing_api_key",
      `Missing ${kind === "secret" ? "secret" : "router"} key. Pass ${OPTION[kind]} or set ${ENV[kind]}.`,
    );
  }
  return checkKey(raw, kind);
}

/** Encodes a path parameter. Empty values and dot segments would reach a different route. */
export function segment(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new RelayForSIError("invalid_argument", `${name} must be a non-empty string.`);
  }
  // encodeURIComponent keeps "." and "..", which URL parsing would then resolve away.
  if (/^\.+$/.test(value)) {
    throw new RelayForSIError("invalid_argument", `${name} cannot be "${value}".`);
  }
  return encodeURIComponent(value);
}

function serialize(body: unknown): string {
  return JSON.stringify(body, (key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number") {
      const field = key === "" ? "body" : key;
      if (!Number.isFinite(value)) {
        throw new RelayForSIError("invalid_argument", `${field} must be a finite number.`);
      }
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new RelayForSIError(
          "invalid_argument",
          `${field} exceeds Number.MAX_SAFE_INTEGER. Pass it as a string or a bigint.`,
        );
      }
    }
    return value;
  });
}

function buildURL(base: string, path: string, query: Call["query"]): string {
  let url = base + path;
  if (query) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) params.append(name, String(value));
    }
    const search = params.toString();
    if (search) url += `?${search}`;
  }
  return url;
}

function buildHeaders(
  config: Config,
  options: RequestOptions,
  key: string | undefined,
  hasBody: boolean,
  idempotencyKey: string | undefined,
): Headers {
  // Built before the first attempt: fetch rejects invalid headers with the same TypeError it
  // uses for network failures, which would otherwise be retried.
  try {
    const headers = new Headers();
    headers.set("accept", "application/json");
    if (hasBody) headers.set("content-type", "application/json");
    headers.set("x-relayforsi-sdk", config.sdkHeader);
    // Browsers do not allow setting user-agent.
    if (!isBrowser()) headers.set("user-agent", `${config.sdkHeader} ${runtimeName()}`);
    for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.delete("authorization");
    headers.delete("idempotency-key");
    if (key !== undefined) headers.set("authorization", `Bearer ${key}`);
    if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
    return headers;
  } catch (cause) {
    throw new RelayForSIError("invalid_argument", `Invalid request header: ${describe(cause)}`, {
      cause,
    });
  }
}

/** The answer's id for support: the management API's `request-id`, or the router's call id. */
function requestIdOf(headers: HeadersLike): string | undefined {
  return headers.get("request-id") ?? headers.get("x-relayfor-call-id") ?? undefined;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "(empty body)";
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJSON(text: string, contentType: string | null): Parsed {
  const trimmed = text.trimStart();
  if (trimmed === "") return { ok: false };
  if (!(contentType ?? "").includes("json") && !trimmed.startsWith("{")) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFrom(
  status: number,
  parsed: Parsed,
  text: string,
  headers: HeadersLike,
  requestId: string | undefined,
  idempotencyKey: string | undefined,
): APIError {
  const retryAfter = parseRetryAfter(headers);
  const envelope = parsed.ok && isObject(parsed.value) ? parsed.value["error"] : undefined;
  // Management API: {error: {code, message, param, request_id}}.
  // Router (OpenAI and Anthropic formats): {error: {message, type, code}}.
  if (isObject(envelope) && typeof envelope["message"] === "string") {
    const code =
      typeof envelope["code"] === "string" && envelope["code"] !== ""
        ? envelope["code"]
        : typeof envelope["type"] === "string" && envelope["type"] !== ""
          ? envelope["type"]
          : "unexpected_response";
    const bodyRequestId =
      typeof envelope["request_id"] === "string" ? envelope["request_id"] : undefined;
    return new APIError({
      status,
      code,
      message: envelope["message"],
      param: typeof envelope["param"] === "string" ? envelope["param"] : undefined,
      requestId: requestId ?? bodyRequestId,
      // An idempotent replay has a new request-id header but the original id in its body.
      originalRequestId:
        bodyRequestId !== undefined && requestId !== undefined && bodyRequestId !== requestId
          ? bodyRequestId
          : undefined,
      retryAfter,
      headers,
      body: parsed.ok ? parsed.value : text,
      idempotencyKey,
    });
  }
  return new APIError({
    status,
    code: "unexpected_response",
    message: `Unexpected ${status} response from relayfor.si: ${snippet(text)}`,
    requestId,
    retryAfter,
    headers,
    body: parsed.ok ? parsed.value : text,
    idempotencyKey,
  });
}

interface ParsedResponse {
  readonly kind: "json";
  readonly data: unknown;
  readonly status: number;
  readonly requestId: string | undefined;
}

/** A 2xx `text/event-stream` answer, its body not read yet. */
interface StreamResponse {
  readonly kind: "stream";
  readonly body: ReadableStream<Uint8Array>;
  readonly status: number;
  readonly requestId: string | undefined;
  /** Aborts the request; `timedOut` marks an idle timeout. */
  readonly abort: (timedOut: boolean) => void;
  readonly timedOut: () => boolean;
  /** Removes the listener on the caller's signal. */
  readonly release: () => void;
}

function interpret(
  response: FetchResponse,
  text: string,
  idempotencyKey: string | undefined,
): ParsedResponse {
  const { status, headers } = response;
  const requestId = requestIdOf(headers);
  // With redirect: "manual", browsers return an opaque response instead of the 3xx.
  if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    const location = headers.get("location");
    throw new APIError({
      status,
      code: "unexpected_redirect",
      message: `relayfor.si responded with a redirect${location ? ` to ${location}` : ""}. Redirects are not followed; check baseURL.`,
      requestId,
      headers,
      body: text,
      idempotencyKey,
    });
  }
  const parsed = parseJSON(text, headers.get("content-type"));
  if (status >= 200 && status < 300) {
    if (!parsed.ok) {
      throw new APIError({
        status,
        code: "unexpected_response",
        message: `Expected JSON from relayfor.si, got: ${snippet(text)}`,
        requestId,
        headers,
        body: text,
        idempotencyKey,
      });
    }
    return { kind: "json", data: parsed.value, status, requestId };
  }
  throw errorFrom(status, parsed, text, headers, requestId, idempotencyKey);
}

function defaultFetch(): Fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new RelayForSIError(
      "fetch_unavailable",
      "No global fetch found. Pass one with the fetch option.",
    );
  }
  // Looked up on every request so a fetch patched later (msw, Next.js) is used, and called on
  // globalThis because an unbound fetch throws "Illegal invocation" on Workers.
  return (url, init) => globalThis.fetch(url, init);
}

async function attempt(
  config: Config,
  url: string,
  init: PreparedInit,
  timeout: number,
  signal: AbortSignal | undefined,
  idempotencyKey: string | undefined,
  stream: boolean,
): Promise<ParsedResponse | StreamResponse> {
  const send = config.fetch ?? defaultFetch();
  const controller = new AbortController();
  let timedOut = false;
  const abort = (idle: boolean): void => {
    timedOut ||= idle;
    controller.abort();
  };
  const timer = setTimeout(() => abort(true), timeout);
  // Removed in finally, so a long-lived caller signal does not accumulate listeners.
  const forward = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  const release = (): void => signal?.removeEventListener("abort", forward);
  let handedOver = false;
  const failed = (cause: unknown): never => {
    if (signal?.aborted) throw abortReason(signal);
    if (timedOut) {
      throw new TimeoutError(`Request timed out after ${timeout} ms.`, { cause, idempotencyKey });
    }
    throw new ConnectionError(`Could not connect to ${new URL(url).origin}: ${describe(cause)}`, {
      cause,
      idempotencyKey,
    });
  };
  try {
    let response: FetchResponse;
    try {
      response = await send(url, { ...init, signal: controller.signal });
    } catch (cause) {
      return failed(cause);
    }
    const ok = response.status >= 200 && response.status < 300;
    const type = response.headers.get("content-type") ?? "";
    if (stream && ok && type.includes("text/event-stream") && response.body) {
      // The reader owns the request from here: it times out on idle and releases the signal.
      clearTimeout(timer);
      handedOver = true;
      return {
        kind: "stream",
        body: response.body,
        status: response.status,
        requestId: requestIdOf(response.headers),
        abort,
        timedOut: () => timedOut,
        release,
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      return failed(cause);
    }
    return interpret(response, text, idempotencyKey);
  } finally {
    if (!handedOver) {
      clearTimeout(timer);
      release();
    }
  }
}

function notify<E>(hook: ((event: E) => unknown) | undefined, event: E): void {
  if (!hook) return;
  try {
    void Promise.resolve(hook(event)).catch(() => undefined);
  } catch {
    // A failing hook must not fail the request.
  }
}

/** The `x-relayforsi-sdk` header value. */
export function sdkHeader(
  appInfo: { name: string; version?: string | undefined; url?: string | undefined } | undefined,
): string {
  const base = `relayfor.si-js/${SDK_VERSION}`;
  if (!appInfo) return base;
  const name = headerSafe(appInfo.name);
  if (!name) return base;
  const version = appInfo.version ? `/${headerSafe(appInfo.version)}` : "";
  const url = appInfo.url ? ` (+${headerSafe(appInfo.url)})` : "";
  return `${base} ${name}${version}${url}`;
}

function checkDuration(value: number, name: string, min: number): number {
  if (!Number.isFinite(value) || value < min) {
    throw new RelayForSIError("invalid_argument", `${name} must be a number >= ${min}.`);
  }
  return value;
}

/** Runs `call` with retries until an answer: parsed JSON, or a stream not read yet. */
async function perform(
  config: Config,
  call: Call,
  stream: boolean,
): Promise<ParsedResponse | StreamResponse> {
  const options = call.options ?? {};
  const signal = options.signal;
  if (signal?.aborted) throw abortReason(signal);

  const key =
    call.auth === "none"
      ? undefined
      : call.key !== undefined
        ? checkKey(call.key, call.auth)
        : await resolveKey(call.auth === "secret" ? config.apiKey : config.routerKey, call.auth);
  const url = buildURL(config.baseURL, call.path, call.query);
  // Serialized once: every attempt must send the same bytes for the idempotency check.
  const body = call.body === undefined ? undefined : serialize(call.body);
  const idempotencyKey =
    call.method === "POST" && call.charged !== true
      ? checkIdempotencyKey(options.idempotencyKey ?? newIdempotencyKey())
      : undefined;
  const headers = buildHeaders(config, options, key, body !== undefined, idempotencyKey);
  if (stream) headers.set("accept", "text/event-stream, application/json");
  const timeout = checkDuration(options.timeout ?? call.timeout ?? config.timeout, "timeout", 1);
  const maxRetries = Math.floor(
    checkDuration(options.maxRetries ?? config.maxRetries, "maxRetries", 0),
  );
  const init: PreparedInit = {
    ...config.fetchOptions,
    ...options.fetchOptions,
    method: call.method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  };

  let retries = 0;
  let inProgressSince: number | undefined;
  for (let attemptNumber = 1; ; attemptNumber++) {
    const event: RequestEvent = {
      method: call.method,
      url,
      attempt: attemptNumber,
      idempotencyKey,
    };
    notify(config.hooks.onRequest, event);
    const started = monotonicNow();
    try {
      const result = await attempt(config, url, init, timeout, signal, idempotencyKey, stream);
      notify(config.hooks.onResponse, {
        ...event,
        status: result.status,
        requestId: result.requestId,
        durationMs: monotonicNow() - started,
      });
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (!isRelayForSIError(error)) throw error;
      if (isAPIError(error)) {
        notify(config.hooks.onResponse, {
          ...event,
          status: error.status,
          requestId: error.requestId,
          durationMs: monotonicNow() - started,
        });
      }
      const retryAfter = isAPIError(error) ? error.retryAfter : undefined;
      let delay: number;
      switch (classify(error, call.charged === true)) {
        case "in_progress":
          // The original request is still running. Wait on a separate time budget, not
          // maxRetries; the minimum step keeps a retry-after of 0 from spinning.
          inProgressSince ??= started;
          delay = Math.max(
            MIN_IN_PROGRESS_STEP_MS,
            Math.min(retryAfter ?? IN_PROGRESS_STEP_MS, IN_PROGRESS_BUDGET_MS),
          );
          if (monotonicNow() - inProgressSince + delay > IN_PROGRESS_BUDGET_MS) throw error;
          break;
        case "retry":
          if (retries >= maxRetries) throw error;
          if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) throw error;
          delay = retryAfter !== undefined ? retryAfter + Math.random() * 250 : backoff(retries);
          retries++;
          break;
        default:
          throw error;
      }
      notify(config.hooks.onRetry, { ...event, delayMs: delay, error });
      await sleep(delay, signal);
    }
  }
}

/** @internal */
export async function request<T>(config: Config, call: Call): Promise<T> {
  const result = await perform(config, call, false);
  // Never a stream: perform() reads the body when `stream` is false.
  if (result.kind !== "json") throw new Error("unreachable");
  // Responses are typed from the OpenAPI document, not validated at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result.data as T;
}

/** Marks `[DONE]`, the end of a stream. */
const DONE: unique symbol = Symbol("done");

/** A streamed call's answer: its events, or the JSON a server answered instead of a stream. */
export type Streamed =
  | { readonly kind: "json"; readonly data: unknown }
  | { readonly kind: "events"; readonly events: AsyncGenerator<unknown, void, undefined> };

/**
 * @internal Sends `call` asking for server-sent events. Retries happen before the first byte
 * of an answer; once a stream starts, a failure ends it with an error.
 */
export async function requestStream(config: Config, call: Call): Promise<Streamed> {
  const result = await perform(config, call, true);
  if (result.kind === "json") return { kind: "json", data: result.data };
  const timeout = call.options?.timeout ?? call.timeout ?? config.timeout;
  return { kind: "events", events: readEvents(result, call.options?.signal, timeout) };
}

/**
 * The `data` of each server-sent event, parsed, until `[DONE]` or the end of the stream. An
 * `error` event throws an APIError with its code. `timeout` bounds the wait for each chunk.
 */
async function* readEvents(
  stream: StreamResponse,
  signal: AbortSignal | undefined,
  timeout: number,
): AsyncGenerator<unknown, void, undefined> {
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let finished = false;
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new APIError({
        status: stream.status,
        code: "unexpected_response",
        message: `Expected JSON in a server-sent event, got: ${snippet(text)}`,
        requestId: stream.requestId,
        headers: new Headers(),
        body: text,
      });
    }
  };
  /** One complete event: undefined to go on, "done" at [DONE], or the parsed data. */
  const dispatch = (): unknown => {
    const text = data.join("\n");
    data = [];
    if (text === "") return undefined;
    if (text.trim() === "[DONE]") return DONE;
    const value = parse(text);
    if (isObject(value) && value["type"] === "error") {
      // The Image API's shape is {type: "error", error: {message, code}}.
      const details = isObject(value["error"]) ? value["error"] : value;
      throw new APIError({
        status: stream.status,
        code:
          typeof details["code"] === "string" && details["code"] !== ""
            ? details["code"]
            : "stream_error",
        message: typeof details["message"] === "string" ? details["message"] : "The stream failed.",
        requestId: stream.requestId,
        headers: new Headers(),
        body: value,
      });
    }
    return value;
  };
  // Raced against the idle timer and the caller's signal, so a fetch that ignores its abort
  // signal still cannot leave a read hanging.
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      // An abort between two reads fires no event, so it is checked before each one.
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const idle = setTimeout(() => {
        stream.abort(true);
        reject(new TimeoutError(`No data from the stream for ${timeout} ms.`));
      }, timeout);
      const onAbort = (): void => {
        if (signal) reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      reader
        .read()
        .then(resolve, (cause: unknown) => {
          if (signal?.aborted) reject(abortReason(signal));
          else if (stream.timedOut()) {
            reject(new TimeoutError(`No data from the stream for ${timeout} ms.`, { cause }));
          } else reject(new ConnectionError(`The stream broke: ${describe(cause)}`, { cause }));
        })
        .finally(() => {
          clearTimeout(idle);
          signal?.removeEventListener("abort", onAbort);
        });
    });
  try {
    for (;;) {
      const chunk = await read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      // The last piece may be a line still arriving.
      buffer = chunk.done ? "" : (lines.pop() ?? "");
      if (chunk.done) lines.push("");
      for (const line of lines) {
        if (line === "") {
          const value = dispatch();
          if (value === DONE) {
            finished = true;
            return;
          }
          if (value !== undefined) yield value;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
        // Comments (":") and other fields (event, id, retry) carry nothing we read.
      }
      if (chunk.done) {
        finished = true;
        return;
      }
    }
  } finally {
    stream.release();
    if (!finished) {
      // Stopped early (a break, a thrown error): end the request instead of leaving it open.
      stream.abort(false);
      await reader.cancel().catch(() => undefined);
    }
  }
}
