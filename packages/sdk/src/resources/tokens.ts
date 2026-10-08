import { segment, type RequestOptions } from "../core/request";
import { pageQuery, paginate } from "../pagination";
import type {
  Launch,
  ListParams,
  Token,
  TokenDetail,
  TokenImportParams,
  TokenList,
} from "../types";
import { API, type Caller } from "./shared";

export interface TokensResource {
  /**
   * Brings an existing pump.fun token onto a route. Returns a launch of kind `import` whose
   * `transaction` the token's creator signs; submit it with `launches.submit()`. The 1 SOL
   * import fee is in the transaction. Counts against the project's 10 launches a minute.
   * `POST /tokens/import`
   */
  import(params: TokenImportParams, options?: RequestOptions): Promise<Launch>;
  /**
   * Gets a token with its market state (`market` is null when it could not be read).
   * `GET /tokens/{mint}`
   */
  get(mint: string, options?: RequestOptions): Promise<TokenDetail>;
  /** Lists the project's tokens, newest first. `GET /tokens` */
  list(params?: ListParams, options?: RequestOptions): Promise<TokenList>;
  /** Iterates over all of the project's tokens. */
  all(params?: ListParams, options?: RequestOptions): AsyncGenerator<Token, void, undefined>;
}

export function tokens(call: Caller): TokensResource {
  const resource: TokensResource = {
    import: async (params, options) =>
      call({ method: "POST", path: `${API}/tokens/import`, body: params, auth: "secret", options }),
    get: async (mint, options) =>
      call({
        method: "GET",
        path: `${API}/tokens/${segment(mint, "mint")}`,
        auth: "secret",
        options,
      }),
    list: async (params, options) =>
      call({ method: "GET", path: `${API}/tokens`, query: params, auth: "secret", options }),
    all: (params, options) =>
      paginate((cursor) => resource.list(pageQuery(params, cursor), options)),
  };
  return resource;
}
