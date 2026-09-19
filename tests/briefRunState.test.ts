import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  STALLED_AFTER_MINUTES, briefRunState, elapsedWords, lastBriefWords, usualWords,
  type BriefExpectations, type BriefHistory, type BriefRunRow,
} from "../src/shared/intelligence/briefRunState";
import { MAX_BRIEF_ATTEMPTS } from "../src/shared/intelligence/briefTerminality";
import { MOVING_KINDS, examinedLine, pressOutcomeLine, progressFraction, toneClassFor } from "../src/client/lib/briefBand";

/**
 * EVERY STATE THE ROW CAN BE IN HAS A NAME AND A SENTENCE (19 Sep 2026).
 *
 * The statuses are read OUT OF the schema's CHECK constraint rather than restated, so a status
 * added to the database later cannot default to silence here. Every status is driven at every
 * attempt count, leased and unleased, requested and scheduled, fresh and stale — and only one
 * combination in the whole product is allowed to say a brief arrived.
 */
const SCHEMA = readFileSync(new URL("../migrations/0035_daily_intelligence_pipeline.sql", import.meta.url), "utf8");
const STATUSES = Array.from(SCHEMA.match(/status\s+TEXT NOT NULL DEFAULT 'QUEUED'\s+CHECK \(status IN \(([^)]+)\)\)/)![1]!.matchAll(/'([A-Z_]+)'/g), (m) => m[1]!);

const NOW = new Date("2026-09-19T13:41:00.000Z"); // 09:41 New York
const EXP: BriefExpectations = { usualSeconds: 264, slowSeconds: 313, measuredFrom: 30 };
const ON: BriefHistory = { lastArrivedAt: "2026-09-17T11:42:31.000Z", lastReportDate: "2026-09-17", lastRequestedBy: null };
const TZ = "America/New_York";

function row(over: Partial<BriefRunRow>): BriefRunRow {
  return {
    status: "GENERATING", report_date: "2026-09-19", attempts: 1,
    started_at: "2026-09-19T13:39:40.000Z", stage_at: "2026-09-19T13:40:30.000Z", stage_lease_until: null,
    completed_at: null, requested_at: null, requested_by: null, retry_after: null, error_code: null, error_message: null,
    section_count: 0, ...over,
  };
}

describe("the schema's statuses", () => {
  it("are read out of the migration, and there are the seven the pipeline uses", () => {
    expect(STATUSES).toEqual(["QUEUED", "GATHERING", "RANKING", "GENERATING", "VERIFYING", "READY", "FAILED"]);
  });
});

