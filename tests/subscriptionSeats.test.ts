import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { isSearchGrounded } from "../src/shared/ai/models";
import { isProviderOutage, outageKind, shouldBackOff } from "../src/shared/ai/providerFailure";
import { handleSubscriptionSeatReport } from "../src/worker/services/subscriptionSeats";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../src/worker/auth";
import type { RouteContext } from "../src/worker/router";
import { detectUsageLimit } from "../scripts/lib/seat-usage-limit.mjs";
import {
  CLAIM_TTL_MS,
  HEARTBEAT_FRESH_MS,
  MAX_CLAIM_ATTEMPTS,
  QUEUE_TTL_MS,
  SEATS,
  allSeatAvailability,
  claimRun,
  clearSeatExhaustion,
  exhaustionCooldownSeconds,
  isExhausted,
  isFresh,
  laneAvailability,
  markSeatExhausted,
  parkRun,
  reapSeatRuns,
  recordHeartbeat,
  reportRun,
} from "../src/worker/ai/subscriptionSeats";

/**
 * TWO SEATS SHE ALREADY PAYS FOR — and, above everything else here, THE PROOF THAT NEITHER MATTERS.
 *
 * The one property this whole design has to have is that it is a CHAIN MEMBER AND NEVER A
 * DEPENDENCY. Her Mac sleeps, the lid closes, she travels; a firm whose work stops when a laptop
 * shuts is worse than a firm that never had the lane. So the first describe block in this file
 * deletes every heartbeat and proves the work still completes, and the rest of the file is only
 * worth reading if that one passes.
 *
 * The other things proven here, each traceable to a specific way this could go wrong:
 *
 *   · A STALE SEAT COSTS NOTHING. Not "is skipped quickly" — is never assembled, parks no row, and
 *     waits zero milliseconds. A timeout would have made every private card pay for a shut lid.
 *   · THE SEATS ARE INDEPENDENT. Exactly one heartbeat fresh must offer exactly that seat. A shared
 *     "is the Mac awake" signal would have meant the first Claude Code hang cost the firm Codex too.
 *   · A SHUT LID DOES NOT ARM A BACK-OFF. `shouldBackOff` must exclude the seat-unavailable reason,
 *     or a laptop closed overnight walks the doubling to its one-hour ceiling and the seat is least
 *     available in the first hour of the morning, which is exactly when she has just opened it.
 *   · NOTHING IS STRANDED. A claim that goes quiet returns to the pool once and is closed the
 *     second time. This is the failure the sister system actually had in production — a run claimed
 *     at 22:10, never reported, and a task reading "running" for two days and eleven hours.
 *   · THE LADDER IS CLIMBABLE. Every rung registered ACTIVE must actually pass every gate the
 *     router applies, or it is registered, visible and permanently unreachable.
 */

let t: TestDb;

const MP_ACTOR: Actor = {
  type: "HUMAN",
  firmUserId: "fu_scooter_taylor",
  roles: ["MANAGING_PARTNER"],
  firmScopes: ["west-peek"],
};

/** A PRIVATE_MODEL_ONLY judgement call — the only shape the seats are ever offered. */
const PRIVATE_CALL = {
  purpose: "draft a note on the fund's position",
  inputs: ["Summarise where we landed and what to do next."],
  sensitivity: "INTERNAL" as never,
  actor: MP_ACTOR,
  budgetContext: { expectedOutputTokens: 200, judgement: true, confidential: true },
  routing: { category: "OPERATIONS" as const, taskClass: "employee-work" },
};

