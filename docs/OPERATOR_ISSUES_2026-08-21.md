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
| 1 | Fold Today into Home; brief runs at 7am ET without a button | IN PROGRESS | **Root cause found and fixed: 10 ms of CPU per cron trigger on the Workers Free plan.** The manual button was never the same code — it briefs one partner through a request. Now chunked: two sources and one partner's brief per tick, job on INTERVAL 15, `deliver_at_local` as the per-partner gate, regex compilation hoisted and the feed byte cap cut 2 MB → 256 KB. A failed brief retries up to three times rather than costing a partner the day. A scheduled tick has been watched SUCCEEDING in production. Does not close until briefs are watched landing on consecutive days. |
| 2 | "I know" and "Stop telling me" do the same thing; one should delete | **DONE** | They now differ: "I know" is quiet for a week (somebody who said it last Tuesday has not said it about today); "Stop telling me, for good" is permanent. Both stay keyed to the exact wording, so the same problem described differently is a different item and still gets said — that is what makes a permanent option safe. |
| 3 | Approvals: cards, reject/block/send-back/draft, state change after decision; hostile review | IN PROGRESS | **Correction:** Approve, Request revision and Reject all exist — they render only for a `pending_review` card, and production has none, so the queue looked actionless. Decisions no longer swallow their result (a 403 said nothing before). Still missing: changing state *after* a decision, a block distinct from reject, and the card treatment. |
| 4 | Work under Approvals; drop the checkmark | TODO | Lands with the nav work. |
| 5 | Nav group titles carry no more weight than their items | **DONE** | They were quieter on every axis at once — same colour token, same weight, smaller, dimmed to 0.72. Now brighter and heavier, deliberately still small: a signpost should not compete on SIZE with the things it points at, or the eye scans categories instead of destinations. Verified on screen. |
| 6 | Thesis formatting | **DONE** | The real defect was not formatting: the page rendered the **oldest** mandate version, so amending said "Saved as version 2" and changed nothing. The API now names `current` explicitly and all eight call sites read it — removing the indexing question rather than answering it eight times. |
| 7 | Three routes into the funnel: manual/deck upload, Airtable, scout | TODO | Four uncontrolled routes already exist while the page claims "the only way in". Consolidate before adding. |
| 8 | A host AI employee on every Deals / Firm / Learn page | IN PROGRESS | Registry and rule landed: 17 pages across Deals, Firm and Learn have a named owner joined to the roster and its machines. Admin deliberately has none — it is machinery, not a room somebody runs. Personal surfaces are already signed by their deliverer. Card component and chat still to build; gate the card on live employment status. |
| 9 | Edit a company; working History; link deal ↔ company; record a dropped "no" | TODO | `PATCH /api/companies/:id` exists with no caller, no authorization and no event. Needs a `company.update` action key. The pass path does not exist anywhere. |
| 10 | Sectors derived from the thesis, plus a Misc catch-all | TODO | Currently free text, already diverging from the mandate's own vocabulary. |
| 11 | Meetings + IC rebuilt | TODO | Spine kept (see decisions). Delete the legacy form on the same route first — it files every meeting as FOUNDER. |
| 12 | Portfolio sub-tabs: monitoring, and reporting from inbound updates | TODO | Blocked behind the fund being able to record that it owns anything at all. |
| 13 | Deal Math folded into Fund strategy; rebuilt for a novice GP | TODO | Deal Math contains no math today. Fund strategy fabricates its inputs — every scenario records $10M deployed against a real $10K. |
| 14 | Per-page AI chat panel, top right | TODO | Ships with #8. The live-help service exists but is mounted only inside a meeting. |
| 15 | Hostile review as a novice GP | **DONE** | 37 surfaces, five blind reviewers, plus a browser pass as MP. Artifact approved 21 Aug 2026. |
| 16 | LP page rebuilt in human language; reporting folded in | TODO | There is nowhere in the system to record what an LP committed, or the fund's size. That is the rebuild, not the vocabulary. |
| 17 | Cull employees; no duplicated work; veteran prompting from their machine's skills | TODO | 1 of 31 employees has ever run anything; 0 hold a tool; the veteran standard reaches 2 of ~27 call sites. |
| 18 | Research as a guided conversation; market mapping unburied | TODO | The AI research engine is built and reachable from no button. Wire it before redesigning around it. |
| 19 | University does not work | **DONE (undeployed)** | Root cause: the Workers AI adapter read a field the model does not return, so the whole cheap tier had never once succeeded. Fixed, proven against the live service, and University pinned to a capable model. **Still broken in production until this ships.** |
| 20 | Delete documents with a trail; stop filing morning briefs | **DONE** | Archive with a required reason, recording who and when, on the event spine. Not a hard delete: deliverables reference documents by id and the bytes live in R2, so destroying the row would break references and erase the history you asked to keep — it leaves every list, and the trail survives. Morning briefs are no longer filed at all; they live on Home and are superseded daily. Existing noise is yours to clear with the new control. |
| 21 | Cockpit overhaul; text fits; deterministic adjustable budgets; explain the two blocks | IN PROGRESS | Overflow **fixed** — the four posture cards rendered on top of one another. Remaining: "Best available" writes a policy identical to "Balanced"; spend has three definitions that disagree by 28%; 51 quarantined outputs cannot be accepted because the button does not exist. |
| 22 | Fix the three red diagnostics; decide the interval; escalate to MPs; show what was escalated | IN PROGRESS | Corrected by the browser pass: Diagnostics **does** detect — it reports "Broken — Scooter's brief". It never tells anyone, and Home says "Nothing outstanding" at the same moment. Two cards are green while wrong. |

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
