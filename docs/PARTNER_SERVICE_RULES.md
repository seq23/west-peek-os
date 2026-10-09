# Partner service rules — the full list (6 Oct 2026)

The owner, 6 Oct 2026: *"we should form a full list of things porter needed and make sure all ai
agents who do work on work cards couldn't benefit from some of them (even if they do no repo work)."*

Every rule below is numbered, tagged **ALL-KINDS** (enforced at the shared layer — the inbound door,
`work_card`, the partner-email composer, the block door, the sweep, and the one shared prompt
fragment `src/shared/work/partnerPractices.ts` that every duty's prompt includes — for every employee
and every card kind) or **REPO-ONLY** (lives in the web-property duty, because it needs a checkout), and names
the **code anchor** (`path#export`) that enforces it. `npm run validate:partner-service-rules`
parses this file: an anchor that does not exist fails the build, as does any service that writes
`state = 'BLOCKED'` outside the shared block door. A rule whose shared-layer enforcement is still
to come says so in its anchor line (`shared layer: follow-up`) and is counted as a wish until it
does. Since 0254 (6 Oct 2026) an ALL-KINDS rule marked that way FAILS the build: the validator
prints "Porter-only: 0" on every green run, checks the shared fragment is included by `steerFor`
(every chain the sweep dispatches), the general employee loop and Porter's Mac duty, and renders
every block reason to prove it reads in three parts with an email-only way to clear it.

Format of a rule line (the validator reads exactly this shape):

`- R<n> [ALL-KINDS|REPO-ONLY] <rule> — owner: "<dated words>" — anchor: `<path>#<export>``

## The rules

