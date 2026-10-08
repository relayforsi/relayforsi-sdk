import { toBase64 } from "../core/base64";
import { RelayForSIError } from "../core/errors";

/** Maximum token image size accepted by the API. */
export const MAX_IMAGE_BYTES: number = 2 * 1024 * 1024;

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface DataUriOptions {
  /** Expected type. Checked against the file's contents. */
  type?: ImageType | undefined;
}

export interface FilesResource {
  /**
   * Converts an image to the data URI `launches.prepare` expects. Accepts PNG, JPEG, GIF and WebP
   * up to 2 MiB, detected from the file's contents.
   */
  dataUri(input: Blob | ArrayBuffer | ArrayBufferView, options?: DataUriOptions): Promise<string>;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/** Detects the image type from its magic bytes. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return undefined;
}

async function bytesOf(input: Blob | ArrayBuffer | ArrayBufferView): Promise<Uint8Array> {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    // Checked before reading, so oversized files are never loaded into memory.
    if (input.size > MAX_IMAGE_BYTES)
      return new Uint8Array(input.size > 0 ? MAX_IMAGE_BYTES + 1 : 0);
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new RelayForSIError(
    "invalid_argument",
    "dataUri expects a Blob, an ArrayBuffer or a Uint8Array.",
  );
}

export function files(): FilesResource {
  return {
    dataUri: async (input, options = {}) => {
      const bytes = await bytesOf(input);
      if (bytes.length === 0) throw new RelayForSIError("file_too_large", "The image is empty.");
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new RelayForSIError("file_too_large", "The image exceeds the 2 MiB limit.");
      }
      const type = sniffImage(bytes);
      if (!type) {
        throw new RelayForSIError("file_type", "The image must be a PNG, JPEG, GIF or WebP.");
      }
      if (options.type !== undefined && options.type !== type) {
        throw new RelayForSIError(
          "file_type",
          `Expected ${options.type}, but the file is ${type}.`,
        );
      }
      return `data:${type};base64,${toBase64(bytes)}`;
    },
  };
}
