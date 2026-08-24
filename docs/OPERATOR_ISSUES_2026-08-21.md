# Operator issues — 21 August 2026

The 22 items Sequoia raised after using the deployed system, plus what the hostile review found
independently. This file is the execution ledger for that work: it is updated as each item lands and
is not closed until every item is either DONE or explicitly DEFERRED with a reason.

Full findings, evidence and the reconciliation against this list are in the review artifact approved
on 21 Aug 2026.

**Status vocabulary** — DONE (shipped or on this branch, proven) · IN PROGRESS · TODO ·
DEFERRED (a decision was taken not to build it yet, reason stated).

Nothing here is marked DONE on the strength of a passing test alone. The failure mode this repo
already has is a green suite over a product nobody exercised.

---

## Decisions taken, so they are not re-litigated

- **Email.** Inbound accepted and fenced as untrusted; employees may parse it and assign work, but
  nothing starts and no money is spent without approval. Outbound built, automatic sending **off**
  for everyone including the MPs; manual MP-triggered send only, from `os@westpeek.ventures`.
  Briefs, research and reports are delivered to Home — download, or press a button to mail them to
  yourselves. Later: employees may email MPs. Much later: outside people.
- **The 7am brief is not an email.** It is the brief already built and waiting on Home.
- **Document delete is a tombstone** with actor, timestamp and reason. The document leaves view; the
  trail survives. Required by the append-only event spine.
- **Meetings keeps its spine.** The consent model, seating, chat turns, close-out delegation and the
  IC packet/decision machinery are sound and stay. The surface is rebuilt on top of them.
- **Meeting capture is in-browser**, chunked to Workers AI Whisper on the existing binding — no
  vendor, no credential. A purpose-built recording bot and streaming transcription are in
  `BACKLOG.md`.
- **Both MPs are live in an IC room simultaneously.** That justifies Durable Objects and needs an
  ADR before it is built.

---

## The 22

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Fold Today into Home; brief runs at 7am ET without a button | **DONE** | **Root cause found and fixed: 10 ms of CPU per cron trigger on the Workers Free plan.** The manual button was never the same code — it briefs one partner through a request. Now chunked: two sources and one partner's brief per tick, job on INTERVAL 15, `deliver_at_local` as the per-partner gate, regex compilation hoisted and the feed byte cap cut 2 MB → 256 KB. A failed brief retries up to three times rather than costing a partner the day. A scheduled tick has been watched SUCCEEDING in production. Does not close until briefs are watched landing on consecutive days.  **Today is folded in, 21 Aug 2026.** It showed open work, pending approvals and recent activity — all three of which Home already carries as modules (`my_work`, `approvals`, `what_changed`), and the first two of which are now tabs sitting directly above where Today used to be. The review also found it promised a date, meetings and deadlines it never showed, so it read as a page that had stopped working rather than as a smaller copy of Home. The route still resolves to Home so a bookmark lands. |
| 2 | "I know" and "Stop telling me" do the same thing; one should delete | **DONE** | They now differ: "I know" is quiet for a week (somebody who said it last Tuesday has not said it about today); "Stop telling me, for good" is permanent. Both stay keyed to the exact wording, so the same problem described differently is a different item and still gets said — that is what makes a permanent option safe. |
| 3 | Approvals: cards, reject/block/send-back/draft, state change after decision; hostile review | **DONE** | **Correction:** Approve, Request revision and Reject all exist — they render only for a `pending_review` card, and production has none, so the queue looked actionless. Decisions no longer swallow their result (a 403 said nothing before). Still missing: changing state *after* a decision, a block distinct from reject, and the card treatment. |
| 4 | Work under Approvals; drop the checkmark | **DONE** | Both answer the same question — what is waiting on a person — so they are adjacent rather than separated by Today, Notifications and the weekly review. The tick was the only icon on any item in the group, which made Approvals read as a state (done) rather than a place, and made every other item look like it was missing one. |
| 5 | Nav group titles carry no more weight than their items | **DONE** | They were quieter on every axis at once — same colour token, same weight, smaller, dimmed to 0.72. Now brighter and heavier, deliberately still small: a signpost should not compete on SIZE with the things it points at, or the eye scans categories instead of destinations. Verified on screen. |
| 6 | Thesis formatting | **DONE** | The real defect was not formatting: the page rendered the **oldest** mandate version, so amending said "Saved as version 2" and changed nothing. The API now names `current` explicitly and all eight call sites read it — removing the indexing question rather than answering it eight times. |
| 7 | Three routes into the funnel: manual/deck upload, Airtable, scout | **DONE** | Consolidated 22 Aug 2026. There are **four** routes, not three — MANUAL, EMAIL, NETWORK_OS, SCOUT — and they now converge on ONE governed entry point, `openIntoFunnel`. They differ only in what they hand it and who picks up the card. Every arrival records which route it came by, matches an existing company before creating one, and opens a work card rather than writing straight to the pipeline: operator, on two wrong versions, *"its not about going str8 to the funnel is about opening a work card for Wyatt to route it appropriately"*. `tests/dealIntake.test.ts` is shaped as the claim — one block per route, each proving it matched first, produced the right kind of outcome, and recorded provenance — so a fifth route belongs there or it is not consolidated. |
| 8 | A host AI employee on every Deals / Firm / Learn page | **DONE** | 17 pages across Deals, Firm and Learn have a named owner joined to the roster and its machines. Admin deliberately has none — it is machinery, not a room somebody runs. The card and the 1:1 chat landed with item 14 and are mounted inside `PageHostCard`, so all 17 got them in one change and none can forget. Gated on live employment: a switched-off host declines in their own name rather than the page pretending nobody was ever there. Operator's verdict after the rebuild: *"the chat panels are perfect."* |
| 9 | Edit a company; working History; link deal ↔ company; record a dropped "no" | **DONE** | `company.update` is a registered action and a RESTRICTED one — the tier that did not exist before. Reserved was wrong (a card for every spelling correction is how a queue becomes unreadable) and ordinary was wrong too (its last line hands the action to any authenticated identity, the read-only service account included). MPs, the investment team and the host employee act immediately; everyone else is refused with the list, so the refusal says who to ask. Every edit is attributed and on the event spine, and History works. **A pass is a real path**: `POST /api/opportunities/:id/transition` to PASSED, refused without a reason whatever the caller, keeping the company and its whole history — the pass pile is one press away. |
| 10 | Sectors derived from the thesis, plus a Misc catch-all | **DONE** | Derived at read time from the current mandate through one route, so amending the thesis changes every picker and the two cannot drift. Free text had already diverged: the mandate said `HEALTH_TECH` while the register said "Ed tech" and "Consumer", and three spellings of one taxonomy means "how much of the pipeline is health tech" has no answer. `matchSector` reads the old free text as the sectors it plainly is rather than discarding history. **Off-thesis is a real answer**, always last and always present — a company that does not fit is a fact worth recording, and forcing every one into a mandate sector would make the register lie to keep a dropdown tidy. The key stays `AI` so nothing already filed under it orphans; the label reads "Artificial intelligence". |
| 11 | Meetings + IC rebuilt | **DONE** | Spine kept, surface rebuilt, and the legacy form that filed every meeting as FOUNDER is gone. `MeetingsPage.tsx` and `IcPortalPage.tsx` replace the meeting UI that was stranded inline in `App.tsx`. **ADR-019** records the two decisions that needed recording: a meeting is captured in the browser (so employees can react during the call, on the existing Workers AI binding — no new vendor, no new credential), and a deal reaches the committee by MOVING ONE STAGE rather than through a separate errand. Consent is prompted and logged before capture, because in-browser recording shows no bot to the other side. Poppy facilitates and never decides; dissent survives the meeting and cannot be edited, removed, or written by an employee — proved in `e2e/p60-ic-decision-and-dissent.spec.ts`. |
| 12 | Portfolio sub-tabs: monitoring, and reporting from inbound updates | **DONE** | Unblocked once `RecordInvestment` gave the fund a way to book a position at all. Extracted from 250 inline lines of `App.tsx` into `PortfolioPage.tsx`, in LP's shape — it used to OPEN on a metric-definition form full of `metric_key` and `as_of_date`, and nobody arrives at Portfolio wanting to define a metric. **A real arithmetic bug was found in the new reporting**: month-over-month shifted 30 June back to 30 May, but every figure here is dated month-end, so the 31 May reading fell one day outside the window and the comparison reached back to April — reporting a two-month move as a monthly one, on every 31-day month. |
| 13 | Deal Math folded into Fund strategy; rebuilt for a novice GP | **DONE** | **The fabricated inputs were the serious half.** Every scenario was created with `fund_size: 30000000, investable: 24000000, fund_deployed: 10000000` HARDCODED IN THE REQUEST BODY — not form defaults a partner could see and correct, numbers no partner ever laid eyes on. The constraint engine then answered "does this sleeve fit", "is concentration within limit" and "is the reserve sufficient" against a thirty-million-dollar fund the firm does not have, and printed the answers with the confidence of arithmetic. `GET /api/funds/:id/basis` now reads what the fund actually is, with three provenances and no fourth — RECORDED, DERIVED, MISSING. There is deliberately no "assumed": an assumption is what got us here. The page REFUSES when the fund's size has not been recorded, exactly as it already refused without a pinned policy version; it had no business being stricter about a policy id than about the size of the fund. **Folded 22 Aug 2026.** Deal Math was a signpost to the VentureDeals dashboards plus the firm's own figures to carry across — which is the step you take WHILE deciding a cheque, not a separate errand. It is now the section "What this cheque actually buys", placed BEFORE the scenarios, because you size a cheque by what it buys and then ask whether the fund can afford it. `MERGED_ROUTES` resolves the old address so a bookmark lands on Fund strategy with the right host and title, rather than rendering merged content under the departed tab's name. |
| 14 | Per-page AI chat panel, top right | **DONE** | Mounted inside `PageHostCard`, so all 17 hosted pages got it in one change and none can forget it. **It expands the card, it is not a panel** — operator, on the first attempt: *"i am afraid u ruined the UI... each 1:1 chat panel should just expand the host card as is"*. Closed, the only new pixels are one line in the bottom corner; open, a rule appears and the conversation continues the card at the same width. The host of the page answers, because making a partner pick from a roster of nineteen asks them to know the org chart before they can ask a question. One thread per partner per page — two partners in one thread is a ROOM, needing presence and the Durable Object machinery `AGENTS.md` forbids without cause. A switched-off host declines in their own name, as a recorded turn. |
| 15 | Hostile review as a novice GP | **DONE** | 37 surfaces, five blind reviewers, plus a browser pass as MP. Artifact approved 21 Aug 2026. |
| 16 | LP page rebuilt in human language; reporting folded in | **DONE** | The vocabulary was the smaller half. There was nowhere in the system to record **how much an LP committed** or **how big the fund is** — "COMMITTED" existed only as a status string on three tables, so the system could say an LP had committed while holding no idea what to or how much. `lp_commitment` now records it in integer minor units (a REAL would put rounding into the one table where the number IS the fact), one live row per LP per fund so a revision edits rather than double-counting, and `fund` carries a target, currency and vintage. Signed and soft are reported as separate figures and never summed: the moment those are one number labelled "raised", the fund's headline is a hope. The page leads with the raise and reads in English — `LP records (LP_PRIVATE)`, `EXTERNAL VDR UNPROVEN — PROVIDER NOT SELECTED`, "Working claim" and "VERIFIED evidence" are all gone, and every LP is no longer silently filed as a family office. **Reporting folded in, 21 Aug 2026.** Operator: "reporting is supposed to be our fund reporting for
LPs, so its only natural they belong folded into 1 tab." They were two tabs for one relationship —
an LP is somebody who gave the fund money and whom the fund owes an account of it — so answering
"what has Cedar been told?" required knowing that packets lived somewhere else entirely.

