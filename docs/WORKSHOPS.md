# Monthly Rooms and Workshops

How the two monthly streams are planned, settled 17 Sep 2026 by the operator. It replaces the
16 Sep version of this page, which was right about the chain and wrong about almost every fact in
it — the length, who hosts, what a "concept" is and what free means.

**This document is read by a test.** `tests/workshopsDocument.test.ts` parses the tables and rules
below and asserts them against the code. A rule written here that the code does not do, or a fact
the code changed and this page did not, fails the build. This repo has twice shipped a
specification nothing read; that is the defect this arrangement exists to prevent.

## What a Workshop is

A **45–60 minute** working session on **West Peek Live** (a live stage for the host, attendee join
by code, chat, hand-raise, breakouts for exercises) for small-business owners, solopreneurs and
community builders. The promise is what they can **do** by the end; teach / do / show; at least two
breakout exercises; an artifact every attendee leaves with. No venue, ever.

**Scooter Taylor hosts.** A **co-host** is the norm rather than the exception — the other partner,
or a named guest with a live page showing they do this. A packet with no co-host says so out loud
rather than passing silently.

**Attendance is free. Always, by design — and Parker always suggests a small sponsor anyway.**
In the operator's words: *"we should always try to find a small sponsor for a workshop even if we
dont use them since its free to put them on."* These are two answers to two different questions and
they do not contradict each other: the session is never ticketed, and every packet still carries a
suggested sponsor **category** and a small ask, which the firm may simply not use. A packet with no
suggestion is flagged as incomplete.

## One topic a month, several angles inside it

This is the structural rule, not a wording preference.

> *"Black lawyers is a topic. Community is a topic. but angles are things like names / venues /
> type of event and for workshops the angles can be 'Community as a Service' the new model OR How
> to find your Brand's community."*

So: **one topic per month per stream**, and the three concepts are three **angles** on that one
topic. An angle varies the **name**, the **framing**, the **format**, the **venue**, the
**experience** or which cut of the audience it is aimed at. An angle never varies the subject.

Three different subjects cannot be produced, in two layers:

| Layer | What it does |
|---|---|
| Structural | The packet holds **one** `topic`. A concept's `title` is the angle's name; a concept has no field that can carry a subject of its own. |
| Rejected | Every concept must echo `angle_on`, copied from the topic. Values that differ mean three subjects, and the parse returns null — the stage **fails and retries**, and nothing is stored. |

## Who sets the topic

Either human may hand Parker a topic in advance and he builds angles on it. **If nobody has, he
chooses the topic himself** and brings something new and fresh. He never waits, never blocks, and
never asks which situation he is in — the two paths differ only by whether a string is present.

## Adjacency

A **light** rule: *"adjacency is a light rule. for one month. and just make sure they are not too
similar."* One month back, no near-identical subject in a row, soft rather than absolute — it is
guidance in the prompt, not a rejection in the parser, because "too similar" is a judgement.

**It measures what actually RAN, not what was proposed.** October's Workshop is hosted outside the
firm; Parker's own October AI packet was declined. An adjacency rule reading his proposals would
make November avoid a dead idea and walk into the subject that is actually being run. So it reads
calendared events (including ones the firm did not build) and packets a human kept.

## Cadence

**Both streams deliver on the 1st of the month prior.** November's lands 1 October. The trigger is
`runMonthlyRoomProposal`, which mints the monthly card. It is a floor, not a window: a tick on the
3rd because the 1st was missed still delivers.

## The plan on the record

The one source of truth is `MONTHLY_PLAN` in `src/shared/events/monthlyPlan.ts`. `WORKSHOP_SERIES`
is derived from it, not kept beside it.

| Month | Stream | Status | Topic |
|---|---|---|---|
| 2026-09 | Workshop | set by the partners | How to use AI for small businesses / solopreneurs |
| 2026-09 | Room | not running | — |
| 2026-10 | Workshop | hosted outside the firm | Content creation |
| 2026-10 | Room | not running | — |
| 2026-11 | Workshop | set by the partners | Community |
| 2026-11 | Room | set by the partners | Black lawyers |
| 2026-12 | Workshop | Parker chooses | — |
| 2026-12 | Room | Parker chooses | — |

