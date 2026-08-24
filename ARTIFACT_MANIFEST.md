# Artifact Manifest — West Peek OS

## Roots

- Application root: `west-peek-os/` (this directory), at
  `/Users/sequoiataylor/Github/west-peek-os`. It must be packageable independently.
- **Parent authority container:**
  `/Users/sequoiataylor/REPO_OPERATOR_PROJECTS/west-peek-os-odysseus/WORK/WEST_PEEK_OS_v3_2_14_AND_ODYSSEUS_IMPL_v1_11_FULL_ARTIFACT_PACKAGE/`

  **Corrected 24 Aug 2026.** This said "the directory containing this `west-peek-os/` folder", and
  the two load-bearing authorities are not there and never have been — the parent of this repo is
  `Github/`, which holds forty unrelated projects. Anybody following the manifest to re-verify would
  have found both files missing and read that as the tampering the hash check exists to catch. Both
  are byte-identical to their recorded hashes at the real path; only the pointer was wrong.

## Parent authority baseline (SHA-256, recorded at P0 bootstrap 2026-08-10)

| File | SHA-256 |
|---|---|
| `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` | `01d94450fa9689f51be445cf4ed13b4ac2284ae0cab9fbeda875ca125b211121` |
| `WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` | `a7681dc0b28ef86bae30f42d7fe6f1f61a36b405a20756ff1c4a64d9bbaa9179` |

Full baseline (all root files) is held by the Repo Operator run receipt. These two are the load-bearing
authorities and are re-hashed at every snapshot boundary; mismatch halts the run.

Re-verified byte-identical at the P12 boundary (2026-08-12), at the **P25 boundary (2026-08-13)**,
at the **D1–D4 design-overhaul boundary (2026-08-13)**, and at the **operator-review boundary
(2026-08-24)**. Both hashes above match the files on disk exactly.

## Brand authority (added at the D1–D4 design overhaul, 2026-08-13)

| File | SHA-256 | Source |
|---|---|---|
| `WEST_PEEK_BRAND_SYSTEM.md` | `6b8e3c0a33b6ff22c34a5713181f28066d0255006c9d24b4e66b33936125f589` | byte-identical to the copy carried by `seq23/westpeek-live`, `seq23/west-peek-network-os`, and `seq23/west-peek-pitch-lab` |
| `src/client/public/wp-mark.svg` | `bf90a100c0e71687426763798f0ad6912bdec579dc2ae1d51b095b8bede3d78c` | the approved West Peek mark, copied byte-identical from `seq23/westpeek-live:public/brand/wp-mark.svg` |

`src/client/public/icon.svg` carries the same bytes: the PWA icon is the approved mark, not a
fabricated substitute. The brand authority is marked CANONICAL / LOCKED and must not be edited
locally — see `AGENTS.md` and `docs/WEST_PEEK_DESIGN_SYSTEM.md` §14. `npm run validate:brand`
re-checks it, the token discipline, and the mark's presence in the shell on every run.

## Snapshot rules (approved plan §13.3)

Every snapshot must:

- include the complete project root, including the full `west-peek-os/` application;
- exclude secrets, local caches, `node_modules/`, `dist/`, `.wrangler/`, `backups/`, test artifacts;
- reopen successfully and pass archive integrity (`unzip -t` or equivalent);
- prove required files present (this manifest, `AGENTS.md`, `WEST_PEEK_BRAND_SYSTEM.md`,
  `package.json`, `migrations/`, `src/`, `docs/WEST_PEEK_DESIGN_AUDIT` + `DESIGN_SYSTEM` docs);
- record SHA-256 of the archive;
- preserve this ledger set;
- label provider/external layers PROVEN/UNPROVEN accurately (see `IMPLEMENTATION_LEDGER.md`).

## Required snapshot boundaries

P0, P1, P3, P5, P6, P9, P12 (full cumulative snapshots). Intermediate phases snapshot when
migration/security risk warrants. The Repo Operator host owns delivery.

For the D1–D5 design overhaul (2026-08-13) the run's execution contract assigns cumulative snapshot
ZIP creation and structural verification to the host **after** the implementation session, so that
session deliberately produced no delivery ZIP of its own.

## Exclusions from every artifact

- Any decrypted secret value; `~/.west-peek-os/vault/` is never copied into the project.
- `.dev.vars`, `.env` (only `.env.example`, names-only, is checked in).
- Local databases, backups, caches, build output.

## Snapshot — 22 Aug 2026, the operator-issues program

