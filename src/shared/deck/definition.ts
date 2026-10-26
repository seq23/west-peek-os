/**
 * The LP deck as DATA, with every figure bound to a record.
 *
 * THIS FILE IS THE DELIVERABLE, not the PDF it produces. All six construction discrepancies found on
 * 9 Sep 2026 exist because the August deck STORED numbers that duplicate what the OS already knows:
 * a table summing to $27M of a $30M fund, $3M of reserves labelled "30% of the fund" when it is 10%,
 * a $6M secondaries sleeve called 30% when it is 20%. A deck that reads the fund row cannot do that.
 *
 * SO THERE ARE NO NUMERIC LITERALS HERE WHERE A RECORD EXISTS. A figure is a `bind` — a key into the
 * snapshot taken at render time — and `tests/deckDefinition.test.ts` fails the build if a bare number
 * appears in a slot that has a binding available. That guard is what makes the discrepancies
 * structurally unrepeatable rather than fixed once.
 *
 * ── THE LENS ─────────────────────────────────────────────────────────────────────────────────
 *
 * Written for an endowment or family-office allocator who reads hundreds of first-time-fund decks a
 * year and is looking for a reason to say no inside ninety seconds. That changes four things:
 *
 * 1. ATTRIBUTION IS THE HARDEST QUESTION FOR A FIRST-TIME FUND and the August deck does not answer
 *    it. Credentials are not track record. The OS holds ZERO positions, so this deck says that in
 *    plain words rather than hoping nobody asks — a first-time fund honest about being one reads
 *    better than one that hopes the question does not come up, and an allocator finds out either way.
 *
 * 2. THE COMMUNITY CLAIM IS THE ENTIRE THESIS AND WAS THE LEAST EVIDENCED THING IN THE DOCUMENT.
 *    "5,000 person community" is a number about the community, not about dealflow. What the OS can
 *    actually compute is the proportion of recorded opportunities that arrived through it — bound
 *    here, WITH its sample size, because a proportion of four is a signal and not a statistic, and
 *    printing it without the denominator would be the same overstatement this deck just fixed.
 *
 * 3. THE CONSTRUCTION DERIVATION IS SHOWN ON THE SLIDE. Allocators check the arithmetic because it
 *    tells them whether the GP has modelled their own fund. $30M, less fees, less expenses, to an
 *    investable base, split 70/30 — every line computed, so it cannot fail to add up.
 *
 * 4. SECONDARIES ARE THE MOST DEFENSIBLE EDGE and read as a footnote in August. A decade of direct
 *    buyer-and-seller work, $100M+ transacted, and a partnership with a FINRA-registered
 *    broker-dealer is the only concrete SOURCING MECHANISM in the document; every other
 *    proprietary-access claim rests on community, which is asserted. It moves to the slide where an
 *    allocator forms the question "how does a $30M first fund get into late-stage secondaries".
 */

/** Keys into the render-time snapshot. A slot naming one of these prints a live figure. */
export type Binding =
  | "fund_size"
  | "fees"
  | "expenses"
  | "investable_base"
  | "early_sleeve_usd"
  | "early_sleeve_pct"
  | "secondary_sleeve_usd"
  | "secondary_sleeve_pct"
  | "reserve_pct"
  | "mgmt_fee_pct"
  | "carry_pct"
  | "reserve_usd"
  | "initial_capital_usd"
  | "target_positions"
  | "check_min"
  | "check_max"
  | "sectors"
  | "community_sourced_share"
  | "positions_held"
  | "as_of_date"
  // Fund I final math (mandate v5, 26 Oct 2026). Every one is a field of the mandate record.
  | "check_typical"
  | "target_ownership_pct"
  | "follow_on_min"
  | "follow_on_max"
  | "follow_on_companies"
  | "secondary_check_min"
  | "secondary_check_max"
  | "secondary_positions"
  | "concentration_cap"
  | "gp_commit_pct"
  | "gp_commit_usd"
  | "target_net_multiple"
  | "mgmt_fee_schedule";

/**
 * Every binding there is, in one list. The Worker's transcription prompt and the figure builder
 * read this rather than keeping their own copy — two lists of the same keys is how one of them
 * falls behind.
 */
