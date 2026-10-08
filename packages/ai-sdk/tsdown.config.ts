import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: { generator: "oxc" },
  minify: false,
  sourcemap: false,
  hash: false,
  clean: true,
  treeshake: true,
});
