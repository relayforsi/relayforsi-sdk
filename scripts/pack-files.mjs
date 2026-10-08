// Checks each package's published files against packages/*/pack-files.txt.
// Run with --update to rewrite the snapshots.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const update = process.argv.includes("--update");
let failed = false;

for (const name of ["sdk", "ai-sdk"]) {
  const dir = resolve(root, "packages", name);
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }),
  );
  const files = packed.files.map((file) => file.path).toSorted();
  const listing = `${files.join("\n")}\n`;
  const snapshot = resolve(dir, "pack-files.txt");
  if (update) {
    writeFileSync(snapshot, listing);
    console.info(`${name}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} KB packed`);
    continue;
  }
  let expected = "";
  try {
    expected = readFileSync(snapshot, "utf8");
  } catch {}
  if (expected !== listing) {
    console.error(
      `${name}: the published files changed. Expected:\n${expected}\nGot:\n${listing}\nRun \`node scripts/pack-files.mjs --update\` if intended.`,
    );
    failed = true;
  } else {
    console.info(
      `${name}: ${files.length} files as expected, ${(packed.size / 1024).toFixed(1)} KB packed`,
    );
  }
}
process.exit(failed ? 1 : 0);
