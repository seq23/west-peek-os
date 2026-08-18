import { describe, expect, it } from "vitest";
import {
  assignmentLabel,
  isAssigned,
  resolveAssignment,
  type ProposedCommitment,
  type RosterEntry,
} from "../src/shared/meetings/delegationPolicy";
import { buildDigest, parseProposals } from "../src/worker/services/meetingDelegation";

/**
 * The operator's assignment rule, pinned (P33).
 *
 * "Walter to assign only to AI employees, with human tasks proposed as recommended... the default
 * is to get the AI employees to do everything." These tests exist because that rule is easy to
 * invert by accident — one over-eager pattern in HUMAN_ONLY_SIGNALS and suddenly the firm's default
 * is handing work to a person.
 */

const ROSTER: RosterEntry[] = [
  { id: "aie_walker", name: "Walker", role: "Chief of Staff", status: "ACTIVE" },
  { id: "aie_priya", name: "Priya", role: "Investment Associate", status: "ACTIVE" },
  { id: "aie_wesley", name: "Wesley", role: "LP Relations", status: "ACTIVE" },
];
const FALLBACK = ROSTER[0]!;

const propose = (over: Partial<ProposedCommitment> = {}): ProposedCommitment => ({
  commitment_text: "Send the updated data room index",
  owner_side: "FIRM",
  ...over,
});

describe("assignment defaults to AI employees", () => {
  it("assigns ordinary firm work to an AI employee with no human involvement", () => {
    const r = resolveAssignment(propose(), ROSTER, FALLBACK);
    expect(r.assignee_kind).toBe("AI_EMPLOYEE");
    expect(r.ai_employee_id).toBe("aie_walker");
    expect(r.human_touch_reason).toBeNull();
  });

  it("honours a named employee the model suggested", () => {
    const r = resolveAssignment(propose({ suggested_employee_name: "Priya" }), ROSTER, FALLBACK);
    expect(r.ai_employee_id).toBe("aie_priya");
  });

  it("matches a suggested name case-insensitively and ignores surrounding space", () => {
    const r = resolveAssignment(propose({ suggested_employee_name: "  wESLEy " }), ROSTER, FALLBACK);
    expect(r.ai_employee_id).toBe("aie_wesley");
  });

  it("falls back rather than inventing an employee the roster does not have", () => {
    const r = resolveAssignment(propose({ suggested_employee_name: "Gandalf" }), ROSTER, FALLBACK);
    expect(r.ai_employee_id).toBe("aie_walker");
    expect(r.assignee_kind).toBe("AI_EMPLOYEE");
  });

  it("never assigns to an employee who is not on the active roster passed in", () => {
    // The service only ever passes ACTIVE employees. Given an empty active roster there is nobody
    // to assign to, and the honest result is an unowned deliverable — not a silent assignment.
    const r = resolveAssignment(propose(), [], null);
    expect(r.assignee_kind).toBe("UNASSIGNED");
    expect(r.ai_employee_id).toBeNull();
    expect(r.human_touch_reason).toMatch(/no active ai employee/i);
  });
});

describe("human work is recommended, never assigned", () => {
  const humanOnly = [
    "Sign the SAFE and return it to the founder",
    "Wire the investment amount on closing",
    "Sequoia to personally call the founder about the round",
    "Decide whether to invest and at what check size",
  ];

  it.each(humanOnly)("recommends rather than assigns: %s", (text) => {
    const r = resolveAssignment(propose({ commitment_text: text }), ROSTER, FALLBACK);
    expect(r.assignee_kind).toBe("HUMAN_RECOMMENDED");
    // The critical assertion: nobody is holding it. A recommendation that quietly sets an owner
    // would be an assignment wearing a different label.
    expect(r.ai_employee_id).toBeNull();
    expect(isAssigned(r.assignee_kind)).toBe(false);
    expect(r.human_touch_reason).toBeTruthy();
  });

  it("still recommends even when the model suggested an employee for it", () => {
    const r = resolveAssignment(
      propose({ commitment_text: "Sign the term sheet", suggested_employee_name: "Priya" }),
      ROSTER,
      FALLBACK,
    );
    expect(r.assignee_kind).toBe("HUMAN_RECOMMENDED");
    expect(r.ai_employee_id).toBeNull();
  });
});

