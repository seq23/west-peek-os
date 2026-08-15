# Artifact Manifest — West Peek OS

## Roots

- Project root (cumulative authority container): the directory containing this `west-peek-os/` folder.
- Application root: `west-peek-os/` (this directory). It must be packageable independently.

## Parent authority baseline (SHA-256, recorded at P0 bootstrap 2026-08-10)

| File | SHA-256 |
|---|---|
| `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` | `01d94450fa9689f51be445cf4ed13b4ac2284ae0cab9fbeda875ca125b211121` |
| `WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` | `a7681dc0b28ef86bae30f42d7fe6f1f61a36b405a20756ff1c4a64d9bbaa9179` |

Full baseline (all root files) is held by the Repo Operator run receipt. These two are the load-bearing
authorities and are re-hashed at every snapshot boundary; mismatch halts the run.

Re-verified byte-identical at the P12 boundary (2026-08-12), at the **P25 boundary (2026-08-13)**,
and again at the **D1–D4 design-overhaul boundary (2026-08-13)**. Both hashes above match the files
on disk exactly.

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