export const ALL_BINDINGS: readonly Binding[] = [
  "fund_size", "fees", "expenses", "investable_base", "early_sleeve_usd", "early_sleeve_pct",
  "secondary_sleeve_usd", "secondary_sleeve_pct", "reserve_pct", "mgmt_fee_pct", "carry_pct",
  "reserve_usd", "initial_capital_usd", "target_positions", "check_min", "check_max", "sectors",
  "community_sourced_share", "positions_held", "as_of_date",
  "check_typical", "target_ownership_pct", "follow_on_min", "follow_on_max", "follow_on_companies",
  "secondary_check_min", "secondary_check_max", "secondary_positions", "concentration_cap",
  "gp_commit_pct", "gp_commit_usd", "target_net_multiple", "mgmt_fee_schedule",
];

/**
 * A table cell: prose, a figure bound to a record, or a picture (a company's logo in a table row).
 * A number a record holds is ALWAYS a `bind` cell, never typed into a string cell.
 */
export type TableCell = string | { bind: Binding } | { asset: string; alt: string };

/**
 * One block on a slide. Prose, a figure that comes from a record, and — since the preview-first flow
 * (26 Oct 2026) — the pieces the original Canva deck was made of and the definition could not say:
 * pictures (team photos, logos, the member collage, the flywheel), a row of them with captions, a
 * quote with its speaker, a table, a person with their photo and points, and a sub-heading.
 *
 * PICTURES ARE NAMED, NEVER EMBEDDED. `asset` is a file name in the deck's private asset store
 * (R2 `deck-assets/`); the renderer is handed the bytes at render time. Nothing about a person or a
 * company lives in this public repository — the preview's own slides live in D1.
 */
export type Slot =
  | { kind: "text"; text: string; /** No bullet: a paragraph (the disclaimer, the contact lines). */ plain?: boolean }
  | { kind: "figure"; label: string; bind: Binding }
  | { kind: "derivation"; label: string; bind: Binding; operator?: "minus" | "equals" }
  | { kind: "heading"; text: string }
  | { kind: "image"; asset: string; alt: string; height?: number; round?: boolean; caption?: string }
  | { kind: "images"; items: Array<{ asset: string; alt: string; caption?: string }>; height?: number }
  | { kind: "quote"; text: string; by?: string }
  | { kind: "table"; columns?: string[]; rows: TableCell[][] }
  | { kind: "person"; name: string; photo?: string; points: string[]; logos?: string[] };

export interface Slide {
  key: string;
  /** The claim the slide makes, in the deck's own condensed caps voice. */
  headline: string;
  /** The sentence under it that does the arguing. */
  standfirst?: string;
  slots: Slot[];
  /** Where a non-numeric claim came from, so the next audit does not re-derive provenance. */
  sources?: string[];
  /**
   * How the page is laid out. `standard` (the default) is one column; `split` puts `right` beside
   * `slots`; `panel` sets `aside.text` on a dark panel at the left (the original team page);
   * `photo` sets `aside.asset` full-height at the left (the original member collage).
   */
  layout?: "standard" | "cover" | "split" | "panel" | "photo";
  /** The second column of a `split` page. */
  right?: Slot[];
  /** The left panel of a `panel` or `photo` page. */
  aside?: { text?: string; asset?: string; alt?: string };
}

/** The cover's location line, exactly as the partners wrote it (26 Oct 2026). One copy. */
export const LOCATION_LINE = "New York · San Francisco · Atlanta (and everywhere in between)";

/**
 * The approved lines, quoted rather than paraphrased.
 *
 * All four were already written down in the March two-pager and none of them reached the August
 * deck — while that deck simultaneously inflated a figure the two-pager had right. The deck was
 * never short of material; it could not see what the firm had already produced.
 *
 * `2-pager` = West_Peek_Ventures_FINAL_TIGHT_2PAGE.pdf, March 2026.
 */
const SOURCE_2PAGER = "West Peek Ventures two-pager, March 2026";
const SOURCE_RECORDS = "West Peek OS fund records, live at render time";
const SOURCE_DECK_V2 = "West Peek Ventures Fund I deck, v2, corrected 9 Sep 2026";