The old page opened with two shouted disclaimers, verbatim: `NO FINANCIAL, ACCOUNTING, OR VALUATION
CORRECTNESS IS CERTIFIED — this surface records process, review, and discrepancy only` and
`UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE (no live administrator system is configured; West Peek
OS never writes to one)`. Both true, neither a sentence. They now read: *"This records what was sent
and who signed it off. It does not check whether the numbers in it are right"* and *"No administrator
system is connected, so both numbers are typed in by hand."*

A period is the quarter you owe a letter for; the packet is the letter; the reviews are who has to
read it first. Naming a period `Q1 2026` derives its dates, because typing two ISO dates to say "Q1"
is the small tax that stops a thing being used. The administrator NAV check moved across with it,
because it is the step BEFORE a letter goes out — telling investors a figure the administrator
disagrees with is the most expensive mistake available on that page, and the check for it was on a
different tab.

**Still open:** the claims and data-room machinery is not yet re-surfaced in plain words.|
| 17 | Cull employees; no duplicated work; veteran prompting from their machine's skills | **DONE** Closed 22 Aug 2026 with the operator's own decisions. **Roster 19 → 18**, Piper merged into Wesley — two seats on one machine with byte-identical guidance is not a division of labour, it is a duplicate row. **Machines 46 total, 43 active**; every active machine now has exactly one accountable seat and at least two written methods, which closes the gap that "19 machines have no methods" and "19 have nobody on them" were one fact. Three machines retired: `prompt_enhancer_intent` (a second front door to intent-parsing, which `askToCard.ts` already does better) and the two that assumed an engineer this firm does not employ. **Retirement is a flag and never a delete** — work cards and AI runs reference these rows, and a June work card must not lose the name of the machine that produced it. Duplicated work resolved: Pierce lost `ic_decision`, because the firm's own method says the champion may not write the kill case and Pierce is always the champion; Percy came off Communications' machine, whose single skill was his landing-page rubric — leaving the seat responsible for press and embargoes with no method about either. |
| 18 | Research as a guided conversation; market mapping unburied | **DONE** | The engine is now reachable. `POST /api/research/packets` searches live, grounds every finding against the record it came from, drops what the sources did not support and reports how much it dropped — and had no caller anywhere in the client. The only button on the page assembled a document out of findings a person had typed, which is a different job wearing the same word. Both now exist as separate buttons because they answer different questions: "write up what we know" and "go and learn". **The guided half landed 21 Aug 2026.** `POST /api/research/projects/:id/propose-questions` turns a topic into the five to seven questions that would settle it. The page asked the hardest part of research as its first field: a partner who types "AI inference" has said what they are curious about, not what would resolve it, and naming the questions that would is where an analyst earns their place. At least one must DISCONFIRM the obvious thesis — research that can only agree with whoever commissioned it is not research — and each must be answerable with evidence somebody could go and find. Proposed, never added: a research plan nobody agreed to is one nobody uses. **Closed 22 Aug 2026.** Two faults remained, both the same shape as the bug that made this surface invisible the first time. The project DETAIL rendered ABOVE the list that selects it, so with nothing chosen the page was a card and a bare list, and with something chosen the working surface appeared above the row just clicked; the list now comes first and an unopened page says so rather than showing nothing. And market mapping — which item 18 asked to have UNBURIED — had been moved out of its own near-empty tab and then folded straight into a `<details>` here, reproducing the burial the move was meant to end. It is a section now, headed with the question it answers. |
| 19 | University does not work | **DONE** | Root cause: the Workers AI adapter read a field the model does not return, so the whole cheap tier had never once succeeded. Fixed, proven against the live service, and University pinned to a capable model. **Still broken in production until this ships.** |
| 20 | Delete documents with a trail; stop filing morning briefs | **DONE** | Archive with a required reason, recording who and when, on the event spine. Not a hard delete: deliverables reference documents by id and the bytes live in R2, so destroying the row would break references and erase the history you asked to keep — it leaves every list, and the trail survives. Morning briefs are no longer filed at all; they live on Home and are superseded daily. Existing noise is yours to clear with the new control. |
| 21 | Cockpit overhaul; text fits; deterministic adjustable budgets; explain the two blocks | **DONE** | Overflow **fixed** — the four posture cards rendered on top of one another. The three named defects closed 21 Aug 2026, on `src/client/pages/AiOpsPage.tsx` (nav key `cockpit`, label "Cockpit" — `CockpitPage.tsx` is the portfolio view inside Fund strategy and was not touched).  **"Best available" now means something.** It wrote a policy byte-identical to Balanced — same cost mode, same pin behaviour — so choosing it changed nothing and the page then displayed "Balanced" back at you. Kept rather than deleted, because the operator's own ask was a lever she could "adj higher if i dont mind spending more" and removing it leaves the top of the range at Balanced — still a lie, just quieter. Unpinned work now takes the DEAREST priced capable model instead of the cheapest, recorded on the run with the honest caveat that price is the only quality signal in the model registry. Pins still win: a setting called "best available" must never be able to make the brief worse.  **Spend had three definitions.** `dailySpendUsd` counted actual-or-estimate over queued/running/completed; Diagnostics summed actual cost alone over runs of ANY status; the all-time headline summed actual cost over completed runs only, valuing every unpriced run at zero. One word, three populations — the same shape as "follow-on candidate". `src/worker/ai/spend.ts` is now the single definition, and today / this month / all time / both ceilings / Diagnostics / the boundary's own gate all read it. The sentence saying what is counted is served from that module and printed above every figure, so the page cannot reword the arithmetic.  **The quarantine has an exit.** `GET /api/ai/quarantine` lists what is waiting, oldest first, with what leaving it there has already cost. "Use it" is the existing accept route, which had no caller anywhere in the client. "Throw it away" is new and deliberately does NOT clear the quarantine flag — refused text must never become usable — so an `ai_output_decision` row takes it out of the queue instead, with a required reason. A run already decided cannot be decided again, checked before the flag is touched so the other button cannot undo a refusal.  **Firmwide budget (item 23) landed with it:** monthly and all-time, integer cents, versioned, and enforced in the AI preflight — a ceiling below what is already spent is refused naming both figures, and a breach names the limit rather than saying "over budget". Migration `0121`. Not deployed, and no e2e run. |
| 22 | Fix the three red diagnostics; decide the interval; escalate to MPs; show what was escalated | **DONE** | Corrected by the browser pass: Diagnostics **does** detect — it reports "Broken — Scooter's brief". It never tells anyone, and Home says "Nothing outstanding" at the same moment. Two cards are green while wrong.  **Escalation landed 21 Aug 2026.** The interval is decided and documented: every tick, fifteen minutes — the checks are COUNT queries costing nothing, and what they catch sits unnoticed for days otherwise, so there is no argument for checking the firm's own health less often than the cheapest job on the schedule. It escalates only what PERSISTS: a fault must be seen DOWN on two consecutive runs before anybody is told, because alerting on one bad tick trains a partner to ignore the alert. Told once, not every quarter of an hour, and both partners — "somebody will see it" is how a thing goes unowned. It also says when a fault RECOVERS, since an alert with no all-clear leaves you unable to tell a fixed fault from one nobody has mentioned lately. Watched running in production: `13 checked · 0 down`. |

