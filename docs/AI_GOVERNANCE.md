# AI Governance — West Peek OS (P4)

Governing law: **AI prepares the decision. The Managing Partners and authorized humans
make the decision.** P4 introduces AI only now that authority is enforceable (P3).
This document describes the governed AI boundary and its cost/privacy machinery.

> **Live AI providers are UNPROVEN — CREDENTIAL GATE.** No live AI credentials exist
> in any environment. All provider behavior in tests is adapter + fixture based
> (injected `fetchImpl` stubs). An adapter's existence is not a verified vendor (D9).

## The boundary: `runAi`

`src/worker/ai/runAi.ts` exports:

```ts
runAi(env, { purpose, actor, inputs, sensitivity, capabilityRequirement?, budgetContext? }, deps?) → { run }
```

`runAi` is the ONLY module that may call a provider. Provider SDK imports, model API
hostnames, and bearer-token model calls may exist only in `src/worker/ai/providers/`,
proven by `scripts/validate/no-direct-provider-calls.mjs` (`npm run validate:ai-boundary`,
with a planted-violation self-test).

Every invocation — including blocked ones — lands in `ai_run` with a unique
`trace_id`, a cost estimate, a terminal status, and (when blocked) a visible
`failure_reason`. There is no silent spend and no silent discard.

### Pipeline (fail closed at every step)

1. **Cost-mode gate.** `CRITICAL_ONLY` runs only purposes flagged critical
   (`budget_context.critical`) or matching critical/risk/deadline/LP/IC/deal/compliance;
   everything else is `BLOCKED_DEFERRED`.
2. **Credential scrub** (`src/worker/ai/scrub.ts`). Inputs are scanned for
   secret-shaped patterns — vendor API keys, vault key names (`ANTHROPIC_API_KEY`),
   bearer tokens, secret assignments, wire-instruction text. Any match blocks the run
   (`EGRESS_BLOCKED`) before any provider call, on every path including local. The
   block reason names the pattern class only — never the matched text.
3. **Privacy-mode resolution (D8).** Firmwide mode from the latest `budget_policy`
   row: `LOCKDOWN` → no external provider, ever; `LOCAL` → local adapter only;
   `FRONTIER` → external allowed only for labels the provider data policy allows.
4. **Egress check (D9 default-deny).** `provider_data_policy` must explicitly allow
   the sensitivity label for the provider; absence of an allowing row is a denial.
   `CONFIDENTIAL`, `RESTRICTED`, `LP_PRIVATE`, `MNPI_SENSITIVE`, and
   `BANKING_RESTRICTED` are denied for every seeded external provider and can never
   leave — in any mode.
5. **Provider availability.** Globally disabled → `PROVIDER_DISABLED`; kill-switched
   → `KILL_SWITCHED`. No call is made.
6. **Cost preflight.** Estimate from the latest `provider_pricing_snapshot`
   (ILLUSTRATIVE placeholder pricing — real pricing is operator-maintained config)
   and expected tokens; per-run and daily caps from `budget_policy` are hard stops
   (`BUDGET_BLOCKED`, zero provider calls).
7. **Adapter call.** `mockLocal` (deterministic, offline, zero-cost — the manual
   fallback that always works) or `httpExternal` (generic HTTPS adapter; in tests
   always pointed at an injected stub, never a real vendor).
8. **Output quarantine.** External-provider outputs land in `ai_run.output_text`
   with `output_quarantine = 1`. The only promotion path is a HUMAN accept step
   (`POST /api/ai/runs/:id/accept-output`). Quarantined text never auto-enters any
   other table (tested: absent from the event spine, approval cards, captures, work
   cards).
9. **Manual fallback (reduced mode §3.5).** A provider failure marks the run
   `BLOCKED_DEFERRED` with the reason visible; the deterministic app (work cards,
   approvals, activity) is unaffected.

## Cost modes

| Mode | Behavior |
|---|---|
| `NORMAL` | Default. Honors an optional model preference; else cheapest adequate model. Caps enforced. |
| `CHEAPO` | Cheapest adequate model from the pricing snapshot, regardless of preference. Caps enforced. |
| `CRITICAL_ONLY` | Only critical purposes run; everything else `BLOCKED_DEFERRED`. |
| `STRATEGIC_SURGE` | Caps lift to the surge budget only inside an unexpired surge record carrying purpose + owner + budget + end. An expired or incomplete surge is treated as `NORMAL` (fail closed); expiry is enforced by timestamp comparison. |

## Privacy modes (D8)

`LOCAL` | `FRONTIER` | `LOCKDOWN`. The seeded firmwide default is `LOCKDOWN` —
fail closed; no external egress until an MP deliberately changes policy.
Changing the firmwide cost/privacy policy is the reserved action
`governance.policy_change`: an approval card must be approved and presented as a
receipt; the change is a NEW `budget_policy` row (versioned, immutable by trigger).

## Provider registry posture (D9)

Providers are configuration, not architecture. `provider_registry` seeds DISABLED
placeholder entries (openai, anthropic, google, perplexity, openrouter) with
capabilities/cost metadata and base URLs as operator config. Kill switch and enable
are MP-governance actions through `authorize()` + approval receipt
(`POST /api/ai/providers/:key/kill-switch` / `.../enable`); both append audit events
(`provider.kill_switched` / `provider.enabled`). `provider_pricing_snapshot` rows are
clearly-labeled ILLUSTRATIVE placeholders; operators capture real dated snapshots.

## AI employees (D10)

The roster is seeded reference data: 31 rows from the ONE registry source
(`src/shared/registry/aiEmployees.ts` → generated seed in migration 0004), all
`INACTIVE`. Activation is human-reserved (`ai_employee.activate`):

1. `POST /api/ai/employees/:id/request-activation` creates the approval card.
2. A human with the MP role approves it.
3. `POST /api/ai/employees/:id/activate` with the receipt applies the activation,
   writes `ai_employee_status_history` (append-only by trigger), and consumes the
   receipt.

Constraints: ≤5 `ACTIVE` at any time — a 6th activation is refused with 409 even
with a valid approval (receipt not consumed). A Managing Partner name can never be
an AI employee (generator guard + service-level refusal). There is no direct
status-update route — no silent activation path exists. An employee can never expand
its own tool scope: `grantToolScope` is HUMAN-only at the service level.

## Reduced mode

When providers are disabled, kill-switched, failing, or the firm is in
LOCKDOWN/LOCAL, AI convenience degrades — the deterministic system of record
(captures, work cards, approvals, activity) is fully served. `mockLocal` keeps
local AI-assisted drafting available offline; external runs report their block
reason visibly in the run ledger.

## Eval + value ledgers

`eval_record` (per-employee eval scores, optionally linked to a run) and
`value_outcome` (per-run outcome notes) exist for later phases; nothing auto-writes
them in P4.
