# Executive Intelligence Report — the specification

**Status: this is the specification the daily brief is built to, not a note beside it.**
`tests/briefSpecification.test.ts` reads THIS FILE and fails the build if the generator and this
document disagree — so a section added here without a section added to
`src/shared/intelligence/reportSchema.ts` breaks the build, and so does the reverse. A specification
nothing reads is the same void that swallowed an instruction to an employee; this one is read.

Written from the example the operator supplied on 15 Sep 2026 and kept in her words below.
Implemented by prompt version `daily-intelligence-v5` and carried forward by `v6`, which adds only
the per-partner lens. Verified at generation time by `verifyBrief`; a brief that fails is recorded
FAILED with its problems, never delivered thin.

---

## The specification, in the operator's words

Executive Intelligence Report — example the operator wants ours to match or beat
(astrology/spiritual sections deliberately EXCLUDED)

Sections, in order:
1. One-Minute Executive Summary — 5 numbered points; the key figure in bold; a numbered source per point.
2. Top 5 Headlines — each: the headline, the figures called out large, a "Why it matters" paragraph written for an investor, and "Investor Importance: x/10".
3. Markets & Macro Dashboard — table: 10-Year Treasury, Brent, WTI, Fed hike/cut probability, S&P futures, Nasdaq futures, Dollar, Bitcoin; then a "Current Regime" strip (Equities / Treasuries / Oil / Fed / AI fundamentals / AI valuations / IPO market / PE fundraising / Secondaries each 🟢🟡🔴); then "the most important number on the board today".
4. Capital Markets / M&A / Funding — 2–3 items with a "Read-through".
5. VC / Private Markets / Secondaries — 3–4 numbered theses with a West Peek read-through ("for an emerging manager…", "for secondaries…").
6. Government / Legal / Supreme Court — 1–2 items with "Why it matters".
7. AI & Technology — 1–2 items.
8. (A named-company watch section — the operator's example tracks SpaceX; ours should track the firm's watchlist entries instead.)
9. Investor Insight — one thesis, argued.
10. Key Events Today — what to watch, with the numbers that matter.
11. One Thing to Watch — closing.
Footer: numbered citations [n]: URL "title".

Voice: short paragraphs, one idea per line, numbers stated once and big, no hedging filler, every
claim cited, never invent a live number — if a live figure could not be fetched, say so ("I do not
have a reliable print, so I am not going to invent one").

---

## The same eleven sections, as the code names them

The test reads this table. The left column is the section above; the right is the `key` in
`REPORT_SECTIONS`, and the order of the rows is the order the report is written and rendered in.

| # | Section | Section key |
|---|---|---|
| 1 | One-Minute Executive Summary | `executive_summary` |
| 2 | Top 5 Headlines | `top_headlines` |
| 3 | Markets & Macro Dashboard | `markets_macro` |
| 4 | Capital Markets / M&A / Funding | `capital_markets` |
| 5 | VC / Private Markets / Secondaries | `venture_private` |
| 6 | Government / Legal / Supreme Court | `government_legal` |
| 7 | AI & Technology | `ai_technology` |
| 8 | Named-company watch — the firm's watchlist | `watchlist` |
| 9 | Investor Insight | `investor_insight` |
| 10 | Key Events Today | `key_events` |
| 11 | One Thing to Watch | `watch` |

The footer (`citations`) is written by the system, never by the model, and is therefore not in the
list of sections the model is required to produce.

## The dashboard rows, exactly

`10-year Treasury`, `Brent`, `WTI`, `Fed cut/hike probability`, `S&P 500`, `Nasdaq`, `US dollar`,
`Bitcoin`. The test asserts each of these appears in the synthesis prompt.

## The regime strip, exactly

`Equities`, `Treasuries`, `Oil`, `Fed`, `AI fundamentals`, `AI valuations`, `IPO market`,
`PE fundraising`, `Secondaries` — each one of three tones: `GREEN`, `YELLOW`, `RED`.

## Why the strip is words in the record and lights on the page

The operator's example draws 🟢 🟡 🔴, and so does ours — but the emoji is a RENDERING, not the
stored text. This file's own first rule is that generation produces data and presentation renders
it: the model writes "Equities: YELLOW — earnings strong, discount-rate pressure rising", and the
daily brief panel turns that line into the coloured status. An emoji in the stored record would
bake one surface's decision into the report, and the same report has to become a web page, a push
notification and an email. The tone vocabulary above is therefore exact, and the test asserts both
that the prompt asks for those three words and that the panel can read each of them.

## What is deliberately excluded, and how the exclusion is enforced

The operator's example carried astrology and spiritual sections and she cut them by name. The
exclusion is **structural rather than a line in a prompt**: `REPORT_SECTIONS` is a closed list and
`parseReport` DROPS any section key it does not know, so a model that decides to add a horoscope
produces a section that is discarded before anything is stored. There is nothing to ask it not to
do, which is the strongest form this rule can take.

The same closure is why section 8 is the firm's watchlist and not SpaceX: the packet carries
`watchlist_entries` from the firm's own records, and the prompt tells the model to write one line
saying the firm has no watchlist entries when there are none, rather than choosing a company.

## The rule that matters most

**Never invent a live number.** Enforced in three places, not one:

- the prompt names every figure that could NOT be fetched, by name and with its reason, and gives
  the model the sentence to use ("I do not have a reliable print for X this morning…");
- `verifyReport` flags `invented_market_figure` — a market level in the prose that the packet never
  supplied;
- `verifyBrief` flags `invented_url` — any URL the model typed rather than citing by `[n]`.

Citations cannot be invented by construction: the model cites `[n]`, and the system resolves `n`
against the sources it supplied itself.

## What the generator must not lose

`verifyBrief` fails a brief for any of: a missing required section, a section under 40 characters,
a section with no `[n]` citation (the watchlist is excused only when the firm has no entries), a
citation resolving to nothing, a typed URL, or fewer than five `Investor Importance: n/10` scores
on the headlines.