| | |
|---|---|
| Archive | `west-peek-os-odysseus_FULL_SNAPSHOT_20260822T155641Z_07ad66c9a1c6.zip` |
| SHA-256 | `ab0dd93b9651d9297f6400006b55e14d6956d5f971af11d7e385da42b35c1a2e` |
| Commit | `07ad66c9a1c6` on `main`, pushed to `seq23/west-peek-os` |
| Deployed build | `6ff58052-7e72-415e-afdc-0773dfb41500` at os.joinwestpeek.com |
| Size | 3.9 MB |

**Verified, not assumed.** `unzip -t` reports no errors; `ARTIFACT_MANIFEST.md`, `AGENTS.md` and
`package.json` are present; 443 files under `migrations/` and `src/`; and a scan for the excluded
set — `node_modules/`, `dist/`, `.wrangler/`, `backups/`, `.git/`, test artifacts, `.dev.vars`,
`.env` — returns zero matches, so no secret or build output travelled with it.

### What this snapshot contains, and what remains unproven

**Proven:** unit suite 110 files / 1,682 tests / 0 skipped; end-to-end **95 passed, 0 failed, run
twice consecutively** — the first time this suite has executed at all, since it could not previously
boot; all seven local validators pass with their self-tests; ten migrations applied to production and
the repairs read back afterwards rather than assumed.

**UNPROVEN, and stated rather than implied:**
- **Reading a deck with a real model.** Locally `run_ai` routes to `mock-local`, so which blanks a
  live model fills is not claimed. The journey is asserted through the governed boundary and stops
  there.
- **A steering note reaching an employee's prompt.** `ai_run` stores a hash of its inputs rather than
  the inputs, and the mock never emits the `ACKNOWLEDGED:` line.
- **Whisper capture**, built end to end and never once called — the control renders disabled with the
  reason on screen rather than looking live.
- **A shared live IC room** and the **Fireflies API**, both designed in ADR-019 and deliberately not
  built.
- `validate:sql` was not run: it takes 10+ minutes against production, and the recommendation to move
  it local (6.3s, 0 rejected) is recorded in `IMPLEMENTATION_LEDGER.md`, not adopted.


---

## Snapshot boundary — operator review, 24 Aug 2026

The 22-item operator list closed, Network OS connected, and the emailed-deck journey proven on real
mail. Recorded here because a snapshot that cannot be named cannot be returned to.

| What | SHA / id |
|---|---|
| Deployed Worker version | `c3926df7-875e-484e-b293-c5326caa9cbb` |
| Branch | `review/the-silent-failures` |
| Migrations | 140 in repo, 140 applied to production |

The **Worker version id** is the snapshot identity here, not a commit SHA. A manifest that pins its
own commit cannot be written: recording the SHA changes the tree and therefore the SHA. The Worker
version is stable, is what production is actually running, and is the thing you would roll back to.
The commit is the tip of the branch above.

### Authority files re-verified at this boundary

Re-hashed on disk, not copied forward from the rows above:

| File | SHA-256 | Verdict |
|---|---|---|
| `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` | `01d94450fa9689f51be445cf4ed13b4ac2284ae0cab9fbeda875ca125b211121` | matches |
| `WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` | `a7681dc0b28ef86bae30f42d7fe6f1f61a36b405a20756ff1c4a64d9bbaa9179` | matches |
| `WEST_PEEK_BRAND_SYSTEM.md` | `6b8e3c0a33b6ff22c34a5713181f28066d0255006c9d24b4e66b33936125f589` | matches |
| `src/client/public/wp-mark.svg` | `bf90a100c0e71687426763798f0ad6912bdec579dc2ae1d51b095b8bede3d78c` | matches |

### What the repo does and does not reproduce

Code and schema are **identical** to production at this commit: `wrangler d1 migrations list` reports
nothing pending, and the applied set matches the repo file-for-file.

Production also holds **operational data** that no migration reproduces, and should not — companies,
work cards, events, the 245 synced contacts. Two rows are worth naming because they were written by
hand rather than by the product: `pending_deck.pdk_recover_sensori` and `pdk_recover_vynlo`, inserted
to recover two decks already in R2 after a bug queued neither. They are deliberately NOT seeded into
a migration: both are now `READ`, and seeding them would put rows matching `inbound-email/%` into
every fresh test database — which would make the `p54` assertion that an oversized deck gets queued
pass without the product doing anything. A seed that hollows out a test is worse than a gap in a
snapshot.