export const DECK_SLIDES: readonly Slide[] = [
  {
    key: "cover",
    headline: "COMMUNITY IS THE NEW MOAT.",
    standfirst: LOCATION_LINE,
    slots: [
      { kind: "text", text: "Fund I — Early stage fund" },
      { kind: "figure", label: "As of", bind: "as_of_date" },
      { kind: "text", text: "For Accredited Investors Only" },
    ],
    // The three cities sit under the wordmark in the source, as a locator. For an allocator
    // geography is a sourcing claim: it says the network is not concentrated in one market.
    sources: [SOURCE_2PAGER, SOURCE_DECK_V2],
  },
  {
    key: "positioning",
    headline: "WE ARE NOT ENTERING VENTURE AS CAPITAL ALLOCATORS.",
    /*
     * THE STRONGEST OF THE FOUR APPROVED LINES, AND IT GOES EARLY — where the objection first
     * forms, not buried in the team slide. An allocator's instinctive read of a $30M debut fund is
     * "two people who have not run a fund before"; this concedes that and answers it in one breath.
     *
     * THE EM-DASH STRUCTURE IS THE SENTENCE. "Not X — already Y." Splitting it into two sentences or
     * softening the "not" concedes nothing and persuades nobody.
     */
    standfirst:
      "We are not entering venture as capital allocators — we have already been operating within the " +
      "ecosystem as connectors, operators, and problem-solvers.",
    slots: [
      // The three bullets are the EVIDENCE for "connectors, operators, problem-solvers", which is an
      // assertion on its own. They travel with it.
      { kind: "text", text: "Sourcing opportunities through trusted relationships" },
      { kind: "text", text: "Supporting founders beyond capital" },
      { kind: "text", text: "Activating a high-signal community to drive outcomes" },
    ],
    sources: [SOURCE_2PAGER],
  },
  {
    key: "thesis",
    headline: "WE BACK FOUNDERS IN SECTORS THAT BENEFIT FROM THE POWER OF COMMUNITY.",
    /*
     * AI SITS ODDLY INSIDE A COMMUNITY ARGUMENT UNLESS THE COPY EARNS IT, and the deck's own earlier
     * slide supplies the connective tissue: AI makes trust scarcer. So AI is not an exception to the
     * thesis, it is the reason the thesis holds. Five sectors read as an argument rather than a
     * longer list.
     *
     * The list itself is BOUND, not typed — deck p4 and the Terms page disagreed for three weeks
     * because each held its own copy.
     */
    standfirst:
      "As AI makes trust scarcer, the communities that vouch for founders become the scarce asset. " +
      "We invest where that is true.",
    slots: [{ kind: "figure", label: "Sector focus", bind: "sectors" }],
    sources: [SOURCE_RECORDS],
  },
  {
    key: "sourcing",
    headline: "HOW DEALS REACH US: THROUGH PEOPLE WE KNOW.",
    /*
     * HOW DEALS REACH US, PROVEN WITH STRONG TRUE POINTS (owner, 26 Oct 2026). The earlier version
     * printed "2 of 8 opportunities sourced through the community" — a small ratio that undersold
     * the one claim the whole thesis rests on, and the records behind it were mislabelled (a website
     * email counted as a deal, warm intros filed as cold inbound). No small count or ratio goes on
     * this page; the guard is tests/deckDefinition.test.ts.
     */
    standfirst:
      "Every company we've looked at reached us through someone in our community: no cold " +
      "outreach, no paid deal flow.",
    slots: [
      { kind: "text", text: "A community of 5,000+ founders, operators and investors, built during the pandemic" },
      { kind: "text", text: "Rooms evenings, where members meet the founders worth knowing, in person" },
      { kind: "text", text: "Member intros: the people who know a founder best bring them to us" },
      { kind: "text", text: "Founders who come to us before they raise, not after the round is set" },
      { kind: "text", text: "The same relationships behind more than $100M in secondary transactions" },
    ],
    sources: [SOURCE_2PAGER, "Partners' account of every deal the firm has looked at, 26 Oct 2026"],
  },
  {
    key: "secondaries",
    headline: "EARLY-STAGE RETURNS WITH LATE-STAGE LIQUIDITY.",
    /*
     * THE MECHANISM, ON THE SLIDE WHERE THE QUESTION IS RAISED. An allocator reading "30% Series B/C
     * secondaries" from a $30M first-time fund asks exactly one thing: how do you get access at all.
     * This is the answer, and it is the only concrete sourcing mechanism in the document — every
     * other proprietary-access claim rests on community, which is asserted.
     *
     * QUOTED AT THE SOURCE'S LEVEL. "relationships and partnerships with" — not that West Peek IS a
     * broker-dealer, not exclusive, not a formal agreement, and no broker-dealer is named. An
     * allocator who reads more into it than the facts support finds that out in diligence, which is
     * a worse outcome than a plainer sentence.
     */
    standfirst:
      "We have spent over a decade working directly with buyers and sellers in the secondary " +
      "market and have facilitated more than $100M in secondary transactions. Through these " +
      "relationships and partnerships with a FINRA-registered broker-dealer, we are able to access " +
      "curated secondary opportunities alongside primary investments.",
    slots: [
      { kind: "figure", label: "Early stage", bind: "early_sleeve_pct" },
      { kind: "figure", label: "Secondaries", bind: "secondary_sleeve_pct" },
      { kind: "figure", label: "Secondary positions", bind: "secondary_positions" },
      { kind: "figure", label: "Secondary check from", bind: "secondary_check_min" },
      { kind: "figure", label: "up to", bind: "secondary_check_max" },
      { kind: "text", text: "Larger blocks go to our LP relationships as co-investment" },
    ],
    sources: [SOURCE_2PAGER],
  },
  {
    key: "construction",
    headline: "THE FUND, FROM COMMITTED CAPITAL TO CHECKS.",
    /*
     * SHOWN AS A DERIVATION, NOT A TABLE OF RESULTS. An allocator checks this arithmetic because it
     * tells them whether the GP has modelled their own fund — and the August table did not add up,
     * which is the impression this replaces. Every line is computed at render time, so it cannot
     * fail to sum and cannot drift from the OS.
     */
    standfirst:
      "A fund does not deploy its whole commitment. Fees and expenses come off the top; what is " +
      "left is what buys ownership.",
    slots: [
      { kind: "derivation", label: "Committed", bind: "fund_size" },
      { kind: "derivation", label: "Management fees", bind: "fees", operator: "minus" },
      { kind: "derivation", label: "Fund expenses", bind: "expenses", operator: "minus" },
      { kind: "derivation", label: "Investable capital", bind: "investable_base", operator: "equals" },
      { kind: "figure", label: "Early stage", bind: "early_sleeve_usd" },
      { kind: "figure", label: "Secondaries", bind: "secondary_sleeve_usd" },
      { kind: "figure", label: "Held in reserve for follow-ons", bind: "reserve_usd" },
      { kind: "derivation", label: "For first checks", bind: "initial_capital_usd", operator: "equals" },
    ],
    sources: [SOURCE_RECORDS],
  },
  {
    key: "portfolio",
    // NO COUNT IN THE HEADLINE. "TWENTY-FIVE COMPANIES" was typed here and outlived the record
    // that said 25; the count is a figure, so it is bound below and the headline makes the claim.
    headline: "A PORTFOLIO SIZED TO THE CAPITAL THAT EXISTS.",
    standfirst:
      "Reserves are how ownership survives the Series A. The count and the check are set against " +
      "what is left after them, not against the fund size.",
    slots: [
      { kind: "figure", label: "Companies, first checks", bind: "target_positions" },
      { kind: "figure", label: "Typical first check", bind: "check_typical" },
      { kind: "figure", label: "First check from", bind: "check_min" },
      { kind: "figure", label: "up to", bind: "check_max" },
      { kind: "figure", label: "Follow-on companies", bind: "follow_on_companies" },
      { kind: "figure", label: "Follow-on check from", bind: "follow_on_min" },
      { kind: "figure", label: "up to", bind: "follow_on_max" },
      { kind: "figure", label: "Reserved from the early-stage sleeve", bind: "reserve_pct" },
      { kind: "figure", label: "Most in any one company", bind: "concentration_cap" },
      { kind: "figure", label: "Target ownership", bind: "target_ownership_pct" },
    ],
    sources: [SOURCE_RECORDS],
  },
  {
    key: "track_record",
    headline: "WHAT WE HAVE DONE, AND WHAT WE HAVE NOT.",
    /*
     * THE SLIDE THE AUGUST DECK DID NOT HAVE, and the one an allocator is looking for.
     *
     * Attribution is the hardest question for a first-time fund. Credentials — transactions
     * facilitated, capital raised for others — are not track record, and an allocator knows the
     * difference in ten seconds. The position count is BOUND, so this slide cannot overstate: if the
     * fund has made no investments it says so, and when it has made some it says how many without
     * anybody rewriting the slide.
     *
     * A first-time fund honest about being one reads better than one hoping nobody notices, and the
     * honesty buys the right to lead with the sourcing edge instead.
     */
    standfirst:
      "This is a first fund. We are not going to present transaction volume as though it were " +
      "portfolio performance.",
    slots: [
      { kind: "figure", label: "Positions held to date", bind: "positions_held" },
      { kind: "text", text: "More than $100M in secondary transactions facilitated — deal experience, not fund returns" },
      { kind: "text", text: "What to judge us on today: what we see, how early we see it, and who lets us in" },
    ],
    sources: [SOURCE_RECORDS, SOURCE_2PAGER],
  },
  {
    key: "team",
    headline: "22+ YEARS OF COMBINED ECOSYSTEM PROXIMITY.",
    /*
     * "COMBINED" IS LOAD-BEARING — 22+ years across two people, not each — and "proximity" and
     * "operating in and around" are deliberate hedges in the source. They are honest ones, and
     * upgrading them to "investing" would be the same failure as $500M in a new place. Duration is
     * one of the few honest answers available to a first-time fund before there is a track record,
     * and it must read as ecosystem TIME rather than as prior fund management.
     */
    standfirst:
      "We have spent over two decades operating in and around Silicon Valley and venture-backed " +
      "ecosystems, building trusted relationships across founders, investors, and intermediaries.",
    slots: [
      { kind: "text", text: "A brother-and-sister partnership: company building, and investment banking" },
      { kind: "text", text: LOCATION_LINE },
    ],
    sources: [SOURCE_2PAGER],
  },
  {
    key: "terms",
    headline: "FUND I TERMS.",
    slots: [
      { kind: "figure", label: "Fund size", bind: "fund_size" },
      { kind: "text", text: "Delaware Limited Partnership" },
      { kind: "text", text: "10-year fund life, plus two one-year extensions" },
      { kind: "text", text: "4-year investment period" },
      { kind: "text", text: "United States" },
      { kind: "figure", label: "Management fee", bind: "mgmt_fee_schedule" },
      { kind: "figure", label: "Carried interest", bind: "carry_pct" },
      { kind: "figure", label: "GP commitment", bind: "gp_commit_pct" },
      { kind: "figure", label: "GP commitment, in dollars", bind: "gp_commit_usd" },
      { kind: "figure", label: "Target net multiple to LPs", bind: "target_net_multiple" },
      { kind: "figure", label: "Sector focus", bind: "sectors" },
      { kind: "text", text: "SPVs offered pro rata to LPs at a 1/10 fee; direct co-investment shared with LPs" },
    ],
    sources: [SOURCE_DECK_V2, SOURCE_RECORDS],
  },
];

