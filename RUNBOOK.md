# RUNBOOK — west-peek-os

The Cloudflare Worker + D1 fund OS at `os.joinwestpeek.com`. `AGENTS.md` is the repo-local authority
for anyone changing code; this file is the operator's: what a partner does by email, what the Mac
does for them, and the three doors opened on 6 Oct 2026. Deploys: a green `main` self-deploys
(`.github/workflows/deploy.yml`); never a bare `wrangler deploy`.

## The three doors (owner, 6 Oct 2026)

### 1 · Any repo she names

- **What a partner does.** Email os@joinwestpeek.com naming the GitHub repo once — `seq23/topbarz-voting`
  or `https://github.com/seq23/topbarz-voting` — with the ask. A host beside it (`https://voting.topbarz.xyz`)
  is recorded too. After that the host or the repo name is enough.
- **What happens.** The door registers the repo in `web_property_registry` (`requested_by` = the
  authenticated address) and the job proceeds — registration is a step inside the job, never a block,
  never "not a West Peek property". The eight seeded hosts (`src/shared/intake/webPropertyChange.ts`)
  cannot be re-pointed by email: a trigger on the table refuses it.
- **On the Mac.** The duty (`scripts/duties/web-property-change.mjs`) clones a missing checkout to
  `~/GitHub/<repo>` with `gh repo clone`; a repo with no `RUNBOOK.md` gets one generated from its own
  `package.json` and wrangler config (`scripts/duties/lib/runbook.mjs` — deploy route READ from the
  config, never guessed) and committed on the job's branch, so the PR carries it.
- **Data-ops.** The scripts a repo's RUNBOOK lists under `## Porter may run` may run against preview
  and production on the model's request: the model writes `status: "needs_runs"` and the SCRIPT runs
  `npm run <script> -- <args>` with the firm's credentials and records each run (script, env, exit, one
  line) in the card's proof. A `wrangler d1 execute` happens only inside such a script. Never a bare
  `wrangler deploy`; schema changes only through migrations in the deploy.
- **Files for the partner.** The job writes exports, QR codes and reports under `JOB_DIR/out/` and
  names them in `deliverables`; the DONE / preview email attaches them (≤ 10 MB in total) or links
  them (Drive viewer share to the requesting partner for anything larger or marked `private`).
- **A host outside her Cloudflare zones** (voting.topbarz.xyz on a registrar she does not hold): the
  duty attaches the custom domain to the Pages project through the API, reads back the record
  Cloudflare requires (CNAME `<label>` → `<project>.pages.dev`, plus any TXT) and the partner is emailed
  it in three parts — not a block: the site is live on pages.dev meanwhile, the Mac re-checks every
  15 minutes for 7 days and emails "live at https://<host>" when Cloudflare says active.

### 2 · A key by email, hands off

- **What a partner does.** In an authenticated email to os@, on its own line:
  `SECRET GIPHY_API_KEY=<value>`. Several lines, several keys. Nothing else is needed; the reply says
  "Stored GIPHY_API_KEY for <repo>; it is never shown again."
- **Names.** Vendor-prefixed (`VENDOR_THING`). Reserved names are refused by name and never stored:
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, anything starting
  `ANTHROPIC_`, `CLAUDE_`, `DYLD_`, `LD_`, `NODE_`, `GIT_`, `SSH_` (`src/worker/services/secretHandoff.ts`).
- **Where it goes.** Encrypted (AES-256-GCM) into `secret_handoff` under the Worker secret
  `WP_OS_SECRET_HANDOFF_KEY`; scrubbed from the stored `.eml` in R2 and from the text every door reads;
  never in `work_card`, `event_record`, `inbound_message`, a card, a log line or an email. The Mac's
  claimer (`scripts/claimer/local-job-claimer.mjs`, every heartbeat) pulls pending rows over the
  Access-authenticated channel, writes each with `vault.mjs set <NAME>` reading the value from stdin,
  and the Worker deletes the row. Unclaimed rows expire after 7 days.
