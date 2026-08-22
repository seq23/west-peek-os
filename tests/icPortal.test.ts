import { describe, expect, it } from "vitest";
import {
  expectedSectionIds,
  icReadiness,
  restrictedSectionIds,
  type AnswerRow,
} from "../src/worker/services/icPortal";
// Counted from the framework, never typed in. The core set and the closing six are both edited
// from time to time, and a literal here reads as a rule when it is only today's arithmetic.
import { CLOSING_SIX, CORE_SECTIONS } from "@shared/ic/diligenceFramework";

/**
 * IC readiness and the anti-bias rule (P34).
 *
 * The rule these tests exist to protect: readiness is REPORTED BY NAME, never scored. A percentage
 * would let a packet read "92% ready" with the entire kill case empty — the exact failure the
 * framework was written to prevent.
 */

const answer = (section_id: string, state: string, over: Partial<AnswerRow> = {}): AnswerRow => ({
  id: `icd_${section_id}`,
  ic_packet_id: "icp_1",
  section_id,
  state,
  body: state === "ANSWERED" ? "answered" : null,
  na_reason: state === "NOT_APPLICABLE" ? "no revenue yet" : null,
  answered_by: "fu_1",
  answered_at: "2026-08-17T00:00:00Z",
  ...over,
});

describe("expected sections", () => {
  it("is core + closing six for a sector-less deal", () => {
    const ids = expectedSectionIds("OTHER");
    expect(ids).toContain("founder");
    expect(ids).toContain("kill_case");
    expect(ids).toContain("closing_6");
    expect(ids.filter((i) => i.startsWith("sector_"))).toEqual([]);
    expect(ids).toHaveLength(CORE_SECTIONS.length + CLOSING_SIX.length);
  });

  it("adds exactly one sector section for a sector deal", () => {
    const ids = expectedSectionIds("AI");
    expect(ids).toContain("sector_ai");
    expect(ids).toHaveLength(CORE_SECTIONS.length + 1 + CLOSING_SIX.length);
  });
});

describe("readiness", () => {
  it("reports every section open when nothing is answered", () => {
    const r = icReadiness("OTHER", []);
    expect(r.complete).toBe(false);
    expect(r.open).toHaveLength(expectedSectionIds("OTHER").length);
    expect(r.answered).toEqual([]);
  });

  it("names what is open rather than scoring it", () => {
    const answers = expectedSectionIds("OTHER")
      .filter((id) => id !== "kill_case")
      .map((id) => answer(id, "ANSWERED"));
    const r = icReadiness("OTHER", answers);
    // All but one done. A percentage would say 94% and read as ready.
    expect(r.open).toEqual(["kill_case"]);
    expect(r.complete).toBe(false);
    expect(r).not.toHaveProperty("score");
    expect(r).not.toHaveProperty("percent");
  });

  it("flags a missing bear case specifically", () => {
    const answers = expectedSectionIds("OTHER")
      .filter((id) => id !== "closing_6")
      .map((id) => answer(id, "ANSWERED"));
    expect(icReadiness("OTHER", answers).bear_case_missing).toBe(true);
  });

  it("does not flag a bear case that is written", () => {
    const answers = expectedSectionIds("OTHER").map((id) => answer(id, "ANSWERED"));
    const r = icReadiness("OTHER", answers);
    expect(r.bear_case_missing).toBe(false);
    expect(r.complete).toBe(true);
  });

  it("counts an explained NOT_APPLICABLE as covered, not open", () => {
    // An honest "does not apply, because…" is a complete answer; treating it as a gap would push
    // people to write filler.
    const answers = expectedSectionIds("OTHER").map((id) =>
      id === "traction" ? answer(id, "NOT_APPLICABLE") : answer(id, "ANSWERED"),
    );
    const r = icReadiness("OTHER", answers);
    expect(r.not_applicable).toEqual(["traction"]);
    expect(r.open).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it("treats an explicitly OPEN answer as open even though a row exists", () => {
    const answers = expectedSectionIds("OTHER").map((id) =>
      id === "moat" ? answer(id, "OPEN") : answer(id, "ANSWERED"),
    );
    expect(icReadiness("OTHER", answers).open).toEqual(["moat"]);
  });

  it("counts the sector section for a sector deal", () => {
    const answers = expectedSectionIds("OTHER").map((id) => answer(id, "ANSWERED"));
    // Same answers, AI packet: the sector module is still outstanding.
    expect(icReadiness("AI", answers).open).toEqual(["sector_ai"]);
  });
});

describe("the champion restriction", () => {
  it("covers the kill case and Closing Six question 6, and nothing else", () => {
    expect(restrictedSectionIds().sort()).toEqual(["closing_6", "kill_case"]);
  });
});