November's Workshop is angles on **how companies and brands leverage community to achieve their
goals**. November's Room is **Black lawyers again** — she declined `rpk_6828fcf0` ("The Rise of the
Black Lawyer Room") on 15 Sep; the topic was never the problem, so this time it is several distinct
catchy names and unique experiences that draw both the people and the sponsors. December is
Parker's own pick in both streams, and not Black lawyers again.

A month marked **hosted outside the firm** or **not running** is not queued: the job says why
rather than building a packet nobody asked for.

## Two emails a month

**One for Rooms, one for Workshops, each addressed to Sequoia and Scooter together** — not one per
angle, not one per person. Two separate messages would be two conversations about one decision, and
with a single-use reply code in the mail the second copy would carry a code the first reply had
already spent.

Each email introduces Parker, opens with a **TLDR** giving the topic and the angles in one glance,
and spells out how to answer it.

## Deciding by reply

`src/worker/effects/inboundEmail.ts` states the rule the whole inbound design turns on: **"a
hashtag is a public word — so it may route but must never authorise."** A fixed tag like `#wpno`
would let anyone who learned it kill a month's plan.

So the tag is **minted per packet**: `#wpkeep-7Q4K` / `#wpno-7Q4K`, and everything after it is the
reason.

| Control | What it stops |
|---|---|
| Per-packet token | A published word that decides anything. The code belongs to one packet. |
| Token **and** authenticated partner | A leaked token alone does nothing; a forged `From` alone does nothing. |
| Single use | A replayed thread, and a second reply re-deciding something already decided. |
| Expires with the month | An old thread deciding a later month. |
| Unsure goes to Porter | A guess. Two codes, two answers, an unknown code, an expired code or an unauthenticated sender all become a capture with the reason on it, and change nothing. |

The decision lands in `decidePacket` — the same function the in-app button calls, so it is the same
status, the same note, the same event and the same shelf. There is no second decision path.

**Reply-To** on these emails is `os@joinwestpeek.com`, the mailbox the inbound Worker actually
reads; the sending address is `os@westpeek.ventures`, a different domain, so without Reply-To a
plain Reply reaches nothing.

## One chain, two kinds

A Workshop is `evt_room_packet.kind = 'WORKSHOP'` (migration 0171) on the same table, the same
queue, the same card on Parker's desk, the same one-stage-per-tick sweep, the same keep/dismiss door
and the same email as a Room. The Workshop branch is `runWorkshopStage` in
`src/worker/services/roomPacket.ts`; the brief, prompts, parsers and verifier are in
`src/shared/events/workshopPacket.ts`.

| Stage | Room | Workshop |
|---|---|---|
| DISCOVER | who pays to reach this audience | what the audience is asking this month — live search, every URL checked, every note **judged** |
| RESEARCH | each sponsor | passed through |
| CONCEPTS | three angles on the month's topic, one chosen | three angles on the month's topic, one chosen |
| VENUES | venues for the winner | passed through — **Virtual · West Peek Live** |
| PACKET | run of show, budget, structure, pitch | the promise, run of show with stage/breakout segments, exercises, what they leave with, the host and co-host, the delivery plan, the suggested sponsor, promo line, three invitation emails, budget |
| PDF | rendered, emailed to both partners in one message | rendered (`renderWorkshopHtml`), emailed to both partners in one message |

`verifyWorkshopPacket` removes a venue a model offers, strips any URL that was not judged, demotes a
guest host or co-host without a checked page, forces attendance-free, and flags a missing co-host,
a missing sponsor suggestion and a run of show outside the length range.

## How the partners trigger one

- **By hand:** Events & Rooms → *Ask Parker for a Room* → switch to **Workshop** → pick the month.
  A month with a set topic builds angles on that topic; an open month takes the topic typed, or
  Parker's own if none is.
- **By itself:** the `monthly_room_proposal` job mints the cards on the 1st of the month prior.
- **Dismissing** opens a reason box **on the card** — never a browser dialog. The reason is
  optional, and a dismissed proposal stays on the shelf below, greyed, with the reason attached.
