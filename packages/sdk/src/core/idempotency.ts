import { RelayForSIError } from "./errors";

// Same rule as the API: 1 to 255 visible ASCII characters.
const KEY = /^[\x21-\x7e]{1,255}$/;

/** A random UUID v4. */
export function newIdempotencyKey(): string {
  const crypto = globalThis.crypto;
  // Browsers expose randomUUID only in secure contexts.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function checkIdempotencyKey(key: string): string {
  if (!KEY.test(key)) {
    throw new RelayForSIError(
      "invalid_idempotency_key",
      "An Idempotency-Key must be 1 to 255 visible ASCII characters, with no spaces.",
    );
  }
  return key;
}
