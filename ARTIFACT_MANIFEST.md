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

Re-verified byte-identical at the P12 boundary (2026-08-12), the final boundary of the authorized
P0–P12 scope.

## Snapshot rules (approved plan §13.3)

Every snapshot must:

- include the complete project root, including the full `west-peek-os/` application;
- exclude secrets, local caches, `node_modules/`, `dist/`, `.wrangler/`, `backups/`, test artifacts;
- reopen successfully and pass archive integrity (`unzip -t` or equivalent);
- prove required files present (this manifest, `AGENTS.md`, `package.json`, `migrations/`, `src/`);
- record SHA-256 of the archive;
- preserve this ledger set;
- label provider/external layers PROVEN/UNPROVEN accurately (see `IMPLEMENTATION_LEDGER.md`).

## Required snapshot boundaries

P0, P1, P3, P5, P6, P9, P12 (full cumulative snapshots). Intermediate phases snapshot when
migration/security risk warrants. The Repo Operator host owns delivery; the implementation run
produces one final full-snapshot ZIP at the end of the authorized scope.

## Exclusions from every artifact

- Any decrypted secret value; `~/.west-peek-os/vault/` is never copied into the project.
- `.dev.vars`, `.env` (only `.env.example`, names-only, is checked in).
- Local databases, backups, caches, build output.
