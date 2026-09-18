import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_BRIEF_ATTEMPTS,
  STRANDED_SQL,
  TERMINAL_SQL,
  briefTerminality,
  strandedReason,
} from "../src/shared/intelligence/briefTerminality";

/**
 * A BRIEF ALWAYS ENDS STATED (18 Sep 2026).
 *
 * At 14:58 the two partners' rows for the day read:
 *
 *   fu_scooter_taylor   FAILED      attempts=3   "the brief was rejected twice: ..."
 *   fu_sequoia_taylor   GENERATING  attempts=3   error_message EMPTY
 *
 * His stage completed and the gate failed it, so the code that writes the reason ran. Hers was
 * evicted between the model returning (two `ai_run` rows completed at 14:56 and 14:57) and the
 * outcome being persisted — `stage_at` never moved from 14:41:47 — so nothing wrote anything. She
 * got a blank card with no reason; he got one that explained itself.
 *
 * THE PROPERTY: no (status, attempts) pairing may be at rest holding a spent budget in a
 * non-terminal status. Such a pairing is named `stranded` and must be flagged for closure, so that
 * the thing which cannot happen is DETECTED rather than described.
 */

/** Every status the brief's own table accepts, read off its CHECK constraint. */
function statusesFromSchema(): string[] {
  const sql = readFileSync(new URL("../migrations/0035_daily_intelligence_pipeline.sql", import.meta.url), "utf8");
  // Anchored to the table: the first `CHECK (status IN …)` in this file belongs to
  // `tracked_narrative`, and reading it would pass having tested none of the brief's statuses.
  const table = /CREATE TABLE IF NOT EXISTS intelligence_report\s*\(([\s\S]*?)\n\);/.exec(sql);
  if (!table) throw new Error("the intelligence_report table is no longer where this test reads it from");
  const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(table[1] ?? "");
  if (!m) throw new Error("the status CHECK constraint is no longer where this test reads it from");
  const list = (m[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  if (!list.includes("READY") || !list.includes("FAILED")) throw new Error(`read the wrong constraint: ${list}`);
  return list;
}

describe("every status and attempt count has a stated outcome", () => {
  it("resolves the full cross-product, and strands nothing silently", () => {
    const statuses = statusesFromSchema();
    expect(statuses.length, "read no statuses out of the schema").toBeGreaterThan(1);

    let examined = 0;
    for (const status of statuses) {
      for (let attempts = 0; attempts <= MAX_BRIEF_ATTEMPTS + 2; attempts++) {
        examined += 1;
        const t = briefTerminality(status, attempts);

        // EVERY PAIRING RESOLVES. A pairing with no kind is a pairing nothing handles.
        expect(t.kind, `${status}/${attempts} has no kind`).toBeTruthy();

        // THE INVARIANT: a spent budget in a non-terminal status is never left alone.
        const spent = attempts >= MAX_BRIEF_ATTEMPTS;
        const terminalStatus = status === "READY" || status === "FAILED";
        if (spent && !terminalStatus) {
          expect(t.kind, `${status}/${attempts} was not recognised as stranded`).toBe("stranded");
          expect(t.mustBeClosed, `${status}/${attempts} is stranded but nothing closes it`).toBe(true);
          expect(t.terminal, "a stranded row must not be reported as finished — it has no reason on it yet").toBe(false);
        } else {
          expect(t.mustBeClosed, `${status}/${attempts} was marked for closure but is not stranded`).toBe(false);
        }

        // A row marked for closure must never ALSO be reported finished: closing it is what puts
        // the reason on it, and skipping that step is exactly the 18 Sep silence.
        expect(t.terminal && t.mustBeClosed, `${status}/${attempts} is both finished and needing closure`).toBe(false);
      }
    }
    // HARD-FAIL ON AN EMPTY LOOP.
    expect(examined, "examined no pairings at all").toBeGreaterThan(10);
  });

  it("keeps the owner's three tries: a failure with budget left is retryable, the third is not", () => {
    // "if the brief doesnt land it should self heal and keep trying (at least 2 additional tries
    // for a total of 3 before it says broken)" — the number is hers and is not changed here.
    expect(MAX_BRIEF_ATTEMPTS).toBe(3);
    expect(briefTerminality("FAILED", 1).kind).toBe("retryable");
    expect(briefTerminality("FAILED", 1).terminal).toBe(false);
    expect(briefTerminality("FAILED", 2).kind).toBe("retryable");
    expect(briefTerminality("FAILED", 3).kind).toBe("failed_out");
    expect(briefTerminality("FAILED", 3).terminal, "the third failure must stop the cron retrying").toBe(true);
  });

  it("does not strand a healthy run that still has budget", () => {
    // The normal resting state between two ticks: mid-pipeline, attempts left. Must be left alone.
    for (const status of ["GATHERING", "RANKING", "GENERATING", "VERIFYING"]) {
      const t = briefTerminality(status, 1);
      expect(t.kind, `${status}/1 was disturbed`).toBe("in_progress");
      expect(t.mustBeClosed).toBe(false);
      expect(t.terminal).toBe(false);
    }
  });

  it("reports the real 18 Sep rows the way they should have been reported", () => {
    // His: ended stated, budget gone. Finished.
    expect(briefTerminality("FAILED", 3)).toMatchObject({ terminal: true, kind: "failed_out", mustBeClosed: false });
    // Hers: the one the system had no answer for.
    expect(briefTerminality("GENERATING", 3)).toMatchObject({ terminal: false, kind: "stranded", mustBeClosed: true });
  });

  it("gives a stranded row a sentence that says nothing further will happen on its own", () => {
    const said = strandedReason(MAX_BRIEF_ATTEMPTS);
    expect(said).toMatch(/stopped part-way through/i);
    // The thing her partner's row said and hers did not: what happens next.
    expect(said, "it does not say the automatic attempts are over").toMatch(/nothing further will be tried automatically/i);
    expect(said, "it does not tell her what she can do").toMatch(/build it again/i);
    // NEVER A COLUMN VALUE OR AN ERROR CODE IN HER SENTENCE.
    for (const leak of ["GENERATING", "unfinishable", "stage_at", "attempts >="]) {
      expect(said, `the sentence leaks ${leak}`).not.toContain(leak);
    }
  });
});

describe("the database and the code agree about finished", () => {
  const service = readFileSync(new URL("../src/worker/services/dailyIntelligence.ts", import.meta.url), "utf8");

  it("every done-query uses the shared fragment rather than its own predicate", () => {
    expect(TERMINAL_SQL).toContain(String(MAX_BRIEF_ATTEMPTS));
    // The hand-written form that drifted. If it comes back, so does the bug.
    expect(service, "a hand-written terminal predicate is back in the service").not.toMatch(
      /status = 'READY' OR \(status = 'FAILED' AND attempts >= \$\{MAX_BRIEF_ATTEMPTS\}\)/,
    );
    expect(service.match(/\$\{TERMINAL_SQL\}/g)?.length ?? 0, "the shared fragment is not used by both done-queries")
      .toBeGreaterThanOrEqual(2);
  });

  it("the tick asks the shared answer instead of testing FAILED by hand", () => {
    expect(service).toMatch(/briefTerminality\(row\.status, row\.attempts\)\.terminal/);
    expect(service, "the old skip guard is back — it misses a stranded row entirely").not.toMatch(
      /row\?\.status === "FAILED" && row\.attempts >= MAX_BRIEF_ATTEMPTS/,
    );
  });

  it("the stranded recovery exists, is bound, and runs before anything is advanced", () => {
    expect(service).toMatch(/export async function closeUnfinishableReports/);
    expect(service, "the recovery does not use the shared stranded predicate").toContain("${STRANDED_SQL}");
    // BEFORE, not after: a stranded row left in place is advanced again by this very tick.
    const recoveryCall = service.indexOf("closeUnfinishableReports(env, now)");
    const advance = service.indexOf("const step = await advanceBrief(env, actor, p.id, now, deps)");
    expect(recoveryCall, "the recovery is never called from the tick").toBeGreaterThan(-1);
    expect(recoveryCall, "the recovery runs after rows are advanced").toBeLessThan(advance);
  });

  it("the stranded predicate does not fire on a run that is merely between stages", () => {
    // Both guards must be present: no lease held, AND no movement for a whole stage's lease.
    expect(STRANDED_SQL).toMatch(/stage_lease_until IS NULL OR stage_lease_until </);
    expect(STRANDED_SQL).toMatch(/COALESCE\(stage_at, started_at\) </);
    expect(STRANDED_SQL).toContain("status NOT IN ('READY','FAILED')");
  });

  it("a requested rebuild starts the day's budget over, so the cron can still self-heal", () => {
    expect(service).toMatch(/CASE WHEN \?6 = 'requested' THEN 1 ELSE intelligence_report\.attempts \+ 1 END/);
    expect(service, "the button does not identify itself as a request").toMatch(
      /startReport\(ctx\.env, firmScope, target, now, "requested"\)/,
    );
  });
});
