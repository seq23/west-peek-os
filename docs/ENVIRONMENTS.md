# Environments — West Peek OS

`WP_OS_ENV` selects the runtime identity mode: `local` | `preview` | `production`.

## local (the only environment this repository exercises)

- Everything runs offline: `wrangler dev` + miniflare (`.wrangler/state/`), local D1,
  local R2/KV emulation. No Cloudflare credentials, no network calls to Cloudflare.
- Identity: the app honors the explicit dev header `x-wpos-dev-user: <email>` and
  resolves it against `firm_user`. Unknown email → 401. No header → 401.
  Unauthenticated requests are denied locally too — "local" is not an open mode.
- All validation (`typecheck`, `test`, `e2e`, `migrate:local`, `backup:local`,
  `restore:local`) runs here.

## preview / production (nothing here is proven by this repo's validation)

- **Nothing in this repo exercises either environment.** Every remote fact below is
  operator configuration or an externally recorded result. No local check produced,
  reproduced, or re-verified any of it, and local green checks are never
  preview/production readiness.
- **Production ingress is configured — recorded externally, not proven here.**
  Cloudflare Access is configured and independently proven active for the production
  hostname `west-peek-os.seq-taylor.workers.dev`; that is the operator's record, carried
  in the approved admission task, established outside this repository. A prior production
  deploy of the `west-peek-os` Worker with its D1/KV/R2 bindings, and one bound production
  Worker secret (`OPENROUTER_API_KEY`), are likewise recorded as externally verified in
  `docs/PROVIDER_READINESS_AUDIT.md` §1/§4. Do not read those records as anything this
  repository can demonstrate.
- Deploying *from here* remains a named human approval gate. No Repo Operator run of the
  production-artifact admission task deployed, applied a remote migration, created a
  Cloudflare resource, or configured or mutated Cloudflare Access. The remote changes
  recorded above — the earlier deploy, the Access policy, the bound Worker secret — were
  operator actions taken outside those runs and were never reproduced or checked by one.
- `wrangler.toml` now declares an explicit `[env.production]` profile
  (`wrangler deploy --env production`) that sets `WP_OS_ENV = "production"` and restates
  every binding, because named environments do not inherit bindings or vars. The
  top-level profile remains the LOCAL one and keeps its ADR-007 placeholder
  `database_id` / KV `id`; the real, non-secret identifiers appear only under
  `[env.production]`.
- **Declaring that profile is not deploying it.** The run that declared it performed no
  deploy, no Cloudflare Access change, and no remote migration apply. What it buys is a
  deployment target that carries `WP_OS_ENV = "production"` and the real bindings, so a
  correct deploy can no longer ship the local profile by omission of configuration.
- **It does NOT make a wrong deploy impossible. Deployment must name the environment:
  `wrangler deploy --env production`.** A bare `wrangler deploy` still selects the
  top-level LOCAL profile and would publish `WP_OS_ENV = "local"` to the `west-peek-os`
  Worker — which §3 of the admission task forbids. Wrangler warns when a config defines
  environments and none is specified, but it does not refuse; the warning is the only
  guard, so the `--env production` flag is a required part of the deploy procedure, not a
  convenience. Verified by dry-run: with no `--env`, wrangler resolves
  `env.WP_OS_ENV ("local")` and the placeholder KV id; with `--env production`, it
  resolves `env.WP_OS_ENV ("production")` and the real D1/KV/R2 ids.
- `preview` has no profile of its own and has never been deployed, configured, or
  exercised at all.
- Identity in these environments is Cloudflare Access (or equivalent private ingress):
  the Access policy — MFA, device posture, allowed users — is CONFIGURATION owned by
  the operator, not application code. The worker reads the
  `Cf-Access-Authenticated-User-Email` header that Access injects after
  authentication and enforces app-level `FirmUser`/`Role`/`AuthorityScope` records on
  top. The dev header is ignored outside `WP_OS_ENV=local` (tested).
- Remote migration apply and remote backup are UNPROVEN until separately gated and
  actually exercised. Access's live behaviour on the production hostname is externally
  recorded (above), never proven by anything in this repo. Do not describe local green
  checks as preview/production readiness.

## Separation rules

- No shared state between environments: separate D1 databases, R2 buckets, KV
  namespaces per environment (operator configuration at deploy time).
- Secrets live only in the encrypted vault (`~/.west-peek-os/vault/`), never in
  `wrangler.toml`, `.dev.vars`, this repo, logs, or receipts
  (`docs/ENVIRONMENT_CONTRACT.md` is names-only).
- `--remote` wrangler flags are forbidden for agents; any remote operation is an
  explicit human-gated action.

## Running the test suite

Use `npx vitest run --no-file-parallelism`.

The suite is resource-hungry — each file spins up a Miniflare worker with a real D1 — and under
parallel execution or alongside other heavy processes it fails in ways that look like real bugs
and are not:

- a file reported as FAILED with all of its tests **skipped** (the file was aborted mid-run);
- `Test timed out in 60000ms` on a test that takes under a second on its own;
- `undici ... other side closed` from the worker's socket.

**Before believing any full-suite failure, re-run the named file on its own.** Every one of these
has so far passed in isolation. What makes this expensive is that the failure moves between files
from run to run, so it reads as a regression in whatever you touched last.

Do not run anything else heavy against the repo while the suite runs — including a shell loop
polling for its output, which is enough on its own to push files past the 60-second timeout.
