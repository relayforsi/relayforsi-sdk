import { RelayForSIError, TimeoutError } from "../core/errors";
import { checkIdempotencyKey, newIdempotencyKey } from "../core/idempotency";
import type { Call, RequestOptions } from "../core/request";
import { sleep } from "../core/retry";
import { monotonicNow } from "../core/runtime";

export type Caller = <T>(call: Call) => Promise<T>;

export const API = "/api/project/v1";

export interface WaitOptions {
  /** Total milliseconds before throwing `wait_timeout`. */
  timeout?: number | undefined;
  /** Milliseconds between polls. */
  interval?: number | undefined;
  signal?: AbortSignal | undefined;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RelayForSIError(
      "invalid_argument",
      `${name} must be a positive number of ms, got ${value}.`,
    );
  }
  return value;
}

export async function waitUntil<T>(
  get: (options: RequestOptions) => Promise<T>,
  done: (value: T) => boolean,
  options: WaitOptions,
  defaults: { readonly timeout: number; readonly interval: number },
  what: string,
): Promise<T> {
  const timeout = positive(options.timeout ?? defaults.timeout, "timeout");
  const interval = positive(options.interval ?? defaults.interval, "interval");
  const deadline = monotonicNow() + timeout;
  for (;;) {
    const last = await get({ signal: options.signal });
    if (done(last)) return last;
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) {
      throw new TimeoutError(
        `${what} did not finish within ${timeout} ms.`,
        { last },
        "wait_timeout",
      );
    }
    await sleep(Math.min(interval, remaining), options.signal);
  }
}

/**
 * `options` with an Idempotency-Key fixed before the call, so an error can name the key the
 * request actually carried, whether the caller's or a generated one.
 */
export function withIdempotencyKey(
  options: RequestOptions | undefined,
): RequestOptions & { idempotencyKey: string } {
  return {
    ...options,
    idempotencyKey: checkIdempotencyKey(options?.idempotencyKey ?? newIdempotencyKey()),
  };
}

/**
 * A null secret means the response is a replay whose secret the API could not give back: it
 * returns router keys and webhook secrets to a retry within 24 hours, so this is a backstop.
 */
export function requireSecret<T extends { readonly id: string }, K extends keyof T>(
  response: T,
  field: K,
  advice: string,
  options: RequestOptions & { idempotencyKey: string },
): T & { [P in K]: string } {
  const secret = response[field];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
  if (typeof secret === "string" && secret !== "") return response as T & { [P in K]: string };
  const id = response.id;
  throw new RelayForSIError(
    "secret_unrecoverable",
    `The response is a replay of an earlier request with the same Idempotency-Key and does not include the secret. ${advice}`,
    { resourceId: id, idempotencyKey: options.idempotencyKey },
  );
}
