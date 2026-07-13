import { defineConfig } from "tsup";

// Bundle the SDK to a single ESM file + one type-declaration file. Bundling (rather
// than tsc per-file) sidesteps ESM extension-resolution headaches — consumers get a
// clean `dist/index.js` + `dist/index.d.ts` regardless of their toolchain.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
});
