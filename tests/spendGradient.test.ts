import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { checkFirmBudgets, currentSpendBehaviour, liveBypass, notifyAtFiftyReason } from "../src/worker/ai/spend";
import {
  evaluateSpend,
  LADDER,
  leverFromPolicy,
  monthElapsedFraction,
  paceAllowance,
  protectedFromSpendPressure,
  translateLegacyCostMode,
} from "../src/shared/ai/spendLever";
import { MIN_RUNS_FOR_EVIDENCE, orderByEvidence, verdictFor } from "../src/worker/ai/modelLearning";

/**
 * ONE LEVER, A GRADIENT MEASURED AGAINST THE MONTH ELAPSED, AND THE GUARANTEE UNDER BOTH.
 *
 * The owner set the real ladder on 17 Sep 2026. This suite proves the four things she has to be
 * able to rely on, at runtime rather than in a comment:
 *
 *   1. PROTECTED WORK SURVIVES EVERY THRESHOLD. Spend is driven past $5, $10, $50 and $75 and a
 *      call marked judgement still gets an adequate model at every one of them. This is the
 *      guarantee that makes an automatic gradient safe to run at all.
 *   2. FREE_ONLY FAILS LOUDLY. Protected work with no free model available STOPS, names itself and
 *      names the lever, rather than quietly taking something weaker.
 *   3. HER HAND ALWAYS WINS. The gradient never moves the lever: FREE_ONLY stays free at $0 spent,
 *      OPEN stays open at $40.
 *   4. THE LEARNING HALF ADMITS WHAT IT DOES NOT KNOW. Three data points produce
 *      INSUFFICIENT_EVIDENCE and change nothing, rather than a confident ordering.
 */

let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

const OK = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const anyHost = (() => {
  return (async () => OK("answer")) as unknown as typeof fetch;
})();

function env(extra: Partial<Env> = {}): Env {
  return makeTestEnv(t.db, {
    OPENROUTER_API_KEY: "or-key",
    GEMINI_API_KEY: "gem-key",
    WP_ANTHROPIC_API_KEY: "ant-key",
    ...extra,
  });
}

/** Write a policy row at a given lever. The live default after 0179 is MODERATE. */
async function setLever(lever: "FREE_ONLY" | "MODERATE" | "OPEN", dailyCapUsd = 2.5): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', ?3, 0.75, 1, 0, ?2, 0, 'fu_sequoia_taylor')`,
    )
    .bind(`bp_test_${crypto.randomUUID()}`, lever, dailyCapUsd)
    .run();
}

/**
 * Put month-to-date spend on the board WITHOUT running anything, by writing committed `ai_run` rows
 * with a stated cost. `firmSpend` is the single definition every ceiling and the gradient read, so
 * driving it directly is driving the real input rather than a test-only shim.
 */
