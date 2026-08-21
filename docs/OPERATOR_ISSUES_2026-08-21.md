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
| 1 | Fold Today into Home; brief runs at 7am ET without a button | TODO | The scheduled brief already exists and **fails on the cron** — 4 of the last 8. Fix the job before merging the surfaces, or Home inherits a broken brief. |
| 2 | "I know" and "Stop telling me" do the same thing; one should delete | TODO | Both hide and both lapse after 7 days. Needs a permanent dismissal distinct from acknowledgement. |
| 3 | Approvals: cards, reject/block/send-back/draft, state change after decision; hostile review | TODO | Every decision button currently discards its result, so a 403 looks like success. Fix that first. Operator proposed a stacked-deck card treatment — card tops must carry state. |
| 4 | Work under Approvals; drop the checkmark | TODO | Lands with the nav work. |
| 5 | Nav group titles carry no more weight than their items | TODO | Diagnosed: group headings are same colour and weight as children, smaller, and dimmed to 0.72 opacity. Fix is to give them one axis of dominance, not size. |
| 6 | Thesis formatting | TODO | Formatting is the least of it — the page renders the **oldest** mandate version. Amending appears to do nothing. Six call sites take `[0]` from an ascending list; one takes `.at(-1)`. |
| 7 | Three routes into the funnel: manual/deck upload, Airtable, scout | TODO | Four uncontrolled routes already exist while the page claims "the only way in". Consolidate before adding. |
| 8 | A host AI employee on every Deals / Firm / Learn page | TODO | Build once, before the page rebuilds, so they inherit it. Home already shows bylines for INACTIVE employees — gate on employment status as part of this. |
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
| 20 | Delete documents with a trail; stop filing morning briefs | TODO | No delete route exists for anyone. 6 of 8 stored documents are machine noise. |
| 21 | Cockpit overhaul; text fits; deterministic adjustable budgets; explain the two blocks | IN PROGRESS | Overflow **fixed** — the four posture cards rendered on top of one another. Remaining: "Best available" writes a policy identical to "Balanced"; spend has three definitions that disagree by 28%; 51 quarantined outputs cannot be accepted because the button does not exist. |
| 22 | Fix the three red diagnostics; decide the interval; escalate to MPs; show what was escalated | TODO | Corrected by the browser pass: Diagnostics **does** detect — it reports "Broken — Scooter's brief". It never tells anyone, and Home says "Nothing outstanding" at the same moment. Two cards are green while wrong. |

---

## Found by the review, not on the list

Ordered by consequence. These are not optional extras; the first two outrank most of the 22.

1. **The fund cannot record that it owns anything.** Positions come only from executed transactions;
   all five transaction routes are unreachable. `position = 0` and structurally always will be.
2. **The fund can say yes but not no, and yes is the ungated one.** No pass control exists; the IC UI
   submits only APPROVE; "Move to invested" is one unconfirmed click that bypasses the reserved
   `investment.approve` key.
3. **`POST /api/intent/brief` has no authorization check at all** — any firm identity, including the
   read-only service account, can commission unbounded AI spend and file a signed firm document.
4. **The kill switch manufactures its own approval** — creates a card and approves it on the next
   line, then cites the receipt as evidence a human reviewed it.
5. **"Nothing is wrong" and "the server failed" render identically** across most surfaces. The helper
   written to prevent this, `stateMessage()`, is imported by no file.
6. **Five pages render their own replaced predecessor** in a disclosure below them, each still
   containing the bug its rewrite fixed, sharing test ids.
7. **Consequential controls fabricate their inputs** — deal math, scenarios, the graduation rate, the
   metric bands, the reporting period.
8. **You can assign work to an employee and never make them do it** — the endpoint that makes an
   employee work a card has no caller anywhere.
9. **Space and disclosure were never decided.** Content sits in a 600px column inside a 1200px area
   while tables are clipped; collapse state tracks page age, not importance.

---

## Landed on this branch

- Workers AI adapter reads both response shapes; missing and empty responses report separately;
  vision supported per-model. Proven against the live service, six tests from recorded shapes.
- University, market maps and research packets pinned to a capable model, fallback off.
- The three Workers AI catalogue rows that silently failed a NOT NULL constraint, backfilled.
- The spend-posture cards no longer render on top of one another.
