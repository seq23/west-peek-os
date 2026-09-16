# Partner email and blog help

Recorded 16 Sep 2026. Two things a partner meets in their inbox, and the rules behind them.

## Every email an employee sends a partner has one shape

**The door.** `src/worker/services/execEmail.ts` is the only place an employee's email to a
partner is sent from. `sendPartnerEmail` (an employee writing to `sequoia@` / `scooter@`) and
`sendFirmUserCopy` (a partner pressing "Email it to me" on Home) both take an `ExecEmailInput`,
lay it out with `src/shared/email/execEmail.ts`, lint the result, and only then hand it to the
transport — with an HTML part carrying the same content and `Reply-To: os@joinwestpeek.com`, so
a reply becomes a routed request like any other. `npm run validate:partner-email` fails the build
if any other service file calls a transport.

**The shape**, enforced by `renderExecEmail` (normalises) and `lintExecEmail` (refuses):

| Part | Rule |
|---|---|
| Subject | `<Employee>: <what it is>`, ≤ 70 characters (longer is cut with an ellipsis) |
| Line 1 | `**TL;DR:**` — one or two sentences: what was done and what, if anything, the partner decides |
| Sections | bold label, bullets under it, no section over 6 lines (the rest is pointed at the details); numbers bolded |
| `— Details —` | the full material, for those who want it; a run of more than 8 lines with no bullet or label is broken up |
| Footer | `— <Employee>, <role>. Reply to this email or write to os@joinwestpeek.com for anything else.` |

A message that fails the lint is not sent; the refusal is an event with the violations.
`tests/execEmail.test.ts` renders every kind the system sends — the reply to a request, Walker's
Productions note and introduction, Parker's Room packet, the morning brief and a research packet
emailed from Home, blog help in each mode — and asserts the lint is clean, then proves the lint
still catches each broken rule.

**Who composes what.** `requestReply.ts` (DONE / BLOCKED replies), `productions.ts` (Walker's
monthly note and introduction), `roomPacket.ts` (Parker's packet), `deliverables.ts` (a partner's
own copy), `blogHelp.ts` (below). Each builds the sections; none touches a transport.

## Blog help is a routed request

A partner emails `os@joinwestpeek.com` from their own address (it must authenticate — see
`src/shared/intake/partnerAuthority.ts`). Porter reads the ask at the door
(`src/shared/intake/blogHelp.ts`, called from `openAssignmentCard`) and, when it is blog help,
marks the card `kind = 'BLOG_HELP'` on that partner's chief of staff — Wren for Sequoia, Walker
for Scooter — with the modes and topic in `work_card.request_json`.

| The partner writes… | Mode | What comes back |
|---|---|---|
| "help me make an **outline** for a blog post on X and do **research**" | OUTLINE | a working title + 3 alternates, the one-sentence thesis, a section-by-section spine (what each proves, the 2–3 facts and URLs it leans on), a suggested opening and closing, 5 research notes with URLs |
| "**write** a blog post on X" / "**draft** the full post" | DRAFT | the full post in the partner's voice, 900–1,400 words unless the ask says "about N words" / "under N words", sources footnoted `[n]` |
| "a **phrase** I can repeat across posts" / "a **tagline**" / "build **authority**" | PHRASE | 5 candidate signature phrases, why each builds authority, how each recurs (opening line, sign-off, header, refrain), one recommendation |

Modes combine ("outline it and then write it"); a blog ask with no clear verb is an OUTLINE.

**The runner** (`src/worker/services/blogHelp.ts`, dispatched by the employee sweep) researches
first through the search model, checks every URL is live, and puts every surviving fact to a
second model that judges it against the brief — the pattern `productions.ts` arrived at. Only
judged URLs may be cited; anything else the writer offers is stripped and counted. The piece is
written with the partner's voice cues (name, profile sectors and themes, what they said about the
last pieces) and West Peek's positioning (`WEST_PEEK_POSITIONING`, read from `docs/COMMUNITY.md`).
The result is a `blog_help` deliverable — on the partner's Home under their chief of staff, filed
to Documents as markdown — and ONE email in the shape above. No source for an OUTLINE or DRAFT
means the card is BLOCKED with the reason and nothing is emailed but the sweep's blocked reply.

Proof: `tests/blogHelp.test.ts` (routing of the three phrasings, each mode with stubbed
search/judge/writer, the deliverable filed, the email sent once) and `e2e/p68-blog-help.spec.ts`
(the real email door, and the deliverable rendering on Home).