describe("human touch keeps the work assigned", () => {
  const touch = [
    "Draft an intro between the founder and a design partner",
    "Reply to the founder's email about the timeline",
    "Prepare the LP update for this quarter",
    "Run reference calls on the CTO",
  ];

  it.each(touch)("assigns AND flags a human: %s", (text) => {
    const r = resolveAssignment(propose({ commitment_text: text }), ROSTER, FALLBACK);
    expect(r.assignee_kind).toBe("AI_WITH_HUMAN_TOUCH");
    // Distinguishing feature versus HUMAN_RECOMMENDED: an employee genuinely owns the work.
    expect(r.ai_employee_id).toBeTruthy();
    expect(isAssigned(r.assignee_kind)).toBe(true);
    expect(r.human_touch_reason).toBeTruthy();
  });

  it("carries the model's own reason through when no built-in signal matched", () => {
    const r = resolveAssignment(
      propose({ commitment_text: "Book the offsite venue", human_touch_reason: "Sequoia wanted to pick it" }),
      ROSTER,
      FALLBACK,
    );
    expect(r.assignee_kind).toBe("AI_WITH_HUMAN_TOUCH");
    expect(r.human_touch_reason).toBe("Sequoia wanted to pick it");
  });
});

describe("counterparty commitments", () => {
  it("tracks what they owe us without assigning it to anyone", () => {
    const r = resolveAssignment(
      propose({ commitment_text: "Founder will send the updated cap table", owner_side: "COUNTERPARTY" }),
      ROSTER,
      FALLBACK,
    );
    expect(r.assignee_kind).toBe("UNASSIGNED");
    expect(r.ai_employee_id).toBeNull();
  });

  it("does not apply human-only rules to their side", () => {
    // "The founder will sign" is their signature, not ours — it must not become our recommendation.
    const r = resolveAssignment(
      propose({ commitment_text: "Founder will sign the term sheet", owner_side: "COUNTERPARTY" }),
      ROSTER,
      FALLBACK,
    );
    expect(r.assignee_kind).toBe("UNASSIGNED");
  });
});

describe("extraction parsing", () => {
  it("reads a plain JSON object", () => {
    const out = parseProposals('{"commitments":[{"commitment_text":"Send the deck","owner_side":"FIRM"}]}');
    expect(out).toHaveLength(1);
  });

  it("reads JSON the model wrapped in a code fence", () => {
    const out = parseProposals('Sure!\n```json\n{"commitments":[{"commitment_text":"Send the deck","owner_side":"FIRM"}]}\n```');
    expect(out?.[0]?.commitment_text).toBe("Send the deck");
  });

  it("treats an empty list as a valid answer, not a failure", () => {
    // A meeting with no commitments is normal. Conflating "none" with "extraction broke" would
    // make the UI claim a failure every time a meeting was purely informational.
    expect(parseProposals('{"commitments":[]}')).toEqual([]);
  });

  it("returns null on unparseable output rather than guessing", () => {
    expect(parseProposals("I could not find any commitments, sorry.")).toBeNull();
    expect(parseProposals('{"commitments":[{"owner_side":"FIRM"}]}')).toBeNull();
    expect(parseProposals('{"commitments":[{"commitment_text":"x","owner_side":"NEITHER"}]}')).toBeNull();
  });
});

describe("the digest tells the operator who has what", () => {
  const resolved = [
    resolveAssignment(propose({ commitment_text: "Send the updated data room index", suggested_employee_name: "Priya" }), ROSTER, FALLBACK),
    resolveAssignment(propose({ commitment_text: "Draft an intro to a design partner" }), ROSTER, FALLBACK),
    resolveAssignment(propose({ commitment_text: "Sign the SAFE" }), ROSTER, FALLBACK),
    resolveAssignment(propose({ commitment_text: "Founder will send the cap table", owner_side: "COUNTERPARTY" }), ROSTER, FALLBACK),
  ];
  const digest = buildDigest({ title: "Acme seed call" }, resolved, ROSTER);

  it("names the employee holding each assigned task", () => {
    expect(digest).toContain("Priya — Send the updated data room index");
  });

  it("separates recommendations from assignments", () => {
    expect(digest).toMatch(/\*\*Recommended for you\*\* — not assigned/);
    expect(digest).toContain("Sign the SAFE");
  });

  it("keeps counterparty items in their own section", () => {
    expect(digest).toMatch(/\*\*They owe us\*\*/);
  });

  it("states that nothing was sent", () => {
    // The operator must never have to wonder whether a close-out emailed anyone.
    expect(digest).toMatch(/nothing has been sent/i);
  });

  it("says so plainly when a meeting produced nothing", () => {
    expect(buildDigest({ title: "Standup" }, [], ROSTER)).toMatch(/no new deliverables/i);
  });
});

describe("labels", () => {
  it("reads as plain English for each kind", () => {
    expect(assignmentLabel("AI_EMPLOYEE")).toBe("Assigned");
    expect(assignmentLabel("AI_WITH_HUMAN_TOUCH")).toBe("Assigned · your input wanted");
    expect(assignmentLabel("HUMAN_RECOMMENDED")).toBe("Recommended for you");
    expect(assignmentLabel("UNASSIGNED")).toBe("Unassigned");
  });
});
