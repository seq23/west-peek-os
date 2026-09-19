import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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
const FACES_SRC = code(readFileSync(`${CLIENT}pages/Faces.tsx`, "utf8"));
const PACKET = code(readFileSync(`${CLIENT}pages/DealPacket.tsx`, "utf8"));
const DECK = code(readFileSync(`${CLIENT}pages/DeckPanel.tsx`, "utf8"));
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
  it("uses one h2 for the masthead answer, h3 for a band and h4 for a thing inside one", () => {
    /*
     * The shell renders the page title as an h2; a band is an h3 and a thing inside one is an h4.
     * The Deals redesign (design/DEALS_SECTION_DESIGN.md §2) adds ONE more h2 to the page — the
     * masthead's answer line, the Home/Work pattern — and it is the only h2 the page may write.
     * Two answer lines would be two pages; none would be the old page, three ranks of meaning at
     * one rank of type.
     */
    const h2s = [...DEALFLOW.matchAll(/<h2[ >]/g)].length;
    expect(h2s, "DealflowPage writes exactly one h2 — the masthead answer").toBe(1);
    expect(DEALFLOW).toMatch(/<header className="masthead">[\s\S]{0,600}<h2 data-testid="dealflow-answer">/);
    for (const [name, src] of FILES) {
      expect(ranks(src).filter((r) => r < 2 || r > 4), `${name} uses a rank outside h2/h3/h4`).toEqual([]);
      if (name !== "DealflowPage") expect(ranks(src).filter((r) => r === 2), `${name} writes an h2 it does not own`).toEqual([]);
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
   * The order is the argument. Where does it stand, what are the terms, what do we know and how
   * (and what is unanswered), what has the committee said, what has happened to it. The record
   * carries them as FIVE FACES on one strip (design §4, artboard E2) rather than seven always-open
   * sections; any other order asks the reader to hold something in their head that the page could
   * have told them first.
   */
  const FACES = ["Where this stands", "The deal itself", "What we know", "The committee", "History"];

  it("opens the record with those five faces, in that order, on one tab strip", () => {
    const strip = DEALFLOW.slice(DEALFLOW.indexOf("const faces: Face[] = ["), DEALFLOW.indexOf('<div className="deal-record"'));
    const labels = [...strip.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(FACES);
    // The strip is a real tablist: the panels are keyed on the same faces the strip names.
    for (const key of ["standing", "deal", "known", "committee", "history"]) {
      expect(DEALFLOW, `no panel for the ${key} face`).toContain(`<FacePanel idPrefix="deal" face="${key}" active={face}`);
    }
    expect(FACES_SRC).toContain('role="tablist"');
    expect(FACES_SRC).toContain('role="tab"');
    expect(FACES_SRC).toContain("aria-selected={selected}");
    expect(FACES_SRC).toContain('tabIndex={selected ? 0 : -1}');
  });

  it("leads the page with the answer, the rail and the human act — then the pipeline, then the committee", () => {
    /*
     * The bands, in the order a partner reads them (artboard E1): what is waiting on me, the
     * pipeline, the committee — and nothing headed "Top of the funnel": the marketing paragraph in
     * a bordered box above the data is gone (design §1.2 #3), and "Add a company" is the pipeline
     * band's own action.
     */
    const bands = sections(DEALFLOW);
    expect(bands).toEqual(["Waiting on you", "The pipeline", "The committee"]);
    expect(DEALFLOW).not.toContain("Top of the funnel");
    expect(DEALFLOW).not.toContain("funnel-mouth");
    expect(DEALFLOW.indexOf('data-testid="stage-rail"')).toBeLessThan(DEALFLOW.indexOf("<h3>Waiting on you</h3>"));
    // The rail's nodes are buttons that narrow the list, and the exits line carries Phase A's rule.
    expect(DEALFLOW).toMatch(/<button[^>]*className=\{cls\}[^>]*data-testid=\{`stage-node-\$\{s\.key\}`\}/);
    expect(DEALFLOW).toContain("every company the firm records enters at New, however it arrived");
    // The page's primary is the one-click accept of a proposal, on the Waiting band.
    const proposal = DEALFLOW.slice(DEALFLOW.indexOf("function ProposalCard("), DEALFLOW.indexOf("export function DealflowPage("));
    expect(proposal).toContain('className="btn-primary"');
    expect(proposal).toContain("/api/meeting-stage-proposals/${p.id}/decide");
  });

  it("shows what the committee has seen, asked and decided — moved whole from Meetings", () => {
    /*
     * Section 4 of the old Meetings page: the packet, what it does not know and who owes each
     * answer, who is seated, the decision, the dissent, and the controls to answer, submit, decide
     * and disagree. Every test id the committee journey drives (e2e/p60) is here, so the journey
     * did not lose a control in the move.
     */
    const committee = DEALFLOW.slice(DEALFLOW.indexOf("function CommitteeFace("), DEALFLOW.indexOf("type RecordFace ="));
    for (const id of ["ic-deal-", "ic-questions-", "ic-question-", "ic-answer-", "ic-answer-text-", "ic-answer-save-", "ic-withdraw-", "ic-seats-", "ic-decision-", "ic-dissents-", "ic-dissent-open-", "ic-dissent-text-", "ic-dissent-save-", "ic-submit-", "ic-decide-", "ic-rationale-", "ic-invest-", "ic-pass-", "ic-defer-", "ic-open-packet-", "ic-packet-state-", "ic-card-"]) {
      expect(committee, `the committee face lost ${id}`).toContain(`data-testid={\`${id}`);
    }
    expect(committee).toContain("owedInWords");
    expect(committee, "a pass needs a sentence").toMatch(/rationale\.trim\(\)\.length < 12/);
    // Dissent is printed whole, and silence is not agreement.
    expect(committee).toContain("not the same as everybody agreeing");
    // A deal that has not reached the committee says so plainly.
    expect(committee).toContain('data-testid="deal-committee-none"');
    expect(committee).toContain("state-empty");
    // The packet's own faces open from the committee face, and are the retired IC Portal's tabs.
    expect(committee).toContain("<DealPacket");
    expect(PACKET).toMatch(/label: "Diligence"[\s\S]*label: "Memo"[\s\S]*label: "Market"[\s\S]*label: "People"[\s\S]*label: "Audit"/);
    expect(existsSync(`${CLIENT}pages/IcPortalPage.tsx`), "IcPortalPage is retired").toBe(false);
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

  it("says why the committee face is empty, rather than showing a gap", () => {
    expect(DEALFLOW).toContain('data-testid="deal-committee-none"');
    expect(DEALFLOW).toContain('data-testid="deal-record-none"');
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

  it("has no second door: the picker <select> and its tinted box are gone", () => {
    // design §1.2 #7. The row's name opens the record and says so (`aria-expanded`); a company the
    // filter hides is one chip away ("Everything"), and a company with no live deal takes a new
    // one through "Add a company", which reuses the register entry.
    expect(DEALFLOW).not.toContain('data-testid="deal-record-company"');
    expect(DEALFLOW).not.toContain("deal-record-step");
    expect(DEALFLOW).toMatch(/data-testid=\{`deal-company-\$\{deal\.id\}`\}\s+aria-expanded=\{open\}/);
    expect(DEALFLOW).toContain("data-testid={`dealflow-filter-${f.key}`}");
  });

  it("takes every reason in an inline field, never a browser prompt", () => {
    // design §1.2 #6: no label, no error slot, no focus ring, invisible on a phone keyboard.
    for (const [name, src] of [...FILES, ["DealPacket", PACKET], ["DeckPanel", DECK]] as const) {
      expect(src.includes("window.prompt"), `${name} still opens a window.prompt`).toBe(false);
      expect(src.includes("window.confirm"), `${name} still opens a window.confirm`).toBe(false);
    }
    // The field has a visible label and an error slot that reads as an instruction.
    const field = DEALFLOW.slice(DEALFLOW.indexOf("function ReasonField("), DEALFLOW.indexOf("function StageRail("));
    expect(field).toContain('<label className="field"');
    expect(field).toContain('className={err ? "field-help err" : "field-help"}');
    expect(field).toContain("aria-invalid={err ? true : undefined}");
    for (const use of ["testId={`deal-pass-reason-${deal.id}`}", "testId={`deal-archive-reason-${deal.id}`}", "testId={`proposal-decline-reason-${p.id}`}", 'testId="deal-record-pass-reason"']) {
      expect(DEALFLOW, `${use} does not use the inline field`).toContain(use);
    }
  });

  it("carries orange on one stage chip only — the stage the firm is acting in", () => {
    // design §1.2 #5: `.stage-chip-screening/-diligence/-ic_ready` painted three stages orange,
    // making orange a status. One chip, chosen by the stage registry's own keys.
    expect(DEALFLOW).not.toContain("stage-chip-${");
    expect(DEALFLOW).toContain('"stage-chip stage-chip-live"');
    expect(DEALFLOW).toMatch(/const LIVE_STAGES: readonly string\[\] = \["SCREENING", "DILIGENCE", "IC_READY"\]/);
  });

  it("is the only thing the shell renders on this route", () => {
    // The pipeline and the record were two components on one route, each with its own company
    // picker. Picking a company in one did not open the other.
    const app = code(readFileSync(`${CLIENT}App.tsx`, "utf8"));
    expect(app).not.toContain('data-testid="deal-records"');
    expect(app).not.toContain("<InvestmentPage");
  });
});
