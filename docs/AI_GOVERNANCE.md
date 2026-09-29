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

1. **The defer gate.** `defer_non_critical` runs only purposes flagged critical
   (`budget_context.critical`) or matching critical/risk/deadline/LP/IC/deal/compliance;
   everything else is `BLOCKED_DEFERRED`. This is "what work runs at all" and it is a
   separate question from how much money — a policy row still carrying the retired
   `cost_mode = 'CRITICAL_ONLY'` is honoured here for compatibility.
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

## The spend lever (17 Sep 2026)

One control the owner touches, three positions, named identically to Boss OS —
adopted, written fresh, never imported.

| Position | Behaviour |
|---|---|
| `FREE_ONLY` | **The $0 posture.** Nothing that costs money runs. Her subscription seats (Claude Code, then Codex) count as $0 lanes and lead; the free lanes follow for content allowed to reach them. Work Claude would have written (a pinned class, the brief) runs on the best of those and **says it is weaker than the pin**. Private work with both seats away or out of usage **stops and names the lever** — a free lane may never see it and a paid one is not allowed. |
| `MODERATE` | **The default, and what production is on.** The gradient below runs inside this position. |
| `OPEN` | **The switch for "I need good work right now."** Seats still lead, then paid Claude; the free lanes are skipped for judgement work so a mediocre free answer cannot end the walk early. Spends what is needed up to the ceiling; the gradient stops tightening. |

### The ladder for work that needs a strong model (29 Sep 2026)

The owner's order, with the seats first because she already pays for them:

```
Claude Code seat (Max plan)  →  Codex seat (ChatGPT Plus)  →  FREE lanes  →  paid Sonnet (OpenRouter)  →  Anthropic direct  →  other adequate lanes
      $0, flat fee                  $0, flat fee            public content only     per token                   per token
```

- **Which work leads on the seats.** All private judgement work (as before), plus public work a caller
  names `seatFirst`: card work with a free-to-use card, artifacts on such a card, the brief, University,
  the market map. Public work she did not name (blog help, room packets, hiring writes) stays free-first
  and does not spend her interactive capacity.
- **A seat that is out of usage is skipped until it resets.** The claimer recognises the CLI's usage-limit
  sentence (`scripts/lib/seat-usage-limit.mjs`) and reports the seat exhausted; the Worker records
  `exhausted_until` on the device row (migration 0245) and `allSeatAvailability` reads it, so nothing is
  parked and nothing waits 90 seconds on a seat that will refuse. A seat that answers clears it; the
  cooldown otherwise expires by itself (30 minutes when the notice names no time).
- **Free lanes never see private content.** Unchanged and enforced twice (step 4b and the egress gate).
  So the free rung exists only for public content; private work goes seats → paid Claude.
- **The brief may degrade, and says so.** With `requireModel` + `degradeAllowed`, a free lane may stand in
  front of Sonnet, but only a reply that passes the brief's own verifier is kept, and
  `briefServing` (shared/ai/briefServing.ts) marks a brief written by anything but Sonnet or a seat as
  "written by a weaker model" on the report and on the page. A bare `requireModel` is still that model or nothing.
- **After paid Claude comes OpenAI.** The lanes left once the head and its direct peer have failed are
  ordered Claude family, then OpenAI, then everything else (`shared/ai/vendorFamily.ts`), keeping
  health-then-price order inside each family. Judgement work only: a mechanical call's last resort is
  still the cheapest lane. Which OpenAI model that is depends on what the catalogue has ACTIVE —
  today `openai/gpt-5-mini` through OpenRouter (verified in 0188), and direct OpenAI as the peer of
  an `openai/*` head. A stronger OpenAI model joins the rung the moment it is registered ACTIVE with
  a vendor-read price (`npm run prices:refresh`) and a live probe; nothing here guesses either.
- **Repo work on cards has the same second model.** The Mac job (Porter, web property change) runs
  `claude -p` per phase. When Claude Code reports its plan is out of usage, that phase is run again
  on Codex (ChatGPT Plus seat) in the same worktree with the same prompt, and the job log says so.
  Any other Claude failure stays the phase's failure. See `scripts/lib/codex-seat.mjs`.
- **Setting the default is a human act.** Moving production to `FREE_ONLY` is `governance.policy_change`
  (an approval card); no migration does it.

### The gradient, measured against the month ELAPSED

Runs **only inside `MODERATE`**, automatically and continuously. The owner's
ladder, pro-rated: a threshold's allowance at any instant is
`threshold × monthElapsedFraction`, floored at one day's share.

| Month-to-date vs. pro-rated line | Behaviour |
|---|---|
| under the $5 line | normal |
| $5 – $10 line | cheaper choices on unpinned, unprotected work |
| over the $10 line | free-first; paid models kept for protected work |
| $50 (absolute) | **notify**, carrying the bypass decision. Nothing stops. |
| $75 (absolute) | **hard stop**, automatic, bypass available |

$8 on the 3rd is over pace and tightens; the same $8 on the 25th is on pace and
does not. A raw month-to-date total would put one heavy build day into austerity
for the rest of the month, which is why the elapsed month is the denominator. It
is also self-healing: a heavy day eases back on its own as the month catches up.

### The guarantee

**Protected work is never downgraded at any position on the gradient.** A call
marked `judgement`, `interpretation` or `requiresSearch` keeps its model or fails
loudly. One predicate — `protectedFromSpendPressure` — decides, and every branch
asks it rather than re-deriving. Proven in `tests/spendGradient.test.ts` by
driving spend past every threshold.

**Her hand always wins.** The gradient never writes `spend_lever`. `FREE_ONLY`
stays free at $0 spent; `OPEN` stays open at $40.

### The retired `cost_mode`

`NORMAL | CHEAPO | CRITICAL_ONLY | STRATEGIC_SURGE` was four values answering
three unrelated questions. The column remains (it is NOT NULL and the archive
carries it) but is now **derived from** the lever and read by nothing.
`scripts/validate/one-lever-not-four.mjs` fails the build if a routing decision
reads it again. Anything still sending a `cost_mode` to `/api/ai/budget` is
translated, not ignored: CHEAPO+pins→`MODERATE`, CHEAPO−pins→`FREE_ONLY`,
NORMAL+frontier→`OPEN`, CRITICAL_ONLY→`MODERATE` plus `defer_non_critical`,
STRATEGIC_SURGE→`OPEN` plus the offer of a bypass.

A **bypass** is a `spend_bypass` row — a higher ceiling, a reason, a named
person, an expiry — that lapses on its own. It lifts only the monthly ceiling;
the per-run and daily caps are no longer lifted by anything.

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
