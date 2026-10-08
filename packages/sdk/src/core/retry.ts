import { isAPIError, isConnectionError, type RelayForSIError } from "./errors";

/** A longer Retry-After is not waited for; the error is thrown with `retryAfter` set. */
export const MAX_RETRY_AFTER_MS = 60_000;
/** Total time spent waiting on `idempotency_in_progress`, separate from maxRetries. */
export const IN_PROGRESS_BUDGET_MS = 30_000;
export const IN_PROGRESS_STEP_MS = 1_000;
export const MIN_IN_PROGRESS_STEP_MS = 250;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

// Intentional closures, not outages.
const CLOSED = new Set(["launches_closed", "purchases_closed", "webhooks_closed"]);

/**
 * Router refusals that prove the call never started and cost nothing: the only failures a
 * charged call (an image generation) retries. A provider's failure may already be billed.
 */
const REFUSED_UNCHARGED = new Set([
  "rate_limited",
  "too_many_running_calls",
  "too_much_reserved",
  "model_busy",
  "gateway_busy",
  "gateway_capacity",
  "gateway_unavailable",
  "service_unavailable",
  "storage_unavailable",
  "catalog_unavailable",
  "gateway_error",
  "upstream_unreachable",
]);

export type RetryClass = "retry" | "in_progress" | "never";

/**
 * Whether `error` may be retried. A `charged` call is retried only after a refusal in
 * REFUSED_UNCHARGED, never after a lost connection or a timeout.
 */
export function classify(error: RelayForSIError, charged = false): RetryClass {
  if (charged) {
    return isAPIError(error) && REFUSED_UNCHARGED.has(error.code) ? "retry" : "never";
  }
  if (isConnectionError(error)) return "retry";
  if (!isAPIError(error)) return "never";
  if (error.code === "idempotency_in_progress") return "in_progress";
  switch (error.status) {
    case 408:
    case 429:
    case 500:
    case 502:
    case 504:
      return "retry";
    case 503:
      return CLOSED.has(error.code) ? "never" : "retry";
    default:
      return "never";
  }
}

/** Exponential backoff with full jitter. `retry` starts at 0. */
export function backoff(retry: number): number {
  return Math.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry);
}

/** Reads `retry-after-ms`, or `retry-after` as seconds or an HTTP date, in milliseconds. */
export function parseRetryAfter(headers: { get(name: string): string | null }): number | undefined {
  const ms = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The signal's abort reason, or an AbortError if the runtime provides none. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Resolves after `ms`, or rejects when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      if (signal) reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