describe("no combination is silent, and exactly one arrives", () => {
  const combos: Array<{ label: string; r: BriefRunRow }> = [];
  for (const status of STATUSES) {
    for (const attempts of [1, 2, MAX_BRIEF_ATTEMPTS, MAX_BRIEF_ATTEMPTS + 1]) {
      for (const leased of [false, true]) {
        for (const requested of [false, true]) {
          for (const stale of [false, true]) {
            combos.push({
              label: `${status} attempts=${attempts} leased=${leased} requested=${requested} stale=${stale}`,
              r: row({
                status, attempts,
                stage_lease_until: leased ? "2026-09-19T13:59:00.000Z" : null,
                requested_at: requested ? "2026-09-19T13:39:40.000Z" : null,
                requested_by: requested ? "fu_sequoia_taylor" : null,
                stage_at: stale ? "2026-09-19T12:30:00.000Z" : "2026-09-19T13:40:30.000Z",
                completed_at: status === "READY" || status === "FAILED" ? "2026-09-19T13:41:00.000Z" : null,
                retry_after: status === "FAILED" && attempts < MAX_BRIEF_ATTEMPTS ? "2026-09-19T14:01:00.000Z" : null,
                error_message: status === "FAILED" ? "the brief was rejected twice: the markets_macro section is missing" : null,
                section_count: status === "READY" ? 11 : 0,
              }),
            });
          }
        }
      }
    }
  }

  it(`drives ${combos.length} combinations and every one has a kind, a sentence and a button label`, () => {
    expect(combos.length).toBeGreaterThan(100);
    for (const c of combos) {
      const s = briefRunState(c.r, ON, EXP, NOW, TZ);
      expect(s.kind, c.label).toBeTruthy();
      expect(s.line.trim().length, `${c.label}: empty line`).toBeGreaterThan(20);
      expect(s.line, `${c.label}: a status code leaked into her sentence`).not.toMatch(/\b(GATHERING|RANKING|GENERATING|VERIFYING|QUEUED)\b/);
      expect(s.button.label.trim().length, `${c.label}: no button label`).toBeGreaterThan(3);
    }
  });

  it("only READY with sections on screen may claim a brief arrived", () => {
    const arrived = combos.filter((c) => briefRunState(c.r, ON, EXP, NOW, TZ).arrived);
    expect(arrived.length).toBeGreaterThan(0);
    for (const c of arrived) {
      expect(c.r.status, c.label).toBe("READY");
      expect(c.r.section_count, c.label).toBeGreaterThan(0);
    }
    const empty = briefRunState(row({ status: "READY", section_count: 0, completed_at: NOW.toISOString() }), ON, EXP, NOW, TZ);
    expect(empty.arrived).toBe(false);
    expect(empty.kind).toBe("failed_out");
  });

  it("a moving row under a live lease is RUNNING and says the stage, the elapsed time and the measured usual", () => {
    const s = briefRunState(row({ stage_lease_until: "2026-09-19T13:59:00.000Z" }), ON, EXP, NOW, TZ);
    expect(s.kind).toBe("running");
    expect(s.stage).toBe("writing it");
    expect(s.line).toMatch(/writing it/);
    expect(s.line).toMatch(/Started 1m 20s ago/);
    expect(s.line).toMatch(/usually 4–5 minutes/);
    expect(s.elapsedSeconds).toBe(80);
    expect(s.button.enabled, "a second press while running does nothing").toBe(false);
    expect(s.button.label).toMatch(/^Already building — started 1m 20s ago$/);
  });

  it("running past the measured usual is still RUNNING, says so in words, names the slow end, and carries the stage strip", () => {
    // Started 30 minutes ago against a 264s usual: not stuck (the lease is live), just longer than most.
    const s = briefRunState(row({ started_at: "2026-09-19T13:11:00.000Z", stage_lease_until: "2026-09-19T13:59:00.000Z" }), ON, EXP, NOW, TZ);
    expect(s.kind).toBe("running");
    expect(s.slow).toBe(true);
    expect(s.line).toBe("Still building — writing it. 30m in; usually about 4 minutes. The slow end is 5.");
    expect(s.button.enabled).toBe(false);
    expect(s.stages.map((x) => `${x.words}:${x.state}`)).toEqual(["read 48h:done", "ranked:done", "writing:now", "checked:todo"]);
    const fresh = briefRunState(row({ stage_lease_until: "2026-09-19T13:59:00.000Z" }), ON, EXP, NOW, TZ);
    expect(fresh.slow).toBe(false);
    const done = briefRunState(row({ status: "READY", section_count: 3, completed_at: NOW.toISOString() }), ON, EXP, NOW, TZ);
    expect(done.stages.every((x) => x.state === "done")).toBe(true);
  });

  it("a moving row with no lease is QUEUED between stages; a fresh request that nothing has picked up is REQUESTED", () => {
    expect(briefRunState(row({ status: "RANKING" }), ON, EXP, NOW, TZ).kind).toBe("queued");
    const req = briefRunState(row({ status: "GATHERING", requested_at: "2026-09-19T13:40:50.000Z", requested_by: "fu_sequoia_taylor" }), ON, EXP, NOW, TZ);
    expect(req.kind).toBe("requested");
    expect(req.line).toMatch(/within a minute/);
    expect(req.button.enabled).toBe(false);
  });

  it("a row that stopped moving past the stale threshold is STALLED and names the sweeper", () => {
    const s = briefRunState(row({ stage_at: "2026-09-19T12:30:00.000Z" }), ON, EXP, NOW, TZ);
    expect(s.kind).toBe("stalled");
    expect(s.next).toMatch(new RegExp(`${STALLED_AFTER_MINUTES} minutes`));
    expect(s.button.enabled, "she may start over rather than wait for the sweeper").toBe(true);
  });

  it("a FAILED row with attempts left is RETRYING and says the clock time, from the row's retry_after", () => {
    const s = briefRunState(row({ status: "FAILED", attempts: 1, retry_after: "2026-09-19T14:01:00.000Z", error_message: "the provider answered 429" }), ON, EXP, NOW, TZ);
    expect(s.kind).toBe("retrying");
    expect(s.line).toMatch(/attempt 1 of 3 failed: the provider answered 429/);
    expect(s.next).toMatch(/tries again at 10:01 AM/);
    expect(s.actAt).toBe("2026-09-19T14:01:00.000Z");
  });

  it("a FAILED row with the attempts spent is FAILED OUT, says why, says nothing more is tried, and offers Try again", () => {
    const s = briefRunState(row({ status: "FAILED", attempts: MAX_BRIEF_ATTEMPTS, error_message: "the brief was rejected twice: the markets_macro section is missing" }), ON, EXP, NOW, TZ);
    expect(s.kind).toBe("failed_out");
    expect(s.line).toMatch(/No brief today\. It was tried 3 times/);
    expect(s.line).toMatch(/markets_macro section is missing/);
    expect(s.next).toMatch(/Nothing more is tried automatically\. Press the button to try again now\./);
    expect(s.next, "there is no schedule to promise").not.toMatch(/tomorrow/);
    expect(s.button.label).toBe("Try again now");
  });

  it("a FAILED row that recorded no reason still says so rather than a blank", () => {
    const s = briefRunState(row({ status: "FAILED", attempts: MAX_BRIEF_ATTEMPTS, error_message: null }), ON, EXP, NOW, TZ);
    expect(s.line).toMatch(/the run did not record why/);
  });
});

