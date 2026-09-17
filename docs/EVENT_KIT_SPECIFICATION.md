# The draft proposed event kit — the specification

**Status: this is the specification the kit generator is built to, not a note beside it.**
`tests/eventKitSpecification.test.ts` reads THIS FILE and fails the build if the generator and this
document disagree — so a section added here without a section added to `EVENT_KIT_SECTIONS` in
`src/shared/events/eventKit.ts` breaks the build, and so does the reverse. A specification nothing
reads is the same void that swallowed an instruction to an employee; this one is read.

Written FROM the kit that was actually sent: `docs/EVENT_KIT_EXAMPLE_SEPTEMBER.md` is the real
September 2026 livestream kit, produced by hand for Scooter, kept here verbatim. The same shape as
`docs/EXECUTIVE_BRIEF_SPECIFICATION.md`: the operator's own example first, the code's names beside
it, and a test that will not let the two drift.

---

## What a kit is, and why there is exactly one

With every monthly proposal — **Rooms AND Workshops, both streams** — Parker writes **one DRAFT
PROPOSED EVENT KIT, for the angle he would run**. Not three.

It is the case for his own recommendation, and it is what makes the email something to react to
rather than a menu. The two angles he did not choose stay one line each in the packet, where a
comparison belongs. A kit per angle would be a menu with more pages.

A kit is a **draft**, and says so on its first line. Nothing in it is booked, and nobody outside the
firm has been contacted.

## The five sections, as the September kit wrote them

The test reads this table. The left column is the section; the right is the `key` in
`EVENT_KIT_SECTIONS`, and the order of the rows is the order a kit is written and rendered in.

| # | Section | Section key |
|---|---|---|
| 1 | Header | `header` |
| 2 | Official event description | `event_description` |
| 3 | Run of show | `run_of_show` |
| 4 | Discussion guide | `discussion_guide` |
| 5 | Social posts | `social_posts` |

What each one carries, from the example:

1. **Header** — event title, format, total duration, platform, and the proposed date and time.
2. **Official event description** — the published title, the broadcast time, the hook, "what we'll
   cover" broken into parts each with its own minutes, who it is for, and one audience tip.
3. **Run of show** — a table of Time / Segment / Description & notes / **On Screen**.
4. **Discussion guide** — the host's opening script, and the core questions for the guest.
5. **Social posts** — Post A to announce, and Post B written in a speaker's own voice for them to
   share.

## The four things a model does not decide

Each of these was a defect in the kit that actually shipped, and each is closed **structurally** —
in the parser and the verifier, after generation — rather than asked for in a prompt. The rule this
repo keeps relearning is that a prompt is a request.

### 1 · The platform: West Peek Live, alone

The owner, on the September kit's "StreamYard / YouTube Live / LinkedIn Live / Instagram Live" line:
*"THIS IS OUR PREFERRED WAY TO DO VIRTUAL EVENTS."*

So `EVENT_KIT_PLATFORM` is a constant the kit is given, there is no field a second platform could be
stored in, and `verifyEventKit` strips these four **by name** wherever they appear in the prose,
flagging `retired_platform_removed`:

`StreamYard`, `YouTube Live`, `LinkedIn Live`, `Instagram Live`

### 2 · A real proposed date and time — never a bracket

September's kit shipped **"[Insert Date] at 6:00 PM ET"**. A bracket is a to-do disguised as a
document: it reached a partner looking finished and was not.

The date is therefore **computed** by `proposedSlotFor(month, stream)` from the month and the
stream, is a real weekday in that month, and carries the word **PROPOSED** every time it is shown. A
model never writes it, so it can never fail to. The house slots:

| Stream | Slot | Time |
|---|---|---|
| Workshop | second Thursday | `6:00 PM ET` |
| Room | third Wednesday | `6:30 PM ET` |

The greenroom check-in is kept from the September kit: **15 minutes** before the broadcast
(`GREENROOM_MINUTES_BEFORE`), and the verifier **inserts the greenroom row back** if the model drops
it (`greenroom_inserted`).

Any remaining square-bracket placeholder anywhere in a kit is removed and flagged
(`placeholder_removed`) — replaced by the proposed slot where it was a date, and by the open mark
otherwise.

### 3 · What he cannot know is marked OPEN, never invented

The firm's standing rule: say what you do not know rather than filling a gap with something
plausible. Three kinds, and `openItemsFor` derives them from the record rather than trusting a model
not to fill them:

| Kind | When it is open |
|---|---|
| `CO_HOST` | the packet names no co-host |
| `GUEST` | the angle wanted a guest and none was stood up with evidence |
| `JOIN_LINK` | **always**, on a proposal — the event is not scheduled, so no link exists |

The join link has **no field at all** in `EventKit`: it cannot be invented into a shape that does not
exist. A person named into an open seat is taken back out and the seat restored
(`invented_person_removed`).

### 4 · The On Screen column

The part of a broadcast nothing else in this system thinks about: who is in frame, and in what
layout, minute by minute. Every run-of-show row carries one shape from a **closed** vocabulary, taken
from the September run of show — a backstage greenroom, the host alone, two-up for the interview, a
screen share for the demo, three-up for the wrap:

`BACKSTAGE`, `SOLO`, `2-UP`, `SCREEN SHARE`, `3-UP`

A row that comes back without a recognisable one is flagged (`on_screen_defaulted`) and defaulted,
never rendered as a blank cell in a table a producer has to run a live broadcast from.

## The shape of each stream

| | Workshop | Room |
|---|---|---|
| Length | 45–60 minutes | one evening |
| Cost to attend | free | — |
| Host | Scooter, usually with a co-host | Scooter, usually with a co-host |
| Size | — | 25–35 people, one real question |

## Delivery — a link, not an attachment

The kit is **filed as the deliverable** (`kind: "event_kit"`, on the recipient's Home, the mechanism
every run already uses) and **the email links to it**.

The owner's own product settled this, in West Peek Live's instruction pages: *"The email never
carries the text, so correcting a page corrects it for everyone who already has the link."* A kit is
a draft — the date is proposed, a co-host may still be open, the questions get edited — and an
attachment cannot be corrected once it has been sent. `deliver()` upserts on
`(source_type, source_id)`, so a rebuild **corrects the page the partners already have a link to**
rather than sending a second, contradictory copy.

**The email carries the TL;DR**: the proposed title, the proposed date and time, the duration shape,
and the one line on why this angle — enough to react to without clicking. Then the link.

## Where it sits in the chain

Between `PACKET` and `PDF`, which is the only place it can be: it **reads** the packet (the chosen
angle, the run of show, the hosts) and the PDF stage sends the email that must carry its link.

It is its own stage rather than a paragraph in the packet prompt because it answers a different
question, produces a different artifact with its own life, and the first thing to be dropped when
one call answers two questions is the half nothing verifies.

**Rule 0:** a kit that does not parse **fails the stage** — the sweep retries it with the reason on
Parker's card — rather than storing an empty one. A kit with no run-of-show rows does not parse at
all.
