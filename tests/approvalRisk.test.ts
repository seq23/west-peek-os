import { describe, expect, it } from "vitest";
import { assessRisk, expiryHours, isStale, queueRank, recommendApprover } from "../src/shared/approvals/risk";

/**
 * Approval risk (P47).
 *
 * The rule worth protecting: risk is DERIVED from the action, never declared by the requester —
 * who is often an AI employee with an interest in a fast approval.
 */

describe("classification", () => {
  it("puts a human-reserved action above HIGH", () => {
    // Canon reserved these because a machine must never do them, which is stronger than "risky".
    expect(assessRisk("investment.approve").level).toBe("RESERVED");
  });

  it("treats anything that leaves the firm as HIGH", () => {
    const r = assessRisk("effect.email.send");
    expect(r.level).toBe("HIGH");
    expect(r.reason).toMatch(/cannot be unsent/);
  });

  it("treats a revocation as HIGH even when not an external effect", () => {
    // Chosen deliberately from the NON-reserved set: capital_call.issue and knowledge.promote are
    // already human-reserved, so they never reach this tier. The reserved register is broader than
    // it looks, which is worth knowing before adding a rule here.
    expect(assessRisk("data_room_access.revoke").level).toBe("HIGH");
  });

  it("treats a change to the firm's record as MEDIUM", () => {
    expect(assessRisk("contradiction.resolve").level).toBe("MEDIUM");
  });

  it("leaves ordinary internal work LOW", () => {
    expect(assessRisk("work_card.update").level).toBe("LOW");
  });

  it("gives every level a reason an approver can read", () => {
    for (const k of ["investment.approve", "effect.email.send", "contradiction.resolve", "work_card.update"]) {
      expect(assessRisk(k).reason.length, k).toBeGreaterThan(12);
    }
  });
});

describe("triage", () => {
  it("sorts the dangerous things to the top of the queue", () => {
    const order = ["LOW", "RESERVED", "MEDIUM", "HIGH"].sort((a, b) => queueRank(a) - queueRank(b));
    expect(order).toEqual(["RESERVED", "HIGH", "MEDIUM", "LOW"]);
  });

  it("puts an unclassified card last rather than first", () => {
    expect(queueRank("UNCLASSIFIED")).toBeGreaterThan(queueRank("LOW"));
  });

  it("gives riskier cards a shorter fuse", () => {
    expect(expiryHours("HIGH")).toBeLessThan(expiryHours("LOW"));
    expect(expiryHours("RESERVED")).toBeLessThan(expiryHours("MEDIUM"));
  });

  it("recommends a partner for anything reserved or high", () => {
    expect(recommendApprover("effect.email.send", ["INVESTMENT_TEAM", "MANAGING_PARTNER"])).toBe("MANAGING_PARTNER");
  });

  it("does not override a single required role", () => {
    // Advisory only — it must never appear to narrow who is actually allowed to decide.
    expect(recommendApprover("effect.email.send", ["COMPLIANCE"])).toBe("COMPLIANCE");
  });
});

describe("staleness", () => {
  const now = new Date("2026-08-17T12:00:00Z");

  it("flags a card past its date", () => {
    expect(isStale("2026-08-16T12:00:00Z", now)).toBe(true);
  });

  it("does not flag a card with time left, or none set", () => {
    expect(isStale("2026-08-18T12:00:00Z", now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
  });

  it("is advisory only — nothing here decides", () => {
    // Auto-approving on expiry lets silence approve an external send; auto-rejecting lets silence
    // kill a deal. This module returns a boolean and takes no action, by design.
    expect(typeof isStale("2026-01-01T00:00:00Z", now)).toBe("boolean");
  });
});
