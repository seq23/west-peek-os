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

## A web property change is a routed request worked on her Mac (Plan A, 20 Sep 2026)

A partner emails `os@joinwestpeek.com` naming one of the firm's web properties — **the email is
the specification** (Porter reads the partner's own words; quoted replies and signatures are
stripped) and everything else is an asset it may reference: files attached to the email (kept by
name, listed under ATTACHMENTS: on the Mac), a **Google Drive folder link** written in the partner's
own text (never one in a quoted thread), links to pages. "Swap the founders photo for the one
attached" is a whole request; so is "change the tagline to X". Porter can fetch a public page or
image by URL when the request says so (source recorded; rights are an ASK unless the asset is the
partners' own or a featured company's own; a login-only page is a BLOCK).

What the partner hears, at most once each: **RECEIVED** at intake ("Got it — I'm on it", what was
understood, what comes next), the **PLAN** only when a decision is theirs (or the **PREVIEW** on
the not-ready path), a **QUESTION** only when something only they can supply is missing, **STUCK**
only when the work cannot proceed or has sat idle past the ceiling (45 min inside 06–22 Central),
and **DONE** with the proof. A change with nothing to ask is built without asking.

A partner emails `os@joinwestpeek.com` a **Google Drive folder link** and names one of the firm's
web properties — `westpeek.ventures`, `westpeekproductions.com` or `joinwestpeek.com` (or "the
ventures site", "the productions site", "the community site"). Porter reads it at the door
(`src/shared/intake/webPropertyChange.ts`, called from `openAssignmentCard`): every Drive folder
link on a partner's email is recorded on the card (`work_card.request_json`), and with a property
named the chief of staff hands the card to **Porter** at once, `kind = 'WEB_PROPERTY_CHANGE'`,
with the folder, the property and the repo on `web_property_change`. A folder with no property
named stays an ordinary assignment with the link kept.

The email to try it, from scooter@ or sequoia@:

> **Subject:** ventures site update
> Please update the westpeek.ventures site with the package here:
> https://drive.google.com/drive/folders/&lt;folder-id&gt;
> New team page, the portfolio logos in the folder, and the thesis copy in the doc.

What happens, phase by phase — each a fresh Claude Code context on her Mac, claimed by the
local-job claimer (`deployment/launchd/README.md`):

| Phase | Model | What comes back to the partner |
|---|---|---|
| **PLAN** | opus | the plan as a Document on the card AND **in full in the email** to the partner who asked, above the decisions that are theirs (brand or colourway, copy meaning, legal or regulatory wording, removing a public claim, image rights, money) — each a numbered question **with Porter's recommended default**. Structure, CSS, validators, redirects, assets and build wiring are decided and recorded. **Reply with one word: `approved`** (also `approve`, `yes`, `go`, `land it`) and every ask takes its recommendation. A reply starting `no`, `not approved`, `stop` or `changes:` HOLDS the card with the text recorded. Any other text is read as the answers. Only the partner who asked can approve their own card; the other partner's reply is kept as a note. |
| **BUILD** | sonnet | the change in a git worktree of the target repo, its validators green, screenshots at desktop and 390px, every new link curled, a PR opened. The script — not the model — reads `gh pr checks`. Nothing is emailed. |
| **LAND** | haiku | with **land on green** ON (her rule), the PR is landed with `~/bin/land` as soon as its checks are green, proven live with curl, and ONE email says done with the PR and the proof. With it OFF, the card asks "land it?" first. |

**When the plan is not publish-ready** (it would ship placeholders — a missing link, logo, record
or colour value — Porter says so at the top of the plan email and names each gap), `approved` means
BUILD → PR → the Cloudflare Pages **preview link** → a second email with the preview, the PR, the
placeholders and the proof → the card asks again: reply **`approved`** a second time to land, or
`changes: …` to hold. Land-on-green applies only to a publish-ready plan. On a ready plan, reply
**`preview`** instead of `approved` to take the same road. **The named bypass:** reply
**`approved to production`** (also `force production`, `ship it anyway`, `land anyway`) — on the
plan or on the preview email — and a not-ready plan lands on green with its placeholders; the card
records who forced it and which placeholders shipped, and the DONE email says so at the top, to
BOTH partners. Plain `approved` never forces. Only the partner who asked can approve, preview or
force their own card.

**Pre-approval in the request.** Write **`your call`** (also `you decide`, `no need to ask`,
`just do it`, `pick everything`, `no options`) in the request itself and Porter decides everything
— every recommendation becomes the decision, no options are offered; the plan is approved as filed
in your name, the email is an FYI ("no reply needed; reply `stop` to hold it"), and BUILD starts at
once. A plan that is not publish-ready still stops at the preview unless the same request also says
`approved to production`, in which case it lands, named as forced by you. `stop`, `no` or
`changes: …` from you at any point before landing holds the card. The phrase counts only in your
own authenticated request text — never a quoted line, never a later message, never the other partner.

The rules of the kind are rows on the Work page (land on green, the model per phase, one live run
per card, never iterate in production when a pass emails the partners); a Managing Partner flips
the editable ones there. Nothing lands without a recorded plan approval and a recorded green check
(`validate:no-land-without-approval`), and a card of this kind cannot go DONE without a PR link, a
green check and a merge (migration 0219).
