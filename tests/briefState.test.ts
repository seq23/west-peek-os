import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { briefArrival, briefStageWords } from "../src/client/lib/briefState";

/**
 * A BRIEF THAT DID NOT ARRIVE SAYS SO, ON HER HOME (18 Sep 2026).
 *
 * Both partners opened Home at 08:59 CT to a card with a header, a "Rebuild today's brief" button,
 * the line "2026-09-18 · 300 items → 283 events → 30 considered", and nothing else. Her report row
 * was GENERATING; his was FAILED, carrying the reason on the row the whole time — "the brief was
 * rejected twice: executive_summary carries no [n] citation; ...". Neither was shown. She guessed
 * at the collapse button, because the card gave her nothing better to guess at.
 *
 * THE PROPERTY UNDER TEST: of every status the database permits, exactly one may report that a
 * brief arrived, and every other one must say out loud that it did not. The status list is read
 * out of the migration rather than typed here, so a status added later cannot slip through as
 * silence — which is the failure mode this test exists for.
 */

/** Every status `intelligence_report.status` accepts, read from the migration that declares it. */
function statusesFromSchema(): string[] {
  const sql = readFileSync(new URL("../migrations/0035_daily_intelligence_pipeline.sql", import.meta.url), "utf8");
  // ANCHORED TO THE TABLE. A bare search for the first `CHECK (status IN (...))` in this file finds
  // `tracked_narrative`'s ACTIVE/RESOLVED/DORMANT three tables earlier and passes having tested
  // none of the brief's statuses — three is not zero, so a zero-guard does not catch it.
  const table = /CREATE TABLE IF NOT EXISTS intelligence_report\s*\(([\s\S]*?)\n\);/.exec(sql);
  if (!table) throw new Error("the intelligence_report table is no longer where this test reads it from");
  const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(table[1] ?? "");
  if (!m) throw new Error("the status CHECK constraint is no longer where this test reads it from");
  const list = (m[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  if (!list.includes("READY") || !list.includes("FAILED")) {
    throw new Error(`read the wrong constraint: ${list.join(",")}`);
  }
  return list;
}

const ROW = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  report_date: "2026-09-18",
  completed_at: null,
  ...extra,
});

describe("only a readable brief may claim to have arrived", () => {
  it("covers every status the schema allows, and says so in all of them", () => {
    const statuses = statusesFromSchema();
    // HARD-FAIL ON AN EMPTY LOOP. A regex that matched nothing would otherwise pass this test
    // having asserted about no statuses at all.
    expect(statuses.length, "read zero statuses out of the migration").toBeGreaterThan(1);

    for (const status of statuses) {
      // Sections present, so the ONLY thing separating these cases is the status itself.
      const a = briefArrival(ROW(status), 7);
      expect(a.line, `${status} produced an empty line`).not.toHaveLength(0);
      // NEVER A STATUS CODE IN THE SENTENCE. "GENERATING" is not a thing she should have to decode.
      expect(a.line, `${status} leaked the raw status into her sentence`).not.toContain(status);
      if (status === "READY") {
        expect(a.arrived, "a READY report with sections did not count as arrived").toBe(true);
      } else {
        expect(a.arrived, `${status} claimed a brief had arrived`).toBe(false);
        // THE WHOLE POINT: not merely "not arrived", but SAYING not arrived.
        expect(a.line, `${status} did not say the brief is not there`).toMatch(/not arrive|still being built|no brief/i);
        expect(a.remedy, `${status} left her with nothing to do about it`).toBeTruthy();
      }
    }
  });

  it("shows the reason the pipeline already wrote down, verbatim", () => {
    // The real 18 Sep message, off the production row.
    const why =
      "the brief was rejected twice: executive_summary carries no [n] citation; top_headlines carries no [n] citation";
    const a = briefArrival(ROW("FAILED", { error_code: "incomplete", error_message: why }), 0);
    expect(a.arrived).toBe(false);
    expect(a.tone).toBe("failed");
    expect(a.line, "the reason was on the row and was not shown").toContain(why);
  });

  it("does not go silent when a failure recorded no reason", () => {
    const a = briefArrival(ROW("FAILED", { error_message: null }), 0);
    expect(a.arrived).toBe(false);
    expect(a.line).toMatch(/did not arrive/i);
    expect(a.line).toMatch(/did not record why/i);
  });

  it("treats a READY report with every section held back as an empty card, not an arrival", () => {
    /*
     * READY IS NECESSARY AND NOT SUFFICIENT. The verifier drops a section that cites something its
     * sources do not support; if it drops all of them the row is READY and the card is blank. That
     * is the same empty card by a different route and it must read the same way.
     */
    const a = briefArrival(ROW("READY", { completed_at: "2026-09-18T12:40:06.505Z" }), 0);
    expect(a.arrived, "a READY report with no sections claimed to be a brief").toBe(false);
    expect(a.tone).toBe("failed");
    expect(a.line).toMatch(/held back/i);
  });

  it("says nothing was built when there is no row at all", () => {
    const a = briefArrival(null, 0);
    expect(a.arrived).toBe(false);
    expect(a.line).toMatch(/no brief/i);
  });

  it("names every stage in words rather than column values", () => {
    for (const status of statusesFromSchema()) {
      const words = briefStageWords(status);
      expect(words, `${status} has no words`).not.toHaveLength(0);
      expect(words, `${status} is still shouting its column value`).not.toBe(status);
    }
  });
});

/**
 * AND THE PANEL ACTUALLY RENDERS IT.
 *
 * There is no DOM renderer in this suite, so the wiring is asserted at the source — the same
 * narrow, deliberate check the brief-arrives validator makes about the band. It catches the failure
 * that actually happened: a well-tested pure function that nothing on the page calls.
 */
describe("the panel is wired to it", () => {
  const panel = readFileSync(new URL("../src/client/pages/DailyBriefPanel.tsx", import.meta.url), "utf8");

  it("computes the arrival from the report and the sections actually on screen", () => {
    expect(panel).toMatch(/briefArrival\(report,\s*sections\.length\)/);
  });

  it("renders the not-arrived notice, and only when the brief has not arrived", () => {
    expect(panel).toContain('data-testid="daily-brief-not-arrived"');
    expect(panel, "the notice does not depend on the arrival").toMatch(/report && !arrival\.arrived/);
  });

  it("declares the failure reason the API returns, so it can be shown", () => {
    expect(panel, "error_message was never declared on the Report type — the 18 Sep defect")
      .toMatch(/error_message:\s*string \| null/);
  });
});