const openRouterAnswers = (model: string, text: string) => () =>
  new Response(
    JSON.stringify({ model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** Answers any vendor host with a plausible body, and records who was actually called. */
function anyVendor(text: string): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(new URL(url).host);
    return openRouterAnswers("anthropic/claude-sonnet-5", text)();
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function env(): Env {
  return makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
}

const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();

async function heartbeat(seat: (typeof SEATS)[number], ageMs: number, device = "mac-test"): Promise<void> {
  await recordHeartbeat(env(), { seat, deviceId: device, hostname: "her-mac" }, new Date(Date.now() - ageMs));
}

beforeAll(async () => {
  t = await createTestDb();
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 'fu_scooter_taylor')`,
    )
    .bind(`bp_${crypto.randomUUID()}`)
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

beforeEach(async () => {
  // Every case starts with both seats away and the queue empty. A heartbeat left behind by one case
  // silently deciding the next case's routing is precisely how a suite passes for the wrong reason.
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("THE ONE THAT MATTERS: no claimer at all, and the work still completes", () => {
  it("completes a private run with NEITHER seat ever having checked in", async () => {
    const rows = await t.db.prepare("SELECT COUNT(*) AS n FROM subscription_seat_device").first<{ n: number }>();
    expect(rows?.n, "the premise of this test is that no machine exists").toBe(0);

    const stub = anyVendor("the note, drafted");
    const { run } = await runAi(env(), PRIVATE_CALL, { fetchImpl: stub.fetchImpl });

    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("the note, drafted");
    // A network lane answered it. The seats did not merely fail — they were never in the way.
    expect(stub.seen.length).toBeGreaterThan(0);
  });

  it("parks NOTHING when no seat is available, so no claimer can ever find orphaned work", async () => {
    const stub = anyVendor("answered elsewhere");
    await runAi(env(), PRIVATE_CALL, { fetchImpl: stub.fetchImpl });
    const parked = await t.db.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run").first<{ n: number }>();
    expect(parked?.n, "a stale seat must not be assembled at all, let alone park a row").toBe(0);
  });

  it("completes with the seats registered but every heartbeat long stale — the ordinary night", async () => {
    await heartbeat("claude_code", 14 * 60 * 60 * 1000);
    await heartbeat("codex", 9 * 60 * 60 * 1000);

    const stub = anyVendor("still answered");
    const started = Date.now();
    const { run } = await runAi(env(), PRIVATE_CALL, { fetchImpl: stub.fetchImpl });
    const elapsed = Date.now() - started;

    expect(run.status).toBe("COMPLETED");
    /*
     * ZERO DELAY, ASSERTED AS A NUMBER. This is the whole argument for a heartbeat over a timeout:
     * the router's own wait is ninety seconds, so if a stale seat were being WAITED on rather than
     * skipped, this would take at least that long. Ten seconds is a generous ceiling for a test
     * machine doing real SQLite work and still two orders of magnitude below the failure it guards.
     */
    expect(elapsed).toBeLessThan(10_000);
    const parked = await t.db.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run").first<{ n: number }>();
    expect(parked?.n).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("availability is a heartbeat, and the rule is exact", () => {
  it("is fresh inside the window and stale outside it, on the boundary", () => {
    const now = new Date();
    expect(isFresh(new Date(now.getTime() - 1_000).toISOString(), now)).toBe(true);
    expect(isFresh(new Date(now.getTime() - (HEARTBEAT_FRESH_MS - 1_000)).toISOString(), now)).toBe(true);
    expect(isFresh(new Date(now.getTime() - (HEARTBEAT_FRESH_MS + 1_000)).toISOString(), now)).toBe(false);
  });

  it("never treats absence, nonsense or a future clock as freshness", () => {
    const now = new Date();
    expect(isFresh(null, now)).toBe(false);
    expect(isFresh(undefined, now)).toBe(false);
    expect(isFresh("not a date", now)).toBe(false);
    /*
     * A DEVICE WITH A BROKEN CLOCK MUST NOT BE ABLE TO CLAIM AVAILABILITY FOR EVER by pinging once
     * from next Tuesday. Small skew is tolerated because it is normal; an hour ahead is not.
     */
    expect(isFresh(iso(60 * 60 * 1000), now)).toBe(false);
    expect(isFresh(iso(5_000), now), "a few seconds of skew is ordinary and must not fail").toBe(true);
  });

  it("says WHY, in a sentence a person can act on, rather than returning a bare false", async () => {
    const never = await laneAvailability(env(), "claude_code");
    expect(never.available).toBe(false);
    expect(never.reason).toContain("ever checked in");

    await heartbeat("claude_code", 14 * 60 * 60 * 1000);
    const stale = await laneAvailability(env(), "claude_code");
    expect(stale.available).toBe(false);
    // The age, in words, because "14400000ms" on a partner's run explanation helps nobody.
    expect(stale.reason).toContain("hours ago");
    expect(stale.reason).toContain("Claude Code");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("the two seats are independent, which is the reason there are two", () => {
  it("offers the awake seat and not the sleeping one, in both directions", async () => {
    await heartbeat("claude_code", 5_000);
    await heartbeat("codex", 6 * 60 * 60 * 1000);
    let seats = await allSeatAvailability(env());
    expect(seats.find((s) => s.seat === "claude_code")?.available).toBe(true);
    expect(seats.find((s) => s.seat === "codex")?.available).toBe(false);

    // And the mirror image, because a bug that hard-codes one seat passes the first case alone.
    await t.db.prepare("DELETE FROM subscription_seat_device").run();
    await heartbeat("claude_code", 6 * 60 * 60 * 1000);
    await heartbeat("codex", 5_000);
    seats = await allSeatAvailability(env());
    expect(seats.find((s) => s.seat === "claude_code")?.available).toBe(false);
    expect(seats.find((s) => s.seat === "codex")?.available).toBe(true);
  });

  it("leads a private run on the one awake seat while the other sleeps, and says so on the run", async () => {
    await heartbeat("codex", 5_000);
    await heartbeat("claude_code", 20 * 60 * 60 * 1000);

    /*
     * The seat will not answer inside the test's patience, so the run ends up on a network lane —
     * which is fine and is not what is being asserted. What is asserted is that CODEX WAS OFFERED
     * THE WORK and Claude Code was not, which the parked row proves directly.
     */
    const stub = anyVendor("answered after the seat did not");
    await runAi(env(), PRIVATE_CALL, { fetchImpl: stub.fetchImpl });

    const parked = await t.db.prepare("SELECT seat FROM subscription_seat_run").all<{ seat: string }>();
    const seatsParked = (parked.results ?? []).map((r) => r.seat);
    expect(seatsParked, "the awake seat was offered the run").toContain("codex");
    expect(seatsParked, "the sleeping seat was never assembled").not.toContain("claude_code");
  }, 180_000);

  it("keeps a claimer that serves one seat away from the other seat's work", async () => {
    await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    const wrongSeat = await claimRun(env(), "mac-claude-only", ["claude_code"]);
    expect(wrongSeat, "a machine without Codex installed must never be handed a Codex run").toBeNull();

    const rightSeat = await claimRun(env(), "mac-both", ["claude_code", "codex"]);
    expect(rightSeat?.seat).toBe("codex");
  });

  it("refuses to claim for no seats at all rather than treating an empty list as 'any'", async () => {
    await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    expect(await claimRun(env(), "mac-confused", [])).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("a shut lid is not an outage to back off from", () => {
  it("chains on an unavailable seat but arms NO cooldown", () => {
    const reason = "subscription_seat_unavailable:her Mac last checked in 14 hours ago";
    // It must chain — otherwise a sleeping laptop stops the firm.
    expect(isProviderOutage(reason)).toBe(true);
    /*
     * And it must NOT cool. The heartbeat answers the same question every thirty seconds for free;
     * a cooldown on top would compound overnight to its one-hour ceiling and leave the seat least
     * available in the first hour of the morning, which is when she has just opened the laptop.
     */
    expect(shouldBackOff(reason)).toBe(false);
    // Named for what it is: a Cockpit reading "outage" sends somebody hunting a broken integration.
    expect(outageKind(reason)).toBe("SEAT_ASLEEP");
  });

  it("DOES back off when a seat is present and misbehaving, which is what a cooldown is for", () => {
    const reason = "subscription_seat_failed:Claude Code: the session was rate limited";
    expect(isProviderOutage(reason)).toBe(true);
    expect(shouldBackOff(reason)).toBe(true);
    expect(outageKind(reason)).toBe("CLAIMER_FAILED");
  });

  it("still refuses to chain a capability refusal from a seat", () => {
    // A seat cannot see a picture. Asking a second vendor finds one that will answer without it.
    expect(isProviderOutage("provider_cannot_see_images:codex")).toBe(false);
    expect(isProviderOutage("provider_cannot_read_documents:claude_code")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("nothing is stranded: the claim, the report and the reaper", () => {
  it("hands one run to exactly one claimer", async () => {
    await parkRun(env(), { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    const first = await claimRun(env(), "mac-a", ["claude_code"]);
    const second = await claimRun(env(), "mac-b", ["claude_code"]);
    expect(first?.id).toBeTruthy();
    expect(second, "the second claimer must get nothing, not the same row").toBeNull();
  });

  it("refuses a report from a machine that no longer holds the run", async () => {
    const id = await parkRun(env(), { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-a", ["claude_code"]);
    const impostor = await reportRun(env(), { runId: id, deviceId: "mac-b", outputText: "I answered it" });
    expect(impostor.accepted).toBe(false);
    // And it is told WHY, because the usual cause is a machine waking to find its run reassigned —
    // the system working correctly, and something to log calmly rather than retry.
    expect(impostor.detail).toContain("no longer claimed by you");

    const rightful = await reportRun(env(), { runId: id, deviceId: "mac-a", outputText: "the real answer" });
    expect(rightful.accepted).toBe(true);
  });

  it("records a reported failure as a result rather than losing it", async () => {
    const id = await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-a", ["codex"]);
    await reportRun(env(), { runId: id, deviceId: "mac-a", error: "codex exited 1" });
    const row = await t.db.prepare("SELECT status, error FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string; error: string }>();
    expect(row?.status).toBe("FAILED");
    expect(row?.error).toContain("codex exited 1");
  });

  it("returns a silent claim to the pool once, then closes it — never loops for ever", async () => {
    const id = await parkRun(env(), { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-a", ["claude_code"]);

    // The lid closed. Nobody is waiting: the router gave up long ago and this row has no waiter.
    const wellPast = new Date(Date.now() + CLAIM_TTL_MS + 60_000);
    const first = await reapSeatRuns(env(), wellPast);
    expect(first.examined).toBeGreaterThan(0);
    expect(first.returnedToPool).toContain(id);

    let row = await t.db.prepare("SELECT status, resolution, attempt_count FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string; resolution: string; attempt_count: number }>();
    expect(row?.status, "back in the pool for the next machine that wakes up").toBe("QUEUED");
    expect(row?.resolution).toContain("went quiet");

    // A second machine takes it and also dies. That is enough.
    await claimRun(env(), "mac-b", ["claude_code"]);
    const second = await reapSeatRuns(env(), new Date(wellPast.getTime() + CLAIM_TTL_MS + 60_000));
    expect(second.abandoned).toContain(id);

    row = await t.db.prepare("SELECT status, resolution, attempt_count FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string; resolution: string; attempt_count: number }>();
    expect(row?.status).toBe("ABANDONED");
    expect(row?.attempt_count).toBe(MAX_CLAIM_ATTEMPTS);
    // A sentence, not a code: this is what somebody reads when they ask why a card cost money.
    expect(row?.resolution).toContain("closed rather than offered again");
  });

  it("closes a queued run nobody ever took, so the subscription is not spent on a dead answer", async () => {
    const id = await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    const out = await reapSeatRuns(env(), new Date(Date.now() + QUEUE_TTL_MS + 60_000));
    expect(out.abandoned).toContain(id);
    const row = await t.db.prepare("SELECT status, resolution FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string; resolution: string }>();
    expect(row?.status).toBe("ABANDONED");
    expect(row?.resolution).toContain("answered on another lane");
  });

  it("leaves a fresh claim and a fresh queue row completely alone", async () => {
    const claimed = await parkRun(env(), { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-a", ["claude_code"]);
    const queued = await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });

    const out = await reapSeatRuns(env(), new Date());
    // Rule 0: it looked at both rows and deliberately touched neither. Examining zero would be a
    // reaper that had stopped reaping without anybody noticing.
    expect(out.examined).toBe(2);
    expect(out.returnedToPool).toHaveLength(0);
    expect(out.abandoned).toHaveLength(0);
    for (const id of [claimed, queued]) {
      const row = await t.db.prepare("SELECT status FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string }>();
      expect(["QUEUED", "CLAIMED"]).toContain(row?.status);
    }
  });

  it("never reopens something already terminal", async () => {
    const id = await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-a", ["codex"]);
    await reportRun(env(), { runId: id, deviceId: "mac-a", outputText: "done" });
    await reapSeatRuns(env(), new Date(Date.now() + 10 * CLAIM_TTL_MS));
    const row = await t.db.prepare("SELECT status, output_text FROM subscription_seat_run WHERE id = ?1").bind(id).first<{ status: string; output_text: string }>();
    expect(row?.status).toBe("REPORTED");
    expect(row?.output_text).toBe("done");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("the ladder is actually climbable", () => {
  /**
   * AN UNCLIMBABLE LADDER IS THE "RUNS BUT INERT" DEFECT WEARING A TABLE.
   *
   * A rung registered ACTIVE that the router can never choose is worse than one that is absent: it
   * shows on the Cockpit, it reads as capacity the firm has, and the first time anybody finds out
   * otherwise is the outage it was meant to survive.
   *
   * These are the REAL gates in this repo — there is no fast/general/frontier tier enum here, which
   * was checked rather than assumed. A rung must clear every one of them:
   *   · its provider is enabled and not kill-switched
   *   · a provider_data_policy row exists (the egress gate is default-deny)
   *   · its price was actually READ from a vendor (ILLUSTRATIVE/UNKNOWN are barred from ranking)
   *   · it supports reasoning (interpretation calls refuse a lane that does not)
   */
  it("every ACTIVE rung clears every gate the router applies", async () => {
    const rows = await t.db
      .prepare(
        `SELECT pm.id, pm.model, pm.supports_reasoning, pm.status, pm.registered_by,
                pr.provider_key, pr.enabled, pr.kill_switched,
                (SELECT COUNT(*) FROM provider_data_policy dp WHERE dp.provider_id = pr.id AND dp.allowed = 1) AS policies,
                (SELECT ps.input_per_mtok_usd FROM provider_pricing_snapshot ps
                  WHERE ps.provider_id = pr.id AND ps.model = pm.model ORDER BY ps.captured_at DESC LIMIT 1) AS price,
                pm.pricing_state
           FROM provider_model pm
           JOIN provider_registry pr ON pr.id = pm.provider_id
          WHERE pm.status = 'ACTIVE'`,
      )
      .all<{
        id: string; model: string; supports_reasoning: number; provider_key: string; registered_by: string;
        enabled: number; kill_switched: number; policies: number; price: number | null; pricing_state: string;
      }>();
    const active = rows.results ?? [];

    // RULE 0, MECHANICAL. A check that examined nothing has abstained, not passed — and this one
    // would silently pass on an empty catalogue, which is exactly the state a bad migration creates.
    expect(active.length, "examined ZERO active rungs — the catalogue or this query is wrong").toBeGreaterThanOrEqual(10);

    for (const r of active) {
      expect(r.enabled, `${r.provider_key}/${r.model} is ACTIVE on a disabled provider`).toBe(1);
      expect(r.kill_switched, `${r.provider_key}/${r.model} is ACTIVE on a kill-switched provider`).toBe(0);
      expect(r.policies, `${r.provider_key}/${r.model} has no allowed data policy, so egress default-deny bars it`).toBeGreaterThan(0);
      expect(r.price, `${r.provider_key}/${r.model} has no pricing snapshot, so it cannot be estimated`).not.toBeNull();
      expect(
        ["SOURCED", "STALE"],
        `${r.provider_key}/${r.model} carries a price nobody read, so it is barred from every cost comparison`,
      ).toContain(r.pricing_state);
      /*
       * ── REASONING IS DEMANDED OF THE LADDER'S RUNGS, AND ONLY OF THEM ──────────────────────
       *
       * `runAi` refuses a lane with `supports_reasoning = 0` for an INTERPRETATION call. The rungs
       * registered by 0187 and 0188 exist precisely to carry judgement work, so a wrong zero on one
       * of them leaves it registered, visible on the Cockpit, and permanently unreachable — the
       * "runs but inert" defect in a table, which is what this check is for.
       *
       * TWO PRE-EXISTING LANES ARE CORRECTLY EXEMPT, and running this check taught me why rather
       * than the other way round:
       *
       *   · `perplexity/sonar` is SEARCH-GROUNDED, and `isSearchGrounded` already bars it from
       *     judging on its own account. Demanding reasoning of it would be this check misfiring.
       *   · `workers_ai/@cf/ibm-granite/...` is the MECHANICAL tier — near-free, INTERNAL-safe, and
       *     deliberately used for machinery rather than thinking. It is reachable for every call it
       *     is meant to serve, which is the actual definition of not-inert.
       *
       * So the rule is not "every ACTIVE lane reasons" — that would be false and would have to be
       * loosened until it meant nothing. It is "every lane registered as a rung of this ladder can
       * actually be chosen for the work the ladder exists to carry".
       */
      if (isSearchGrounded(r.model)) continue;
      if (!/^migration:018[78]$/.test(r.registered_by ?? "")) continue;
      expect(
        r.supports_reasoning,
        `${r.provider_key}/${r.model} is ACTIVE but records supports_reasoning = 0, so every interpretation call refuses it`,
      ).toBe(1);
    }
  });

  it("takes the firm from ONE private-capable lane to nine", async () => {
    /*
     * THE NUMBER THIS WORK EXISTS TO MOVE. Before tonight `anthropic/claude-sonnet-5` was the only
     * lane allowed to see an LP name, so an OpenRouter outage meant confidential work could not run
     * at all. "Private-capable" here means exactly what the router means: ACTIVE, on a provider
     * whose terms do not permit training, with an egress policy that admits INTERNAL.
     */
    const row = await t.db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM provider_model pm
           JOIN provider_registry pr ON pr.id = pm.provider_id
          WHERE pm.status = 'ACTIVE'
            AND COALESCE(pr.training_permitted, 0) != 1
            AND EXISTS (SELECT 1 FROM provider_data_policy dp
                         WHERE dp.provider_id = pr.id AND dp.privacy_label = 'INTERNAL' AND dp.allowed = 1)`,
      )
      .first<{ n: number }>();
    expect(row?.n, "two subscription seats plus seven non-training network lanes").toBeGreaterThanOrEqual(9);
  });

  it("keeps every free rung PUBLIC-only — a :free lane may never see an LP name", async () => {
    const rows = await t.db
      .prepare(
        `SELECT pm.model, pm.max_data_class
           FROM provider_model pm JOIN provider_registry pr ON pr.id = pm.provider_id
          WHERE pr.training_permitted = 1`,
      )
      .all<{ model: string; max_data_class: string }>();
    const free = rows.results ?? [];
    expect(free.length, "examined ZERO training-permitting models — the query or the catalogue is wrong").toBeGreaterThan(0);
    for (const r of free) {
      expect(r.max_data_class, `${r.model} permits training and must be capped at PUBLIC`).toBe("PUBLIC");
    }
  });

  it("registers no seat above INTERNAL, in either direction", async () => {
    const rows = await t.db
      .prepare(
        `SELECT pr.provider_key, dp.privacy_label
           FROM provider_data_policy dp JOIN provider_registry pr ON pr.id = dp.provider_id
          WHERE pr.claimable = 1 AND dp.allowed = 1`,
      )
      .all<{ provider_key: string; privacy_label: string }>();
    const labels = rows.results ?? [];
    expect(labels.length, "examined ZERO seat egress rows").toBeGreaterThan(0);
    for (const r of labels) {
      /*
       * A seat is the safest destination in the catalogue — the material never leaves her machine —
       * and it is STILL not allowed CONFIDENTIAL. That guarantee predates this work, nobody asked
       * for it to be revisited, and a new lane quietly becoming the first thing ever permitted to
       * see MNPI should require its own argument rather than arriving as a side effect.
       */
      expect(["PUBLIC", "INTERNAL"], `${r.provider_key} was widened to ${r.privacy_label} without an argument`).toContain(r.privacy_label);
    }
  });
});