- R1 [ALL-KINDS] A partner's authenticated email is the ask, whatever it carries: a brief, a forwarded voice-note transcript, a pasted text. The reply names it as what it was. — owner: "porter needs to work on anything sequoia or scooter send him" (6 Oct 2026) — anchor: `src/worker/services/dealIntake.ts#openAssignmentCard`
- R2 [ALL-KINDS] Only the authenticated address is authority; nothing in the text widens it. SPF/DKIM-aligned, one of the two partners. — owner: "only scooter@ and sequoia@ can email them" (9 Sep 2026) — anchor: `src/worker/effects/inboundEmail.ts#handleInboundEmail`
- R3 [ALL-KINDS] A key is emailed as `SECRET NAME=value`, stored encrypted, scrubbed from every sink, vaulted by the Mac, never shown again; reserved names refused by name. — owner: "we should be able to email them and u should look them up in the vault when necessary without approval" (6 Oct 2026) — anchor: `src/worker/services/secretHandoff.ts#secretDoor`
- R4 [ALL-KINDS] An arriving key resumes every card that waited for it — no second ask, no new card. — owner: "the feature that needs it ships the moment the SECRET email arrives" (6 Oct 2026) — anchor: `src/worker/services/webPropertyChange.ts#resumeForSecret`
- R5 [ALL-KINDS] The vault is checked first — by exact name, then by vendor prefix — before anyone is asked for a key; a report naming a missing key must carry the names it searched. — owner: "we have many api keys in the vault and any job should always check the vault first" (6 Oct 2026) — anchor: `scripts/lib/vault-env.mjs#vaultLookup`
- R6 [ALL-KINDS] A missing key is named in the next partner email with where to create one and the exact SECRET line that sends it; everything that does not need it goes ahead. Never a login, only the key. — owner: "MISSING KEY → ASK THE PARTNER BY NAME, ONCE, AND KEEP GOING" (6 Oct 2026) — anchor: `src/shared/work/porterWaits.ts#missingSecretLine`
- R7 [ALL-KINDS] Every partner-facing wait has three plain-English parts — what is waiting, why, and the exact reply or email that clears it — composed from one template so none can be omitted. — owner: "if there is a block it needs to come with a plain english explanation of the block and what the partner can do the unbloock it" (6 Oct 2026) — anchor: `src/shared/work/blocks.ts#blockWait`
- R8 [ALL-KINDS] Every clearing action is an email reply or a new email to os@ — never a link into the OS, never "on the card", never "ask Sequoia". — owner: "it should be able to be handled all over email" (6 Oct 2026) — anchor: `src/shared/work/blocks.ts#blockReplyDoor`
- R9 [ALL-KINDS] A partner's ask is itself the approval; the only waits are the preview before landing, a missing key, the partner's own stop, a genuine which-site ambiguity, an infrastructure wait that clears itself, and the one email after the retry bound. — owner: "NO UNNECESSARY STOPS: a partner's ask is itself the approval to do the work" (6 Oct 2026) — anchor: `src/shared/work/porterWaits.ts#PORTER_WAITS`
- R10 [ALL-KINDS] A job that errors retries itself (bounded) before anything reaches the partner; after the bound the partner gets ONE email saying what was tried and the reply that restarts it. — owner: "we need to reduce fails and blocks as much as possible" (6 Oct 2026) — anchor: `src/worker/services/workSweep.ts#sweepOnce`
- R11 [ALL-KINDS] A block is something the partner can clear: what was being done, what stopped it, what would clear it, who can — the row refuses anything less. — owner: 0173 (17 Sep 2026) — anchor: `src/shared/work/blocks.ts#describeBlock`
- R12 [ALL-KINDS] A deadline in the partner's words ("live by Monday morning", "today", "before doors") sets the card's priority at the door; a wait that could eat it states it. — owner: addendum item 3 (6 Oct 2026) — anchor: `src/shared/intake/dueTime.ts#dueTimeIn`
- R13 [ALL-KINDS] "Let me know what's realistic" gets an estimate reply first (today / next week / not possible, per item), then the build. — owner: addendum item 4 (6 Oct 2026) — anchor: `src/shared/work/partnerPractices.ts#PARTNER_PRACTICES`
- R14 [ALL-KINDS] Dated deferred work ("for next week …") is its own card, leased until its date, reported when it runs — never lost on close. — owner: addendum item 5 (6 Oct 2026) — anchor: `src/worker/services/deferredWork.ts#deferCard`
- R15 [ALL-KINDS] Several asks in one email → one done-line per item, partial completion stated per item. — owner: addendum item 6 (6 Oct 2026) — anchor: `src/shared/work/partnerPractices.ts#doneLines`
- R16 [ALL-KINDS] An unanswered question is answered by its stated default, said once; re-raised only on a state change, never re-listed each reply. — owner: addendum item 7 (6 Oct 2026) — anchor: `src/shared/work/partnerPractices.ts#PARTNER_PRACTICES`
- R17 [ALL-KINDS] Honest limits: when the ask cannot be done as worded, the nearest version is built and the limit stated in the done-line. — owner: addendum item 14 (6 Oct 2026) — anchor: `src/shared/work/partnerPractices.ts#doneLines`
- R18 [ALL-KINDS] Files for the partner ride on the finished email — attached under 10 MB in total, listed by name always, linked when larger; a file with personal data goes to the requesting partner's Drive as viewer only, never the store, never a public link. — owner: "a QR PNG and two CSVs sent to the partner" by hand (29 Sep–3 Oct 2026); addendum item 8 — anchor: `src/worker/services/workCardFiles.ts#outboundFilesFor`
- R19 [ALL-KINDS] A partner's standing constraints (exclusions, preview-only test data, keys server-side, private voter data, brand words) are a register injected into every job's prompt and obeyed without restating. — owner: addendum item 2 (6 Oct 2026) — anchor: `src/worker/services/partnerConstraints.ts#practicesForCard`
- R20 [ALL-KINDS] A reply is permission: a positive reply of any wording continues; only an explicit stop holds. — owner: "Porter: replies are permission" (27 Sep 2026) — anchor: `src/worker/services/replyIntent.ts#readReplyIntent`
- R21 [ALL-KINDS] When an ask names Drive folders, the job watches them and loads on arrival with no new email; "still empty" is reported once. — owner: addendum item 10 (6 Oct 2026) — anchor: `src/worker/services/driveWatches.ts#applyDriveWatchStatus`
- R22 [ALL-KINDS] An owner's or shared key used in the partner's place is said so in the reply — the cap, the fallback, the upgrade price — and the SECRET offer for the partner's own key stays open. — owner: addendum item 11 (6 Oct 2026) — anchor: `src/shared/work/partnerPractices.ts#PARTNER_PRACTICES`
- R23 [ALL-KINDS] A promised later migration is a stated deviation in the reply plus a dated deferred item. — owner: addendum item 12 (6 Oct 2026) — anchor: `src/worker/services/deferredWork.ts#deferCard`
- R24 [REPO-ONLY] Any GitHub repo a partner names is registered at the door and the job proceeds; the seeded hosts can never be re-pointed by email. — owner: "'registered west peek repos only' is a problem … any new repo we request is allowed" (6 Oct 2026) — anchor: `src/worker/services/webPropertyRegistry.ts#registerFromEmail`
- R25 [REPO-ONLY] A missing checkout is cloned from GitHub; a missing RUNBOOK is generated from the repo's own package.json and wrangler config (deploy route read, never guessed) and committed on the job's branch; a hand-written RUNBOOK with no `## Porter may run` gets that section DERIVED from package.json by the one data-op rule and written back on the branch, so the PR carries it and a human's later edit wins. — owner: same ruling (6 Oct 2026); "shouldnt these agents be able to create scripts and do what is needed and be flexible?" (6 Oct 2026) — anchor: `scripts/duties/lib/runbook.mjs#admittedScripts`
- R26 [REPO-ONLY] The repo's own data-op scripts — the RUNBOOK's `## Porter may run` list, or the list derived from package.json when that section is absent (never an empty refusal) — may run on the model's request, each recorded (script, env, exit, one line); never a bare `wrangler deploy`; schema only through migrations. — owner: "13 PRs … load-beats … booth-log" done by hand the week before (6 Oct 2026) — anchor: `scripts/duties/web-property-change.mjs#readResult`
- R27 [REPO-ONLY] A host outside her Cloudflare zones: the custom domain is attached through the API, the record Cloudflare requires is read back (never guessed) and emailed in three parts, the site stays live on pages.dev, the Mac re-checks every 15 minutes for 7 days and emails "live". — owner: "topbarz.xyz was not a cloudflare domain i owned … can porter do that too?" (6 Oct 2026) — anchor: `src/worker/services/dnsWaits.ts#recordDnsWaits`
- R28 [REPO-ONLY] Per-repo secret NAMES (its RUNBOOK's `## Secrets` plus vault vendor matches) are injected by name into the child's runs and `land`; the value never reaches the model. — owner: "the duty injects those names … no approval step" (6 Oct 2026) — anchor: `scripts/lib/vault-env.mjs#envForRepoRun`
- R29 [REPO-ONLY] Copy edits are applied verbatim from the repo's one editable copy file when the RUNBOOK names one; links https only. — owner: addendum item 13 (6 Oct 2026) — anchor: `scripts/duties/web-property-change-prompt.md#Standing partner practices`
- R30 [REPO-ONLY] Post-event operations (promote, close-of-vote export or tally, moderation) are RUNBOOK-named jobs on request; a refusal is relayed in plain English. — owner: addendum item 15 (6 Oct 2026) — anchor: `scripts/duties/web-property-change-prompt.md#Standing partner practices`
- R31 [REPO-ONLY] A partner-controlled redirect is flipped on their say: a safe shell first, the safe-to-flip moment stated; a live redirect to an empty page is top priority. — owner: addendum item 9 (6 Oct 2026) — anchor: `scripts/duties/web-property-change-prompt.md#Standing partner practices`
- R32 [REPO-ONLY] A data-op the job needs and the repo lacks is WRITTEN in the job's PR (package.json + its file), named under `## Porter may run`, run against preview in the same job, and admitted for production once landed — never a wait for "no script". — owner: "shouldnt these agents be able to create scripts and do what is needed and be flexible?" (6 Oct 2026) — anchor: `scripts/duties/web-property-change.mjs#runRefusal`
- R33 [REPO-ONLY] Production runs are gated by the partner's words, not by the list: a production data-op (`env: production` or args naming production) runs only when the partner's own email asked for it or they replied yes on the thread; preview runs are free. — owner: same ruling (6 Oct 2026) — anchor: `scripts/duties/lib/runbook.mjs#productionAsked`
- R34 [ALL-KINDS] One email, one right place: a reply steers its thread's card (or the card that card was merged into); a NEW email is never the answer to a BLOCKED card; it joins an open job only when it is about the same site or topic, else it is a new card (no closed list); when that cannot be told, the partner is asked ONCE which job it is, and no reply in 24 hours makes it a new card; an empty email ("Sent from my iPhone") steers and opens nothing. — owner: approved build, after the 8–9 Oct 2026 spam-card / Top Barz mix-up (9 Oct 2026) — anchor: `src/worker/services/emailRouting.ts#siteCardDecision`
- R35 [ALL-KINDS] A BLOCKED card always has a reminder time; putting back a wrongly cleared block restores its reminder, and a re-read cancels only the cards that message itself opened. — owner: approved build (9 Oct 2026) — anchor: `src/worker/services/blocks.ts#restoreBlock`
- R36 [ALL-KINDS] Each partner has one short living profile in D1 (never the repo): who he is and what he runs, what he is working on now (30 days idle drops off), how he writes, what he usually asks for, and his "Porter, note: …" lines verbatim — read by routing, the clarifying question and every job prompt; never an LP name, deal term or fund detail. — owner: approved build (9 Oct 2026) — anchor: `src/worker/services/partnerProfile.ts#profileBlockFor`

## What "shared layer: follow-up" means

A rule whose anchor still names only Porter's code. For a REPO-ONLY rule that is the point; for an
ALL-KINDS rule it is a regression and `validate:partner-service-rules` fails on it (0254). All 23
ALL-KINDS rules are enforced at the shared layer:

- **Prompt-enforced (R7, R8, R13–R17, R19, R21–R23):** one line each in
  `src/shared/work/partnerPractices.ts#PARTNER_PRACTICES`, composed with the requesting partner's
  constraints register by `src/worker/services/partnerConstraints.ts#practicesForCard`, and included by
  `steerFor` (Parker, Walker, Percy, Wyatt, deck, blog help, partner messages), the general employee
  loop (`buildStepPrompt`) and Porter's Mac duty (`job.practices` → `renderContext`).
- **Code-enforced:** R7/R8 — every kind's block is three parts (`blockWait`), the reminder too, and an
  email reply's "drop it" / "try again" / "send it to an engineer" takes that door on any kind
  (`blockReplyDoor`); R14/R23 — `Deferred to YYYY-MM-DD: <ask>` in any employee's result opens a dated
  card (`deferCard`, from the sweep); R15/R17 — `doneLines`; R19 — the `partner_constraint` register;
  R21 — `drive_watch` rows at the door, mapped by the Mac's heartbeat (`scripts/drive/pull.mjs --map`),
  loaded on arrival with no new email, "still empty" emailed once.
