import { http, HttpResponse, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";

import { RelayForSI, type RelayForSIOptions } from "../src";

export const server = setupServer();

export const BASE = "https://relayfor.test";
export const API = `${BASE}/api/project/v1`;
export const SECRET_KEY = `rf_sk_${"a".repeat(40)}`;
export const ROUTER_KEY = `rf_ai_${"b".repeat(40)}`;

export function client(options: RelayForSIOptions = {}): RelayForSI {
  return new RelayForSI({ apiKey: SECRET_KEY, baseURL: BASE, maxRetries: 2, ...options });
}

export interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

/** Records every request that reaches the mock API. */
export function recorder(): { readonly seen: Seen[]; record(request: Request): Promise<void> } {
  const seen: Seen[] = [];
  return {
    seen,
    async record(request) {
      seen.push({
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body: await request.clone().text(),
      });
    },
  };
}

/** The management API's error envelope. */
export function apiError(
  status: number,
  code: string,
  message = `${code} happened`,
  extra: { param?: string; requestId?: string; headers?: Record<string, string> } = {},
): HttpResponse<JsonBodyType> {
  const requestId = extra.requestId ?? "req_0000000000000000";
  return HttpResponse.json(
    {
      error: {
        code,
        message,
        ...(extra.param ? { param: extra.param } : {}),
        request_id: requestId,
      },
    },
    { status, headers: { "request-id": requestId, ...extra.headers } },
  );
}

/** Responds to each request with the next responder; the last one repeats. */
export function sequence(
  method: "get" | "post" | "patch" | "delete",
  url: string,
  responders: readonly ((request: Request) => Response | Promise<Response>)[],
  log?: ReturnType<typeof recorder>,
): void {
  let index = 0;
  server.use(
    http[method](url, async ({ request }) => {
      await log?.record(request);
      const responder = responders[Math.min(index, responders.length - 1)];
      index++;
      if (!responder) throw new Error("no responder");
      return responder(request);
    }),
  );
}

export const launch = {
  id: "lch_0123456789abcdef",
  kind: "wallet",
  state: "prepared",
  mint: "Mint111111111111111111111111111111111111111",
  creator: "Crea111111111111111111111111111111111111111",
  name: "Acme",
  symbol: "ACME",
  metadata_uri: "https://example.test/meta.json",
  image: null,
  route: [],
  preset: null,
  fee_lamports: "20000000",
  quote_mint: "So11111111111111111111111111111111111111112",
  opening_buy: null,
  transaction: { version: 1, base64: "AQID", last_valid_block_height: "300000000" },
  signature: null,
  error: null,
  created_at: "2026-10-05T12:00:00.000Z",
  confirmed_at: null,
} as const;
