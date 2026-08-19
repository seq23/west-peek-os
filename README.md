# West Peek OS

The operating system for West Peek Ventures — an earliest-stage venture fund run by two Managing
Partners with a workforce of AI employees.

It is one Cloudflare Worker serving a React app and an API over a D1 database. Deployed at
**os.joinwestpeek.com**, behind Cloudflare Access.

---

## Start here

```bash
npm install
npm run migrate:local          # apply migrations to the local D1 store
npm run dev                    # wrangler dev on :8787
```

Sign in with `scooter@westpeek.ventures` or `sequoia@westpeek.ventures`. In local mode a dev header
stands in for Cloudflare Access.

```bash
npm run typecheck              # tsc --noEmit
npx vitest run                 # 850+ unit tests
npm run e2e                    # 70 browser journeys — resets the local DB first
npm run validate:authority     # the four validators, below
npm run validate:ai-boundary
npm run validate:network-boundary
npm run validate:brand
```

Run all of those before you push. CI is not a substitute for the validators — they encode rules the
type system cannot.

---

## What you actually need to know

This codebase has a governance model, and most of its surprising behaviour comes from that rather
than from the framework. Six things will bite you if you do not know them.

### 1 · Unknown action keys are DENIED

Every governed action goes through `authorize(env, actor, actionKey, …)`. If the key is not in the
`action_type` table, authorize **fails closed** — the feature returns 403.

Keys live in `src/shared/registry/actionTypes.ts` (ordinary and external-effect) and
`src/shared/registry/reservedActions.ts` (human-only). After adding one:

```bash
node scripts/seed/generate-machine-seed.mjs
```

**This has bitten production.** The generator writes keys into migration `0003`, which every
existing database applied long ago — so a rewritten `0003` reaches new databases only. Three keys
added in August 2026 passed every local test and were simply absent in production. The generator now
detects that and emits a numbered backfill migration; `--check` fails if one is missing. Do not
hand-edit `0003`.

### 2 · Migrations are append-only, and applied ones never re-run

Add a new numbered file. Never edit an applied migration expecting it to take effect — it will not,
anywhere except a fresh database.

### 3 · Many tables reject UPDATE at the database layer

`event_record`, `ic_decision`, `approval_comment`, `intelligence_delivery`, `browser_task_charge`
and others carry a trigger that aborts UPDATE (D15). This is deliberate: an audit trail that can be
edited is not an audit trail. Correct a mistake by writing a compensating row.

### 4 · Egress is allowlisted by file

`scripts/validate/no-unauthorized-effects.mjs` fails the build if a worker file calls `fetch()`
without being named in `EGRESS_ALLOWED`, with a reason. Today: the RSS feed client, the Resend
transport, the Network OS client, the SEC EDGAR client, and the Google client — OAuth and calendar,
read-only scopes, reachable only for a partner who granted consent to their own account. External *effects* (anything leaving the
firm) execute only in `src/worker/effects/executor.ts`, only against an approved receipt.

Bindings are exempt because they are not `fetch` — Browser Rendering reaches the web through
`env.BROWSER`, which is why it needs no entry.

### 5 · Every AI call goes through `runAi`

`src/worker/ai/runAi.ts` is the only path to a model. It applies privacy policy, budget preflight,
provider routing and the kill switch, and writes to the `ai_run` ledger. There is no second call
path, and adding one will fail `validate:ai-boundary`.

Sensitivity is never *lowered* to reach a permitted lane. A CONFIDENTIAL meeting is refused rather
than quietly downgraded.

### 6 · Verify production after deploying

> **One deploy path.** `npm run deploy:production` — it applies migrations, refuses to continue if
> any are still pending, builds, deploys, then probes the Worker. Do not deploy with bare
> `wrangler deploy`, and do not reconnect the GitHub build trigger: Workers Builds does not run
> migrations, and shipping code against an un-migrated database has already broken production
> twice. Bare `wrangler deploy` fails differently and more quietly — it bundles the Worker from
> source but does NOT build the client, so it ships today's backend with whatever frontend was
> last built, and reports success. **[docs/DEPLOYING.md](docs/DEPLOYING.md)** has the full
> reasoning, how to verify what actually shipped, and the transient Cloudflare failures worth
> retrying rather than debugging.


`wrangler deploy` succeeding does not mean your migration applied. This has caused two incidents in
one day — code deployed against tables that did not exist yet. After any deploy touching schema:

```bash
npx wrangler d1 migrations list WP_OS_DB --env production --remote   # must say "No migrations to apply"
```

Then query for the thing you just added. Trust the query, not the deploy output.

---

## Layout

```
src/
  shared/      Pure logic, no I/O. Testable without a database or a model.
               Registries (action types, AI employees, personas), and the
               decision rules for intelligence, IC, market maps, approvals.
  worker/
    index.ts   Every route, in one router chain.
    services/  One file per concern. Business logic + its route handlers.
    effects/   Anything that reaches outside: executor, feed, email, Network OS, SEC, browser.
    ai/        runAi — the single governed model boundary.
  client/
    App.tsx    Shell, nav, and the surfaces that have not been extracted yet.
    pages/     One file per page.
migrations/    Numbered, append-only. 0003 is generated — do not hand-edit.
tests/         Vitest. `tests/helpers/db.ts` gives a real migrated D1 via miniflare.
e2e/           Playwright journeys against a real local worker.
scripts/
  validate/    The four scanners. Each has a --self-test.
  seed/        Registry → migration generators.
```