describe("no row yet — on demand, any day", () => {
  it("is IDLE: no brief today yet, when the last one arrived, and the button is the door", () => {
    const s = briefRunState(null, ON, EXP, NOW, TZ);
    expect(s.kind).toBe("idle");
    expect(s.line).toBe("No brief today yet. The last one arrived Thursday 7:42 AM.");
    expect(s.next).toMatch(/Press the button and it is built now — usually 4–5 minutes, any day of the week\./);
    expect(s.button).toEqual({ label: "Build today's brief", enabled: true });
    expect(s.actAt, "nothing is scheduled").toBeNull();
  });

  it("says so when none has ever been built, and names today / yesterday / a weekday / a date", () => {
    const none = briefRunState(null, { lastArrivedAt: null, lastReportDate: null, lastRequestedBy: null }, EXP, NOW, TZ);
    expect(none.kind).toBe("idle");
    expect(none.line).toMatch(/None has been built yet\./);
    expect(lastBriefWords("2026-09-19T10:20:00.000Z", NOW, TZ)).toBe("today 6:20 AM");
    expect(lastBriefWords("2026-09-18T10:20:00.000Z", NOW, TZ)).toBe("yesterday 6:20 AM");
    expect(lastBriefWords("2026-09-15T10:20:00.000Z", NOW, TZ)).toBe("Tuesday 6:20 AM");
    expect(lastBriefWords("2026-09-01T10:20:00.000Z", NOW, TZ)).toMatch(/^Tue, Sep 1 6:20 AM$/);
  });

  it("a Saturday, a partner with weekends off, an hour before any old start — all IDLE, all buildable", () => {
    // The profile's weekends and earliest_start_local no longer bear on a brief; the state takes no schedule at all.
    const s = briefRunState(null, ON, EXP, new Date("2026-09-19T09:00:00.000Z"), TZ);
    expect(s.kind).toBe("idle");
    expect(s.button.enabled).toBe(true);
  });

  it("with no measured history the duration is labelled a guess, never presented as measured", () => {
    expect(usualWords({ usualSeconds: 264, slowSeconds: 313, measuredFrom: 0 })).toMatch(/at a guess — no run has been timed yet/);
    expect(usualWords(EXP)).toBe("usually 4–5 minutes");
  });
});

