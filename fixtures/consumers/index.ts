// Type-checked by scripts/check-consumers.sh against the packed package. Never executed.
import { RelayForSI, isAPIError, type ErrorCode, type Launch } from "relayfor.si";
import { verifyWebhook, type RelayForSIEvent } from "relayfor.si/webhooks";
import { pickTransactionVersion, signWithWallet } from "relayfor.si/solana";

const relayForSI = new RelayForSI({ apiKey: "rf_sk_x" });

export async function run(): Promise<string> {
  const launch: Launch = await relayForSI.launches.prepare({
    creator: "c",
    name: "n",
    symbol: "s",
    image: "i",
    opening_buy_lamports: 1n,
    description: undefined,
  });
  for await (const token of relayForSI.tokens.all()) void token.mint;
  for await (const event of await relayForSI.ai.images.stream({ model: "m", prompt: "p" })) {
    if (event.type === "image_generation.completed") void event.media_type;
  }
  const event: RelayForSIEvent = await verifyWebhook({ body: "{}", header: "", secret: "whsec_x" });
  if (event.type === "launch.confirmed") void event.data.launch.mint;
  if (event.type === "token.graduated") void event.data.token.symbol;
  void signWithWallet;
  void pickTransactionVersion;
  try {
    await relayForSI.keys.revoke("key_1");
  } catch (error) {
    if (isAPIError(error)) {
      const code: ErrorCode = error.code;
      void code;
    }
  }
  return launch.id;
}
