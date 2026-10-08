// Fails when this repository, or a package it publishes, names the people or projects behind it.
// The names are kept as SHA-256 hashes so that this file, which is public, spells none of them,
// and a hit prints its file and line but never the word. A word matches as a whole token or as
// the start of one (`name0` matches `name`), ignoring case.
//
//   node scripts/public-names.mjs   checks every tracked file and each package's packed files
//
// tools/codegen/generate.ts uses `leaks()` to keep such words out of generated types.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HASHES = new Set([
  "e7a893bbf7072a37659dcf437f726b63e2127147f0a6b4cd7f79f4ba2db73de8",
  "299f88d1042c3468de7df9c8952688c7ff1702cb6f793db783f4d5fe762d0fa3",
  "19e05df6b2e5fb94f3ee7eed2c02d340a1128a00231f5f6949641a143ab3b57a",
  "8cfde6efdfc4ed5ab1f6acbbd1ba49bf31932f84d0a4c090eb41c7d151e8b180",
  "96a4bc2602655473120fcc571ee3d8cfe5f8801f8038ccc06323d305e323331c",
  "7f871cbf905f6e0cd598b11609f33f609e60a61892ac6b37e80cf1de282ee367",
  "6ce82deaeb0d03bec48b06b0d5fa3667654ed111effccb9114e9f71b175c3cc0",
  "1746a682cdda5930db9bb41097be1295007ec8b96a5d60b9c67da54e9bad0081",
  "e265c3133d317bbf2969b1782bca6899409d4266d13b6cc4f2e38cbabbd32693",
  "38e395adcd63aba86300ba2daa0c85f9ef4eac631a9d727850b362c39da28796",
  "7b7a41d46463c926d10716ceb8eabdd7d479519434133fcced13dd44bdf13ed7",
]);
// The lengths of the hashed names, for matching the start of a token.
const LENGTHS = [4, 5, 6, 7, 8, 9, 10];
// A home folder on a developer's machine.
const HOME = /\/(?:Users|home)\/[^/"'`\s]+\//;

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Whether `text` names a hashed name, or a home folder. */
export function leaks(text) {
  if (HOME.test(text)) return true;
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token === "") continue;
    for (const length of LENGTHS) {
      if (token.length >= length && HASHES.has(hash(token.slice(0, length)))) return true;
    }
  }
  return false;
}

/** The lines of `text` that leak, numbered from 1. */
function leakingLines(text) {
  return text.split("\n").flatMap((line, index) => (leaks(line) ? [index + 1] : []));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const run = (args, cwd = root) => execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  const files = new Set(
    run(["git", "ls-files", "-z"])
      .split("\0")
      .filter((file) => file !== "" && file !== "pnpm-lock.yaml")
      .map((file) => resolve(root, file)),
  );
  for (const name of ["sdk", "ai-sdk"]) {
    const dir = resolve(root, "packages", name);
    const [packed] = JSON.parse(run(["npm", "pack", "--dry-run", "--json"], dir));
    for (const file of packed.files) files.add(resolve(dir, file.path));
  }
  let hits = 0;
  for (const file of [...files].toSorted()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of leakingLines(text)) {
      hits++;
      console.error(
        `${file.slice(root.length + 1)}:${line}: a name this repository must not publish`,
      );
    }
  }
  if (hits > 0) {
    console.error(`public-names: ${hits} line(s) to change before anything is published.`);
    process.exit(1);
  }
  console.info(`public-names: ${files.size} files, none names the team behind them.`);
}
