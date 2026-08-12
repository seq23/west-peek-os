# tests

Vitest unit/integration against a miniflare-backed in-memory D1 — no credentials, offline.

- `helpers/db.ts` — creates the D1, applies all `migrations/*.sql` in order with
  `d1_migrations` tracking (mirrors wrangler; re-apply is a no-op). Includes a
  trigger-aware SQL splitter because workerd's `exec()` splitter breaks on comments
  and BEGIN…END trigger bodies.
- `migrations.test.ts` — schema version, seeded roles/users, append-only triggers (D15),
  migration idempotency.
- `api.test.ts` — auth denial matrix (ADR-006), `/api/me` identity + roles + authority
  scopes, `/api/health` degradation, SPA delegation.
