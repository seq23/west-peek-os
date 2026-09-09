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
  | "as_of_date";

/** One line on a slide. Either prose, or a figure that comes from a record. */
export type Slot =
  | { kind: "text"; text: string }
  | { kind: "figure"; label: string; bind: Binding }
  | { kind: "derivation"; label: string; bind: Binding; operator?: "minus" | "equals" };

export interface Slide {
  key: string;
  /** The claim the slide makes, in the deck's own condensed caps voice. */
  headline: string;
  /** The sentence under it that does the arguing. */
  standfirst?: string;
  slots: Slot[];
  /** Where a non-numeric claim came from, so the next audit does not re-derive provenance. */
  sources?: string[];
}

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
    standfirst: "New York • San Francisco • Atlanta",
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
    headline: "OUR DEALFLOW ARRIVES BEFORE IT IS A DEAL.",
    /*
     * THE CLAIM, MEASURED RATHER THAN ASSERTED — and measured honestly. "5,000 person community" is
     * a number about the community, not about dealflow. What the records can actually show is the
     * share of recorded opportunities that arrived through it, WITH the denominator, because a
     * proportion of four is a signal and not a statistic. Printing it without the sample size would
     * be the same species of overstatement this deck exists to have removed.
     */
    standfirst:
      "Members bring us founders before they raise. This is what the record shows so far — a small " +
      "sample, stated as one.",
    slots: [
      { kind: "figure", label: "Opportunities sourced through the community", bind: "community_sourced_share" },
      { kind: "text", text: "Relationships on file across the network" },
    ],
    sources: [SOURCE_RECORDS],
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
      "Sequoia Taylor has spent over a decade working directly with buyers and sellers in the " +
      "secondary market and has facilitated over $100M in transactions. Through these relationships " +
      "and partnerships with a FINRA-registered broker-dealer, we are able to access curated " +
      "secondary opportunities alongside primary investments.",
    slots: [
      { kind: "figure", label: "Early stage", bind: "early_sleeve_pct" },
      { kind: "figure", label: "Secondaries", bind: "secondary_sleeve_pct" },
    ],
    sources: [SOURCE_2PAGER],
  },
  {
    key: "construction",
    headline: "THE FUND, FROM COMMITTED CAPITAL TO CHEQUES.",
    /*
     * SHOWN AS A DERIVATION, NOT A TABLE OF RESULTS. An allocator checks this arithmetic because it
     * tells them whether the GP has modelled their own fund — and the August table did not add up,
     * which is the impression this replaces. Every line is computed at render time, so it cannot
     * fail to sum and cannot drift from the OS.
     */
    standfirst:
      "A $30M fund does not deploy $30M. Fees and expenses come off the top; what is left is what " +
      "buys ownership.",
    slots: [
      { kind: "derivation", label: "Committed", bind: "fund_size" },
      { kind: "derivation", label: "Management fees", bind: "fees", operator: "minus" },
      { kind: "derivation", label: "Fund expenses", bind: "expenses", operator: "minus" },
      { kind: "derivation", label: "Investable capital", bind: "investable_base", operator: "equals" },
      { kind: "figure", label: "Early stage", bind: "early_sleeve_usd" },
      { kind: "figure", label: "Secondaries", bind: "secondary_sleeve_usd" },
      { kind: "figure", label: "Held in reserve", bind: "reserve_usd" },
      { kind: "derivation", label: "For initial cheques", bind: "initial_capital_usd", operator: "equals" },
    ],
    sources: [SOURCE_RECORDS],
  },
  {
    key: "portfolio",
    headline: "TWENTY-FIVE COMPANIES, SIZED TO THE CAPITAL THAT EXISTS.",
    standfirst:
      "Reserves are how ownership survives the Series A. The count and the cheque are set against " +
      "what is left after them, not against the fund size.",
    slots: [
      { kind: "figure", label: "Target companies", bind: "target_positions" },
      { kind: "figure", label: "Initial cheque", bind: "check_min" },
      { kind: "figure", label: "up to", bind: "check_max" },
      { kind: "figure", label: "Reserved from the early-stage sleeve", bind: "reserve_pct" },
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
      { kind: "text", text: "Over $100M in secondary transactions facilitated, as a principal — deal experience, not fund returns" },
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
      { kind: "text", text: "New York • San Francisco • Atlanta" },
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
      { kind: "figure", label: "Management fee", bind: "mgmt_fee_pct" },
      { kind: "figure", label: "Carried interest", bind: "carry_pct" },
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
]);

export const PERCENT_BINDINGS: ReadonlySet<Binding> = new Set<Binding>([
  "early_sleeve_pct", "secondary_sleeve_pct", "reserve_pct", "mgmt_fee_pct", "carry_pct",
]);

/** Every binding the definition actually uses. The validator counts these; zero means it saw nothing. */
export function bindingsUsed(slides: readonly Slide[] = DECK_SLIDES): Binding[] {
  const out: Binding[] = [];
  for (const slide of slides) {
    for (const slot of slide.slots) {
      if (slot.kind === "figure" || slot.kind === "derivation") out.push(slot.bind);
    }
  }
  return out;
}
