# Recovery — West Peek OS

Scope: recovery paths that EXIST as of P1. Approved plan §16.7 scenarios that require
later-phase machinery (event-sourced rebuild, R2 document restore, remote/preview
recovery) are listed at the end as later-phase, not claimed here.

Everything below runs locally and offline (miniflare store at `.wrangler/state/v3/d1`).
No Cloudflare credentials are involved; `--remote` is never used.

## 1. Unavailable D1 binding (or unreachable D1)

Symptoms: `GET /api/health` reports `d1.reachable: false` (with error), or wrangler
commands fail against the local store.

- `/api/health` is designed to degrade cleanly: binding absence or query failure is
  REPORTED (`ok: false`, per-binding presence flags), never fatal to the worker.
- Local: the store lives at `.wrangler/state/v3/d1/`. If it is missing or was deleted,
  rebuild from scratch:
  1. `npm run migrate:local` — re-applies `migrations/*.sql` in order (schema + seeds).
  2. `node scripts/backup/restore.mjs --file backups/<latest>.json` — restores data
     from the most recent backup, if one exists.
- Remote D1 (preview/production): UNPROVEN — CREDENTIAL/APPROVAL GATE. Remote recovery
  runbook is a deployment-phase deliverable, not written yet.

## 2. Corrupted local migration / broken local store

Symptoms: migration apply fails midway, or the local SQLite file is inconsistent.

The local store is disposable. Nuclear option, always safe locally:

1. Stop `wrangler dev`.
2. Delete `.wrangler/state/v3/d1/` (local dev data only — never do anything equivalent
   against a remote store).
3. `npm run migrate:local` to rebuild schema + seeds.
4. Restore data from backup if needed (see §1 step 2).

Guarantees that make this safe:

- Migrations are additive-first and defensively written (`IF NOT EXISTS`,
  `INSERT OR IGNORE`); wrangler additionally tracks applied filenames in
  `d1_migrations`, so re-running `migrate:local` is a no-op (idempotent — verified).
- `event_record` is append-only by database trigger: UPDATE/DELETE are rejected
  (D15) — as are the policy-version, approval, evidence, access-ledger, comparison-run,
  and reconciliation tables added through P12. Those triggers protect the APPLICATION
  from rewriting history; they also block the DELETEs a faithful reload needs, so
  `restore.mjs` takes them down for the load and puts them back (ADR-015).

## 3. Lost preview environment

Preview does not exist yet (no remote deployment has been approved or attempted —
see `docs/ENVIRONMENTS.md`). There is nothing to lose: preview would be rebuilt from
this repo (worker code + migrations + asset build) plus operator-supplied Cloudflare
configuration. Institutional truth in preview would come from a restore of a backup
export, using the same `restore.mjs` mechanism against the preview D1 — that path is
UNPROVEN until remote credentials exist.

## 4. Backup / restore (the proof path that exists)

- `npm run backup:local` — exports every D1 user table to
  `backups/wpos-backup-<utc>.json` (gitignored, never packaged). Mechanism: shells out
  to `wrangler d1 execute WP_OS_DB --local --json`, i.e. the exact same miniflare store
  `wrangler dev` serves.
- `npm run restore:local` — restores the latest backup into an EMPTY local D1
  (refuses non-empty; `--force` drops all tables first). Rebuilds schema via
  `wrangler d1 migrations apply --local` so `d1_migrations` stays truthful, then
  drops the append-only triggers, replaces seed content with backup rows,
  **re-creates every trigger from its own recorded SQL, and verifies the full set is
  back** (ADR-015) before checking row counts. A restore that lost the append-only
  guarantees would be worse than a failed restore, so that check is a hard failure.
- `node scripts/backup/prove-restore.mjs` — scripted proof: insert proof event →
  backup → wipe → restore → read back. Last run: PASSED against the full 0001–0012
  schema, 2026-08-12 (see IMPLEMENTATION_LEDGER).

## Later-phase recovery (approved plan §16.7 — NOT yet available)

- Point-in-time rebuild from the event spine (needs P3 event emission).
- R2 document/artifact restore and provenance re-linking (needs document pipelines).
- Remote/preview/production backup scheduling and offsite copies (deployment gate).
- Cross-environment restore drills (requires a second environment to exist).
