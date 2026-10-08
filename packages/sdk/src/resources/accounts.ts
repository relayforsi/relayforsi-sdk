import { segment, type RequestOptions } from "../core/request";
import { pageQuery, paginate } from "../pagination";
import type {
  Account,
  AccountList,
  LedgerEntry,
  LedgerList,
  ListParams,
  Purchase,
  PurchaseCreateParams,
  PurchaseList,
} from "../types";
import { API, waitUntil, type Caller, type WaitOptions } from "./shared";

export interface LedgerResource {
  /** Lists an account's ledger entries, newest first. `GET /accounts/{id}/ledger` */
  list(account: string, params?: ListParams, options?: RequestOptions): Promise<LedgerList>;
  /** Iterates over all of an account's ledger entries. */
  all(
    account: string,
    params?: ListParams,
    options?: RequestOptions,
  ): AsyncGenerator<LedgerEntry, void, undefined>;
}

export interface PurchasesResource {
  /**
   * Creates a USDC credit purchase, $20 to $1,000,000 in dollars and cents (`"49.50"`).
   * Returns a v0 transaction for the payer to sign and send,
   * valid for about a minute, and a Solana Pay URL. `POST /accounts/{id}/purchases`
   */
  create(
    account: string,
    params: PurchaseCreateParams,
    options?: RequestOptions,
  ): Promise<Purchase>;
  /** `GET /accounts/{id}/purchases/{purchase}` */
  get(account: string, purchase: string, options?: RequestOptions): Promise<Purchase>;
  /** Lists an account's purchases. `transaction` is always null in lists. */
  list(account: string, params?: ListParams, options?: RequestOptions): Promise<PurchaseList>;
  /** Iterates over all of an account's purchases. */
  all(
    account: string,
    params?: ListParams,
    options?: RequestOptions,
  ): AsyncGenerator<Purchase, void, undefined>;
  /**
   * Polls until the purchase is `credited` (by default every 2 s for up to 10 minutes). An
   * unpaid purchase never credits. Throws `wait_timeout` with the last purchase in `error.last`.
   */
  wait(account: string, purchase: string, options?: WaitOptions): Promise<Purchase>;
}

export interface AccountsResource {
  /** Gets a credit account by id (`acc_...`) or by its token's mint. `GET /accounts/{id}` */
  get(account: string, options?: RequestOptions): Promise<Account>;
  /** `GET /accounts` */
  list(params?: ListParams, options?: RequestOptions): Promise<AccountList>;
  /** Iterates over all accounts. */
  all(params?: ListParams, options?: RequestOptions): AsyncGenerator<Account, void, undefined>;
  readonly ledger: LedgerResource;
  readonly purchases: PurchasesResource;
}

const base = (account: string): string => `${API}/accounts/${segment(account, "account")}`;

export function accounts(call: Caller): AccountsResource {
  const ledger: LedgerResource = {
    list: async (account, params, options) =>
      call({
        method: "GET",
        path: `${base(account)}/ledger`,
        query: params,
        auth: "secret",
        options,
      }),
    all: (account, params, options) =>
      paginate((cursor) => ledger.list(account, pageQuery(params, cursor), options)),
  };

  const purchases: PurchasesResource = {
    create: async (account, params, options) =>
      call({
        method: "POST",
        path: `${base(account)}/purchases`,
        body: params,
        auth: "secret",
        options,
      }),
    get: async (account, purchase, options) =>
      call({
        method: "GET",
        path: `${base(account)}/purchases/${segment(purchase, "purchase")}`,
        auth: "secret",
        options,
      }),
    list: async (account, params, options) =>
      call({
        method: "GET",
        path: `${base(account)}/purchases`,
        query: params,
        auth: "secret",
        options,
      }),
    all: (account, params, options) =>
      paginate((cursor) => purchases.list(account, pageQuery(params, cursor), options)),
    wait: async (account, purchase, options = {}) =>
      waitUntil(
        (request) => purchases.get(account, purchase, request),
        (found) => found.status === "credited",
        options,
        { timeout: 600_000, interval: 2_000 },
        `Purchase ${purchase}`,
      ),
  };

  const resource: AccountsResource = {
    get: async (account, options) =>
      call({ method: "GET", path: base(account), auth: "secret", options }),
    list: async (params, options) =>
      call({ method: "GET", path: `${API}/accounts`, query: params, auth: "secret", options }),
    all: (params, options) =>
      paginate((cursor) => resource.list(pageQuery(params, cursor), options)),
    ledger,
    purchases,
  };
  return resource;
}
