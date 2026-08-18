import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVENT_ETHOS, OPERATING_RHYTHM, WHY_THE_RHYTHM } from "@shared/events/programme";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";

/**
 * The programme module and docs/COMMUNITY.md are two copies of the operator's own words, and the
 * one that drifts is always the one nobody is looking at. These pin them together: if the document
 * is edited and the screen is not, this fails rather than the community quietly being told
 * something the firm no longer believes.
 */
/**
 * The document is Markdown and the module is plain strings, so a phrase can be identical in
 * meaning and different in bytes purely because of emphasis. Comparing normalised text keeps the
 * test about the WORDS, which is what must not drift, rather than about the formatting, which may.
 */
const DOC = readFileSync(new URL("../docs/COMMUNITY.md", import.meta.url), "utf8")
  .replace(/\*\*|__|[*_`]/g, "")
  .replace(/\s+/g, " ");

describe("the event programme matches the community document", () => {
  it("keeps the stance verbatim", () => {
    expect(DOC).toContain("We are curators and conveners");
    for (const line of EVENT_ETHOS.notThis) {
      // The document writes these as one sentence each; strip the full stop to compare.
      expect(DOC).toContain(line.replace(/\.$/, ""));
    }
  });

  it("keeps what the product actually is", () => {
    expect(EVENT_ETHOS.product).toContain("Conversation");
    expect(DOC).toContain("Conversation — not presentations — is the product");
  });

  it("keeps the sponsor rule, which is the one that protects members", () => {
    expect(EVENT_ETHOS.money).toContain("never purchase access to members");
    expect(DOC).toContain("They never purchase access to members");
  });

  it("covers every interval the Operating Rhythm table names", () => {
    for (const label of ["Weekly", "Monthly", "Quarterly", "Annually"]) {
      expect(OPERATING_RHYTHM.some((i) => i.label === label), `${label} missing`).toBe(true);
      expect(DOC).toContain(`| ${label} |`);
    }
  });

  it("names the real things that run at each interval", () => {
    const all = OPERATING_RHYTHM.flatMap((i) => i.runs).join(" ");
    for (const thing of ["The Office", "Community Mastermind", "Room", "dinner", "Summit"]) {
      expect(all).toContain(thing);
    }
    expect(DOC).toContain("Tap In Tuesday");
  });

  it("gives every interval a purpose and a recommendation someone can act on", () => {
    for (const i of OPERATING_RHYTHM) {
      expect(i.purpose.length).toBeGreaterThan(20);
      // A recommendation that says nothing specific is decoration.
      expect(i.recommendation.length).toBeGreaterThan(60);
    }
  });

  it("keeps the closing argument for why the rhythm is shaped this way", () => {
    expect(WHY_THE_RHYTHM).toContain("Community creates reach");
    expect(DOC).toContain("Community creates reach");
  });

  it("is written by an employee who exists, with the title the operator chose", () => {
    const parker = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker");
    expect(parker).toBeDefined();
    expect(parker!.role).toBe("Event Marketing Coordinator");
    expect(DOC).toContain("Event Marketing Coordinator");
  });
});
