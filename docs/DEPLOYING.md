# Deploying

```bash
npm run deploy:production
```

That is the whole answer. The rest of this file explains why there is only one answer, because the
obvious alternative looks like it works and does not.

---

## Never run `wrangler deploy` on its own

`npx wrangler deploy --env production` appears to succeed. It prints the bindings, prints a version
id, and exits zero. **It ships a stale interface.**

`wrangler.toml` sets `main = "src/worker/index.ts"`, so wrangler bundles the Worker *from source* at
deploy time — worker changes really do ship. But the browser application is built separately by
Vite into `dist/client`, and wrangler simply uploads whatever is sitting there. If you have not run
`npm run build` since your last change to `src/client`, you have just deployed today's backend with
whichever frontend happened to be lying around.

Nothing warns you. The deploy output is identical.

### How this actually bit

On 19 August 2026 a complete feature — the per-partner briefing-interests editor — was written,
tested, committed and "deployed". The operator could not find it. It had never shipped: the bundle
in production was three hours old because the deploys had been done with bare `wrangler deploy`
while working around an unrelated Cloudflare outage.

The wrong conclusion was reached first (that the component was in the wrong place) and it was moved
before anyone checked what had actually been uploaded. That is the real cost of this trap: it does
not just fail, it sends you looking somewhere else.

---

## What the script does, in the only safe order

`scripts/deploy/production.mjs`, four steps, stopping at the first failure:

1. **Apply migrations** against the remote D1.
2. **Verify none are pending.** The step a human skips.
3. **Build and deploy** — `vite build`, then `wrangler deploy`.
4. **Verify the Worker answers.** A 302 is correct: that is Cloudflare Access redirecting.

Migrations run **before** the code, because the reverse ships code against tables that do not exist
yet. That ordering is not a preference — it shipped broken twice in one day before the script
existed, and both times the deploy output looked perfect while the feature 500'd.

Step 2 exists because `wrangler d1 migrations apply` succeeding does not prove the schema is
current. Deploying against a stale schema is the failure this whole script was written to prevent.

---

## Verifying what actually shipped

When in doubt — and always after any deploy that did not go through the script:

```bash
# What is the live bundle?
curl -s https://os.joinwestpeek.com/ -H "cf-access-token: $TOK" \
  | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'

# What did you just build?
ls dist/client/assets/index-*.js
```

The hashes must match. To prove a specific change is live, grep the served bundle for a string only
the new code contains:

```bash
curl -s "https://os.joinwestpeek.com/assets/index-XXXX.js" -H "cf-access-token: $TOK" \
  | grep -c "some string from your change"
```

Do not assume. A deploy that reports success has told you a version was uploaded, not that it
contains what you wrote.

---

## Cloudflare is intermittently flaky, and it is not you

Two failures recur and are transient. A straight retry has always cleared them:

- **`migration apply failed`** with no useful detail — the remote D1 call hung or was refused.
  Run `npx wrangler d1 migrations apply WP_OS_DB --env production --remote` directly to see the
  real error; it usually reports `No migrations to apply!` and the next deploy proceeds.
- **Asset upload stalls or errors mid-way.** Retry.

One caution when diagnosing: piping a validator or a deploy through `tail` replaces its exit code
with `tail`'s, so a `&&` chain sails straight past a failure. A red check was shipped this way once.
Check the output, not just the absence of a stack trace.

Reading an API response straight after deploying can also return a **cached** answer that looks like
the deploy did not take. Add a cache-buster before concluding anything:

```bash
curl -s -H "cf-access-token: $TOK" "https://os.joinwestpeek.com/api/me/connections?cb=$(date +%s)"
```

---

## Secrets and settings

**Secrets** live in Worker secret storage and never in the repo:

```bash
npm run vault:set NAME                      # into the encrypted local vault
CLOUDFLARE_ACCOUNT_ID=… npm run vault:sync:cloudflare   # vault → Worker secrets
```

The sync **fails closed**: if any name in `scripts/vault/cloudflare-mapping.json` is missing from
the vault, nothing syncs. That is deliberate — a partial sync leaves you guessing which half
arrived.

**Settings are not secrets** and belong in `wrangler.toml` under `[env.production.vars]`, where the
decision is visible in review rather than hidden in a dashboard. `WP_OS_EMAIL_FROM` and
`WP_OS_EMAIL_SEND` are there for exactly that reason.

`WP_OS_EMAIL_SEND` must be the literal string `enabled`. `true`, `yes` and `1` all leave sending
off. That is intentional: it should be impossible to switch on by accident.

---

## Before you deploy

```bash
npm run typecheck
npx vitest run --no-file-parallelism      # see docs/ENVIRONMENTS.md on why the flag
npm run validate:authority
npm run validate:ai-boundary
npm run validate:network-boundary
npm run validate:brand
```

The validators are not optional decoration. Each one refuses a specific class of change: egress
outside the allowlist, a model call outside the boundary, a foreign binding, a colour outside the
token block. If one fails, the rule is right until you have shown otherwise — widen an allowlist
only with the reason written next to the entry.

---

## Handing off a build

The delivery artifact is a full-baseline ZIP built from the committed tree:

```bash
GITHUB_ROOT="$HOME/GitHub" ~/repo-tools/active/package_repo_snapshot.sh west-peek-os
```

It refuses a dirty tree, which is correct: a snapshot named after a commit must **be** that commit.
Admission then proves every member byte-for-byte against the commit and refuses any file containing
a vault credential value — so deploy from the committed HEAD *before* packaging, or the artifact
will claim a deployment that was built from something else.
