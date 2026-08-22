import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The shape of the deal record — what appears once a company is picked on Dealflow.
 *
 * Operator, 22 Aug 2026: "the deal flow tab is still not good enough UI and UX wise. you need to
 * fix it once we pick a company and all the stuff comes out." And before that, on the same page:
 *
 *   · "there should be 1 deal record for every company with all fields in it — price per share and
 *      # of shares should be in the deal record and it should open once u select a company"
 *   · "what the firm knows about them / its deals — these sections need to be rethought and figure
 *      out how to make this easy to work through"
 *   · "i dont underestand why it cant be simple like the lp page. everything is there and its easy
 *      to follow"
 *   · "yes and the add a second deal to this company part can be neested i guess"
 *   · "the entire deal flow page needs to be done over again and its not easy to follow and things
 *      are hidden that shouldnt be and the last section is incomplete and not consistent in size
 *      heading"
 *
 * Every assertion below is one of those sentences turned into something that fails. Structural
 * checks on the source in the manner of `tests/accessibility.test.ts` and
 * `tests/adminPagesLayout.test.ts`: cheap, and they fail for the right reason.
 *
 * WHAT WAS ACTUALLY WRONG, so the next person does not undo it by accident. Picking a company on
 * the pipeline navigated away to the company register. The record lived in a SECOND component on
 * the same route whose first control was another company picker, then a list of deals, then a
 * click to pick one of those. Price per share and the number of shares appeared on no surface at
 * all — the only route to either was the transaction ladder, which books a position and is a
 * different act from recording what a round is priced at. The company's own 360 was rendered
 * twice, once openly and once inside a `<details>` reading "Everything else on record for this
 * company". This file exists so none of that can come back quietly.
 */

const CLIENT = new URL("../src/client/", import.meta.url).pathname;

