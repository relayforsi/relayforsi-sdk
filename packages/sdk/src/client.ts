import { RelayForSIError } from "./core/errors";
import {
  checkKey,
  request,
  sdkHeader,
  type Call,
  type Config,
  type ExtraRequestInit,
  type Fetch,
  type Hooks,
  type KeySource,
} from "./core/request";
import { isBrowser } from "./core/runtime";
import { accounts, type AccountsResource } from "./resources/accounts";
import { ai, type AIResource } from "./resources/ai";
import { files, type FilesResource } from "./resources/files";
import { keys, type KeysResource } from "./resources/keys";
import { launches, type LaunchesResource } from "./resources/launches";
import { presets, type PresetsResource } from "./resources/presets";
import {
  project,
  statements,
  usage,
  type ProjectResource,
  type StatementsResource,
  type UsageResource,
} from "./resources/project";
import { tokens, type TokensResource } from "./resources/tokens";
import { webhooks, type WebhooksResource } from "./resources/webhooks";

export interface AppInfo {
  /** Your integration's name, sent in the `x-relayforsi-sdk` header. */
  name: string;
  version?: string | undefined;
  url?: string | undefined;
}

export interface RelayForSIOptions {
  /** The project's secret key (`rf_sk_...`). Defaults to `RELAYFOR_SECRET_KEY`. */
  apiKey?: KeySource | undefined;
  /** A router key (`rf_ai_...`), used by `ai.balance()`. Defaults to `RELAYFOR_ROUTER_KEY`. */
  routerKey?: KeySource | undefined;
  /** Defaults to `https://relayfor.si`. Must be https, except for localhost. */
  baseURL?: string | undefined;
  /** Milliseconds per attempt. Defaults to 30000. */
  timeout?: number | undefined;
  /** Retries after the first attempt. Defaults to 2. */
  maxRetries?: number | undefined;
  /** Defaults to the global `fetch`. */
  fetch?: Fetch | undefined;
  fetchOptions?: ExtraRequestInit | undefined;
  /** Headers sent with every request. */
  headers?: Readonly<Record<string, string>> | undefined;
  hooks?: Hooks | undefined;
  appInfo?: AppInfo | undefined;
  /**
   * The client refuses to run in a browser, where the secret key would be exposed to every
   * visitor. Set to true only if you understand the risk.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

const DEFAULT_BASE_URL = "https://relayfor.si";
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

// Stored outside the instance so keys never show up in console.log or util.inspect.
const OPTIONS = new WeakMap<object, RelayForSIOptions>();

function checkBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayForSIError("invalid_base_url", `baseURL is not a valid URL: "${value}".`);
  }
  if (url.search || url.hash) {
    throw new RelayForSIError("invalid_base_url", "baseURL cannot contain a query or fragment.");
  }
  if (url.protocol === "http:" && !LOCAL.test(url.hostname)) {
    throw new RelayForSIError(
      "insecure_base_url",
      `baseURL must use https (http is allowed for localhost only), got "${value}".`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RelayForSIError("invalid_base_url", `baseURL must be https, got ${url.protocol}`);
  }
  return value.replace(/\/+$/, "");
}

function checkSource(
  source: KeySource | undefined,
  kind: "secret" | "router",
): KeySource | undefined {
  return typeof source === "string" ? checkKey(source, kind) : source;
}

/**
 * The relayfor.si client.
 *
 * ```ts
 * const relayForSI = new RelayForSI({ apiKey: process.env.RELAYFOR_SECRET_KEY });
 * const launch = await relayForSI.launches.prepare({ creator, name, symbol, image });
 * // The creator's wallet signs launch.transaction, then:
 * await relayForSI.launches.submit(launch.id, { transaction: signed });
 * ```
 */
export class RelayForSI {
  readonly project: ProjectResource;
  readonly launches: LaunchesResource;
  readonly tokens: TokensResource;
  readonly accounts: AccountsResource;
  readonly keys: KeysResource;
  readonly usage: UsageResource;
  readonly statements: StatementsResource;
  readonly webhooks: WebhooksResource;
  readonly presets: PresetsResource;
  readonly files: FilesResource;
  readonly ai: AIResource;

  constructor(options: RelayForSIOptions = {}) {
    if (isBrowser() && options.dangerouslyAllowBrowser !== true) {
      throw new RelayForSIError(
        "browser_not_allowed",
        "RelayForSI uses your secret key and must run on a server. Use relayfor.si/solana for wallet signing in the browser.",
      );
    }
    const config: Config = {
      apiKey: checkSource(options.apiKey, "secret"),
      routerKey: checkSource(options.routerKey, "router"),
      baseURL: checkBaseURL(options.baseURL ?? DEFAULT_BASE_URL),
      timeout: options.timeout ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch,
      fetchOptions: options.fetchOptions,
      headers: { ...options.headers },
      hooks: { ...options.hooks },
      sdkHeader: sdkHeader(options.appInfo),
    };
    OPTIONS.set(this, { ...options });
    // Controls what console.log and util.inspect print. Defined here to keep it out of the types.
    Object.defineProperty(this, Symbol.for("nodejs.util.inspect.custom"), {
      value: (): string => `RelayForSI { baseURL: '${config.baseURL}' }`,
      enumerable: false,
    });
    const call = <T>(spec: Call): Promise<T> => request<T>(config, spec);
    this.project = project(call);
    this.launches = launches(call);
    this.tokens = tokens(call);
    this.accounts = accounts(call);
    this.keys = keys(call);
    this.usage = usage(call);
    this.statements = statements(call);
    this.webhooks = webhooks(call);
    this.presets = presets(call);
    this.files = files();
    this.ai = ai(call, config);
  }

  /** Returns a new client with these options applied on top of this client's. */
  withOptions(options: RelayForSIOptions): RelayForSI {
    return new RelayForSI({ ...OPTIONS.get(this), ...options });
  }

  toJSON(): { baseURL: string } {
    return { baseURL: this.ai.baseURL.replace(/\/api\/v1$/, "") };
  }
}
