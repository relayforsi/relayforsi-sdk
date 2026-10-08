import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    webhooks: "src/webhooks/index.ts",
    solana: "src/solana/index.ts",
  },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { generator: "oxc" },
  // Left unminified for readable stack traces; consumers minify.
  minify: false,
  sourcemap: false,
  // Stable chunk names for the published-files snapshot.
  hash: false,
  clean: true,
  treeshake: true,
});
