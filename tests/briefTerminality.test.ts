import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { closeUnfinishableReports } from "../src/worker/services/dailyIntelligence";
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
    // STRICTER THAN "AT LEAST TWO" (19 Sep 2026): there is ONE SQL done-query left — `runDailyForAll`'s —
    // and it uses the fragment; the second one, `briefsOwedToday`, was the sweep job's gate and is
    // gone with the branch it gated. A second done-query written by hand is exactly the drift this
    // pin exists for, so any SQL that filters intelligence_report on a READY/FAILED pair must be
    // the shared fragment, and the tick must ask `briefTerminality` rather than SQL at all.
    expect(service.match(/\$\{TERMINAL_SQL\}/g)?.length ?? 0, "the remaining SQL done-query does not use the shared fragment").toBeGreaterThanOrEqual(1);
    expect(service, "briefsOwedToday is back — the brief must not ride inside the sweep job again").not.toMatch(/briefsOwedToday/);
    const handWritten = service.match(/status\s*=\s*'FAILED'\s*AND\s*attempts\s*>=/g) ?? [];
    expect(handWritten, "a hand-written FAILED-and-spent predicate exists outside the shared fragment").toEqual([]);
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
    expect(service, "the button does not identify itself as a request, with the presser's name").toMatch(
      /startReport\(ctx\.env, firmScope, target, now, "requested", actor\.firmUserId \?\? null\)/,
    );
    // And the request is a FACT ON THE ROW — the card reads it back, nothing infers it.
    expect(service).toMatch(/requested_at = CASE WHEN \?6 = 'requested' THEN \?8 ELSE intelligence_report\.requested_at END/);
    expect(service).toMatch(/requested_by = CASE WHEN \?6 = 'requested' THEN \?7/);
  });
});

/**
 * AND THE RECOVERY ACTUALLY FIRES — the shipped function, against a real migrated database.
 *
 * Everything above this point reasons about strings. A predicate that reads correctly and selects
 * nothing is the "runs but inert" defect with a nicer face, and it is the one this repo keeps
 * shipping: `closeUnfinishableReports` returning 0 for ever would look exactly like a morning on
 * which nothing was stranded. So the real exported function is run here over the real 18 Sep row
 * shapes, plus the five healthy shapes it must NOT touch.
 *
 * The parameter order is part of what this proves: `?3` appears BEFORE `?1` and `?2` in the
 * statement, so a binder going by position rather than by index would write a timestamp into
 * `error_message` and leave her with a date where the reason should be.
 */
describe("the stranded recovery selects exactly the right rows", () => {
  let db: TestDb;
  let env: Env;

  const NOW = new Date("2026-09-18T15:20:00.000Z");

  //  id            status        attempts  lease                        stage_at                     close?  why
  const ROWS: Array<[string, string, number, string | null, string, boolean, string]> = [
    ["hers",        "GENERATING", 3, null,                       "2026-09-18T14:41:47.366Z", true,  "the real stranded row"],
    ["his",         "FAILED",     3, null,                       "2026-09-18T12:40:06.505Z", false, "already terminal, and it has a reason"],
    ["ready",       "READY",      1, null,                       "2026-09-18T11:00:00.000Z", false, "delivered"],
    ["budget_left", "GENERATING", 2, null,                       "2026-09-18T14:41:47.366Z", false, "still has attempts — must self-heal"],
    ["between",     "RANKING",    3, null,                       "2026-09-18T15:18:00.000Z", false, "moved 2 min ago: alive between stages"],
    ["leased",      "GENERATING", 3, "2026-09-18T15:25:00.000Z", "2026-09-18T14:00:00.000Z", false, "a stage is in flight right now"],
    ["lease_dead",  "GENERATING", 3, "2026-09-18T15:05:00.000Z", "2026-09-18T14:00:00.000Z", true,  "lease expired and it never moved"],
  ];

  beforeAll(async () => {
    db = await createTestDb();
    env = makeTestEnv(db.db);
    await env.WP_OS_DB.prepare(
      "INSERT OR IGNORE INTO firm_user (id, full_name, email, status) VALUES ('fu_probe','Probe','probe@example.com','ACTIVE')",
    ).run();
    for (const [id, status, attempts, lease, stageAt] of ROWS) {
      await env.WP_OS_DB.prepare(
        `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, attempts,
                                          stage_lease_until, stage_at, started_at, firm_scope)
         VALUES (?1,'fu_probe',?2,?3,?4,?5,?6,?6,'west-peek')`,
      ).bind(id, `2026-09-${10 + ROWS.findIndex((r) => r[0] === id)}`, status, attempts, lease, stageAt).run();
    }
  });

  afterAll(async () => {
    await disposeTestDb(db);
  });

  it("closes the stranded ones, leaves every healthy one alone, and writes the real sentence", async () => {
    const closed = await closeUnfinishableReports(env, NOW);
    // HARD-FAIL ON AN EMPTY LOOP: a predicate that selects nothing proves nothing.
    expect(closed, "the recovery selected no rows at all — it is inert").toBeGreaterThan(0);

    for (const [id, , , , , shouldClose, why] of ROWS) {
      const r = await env.WP_OS_DB.prepare(
        "SELECT status, error_code, error_message FROM intelligence_report WHERE id = ?1",
      ).bind(id).first<{ status: string; error_code: string | null; error_message: string | null }>();
      expect(r?.error_code === "unfinishable", `${id} (${why})`).toBe(shouldClose);
      if (shouldClose) {
        expect(r?.status, `${id} was closed but not to a terminal status`).toBe("FAILED");
        expect(r?.error_message, `${id} was closed with no reason — that is the 18 Sep silence`).toBeTruthy();
        // And it must be the SENTENCE, not a bound timestamp: the ?3-before-?1 trap.
        expect(r?.error_message, `${id}'s reason is not the sentence — parameters bound by position`)
          .toMatch(/nothing further will be tried automatically/i);
      }
    }

    // The row that started all of this now reads as something a person can act on.
    const hers = await env.WP_OS_DB.prepare("SELECT error_message FROM intelligence_report WHERE id='hers'")
      .first<{ error_message: string }>();
    expect(hers?.error_message).toMatch(/stopped part-way through/i);
    expect(hers?.error_message).toMatch(/build it again/i);

    // AND IT IS NOW TERMINAL, so the tick will not pick it up again and spend another attempt.
    const after = briefTerminality("FAILED", 3);
    expect(after.terminal).toBe(true);
    expect(after.mustBeClosed).toBe(false);
  });
});
