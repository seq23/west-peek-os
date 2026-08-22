import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The shape of the three admin pages: Sources & sweeps, Integrations, Machines.
 *
 * Same operator instruction as tests/roomsLayout.test.ts — "add a final pass for every single tab
 * that make sure the pages are not jumbled like the events tab and look more like the LP tab", and
 * "i dont underestand why it cant be simple like the lp page. everything is there and its easy to
 * follow."
 *
 * Every property below is one that was actually wrong on one of these three pages, and every one of
 * them is the kind of thing that comes back the next time somebody adds a feature here. Structural
 * checks on the source, in the manner of tests/accessibility.test.ts: cheap, and they fail for the
 * right reason.
 *
 * THE ONES THAT MATTER MOST ARE THE HIDING CHECKS. Sources & sweeps had 478 lines and zero
 * headings — five closed disclosures and nothing announcing what the page held. Integrations
 * collapsed its entire investor half to one line of prose whenever the API refused, so a reader
 * could not learn the sections existed. Machines kept a second department-methods section behind
 * `domain !== "ALL"`, which appeared only once a filter was moved off its default — the same bug
 * an in-file comment directly above it already claimed to have fixed.
 */

const SWEEPS = readFileSync(new URL("../src/client/pages/IntelligencePage.tsx", import.meta.url), "utf8");
const INTEGRATIONS = readFileSync(new URL("../src/client/pages/IntegrationsPage.tsx", import.meta.url), "utf8");
const MACHINES = readFileSync(new URL("../src/client/pages/MachinesPage.tsx", import.meta.url), "utf8");

