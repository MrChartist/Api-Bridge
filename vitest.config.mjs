import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.{test,spec}.mjs", "src/**/*.{test,spec}.{ts,mjs}"],
    testTimeout: 20_000,
  },
});
