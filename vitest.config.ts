import { defineConfig } from "vitest/config";

// Unit tests inject their own fetch/storage/WebSocket, so a plain node environment
// is enough — no jsdom needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
