# Planning documents

The canonical master plan and the Odysseus audit/implementation plan that this system was built
against, plus their completeness ledgers, manifests and structural validation summaries.

They live here so the plan is versioned with the code it describes. Until 18 Aug 2026 they sat
outside the repository, in the Repo Operator package directory
`west-peek-os-odysseus/WORK/WEST_PEEK_OS_v3_2_14_AND_ODYSSEUS_IMPL_v1_11_FULL_ARTIFACT_PACKAGE/`,
which meant the plan and the implementation could drift without anyone seeing it in a diff.

The originals remain in that package as frozen history; this is the working copy from now on.

The two `_PACKAGE.zip` archives were deliberately not copied — they contain the same documents in
compressed form, and a deployment repository should not carry redundant archives of its own files.
They are still in the package directory and in the ARTIFACTS snapshots.

## What is here

| Document | What it is |
|---|---|
| `WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md` | The master plan. The canon section numbers cited throughout the source (§12A, §15, §22A.7 …) refer to this. |
| `WEST_PEEK_OS_ODYSSEUS_AUDIT_AND_IMPLEMENTATION_PLAN_v1_11.md` | The audit and the phased implementation programme (P-numbers in source comments). |
| `*_COMPLETENESS_LEDGER.md` | What each package claimed to contain. |
| `*_STRUCTURAL_VALIDATION_SUMMARY.md` | Validation of that structure at package time. |
| `*_MANIFEST.json` | File-level manifests with hashes. |
| `WEST_PEEK_OS_v3_2_14_AND_ODYSSEUS_IMPL_v1_11_SCOPE_RECEIPT.md` | The scope receipt for the combined package. |

**Not the source of truth for the community model** — that is `docs/COMMUNITY.md`, recorded directly
from the operator and newer than these plans.
