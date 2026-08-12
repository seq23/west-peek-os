# Environments — West Peek OS

`WP_OS_ENV` selects the runtime identity mode: `local` | `preview` | `production`.

## local (the only environment that exists)

- Everything runs offline: `wrangler dev` + miniflare (`.wrangler/state/`), local D1,
  local R2/KV emulation. No Cloudflare credentials, no network calls to Cloudflare.
- Identity: the app honors the explicit dev header `x-wpos-dev-user: <email>` and
  resolves it against `firm_user`. Unknown email → 401. No header → 401.
  Unauthenticated requests are denied locally too — "local" is not an open mode.
- All validation (`typecheck`, `test`, `e2e`, `migrate:local`, `backup:local`,
  `restore:local`) runs here.

## preview / production (UNPROVEN — credential + approval gates)

- Neither environment has been deployed, configured, or exercised. Remote deployment
  is a named human approval gate; `wrangler.toml` ships placeholder `database_id` /
  KV `id` (ADR-007), and real identifiers are operator-supplied configuration.
- Identity in these environments is Cloudflare Access (or equivalent private ingress):
  the Access policy — MFA, device posture, allowed users — is CONFIGURATION owned by
  the operator, not application code. The worker reads the
  `Cf-Access-Authenticated-User-Email` header that Access injects after
  authentication and enforces app-level `FirmUser`/`Role`/`AuthorityScope` records on
  top. The dev header is ignored outside `WP_OS_ENV=local` (tested).
- Anything that would prove these environments (remote migration apply, remote
  backup, Access policy behavior) is UNPROVEN until separately gated and actually
  exercised. Do not describe local green checks as preview/production readiness.

## Separation rules

- No shared state between environments: separate D1 databases, R2 buckets, KV
  namespaces per environment (operator configuration at deploy time).
- Secrets live only in the encrypted vault (`~/.west-peek-os/vault/`), never in
  `wrangler.toml`, `.dev.vars`, this repo, logs, or receipts
  (`docs/ENVIRONMENT_CONTRACT.md` is names-only).
- `--remote` wrangler flags are forbidden for agents; any remote operation is an
  explicit human-gated action.
