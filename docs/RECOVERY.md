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
- Remote D1 (production): **PROVEN 17 Aug 2026** — see §6.

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


## 6. Remote production restore — PROVEN

Run on 17 Aug 2026 against live production, on operator authorisation. Production was never
written to: the drill restores INTO A THROWAWAY DATABASE and compares. Restoring over production
to prove restore works would be the most expensive possible way to find a bug in the dump.

```bash
# 1 · Baseline what production holds, so there is something to verify against.
npx wrangler d1 execute WP_OS_DB --env production --remote --json --command \
  "SELECT (SELECT COUNT(*) FROM firm_user) AS firm_user, (SELECT COUNT(*) FROM action_type) AS action_type, \
          (SELECT COUNT(*) FROM event_record) AS event_record, (SELECT COUNT(*) FROM intelligence_item) AS intelligence_item"

# 2 · Export. Read-only.
npx wrangler d1 export WP_OS_DB --env production --remote --output /tmp/prod-export.sql

# 3 · Throwaway target.
npx wrangler d1 create wp-os-restore-drill

# 4 · Restore into it.
npx wrangler d1 execute wp-os-restore-drill --remote --file /tmp/prod-export.sql

# 5 · Verify (see the four checks below).

# 6 · Tear down. The dump is a full copy of production data — delete it too.
npx wrangler d1 delete wp-os-restore-drill
rm -f /tmp/prod-export.sql
```

### The four checks, and why each one is there

1. **Row counts match the baseline.** Necessary, and on its own worthless — empty rows count too.
2. **Known records carry real content.** `fu_sequoia_taylor` has the right email; Walter is present
   by name. This is what separates a restore from a schema import.
3. **Triggers and indexes came back.** 95 triggers, 387 indexes. A dump that restores rows and
   loses constraints looks perfect until the first write.
4. **Append-only triggers still REFUSE.** An `UPDATE` on `event_record` must fail with
   `event_record is append-only: UPDATE rejected (D15)`. This is the one that matters: it proves the
   restore preserved the firm's GOVERNANCE, not merely its data. A restored database that accepts a
   silent edit to the audit log is not a restored database.

### Result, 17 Aug 2026

| Check | Outcome |
|---|---|
| Export | 688 KB · 186 tables · 1,091 inserts |
| Restore | 1,527 queries · 4,330 rows written · 305 ms |
| Row counts | 7/7 tables match baseline exactly |
| Content | `sequoia@westpeek.ventures`, Walter, 4 active employees |
| Structure | 95 triggers · 387 indexes · schema at `0035` |
| Append-only enforcement | UPDATE **refused** — 0 rows tampered |
| Production after | unchanged at baseline |

### Not yet proven

- **R2 document restore.** The dump covers D1 only. Documents in `WP_OS_DOCUMENTS` are not
  included, so a full disaster recovery is not yet proven end to end.
- **Point-in-time.** `wrangler d1 time-travel` exists and is untested here.

## 7. Inbound email — what is kept, where, and for how long (0226, 22 Sep 2026)

Owner: *"the original emails received for the work card or replied should be kept … we need to
overhaul this."*

**WHAT IS KEPT.** Every message that arrives at `os@joinwestpeek.com` and passes the
`inbound_email_seen` dedupe is written to R2 **once**, at the entry (`keepTheMessage` in
`src/worker/effects/inboundEmail.ts`), before anything decides what it is. That includes unrouted
mail, a deal tag with no readable company, a `#wpnetwork` relay that failed, a reply that could not
be acted on, `#wpupdate`, a small founder deck, an oversize deck, and a steering reply — all of
which kept nothing before this.

**THE ONE EXCEPTION, deliberately.** A message whose `From:` claims one of the two Managing
Partners and which FAILED authentication is **not** kept. The mailbox is publicly addressable, so
archiving a forgery under a partner's name would give an attacker durable storage inside the firm's
bucket. Nothing is dropped by this: the message still opens a routing card carrying its words and
the verdict that refused it, and `inbound_email.not_stored_spoof` is on the event spine.

**WHERE.**

| | |
|---|---|
| Bucket | `WP_OS_DOCUMENTS` → `west-peek-os-documents` |
| Key | `inbound-email/<YYYY-MM-DD>/<uuid>.eml`, `message/rfc822` |
| Index | `inbound_message` (migration 0226) — one row per stored message, written in the same place the object is written |
| Link to the work | `inbound_message.work_card_id`, set once a door opens or steers a card |
| Read back | `GET /api/work-cards/:id/request-message` (decoded body) and `…/raw` (the `.eml`, Managing Partner only) |

**NOTHING EXPIRES.** There is no R2 lifecycle rule, no cleanup job, and nothing in the code or the
migrations deletes a stored message. That is a decision, not an omission: the owner decided on
22 Sep 2026 that **retention is decided after the index exists**, because "how long do we keep
these" cannot be answered while nobody can say what is being kept. `inbound_message` is the answer
to the second question; the first is still open.

**R2 IS OUTSIDE THE BACKUP.** `npm run backup:local` and the proven production restore above cover
**D1 only** — see *Not yet proven* — so a restored database will carry every `inbound_message` row
and its `r2_key`, and the objects those keys name are **not** restored with it. A card's
`Stored message:` line would then point at bytes that are gone. The index makes that gap visible
(`has_raw: false` on the request-message route) rather than silent, which is the improvement; it
does not close it.