// ═════════════════════════════════════════════════════════════════════════════════════════════
describe("a seat whose plan is out of usage is skipped until it resets (0245)", () => {
  it("reads a notice as a limit and a real answer as an answer", () => {
    expect(detectUsageLimit({ stdout: "Claude AI usage limit reached|1759071600" }).limited).toBe(true);
    expect(detectUsageLimit({ stdout: "You've hit your limit · resets 3pm" }).limited).toBe(true);
    expect(detectUsageLimit({ stdout: "", stderr: "You've hit your usage limit. Try again in 3 hours." }).limited).toBe(true);
    expect(detectUsageLimit({ stdout: "The reserve ratio is 0.35 and the pacing is on plan." }).limited).toBe(false);
    // A real answer that discusses limits is long; long output is never inspected.
    expect(detectUsageLimit({ stdout: `usage limit reached is what it prints. ${"x".repeat(700)}` }).limited).toBe(false);
    expect(detectUsageLimit({ stdout: "" }).limited).toBe(false);
  });

  it("bounds the cooldown both ways and defaults when the notice names no time", () => {
    expect(exhaustionCooldownSeconds(undefined)).toBe(30 * 60);
    expect(exhaustionCooldownSeconds(null)).toBe(30 * 60);
    expect(exhaustionCooldownSeconds(5)).toBe(60);
    expect(exhaustionCooldownSeconds(10 * 24 * 60 * 60)).toBe(7 * 24 * 60 * 60);
    expect(exhaustionCooldownSeconds(7200)).toBe(7200);
  });

  it("makes ONLY the exhausted seat unavailable, and says why in a sentence", async () => {
    await heartbeat("claude_code", 5_000);
    await heartbeat("codex", 5_000);
    await markSeatExhausted(env(), { seat: "claude_code", deviceId: "mac-test", reason: "You've hit your limit", retryAfterSeconds: 3600 });

    const seats = await allSeatAvailability(env());
    const cc = seats.find((s) => s.seat === "claude_code")!;
    const cx = seats.find((s) => s.seat === "codex")!;
    expect(cc.available).toBe(false);
    expect(cc.reason).toContain("usage is spent");
    expect(cc.reason).toContain("You've hit your limit");
    expect(cx.available, "Codex is a different plan and stays offered").toBe(true);

    const single = await laneAvailability(env(), "claude_code");
    expect(single.available).toBe(false);
  });

  it("survives a heartbeat: an awake Mac that is out of usage is exactly what this records", async () => {
    await heartbeat("claude_code", 5_000);
    await markSeatExhausted(env(), { seat: "claude_code", deviceId: "mac-test", retryAfterSeconds: 3600 });
    await heartbeat("claude_code", 1_000);
    expect((await laneAvailability(env(), "claude_code")).available).toBe(false);
  });

  it("heals itself: after the cooldown the seat is offered work again with nobody flipping anything", async () => {
    await heartbeat("claude_code", 5_000);
    const { until } = await markSeatExhausted(env(), { seat: "claude_code", deviceId: "mac-test", retryAfterSeconds: 600 });
    const before = new Date(Date.parse(until) - 1_000);
    const after = new Date(Date.parse(until) + 1_000);
    expect(isExhausted({ exhausted_until: until }, before)).toBe(true);
    expect(isExhausted({ exhausted_until: until }, after)).toBe(false);
    // The heartbeat is also older than the freshness window by then, so refresh it at `after`.
    await recordHeartbeat(env(), { seat: "claude_code", deviceId: "mac-test" }, after);
    expect((await laneAvailability(env(), "claude_code", after)).available).toBe(true);
  });

  it("a real answer clears the cooldown at once", async () => {
    await heartbeat("codex", 5_000);
    await markSeatExhausted(env(), { seat: "codex", deviceId: "mac-test", retryAfterSeconds: 3600 });
    const id = await parkRun(env(), { seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-test", ["codex"]);
    await reportRun(env(), { runId: id, deviceId: "mac-test", outputText: "a real answer" });
    expect((await laneAvailability(env(), "codex")).available).toBe(true);
    // And clearing something not set is a no-op, not an error.
    await clearSeatExhaustion(env(), "codex", "mac-test");
  });

  it("the report route marks the seat exhausted when the claimer says its plan is out", async () => {
    await heartbeat("claude_code", 5_000);
    const id = await parkRun(env(), { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await claimRun(env(), "mac-test", ["claude_code"]);
    const ctx = {
      env: env(),
      identity: { email: SUBSCRIPTION_CLAIMER_EMAIL, roles: [] },
      request: new Request("https://example.test/api/subscription-seats/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_id: "mac-test",
          run_id: id,
          error: "Claude Code has run out of usage and said: usage limit reached",
          seat_exhausted: true,
          retry_after_seconds: 7200,
        }),
      }),
    } as unknown as RouteContext;
    const res = await handleSubscriptionSeatReport(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; seat_skipped_until?: string };
    expect(body.accepted).toBe(true);
    expect(body.seat_skipped_until).toBeTruthy();
    expect((await laneAvailability(env(), "claude_code")).available).toBe(false);
  });

  it("an exhausted Claude Code hands the private run to the Codex seat, with no 90-second wait and no Claude Code row parked", async () => {
    await heartbeat("claude_code", 5_000);
    await heartbeat("codex", 5_000);
    await markSeatExhausted(env(), { seat: "claude_code", deviceId: "mac-test", retryAfterSeconds: 3600 });

    const stub = anyVendor("SHOULD NOT BE REACHED");
    const running = runAi(env(), PRIVATE_CALL, { fetchImpl: stub.fetchImpl });

    // Play the Codex claimer: wait for the parked row, claim it, answer it.
    let parkedId: string | null = null;
    for (let i = 0; i < 200 && !parkedId; i++) {
      const row = await t.db.prepare("SELECT id, seat FROM subscription_seat_run WHERE status = 'QUEUED'").first<{ id: string; seat: string }>();
      if (row) {
        expect(row.seat, "the exhausted seat was never offered the run").toBe("codex");
        parkedId = row.id;
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    expect(parkedId, "the run was parked for the Codex seat").toBeTruthy();
    const claimed = await claimRun(env(), "mac-test", ["codex"]);
    expect(claimed?.id).toBe(parkedId);
    await reportRun(env(), { runId: parkedId!, deviceId: "mac-test", outputText: "answered by Codex on the subscription" });

    const { run } = await running;
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("answered by Codex");
    expect(stub.seen, "no paid vendor was called").toEqual([]);
    const parkedSeats = (await t.db.prepare("SELECT DISTINCT seat FROM subscription_seat_run").all<{ seat: string }>()).results ?? [];
    expect(parkedSeats.map((r) => r.seat)).toEqual(["codex"]);
  }, 60_000);
});
