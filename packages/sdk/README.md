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
  <b>The TypeScript SDK for relayfor.si.</b> Launch pump.fun tokens whose creator fees become AI credit, and spend it on hundreds of models.
</p>

<p align="center">
  <a href="https://docs.relayfor.si">Docs</a> ·
  <a href="https://docs.relayfor.si/api">API reference</a> ·
  <a href="https://relayfor.si/dashboard">Dashboard</a> ·
  <a href="https://github.com/relayforsi/relayforsi-sdk/issues">Issues</a>
</p>

## Install

```bash
npm i relayfor.si
```

Runs on Node.js 22+, Bun, Deno, Cloudflare Workers and Vercel Functions.

## Quick start

```ts
import { RelayForSI } from "relayfor.si";

// Reads RELAYFOR_SECRET_KEY (rf_sk_...).
const relayForSI = new RelayForSI();

// Server: prepare the launch.
const launch = await relayForSI.launches.prepare({
  creator: wallet,
  name: "Acme",
  symbol: "ACME",
  image: await relayForSI.files.dataUri(file),
});

// Browser: the creator's wallet signs launch.transaction.

// Server: submit it and wait for the chain.
await relayForSI.launches.submit(launch.id, { transaction: signed });
const { state } = await relayForSI.launches.wait(launch.id);
```

## Packages

- **`relayfor.si`**: the API client for launches, imports, fee
  strategies, AI credit, router keys, usage, statements and webhooks.
  Server only.
- **`relayfor.si/solana`**: signs launch, import and purchase
  transactions with any Wallet Standard wallet, in the browser.
- **`relayfor.si/webhooks`**: verifies webhook signatures and types the
  events.
- **[`@relayforsi/ai-sdk`](https://www.npmjs.com/package/@relayforsi/ai-sdk)**:
  the RFS Router as a Vercel AI SDK provider.

## Usage

### Lists

```ts
for await (const token of relayForSI.tokens.all()) {
  console.log(token.mint);
}
```

`list()` returns one page; `all()` walks every page.

### Wallet signing

```ts
import {
  pickTransactionVersion,
  signWithWallet,
} from "relayfor.si/solana";

// Pass it to prepare() as transaction_version.
const version = pickTransactionVersion(wallet);
const signed = await signWithWallet(
  wallet,
  account,
  launch.transaction,
);
```

### Webhooks

```ts
import { verifyWebhook } from "relayfor.si/webhooks";

const event = await verifyWebhook({
  body: await request.text(),
  header: request.headers.get("relayfor-signature"),
  secret: process.env.RELAYFOR_WEBHOOK_SECRET!,
});
```

Pass the raw body. Deliveries arrive at least once: deduplicate on
`event.id`.

### AI

```ts
// Reads RELAYFOR_ROUTER_KEY (rf_ai_...).
const { spendable_usd } = await relayForSI.ai.balance();

const { data } = await relayForSI.ai.images.generate({
  model: "openai/gpt-image-2",
  prompt: "A red lighthouse at dusk",
});
```

For chat, point the OpenAI or Anthropic SDK at `relayForSI.ai.baseURL`
with a router key, or use
[`@relayforsi/ai-sdk`](https://www.npmjs.com/package/@relayforsi/ai-sdk).

## Errors and retries

```ts
import { isAPIError } from "relayfor.si";

try {
  await relayForSI.launches.prepare(params);
} catch (error) {
  if (isAPIError(error) && error.code === "insufficient_funds") {
    // error.status, error.param, error.requestId
  }
}
```

- Every error has a stable `code`; new codes may come in minor versions.
- Network errors, timeouts, 429 and 5xx are retried twice.
- Every POST carries an idempotency key, so a retry never acts twice.
  Pass your own for jobs that may rerun:
  `{ idempotencyKey: "launch:42" }`.

## Configuration

```ts
const relayForSI = new RelayForSI({
  apiKey: "rf_sk_...",
  routerKey: "rf_ai_...",
  timeout: 30_000,
  maxRetries: 2,
});
```

Every method also takes `signal`, `timeout`, `maxRetries` and
`idempotencyKey` as its last argument.

## License

[MIT](https://github.com/relayforsi/relayforsi-sdk/blob/master/LICENSE)