/**
 * Comments blanked to whitespace of the same length, so byte offsets still line up while prose
 * cannot be read as code.
 *
 * This is not a nicety. Every one of these files documents the defect it fixed in its own header,
 * quoting the markup that was wrong — `<details>`, `className="panel"`, `<code>`. A scan that reads
 * a comment as an element reports the explanation as the offence, which is the fastest way to teach
 * somebody to delete the explanation.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

const DEALFLOW_RAW = readFileSync(`${CLIENT}pages/DealflowPage.tsx`, "utf8");
const PROVENANCE_RAW = readFileSync(`${CLIENT}pages/DealProvenance.tsx`, "utf8");
const RECORD_INVESTMENT_RAW = readFileSync(`${CLIENT}pages/RecordInvestment.tsx`, "utf8");

const DEALFLOW = code(DEALFLOW_RAW);
const PROVENANCE = code(PROVENANCE_RAW);
const RECORD_INVESTMENT = code(RECORD_INVESTMENT_RAW);

const FILES = [
  ["DealflowPage", DEALFLOW],
  ["DealProvenance", PROVENANCE],
  ["RecordInvestment", RECORD_INVESTMENT],
] as const;

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...src.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each h3, in order. Skips any whose text is an expression. */
function sections(src: string): string[] {
  return [...src.matchAll(/<h3>([^<{]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

/** Every .tsx under src/client, for the rules that hold everywhere rather than on three files. */
function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(CLIENT);
  return out;
}

/**
 * The source of one section: from its wrapper's test id to the next section heading.
 *
 * Sections are siblings in a flat sequence rather than nested elements, so "inside this section"
 * is a range in the file rather than a subtree — which is exactly the property being asserted.
 */
function sectionSource(src: string, testId: string): string {
  const at = src.indexOf(`data-testid="${testId}"`);
  expect(at, `no section carries data-testid="${testId}"`).toBeGreaterThan(-1);
  const nextHeading = src.indexOf("<h3>", at);
  return src.slice(at, nextHeading === -1 ? src.length : nextHeading);
}

describe("the deal record keeps the ranks the shell expects", () => {
  it("uses only h3 for a section and h4 for a thing inside one", () => {
    // The shell renders the page title as an h2. A section is therefore an h3 and a thing inside a
    // section is an h4; nothing goes deeper, because there is nothing deeper to navigate to.
    for (const [name, src] of FILES) {
      expect(ranks(src).filter((r) => r < 3 || r > 4), `${name} uses a rank outside h3/h4`).toEqual([]);
    }
  });

  it("has no h5 anywhere in the client", () => {
    // Not only on these three files: an h5 on any page is a fourth level in a product with three,
    // and it arrives the moment somebody nests one section inside another.
    const offenders = clientFiles().filter((f) => /<h5[ >]/.test(code(readFileSync(f, "utf8"))));
    expect(offenders.map((f) => f.split("/client/")[1])).toEqual([]);
  });

  it("does not restate the page title the shell already printed", () => {
    expect(sections(DEALFLOW)).not.toContain("Dealflow");
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet rules an h3 that follows something. A hand-placed <hr> is a second line.
    for (const [name, src] of FILES) {
      expect(src.includes("<hr"), `${name} hand-places a rule`).toBe(false);
    }
  });
});

describe("the record is the sequence of questions a partner actually asks", () => {
  /**
   * The order is the argument. Where does it stand, what are the terms, what do we know and how,
   * what is unanswered, what has the committee said, what has happened to it — and only then the
   * rare act of adding a second deal. Any other order asks the reader to hold something in their
   * head that the page could have told them first.
   */
  const EXPECTED = [
    "Where this stands",
    "The deal itself",
    "What we know, and how we know it",
    "What is still open",
    "Where this deal stands with the committee",
    "Its history",
    "Add a second deal to this company",
  ];

  it("opens the record with those seven sections, in that order", () => {
    expect(sections(DEALFLOW).slice(0, EXPECTED.length)).toEqual(EXPECTED);
  });

  it("still leads the page itself with the funnel and the pipeline", () => {
    const all = sections(DEALFLOW);
    expect(all).toContain("Top of the funnel");
    expect(all).toContain("The pipeline");
    // They come after the record's own sections in the file because the record is defined above
    // the page component; what matters is that both are present as real sections.
    expect(all.indexOf("The pipeline")).toBeGreaterThan(all.indexOf("Top of the funnel"));
  });

  it("leaves the committee section for the meetings side to fill, and says so", () => {
    const committee = sectionSource(DEALFLOW, "deal-committee");
    expect(committee).toContain("state-empty");
    // A placeholder that does not say it is one reads as a broken section.
    expect(DEALFLOW_RAW).toMatch(/PLACEHOLDER, AND NOT MINE TO FILL/);
  });
});

describe("nothing on the record is reachable only by opening something", () => {
  it("nests exactly one thing, and it is the second deal", () => {
    // Operator: "yes and the add a second deal to this company part can be neested i guess." One
    // disclosure, for the rare act. Everything that is work is open.
    const disclosures = [...DEALFLOW.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain('data-testid="deal-second-details"');
  });

  it("hides nothing at all on the two panels the record embeds", () => {
    expect(RECORD_INVESTMENT).not.toContain("<details");
    expect(PROVENANCE).not.toContain("<details");
  });

  it("puts price per share and the number of shares on the record, in the open", () => {
    // The operator's most literal instruction: "price per share and # of shares should be in the
    // deal record". They must be in the terms section, which is above the only disclosure.
    const terms = sectionSource(DEALFLOW, "deal-terms");
    expect(terms).toContain("Price per share");
    expect(terms).toContain("Number of shares");
    expect(terms).toContain('data-testid="deal-terms-price"');
    expect(terms).toContain('data-testid="deal-terms-quantity"');
    expect(DEALFLOW.indexOf('data-testid="deal-terms-price"')).toBeLessThan(DEALFLOW.indexOf("<details"));
  });

  it("does not render the company 360 twice, or at all", () => {
    // It was on the page openly AND inside a disclosure headed "Everything else on record for this
    // company" — the same facts, twice, one of them hidden. What the firm knows is now a section.
    expect(DEALFLOW).not.toContain("Company360");
    expect(DEALFLOW).not.toContain("Everything else on record");
  });
});

describe("every section states its own emptiness rather than disappearing", () => {
  /**
   * A section that vanishes when it holds nothing teaches a reader that the page is unreliable
   * rather than that the fact is absent. Each one says what is missing and what would fill it.
   */
  for (const id of ["deal-terms", "deal-knowledge", "deal-open-questions", "deal-committee", "deal-history"]) {
    it(`${id} carries an empty state`, () => {
      expect(sectionSource(DEALFLOW, id)).toContain("state-empty");
    });
  }

  it("says why the record itself is closed, rather than showing a gap", () => {
    expect(DEALFLOW).toContain('data-testid="deal-record-closed"');
  });

  it("finishes the provenance section instead of stopping mid-air", () => {
    // "the last section is incomplete." With every deal already carrying an origin the page simply
    // stopped after the table, and while loading it replaced its own heading with the word
    // "Loading…" — so the page's last section could vanish entirely.
    expect(PROVENANCE).toContain('data-testid="provenance-complete"');
    expect(PROVENANCE).toMatch(/<h3>Where deals come from<\/h3>/);
    // The heading is drawn before the state, never instead of it.
    expect(PROVENANCE.indexOf("<h3>Where deals come from</h3>")).toBeLessThan(PROVENANCE.indexOf("state.loading &&"));
  });

  it("gives the provenance section the same card treatment as every other section", () => {
    // It used to render `<section className="panel">`, and the stylesheet has no `.panel` rule —
    // so the page's last section drew no card while every section above it did. That is the whole
    // of "not consistent in size heading".
    expect(PROVENANCE).not.toContain('className="panel"');
    expect(PROVENANCE).toContain('<section className="card"');
  });
});

describe("no stored value reaches the screen", () => {
  it("prints no identifier or enum in a code element", () => {
    for (const [name, src] of FILES) {
      expect(src.includes("<code"), `${name} prints a raw value in a <code>`).toBe(false);
    }
  });

  it("translates every enum it touches rather than sentence-casing it in place", () => {
    // Sentence-casing a stored value produces a second vocabulary that drifts from the first. The
    // pipeline registry owns the words for a stage, a deal type and an origin, and this page reads
    // them from it.
    expect(DEALFLOW).toMatch(/dealTypeLabel/);
    expect(DEALFLOW).toMatch(/originLabel/);
    expect(PROVENANCE).toMatch(/import \{ originLabel \} from "@shared\/investment\/pipeline"/);
    for (const raw of ["EARLY_STAGE_PRIMARY", "PENDING_APPROVAL", "IC_READY"]) {
      // Allowed as a key in a lookup or a comparison; never as the thing between two JSX tags.
      expect(DEALFLOW.includes(`>${raw}<`), `${raw} is printed on screen`).toBe(false);
    }
  });

  it("shows money as money", () => {
    // "125000 @ 4" was a share count and a share price, rendered as bare integers.
    for (const [name, src] of [["DealflowPage", DEALFLOW], ["RecordInvestment", RECORD_INVESTMENT]] as const) {
      expect(src, `${name} has no currency formatter`).toMatch(/style: "currency"/);
    }
  });
});

describe("the record opens from the company, and only from the company", () => {
  it("opens when a company is picked on the pipeline", () => {
    // The name used to navigate to the register instead, so "what are this deal's terms" was on a
    // different surface from the deal.
    expect(DEALFLOW).toContain("onOpen(deal.company_id, deal.company_name)");
    expect(DEALFLOW).toContain("<CompanyDealRecord");
  });

  it("keeps one door for a company the filter is hiding", () => {
    expect(DEALFLOW).toContain('data-testid="deal-record-company"');
  });

  it("is the only thing the shell renders on this route", () => {
    // The pipeline and the record were two components on one route, each with its own company
    // picker. Picking a company in one did not open the other.
    const app = code(readFileSync(`${CLIENT}App.tsx`, "utf8"));
    expect(app).not.toContain('data-testid="deal-records"');
    expect(app).not.toContain("<InvestmentPage");
  });
});
