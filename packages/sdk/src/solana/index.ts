// Wire formats: legacy and v0 start with a short-u16 signature count and the signatures,
// followed by the message (a v0 message starts with 0x80). v1 (SIMD-0385) starts with the
// message (first byte 0x81) and ends with the signatures; the count is the message's second byte.
import { base58 } from "@scure/base";

import { fromBase64, toBase64 } from "../core/base64";
import { RelayForSIError } from "../core/errors";

/** Transaction versions, as named by Wallet Standard. */
export type WalletTransactionVersion = "legacy" | 0 | 1;

/** A launch's (or import's) `transaction` object, or a purchase's base64 `transaction`. */
export type TransactionLike = string | { readonly base64: string } | null | undefined;

/** Signs serialized transaction bytes and returns the signed bytes. */
export type SignBytes = (transaction: Uint8Array) => Promise<Uint8Array>;

/** A Wallet Standard account. */
export interface WalletAccountLike {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
}

/** A Wallet Standard wallet. Only `features` is read. */
export interface WalletLike {
  readonly features: Readonly<Record<string, unknown>>;
}

/** Anything that lists supported transaction versions, such as Kit's connected wallet. */
export interface VersionSupport {
  readonly supportedTransactionVersions: Iterable<WalletTransactionVersion>;
}

export interface WalletOptions {
  /** Defaults to "solana:mainnet". */
  chain?: string | undefined;
}

const SIGN = "solana:signTransaction";
const SIGN_AND_SEND = "solana:signAndSendTransaction";
const MAINNET = "solana:mainnet";

interface SignFeature {
  readonly supportedTransactionVersions?: readonly WalletTransactionVersion[];
  readonly signTransaction: (
    ...inputs: readonly { account: WalletAccountLike; transaction: Uint8Array; chain?: string }[]
  ) => Promise<readonly { signedTransaction: Uint8Array }[]>;
}

interface SignAndSendFeature {
  readonly supportedTransactionVersions?: readonly WalletTransactionVersion[];
  readonly signAndSendTransaction: (
    ...inputs: readonly { account: WalletAccountLike; transaction: Uint8Array; chain: string }[]
  ) => Promise<readonly { signature: Uint8Array }[]>;
}

function notATransaction(why: string): RelayForSIError {
  return new RelayForSIError("invalid_argument", `Invalid Solana transaction: ${why}.`);
}

/** Decodes a transaction returned by the API. */
export function transactionBytes(transaction: TransactionLike): Uint8Array {
  if (transaction === null || transaction === undefined) {
    throw new RelayForSIError(
      "invalid_argument",
      "No transaction to sign. A launch has one only while `prepared`, and a purchase only in the response to create().",
    );
  }
  const text = typeof transaction === "string" ? transaction : transaction.base64;
  return fromBase64(text, "The transaction");
}

/** Reads a short-u16 and returns its value and byte length. */
function shortU16(bytes: Uint8Array): readonly [value: number, size: number] {
  let value = 0;
  for (let index = 0; index < 3; index++) {
    const byte = bytes[index];
    if (byte === undefined) throw notATransaction("truncated signature count");
    value |= (byte & 0x7f) << (index * 7);
    if ((byte & 0x80) === 0) return [value, index + 1];
  }
  throw notATransaction("malformed signature count");
}

/** The message bytes of a serialized transaction. */
function messageOf(transaction: Uint8Array): Uint8Array {
  const first = transaction[0];
  if (first === undefined) throw notATransaction("empty");
  if ((first & 0x80) === 0) {
    const [count, size] = shortU16(transaction);
    const start = size + count * 64;
    if (start >= transaction.length) throw notATransaction("signatures exceed its length");
    return transaction.subarray(start);
  }
  if ((first & 0x7f) === 1) {
    const count = transaction[1] ?? 0;
    const end = transaction.length - count * 64;
    if (end <= 2) throw notATransaction("signatures exceed its length");
    return transaction.subarray(0, end);
  }
  throw notATransaction(`unknown version ${first & 0x7f}`);
}