describe("words", () => {
  it("elapsed reads like a person says it", () => {
    expect(elapsedWords(45)).toBe("45s");
    expect(elapsedWords(80)).toBe("1m 20s");
    expect(elapsedWords(600)).toBe("10m");
    expect(elapsedWords(120)).toBe("2m");
  });
});

describe("the band", () => {
  it("shows a progress track only while moving, and never claims done before the row does", () => {
    for (const kind of ["requested", "running", "queued", "stalled"] as const) {
      expect(MOVING_KINDS.has(kind)).toBe(true);
      const f = progressFraction({ kind, elapsedSeconds: 10_000, usualSeconds: 264 });
      expect(f).not.toBeNull();
      expect(f!).toBeLessThanOrEqual(0.95);
    }
    expect(progressFraction({ kind: "arrived", elapsedSeconds: 10, usualSeconds: 264 })).toBeNull();
    expect(progressFraction({ kind: "failed_out", elapsedSeconds: 10, usualSeconds: 264 })).toBeNull();
    expect(progressFraction({ kind: "running", elapsedSeconds: 132, usualSeconds: 264 })).toBeCloseTo(0.5);
  });

  it("tones: arrived is good, failed out is danger, retrying and stalled are the gate, nothing is orange", () => {
    expect(toneClassFor("arrived")).toBe("notice notice-ok");
    expect(toneClassFor("failed_out")).toBe("notice notice-bad");
    expect(toneClassFor("retrying")).toBe("notice notice-gate");
    expect(toneClassFor("stalled")).toBe("notice notice-gate");
    expect(toneClassFor("running")).toBe("notice");
    expect(toneClassFor("idle")).toBe("notice");
  });

  it("the examined line is built only from facts the row carries", () => {
    const line = examinedLine({
      completedAt: "2026-09-19T10:21:00.000Z", preparedBy: "Wren", rawCount: 300, dedupedCount: 283, candidateCount: 30,
      model: "anthropic/claude-sonnet-5", requestedBy: "fu_sequoia_taylor", requestedAt: "2026-09-19T10:15:00.000Z", viewerId: "fu_sequoia_taylor",
    });
    expect(line).toMatch(/^built at .+ · by Wren · 300 items → 283 events → 30 considered · anthropic\/claude-sonnet-5 · requested by you at /);
    expect(examinedLine({ completedAt: null, preparedBy: null, rawCount: null, dedupedCount: null, candidateCount: null, model: null, requestedBy: null, requestedAt: null, viewerId: null })).toBe("");
  });

  it("what the press says comes from the server's answer: 202 requested, 200 already building, anything else the server's reason", () => {
    expect(pressOutcomeLine({ status: 202, data: { line: "Requested. The clock picks it up on its next tick, within a minute." } })).toMatch(/^Requested/);
    expect(pressOutcomeLine({ status: 200, data: { already: true, line: "Building — writing it. Started 1m 20s ago; usually 4–5 minutes." } })).toMatch(/started 1m 20s ago/i);
    expect(pressOutcomeLine({ status: 403, data: { error: "forbidden", detail: "only a Managing Partner may build another partner's brief" } })).toMatch(/only a Managing Partner/);
    expect(pressOutcomeLine({ status: 500, data: null })).toMatch(/HTTP 500/);
  });
});
