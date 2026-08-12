# src/worker

Cloudflare Worker API (P1). Entry `index.ts`; all server behavior lives here.

- `index.ts` — exported `fetch` handler + `handleRequest` (directly testable). `/api/*`
  is routed here; everything else delegates to `env.ASSETS` (SPA).
- `router.ts` — minimal hand-rolled router.
- `auth.ts` — runtime identity (ADR-006): dev header `x-wpos-dev-user` when
  `WP_OS_ENV=local`, else `Cf-Access-Authenticated-User-Email`; resolves `firm_user`
  + roles + authority scopes; fail closed.
- `env.ts` — `Env` bindings (`WP_OS_DB`, `WP_OS_DOCUMENTS`, `WP_OS_KV`, `ASSETS`,
  `WP_OS_ENV`).
- `events.ts` — `appendEvent` helper: the only write path to the append-only
  `event_record` spine (D15).
- `services/companies.ts` — P2 canonical identity (D3): company CRUD, aliases,
  resolution, identity-resolution candidates, human-reserved merge + exact reversal.
- `services/funds.ts` — P2 fund + policy substrate; policy versions are immutable
  (trigger-level) and created as new version rows only.
- `import/contracts.ts` — P2 typed import contracts (Network OS person reference,
  VentureDeals opportunity) + dry-run endpoint; persists nothing (docs/IMPORT_CONTRACTS.md).

Keep imports relative (wrangler does not resolve tsconfig paths).
