# Authority Model — West Peek OS (P3)

Governing law: **AI prepares the decision. The Managing Partners and authorized humans
make the decision.** This document describes the mechanism that enforces it.

## The choke point

`src/worker/services/authorize.ts` exports:

```ts
authorize(env, actor, actionKey, objectRef, context?) → AuthorizationDecision
```

- `actor`: `{ type: "HUMAN" | "AI" | "SYSTEM", firmUserId?, roles: string[], aiEmployeeId?, firmScopes: string[] }`.
  HTTP requests build it from the authenticated FirmUser (`actorFromIdentity`); AI/SYSTEM
  actors are constructed in code (P4+).
- `actionKey`: a key in the `action_type` table — seeded from ONE registry source
  (`src/shared/registry/reservedActions.ts` + `actionTypes.ts`, generated into migration
  0003 by `scripts/seed/generate-machine-seed.mjs`).
- `objectRef`: `{ objectType, objectId?, firmScope? }`.
- `context.receiptId`: an approval card presented as an authorization receipt.

Decision vocabulary (fail closed):

| Decision | Meaning |
|---|---|
| `ALLOW` | Ordinary internal action inside firm scope, or a reserved/external action backed by a valid approved receipt. |
| `REQUIRE_APPROVAL` | The actor may proceed only after a human with a required approver role approves an approval card. Carries `requiredApproverRoles`. |
| `DENY` | Never for this actor: unknown action key, cross-firm-scope, AI/SYSTEM on a reserved action, human missing the required role. |

### Rule order

1. **Unknown action key → DENY.** Every action the system can perform exists in
   `action_type`; anything else is refused by default.
2. **Firm isolation (§11.7).** `objectRef.firmScope` must be in `actor.firmScopes`
   (HUMAN actors derive scopes from `authority_scope` rows with `scope_key='firm_scope'`,
   defaulting to the home firm `west-peek`). Mismatch → DENY. This is a server-side
   boundary, never UI hiding.
3. **Receipt check** (reserved actions and external effects): a presented receipt is
   verified — see below. A valid receipt → ALLOW; an invalid one → REQUIRE_APPROVAL
   (or DENY if the actor could never perform the action anyway).
4. **Reserved actions** (`human_reserved_action` register): AI/SYSTEM → DENY, always.
   HUMAN without a required approver role → DENY. HUMAN with the role →
   REQUIRE_APPROVAL — the role lets you approve, not bypass.
5. **External effects** (`action_type.is_external_effect`): REQUIRE_APPROVAL for every
   actor. AI/SYSTEM can never self-approve because decisions are human-only.
6. **Ordinary internal actions** → ALLOW for actors inside firm scope.

## Receipt semantics

An authorization receipt is an `approval_card` that:

- is in state `approved` (a consumed card has moved to `executed` — replay is refused),
- matches the attempted `action_key` exactly,
- matches the object exactly (`object_type` + `object_id`),
- was decided by a human firm user whose **current** roles intersect the card's
  `required_approver_roles_json` (re-checked at verification time, so revoking a role
  invalidates outstanding receipts).

Execution paths (identity merge/reversal, the external-effect executor) verify the
receipt through `authorize()` and then **consume** it (`approved → executed`) via
`consumeApprovalCard()`. A consumed receipt can never authorize anything again.

## Approval card state machine

Enforced in `src/worker/services/approvals.ts` (`ALLOWED_TRANSITIONS`), not just here:

```
drafted → pending_review → approved | rejected | revise_requested
revise_requested → pending_review        (resubmit after revision)
approved → executed | blocked            ('sent' is a comms-facing alias of executed)
```

Every other transition is rejected with 409 `illegal_transition`. Deciding requires
state `pending_review`, a HUMAN decider, and a required approver role. Every decision
is appended to `approval_decision` — **append-only by database trigger** (UPDATE and
DELETE are rejected); history is always returned with the card.

Required approver roles are set at card creation from the reserved-action register
(MP default for non-register keys) and can never be supplied or widened by the caller.

## Reserved-action enforcement

`identity_merge.execute` (in the register) gates both merge and reversal of canonical
companies (ADR-009): merge is keyed on the source company, reversal on the merge
receipt. The P2 interim MP-role check is gone; both routes now:

1. call `authorize()` with any presented `approval_receipt_id`,
2. 403 on DENY, 409 `approval_required` on REQUIRE_APPROVAL,
3. on ALLOW, execute and consume the receipt.

## External effects

`src/worker/effects/executor.ts` is the ONLY module that executes external effects.
Creating an `external_effect_request` is an ordinary internal action; executing it
requires an approved receipt for the effect's action key (`effect.email.send`,
`effect.message.send`, `effect.webhook.post`) on that exact request. All adapters are
**local simulations** — no network egress; simulated delivery detail is recorded.
Every execution appends `effect.executed` with the receipt id to the event spine.

`npm run validate:authority` statically proves this confinement (no other worker file
marks `external_effect_request` EXECUTED; no outbound fetch anywhere in worker code
except the files named on `EGRESS_ALLOWED`, each with its reason; merge/reverse/executor
route through `authorize()`), self-tests its
own detection against synthetic violations, and verifies the generated seed SQL is
current.

## Privacy visibility

`RESTRICTED`, `LP_PRIVATE`, `MNPI_SENSITIVE`, `BANKING_RESTRICTED` captures and work
cards are visible only to Managing Partners or users holding an `authority_scope`
grant (`scope_key='privacy_label'`, matching value). Enforced in SQL queries — a row
you cannot see is indistinguishable from one that does not exist (404, absent from lists).

## Failure-closed summary

- No authentication → 401 everywhere, including unknown paths.
- Unknown action → DENY.
- Cross-firm-scope → DENY.
- AI/SYSTEM → cannot perform reserved actions, cannot decide approvals, cannot self-approve.
- Human without the required role → DENY on reserved actions, 403 on decisions.
- Missing/invalid/consumed receipt → execution refused (409).
- Silence is never approval (D7): volume is observed at
  `GET /api/diagnostics/approval-volume` and never acted on automatically.
