// Signature: hex HMAC-SHA256 of "<timestamp>.<raw body>" keyed with the whsec_ secret.
import { WebhookVerificationError } from "../core/errors";
import type { RelayForSIEvent } from "./events";

export type * from "./events";
export {
  WebhookVerificationError,
  isWebhookVerificationError,
  type WebhookErrorCode,
} from "../core/errors";

/** The header that carries the signature. */
export const SIGNATURE_HEADER: string = "relayfor-signature";

/** Default tolerance in milliseconds (5 minutes). */
export const DEFAULT_TOLERANCE: number = 300_000;

export interface VerifyWebhookOptions {
  /** The raw request body, for example `await request.text()`. Not parsed JSON. */
  body: string | Uint8Array | ArrayBuffer;
  /** The `relayfor-signature` header. */
  header: string | null | undefined;
  /** The endpoint's secret (`whsec_...`), or a list of secrets during rotation. */
  secret: string | readonly string[];
  /** Maximum clock difference in milliseconds. Defaults to 300000. */
  tolerance?: number | undefined;
  /** Current time in milliseconds, for testing. */
  now?: number | undefined;
}

export interface SignWebhookOptions {
  secret: string;
  body: string | Uint8Array;
  /** Unix seconds. Defaults to now. */
  timestamp?: number | undefined;
}

const encoder = new TextEncoder();

function bytesOf(body: unknown): Uint8Array {
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new WebhookVerificationError(
    "body_not_raw",
    "The body must be the raw request body as a string or bytes, not parsed JSON.",
  );
}

function secretsOf(secret: unknown): string[] {
  const list = (Array.isArray(secret) ? secret : [secret]).filter(
    (item): item is string => typeof item === "string" && item.trim() !== "",
  );
  if (list.length === 0) {
    throw new WebhookVerificationError("missing_webhook_secret", "Missing webhook secret.");
  }
  return list.map((item) => {
    const trimmed = item.trim();
    if (!trimmed.startsWith("whsec_")) {
      throw new WebhookVerificationError("wrong_key_type", "Webhook secrets start with whsec_.");
    }
    return trimmed;
  });
}

function hexBytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedBytes(timestamp: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  // Signs the received bytes directly; decoding and re-encoding could alter invalid UTF-8.
  const prefix = encoder.encode(`${timestamp}.`);
  const data = new Uint8Array(prefix.length + body.length);
  data.set(prefix);
  data.set(body, prefix.length);
  return data;
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

interface Signature {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

function parseHeader(header: string | null | undefined): Signature {
  if (header === null || header === undefined || header.trim() === "") {
    throw new WebhookVerificationError("header_missing", `Missing ${SIGNATURE_HEADER} header.`);
  }
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    // Unknown schemes are ignored for forward compatibility.
    else if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookVerificationError("header_malformed", `Malformed ${SIGNATURE_HEADER} header.`);
  }
  return { timestamp, signatures };
}

/**
 * Verifies a webhook delivery and returns its event. Throws a `WebhookVerificationError` when
 * the signature is invalid or the timestamp is outside the tolerance.
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<RelayForSIEvent> {
  const secrets = secretsOf(options.secret);
  const body = bytesOf(options.body);
  const { timestamp, signatures } = parseHeader(options.header);
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const now = options.now ?? Date.now();
  if (Math.abs(now - timestamp * 1_000) > tolerance) {
    throw new WebhookVerificationError(
      "timestamp_outside_tolerance",
      `Signature timestamp is outside the ${tolerance} ms tolerance.`,
    );
  }
  const data = signedBytes(timestamp, body);
  for (const secret of secrets) {
    const key = await hmacKey(secret, "verify");
    for (const signature of signatures) {
      // Constant-time comparison.
      if (await globalThis.crypto.subtle.verify("HMAC", key, hexBytes(signature), data)) {
        const text =
          typeof options.body === "string" ? options.body : new TextDecoder().decode(body);
        try {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- signed by relayfor.si
          return JSON.parse(text) as RelayForSIEvent;
        } catch {
          throw new WebhookVerificationError("body_not_json", "The body is not valid JSON.");
        }
      }
    }
  }
  throw new WebhookVerificationError(
    "signature_mismatch",
    "No signature matches the body and secret.",
  );
}

/** Creates a valid signature header for `body`. Useful for testing webhook handlers. */
export async function signWebhook(options: SignWebhookOptions): Promise<string> {
  const secret = secretsOf(options.secret)[0] ?? "";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1_000);
  const key = await hmacKey(secret, "sign");
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    signedBytes(timestamp, bytesOf(options.body)),
  );
  return `t=${timestamp},v1=${hex(mac)}`;
}