**`shared/` versus `services/` is the important split.** Anything that is a decision — how an item
is ranked, whether a charge is allowed, which risk tier an action is — belongs in `shared/` as a
pure function, so it can be tested exhaustively without infrastructure. `services/` does I/O and
calls those functions.

---

## Adding a feature

The path most changes follow:

1. **A migration** if you need tables. New numbered file.
2. **Pure rules in `src/shared/<area>/`** — the decisions, with no I/O.
3. **A service in `src/worker/services/`** — queries, plus its route handlers at the bottom.
4. **Routes in `src/worker/index.ts`** — add to the chain. Watch ordering: a literal path must be
   declared before a `:param` that would swallow it.
5. **An action key** if the feature is governed — see rule 1 above.
6. **A page in `src/client/pages/`**, wired in `App.tsx`, plus a nav entry.
7. **A purpose entry in `src/shared/help/pagePurpose.ts`** — a test fails without one.
8. **Tests.** Unit for the rules, a DB-backed test for the service, an E2E if it is a journey.

### Testing conventions worth copying

- **Inject the model and the network.** Services take an optional `synthesise` / `fetchImpl` /
  `launch` parameter defaulting to the real one. Tests pass a fake. This is how the pipeline,
  Network OS, SEC and browser clients are all tested without a paid call.
- **Test the near-miss.** A detector that flags everything is as useless as one that flags nothing.
  Every detector here has a test asserting what it must *not* fire on.
- **Negative-test your guards.** Break the thing deliberately and confirm the guard names it. Several
  guards in this repo were verified that way and one was found to be doing nothing.

---

## Reference

| Document | What it covers |
|---|---|
| [ARCHITECTURAL_DECISIONS.md](ARCHITECTURAL_DECISIONS.md) | The D-numbered decisions the code cites (D9, D15, D16…) |
| [docs/AUTHORITY_MODEL.md](docs/AUTHORITY_MODEL.md) | Who may do what, and how authorize() decides |
| [docs/AI_GOVERNANCE.md](docs/AI_GOVERNANCE.md) | Privacy modes, egress control, the model ledger |
| [docs/EVIDENCE_MODEL.md](docs/EVIDENCE_MODEL.md) | Claims, sources, and the self-promotion ban |
| [docs/IDENTITY_MODEL.md](docs/IDENTITY_MODEL.md) | Firm users, roles, AI employees |
| [docs/DEPLOYING.md](docs/DEPLOYING.md) | The one deploy path, and why bare `wrangler deploy` ships a stale interface |
| [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) | local / preview / production |
| [docs/ENVIRONMENT_CONTRACT.md](docs/ENVIRONMENT_CONTRACT.md) | Every binding and secret, and what it is for |
| [docs/RECOVERY.md](docs/RECOVERY.md) | Backup and restore, including the proven production drill |
| [WEST_PEEK_BRAND_SYSTEM.md](WEST_PEEK_BRAND_SYSTEM.md) | Tokens and the brand validator |
| [IMPLEMENTATION_LEDGER.md](IMPLEMENTATION_LEDGER.md) | What was built, phase by phase |

The canonical plan this implements lives one directory up as
`WEST_PEEK_OS_v3_2_14_CANONICAL_MASTER_PLAN.md`. Code comments cite it by section (§28.6, §12A.2),
and those citations are load-bearing — they are how a future reader finds out *why* a rule exists.

---

## Deploying

```bash
npm run deploy:production
```

Migrations, then a check that none are still pending, then build and deploy, then a health probe.
It stops at the first failure.

**Use it rather than running the commands by hand.** Deploying before migrating ships code against
tables that do not exist — that happened twice in one day, and the script exists because the fix is
not discipline.

Secrets are set with `wrangler secret put` and are **write-only** — Cloudflare cannot show you a
stored value, so a lost secret is rotated, not recovered.

### Deploying

`npm run deploy:production` is the only thing that changes production. It applies D1 migrations,
refuses to continue if any are still pending, builds, deploys, then probes the Worker.

**Cloudflare is not connected to this repository.** The GitHub build trigger was disconnected on
18 Aug 2026, deliberately: Workers Builds deploys code but does not apply migrations, so a push
carrying a migration would ship code against tables that do not exist — which broke production
twice on 17 Aug. Pushing here is saving work, never deploying.

Habit that keeps the two honest: **push, then deploy**, from the same tree. Then the commit on
`main` always matches what is live.

Finished work is admitted into Repo Operator through the DIRECT artifact lane
(`repo artifact-admit <zip> --direct --commit … --attested-by …`), which proves every file in the
artifact byte-for-byte against the commit it claims to come from.

## What is not finished

[BACKLOG.md](BACKLOG.md) is the full list — what is switched off, what has a backend but no UI, what
is thin by agreement, and the two sharp edges that have already caused production incidents.

The short version, so nobody spends a morning looking for something that is not there:

- **Outbound email is off.** The Resend transport exists and is wired to the governed effect path,
  but sending requires both `RESEND_API_KEY` and `WP_OS_EMAIL_SEND=enabled`. Approved emails are
  currently recorded, not sent. Notifications are in-app and push.
- **Functional inboxes** (canon #36) — no inbound mail routing yet.
- **R2 document restore** — the proven restore drill covers D1 only.
- **Browser tasks have no live runner.** The binding, policy and schema exist; nothing executes yet.

Each of those refuses with a stated reason rather than failing obscurely.