- **The Worker secret.** `WP_OS_SECRET_HANDOFF_KEY` is base64 of 32 random bytes, generated on the Mac
  on 6 Oct 2026 and set from the vault: `npm run vault:set WP_OS_SECRET_HANDOFF_KEY < key.txt` then
  `npm run vault:sync:cloudflare` (it is in `scripts/vault/cloudflare-mapping.json`). Unset, the door
  fails closed: nothing is stored, the partner is told, the value is still scrubbed.
- **Use.** The vault is checked FIRST, by exact name then by vendor prefix, before any job asks a
  partner for a key (`scripts/lib/vault-env.mjs#vaultLookup`). The duty injects the repo's allowed
  names (its RUNBOOK's `## Secrets` plus vault vendor matches, recorded on the registry row) into the
  repo's runs and Pages secrets by name; the value never reaches the model. A key the vault lacks is
  never a block: everything else is built, and the next partner email says
  `Still missing: GIPHY_API_KEY — create one at <vendor page>, then email "SECRET GIPHY_API_KEY=<value>" to os@joinwestpeek.com`.
  When it arrives, every card that waited for it rebuilds by itself.

### 3 · Every wait in three parts, cleared by email

- `src/shared/work/porterWaits.ts` is the only way a partner-facing wait is written: **Waiting on**
  …, **Why** …, **To clear it by email** … The kinds: the preview before landing (reply "approved" /
  "changes: …" / "stop"), a plan approval (only when a partner turned plans-wait on), "land it" when
  land-on-green is off, which site (reply with the site or `owner/name`), the partner's own stop,
  a question that is not a job, a missing key (the SECRET line), the Mac asleep (nothing — it
  resumes), a subscription reset (nothing), one email after three failed tries (reply "try again"),
  and a DNS record at the registrar (nothing to email — add the record; re-checked for 7 days).
- Nothing else is a stop. A missing asset is a placeholder plus a "Still missing" line; a RUNBOOK
  "never" rule is obeyed and recorded as a decision; an odd ask is built as its nearest sensible
  reading. `validate:open-repo-door` fails the build on any other wait.

## Standing partner practices

`scripts/duties/web-property-change-prompt.md` § "Standing partner practices" — a forwarded voice
note is the ask; the repo's constraints register (from its README/PRD, on the registry row) is obeyed
without restating; a deadline in their words sets priority and is stated in every wait; "what's
realistic" gets an estimate first; one done-line per item; defaults said once; a partner-controlled
redirect is flipped on their say; an owner's key used in their place is said so; deferred work is its
own dated card; copy verbatim; honest limits; post-event scripts are jobs on request; a personal-data
export goes to the partner's Drive only. The full numbered list with code anchors is
`docs/PARTNER_SERVICE_RULES.md`.

## Where things run

- **Worker**: `src/worker/`; D1 `WP_OS_DB`; R2 `WP_OS_DOCUMENTS` (inbound `.eml`, job files).
- **Mac**: `scripts/claimer/local-job-claimer.mjs` (launchd, under `vault.mjs run --`) claims
  `LOCAL_JOB` runs, vaults emailed secrets, re-checks DNS waits; `scripts/duties/web-property-change.mjs`
  runs PLAN / BUILD / LAND; `scripts/drive/pull.mjs` maps a Drive package, `scripts/drive/push.mjs`
  shares a file with a partner.
- **Vault**: `~/.west-peek-os/vault/` (`npm run vault:*`); names only in this repo.

## Guards

`npm run validate:open-repo-door`, `npm run validate:partner-service-rules`, `npm run
validate:delivery-config`, `npm run validate:no-land-without-approval`, `npm run validate:duty-executor`,
and `tests/openRepoDoor.test.ts`. Each pins the doors above; `scripts/validate/README.md` says what.
