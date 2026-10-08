import { segment, type RequestOptions } from "../core/request";
import type { Project, Statement, Usage, UsageParams } from "../types";
import { API, type Caller } from "./shared";

export interface ProjectResource {
  /** Gets the project the secret key belongs to. `GET /project` */
  get(options?: RequestOptions): Promise<Project>;
}

export interface UsageResource {
  /**
   * Gets AI usage by day, account, key and model, optionally for one `account` or `key`. `from`
   * and `to` are YYYY-MM-DD (UTC), at most 31 days apart; the default is the last 7 days.
   * `GET /usage`
   */
  get(params?: UsageParams, options?: RequestOptions): Promise<Usage>;
}

export interface StatementsResource {
  /** Gets the statement for a month (YYYY-MM). `GET /statements/{month}` */
  get(month: string, options?: RequestOptions): Promise<Statement>;
}

export function project(call: Caller): ProjectResource {
  return {
    get: async (options) =>
      call({ method: "GET", path: `${API}/project`, auth: "secret", options }),
  };
}

export function usage(call: Caller): UsageResource {
  return {
    get: async (params, options) =>
      call({ method: "GET", path: `${API}/usage`, query: params, auth: "secret", options }),
  };
}

export function statements(call: Caller): StatementsResource {
  return {
    get: async (month, options) =>
      call({
        method: "GET",
        path: `${API}/statements/${segment(month, "month")}`,
        auth: "secret",
        options,
      }),
  };
}
