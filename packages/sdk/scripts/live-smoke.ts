// Runs the built SDK against the live API using endpoints that cost nothing. Created keys and
// webhooks are removed afterwards; the prepared launch is never signed.
//
//   RELAYFOR_CI_SECRET_KEY   secret key of a test project (required)
//   RELAYFOR_CI_CREATOR      a funded wallet, needed for prepare's simulation
//   RELAYFOR_CI_WEBHOOK_URL  an HTTPS endpoint that returns 2xx
//   RELAYFOR_BASE_URL        defaults to https://relayfor.si
import { RelayForSI, isRelayForSIError } from "relayfor.si";

const env = (name: string): string | undefined => process.env[name] || undefined;
const relayForSI = new RelayForSI({
  apiKey: env("RELAYFOR_CI_SECRET_KEY"),
  baseURL: env("RELAYFOR_BASE_URL"),
  appInfo: { name: "relayforsi-sdk-nightly" },
});
const cleanup: (() => Promise<unknown>)[] = [];
let failures = 0;

async function step(name: string, run: () => Promise<string | undefined>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await run();
    console.info(
      `ok   ${name} (${Math.round(performance.now() - started)} ms)${detail ? `: ${detail}` : ""}`,
    );
  } catch (error) {
    failures++;
    const what = isRelayForSIError(error) ? `${error.code}: ${error.message}` : String(error);
    console.error(`FAIL ${name}: ${what}`);
  }
}

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

try {
  await step("project.get", async () => (await relayForSI.project.get()).id);
  await step("presets.list + templates", async () => {
    const [presets, templates] = await Promise.all([
      relayForSI.presets.list(),
      relayForSI.presets.templates(),
    ]);
    return `${presets.data.length} presets, ${templates.data.length} templates`;
  });
  await step("tokens.all, launches.all, webhooks.deliveries.all (first page)", async () => {
    const seen: string[] = [];
    for await (const token of relayForSI.tokens.all({ limit: 5 })) {
      seen.push(token.mint);
      break;
    }
    for await (const launch of relayForSI.launches.all({ limit: 5 })) {
      seen.push(launch.id);
      break;
    }
    for await (const delivery of relayForSI.webhooks.deliveries.all({ limit: 5 })) {
      seen.push(delivery.id);
      break;
    }
    return seen.join(", ") || "none yet";
  });
  await step("usage.get + statements.get", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const [usage, statement] = await Promise.all([
      relayForSI.usage.get(),
      relayForSI.statements.get(month),
    ]);
    return `${usage.data.length} usage rows, ${statement.accounts.length} accounts in ${month}`;
  });
  await step("ai.models + ai.imageModels", async () => {
    const [models, imageModels] = await Promise.all([
      relayForSI.ai.models(),
      relayForSI.ai.imageModels(),
    ]);
    return `${models.data.length} models, ${imageModels.data.length} image models`;
  });
  await step("tokens.get of an unknown mint answers not_found", async () => {
    try {
      await relayForSI.tokens.get("not-a-mint");
      return "unexpected success";
    } catch (error) {
      if (isRelayForSIError(error) && error.code === "not_found") return error.code;
      throw error;
    }
  });

  const accounts = await relayForSI.accounts.list({ limit: 1 });
  const account = accounts.data[0];
  if (account) {
    await step("keys: create, update, get, list, balance, revoke", async () => {
      const key = await relayForSI.keys.create({
        account: account.id,
        name: `nightly-${Date.now()}`,
        limit: { usd: "0.01", reset: "daily" },
      });
      cleanup.push(() => relayForSI.keys.revoke(key.id));
      await relayForSI.keys.update(key.id, { limit: { usd: "0.02", reset: "daily" } });
      await relayForSI.keys.get(key.id);
      await relayForSI.keys.list({ account: account.id });
      const balance = await relayForSI.ai.balance({ routerKey: key.key });
      return `${key.id}, spendable ${balance.spendable_usd} USD`;
    });
  } else {
    console.warn("skip keys: the project has no accounts");
  }

  const webhookUrl = env("RELAYFOR_CI_WEBHOOK_URL");
  if (webhookUrl) {
    await step("webhooks: create, test, rotate, deliveries, delete", async () => {
      const webhook = await relayForSI.webhooks.create({
        url: webhookUrl,
        events: ["launch.confirmed"],
      });
      cleanup.push(() => relayForSI.webhooks.delete(webhook.id));
      const delivery = await relayForSI.webhooks.test(webhook.id);
      await relayForSI.webhooks.rotate(webhook.id);
      await relayForSI.webhooks.deliveries.list({ webhook: webhook.id, limit: 5 });
      return `${webhook.id}, ping ${delivery.status}`;
    });
  } else {
    console.warn("skip webhooks: RELAYFOR_CI_WEBHOOK_URL is not set");
  }

  const creator = env("RELAYFOR_CI_CREATOR");
  if (creator) {
    await step("launches.prepare (never signed)", async () => {
      const launch = await relayForSI.launches.prepare({
        creator,
        name: "relayfor.si SDK nightly",
        symbol: "NIGHTLY",
        image: await relayForSI.files.dataUri(PNG),
      });
      return `${launch.id} ${launch.state}, v${launch.transaction?.version}`;
    });
  } else {
    console.warn("skip prepare: RELAYFOR_CI_CREATOR is not set");
  }
} finally {
  for (const undo of cleanup.toReversed()) {
    await undo().catch((error: unknown) => {
      failures++;
      console.error(`FAIL cleanup: ${String(error)}`);
    });
  }
}

console.info(failures === 0 ? "live smoke: passed" : `live smoke: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
