import { describe, expect, it } from "vitest";

import {
  pickTransactionVersion,
  sendWithWallet,
  signTransactionWith,
  signWithWallet,
  transactionVersionOf,
  type WalletAccountLike,
  type WalletLike,
  type WalletTransactionVersion,
} from "../../src/solana";
import fixtures from "../fixtures/transactions.json" with { type: "json" };

// Transactions built with @solana/kit: partially signed by the mint, fully signed by the
// creator, and a different message signed by both.
const { transactions } = fixtures;
const bytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const account: WalletAccountLike = {
  address: fixtures.creator,
  publicKey: new Uint8Array(32),
  chains: ["solana:mainnet"],
  features: ["solana:signTransaction"],
};

function wallet(
  versions: readonly WalletTransactionVersion[],
  sign: (transaction: Uint8Array) => Uint8Array,
  seen: unknown[] = [],
): WalletLike {
  return {
    features: {
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: versions,
        signTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
          seen.push(...inputs);
          return inputs.map((input) => ({ signedTransaction: sign(input.transaction) }));
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: versions,
        signAndSendTransaction: async () => [{ signature: new Uint8Array(64).fill(1) }],
      },
    },
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected it to throw");
}

describe("transaction versions", () => {
  it.each([
    ["legacy", "legacy"],
    ["0", 0],
    ["1", 1],
  ] as const)("detects a %s transaction", (key, version) => {
    expect(transactionVersionOf(transactions[key].partial)).toBe(version);
    expect(transactionVersionOf({ base64: transactions[key].signed })).toBe(version);
  });

  it("picks v1 when supported, v0 otherwise, and rejects legacy-only wallets", () => {
    expect(pickTransactionVersion(wallet(["legacy", 0, 1], (t) => t))).toBe(1);
    expect(pickTransactionVersion(wallet(["legacy", 0], (t) => t))).toBe(0);
    expect(() => pickTransactionVersion(wallet(["legacy"], (t) => t))).toThrow(
      expect.objectContaining({ code: "wallet_unsupported" }),
    );
    expect(() => pickTransactionVersion({ features: {} })).toThrow(
      expect.objectContaining({ code: "wallet_unsupported" }),
    );
  });

  it("accepts a Set of supported versions", () => {
    expect(
      pickTransactionVersion({
        supportedTransactionVersions: new Set<WalletTransactionVersion>(["legacy", 0, 1]),
      }),
    ).toBe(1);
    expect(
      pickTransactionVersion({
        supportedTransactionVersions: new Set<WalletTransactionVersion>([0]),
      }),
    ).toBe(0);
  });

  it("requires a version to be supported by every signing feature", () => {
    const mixed: WalletLike = {
      features: {
        "solana:signTransaction": {
          supportedTransactionVersions: [0, 1],
          signTransaction: async () => [],
        },
        "solana:signAndSendTransaction": {
          supportedTransactionVersions: [0],
          signAndSendTransaction: async () => [],
        },
      },
    };
    expect(pickTransactionVersion(mixed)).toBe(0);
  });
});

describe("signing", () => {
  it.each(["legacy", "0", "1"] as const)("signs a %s transaction", async (key) => {
    const seen: { chain?: string }[] = [];
    const signed = await signWithWallet(
      wallet(["legacy", 0, 1], () => bytes(transactions[key].signed), seen),
      account,
      { base64: transactions[key].partial },
    );
    expect(signed).toBe(transactions[key].signed);
    expect(seen[0]?.chain).toBe("solana:mainnet");
  });

  it.each(["legacy", "0", "1"] as const)("rejects a modified %s transaction", async (key) => {
    const error = await caught(
      signWithWallet(
        wallet(["legacy", 0, 1], () => bytes(transactions[key].modified)),
        account,
        transactions[key].partial,
      ),
    );
    expect(error).toMatchObject({ code: "wallet_modified_transaction" });
  });

  it("rejects an unsupported version before calling the wallet", async () => {
    const seen: unknown[] = [];
    const error = await caught(
      signWithWallet(
        wallet(["legacy", 0], () => bytes(transactions["1"].signed), seen),
        account,
        transactions["1"].partial,
      ),
    );
    expect(error).toMatchObject({ code: "wallet_unsupported" });
    expect(seen).toHaveLength(0);
  });

  it("rethrows wallet errors unchanged", async () => {
    const declined = new Error("User rejected the request.");
    const error = await caught(
      signTransactionWith(transactions["1"].partial, async () => {
        throw declined;
      }),
    );
    expect(error).toBe(declined);
  });

  it("accepts any sign function and passes it a copy of the bytes", async () => {
    let given: Uint8Array | undefined;
    const signed = await signTransactionWith(transactions["0"].partial, async (transaction) => {
      given = transaction;
      transaction.fill(0);
      return bytes(transactions["0"].signed);
    });
    expect(signed).toBe(transactions["0"].signed);
    expect(given?.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ["no transaction", null],
    ["broken base64", "%%%"],
    ["an empty transaction", ""],
    ["bytes that aren't a transaction", btoa("\x05abc")],
    ["an unknown version", btoa("\x87abcdef")],
  ])("rejects %s", async (_, transaction) => {
    expect(await caught(signTransactionWith(transaction, async (t) => t))).toMatchObject({
      code: "invalid_argument",
    });
  });

  it("sends through the wallet and returns a base58 signature", async () => {
    const signature = await sendWithWallet(
      wallet([0, 1], (t) => t),
      account,
      transactions["1"].partial,
    );
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  });
});
