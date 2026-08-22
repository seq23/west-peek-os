import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY, guidanceBlock, skillsForMachines } from "@shared/skills/library";
import { ACTIVE_MACHINES, MACHINE_REGISTRY, isRetiredMachine } from "@shared/registry/machines";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";
import { DEPARTMENTS_COVER_ALL_DOMAINS, departmentDef } from "@shared/registry/departments";

/**
 * The firm's methods, and the two ways a written-down method rots.
 *
 * It attaches to a department that no longer exists, or it attaches to one no employee sits in —
 * either way it is guidance nobody will ever read, and nothing would say so.
 */
describe("the skill library is attached to a real firm", () => {
  it("keys every skill to a machine that exists", () => {
    const keys = new Set(MACHINE_REGISTRY.map((m) => m.key));
    const orphans = SKILL_LIBRARY.filter((d) => !keys.has(d.machineKey)).map((d) => d.machineKey);
    expect(orphans).toEqual([]);
  });

  it("puts the methods somewhere an employee actually sits", () => {
    // Guidance on a machine nobody works is guidance nobody reads.
    const seated = new Set(AI_EMPLOYEE_ROSTER.flatMap((e) => e.primaryMachineKeys));
    const unread = SKILL_LIBRARY.filter((d) => !seated.has(d.machineKey)).map((d) => d.machineKey);
    expect(unread).toEqual([]);
  });

  /*
   * The other direction, and the reason the registry keeps rows it no longer uses.
   *
   * A retired machine is not deleted — work_card, ai_run and ai_run_attribution point at it, and
   * migrations are append-only, so the row stays in the registry and in the database and simply
   * stops taking work. `ACTIVE_MACHINES` is what may be seated on, scheduled to or routed to, and
   * these two guards are what make that flag mean something rather than being documentation.
   */
  it("seats nobody on a retired machine", () => {
    const wrong = AI_EMPLOYEE_ROSTER.flatMap((e) =>
      e.primaryMachineKeys.filter((k) => isRetiredMachine(k)).map((k) => `${e.name} sits on retired ${k}`),
    );
    expect(wrong).toEqual([]);
  });

  it("writes no methods for a retired machine", () => {
    expect(SKILL_LIBRARY.filter((d) => isRetiredMachine(d.machineKey)).map((d) => d.machineKey)).toEqual([]);
  });

  it("keeps every active machine seated and every seat's machines real", () => {
    /*
     * The count is asserted because both halves are decisions the operator made, and a number that
     * drifts silently is how twelve machines came to have nobody on them without anyone noticing.
     *
     * 46 rows in the registry: canon §5A.2's forty-five plus `venture_teaching`, added because the
     * Professor had no teaching machine and was seated on the committee's post-mortem instead.
     * 43 active: `prompt_enhancer_intent` (askToCard.ts already does it), `developer_diagnostics`
     * and `builder_repo_product` (both assume an engineer this firm does not employ) are flagged
     * retired and kept, because deleting them would orphan live history.
     */
    expect(MACHINE_REGISTRY).toHaveLength(46);
    expect(ACTIVE_MACHINES).toHaveLength(43);

    // Every seat names a machine that exists.
    const known = new Set(MACHINE_REGISTRY.map((m) => m.key));
    const unknown = AI_EMPLOYEE_ROSTER.flatMap((e) => e.primaryMachineKeys.filter((k) => !known.has(k)));
    expect(unknown).toEqual([]);

    // And every active machine has somebody accountable for it — the state item 17 finished in.
    const seated = new Set(AI_EMPLOYEE_ROSTER.flatMap((e) => e.primaryMachineKeys));
    expect(ACTIVE_MACHINES.filter((m) => !seated.has(m.key)).map((m) => m.key)).toEqual([]);
  });

  it("gives every domain the machine registry uses a human name", () => {
    // Otherwise the page falls back to shouting an enum, which is what it used to do.
    expect(DEPARTMENTS_COVER_ALL_DOMAINS).toBe(true);
    expect(departmentDef("INVESTMENT_OS").name).toBe("Investing");
  });
});

describe("what an employee is actually told", () => {
  it("gives Wyatt the research methods, because that is where he sits", () => {
    const wyatt = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Wyatt")!;
    const block = guidanceBlock(wyatt.primaryMachineKeys);
    expect(block).toContain("Judging a source before believing it");
    expect(block).toContain("A finding with no source is an opinion");
  });

  it("gives Percy the page-review methods rather than the research ones", () => {
    const percy = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Percy")!;
    const block = guidanceBlock(percy.primaryMachineKeys);
    expect(block).toContain("Why a page does not convert");
    expect(block).not.toContain("Judging a source before believing it");
  });

  it("says nothing at all for a department with no methods written down", () => {
    // An employee told "HOW THIS FIRM DOES THIS WORK:" followed by nothing has been told something
    // false about the firm. Empty means the section is omitted entirely.
    //
    // THE EXAMPLE HAS MOVED TWICE AND THAT IS THIS TEST WORKING. It was `continuity_maintenance`
    // until Pax's seat got methods, then `approval_center` until Pax was seated on that too (for
    // queue-hygiene reporting only — his first method says the machine approves nothing). Every
    // ACTIVE machine now has a seat and a method, so the only machines left with neither are the
    // RETIRED ones, which is exactly right: nothing may be seated on them, so nothing should be
    // written for them either.
    expect(guidanceBlock(["prompt_enhancer_intent"])).toBe("");
    expect(skillsForMachines(["prompt_enhancer_intent"])).toEqual([]);
    // And a key nobody has at all, which is the other way a caller reaches this branch.
    expect(guidanceBlock(["not_a_machine"])).toBe("");
  });

  it("frames them as guidelines and says the rules live elsewhere", () => {
    // The distinction is load-bearing: a rule belongs in code where it can be enforced. If this
    // ever reads as "these are the rules", an employee may believe it can break a real one.
    const block = guidanceBlock(["research_intelligence"]);
    expect(block).toContain("guidelines");
    expect(block).toContain("the rules are enforced elsewhere");
  });
});

