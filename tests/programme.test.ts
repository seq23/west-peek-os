import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EVENT_ETHOS, WHY_THE_RHYTHM } from "@shared/events/programme";
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

  it("keeps the sponsor rule, which is the one that protects members", () => {
    expect(EVENT_ETHOS.money).toContain("never purchase access to members");
    expect(DOC).toContain("They never purchase access to members");
  });

  it("is written by an employee who exists, with the title the operator chose", () => {
    const parker = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker");
    expect(parker).toBeDefined();
    expect(parker!.role).toBe("Event Marketing Coordinator");
    expect(DOC).toContain("Event Marketing Coordinator");
  });
});
