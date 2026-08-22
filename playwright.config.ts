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
    /*
     * `--local` is REQUIRED, and it is what makes the documented "offline; no credentials" promise
     * true again.
     *
     * Wrangler now treats some bindings as REMOTE by default in `wrangler dev`. `[ai]` is one of
     * them, so plain `wrangler dev` opens a remote proxy session before it will serve anything —
     * and on this account that session dies with
     *   `The domain "west-peek-os.seq-taylor.workers.dev" is behind Cloudflare Access, but no
     *    Access Service Token credentials were found`
     * The server then exits 1 and Playwright reports `Process from config.webServer was not able to
     * start`, which is not a product failure and not a spec failure: NOTHING runs. Measured
     * 2026-08-22 on wrangler 4.120.1 — the entire 27-spec suite could not boot.
     *
     * `--local` disables remote bindings, which is the profile this repo has always claimed to test
     * under (AGENTS.md: "resets the local D1, then starts its own `wrangler dev`; no credentials").
     * The consequence is honest and intended: `env.AI` cannot reach Workers AI, so any journey that
     * ends in a real model call must assert up to that boundary rather than through it.
     */
    command: `npm run build && npx wrangler d1 migrations apply WP_OS_DB --local && npx wrangler dev --local --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