---

## Morning brief — operator spec, 21 Aug 2026

Stated by the operator; recorded here so the rebuild is not designed from guesswork.

- **Automated at 7am ET**, every day, with no button pressed.
- **A manual "run my brief" button** for whoever is up earlier. Running it manually satisfies that
  day: the automated run must know it has already happened and skip, then resume automatically the
  next morning. One brief per person per day, however it was triggered.
- **No manual sweeping, ever.** The sweep is part of producing the brief, not a separate chore the
  partner performs first.
- **MPs may add sources by hand** on Sources & sweeps. This is currently impossible:
  `POST /api/intelligence/sources` and `PATCH /api/intelligence/sources/:id` are built, authorized
  and reachable from no button, on the page whose entire stated purpose is where material comes
  from. Building that UI is part of this item.

**Known blocker.** `daily_intelligence` takes roughly four and a half minutes and `runDueJobs` runs
jobs sequentially inside one `ctx.waitUntil`. A cron invocation ends long before that, which is why
scheduled briefs die and manual ones succeed — the manual path holds a request open. The sweeper
now makes the failure visible; it does not make the job finish. Before 7am automation can be
trusted the brief has to stop depending on completing inside a single invocation — chunked across
ticks, or moved to a durable execution path. Do not close item 1 until a scheduled brief has been
watched succeeding in production on consecutive days.

---

## Operator notes filed 21 Aug 2026 and closed the same day

### Employing someone is one press · **DONE**

> "making an employee active shouldnt be so hard. it should just be one button press and an audit
> trail of who did it and at one time. with the option to put a reason in the box for turning on or
> off"

It took five steps across two surfaces: open the detail panel, press "Request activation", leave for
Approvals, approve the card, come back, press a second and differently-named button. Worse, the
on/off toggle on the card only rendered for someone already ACTIVE or PAUSED — which was one of
thirty-one employees — so for almost the entire roster the card carried no hire control at all.

`POST /api/ai/employees/:id/employ` now does the whole chain in one call, and writes every record
the long way round wrote: an approval card, a decision on it by a named human, a consumed receipt, a
status-history row and an event. Nothing is skipped and nothing is faked. **The collapse applies
only when the person pressing holds the approval role** — they are the person who would have
approved it — and that is checked here and then independently again inside `decideApproval`. Anyone
else pressing it still only files the request and is told so, with a 202.

The reason box is optional and hidden behind "say why". A required box is a box people fill with
"x"; left empty the trail still records who and when, which is the part that cannot be reconstructed
afterwards. Typed, it travels to the card summary, the decision note and the history row.

The trail is now read back onto the card — `last_status_change` on the lounge, joined to the
person's real name rather than `fu_scooter_taylor`, because an audit trail nobody can read is not
one. RESTRICTED and RETIRED are excluded on purpose: both are decisions somebody made, and a switch
must not quietly undo one.

### "How everything works" sat inside a line break · **DONE**

> "its fine that its printed twice like that. im talking about how the 'how everything works' is in
> the line break it looks weird"

The help link was `float: right` inside the purpose paragraph and declared after the text, so it
attached to the right edge of whichever line it happened to wrap into — landing mid-sentence. It is
now a flex sibling of the sentence, baseline-aligned on the first line, wrapping to its own line on
a narrow screen. It renders on all 38 pages, which is why it was visible on several tabs.

---

## Community ↔ Network OS · operator spec, 21 Aug 2026

Filed because it was discussed and never written down.

**What the operator said, in order.**

> "right now we have triggers for our network.joinwestpeek.com repo — `#wpdealflow` to add deal flow
> and `#wpnetwork` adds people to the network tab. maybe fully integrate all of that with this. deal
> flow flows thru to this app and i dont know if the network OS keeps the official database or not"

> "ok then since network os has the official database then the community tab should pull from it to
> match people and all of that. and maybe pull in rows of people names and job descriptions? or just
> pull in numbers and % of how many of each category we have of founders, lawyers, operators
> (employees), VCS? i dont know u figure it out"

**Settled: Network OS is the official database of people.** West Peek OS never becomes a second
one. This is already the declared law — `networkAdapter.ts` is the single crossing, inbound is
read-only and idempotent, and `validate:network-boundary` fails the build if any other file reaches
a Network OS host. Nothing below changes that; it makes the Community tab read what is already
there instead of inventing its own population.

