import { describe, expect, it } from "vitest";
import { EMAIL_TRIGGERS, INTAKE_MAILBOX, NO_TRIGGER_ROUTE, triggersIn } from "../src/shared/intake/emailTriggers";
import { SKILL_LIBRARY } from "../src/shared/skills/library";

/**
 * The inbox routing table.
 *
 * Operator, 21 Aug 2026: "i want the employee monitoring the inbox to know immediately what to do
 * when emails enter the inbox with those triggers." These tests exist because that only stays true
 * if the table and the employee's method cannot drift apart — three copies of a routing rule is
 * three chances for the inbox to do something the documentation says it does not.
 */

describe("what a hashtag means is defined once", () => {
  it("carries the two triggers already used across the family, plus the deck one", () => {
    expect(EMAIL_TRIGGERS.map((t) => t.tag)).toEqual(["#wpdealflow", "#wpnetwork", "#wpdeck"]);
  });

  it("sends people to Network OS and companies here, and never both", () => {
    const owner = (tag: string) => EMAIL_TRIGGERS.find((t) => t.tag === tag)!.owner;
    expect(owner("#wpnetwork")).toBe("NETWORK_OS");
    expect(owner("#wpdealflow")).toBe("WEST_PEEK_OS");
    expect(owner("#wpdeck")).toBe("WEST_PEEK_OS");
  });

  it("routes every trigger in a message, because one mail can introduce a founder AND their company", () => {
    const found = triggersIn("Great meeting — adding them #wpnetwork and their company #wpdealflow");
    expect(found.map((t) => t.tag).sort()).toEqual(["#wpdealflow", "#wpnetwork"]);
  });

  it("matches whatever case somebody types", () => {
    expect(triggersIn("#WPDealFlow").map((t) => t.tag)).toEqual(["#wpdealflow"]);
  });

  it("lands everything as a proposal, because a public word can never be what grants entry", () => {
    // The constraint the whole design turns on: anybody who learns the hashtag can type it.
    for (const t of EMAIL_TRIGGERS) {
      expect(t.lands.toLowerCase()).toMatch(/proposal|review queue/);
    }
  });

  it("does not drop mail that carries no trigger", () => {
    expect(triggersIn("just checking in about next week")).toEqual([]);
    expect(NO_TRIGGER_ROUTE.lands).toContain("Needs your attention");
  });
});

describe("the employee reading the inbox knows the same table", () => {
  it("Porter's capture-routing method names every trigger, in the operator's own words", () => {
    const machine = SKILL_LIBRARY.find((m) => m.machineKey === "global_capture_routing")!;
    const skill = machine.skills.find((s) => s.key === "the_inbox_triggers")!;
    const text = skill.guidance.join(" ").toLowerCase();
    for (const t of EMAIL_TRIGGERS) {
      expect(text).toContain(t.tag);
    }
    // The rule that keeps a published hashtag safe has to be in the method, not only in the code.
    expect(text).toContain("routes, it never authorises");
    expect(skill.when).toContain(INTAKE_MAILBOX);
  });
});
