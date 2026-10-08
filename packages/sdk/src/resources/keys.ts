import { segment, type RequestOptions } from "../core/request";
import { pageQuery, paginate } from "../pagination";
import type {
  KeyCreateParams,
  KeyListParams,
  KeyUpdateParams,
  NewRouterKey,
  RouterKey,
  RouterKeyList,
} from "../types";
import { API, requireSecret, withIdempotencyKey, type Caller } from "./shared";

export interface KeysResource {
  /**
   * Creates a router key (`rf_ai_...`) on an account, with an optional spending limit. The key
   * is shown once; a retry with the same Idempotency-Key within 24 hours gets it again. Throws
   * `secret_unrecoverable` (with `resourceId`) in the rare case a replay cannot return it. At
   * most 100 active keys per account (`too_many_keys`). `POST /keys`
   */
  create(
    params: KeyCreateParams,
    options?: RequestOptions,
  ): Promise<NewRouterKey & { key: string }>;
  /** `GET /keys/{id}` */
  get(id: string, options?: RequestOptions): Promise<RouterKey>;
  /** Renames a key or changes its limit. `limit: null` removes the limit. `PATCH /keys/{id}` */
  update(id: string, params: KeyUpdateParams, options?: RequestOptions): Promise<RouterKey>;
  /** Revokes a key. Revoking twice is safe. `DELETE /keys/{id}` */
  revoke(id: string, options?: RequestOptions): Promise<RouterKey>;
  /** Lists active keys, optionally for one account. `GET /keys` */
  list(params?: KeyListParams, options?: RequestOptions): Promise<RouterKeyList>;
  /** Iterates over all active keys. */
  all(params?: KeyListParams, options?: RequestOptions): AsyncGenerator<RouterKey, void, undefined>;
}

export function keys(call: Caller): KeysResource {
  const resource: KeysResource = {
    create: async (params, options) => {
      const sent = withIdempotencyKey(options);
      const created = await call<NewRouterKey>({
        method: "POST",
        path: `${API}/keys`,
        body: params,
        auth: "secret",
        options: sent,
      });
      return requireSecret(created, "key", `Revoke ${created.id} and create a new key.`, sent);
    },
    get: async (id, options) =>
      call({ method: "GET", path: `${API}/keys/${segment(id, "id")}`, auth: "secret", options }),
    update: async (id, params, options) =>
      call({
        method: "PATCH",
        path: `${API}/keys/${segment(id, "id")}`,
        body: params,
        auth: "secret",
        options,
      }),
    revoke: async (id, options) =>
      call({ method: "DELETE", path: `${API}/keys/${segment(id, "id")}`, auth: "secret", options }),
    list: async (params, options) =>
      call({ method: "GET", path: `${API}/keys`, query: params, auth: "secret", options }),
    all: (params, options) =>
      paginate((cursor) => resource.list(pageQuery(params, cursor), options)),
  };
  return resource;
}