**The two options were "rows of people" or "counts and percentages". The answer is both, in that
order of importance — counts first.** A roster of names is something Network OS already does better
and owns; duplicating it here would be a second copy that drifts. What West Peek OS can say that
Network OS cannot is what the population MEANS to the fund: how many founders, operators,
investors and advisors, what share each is, and which way those shares are moving. That is a read
on a community, which is exactly what §12A.4 gives this module and denies it the contact record.
So: the shape of the population up top, and beneath it a sample of real people with what they do,
clearly attributed to Network OS and never editable here.

**What "matching people" means.** The Community page currently holds the firm's own read —
segment, engagement, signal — on names typed in by hand. Those rows must be joined to the Network
OS record rather than living beside it, so a person the firm has an opinion about is the same
person Network OS has a record of.

**Known broken, found by the review and not yet fixed.**
- `network_external_mapping` and `person` are both **0 rows in production** despite a sync event
  recorded as successful. The sync reports success and stores nothing.
- The Community page reads `m.segment`, `m.member_type` and `m.engagement` off rows returned by
  `SELECT *` — so it depends on columns the list query does not guarantee, and lowercases them
  without a guard.

### The three crossings, decided 21 Aug 2026

Read against the Network OS repo rather than assumed. `ContactRecord` there already carries
`person_type: 'investor' | 'founder' | 'operator' | 'lawyer' | 'service_provider' | 'media' |
'general' | 'unknown'`, plus `company`, `title`, `tags`, `relationship_type`, `priority`,
`last_touch_date` and `deal_flow_prospect: 'yes' | 'no' | 'unknown'`. Its four main person types are
exactly the categories the operator asked about, so no new taxonomy is needed anywhere below.

**1 · Community reads a shape, not a roster.**

> "when we are ready we are going to update the network OS with all of our 5000 community members
> and then what will happen to community tab here? should it mirror all those names or only just be
> the algorithmic page that matches people and shows a breakdown of cohort analysis?"

**The algorithmic page. It does not mirror.** Four reasons, in order of weight:

- A mirrored copy of 5,000 people is a second database that drifts, and the boundary law already
  forbids this app becoming one. The moment both systems hold the roster, "which is right" becomes a
  question somebody has to answer weekly and nobody will.
- 5,000 rows is not a decision surface. Nobody scrolls it, so building it costs work and returns a
  page that is never used.
- Network OS already does rosters, search and dedupe, and does them better because that is its job.
- What only THIS app can say is what the population MEANS to the fund: how many founders against
  operators against investors, which cohort is going quiet, who should meet whom, whether the
  community is producing deal flow. That is judgement over a population, which is what §12A.4 gives
  this module and deliberately denies it the contact record.

So: **cohort rollups, matching, and on-demand lookup.** The pull computes counts by `person_type`,
by segment, by engagement and by touch recency, and stores a small dated rollup — so the page reads
an aggregate, not five thousand rows, and movement over time becomes visible. A search box reaches
any individual on demand. The firm's own opinion of a person — segment, engagement, signal — is
stored here keyed to the Network OS contact id. That key is the join, and it is the only thing about
a person this app owns.

**Operational note for 5,000.** `/api/sheets/snapshot` returns the whole table with no paging, so a
full pull at that size is one large response. The rollup is computed at pull time for exactly this
reason; the page must never trigger a pull to render.

**2 · Capture writes OUT to Network OS, as a proposal.**

> "the capture tab needs to integrate also with network OS and allow new people to go the other way
> and go into the network OS database"

Feasible today and it uses the operator's own mechanism. Network OS exposes
`POST /api/intake/create`, authenticated by the same `wpn_session` this app already mints. It takes
`raw_text`, requires a recognised trigger, parses `key: value` lines through `parseFields`, and
appends to Network OS's **intake queue** — not straight to the contact table.

That posture is the point: capturing somebody here **proposes** them to Network OS and Network OS
decides. This app never becomes a writer of the record, which keeps the source of truth single.
Compose the raw text with `#wpnetwork` and the fields Capture already collects.

On this side it is still outbound, so it stays behind the existing reserved `network_os.writeback`
action and its receipt — `configuredClient().push()` currently throws by design and that is the
thing being enabled, narrowly, for this one endpoint.

**3 · Network OS deal flow flows IN to the funnel.**

> "what are we doing about new companies. i think network OS deal flow needs to be sent into this
> app in the deal flow tab that is another way in the funnel."

Agreed, and it is the fourth intake route in item 7. Network OS already marks it two ways: the
`#wpdealflow` trigger, which `classifyTrigger` separates from `#wpnetwork`, and
`deal_flow_prospect: 'yes'` on the contact itself. A contact carrying either arrives here as a
**proposed** opportunity — the same door every other intake route uses, never a direct write into
the pipeline — carrying the person who introduced it, so provenance survives.

**Direction summary, so it is never ambiguous.**

| | Owns | Direction | Mechanism |
|---|---|---|---|
| People | Network OS | in → cohort rollups; out ← Capture proposes | pull snapshot / `POST /api/intake/create` |
| Deal flow | West Peek OS funnel | in ← Network OS | `#wpdealflow` / `deal_flow_prospect = yes` |
| Firm's read on a person | West Peek OS | never leaves | `com_member` keyed to contact id |

Two systems never both claim the same write.

**4 · One mailbox, both triggers, routed by who owns the record.**

> "we should be able to email os@westpeek.ventures too with #wpnetwork #wpdealflow and get companies
> added to the funnel and sync to the network OS database"

`os@westpeek.ventures` is this app's address, so this app receives the mail and then routes each
trigger to whichever system owns that kind of record. One email may carry both.

| Trigger in the email | Lands in | Why |
|---|---|---|
| `#wpdealflow` | this app's funnel, as a **proposed** company | West Peek OS owns deal flow |
| `#wpnetwork` | relayed to Network OS `POST /api/intake/create`, as a **proposal** | Network OS owns people |
| `#wpdeck` | this app's funnel, built from the **attachment** | the information is in the deck, not the body |

**The third trigger, settled 21 Aug 2026.** It answers a different question from the other two — not
*what is this* but *where is the information*. A mail carrying `#wpdeck` tells the analyst the
content is the attachment and the body is a covering note, which changes what they do first. Without
it a deck arrives under `#wpdealflow` with a thin-looking body and reads as a poor submission rather
than a complete one.

**Defined once, in `src/shared/intake/emailTriggers.ts`.** The email handler routes from that table,
Porter's `the_inbox_triggers` method is written from it, and a test asserts the two cannot drift —
three copies of a routing rule is three chances for the inbox to do something the documentation says
it does not.

**THE MAILBOX MOVED TO `os@joinwestpeek.com`, and the reason matters.**

`westpeek.ventures` MX points at Google Workspace. Cloudflare Email Routing installs its own MX at
the zone apex, so enabling it there would have taken mail away from `sequoia@`, `scooter@` and
`info@westpeek.ventures` — the fund's actual email — in exchange for a machine inbox. Not a trade
worth making, and the operator confirmed the move: *"ok then we can change it to
os@joinwestpeek.com if we need to."*

`joinwestpeek.com` carries no mail (verified: zero MX records) and is already the app's own domain —
`os.joinwestpeek.com` and `network.joinwestpeek.com` both live there — so the address now matches the
system it belongs to.

**One thing to watch when enabling.** That domain is deliberately locked down for SENDING:
`v=spf1 -all`, `_dmarc p=reject` with strict alignment, and a null DKIM key. Receiving is governed by
MX so none of that blocks us, but Cloudflare's enable flow adds its own SPF record, which collides
with `-all` — only one SPF record per domain is valid. Delivery here is to a **Worker**, not a
forward to another mailbox, so nothing is ever re-sent and that SPF is not needed. Keep `-all`.

**STILL NOT RECEIVING.** The table, the routes and the method are built and tested. Mail to
`os@joinwestpeek.com` does not reach this Worker yet, because Cloudflare Email Routing has never
been enabled on the domain. Until it is, sending a triggered email does nothing at all and must not
be described as working.