const PAGES = [
  ["IntelligencePage", SWEEPS],
  ["IntegrationsPage", INTEGRATIONS],
  ["MachinesPage", MACHINES],
] as const;

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...src.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each h3, in order. Skips the one whose text is an expression. */
function sections(src: string): string[] {
  return [...src.matchAll(/<h3>([^<{]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

describe("the admin pages keep the ranks the shell expects", () => {
  it("uses only h3 for a section and h4 for a thing inside one", () => {
    // The shell renders the page title as an h2. A section is therefore an h3 and a thing inside a
    // section is an h4; nothing goes deeper, because there is nothing deeper to navigate to.
    for (const [name, src] of PAGES) {
      expect(ranks(src).filter((r) => r < 3 || r > 4), `${name} uses a rank outside h3/h4`).toEqual([]);
    }
  });

  it("does not restate the page title the shell already printed", () => {
    expect(sections(SWEEPS)).not.toContain("Sources & sweeps");
    expect(sections(INTEGRATIONS)).not.toContain("Integrations");
    expect(sections(MACHINES)).not.toContain("Machines");
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet rules an h3 that follows something. A hand-placed <hr> is a second line.
    for (const [name, src] of PAGES) {
      expect(src.includes("<hr"), `${name} hand-places a rule`).toBe(false);
    }
  });

  it("gives every page real sections rather than a stack of disclosures", () => {
    for (const [name, src] of PAGES) {
      expect(ranks(src).filter((r) => r === 3).length, `${name} has too few sections to navigate`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("nothing on these pages is reachable only by opening something", () => {
  it("Sources & sweeps holds no section inside a disclosure", () => {
    // Sources, watchlist, items, the manual sweep and the history were five `<details className=
    // "card intel-panel">`, all closed on load. The page announced nothing it contained.
    expect(SWEEPS).not.toContain("intel-panel");
    expect(SWEEPS).not.toMatch(/<details[^>]*>[\s\S]{0,200}<h3/);
  });

  it("Sources & sweeps names its five sections in the order the questions are asked", () => {
    expect(sections(SWEEPS)).toEqual([
      "Where the material comes from",
      "What we are watching for",
      "What the sweeps have gathered",
      "Gather something now",
      "Every sweep that has run",
    ]);
  });

  it("Machines shows its department methods without moving a filter", () => {
    // There used to be two methods sections: a firm-wide one of nested disclosures, and a second
    // copy gated on the area filter. One section now, always rendered, narrowed by the filter.
    expect(MACHINES).not.toContain('data-testid="department-skills"');
    expect(MACHINES).not.toMatch(/domain !== "ALL" && \(?\s*<section/);
    expect(MACHINES).toContain("<h3>How each department works</h3>");
  });

  it("Machines says what to do when no department is open", () => {
    // With nothing selected the page was a filter, a 45-row table, and nothing else: everything
    // worth reading was behind a press on a row nothing invited you to press.
    expect(MACHINES).toContain('data-testid="machine-none-open"');
  });
});

describe("a refusal is a fact a section states, not a section disappearing", () => {
  it("Integrations renders every investor section whether or not the reader may see it", () => {
    // The whole block used to collapse to `lpOps.data?.error ? <p>…</p> : <>…</>`, so a reader
    // without LP_PRIVATE could not tell the sections existed.
    expect(INTEGRATIONS).not.toContain("lp-ops-forbidden");
    for (const testid of [
      "lp-ops-sources",
      "lp-ops-schedules",
      "lp-ops-engagements",
      "lp-ops-diligence",
      "lp-ops-access",
      "lp-ops-gates",
    ]) {
      expect(INTEGRATIONS, `${testid} is missing`).toContain(testid);
    }
    // The refusal itself is one sentence, reused by each section's empty state.
    expect(INTEGRATIONS).toContain("lpBlocked");
  });

  it("Integrations labels each investor list with what it holds", () => {
    // Four unlabelled <ul>s in a row, with nothing saying what any of them was.
    expect(sections(INTEGRATIONS)).toEqual([
      "What we are connected to",
      "Which meetings still need preparing",
      "Sending work to an outside specialist",
      "Where the investor figures would come from",
      "When our numbers are next checked against theirs",
      "Where each investor conversation stands",
      "What investors have asked for, and what they can see",
      "What still cannot happen",
    ]);
  });
});

describe("no word from inside the machine reaches the screen", () => {
  it("prints no raw value in a <code> element", () => {
    // `<code>{e.status}</code>`, `<code>{k}</code>`, `<code>{m.kind}</code>` — an enum, a gate key
    // and a column value, each rendered as if the reader knew the schema.
    for (const [name, src] of PAGES) {
      expect(src.match(/<code>\{/g), `${name} prints a raw value in <code>`).toBeNull();
    }
  });

  it("maps every state a reader sees through a table of plain words", () => {
    // The maps are the single place the wording lives, so two sections cannot describe the same
    // state differently. Each page owns the vocabulary for what it renders.
    expect(SWEEPS).toContain("const SOURCE_STATE");
    expect(SWEEPS).toContain("const SENSITIVITY");
    expect(INTEGRATIONS).toContain("const CONNECTOR_STATE");
    expect(INTEGRATIONS).toContain("const ENGAGEMENT_STATE");
    expect(MACHINES).toContain("const RUNNING_STATE");
    expect(MACHINES).toContain("const QUEUE_STATE");
  });

  it("does not render a status field straight into the markup", () => {
    for (const [name, src] of PAGES) {
      // `res.status` is an HTTP code inside a failure message — the one place a number belongs.
      const raw = [
        ...src.matchAll(/\{(?!res\.)[a-zA-Z]+\.(status|state|kind|privacy_label|maturity|tested_state|direction|contract_state)\}/g),
      ].map((m) => m[0]);
      expect(raw, `${name} renders a raw field`).toEqual([]);
    }
  });

  it("writes a timestamp the way a person writes one", () => {
    // `last checked {s.last_checked_at}` printed an ISO string at somebody.
    for (const [name, src] of PAGES) {
      expect(src.includes("readableDate"), `${name} has no human date helper`).toBe(true);
      expect(src).not.toMatch(/\{[a-zA-Z]+\.(last_checked_at|started_at|created_at|next_due_at|scheduled_at)\}/);
    }
  });
});
