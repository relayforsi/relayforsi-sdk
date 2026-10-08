# relayfor.si

TypeScript SDK for [relayfor.si](https://relayfor.si): launch pump.fun tokens whose creator fees
pay for their AI, bring existing tokens, manage fee strategies, AI credit, router keys and
webhooks, and call the RFS Router's balance, models and image generation.

```sh
npm i relayfor.si
```

- Runs on Node.js 22+, Bun, Deno, Cloudflare Workers and Vercel Functions.
- ESM only. CommonJS projects on Node.js 22.12+ can still `require()` it.
- One small dependency, [`@scure/base`](https://github.com/paulmillr/scure-base), used for base58.

## Usage

```ts
import { RelayForSI } from "relayfor.si";

const relayForSI = new RelayForSI(); // reads RELAYFOR_SECRET_KEY

const launch = await relayForSI.launches.prepare(
  {
    creator: creatorWallet, // signs last and pays for the launch
    name: "Acme",
    symbol: "ACME",
    image: await relayForSI.files.dataUri(imageFile),
    transaction_version: walletVersion, // from pickTransactionVersion() in the browser
  },
  { idempotencyKey: `launch:${draftId}` }, // your own stable key, see Retries
);

// Have the creator's wallet sign launch.transaction (see "Wallet signing"), then:
await relayForSI.launches.submit(launch.id, { transaction: signedTransaction });

const result = await relayForSI.launches.wait(launch.id);
console.log(result.state); // "confirmed", "failed" or "expired"
```

Request and response fields use the API's names. Amounts and timestamps are strings; amount
inputs also accept a `bigint`. Fee splits (`preset`, `split`, `creator_fees_to`) follow the
project's default fee strategy unless you pass them.

## Configuration

| Option                    | Default               | Description                                                                |
| ------------------------- | --------------------- | -------------------------------------------------------------------------- |
| `apiKey`                  | `RELAYFOR_SECRET_KEY` | Project secret key (`rf_sk_...`), or a function that returns one.          |
| `routerKey`               | `RELAYFOR_ROUTER_KEY` | Router key (`rf_ai_...`), for `ai.balance()` and `ai.images`.              |
| `baseURL`                 | `https://relayfor.si` | Must be https, except for localhost.                                       |
| `timeout`                 | `30000`               | Milliseconds per attempt.                                                  |
| `maxRetries`              | `2`                   | See [Retries](#retries).                                                   |
| `fetch`                   | global `fetch`        | Custom fetch implementation.                                               |
| `fetchOptions`            |                       | Extra fetch options, such as `cache` or an undici `dispatcher`.            |
| `headers`                 |                       | Headers sent with every request.                                           |
| `hooks`                   |                       | `onRequest`, `onResponse` and `onRetry` callbacks for logging and metrics. |
| `appInfo`                 |                       | `{ name, version, url }` of your integration.                              |
| `dangerouslyAllowBrowser` | `false`               | Allow running in a browser. See [Security](#security).                     |

Every method accepts per-request options as its last argument: `signal`, `timeout`,
`maxRetries`, `idempotencyKey`, `headers` and `fetchOptions`.

`relayForSI.withOptions(options)` returns a new client with the given options applied.

## Resources

| Resource     | Methods                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`    | `get`                                                                                                                                       |
| `launches`   | `prepare`, `submit`, `get`, `list`, `all`, `wait`                                                                                           |
| `tokens`     | `import`, `get`, `list`, `all`                                                                                                              |
| `accounts`   | `get`, `list`, `all`, `ledger.list`, `ledger.all`, `purchases.create`, `purchases.get`, `purchases.list`, `purchases.all`, `purchases.wait` |
| `keys`       | `create`, `get`, `update`, `revoke`, `list`, `all`                                                                                          |
| `presets`    | `list`, `create`, `templates`, `get`, `update`, `archive`                                                                                   |
| `usage`      | `get`                                                                                                                                       |
| `statements` | `get`                                                                                                                                       |
| `webhooks`   | `create`, `get`, `list`, `delete`, `rotate`, `test`, `deliveries.list`, `deliveries.all`, `deliveries.replay`                               |
| `files`      | `dataUri`                                                                                                                                   |
| `ai`         | `baseURL`, `anthropicBaseURL`, `balance`, `models`, `imageModels`, `images.generate`, `images.stream`                                       |

### Pagination

`list()` returns one page (`{ data, next_cursor }`). `all()` iterates over every page:

```ts
for await (const token of relayForSI.tokens.all()) {
  console.log(token.mint);
}
```

### Waiting

`launches.wait()` and `accounts.purchases.wait()` poll until the launch or purchase finishes.
Pass `timeout`, `interval` and `signal` to control polling. On timeout they throw a
`TimeoutError` with code `wait_timeout` and the last value in `error.last`. A failed launch is
returned, not thrown. For many launches at once, use the `launch.confirmed`, `token.imported`
and `launch.failed` webhooks instead.

### Limits

Each secret key may make 300 requests a minute, and each project 10 launches or imports a
minute. Past either, the API answers `429 rate_limited` with `retry-after`, which the SDK
waits out (see [Retries](#retries)).

## Errors

All errors extend `RelayForSIError` and have a `code`:

- `APIError`: the API returned an error. Includes `status`, `code`, `param` (the field at
  fault, such as `split.creator_share`) and `requestId` (quote it to support).
- `ConnectionError`: no response was received. `TimeoutError` extends it.
- Aborting with your own `signal` rethrows its reason unchanged.

```ts
import { isAPIError, isConnectionError } from "relayfor.si";

try {
  await relayForSI.launches.prepare(params);
} catch (error) {
  if (isAPIError(error)) {
    switch (error.code) {
      case "insufficient_funds":
        // ...
        break;
      default:
        throw error;
    }
  } else if (isConnectionError(error)) {
    // Retry later with error.idempotencyKey.
  } else {
    throw error;
  }
}
```

`code` autocompletes every documented code: the management API's (`ApiErrorCode`, read from the
API's own list), the router's (`RouterErrorCode`) and the SDK's (`ClientErrorCode`). New codes
may be added in minor releases, so always handle a `default` case.

## Retries

Failed requests are retried up to `maxRetries` times with exponential backoff, honoring
`retry-after`:

- Retried: network errors, timeouts, 408, 429, 500, 502, 503 and 504.
- Not retried: other 4xx responses, `*_closed` 503 responses, and `retry-after` values over 60
  seconds (the error carries `retryAfter` in milliseconds).
- `409 idempotency_in_progress` is waited on for up to 30 seconds, separately from `maxRetries`.
- Image generation (`ai.images`) is charged and has no Idempotency-Key, so it is retried only
  after refusals that prove nothing started (`rate_limited`, `model_busy`, `gateway_busy` and
  the like), never after a lost connection, a timeout or a provider failure that may be billed.

Every POST request includes an `Idempotency-Key`, reused across retries. If your code can
repeat an operation, for example from a job queue, pass your own key:

```ts
await relayForSI.launches.prepare(params, { idempotencyKey: `launch:${orderId}` });
```

Router keys and webhook secrets are shown once, and again to a retry with the same key within 24
hours. In the rare case a replay cannot return one, the SDK throws `secret_unrecoverable` with the
resource id in `error.resourceId`, so you can revoke the key or rotate the secret.

## Wallet signing

`relayfor.si/solana` signs launch, import and purchase transactions in the browser with any
Wallet Standard wallet.

```ts
import { pickTransactionVersion, signWithWallet } from "relayfor.si/solana";

// Pass this to launches.prepare() as transaction_version.
const version = pickTransactionVersion(wallet);

// Sign the transaction returned by launches.prepare(), then submit it from your server.
const signedTransaction = await signWithWallet(wallet, account, launch.transaction);
```

A v0 launch carries no opening buy and fits the creator and about 2 funded project wallets in
its route. If the wallet changes the transaction while signing, `signWithWallet` throws
`wallet_modified_transaction`.

For other wallet libraries, pass a signing function to `signTransactionWith`:

```ts
import { VersionedTransaction } from "@solana/web3.js";
import { signTransactionWith } from "relayfor.si/solana";

const signedTransaction = await signTransactionWith(launch.transaction, async (bytes) =>
  (await wallet.signTransaction(VersionedTransaction.deserialize(bytes))).serialize(),
);
```

`@solana/web3.js` 1.x does not support v1 transactions, so prepare with `transaction_version: 0`.

## Webhooks

`relayfor.si/webhooks` verifies webhook signatures.

```ts
import { verifyWebhook } from "relayfor.si/webhooks";

export async function POST(request: Request): Promise<Response> {
  const event = await verifyWebhook({
    body: await request.text(),
    header: request.headers.get("relayfor-signature"),
    secret: process.env.RELAYFOR_WEBHOOK_SECRET!, // whsec_...
  });

  switch (event.type) {
    case "launch.confirmed":
      // event.data.launch
      break;
    case "payout.credited":
      // event.data.payout
      break;
    case "route.changed":
      // event.data.token: its fees no longer follow the route, so its payouts stopped
      break;
    default:
      // An event type added after this SDK version.
      break;
  }

  return new Response(null, { status: 204 });
}
```

- Pass the raw request body, not parsed JSON.
- Invalid deliveries throw a `WebhookVerificationError`.
- Events may be delivered more than once; deduplicate on `event.id`. Answer 2xx within 10
  seconds: any other answer is retried for 24 hours. Redirects are not followed.
- Event types: `launch.confirmed`, `launch.failed`, `token.imported`, `token.graduated`,
  `payout.credited`, `account.low_balance`, `key.limit_reached`, `route.changed` and `ping`.
- During secret rotation, pass both secrets: `secret: [current, previous]`.
- `signWebhook()` creates signatures for testing your handler.

## AI

The RFS Router is compatible with the OpenAI and Anthropic SDKs. Use a router key as the API
key:

```ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: relayForSI.ai.baseURL, apiKey: routerKey });
const anthropic = new Anthropic({ baseURL: relayForSI.ai.anthropicBaseURL, apiKey: routerKey });
```

For the Vercel AI SDK, use [`@relayforsi/ai-sdk`](https://www.npmjs.com/package/@relayforsi/ai-sdk).

`ai.balance()` reads what a router key's account can spend, `ai.models()` and
`ai.imageModels()` list the models with their prices (no key needed).

### Images

```ts
const { data, usage } = await relayForSI.ai.images.generate({
  model: "openai/gpt-image-2", // from ai.imageModels()
  prompt: "A small red lighthouse on a rock at dusk, flat illustration",
  quality: "medium",
});
// data[0].b64_json, data[0].media_type; usage.cost is the USD charged

// Partial images as they form, then the finished one:
for await (const event of await relayForSI.ai.images.stream({ model, prompt })) {
  if (event.type === "image_generation.completed") save(event.b64_json);
}
```

- Fields beyond `model` and `prompt` apply to models that list them in `parameters`; others are
  refused before anything is reserved. Set `resolution` and `quality` to reserve less.
- Image calls use the router key and time out after 15 minutes by default. A stream's
  `timeout` bounds the wait for each chunk; breaking out of the loop ends the request.
- A model without `streaming: true` answers the finished image as one event.

## Security

- The client uses your secret key and refuses to run in a browser unless
  `dangerouslyAllowBrowser` is set. Use `relayfor.si/solana` for browser code.
- Keys are excluded from `console.log`, JSON output, errors and hooks.
- `baseURL` must use https (http is allowed for localhost), and redirects are not followed.

## Compatibility

- TypeScript 5.4 or later, with `moduleResolution` set to `bundler`, `node16` or `nodenext`.
- The default `baseURL` is `https://relayfor.si`; a proxy may add a path prefix.
- Jest's default CommonJS mode cannot load ESM-only packages. Use Vitest or Jest's ESM mode.
- To use a proxy in Node.js, pass an undici `ProxyAgent` as `fetchOptions.dispatcher`.

## Versioning

This package follows semantic versioning. Minor releases may add methods, enum values, event
types and error codes. `SDK_VERSION`, `SPEC_VERSION` and `SPEC_SHA256` identify the build.

## License

MIT