/*
 * An employee is who the roster says they are, in every prompt that speaks as them.
 *
 * The survey that prompted this found 27 `runAi` call sites in the worker: two carried the veteran
 * standard, two carried the firm's methods, and NONE carried both. The busiest path of all — an
 * employee actually working a card — opened with two hand-written sentences, so the depth the
 * roster asserts for every seat regardless of title never reached the model. Personality was
 * displayed on the Employees page and absent from the work.
 */
describe("an employee brings their persona and their firm's methods to the work", () => {
  it("puts the veteran standard and the employee's own voice into the work-card prompt", async () => {
    const { buildStepPrompt } = await import("../src/shared/work/employeeLoop");
    const { personaFor } = await import("../src/shared/registry/aiEmployeePersonas");
    const { guidanceBlock } = await import("../src/shared/skills/library");

    const wyatt = personaFor("Wyatt")!;
    const prompt = buildStepPrompt(
      {
        employee_name: "Wyatt",
        employee_role: "Analyst & Scout",
        title: "Look at three seed-stage inference companies",
        next_action: "Start with who is actually shipping",
        description: null,
        prompt: null,
        guidance: guidanceBlock(["research_intelligence"]),
        history: [],
      } as never,
      3,
    );

    expect(prompt).toContain("You are Wyatt");
    expect(prompt).toContain(wyatt.voice);
    expect(prompt).toContain(wyatt.expertise);
    // The standard itself, asserted by a phrase from it rather than the whole block.
    expect(prompt).toMatch(/twenty years|evidence from inference|never invent/i);
    // And the firm's own methods, which the loop already carried.
    expect(prompt).toContain("research_intelligence".split("_")[0]!);
  });

  it("addresses Parker by the title the roster actually holds, not one written into a prompt", async () => {
    const { buildCloseoutPrompt } = await import("../src/worker/services/roomCloseout");
    const { AI_EMPLOYEE_ROSTER } = await import("../src/shared/registry/aiEmployees");

    const parker = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")!;
    const prompt = buildCloseoutPrompt(
      { title: "The Zero-to-One Room" } as never,
      "Notes from the evening.",
      "12 founders",
    );

    expect(prompt).toContain("You are Parker");
    expect(prompt).toContain(parker.role);
    // The drift this replaced: the file called Parker an "Event Planner", a title nobody holds.
    expect(prompt).not.toContain("Event Planner");
  });
});

/*
 * Parker was proposing the firm's flagship events without ever being told the document that governs
 * them existed. docs/COMMUNITY.md says of itself that where it and the code disagree, it is right
 * and the code is the bug — and the generator was implementing one row of its four-row rhythm,
 * defaulting to a seated dinner in New York, and reporting the same sponsor target on every packet.
 */
describe("the event marketer works from the firm's community scaffolding", () => {
  it("gives Parker's machine methods that name the governing document", async () => {
    const { skillsForMachines } = await import("../src/shared/skills/library");
    const skills = skillsForMachines(["west_peek_live_events"]);
    expect(skills.length).toBeGreaterThan(0);

    const all = skills.flatMap((s) => s.guidance).join(" ");
    expect(all).toContain("docs/COMMUNITY.md");
    // The four-row rhythm, so a monthly reflex is not the only shape he knows.
    expect(all).toMatch(/weekly/i);
    expect(all).toMatch(/quarterly/i);
    // The rule that outranks the money.
    expect(all).toContain("never purchase access to members");
    // The operator's clause, which had no home anywhere in the system before this: aim for money,
    // but surface a good Room that has none and say what it buys instead.
    expect(all).toMatch(/does not pay for itself/i);
    expect(all).toMatch(/\$10,000/);
    // And the parts of the rhythm that are free by design must not be made to earn.
    expect(all).toMatch(/free by design/i);
  });

  it("puts those methods into the proposal prompt, above the formatting rules", async () => {
    const { buildPacketPrompt } = await import("../src/shared/events/roomPacket");
    const { guidanceBlock } = await import("../src/shared/skills/library");

    const prompt = buildPacketPrompt({
      month: "2026-09",
      recentThemes: [],
      venueCandidates: [],
      city: "Atlanta",
      guidance: guidanceBlock(["west_peek_live_events"]),
    });

    expect(prompt).toContain("docs/COMMUNITY.md");
    expect(prompt).toContain("You are Parker");
    // Addressed by the title the roster actually holds, not the one that had drifted into the file.
    expect(prompt).not.toContain("Event Planner");
    // The methods land before the mechanics: what a good proposal IS, then how to format one.
    expect(prompt.indexOf("docs/COMMUNITY.md")).toBeLessThan(prompt.indexOf("RECENT THEMES") + prompt.length);
  });

  it("omits the section entirely when a machine has no methods, rather than printing an empty heading", async () => {
    const { buildPacketPrompt } = await import("../src/shared/events/roomPacket");
    const prompt = buildPacketPrompt({ month: "2026-09", recentThemes: [], venueCandidates: [], city: "Atlanta" });
    expect(prompt).not.toContain("HOW THIS FIRM DOES THIS WORK");
  });
});