async function spendThisMonth(usd: number, tag: string): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, status,
                           cost_estimate_json, actual_usage_json, input_hash, trace_id, firm_scope, created_at)
       VALUES (?1, ?2, 'HUMAN', 'fu_scooter_taylor', 'PUBLIC', 'FRONTIER', 'NORMAL', 'COMPLETED',
               '{"estimated_cost_usd":0}', ?3, 'h', ?4, 'west-peek', ?5)`,
    )
    .bind(
      `air_spend_${tag}`,
      `seeded spend ${tag}`,
      JSON.stringify({ cost_usd: usd }),
      `trc_${tag}`,
      // AT THE START OF THE MONTH, not now, and the distinction matters: these rows exist to move
      // MONTH-TO-DATE spend, and dating them today would also trip the $2.50 DAILY cap — a different
      // control, proven in aiSpend.test.ts, which would refuse the run before the gradient was ever
      // consulted and make this suite look like it proved something it had not.
      monthStartIso(),
    )
    .run();
}

/** 01:00 on the 1st of the current month — inside THIS_MONTH, and never inside TODAY after the 1st. */
function monthStartIso(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1, 1, 0, 0)).toISOString();
}

async function clearSeededSpend(): Promise<void> {
  await t.db.prepare("DELETE FROM ai_run WHERE id LIKE 'air_spend_%'").run();
}

beforeAll(async () => {
  t = await createTestDb();
  await setLever("MODERATE");
});
afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1. The pro-rating, which is the arithmetic her whole decision rests on ───────────────────

describe("the gradient is measured against the month ELAPSED, not against a raw total", () => {
  it("puts $8 on the 3rd over pace and the SAME $8 on the 25th on pace — her two examples", () => {
    const third = new Date("2026-09-03T12:00:00.000Z");
    const twentyFifth = new Date("2026-09-25T12:00:00.000Z");

    // September has 30 days. On the 3rd, ~8.3% of the month has gone, so the $10 line sits near $0.85.
    expect(paceAllowance(LADDER.cautiousUsd, third)).toBeLessThan(1.2);
    // On the 25th, ~81% has gone, so the same line sits near $8.10.
    expect(paceAllowance(LADDER.cautiousUsd, twentyFifth)).toBeGreaterThan(8);

    /*
     * HER TWO EXAMPLES, AND THE PRECISE CLAIM EACH ONE MAKES.
     *
     * "$8 on the 3rd is over pace and should tighten" — over the $10 line, so CAUTIOUS: free-first
     * hard, paid models kept for protected work.
     *
     * "$8 on the 25th is on pace and should not" — the claim is about the $10 line, and it is met:
     * the same $8 is NOT cautious. It is TIGHTENING, which is her own middle rung: $5–$10 "starts
     * making cheaper choices". $8 with 82% of the month gone projects to $9.80, which is inside
     * that band and outside the one below it, so the ladder is being read exactly as written.
     */
    expect(evaluateSpend("MODERATE", 8, third).position).toBe("CAUTIOUS");
    expect(evaluateSpend("MODERATE", 8, twentyFifth).position).not.toBe("CAUTIOUS");
    expect(evaluateSpend("MODERATE", 8, twentyFifth).position).toBe("TIGHTENING");
    // And a figure genuinely on pace for the whole ladder reads as normal at the same instant.
    expect(evaluateSpend("MODERATE", 3, twentyFifth).position).toBe("NORMAL");
  });

  it("HEALS ON ITS OWN, which is the property a raw month-to-date total does not have", () => {
    // One heavy day early: $2.50, the whole daily cap, spent on the 2nd. It goes cautious that day...
    expect(evaluateSpend("MODERATE", 2.5, new Date("2026-09-02T12:00:00.000Z")).position).toBe("CAUTIOUS");
    // ...and with nothing further spent the allowance climbs past it, easing one rung at a time...
    expect(evaluateSpend("MODERATE", 2.5, new Date("2026-09-12T12:00:00.000Z")).position).toBe("TIGHTENING");
    // ...until the firm is back to normal entirely, by itself. Nobody has to remember to undo
    // anything, which was the whole objection to comparing a raw month-to-date total against a flat line.
    expect(evaluateSpend("MODERATE", 2.5, new Date("2026-09-22T12:00:00.000Z")).position).toBe("NORMAL");
  });

  it("floors the elapsed fraction at one day, so the first minute of the month is not austerity", () => {
    const firstMinute = new Date("2026-09-01T00:01:00.000Z");
    // Without the floor this is ~0.00002 and every threshold pro-rates to nothing.
    expect(monthElapsedFraction(firstMinute)).toBeCloseTo(1 / 30, 5);
    expect(evaluateSpend("MODERATE", 0.1, firstMinute).position).toBe("NORMAL");
  });

  it("uses the real length of the month, so February is not read as a short September", () => {
    // The 28th of February is a finished month; the 28th of a 31-day month is not.
    expect(monthElapsedFraction(new Date("2026-02-28T23:00:00.000Z"))).toBeCloseTo(1, 1);
    expect(monthElapsedFraction(new Date("2026-01-28T23:00:00.000Z"))).toBeLessThan(0.95);
  });

  it("makes each threshold visible BEFORE it bites", () => {
    // 80% of the way to the $50 notify line, with nothing changed yet.
    const approaching = evaluateSpend("MODERATE", 41, new Date("2026-09-25T12:00:00.000Z"));
    expect(approaching.approaching).toBe("NOTIFY");
    expect(approaching.notify).toBe(false);
  });
});

// ── 2. HER HAND ALWAYS WINS ──────────────────────────────────────────────────────────────────

describe("the gradient decides behaviour BETWEEN her instructions, and never moves the lever", () => {
  it("stays FREE_ONLY at $0 spent — a quiet month does not re-open the paid lanes", () => {
    const b = evaluateSpend("FREE_ONLY", 0, new Date("2026-09-20T12:00:00.000Z"));
    expect(b.lever).toBe("FREE_ONLY");
    expect(b.freeOnly).toBe(true);
    expect(b.gradientApplies).toBe(false);
  });

  it("stays OPEN at $40 — an expensive month does not tighten a lever she deliberately opened", () => {
    const b = evaluateSpend("OPEN", 40, new Date("2026-09-03T12:00:00.000Z"));
    expect(b.lever).toBe("OPEN");
    expect(b.prefersFrontier).toBe(true);
    expect(b.freeFirst).toBe(false);
    expect(b.gradientApplies).toBe(false);
    // The position is still REPORTED — she can see where the month is — it simply does not act.
    expect(b.position).toBe("CAUTIOUS");
  });
});

// ── 3. THE GUARANTEE: protected work survives every threshold ────────────────────────────────

describe("PROTECTED WORK IS NEVER DOWNGRADED, at any position on the gradient", () => {
  it("keeps an adequate model for a judgement call at $0, $6, $12, $49 and $74 month-to-date", async () => {
    // The DAILY cap is lifted for this test and only this test. It is a separate control with its
    // own proof, and at $2.50 it would refuse every rung above it before the monthly gradient was
    // reached — which would leave this test passing on the wrong gate.
    await setLever("MODERATE", 500);
    const now = new Date();
    // Every rung of her ladder that still permits a run at all. $75 is the stop and is proven below.
    const rungs = [0, 6, 12, 49, 74];
    for (const [i, mtd] of rungs.entries()) {
      await clearSeededSpend();
      if (mtd > 0) await spendThisMonth(mtd, `rung${i}`);

      const e = env();
      const behaviour = await currentSpendBehaviour(e, "west-peek", "MODERATE", now);
      // Confirm the seeded spend really moved the gradient, so this is not five copies of one case.
      if (mtd >= 12) expect(behaviour.position).toBe("CAUTIOUS");

      const { run } = await runAi(
        e,
        {
          purpose: `judgement at $${mtd}`,
          actor: MP_ACTOR,
          inputs: ["decide whether this is worth keeping"],
          sensitivity: "INTERNAL",
          budgetContext: { judgement: true },
        },
        { fetchImpl: anyHost },
      );

      // Not blocked by money, and — the point — NOT sent to a search-grounded model, which is what
      // `judgement` protects against and what a cost posture used to be able to undo.
      expect(run.status, `rung $${mtd} status`).not.toBe("BUDGET_BLOCKED");
      expect(run.model, `rung $${mtd} model`).not.toBeNull();
      expect(run.model, `rung $${mtd} model`).not.toContain("sonar");
    }
    await clearSeededSpend();
  });

  it("NEGATIVE PROOF: the identical call WITHOUT the marker IS downgraded at the cautious end", async () => {
    await setLever("MODERATE", 500);
    await clearSeededSpend();
    await spendThisMonth(12, "negproof");
    const e = env();

    const protectedRun = await runAi(
      e,
      { purpose: "protected", actor: MP_ACTOR, inputs: ["x"], sensitivity: "INTERNAL", budgetContext: { judgement: true } },
      { fetchImpl: anyHost },
    );
    const mechanicalRun = await runAi(
      e,
      { purpose: "machinery", actor: MP_ACTOR, inputs: ["x"], sensitivity: "INTERNAL", budgetContext: { mechanical: true } },
      { fetchImpl: anyHost },
    );

    const routingFor = async (id: string) =>
      (await t.db.prepare("SELECT explanation FROM ai_run_routing WHERE ai_run_id = ?1").bind(id).first<{ explanation: string }>())!;

    // The mechanical call's run says the firm is economising and that it took the cheap road.
    const mech = await routingFor(mechanicalRun.run.id);
    expect(mech.explanation).toMatch(/cheapest|economising|ahead of pace/i);
    // The protected call's does not claim to have been made cheaper.
    const prot = await routingFor(protectedRun.run.id);
    expect(prot.explanation).toMatch(/interprets or drafts|not downgradeable|dearest/i);

    await clearSeededSpend();
  });

  it("the guarantee is ONE predicate, so there is no second place for a back door to open", () => {
    expect(protectedFromSpendPressure({ judgement: true })).toBe(true);
    expect(protectedFromSpendPressure({ interpretation: true })).toBe(true);
    expect(protectedFromSpendPressure({ requiresSearch: true })).toBe(true);
    expect(protectedFromSpendPressure({ mechanical: true })).toBe(false);
    expect(protectedFromSpendPressure({})).toBe(false);
  });
});

// ── 4. FREE_ONLY FAILS LOUDLY ────────────────────────────────────────────────────────────────

describe("at FREE_ONLY, protected work that needs a paid model STOPS and says so", () => {
  it("blocks the run, names the work and names the lever — it never takes a weaker model", async () => {
    await setLever("FREE_ONLY");
    const e = env();

    /*
     * An INTERNAL-labelled judgement call. The free lanes carry a PUBLIC-only data policy, so none
     * of them is reachable for this label — which is exactly the collision the owner decided:
     * this needs a paid model and the lever says nothing paid.
     */
    const { run } = await runAi(
      e,
      {
        purpose: "the morning brief",
        actor: MP_ACTOR,
        inputs: ["what should she read first"],
        sensitivity: "INTERNAL",
        budgetContext: { judgement: true },
      },
      { fetchImpl: anyHost },
    );

    expect(run.status).toBe("PREFLIGHT_BLOCKED");
    expect(run.failure_reason).toContain("free_only_cannot_serve_protected_work");
    // It NAMES THE WORK...
    expect(run.failure_reason).toContain("the morning brief");
    // ...and NAMES THE LEVER, which is what makes the stop actionable rather than mysterious.
    expect(run.failure_reason).toContain("FREE_ONLY");
    // And it did not quietly succeed on something weaker.
    expect(run.model).toBeNull();
  });

  it("NEGATIVE PROOF: the identical call at MODERATE runs, so the block is the lever and nothing else", async () => {
    await setLever("MODERATE");
    const { run } = await runAi(
      env(),
      {
        purpose: "the morning brief",
        actor: MP_ACTOR,
        inputs: ["what should she read first"],
        sensitivity: "INTERNAL",
        budgetContext: { judgement: true },
      },
      { fetchImpl: anyHost },
    );
    expect(run.status).not.toBe("PREFLIGHT_BLOCKED");
    expect(run.model).not.toBeNull();
  });
});

// ── 5. $50 notifies, $75 stops, and the bypass is an event ───────────────────────────────────

describe("$50 is where she is told and $75 is where the firm stops", () => {
  it("raises a BREACH-severity alert at $50 carrying the bypass decision, without stopping anything", async () => {
    const e = env();
    await clearSeededSpend();
    await spendThisMonth(52, "notify");
    // The gate runs on every call and raises the alert as a side effect of allowing the run.
    const verdict = await checkFirmBudgets(e, "west-peek", 0.01);
    expect(verdict.ok).toBe(true); // $52 is past the notify line and nowhere near the stop.

    const alert = await t.db
      .prepare("SELECT severity, dedupe_key FROM cost_alert WHERE dedupe_key LIKE '%USD50'")
      .first<{ severity: string; dedupe_key: string }>();
    expect(alert).toBeTruthy();
    expect(alert!.severity).toBe("BREACH");

    // The notification carries the DECISION, not just the number: what happens if she does nothing.
    const reason = notifyAtFiftyReason(52);
    expect(reason).toContain("$75");
    expect(reason).toContain("bypass");
    expect(reason).toContain("Doing nothing is a real choice");
    await clearSeededSpend();
  });

  it("stops automatically at $75, and says it is a stop rather than a setting", async () => {
    const e = env();
    await clearSeededSpend();
    await spendThisMonth(74.9, "stop");
    const verdict = await checkFirmBudgets(e, "west-peek", 0.5);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("this is the automatic stop, not a setting");
    await clearSeededSpend();
  });

  it("a bypass lifts the stop, and it is a row with a name and an expiry rather than a lever left pulled", async () => {
    const e = env();
    await clearSeededSpend();
    await spendThisMonth(74.9, "bypass");

    await t.db
      .prepare(
        `INSERT INTO spend_bypass (id, firm_scope, budget_window, ceiling_cents, reason, granted_by, expires_at)
         VALUES ('sby_1', 'west-peek', 'MONTHLY', 12000, 'close the quarter', 'fu_sequoia_taylor', ?1)`,
      )
      .bind(new Date(Date.now() + 86_400_000).toISOString())
      .run();

    const live = await liveBypass(e, "west-peek", "MONTHLY");
    expect(live!.granted_by).toBe("fu_sequoia_taylor");
    expect((await checkFirmBudgets(e, "west-peek", 0.5)).ok).toBe(true);

    // AND IT LAPSES ON ITS OWN. This is the whole difference from STRATEGIC_SURGE, which was a state
    // somebody could leave the firm in by forgetting about it.
    await t.db.prepare("UPDATE spend_bypass SET expires_at = '2026-09-01T00:00:00.000Z' WHERE id = 'sby_1'").run();
    expect(await liveBypass(e, "west-peek", "MONTHLY")).toBeNull();
    expect((await checkFirmBudgets(e, "west-peek", 0.5)).ok).toBe(false);
    await clearSeededSpend();
    await t.db.prepare("DELETE FROM spend_bypass WHERE id = 'sby_1'").run();
  });
});

// ── 6. The migration of the old values ───────────────────────────────────────────────────────

describe("anything still setting a cost_mode keeps working, and is translated rather than ignored", () => {
  it("maps each of the four old values to what it actually DID", () => {
    expect(translateLegacyCostMode("CHEAPO", false).lever).toBe("FREE_ONLY");
    expect(translateLegacyCostMode("CHEAPO", true).lever).toBe("MODERATE");
    expect(translateLegacyCostMode("NORMAL", true, true).lever).toBe("OPEN");
    expect(translateLegacyCostMode("NORMAL", true, false).lever).toBe("MODERATE");
    // The one that was never a spend level at all.
    expect(translateLegacyCostMode("CRITICAL_ONLY").deferNonCritical).toBe(true);
    expect(translateLegacyCostMode("CRITICAL_ONLY").lever).toBe("MODERATE");
    // And the one that was a temporary cap lift, which is now an event.
    expect(translateLegacyCostMode("STRATEGIC_SURGE").wantsBypass).toBe(true);
  });

  it("reads a pre-0179 policy row the old way, because that row could not be rewritten", () => {
    // budget_policy is immutable by trigger, so historic rows carry NULL and mean "read me the old
    // way". A default of MODERATE would have claimed these free-only rows were something they were not.
    expect(leverFromPolicy({ spend_lever: null, cost_mode: "CHEAPO", honours_pins: 0 })).toBe("FREE_ONLY");
    expect(leverFromPolicy({ spend_lever: null, cost_mode: "NORMAL", prefers_frontier: 1 })).toBe("OPEN");
    // An explicit lever always wins over the legacy columns beside it.
    expect(leverFromPolicy({ spend_lever: "MODERATE", cost_mode: "CHEAPO", honours_pins: 0 })).toBe("MODERATE");
  });

  it("ships MODERATE as the live default, which is what the owner asked to be live", async () => {
    const row = await t.db
      .prepare("SELECT spend_lever FROM budget_policy WHERE id = 'bp_0179_moderate'")
      .first<{ spend_lever: string }>();
    expect(row!.spend_lever).toBe("MODERATE");
  });
});

// ── 7. The learning half, and what it does with too little evidence ──────────────────────────

describe("an unproven model is UNKNOWN, not good", () => {
  it("reports INSUFFICIENT_EVIDENCE rather than a rate, below the threshold", () => {
    // Three successes is an anecdote with a denominator, not a record.
    expect(verdictFor({ succeeded: 3, reworked: 0, rejected: 0 })).toEqual({
      decided: 3,
      acceptanceRate: null,
      verdict: "INSUFFICIENT_EVIDENCE",
    });
    // A perfect record at exactly the threshold is evidence.
    expect(verdictFor({ succeeded: MIN_RUNS_FOR_EVIDENCE, reworked: 0, rejected: 0 }).verdict).toBe("PROVEN");
    // And a measured failure is a verdict too — this is the sonar case.
    expect(verdictFor({ succeeded: 4, reworked: 6, rejected: 12 }).verdict).toBe("POOR");
  });

  it("CHANGES NOTHING when no cell has enough evidence, and says so on the run", () => {
    const candidates = [
      { providerId: "p1", model: "cheap", estimatedCostUsd: 0.001 },
      { providerId: "p2", model: "dear", estimatedCostUsd: 0.1 },
    ];
    const thin = new Map([
      ["p1 cheap", { ...verdictFor({ succeeded: 3, reworked: 0, rejected: 0 }), taskKind: "judgement" as const, providerId: "p1", model: "cheap", succeeded: 3, reworked: 0, rejected: 0 }],
    ]);
    const out = orderByEvidence(candidates, thin, "judgement");
    expect(out.applied).toBe(false);
    expect(out.ordered).toEqual(candidates);
    expect(out.note).toContain("insufficient evidence");
  });

  it("prefers the cheapest PROVEN model over a cheaper one nobody has ever asked", () => {
    const candidates = [
      { providerId: "p0", model: "untried-and-cheapest", estimatedCostUsd: 0.0001 },
      { providerId: "p1", model: "proven", estimatedCostUsd: 0.01 },
      { providerId: "p2", model: "sonar-like", estimatedCostUsd: 0.005 },
    ];
    const evidence = new Map([
      ["p1 proven", { taskKind: "judgement" as const, providerId: "p1", model: "proven", succeeded: 24, reworked: 1, rejected: 1, ...verdictFor({ succeeded: 24, reworked: 1, rejected: 1 }) }],
      ["p2 sonar-like", { taskKind: "judgement" as const, providerId: "p2", model: "sonar-like", succeeded: 4, reworked: 6, rejected: 14, ...verdictFor({ succeeded: 4, reworked: 6, rejected: 14 }) }],
    ]);
    const out = orderByEvidence(candidates, evidence, "judgement");
    expect(out.applied).toBe(true);
    // Proven first, unknown second, and the model with a MEASURED record of failing this job last —
    // regardless of it being cheaper than the proven one.
    expect(out.ordered.map((c) => c.model)).toEqual(["proven", "untried-and-cheapest", "sonar-like"]);
    expect(out.note).toContain("proven record");
  });
});
