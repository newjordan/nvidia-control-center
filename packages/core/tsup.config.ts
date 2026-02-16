import { defineConfig } from "tsup"

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/event-bus.ts",
    "src/jsonrpc.ts",
  ],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  splitting: false,
})
