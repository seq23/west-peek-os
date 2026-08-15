import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * Every suite stands up its own miniflare instance, and each one binds a local port. Past
     * ~8 suites in flight the machine runs out of ephemeral ports and workers fail with
     * EADDRNOTAVAIL — a resource limit, not a test failure. The continuation took the suite from
     * 17 files to 26, so concurrency is capped here rather than left to the default (CPU count).
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});