/** Returns the version of a serialized transaction. */
export function transactionVersionOf(
  transaction: TransactionLike | Uint8Array,
): WalletTransactionVersion {
  const bytes = transaction instanceof Uint8Array ? transaction : transactionBytes(transaction);
  const first = bytes[0];
  if (first === undefined) throw notATransaction("empty");
  if ((first & 0x80) !== 0) return 1;
  const prefix = messageOf(bytes)[0] ?? 0;
  return (prefix & 0x80) === 0 ? "legacy" : 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function hasMethod(wallet: WalletLike, name: string, method: string): boolean {
  const feature = wallet.features[name];
  return (
    typeof feature === "object" &&
    feature !== null &&
    typeof Reflect.get(feature, method) === "function"
  );
}

function signFeature(wallet: WalletLike): SignFeature | undefined {
  if (!hasMethod(wallet, SIGN, "signTransaction")) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
  return wallet.features[SIGN] as SignFeature;
}

function sendFeature(wallet: WalletLike): SignAndSendFeature | undefined {
  if (!hasMethod(wallet, SIGN_AND_SEND, "signAndSendTransaction")) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked above
  return wallet.features[SIGN_AND_SEND] as SignAndSendFeature;
}

function versionsOf(source: WalletLike | VersionSupport): ReadonlySet<WalletTransactionVersion> {
  if ("supportedTransactionVersions" in source) return new Set(source.supportedTransactionVersions);
  const lists = [
    signFeature(source)?.supportedTransactionVersions,
    sendFeature(source)?.supportedTransactionVersions,
  ].filter((list) => list !== undefined);
  if (lists.length === 0) {
    throw new RelayForSIError(
      "wallet_unsupported",
      "The wallet does not support signing Solana transactions.",
    );
  }
  // A version counts only if every signing feature supports it, matching Kit's wallet plugin.
  const [first = [], ...rest] = lists;
  return new Set(first.filter((version) => rest.every((list) => list.includes(version))));
}

/**
 * Returns the `transaction_version` to pass to `launches.prepare()` or `tokens.import()`: 1 if
 * the wallet supports it, otherwise 0. A v0 launch carries no opening buy and fits the creator
 * and about 2 funded project wallets in its route. Throws `wallet_unsupported` if the wallet
 * only signs legacy transactions.
 */
export function pickTransactionVersion(source: WalletLike | VersionSupport): 0 | 1 {
  const versions = versionsOf(source);
  if (versions.has(1)) return 1;
  if (versions.has(0)) return 0;
  throw new RelayForSIError(
    "wallet_unsupported",
    "The wallet only supports legacy transactions. Launches require v0 or v1.",
  );
}

/**
 * Signs a transaction with `sign` and returns it as base64 for `launches.submit()`. Throws
 * `wallet_modified_transaction` if the wallet changed the message, which the API would reject.
 * Errors from the wallet are rethrown unchanged.
 */
export async function signTransactionWith(
  transaction: TransactionLike,
  sign: SignBytes,
): Promise<string> {
  const bytes = transactionBytes(transaction);
  const message = messageOf(bytes);
  const signed = await sign(bytes.slice());
  if (!(signed instanceof Uint8Array) || !sameBytes(messageOf(signed), message)) {
    throw new RelayForSIError(
      "wallet_modified_transaction",
      "The wallet modified the transaction while signing it.",
    );
  }
  return toBase64(signed);
}

/** A `SignBytes` function using a Wallet Standard wallet's `solana:signTransaction`. */
export function walletStandardSigner(
  wallet: WalletLike,
  account: WalletAccountLike,
  options: WalletOptions = {},
): SignBytes {
  return async (transaction) => {
    const feature = signFeature(wallet);
    if (!feature) {
      throw new RelayForSIError(
        "wallet_unsupported",
        "The wallet does not support solana:signTransaction.",
      );
    }
    const version = transactionVersionOf(transaction);
    if (
      feature.supportedTransactionVersions &&
      !feature.supportedTransactionVersions.includes(version)
    ) {
      throw new RelayForSIError(
        "wallet_unsupported",
        `The wallet does not support ${version === "legacy" ? "legacy" : `v${version}`} transactions. Use pickTransactionVersion() before preparing.`,
      );
    }
    const [output] = await feature.signTransaction({
      account,
      transaction,
      chain: options.chain ?? MAINNET,
    });
    if (!output)
      throw new RelayForSIError("wallet_unsupported", "The wallet returned no signed transaction.");
    return output.signedTransaction;
  };
}

/** Signs a launch or purchase transaction with a Wallet Standard wallet. Returns base64. */
export function signWithWallet(
  wallet: WalletLike,
  account: WalletAccountLike,
  transaction: TransactionLike,
  options: WalletOptions = {},
): Promise<string> {
  return signTransactionWith(transaction, walletStandardSigner(wallet, account, options));
}

/**
 * Signs and sends a transaction with the wallet's `solana:signAndSendTransaction` and returns
 * the base58 signature. Prefer `signWithWallet` with `launches.submit()`.
 */
export async function sendWithWallet(
  wallet: WalletLike,
  account: WalletAccountLike,
  transaction: TransactionLike,
  options: WalletOptions = {},
): Promise<string> {
  const feature = sendFeature(wallet);
  if (!feature) {
    throw new RelayForSIError(
      "wallet_unsupported",
      "The wallet does not support solana:signAndSendTransaction.",
    );
  }
  const [output] = await feature.signAndSendTransaction({
    account,
    transaction: transactionBytes(transaction),
    chain: options.chain ?? MAINNET,
  });
  if (!output) throw new RelayForSIError("wallet_unsupported", "The wallet returned no signature.");
  return base58.encode(output.signature);
}
