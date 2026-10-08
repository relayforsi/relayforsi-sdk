import { segment, type RequestOptions } from "../core/request";
import { pageQuery, paginate } from "../pagination";
import type {
  Launch,
  LaunchList,
  LaunchPrepareParams,
  LaunchSubmitParams,
  ListParams,
} from "../types";
import { API, waitUntil, type Caller, type WaitOptions } from "./shared";

const DONE = new Set(["confirmed", "failed", "expired"]);

export interface LaunchesResource {
  /**
   * Prepares a token launch from the creator's wallet: the transaction, its route locked in it,
   * checked by simulation and signed by the new mint. The creator's wallet signs
   * `transaction.base64` last; send it yourself or pass it to `submit()`. The project's default
   * fee preset splits the fees unless `preset` or `split` says otherwise. `transaction_version`
   * is 1 by default; 0 is for wallets without v1 and carries no opening buy. Counts against the
   * project's 10 launches a minute. `POST /launches/prepare`
   */
  prepare(params: LaunchPrepareParams, options?: RequestOptions): Promise<Launch>;
  /**
   * Sends the transaction the creator's wallet signed (a launch or an import). Sending the same
   * signed bytes again answers the launch as it stands. `POST /launches/{id}/submit`
   */
  submit(id: string, params: LaunchSubmitParams, options?: RequestOptions): Promise<Launch>;
  /** Gets a launch or import, re-checked on chain while it is pending. `GET /launches/{id}` */
  get(id: string, options?: RequestOptions): Promise<Launch>;
  /** Lists launches and imports, newest first. `GET /launches` */
  list(params?: ListParams, options?: RequestOptions): Promise<LaunchList>;
  /** Iterates over all launches. */
  all(params?: ListParams, options?: RequestOptions): AsyncGenerator<Launch, void, undefined>;
  /**
   * Polls until the launch is `confirmed`, `failed` or `expired` (by default every 2 s for up to
   * 2 minutes) and returns it; a failed launch is returned, not thrown. Throws `wait_timeout`
   * with the last launch in `error.last`. For many launches at once, prefer the
   * `launch.confirmed`, `token.imported` and `launch.failed` webhooks to stay within the 300
   * requests a minute each key may make.
   */
  wait(id: string, options?: WaitOptions): Promise<Launch>;
}

export function launches(call: Caller): LaunchesResource {
  const resource: LaunchesResource = {
    prepare: async (params, options) =>
      call({
        method: "POST",
        path: `${API}/launches/prepare`,
        body: params,
        auth: "secret",
        options,
      }),
    submit: async (id, params, options) =>
      call({
        method: "POST",
        path: `${API}/launches/${segment(id, "id")}/submit`,
        body: params,
        auth: "secret",
        options,
      }),
    get: async (id, options) =>
      call({
        method: "GET",
        path: `${API}/launches/${segment(id, "id")}`,
        auth: "secret",
        options,
      }),
    list: async (params, options) =>
      call({ method: "GET", path: `${API}/launches`, query: params, auth: "secret", options }),
    all: (params, options) =>
      paginate((cursor) => resource.list(pageQuery(params, cursor), options)),
    wait: async (id, options = {}) =>
      waitUntil(
        (request) => resource.get(id, request),
        (launch) => DONE.has(launch.state),
        options,
        { timeout: 120_000, interval: 2_000 },
        `Launch ${id}`,
      ),
  };
  return resource;
}
