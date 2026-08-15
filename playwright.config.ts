import { defineConfig } from "@playwright/test";

/**
 * E2E against a real local `wrangler dev` server (offline miniflare; no credentials).
 * The webServer command builds the client, applies migrations to the local D1
 * (idempotent), then serves worker + SPA on the e2e port.
 *
 * `npm run e2e` runs `scripts/e2e/prepare-local.mjs` first, which stops any stale listener on that
 * port and deletes the local D1 — so every run starts from an empty firm, which is what the
 * journeys assume. `reuseExistingServer` is therefore FALSE: reusing a server we did not start
 * would either hold open the database we just reset or serve a build older than the one under test.
 */
const PORT = Number(process.env.WPOS_E2E_PORT ?? 8787);
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Every spec drives ONE local D1 through the same `wrangler dev`. Parallel workers
  // interleave writes into that shared institutional state, so journeys must run
  // one at a time — the isolation boundary is the database, not the file.
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `npm run build && npx wrangler d1 migrations apply WP_OS_DB --local && npx wrangler dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
