import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The shape of Events & Rooms.
 *
 * This is the page the operator named when she said the tabs were jumbled — "add a final pass for
 * every single tab that make sure the pages are not jumbled like the events tab and look more like
 * the LP tab", and "i dont underestand why it cant be simple like the lp page. everything is there
 * and its easy to follow."
 *
 * Every property below is one that was actually wrong, and every one of them is the kind of thing
 * that comes back the next time somebody adds a feature to this page. They are structural checks on
 * the source, in the manner of tests/accessibility.test.ts: cheap, and they fail for the right
 * reason.
 *
 * ONE OF THEM IS A DIRECT OPERATOR INSTRUCTION with no other test behind it — "declined proposals
 * should go somewhere after they are declined. somewhere below greyed out." It was implemented and
 * nothing anywhere checked it still existed.
 */

const ROOMS = readFileSync(new URL("../src/client/pages/RoomsPage.tsx", import.meta.url), "utf8");
const EVENTS = readFileSync(new URL("../src/client/pages/EventsPage.tsx", import.meta.url), "utf8");
const CLOSEOUT = readFileSync(new URL("../src/client/pages/CloseoutPanel.tsx", import.meta.url), "utf8");

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...src.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each h3, in order. */
function sections(src: string): string[] {
  return [...src.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

describe("Events & Rooms keeps the ranks the shell expects", () => {
  it("uses only h3 for a section and h4 for a thing inside one", () => {
    // The shell renders the page title as an h2. A section is therefore an h3 and a thing inside a
    // section is an h4; nothing goes deeper, because there is nothing deeper to navigate to.
    for (const [name, src] of [["RoomsPage", ROOMS], ["EventsPage", EVENTS], ["CloseoutPanel", CLOSEOUT]] as const) {
      expect(ranks(src).filter((r) => r < 3 || r > 4), `${name} uses a rank outside h3/h4`).toEqual([]);
    }
  });

  it("does not restate the page title the shell already printed", () => {
    // The nav label is "Events & Rooms" and the shell prints it as the h2.
    expect(sections(ROOMS)).not.toContain("Events & Rooms");
    expect(sections(ROOMS)).not.toContain("Rooms");
    expect(sections(EVENTS)).not.toContain("Events");
  });

  it("mounts the events half at section rank, not inside a subsection of Rooms", () => {
    // <EventsPage/> used to sit inside an <h4> subsection, which put an h3 two levels below another
    // h3 and an h3 inside an h4. It renders its own h3 sections now and is mounted bare.
    expect(ROOMS).toContain("<EventsPage />");
    expect(ROOMS).not.toMatch(/<h4>[^<]*<\/h4>[\s\S]{0,400}<EventsPage/);
    expect(sections(EVENTS).length).toBeGreaterThan(0);
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet draws it from the h3. A hand-placed <hr> would be a second line.
    expect(ROOMS).not.toContain("<hr");
    expect(EVENTS).not.toContain("<hr");
  });
});

describe("Events & Rooms reads the order a partner asks in", () => {
  it("leads with the decision, then history, then who pays, then what happened", () => {
    expect(sections(ROOMS)).toEqual([
      "Rooms we could run",
      "Rooms we turned down",
      "Who is paying for it",
      "How often West Peek gathers",
    ]);
    expect(sections(EVENTS)).toEqual([
      "Every gathering on the record",
      "Put a gathering on the record",
    ]);
  });

  it("puts every form after the answer it feeds", () => {
    // Both were inverted: "Add an event" sat above "All events", and the add-sponsor row above the
    // sponsor table. LP's order is the answer first, then the control that adds to it.
    expect(EVENTS.indexOf("Every gathering on the record")).toBeLessThan(
      EVENTS.indexOf("Put a gathering on the record"),
    );
    expect(ROOMS.indexOf('data-testid="sponsor-table"')).toBeLessThan(ROOMS.indexOf('data-testid="add-sponsor"'));
    expect(ROOMS.indexOf('data-testid="rooms-empty"')).toBeLessThan(ROOMS.indexOf('data-testid="propose-room"'));
  });

  it("carries one orientation block, and it is at the bottom", () => {
    // The shell already renders PagePurposeBlock above every page. This page stacked a HowThisWorks
    // on top of that and Events stacked a second one — three explanations before any content.
    expect((ROOMS.match(/<HowThisWorks/g) ?? []).length).toBe(1);
    expect(EVENTS).not.toContain("HowThisWorks");
    expect(ROOMS.indexOf("<HowThisWorks")).toBeGreaterThan(ROOMS.indexOf("<Programme />"));
  });
});

describe("a declined Room goes on a shelf, not into nothing", () => {
  /*
   * Operator, verbatim: "declined proposals should go somewhere after they are declined. somewhere
   * below greyed out." Parker proposes a Room a month and most are declined by design, so a list
   * that silently drops them loses the record of what was considered.
   */
  it("keeps the shelf, its test hook, and the dimming that makes it history", () => {
    expect(ROOMS).toContain('data-testid="declined-proposals"');
    expect(ROOMS).toContain('className="declined-shelf"');
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.declined-shelf\s*\{[^}]*opacity/);
  });

  it("puts the shelf below the live list", () => {
    expect(ROOMS.indexOf("Rooms we could run")).toBeLessThan(ROOMS.indexOf("Rooms we turned down"));
  });

  it("filters DECLINED out of the live list and only into the shelf", () => {
    expect(ROOMS).toContain('p.status !== "DECLINED"');
    expect(ROOMS).toContain('p.status === "DECLINED"');
  });

  it("says what the shelf is for when it is empty, rather than rendering nothing", () => {
    // A section that disappears when empty is a section nobody learns exists.
    const shelf = ROOMS.slice(ROOMS.indexOf('data-testid="declined-proposals"'), ROOMS.indexOf("<SponsorPipeline"));
    expect(shelf).toContain("declined.length === 0");
    expect(shelf).toContain("state-empty");
  });
});

describe("nothing on this page is reachable only by guessing", () => {
  it("has no accordion gating the case for a decision", () => {
    // The packet — question, audience, venues, economics, and both decision buttons — used to exist
    // only for a reader who guessed a row was clickable.
    expect(ROOMS).not.toContain("openId");
    expect(ROOMS).not.toContain('className="card-head"');
  });

  it("shows the rhythm instead of hiding it behind a toggle", () => {
    expect(ROOMS).not.toContain("programme-toggle");
    expect(ROOMS).toContain('data-testid="programme-rhythm"');
    expect(ROOMS).toContain('data-testid="programme-money"');
    expect(ROOMS).toContain('data-testid="programme-why"');
  });

  it("announces the close-out step before it is due, in every state", () => {
    // It returned null for DRAFT, PLANNED and CANCELLED, so a partner met the step for the first
    // time on the one day it is hard to do — attendance is unrecoverable a week later.
    expect(EVENTS).not.toMatch(/return null/);
    expect(EVENTS).toContain("closeout-pending-");
    // And the notes box is open, not behind a link you must click first.
    expect(EVENTS).toContain("closeout-notes-");
    expect(EVENTS).not.toContain("closeout-open-");
  });

  it("gives every section an empty state instead of vanishing", () => {
    for (const hook of ["rooms-empty", "sponsors-empty"]) expect(ROOMS).toContain(hook);
    expect(EVENTS).toContain("events-empty");
  });
});

describe("the screen speaks English, the code speaks enum", () => {
  it("never renders a raw status, stage or verification string", () => {
    // PROPOSED, APPROVED, DECLINED, UNVERIFIED and IN_CONVERSATION were printed in capitals.
    for (const expr of ["p.status", "ev.status", "s.stage", "v.verification", "p.format"]) {
      // `{p.status}` in the body renders it. `status={ev.status}` passes it to a child, which is
      // how the raw value is SUPPOSED to travel — the lookbehind is the difference between the two.
      const rendered = new RegExp(`(?<!=)\\{${expr.replace(".", "\\.")}\\}`);
      expect(rendered.test(ROOMS), `RoomsPage renders ${expr} raw`).toBe(false);
      expect(rendered.test(EVENTS), `EventsPage renders ${expr} raw`).toBe(false);
    }
    // Nor a lowercased enum, which is the same word with the shouting removed.
    expect(ROOMS).not.toContain("{p.status.toLowerCase()}");
    expect(EVENTS).not.toContain("{ev.status.toLowerCase()}");
  });

  it("keeps branching on the raw strings, because that is what the API sends", () => {
    expect(ROOMS).toContain('p.status === "PROPOSED"');
    expect(ROOMS).toContain('v.verification === "UNVERIFIED"');
    expect(EVENTS).toContain('status === "CANCELLED"');
  });

  it("gives every state a label a partner would say out loud", () => {
    for (const said of ["Waiting on you", "Turned down", "Nobody has called yet", "In conversation"]) {
      expect(ROOMS, `missing plain-English label: ${said}`).toContain(said);
    }
    for (const said of ["Not on the calendar yet", "On the calendar", "Happening now"]) {
      expect(EVENTS, `missing plain-English label: ${said}`).toContain(said);
    }
  });

  it("uses only class names the stylesheet actually defines", () => {
    /*
     * A LARGE PART OF WHY THIS PAGE LOOKED JUMBLED. It used `pill`, `card-head`, `data`, `lede`,
     * `prewrap`, `negative`, `stack`, `primary` and `warn` — nine class names, none of which the
     * stylesheet has ever defined. Status badges rendered as bare shouting text, the "Propose"
     * button as a default grey button, and the agenda overflowed its card sideways. Nothing failed;
     * it just looked wrong, on the one page the operator was pointing at.
     */
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const undefinedClasses: string[] = [];
    for (const [file, src] of [["RoomsPage", ROOMS], ["EventsPage", EVENTS]] as const) {
      for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
          if (!new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`).test(css)) {
            undefinedClasses.push(`${file}: .${cls}`);
          }
        }
      }
    }
    expect([...new Set(undefinedClasses)]).toEqual([]);
  });
});
