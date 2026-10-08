# @relayforsi/ai-sdk

[relayfor.si](https://relayfor.si) provider for the [Vercel AI SDK](https://ai-sdk.dev): every
model of the RFS Router, and its image models, paid from a token's AI credit.

```sh
npm i @relayforsi/ai-sdk ai
```

## Usage

```ts
import { generateText } from "ai";
import { relayForSI } from "@relayforsi/ai-sdk"; // reads RELAYFOR_ROUTER_KEY

const { text, providerMetadata } = await generateText({
  model: relayForSI("anthropic/claude-sonnet-5.5"),
  prompt: "Write a short welcome post for our token holders.",
  maxOutputTokens: 512,
});

console.log(providerMetadata?.relayforsi?.cost); // USD charged for the call
```

Use `createRelayForSI({ apiKey, baseURL, headers, fetch })` for a provider with custom settings.

- `apiKey` is a router key (`rf_ai_...`), made on the dashboard or with `keys.create()` in the
  [`relayfor.si`](https://www.npmjs.com/package/relayfor.si) SDK. Secret keys (`rf_sk_...`) are
  rejected.
- Every model id from `GET https://relayfor.si/api/v1/models` works. Tools, structured output,
  reasoning and multi-step agents work as with any provider.
- Streams report the cost in their last chunk. An error during a stream ends it with
  `finishReason: "error"`.
- Provider options go under `relayforsi`, such as
  `providerOptions: { relayforsi: { reasoningEffort: "low" } }`.
- Set `maxOutputTokens` on long runs: each call reserves its longest answer while it runs.
- Errors are the AI SDK's own `APICallError`, with the router's `code` in `responseBody`, and
  retries are the AI SDK's `maxRetries`.

## Images

```ts
import { generateImage } from "ai";

const { image, calls } = await generateImage({
  model: relayForSI.imageModel("openai/gpt-image-2"),
  prompt: "A small red lighthouse on a rock at dusk, flat illustration",
  aspectRatio: "1:1",
  providerOptions: { relayforsi: { quality: "medium" } },
});

console.log(calls[0]?.providerMetadata?.relayforsi?.cost); // USD charged for that call
```

- Image models, the fields each takes and their prices: `GET https://relayfor.si/api/v1/images/models`.
  Fields beyond `n`, `size`, `aspectRatio` and `seed` go in `providerOptions.relayforsi`
  (`resolution`, `quality`, `output_format`, `background`, ...). A field the model does not
  list is refused before anything is charged.
- `n` is split into as many calls as the model needs: the provider reads each model's most
  images a call from that list.
- Images to edit or follow (`prompt: { text, images }`) are sent as `input_references`, on
  models with `reads_images: true`. Masks are not taken.
- Each call reserves its worst case: set `resolution` and `quality` to reserve less.

Embedding models are not served.

Requires `ai` 7 and Node.js 22 or later.

## License

MIT
