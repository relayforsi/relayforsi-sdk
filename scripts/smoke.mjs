// Smoke test for the packed package on Node, Bun or Deno. Run from a folder where the tarball
// is installed.
import { RelayForSI, isAPIError } from "relayfor.si";
import { signWebhook, verifyWebhook } from "relayfor.si/webhooks";
import { transactionVersionOf } from "relayfor.si/solana";

const relayForSI = new RelayForSI({
  apiKey: `rf_sk_${"a".repeat(40)}`,
  maxRetries: 0,
  fetch: async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "No such launch.", request_id: "req_1" },
      }),
      {
        status: 404,
        headers: { "content-type": "application/json", "request-id": "req_1" },
      },
    ),
});

let code;
try {
  await relayForSI.launches.get("lch_1");
} catch (error) {
  code = isAPIError(error) ? error.code : String(error);
}
const secret = `whsec_${"k".repeat(43)}`;
const body = '{"type":"ping"}';
const event = await verifyWebhook({ body, header: await signWebhook({ secret, body }), secret });
const version = transactionVersionOf(
  btoa(String.fromCharCode(0x81, 1, ...Array.from({ length: 80 }, () => 0))),
);

const result = { code, event: event.type, version };
const expected = { code: "not_found", event: "ping", version: 1 };
if (JSON.stringify(result) !== JSON.stringify(expected)) {
  throw new Error(`smoke failed: ${JSON.stringify(result)}`);
}
const runtime = globalThis.Bun
  ? `bun ${globalThis.Bun.version}`
  : globalThis.Deno
    ? `deno ${globalThis.Deno.version.deno}`
    : `node ${process.version}`;
console.log(`smoke ok on ${runtime}`);
