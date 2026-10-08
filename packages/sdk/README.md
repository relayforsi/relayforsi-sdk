<p align="center">
  <img src="https://raw.githubusercontent.com/relayforsi/relayforsi-sdk/8517101fa9a5de2268742676f13fa746c9a298a3/assets/banner.png" alt="relayfor.si: the fees-to-AI layer for launchpads" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/relayfor.si"><img src="https://img.shields.io/npm/v/relayfor.si?color=05e587&labelColor=070707" alt="npm version"></a>
  <a href="https://github.com/relayforsi/relayforsi-sdk/actions/workflows/ci.yml"><img src="https://github.com/relayforsi/relayforsi-sdk/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/node/v/relayfor.si?color=05e587&labelColor=070707" alt="Node.js version">
  <a href="https://github.com/relayforsi/relayforsi-sdk/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/relayfor.si?color=05e587&labelColor=070707" alt="MIT license"></a>
</p>

<p align="center">
  <b>The TypeScript SDK for relayfor.si.</b> Launch pump.fun tokens whose creator fees become<br>
  AI credit, and spend it on hundreds of models through the RFS Router.
</p>

<p align="center">
  <a href="https://docs.relayfor.si">Docs</a> ·
  <a href="https://docs.relayfor.si/api">API reference</a> ·
  <a href="https://relayfor.si/dashboard">Dashboard</a> ·
  <a href="https://github.com/relayforsi/relayforsi-sdk/issues">Issues</a>
</p>

<br>

## Install

```bash
npm i relayfor.si
```

Node.js 22+, Bun, Deno, Cloudflare Workers and Vercel Functions. ESM, with `require()` on
Node.js 22.12+.

## Quick start

```ts
import { RelayForSI } from "relayfor.si";

const relayForSI = new RelayForSI(); // reads RELAYFOR_SECRET_KEY

// 1. Server: prepare the launch.
const launch = await relayForSI.launches.prepare(
  {
    creator: wallet, // signs last and pays
    name: "Acme",
    symbol: "ACME",
    image: await relayForSI.files.dataUri(file),
  },
  { idempotencyKey: `launch:${draftId}` },
);

// 2. Browser: the creator's wallet signs it (relayfor.si/solana).
// 3. Server: submit it and wait for the chain.
await relayForSI.launches.submit(launch.id, { transaction: signed });
const done = await relayForSI.launches.wait(launch.id); // "confirmed", "failed" or "expired"
```

## What's inside

| Import                                                                   | Use it to                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `relayfor.si`                                                            | Launch and import tokens, set fee strategies, and manage AI credit, router keys, usage, statements and webhooks. Server only. |
| `relayfor.si/solana`                                                     | Sign launch, import and purchase transactions with any Wallet Standard wallet. Browser, no dependencies.                      |
| `relayfor.si/webhooks`                                                   | Verify webhook signatures and get typed events.                                                                               |
| [`@relayforsi/ai-sdk`](https://www.npmjs.com/package/@relayforsi/ai-sdk) | The RFS Router as a Vercel AI SDK provider, for text and images.                                                              |

Resources: `project`, `launches`, `tokens`, `presets`, `accounts` (with `ledger` and
`purchases`), `keys`, `usage`, `statements`, `webhooks` (with `deliveries`), `files` and `ai`.
Fields keep the API's names; amounts and dates are strings.

`list()` returns a page, `all()` walks every page:

```ts
for await (const token of relayForSI.tokens.all()) console.log(token.mint);
```

## AI

```ts
import OpenAI from "openai";

// Any OpenAI- or Anthropic-compatible client, with a router key (rf_ai_...).
const openai = new OpenAI({ baseURL: relayForSI.ai.baseURL, apiKey: routerKey });

const { spendable_usd } = await relayForSI.ai.balance(); // reads RELAYFOR_ROUTER_KEY
const { data } = await relayForSI.ai.images.generate({
  model: "openai/gpt-image-2",
  prompt: "A red lighthouse at dusk, flat illustration",
}); // data[0].b64_json
```

`ai.models()` and `ai.imageModels()` list every model with its price. `ai.images.stream()`
yields partial images as they form.

## Wallet signing

```ts
import { pickTransactionVersion, signWithWallet } from "relayfor.si/solana";

const version = pickTransactionVersion(wallet); // pass as transaction_version
const signed = await signWithWallet(wallet, account, launch.transaction);
```

## Webhooks

```ts
import { verifyWebhook } from "relayfor.si/webhooks";

const event = await verifyWebhook({
  body: await request.text(), // the raw body
  header: request.headers.get("relayfor-signature"),
  secret: process.env.RELAYFOR_WEBHOOK_SECRET!, // or [current, previous] while rotating
});

if (event.type === "launch.confirmed") console.log(event.data.launch.mint);
```

Deliveries arrive at least once: deduplicate on `event.id` and answer 2xx within 10 seconds.

## Errors

Every error extends `RelayForSIError` and has a stable `code`:

```ts
import { isAPIError } from "relayfor.si";

try {
  await relayForSI.launches.prepare(params);
} catch (error) {
  if (isAPIError(error) && error.code === "insufficient_funds") {
    // error.status, error.param, error.requestId
  } else throw error;
}
```

`APIError` is an answer from the API, `ConnectionError` none at all, `TimeoutError` too late.
Codes autocomplete; new ones arrive in minor versions, so keep a default branch.

## Retries

Network errors, timeouts, 408, 429 and 5xx answers are retried twice with backoff, honoring
`retry-after` (a deliberate `*_closed` refusal is not).
Every POST carries an `Idempotency-Key`, so a retry never acts twice. If your own job may run
again, pass a stable key: `{ idempotencyKey: "launch:42" }`. Image generation is charged and
retried only after refusals that cost nothing.

## Configuration

```ts
new RelayForSI({
  apiKey, // RELAYFOR_SECRET_KEY (rf_sk_...)
  routerKey, // RELAYFOR_ROUTER_KEY (rf_ai_...)
  baseURL, // https://relayfor.si
  timeout, // 30000 ms per attempt
  maxRetries, // 2
});
```

Also `fetch`, `fetchOptions`, `headers`, `hooks` (`onRequest`, `onResponse`, `onRetry`) and
`appInfo`. Every method takes `signal`, `timeout`, `maxRetries`, `idempotencyKey` and `headers`
as its last argument. Keys never appear in logs, errors or hooks, and the client refuses to run
in a browser.

## Requirements

- TypeScript 5.4+ with `moduleResolution` `bundler`, `node16` or `nodenext`.
- Jest in CommonJS mode cannot load ESM packages: use Vitest or Jest's ESM mode.

## License

[MIT](https://github.com/relayforsi/relayforsi-sdk/blob/master/LICENSE)