/**
 * Bindings whose value is money, so the renderer formats them one way and only one way.
 *
 * Two ways of writing the same figure on one document is the smaller cousin of the bug this deck
 * exists to have fixed.
 */
export const MONEY_BINDINGS: ReadonlySet<Binding> = new Set<Binding>([
  "fund_size", "fees", "expenses", "investable_base", "early_sleeve_usd",
  "secondary_sleeve_usd", "reserve_usd", "initial_capital_usd", "check_min", "check_max",
  "check_typical", "follow_on_min", "follow_on_max", "secondary_check_min", "secondary_check_max",
  "concentration_cap", "gp_commit_usd",
]);

export const PERCENT_BINDINGS: ReadonlySet<Binding> = new Set<Binding>([
  "early_sleeve_pct", "secondary_sleeve_pct", "reserve_pct", "mgmt_fee_pct", "carry_pct",
  "target_ownership_pct", "gp_commit_pct",
]);

/** Every binding the definition actually uses. The validator counts these; zero means it saw nothing. */
export function bindingsUsed(slides: readonly Slide[] = DECK_SLIDES): Binding[] {
  const out: Binding[] = [];
  for (const slide of slides) {
    for (const slot of [...slide.slots, ...(slide.right ?? [])]) {
      if (slot.kind === "figure" || slot.kind === "derivation") out.push(slot.bind);
      if (slot.kind === "table") {
        for (const row of slot.rows) for (const cell of row) if (typeof cell === "object" && "bind" in cell) out.push(cell.bind);
      }
    }
  }
  return out;
}
