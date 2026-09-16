# Monthly Workshops

Recorded 16 Sep 2026 from the operator: "we are introducing monthly workshops in addition to
Rooms … the same workflow as Rooms: a packet with three concepts compared, one chosen", and
"WORKSHOPS ARE VIRTUAL ONLY. Every Workshop runs on West Peek Live."

## What a Workshop is

A 90-minute working session on **West Peek Live** (a live stage for the facilitator, attendee join
by code, chat, hand-raise, breakouts for exercises) for small-business owners, solopreneurs and
community builders. The promise is what they can **do** after 90 minutes; teach / do / show; at
least two breakout exercises; an artifact every attendee leaves with. Sponsors are optional — a
Workshop can be free by design. No venue, ever.

## The series on the record

| Month | Title | Who decides the topic |
|---|---|---|
| September 2026 | How to use AI for small businesses / solopreneurs | set by the partners — Parker builds the packet from the title |
| October 2026 | — | Parker proposes three and chooses |
| November 2026 | How to build community | set by the partners |
| December 2026 and every month after | — | Parker proposes three and chooses |

The set months live in code: `WORKSHOP_SERIES` in `src/shared/events/workshopPacket.ts`. A
Workshop queued for one of those months carries that title whatever was typed, and the three
concepts are three ways to **run** it, never three topics.

## One chain, two kinds

A Workshop is `evt_room_packet.kind = 'WORKSHOP'` (migration 0171) on the same table, the same
queue, the same card on Parker's desk, the same one-stage-per-tick sweep, the same keep/dismiss
door and the same email as a Room. The Workshop branch of the chain
(`runWorkshopStage` in `src/worker/services/roomPacket.ts`; brief, prompts, parsers and the
verifier in `src/shared/events/workshopPacket.ts`):

| Stage | Room | Workshop |
|---|---|---|
| DISCOVER | who pays to reach this audience | what the audience is asking this month — live search, every URL checked, every note **judged** |
| RESEARCH | each sponsor | passed through (sponsors optional) |
| CONCEPTS | three concepts, one chosen | three ways to run it (set month) or three topics (open month), one chosen |
| VENUES | venues for the winner | passed through — **Virtual · West Peek Live** |
| PACKET | run of show, budget, structure, pitch | the promise, run of show with stage/breakout segments, exercises, what they leave with, the facilitator, the delivery plan (platform run of show, on screen, join-code flow, tech check), sponsorship optional, promo line, three invitation emails, budget (facilitator fee + production time + materials) |
| PDF | rendered, emailed to both partners | rendered (`renderWorkshopHtml`), emailed to both partners once through the exec-email door |

`verifyWorkshopPacket` removes a venue a model offers, strips any URL that was not judged, and
turns a guest facilitator without a checked page into a partner-led session with the guest named
as an idea. `tests/workshops.test.ts` pins that a Workshop packet never carries a venue or a venue
cost — rows, text, email, PDF.

## How the partners trigger one

- **A month's Workshop by hand:** Events & Rooms → *Ask Parker for a Room* → switch to
  **Workshop** → pick the month. A set month shows its title, locked; an open month takes the
  topic typed. Submit: the draft is on the record and Parker's card is open; the sweep builds it a
  stage every few minutes and both partners are emailed the PDF.
- **By itself:** the `monthly_room_proposal` job queues Parker's own Room and, on its next tick,
  Parker's own Workshop for the following month when none of that kind exists.

Kept Workshops schedule as `evt_event.kind = 'WORKSHOP'` (event_type WORKSHOP, event_class OTHER),
location fixed to Virtual · West Peek Live.
