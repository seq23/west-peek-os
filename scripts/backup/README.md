# scripts/backup

Local D1 backup/restore (P1). Mechanism: shells out to `wrangler d1 execute WP_OS_DB --local`
— the same miniflare store `wrangler dev` uses. Fully offline; `--remote` is never used.

- `npm run backup:local` — export all D1 user tables to `backups/wpos-backup-<utc>.json` (gitignored).
- `npm run restore:local` — restore latest backup into an EMPTY local D1 (`--force` to wipe first).
- `node scripts/backup/prove-restore.mjs` — scripted seed → backup → wipe → restore → read-back proof.

See `docs/RECOVERY.md`.