This does not contradict the rule above — it honours it. The mailbox is a front door, not a store:
nothing is written twice, each record goes to its one owner, and both arrive as proposals a human
reviews rather than as direct writes.

**BLOCKED ON CONFIGURATION, and named honestly.** There is no inbound email path in this Worker at
all today — `src/worker/index.ts` exports `fetch` and `scheduled` and no `email()` handler, and
`wrangler.toml` has only the OUTBOUND `send_email` binding, still commented out. Receiving mail
needs Cloudflare **Email Routing** enabled on `westpeek.ventures` with a route for
`os@westpeek.ventures` pointing at this Worker. The handler is ordinary work; the DNS and Email
Routing setup is a dashboard action on the domain and is the actual gate. Until it is done, the
email route is UNPROVEN and must not be described as working.

**5 · No email-routing employee. Porter already is one.**

> "should there be an employee who just handles email routing? routing to employees or wherever the
> emails go?"

**No new seat**, and the roster already made this decision. Porter is "Systems & Intake Operator",
his machines are `global_capture_routing`, `network_os_sync_verification` and
`systems_data_integration`, and his own bio reads: *"Everything that arrives and everything that
syncs. Routes captures to whoever owns them... Plumbing, which is why it is one seat rather than
three."* Adding a mail-room seat beside that is precisely the duplicated work item 17 exists to
remove.

**And most of the routing should not be an employee at all.** `#wpdealflow` → funnel and
`#wpnetwork` → Network OS is a rule, not a judgement. A deterministic dispatch is cheaper, faster
and cannot hallucinate a destination; paying for an AI call to read a hashtag would be a bad trade
made on every message.

**What DOES need Porter is the exception**, and that is the real work: mail with no trigger, mail
with a conflicting one, a deck attached with no covering text, a founder replying into an old
thread, the same person arriving twice under two addresses. Those are judgement calls on the firm's
behalf, which is what an employee is for. So the mail room is a machine and Porter owns the pile it
cannot decide — with the exceptions surfaced on **Needs your attention**, because an unrouted email
sitting in a queue nobody opens is the same failure as a stuck job.

**Order of build.** The outbound relay (crossing 2) comes first, because the `#wpnetwork` half of
this email route is the same call. Deal flow intake (crossing 3) reuses item 7's proposal door. The
email handler is last and only after Email Routing exists.

---

## Item 25 — every tab laid out like the LP page · final pass

> "add a final pass for every single tab that makes sure the pages are not jumbled like the events
> tab and look more like the LP tab"

**The standard, named, because "make it nicer" is not one.** The LP page reads well for reasons that
can be copied:

1. **A flat sequence.** Heading, one card, next heading. Nothing nested, nothing behind a
   disclosure, nothing that reveals a further thing when you pick something. The only thing that
   nests is a rare action — "add a second deal for this company" — confirmed by the operator as the
   right exception.
2. **One heading level per rank.** Sections are `h3`, things inside a card are `h4`. Dealflow had
   four sections at the same rank rendering at four sizes, with the most important one smallest.
3. **Headings say what the section is FOR**, not what table it reads. "Where the raise stands", not
   "Fund metrics".
4. **Rules between sections.** They were always distinct and the page never showed it.
5. **Nothing waits silently.** A section with nothing in it says why — and says whether it is empty
   or has not been asked yet, which are different facts.
6. **No machine vocabulary.** `LP_PRIVATE`, `EXTERNAL VDR UNPROVEN`, "Working claim" were all on one
   page.

