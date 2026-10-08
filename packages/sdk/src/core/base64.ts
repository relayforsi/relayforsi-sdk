// Uses Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 (ES2026) when available, else
// btoa / atob.
import { RelayForSIError } from "./errors";

interface Base64Native {
  toBase64?: (this: Uint8Array) => string;
}

interface Base64Constructor {
  fromBase64?: (text: string) => Uint8Array;
}

export function toBase64(bytes: Uint8Array): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- toBase64 is ES2026, not yet in the lib
  const native = (bytes as Base64Native).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let binary = "";
  // Chunked: spreading a large array into String.fromCharCode overflows the stack.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string, what: string): Uint8Array {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fromBase64 is ES2026, not yet in the lib
    const native = (Uint8Array as Base64Constructor).fromBase64;
    if (typeof native === "function") return native(text);
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch (cause) {
    throw new RelayForSIError("invalid_argument", `${what} is not valid base64.`, { cause });
  }
}
