# e2e

Playwright browser tests against local `wrangler dev` (`npm run e2e`). The webServer
command builds the client, applies local migrations (idempotent), and serves on :8787.

P1 (`p1-shell.spec.ts`): unauthenticated `/api/me` → 401; dev-identity header → 200
(Scooter Taylor); `/api/health` open; UI shell renders nav placeholders + health panel.