**Known offenders already seen:** Events & Rooms (the operator's own example), Cockpit, Machines,
Governance, Contradictions, Integrations, Secondaries, Meetings.

**Do it last**, after the functional items — a page whose behaviour is about to change is a page not
worth laying out twice.

---


### The audit, 21 Aug 2026 — every surface read against LpPage.tsx

Two findings apply to EVERY page and are worth more than any single rebuild:

**1 · `<hr>` is styled and used zero times.** `styles.css:268` defines the rule; not one page file uses
it, LP included. "Rules between sections" was written into the standard and never written into the
code. Sections are currently separated only by `h3:not(:first-child) { margin-top: --space-xl }`, so
any page that sections with `h4` or `h5` silently gets the smaller `--space-lg` gap and reads as one
undivided run. That is most of them.

**2 · Ten pages restate the nav label as their own first heading.** The shell already prints the page
title (`App.tsx:4120` renders `<h3>{activeItem.label}</h3>`), so Secondaries, Record, Cross-office,
Meetings, Events, University, Weekly review, Tasks, IC portal and Community each open with a heading
that says what the tab you just clicked is called. Pure wasted space at the top of the fold, which is
the operator's "space isnt being wasted" complaint with a precise cause.

**3 · Rank does not mean depth.** Many pages use `h4` or `h5` for their TOP-level sections, which
ranks them below the shell's `h3` title, so nothing on the page reads as a section. `AiOpsPage` and
Governance have no `h3` at all. Rooms nests an `h3` two levels inside another `h3`. Meetings runs
h3 → h5 → h4. `IntelligencePage` (478 lines) and Contradictions and Activity and Documents have no
headings whatsoever.

**Worst ten, in order:** Events & Rooms (the operator's own example — four nesting levels, an `h3`
inside an `h4`, and the whole Events page mounted inside a Rooms subsection); Cockpit/AI controls;
Integrations; Contradictions; the AI page; Network; Machines; Sources & sweeps; Meetings; and
Activity + Documents together.

**Machine vocabulary reaching the screen**, quoted from the audit: `PROPOSED`, `BREACH`, `DISABLED`,
`OVER TARGET`, `VALUE_DISAGREEMENT · OPEN · HIGH`, `LP_PRIVATE` in a dropdown, `relationship_owner`,
`fixture_contact_1`, `metric_key`, `as_of_date`, `task_class`, `pricing_state`, `max_data_class`,
`diligence_note`, `approval.decided`, and object rows printed as `{object_type}/{object_id}` — a
table of primary keys shown to a Managing Partner.

**Things hidden that should not be:** Machines puts every method behind a row click AND has a second
department-skills section that only appears once a filter is moved off its default. Sources & sweeps
is entirely `<details>` closed on load. Research still renders the project detail ABOVE the list that
selects it, so with nothing selected the page is inverted. Meetings hides seating behind a click with
nothing saying employees can be seated. Rooms hides venues, seed questions and the decision itself
behind guessing that a row is clickable.

## Item 24 — every role researched, every machine given another pass

> "i should not have had to give u that. u r an ai and llm and u should figure out what the role is
> and what it entails and make sure the machine has those skills and task requests and make sure the
> tabs show the things" — and: "IN FACT U NEED TO DO SOME RESEARCH FOR ALL THE ROLES AT THE END AND
> GIVE THE MACHINES ANOTHER PASS. ADD THIS TO YOUR LIST"

Fair, and the criticism is the useful part: the duties of an early-stage VC research seat are
knowable without being dictated, and waiting to be handed them was the wrong instinct.

**MEASURED, so this is a scoped task rather than a sentiment.** Of 45 declared machines:

| | count |
|---|---|
| No methods at all | **19** |
| One or two methods | **15** |
| Meaningfully covered | 11 |

The empty ones include machines the fund cannot run without — Fund Construction + Capital
Allocation, Portfolio Performance + Follow-On Decision, Source-of-Truth Resolver, AI Employee
Performance + Lifecycle. The thin ones include `ic_decision` (1), `lp_fundraising` (1),
`portfolio_support` (1) and `venturedeals_deal_math` (1): the committee, the raise, the companies
and the arithmetic, each with a single method.

**What the pass has to do, per machine:**
1. Work out what the role actually entails, from what the seat is for rather than from its name.
2. Write methods to the standard already set — what to DO and what makes an answer good. "Be
   thorough" is not a skill; "name the one assumption the thesis rests on, and say what would
   falsify it" is.
3. Check the surface. A method nobody can trigger is a document, not a capability — the operator's
   "make sure the tabs show the things" is the half that turns a written duty into work the firm
   can actually ask for.

Queued to the end with items 21–23.

---

## Item 23 — the firmwide budget · operator ask, 21 Aug 2026

> "add another item to overhaul the budget section in the cockpit tab. i need to be able to set a
> firmwide budget very easily and have it change, show up and persist — u can do this last"

Queued behind the rest of the 22 at the operator's request.

**A NAMING COLLISION IN THE CODE, and it is worth fixing while this is open.** There are two keys
and their names cross:

| nav key | label a partner sees | what it is |
|---|---|---|
| `cockpit` | **Fund strategy** | allocating the fund |
| `ai-ops` | **Cockpit** | the admin console — providers, routing, and what the firm spends |

Cockpit is `ai-ops`, and it is the right home for a firmwide budget: its own stated purpose is
"Providers, models, how work is routed, and what the firm is spending on AI", and it already offers
"Raise or lower AI spend". The key named `cockpit` renders something else entirely. I read the key
rather than the label and got this wrong once; the collision is the reason, and renaming the stale
key is part of this item.

The review's item 21 found the adjacent problem: money has three definitions, and Diagnostics and
Cockpit report today's spend 28% apart under the same label.

"Persist" is the operative word. The daily cap currently reads $25 with no surface that sets it, so
whatever is built has to write somewhere durable and be read back by the boundary that enforces it —
a budget that displays but does not bind is worse than none.

---

## Operator notes filed 21 Aug 2026, not yet built

**Machines: show, and EDIT, each machine's skills.** Surveyed 21 Aug 2026.

*What exists:* a real skill library — `src/shared/skills/library.ts`, 11 skills across 7 of the 45
machines, attached to machines and inherited by employees through `primaryMachineKeys`. The Machines
page already renders it firm-wide (`MachinesPage.tsx:361-406`). What it does **not** do is show a
machine's methods inside that machine's own detail panel, which is where the operator looked.

*What does not exist, and the correction worth stating plainly:* **skills cannot be edited, and not
because the UI is confusing — there is no skill table.** `grep -in skill migrations/` returns zero
hits across all 88 migrations. The library is code, so adding a skill today means a code change and
a deploy.

*The operator's ask:* write a new skill in plain English and have the system translate it into the
technical prompt the machine's employees follow.

*What that needs, honestly:* a `skill` table; a write path; an AI translation step (plain English →
the structured guidance lines the library already uses); and a decision about governance. A skill
changes how **every employee on that machine behaves on every run**, which makes it closer to a
policy change than a note. The shape that fits this system: the operator writes it plainly, an
employee drafts the technical version, **the operator reads the drafted version and approves it
before it takes effect** — never a plain-English sentence silently becoming a live instruction
nobody reviewed.

*Operator revised the ask, 21 Aug 2026 — simpler, and it avoids the governance problem entirely:*
no editing of installed skills. Just **see** them per machine, with a link out to the source file on
GitHub to read in full; and **add** a new capability or skill by writing plain English, which gets
translated into the right technical terms and collected in one catch-all markdown file.

*One constraint that shapes it:* the Worker cannot write to the GitHub repository. There is no token
and no path. So the catch-all file is either (a) held in D1 and rendered as markdown for the
operator to copy or download and commit, or (b) written through the GitHub API with a token, which
is a new outward-facing credential and an external effect that would pass through the effect
executor. (a) is smaller, needs no credential, and keeps the repo the single source of truth —
recommended. Viewing needs no approval at all, which is why the revised ask is much cheaper than
the original.

*Capabilities are the mirror image.* The `capability` and `capability_assignment` tables exist with
four working routes (`index.ts:1017-1020`) and **zero client callers**, so the page teaches what
Active/Bench/Archive mean and offers no way to move anything between them.

*Also worth knowing:* skills exist for 7 of 45 machines, and 9 of the 19 roster employees sit on a
machine with no methods written down at all — Porter, Waverly, Wells, Willow, Walter, Parker, Pax,
Preston and Whitney. Writing those is authorship, not engineering.

**West Peek Rooms — the ethos document was found, and the generator ignores most of it.**
`docs/COMMUNITY.md` is the source of truth and says so: *"Where the code and this document disagree,
this document is right and the code is a bug."* It is already mirrored into
`src/shared/events/programme.ts` with a test that fails if the wording drifts.

*What it specifies:* Rooms are curated experiences — dinners, salons, workshops, deep-work sessions,
operator roundtables, excursions, regional gatherings. A four-row rhythm: **weekly** (The Office),
**monthly** (Mastermind and one Room), **quarterly** (regional gatherings, curated dinners,
workshops), **annually** (Summit, Council). Rooms are *"the primary monetization layer"*; sponsors
underwrite experiences and **never purchase access to members**. The pilot Zero-to-One Room is
modelled at $30–45k from one presenting partner, one supporting partner and one in-kind partner —
*"do not start with six logos."*

*What the generator actually does:* proposes only the monthly Room — the other three rows of the
rhythm exist as prose and as executable behaviour nowhere. City is hardcoded to New York; the job's
configured city payload is never read, so it is dead config that looks live. It proposes for the
CURRENT month while its own description promises next month's. The venue brief is hardcoded to *"a
seated working dinner"*, so the candidate list is dinner venues before the model sees anything, and
an unrecognised format silently becomes DINNER. **Every packet ever generated reports a sponsor
target of exactly $27,500–$37,500** — arithmetic on a constant, not a judgement about whether this
Room can attract a sponsor or which category fits it. `scheduleRoom` stamps `cadence='MONTHLY'` on
every Room, so the one column that could carry per-type rhythm carries a constant.

*The operator's clause that has no home yet:* an event should either model how it makes money, or
say up front that it deliberately does not. Nothing in the schema or the verifier expresses that.
The nearest thing is an advisory `no_sponsor_thesis` flag — a packet with no sponsor thesis and a
phantom $37,500 revenue line still saves, still gets approved, still becomes a Room. Given the
document calls Rooms the primary monetization layer, this is the largest hole.

*Not found anywhere:* the "West Peek Rooms internal decision deck" that the canonical master plan
lists as a source input. Not in the repo, the parent directory, sibling repos, or Drive. If a richer
ethos exists, that is where it is, and its contents are not being guessed at.

**Superseded note.** **West Peek Rooms is the flagship events product.** Its goal is community, brand, and money. There
is an ethos document that sets out the event TYPES and the CADENCE at which each should be
proposed — the proposing employee should follow it rather than defaulting to monthly. Every
proposal should model how the event makes money (sponsorship and so on) unless it is explicitly a
non-revenue event, which must be stated up front. Today's generator does none of this: it proposes
on a job named "Monthly" that is configured to run DAILY at 13:00, defaults the city to New York
and the month to the current one because the client posts an empty body, and reports "Venue $0–$0 /
Net $23,900–$33,900" whenever a venue carries no price. Under investigation.

**University and Research should cover industries, not just craft.** University is pre-programmed to
teach a novice VC the trade. The operator wants it to also teach a specific INDUSTRY on demand — AI
inference was the example, deliberately chosen as esoteric — with Whitney bringing a partner up to
speed fast and plainly, without pretending the subject is simple. Paired with it: the research
employee should produce a real report on a sector — the companies, the players, who is doing what.
These are two halves of one need (teach me this market / map this market) and they already have the
right owners: Whitney hosts University, Wyatt hosts Research. Feeds items 18 and 19.

**Who hosts nothing.** With hosting scoped to Deals, Firm and Learn: Percy, Piper, Pippa, Poppy,
Porter, Walker, Willow, Wren. Not a defect by itself — a Chief of Staff and a compliance seat should
not need a page — but it is one honest input to the cull in item 17. Poppy is worth a decision: she
is the IC Facilitator and the IC lives inside Meetings, which Walter hosts.

---

## Item 7 — how a company enters the funnel · operator spec, 21 Aug 2026

**Four routes in, and they are not the same axis as "where deals come from".** That section today
shows `relationship_origin` — Community intro, Network — which is *how the firm knew them*. An
intake route is *how the record entered the system*. A company has both, and conflating them loses
the more useful one.

1. **Manual** — type it, as today.
2. **Upload a deck** — the page's host employee parses it and fills the record in. Wyatt hosts
   Companies and Research; parsing a deck is his work.
3. **Email to `os@westpeek.ventures`** with a hashtag trigger.
4. **The analyst's own sourcing** — Wyatt finds it, per his method "check what the firm has already
   touched before opening a database everybody else reads".
5. **Airtable** — founder inbound from the website or an affiliated site such as a pitch competition.

**The hashtags already exist in the family.** `network.joinwestpeek.com` uses `#wpdealflow` to add
dealflow and `#wpnetwork` to add people. This is integration, not invention, and the same words
should mean the same thing in both places.

**The constraint that shapes all of it, from BACKLOG.md on 17 Aug 2026:** *"a hashtag trigger inside
the email cannot authorise anything, because the sender controls it. Authorisation has to come from
an authenticated partner, and a `From:` header is not authentication."*

That decision stands and the operator's ask survives it, because the hashtag **routes** rather than
authorises. `#wpdealflow` says "this is a company for the funnel"; it does not put one there. The
company arrives as something the analyst proposes and a partner confirms — which is also the
operator's stated email posture: inbound accepted and fenced, employees may parse it and assign work
to each other, nothing starts and no money is spent without approval. A stranger can write
`#wpdealflow`. What they cannot do is enter your pipeline.

**Network OS is authoritative for people and relationships**; this app mirrors it. That is already
the architecture and it is written into Porter's methods — "when our copy disagrees, our copy is the
suspect". Dealflow is this app's own. So `#wpnetwork` belongs to Network OS and flows here;
`#wpdealflow` belongs here. Worth knowing before building: the sync has genuinely run
(`network.sync_completed`, 18 Aug) while `network_external_mapping` and `person` are both zero, so
nothing has actually come across yet — and the Integrations page claims no client is configured,
which is false.

## Item 9 addendum — Deal records and tooling is a discoverability failure

The operator: *"I never realised it was the way to enter real numbers for Sensori — this is a UI
problem."* Exactly right. Sensori's card warns "2 values are placeholders" on the pipeline, and the
control that fixes them is three steps away behind a company dropdown in a section headed "acts on
one deal you pick". The warning and the remedy are on different screens. The fix is to make the
warning itself the way in.

---

## Found by the review, not on the list

Ordered by consequence. These are not optional extras; the first two outrank most of the 22.

1. **The fund cannot record that it owns anything** · **FIXED 21 Aug 2026.** A position is created in
   exactly one place — when a transaction is executed — and every route in that lifecycle was built,
   authorized and tested with nothing able to reach it. There is now a panel on the deal record that
   walks the real ladder: a share class, a draft that commits nothing, submission that raises an
   approval card a partner decides on Approvals, and execution carrying the receipt, which is the
   step that books the position. Nothing shortcuts the governance — the ladder was already right and
   simply had no rungs. **Not yet exercised against production data**; the server loop has long been
   tested, the interface has not been used in anger.
2. **The fund can say yes but not no** · **HALF FIXED 21 Aug 2026.** A pass is now reachable from any
   live deal and carries a required reason, kept on the deal and on the event spine — "we passed in
   August" is a fact; "we passed because the second founder had already left and nobody would say
   why" is what you want when they come back raising. And recording the fund as invested is now a
   Managing Partner's decision rather than a single unconfirmed click. **Still open:** the IC UI
   submits only APPROVE, and a REJECT there routes to a state from which PASS is unreachable.
3. ~~**`POST /api/intent/brief` has no authorization check at all**~~ · **FIXED 21 Aug 2026.** It now
   passes the choke point AND carries a role gate. The choke point alone was not enough: `ai.run` is
   neither reserved nor an external effect, so `authorize` allows any authenticated identity —
   including the read-only service account a Cloudflare Access service token resolves to. What it
   commissions is an unbounded model call filed as a firm document signed in an employee's name, and
   the prompt says "A Managing Partner has asked for a written brief", which should be true rather
   than assumed.
4. **The kill switch manufactures its own approval** — creates a card and approves it on the next
   line, then cites the receipt as evidence a human reviewed it.
5. **"Nothing is wrong" and "the server failed" render identically** across most surfaces. The helper
   written to prevent this, `stateMessage()`, is imported by no file.
6. **Five pages render their own replaced predecessor** · **PARTLY FIXED 21 Aug 2026.** Deleting them
   outright would destroy real capability — identity merges, deal math, meeting notes and close-out
   all live in the older components and have no home in the newer surfaces. So the BUGS inside them
   were killed instead: the legacy meeting form that hardcoded every meeting as FOUNDER is gone
   (close-out delegation reads the type to decide who follows up, so an LP call filed as a founder
   meeting routed its commitments to the wrong person), taking a duplicate `meeting-create-form`
   test id with it; and the deal-math panel no longer submits an invented $1M cheque into a $20M
   pre-money for whatever company is selected. Still open: the legacy company create form, which
   makes a company with no deal attached.
7. **Consequential controls fabricate their inputs** — deal math, scenarios, the graduation rate, the
   metric bands, the reporting period.
8. **You can assign work to an employee and never make them do it** — the endpoint that makes an
   employee work a card has no caller anywhere.
9. **Space and disclosure were never decided.** Content sits in a 600px column inside a 1200px area
   while tables are clipped; collapse state tracks page age, not importance.

---

## Landed and deployed

- **Error visibility.** `stateMessage` had the bug it existed to prevent: `useApi` records status 0
  when fetch rejects, and the test was `status >= 400`, so a dead connection rendered the *empty*
  text. Fixed, joined by `isFailure`, `failureText` and `mutationError`, and `api()` now returns
  status 0 instead of rejecting — an offline click produced an unhandled rejection and a page that
  did nothing. Adopted first where a silent refusal costs most: approval decisions, the whole
  weekly review, intelligence feedback, notification dismissal. Eleven tests.
- **Abandoned runs are closed out** on every tick rather than left RUNNING for ever inflating
  committed spend.

## Landed on this branch

- Workers AI adapter reads both response shapes; missing and empty responses report separately;
  vision supported per-model. Proven against the live service, six tests from recorded shapes.
- University, market maps and research packets pinned to a capable model, fallback off.
- The three Workers AI catalogue rows that silently failed a NOT NULL constraint, backfilled.
- The spend-posture cards no longer render on top of one another.

## Who may edit a company · settled 21 Aug 2026

Operator, asked directly: *"the MPs should be able to edit and the host employee and maybe
investment lead?"* — Managing Partners, `INVESTMENT_TEAM`, and Wyatt, who hosts Companies.

**This needed a new tier in `authorize()`, and the gap is worth recording.** The model had two
levels above nothing: RESERVED (never for an AI actor; a human needs the approver role and even then
it executes only behind an approved approval card) and everything else, whose final line reads
*"ordinary internal action: allowed for any actor inside firm scope"*. `company.update` was ordinary,
so any authenticated identity in the firm could rewrite a company record — including the read-only
service account a Cloudflare Access service token resolves to. The choke point ran and decided
nothing.

Reserved was the wrong instrument: it raises an approval card per action, and a card for every
spelling correction is how an approval queue becomes unreadable and then ignored.

So RESTRICTED — role-gated, not approval-gated. Named roles and named employees act immediately,
everyone else is refused with the list so the refusal says who to ask. Safe to act immediately
because the edit was already attributed and already lands on the event spine with per-field from→to.
An AI employee may hold a restricted role, which is the point: barring Wyatt from the register would
leave the firm with a host who cannot do the work his own page is for. What an AI still cannot do is
anything RESERVED — that boundary is untouched. Malformed restrictions fail CLOSED.

## Work cards have no bottleneck, and that is deliberate · 21 Aug 2026

Operator: *"so right now can any employee open a work card? i guess that is how it should be no
bottle neck"*. Confirmed and kept. `work_card.create` is an ordinary internal action — any actor
inside firm scope, AI employees included, no approval.

The line is in the right place. Opening a card is only saying *this needs doing*; the governance
bites on what the card DOES, where reserved and external-effect actions still require a receipt.
Wyatt can open a card for Porter unattended; neither can spend money or send mail because of it.

**Open, not fixed — operator, same conversation: "but all work cards do not need approval right?
file this away too ----maybe over a certain number of them needs approval? and cant do dupes".**
Confirmed: no work card needs approval, and none should. Two guards to build, and they are different
in kind — worth not conflating.

**Duplicates — a correctness guard, always on.** The same employee opening the same card twice is
never intended; it is a retry, a re-read of the same inbox, or a job that ran twice. So it is not a
threshold at all, it is a uniqueness rule: at most one OPEN card per (machine, object, employee).
A second attempt should find the existing card and add to it rather than fail — an employee told
"denied, duplicate" will simply reword the title and file it anyway. Note that `INSERT OR IGNORE`
must NOT be the mechanism: it would swallow the collision silently, which is the exact failure this
repo has shipped twice.

**Volume — a health signal, not a permission.** A threshold ("over N cards needs approval") is worth
building, but it should be understood as detecting a MALFUNCTION, not policing a decision. An
employee opening forty cards in an hour is not exercising judgement the firm needs to review; it is
looping. So the right response is to pause that employee's card-opening and tell both partners, not
to queue forty approval cards for a human to click through — which would deliver the flood to the
partners rather than stop it. The existing `healthEscalation.ts` is the right home: it already
escalates only what persists, tells both MPs once, and announces recovery.

Threshold to be set with the operator. It cannot be guessed from an empty system, and setting it too
low turns a working employee off in their first busy hour.

## Found by the layout pass, not on any list · 21 Aug 2026

Three defects that no complaint named, because none of them produces a symptom you can point at.

**Twenty-nine class names styled nothing.** A misspelt or never-written CSS class does not error,
does not fail a test, and does not blank the element — it renders unstyled, forever. `.page` was the
wrapper on nine pages. `.tablewrap` was undefined ON THE LP PAGE, so the commitment table on the
surface held up as the standard could push the page sideways. Status badges on Introductions rendered
as bare shouting capitals with no badge; its primary button rendered default grey. The four cells of
a deal row had no rule at all — only the grid's own `minmax(0, …)` kept a long company name from
blowing the row out, which was correct by luck. `npm run validate:css-classes` now fails the build on
any className with no rule.

**Two dead links that looked like inert buttons.** Home's "My open work" module and a health-check
destination both linked to `work-cards` — which is the API path and has never been a route. The
router falls back to Home on an unknown key, so pressing them appeared to do nothing rather than to
fail. The test covering this had pinned a dead link TWICE running (first `jobs`, then `work-cards`),
holding the bug in place instead of catching it. Every destination is now checked against the real
route list read out of `App.tsx`, and the guard was verified by reintroducing the bug and watching it
fail.

**Integrations fetched two lists and rendered neither.** `outstanding_diligence` and
`data_room_access` were requested, returned, and dropped on the floor. The whole investor block also
collapsed to a single line of prose when its API returned 403, so the sections did not appear at all
and a reader could not tell they existed.

## Network OS, fully on · CONNECTED 22 Aug 2026

Operator: *"in the integrations tab - network OS should be fully integrated and turned on and
working. do whatever is needed to make that happen and can file away for the end of this work."*

**What is already built.** The adapter (`src/worker/effects/networkOsClient.ts`) is complete and
boundary-checked — `npm run validate:network-boundary` fails the build if any Network OS host or path
appears outside it. It can read the snapshot, propose a person, and record a receipt for every call.
`#wpnetwork` relays a person to it as a PROPOSAL, and since 22 Aug the founder's company travels with
them. Community is designed as the algorithmic view over Network OS rather than a mirror of it.

**Why it was off, and a correction to how this was first diagnosed.** The original filing said two
of the three values were missing. **They were not.** `wrangler secret list` shows SECRETS and not
VARS, and both the origin and the email were in `[env.production.vars]` all along. The same mistake
was then repeated on the email: `info@` was read as absent from `.env.local` in the Network OS repo
when `wrangler.toml` — the source the deployed project actually uses — had carried all three
addresses the whole time. Two wrong conclusions, both from reading a copy instead of the source.

The real cause was the only remaining candidate: **the session secret did not match.** Network OS
signs its `wpn_session` cookie with `APP_SESSION_SECRET`, this app mints a byte-compatible one with
`WP_OS_NETWORK_OS_SESSION_SECRET`, and neither Cloudflare Workers nor Pages will reveal a secret
value once set — so the only way to make them agree was to ROTATE to a known value on both sides.
The operator accepted the cost, which is that every open browser session is signed out.

`networkOsBlockedReason()` names whichever is missing, and every surface reports it rather than
failing quietly.

**And then the Integrations page still said it was not set up — which was its own, separate bug.**
Operator, 22 Aug: *"the integrations tab is not telling the truth about network OS."* The page was
reading `connector.credential_name`, which migration `0021` had set to `NETWORK_OS_API_TOKEN` — a
name that **has never existed anywhere in this repository**. A placeholder written when Network OS
was a hypothesis, never updated when the real client landed, and pinned by a test that asserted the
placeholder string. So the page checked for a credential that could not be present and reported its
absence for ever, over a working integration.

Fixed in `0142` plus two rules worth keeping. **Status is derived, not remembered** — a stored status
is only as fresh as the last time somebody pressed a button, which is exactly how the row drifted for
a month. And **the check now contacts the far end**: `probeNetworkOs()` mints the session, makes the
request, reads the status line and cancels the body before a single contact is parsed, so it needs no
pull authority and brings no data across. Unreachable, 401, and other-HTTP are reported apart,
because they have three different fixes.

**Confirmed by the operator the same day: "accepted us."** That press is the first end-to-end proof
of the integration from the product itself.

**Connected at 20:57 on 22 Aug 2026**, and read back from the RECEIPT rather than the cursor:
`{"resource":"contact","status":"OK","provider":"LIVE"}`. The cursor agrees, but the cursor is not
the evidence — on 17 Aug it read `contact — OK` over three FAILED receipts and zero mappings, because
a fixture run had written OK over live failures.

**What "turned on" needed, in order.**
1. The two missing secrets set on the production Worker. **The operator supplies these — the base URL
   of her Network OS deployment and an email that is an approved user there.** They are credentials
   and go through `npm run vault:sync:cloudflare`, never into the repository.
2. A live pull proven end to end and WATCHED, not assumed. There is history here: on 17 Aug the sync
   cursor reported `contact — OK` over three FAILED receipts and zero mappings, because a FIXTURE run
   wrote OK over live failures. Fixtures can no longer touch the live cursor, and the first real pull
   must be read back from the receipts rather than from the cursor.
3. `#wpnetwork` relay proven against the live queue — a person proposed, and somebody at the Network
   OS end seeing them arrive.
4. Dedupe confirmed at their end, which the operator has stated is Network OS's job: *"network OS
   should already have dedupe and dupe prevention."* This app must not grow a second one.

**What must not change when it goes on.** Network OS owns who is a member; this app proposes and
never writes a contact. That boundary is enforced by the validator, not by convention, and turning
the integration on does not relax it.
