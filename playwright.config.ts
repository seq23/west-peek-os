import { defineConfig } from "@playwright/test";

/**
 * E2E against a real local `wrangler dev` server (offline miniflare; no credentials).
 * The webServer command builds the client, applies migrations to the local D1
 * (idempotent), then serves worker + SPA on :8787.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Every spec drives ONE local D1 through the same `wrangler dev`. Parallel workers
  // interleave writes into that shared institutional state, so journeys must run
  // one at a time — the isolation boundary is the database, not the file.
  workers: 1,
  use: {
    baseURL: "http://localhost:8787",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command:
      "npm run build && npx wrangler d1 migrations apply WP_OS_DB --local && npx wrangler dev --port 8787",
    url: "http://localhost:8787/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
