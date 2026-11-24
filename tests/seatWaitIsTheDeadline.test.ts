import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { attemptDeadlineMs, MAX_ATTEMPT_MS, MIN_TOKENS_PER_SEC, searchAttemptDeadlineMs } from "../src/worker/ai/chainBudget";
import { CLAIM_TTL_MS, claimRun, reapSeatRuns, recordHeartbeat, reportRun, SEAT_RUN_GRACE_MS, SEAT_SEARCH_CAPABILITY } from "../src/worker/ai/subscriptionSeats";

/**
 * A SEAT WAITS AS LONG AS THE ATTEMPT, AND THE MAC AND THE REAPER READ THE SAME NUMBER (24 Nov 2026).
 *
 * Preston's edit of the Fund I deck declares 12,000 output tokens. Her Mac claimed it within seconds, every time, and the
 * router abandoned it at a fixed ninety seconds, forty-five times in twelve hours, with no other lane allowed to take it.
 * What has to be true: a deck-sized call waits minutes and gets the answer the Mac returns after ninety seconds; a small
 * call still gives up quickly; the claimer stops its child at the row's own `max_seconds` plus the shared grace, never
 * at a fixed timer; and the reaper never takes a claimed answer back while its router can still be waiting.
 */

let t: TestDb;
const env = (): Env => makeTestEnv(t.db, {});
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await disposeTestDb(t); });

const DECK_EDIT_TOKENS = 12_000;

async function adapterFor(clock: { ms: number }, onTick?: (ms: number) => Promise<void>) {
  const { createSubscriptionSeatAdapter } = await import("../src/worker/ai/providers/subscriptionSeat");
  return createSubscriptionSeatAdapter({
    env: env(),
    seat: "claude_code",
    modelAccess: "PRIVATE_MODEL_ONLY",
    pollMs: 5_000,
    sleep: async (ms) => { clock.ms += ms; await onTick?.(clock.ms); },
    now: () => new Date(clock.ms),
  });
}

describe("the router's wait for a seat is the attempt's own deadline", () => {
  it("a deck edit the Mac answers after 200 s is KEPT, and its row tells the Mac how long it has", async () => {
    const start = Date.parse("2026-11-24T16:00:00Z");
    const clock = { ms: start };
    await recordHeartbeat(env(), { seat: "claude_code", deviceId: "mac-deck", hostname: "her-mac", capabilities: [] }, new Date(clock.ms));
    let claimed: string | null = null;
    const adapter = await adapterFor(clock, async (ms) => {
      if (!claimed && ms - start >= 10_000) claimed = (await claimRun(env(), "mac-deck", ["claude_code"], new Date(ms)))?.id ?? null;
      if (claimed && ms - start >= 200_000) await reportRun(env(), { runId: claimed, deviceId: "mac-deck", outputText: '{"slides":[],"changes":["page 3 is Why Now"],"cannot":[]}' }, new Date(ms));
    });
    const deadlineMs = attemptDeadlineMs(DECK_EDIT_TOKENS);
    expect(deadlineMs, "a 12,000-token write is given at least what the slowest measured rate needs").toBeGreaterThanOrEqual((DECK_EDIT_TOKENS / MIN_TOKENS_PER_SEC) * 1000);
    const out = await adapter.complete({ purpose: "Apply a partner's change to the LP deck preview", inputs: ["edit"], model: null, deadlineMs });
    expect(out.text).toContain("page 3 is Why Now");
    const row = await t.db.prepare("SELECT max_seconds, status FROM subscription_seat_run WHERE id = ?1").bind(claimed).first<{ max_seconds: number; status: string }>();
    expect(row?.status).toBe("REPORTED");
    expect(row!.max_seconds).toBe(Math.round(deadlineMs / 1000));
    expect(row!.max_seconds, "longer than the old fixed 90 s").toBeGreaterThan(90);
  });

  it("a small ask still gives up at its own short deadline and closes its row", async () => {
    const start = Date.parse("2026-11-24T17:00:00Z");
    const clock = { ms: start };
    await recordHeartbeat(env(), { seat: "claude_code", deviceId: "mac-small", hostname: "her-mac", capabilities: [] }, new Date(clock.ms));
    const adapter = await adapterFor(clock);
    const deadlineMs = attemptDeadlineMs(400);
    await expect(adapter.complete({ purpose: "Small ask", inputs: ["x"], model: null, deadlineMs })).rejects.toThrow(/subscription_seat_unavailable/);
    expect(clock.ms - start).toBeLessThanOrEqual(deadlineMs);
    expect(deadlineMs).toBeLessThan(120_000);
    const row = await t.db.prepare("SELECT status FROM subscription_seat_run WHERE purpose = 'Small ask'").first<{ status: string }>();
    expect(row?.status).toBe("ABANDONED");
  });

  it("a search is still given the longest attempt (measured searches ran 114 to 348 s)", () => {
    expect(searchAttemptDeadlineMs()).toBe(MAX_ATTEMPT_MS);
    expect(MAX_ATTEMPT_MS).toBeGreaterThanOrEqual(378_000);
    // The whole wait plus the Mac's grace fits inside the Worker's 15-minute scheduled limit.
    expect(MAX_ATTEMPT_MS + SEAT_RUN_GRACE_MS).toBeLessThan(900_000);
  });
});

describe("the Mac and the reaper read the row's max_seconds, not a fixed timer of their own", () => {
  it("the claimer's grace is the Worker's grace, and it has no fixed run timeout left", () => {
    const claimer = readFileSync(new URL("../scripts/claimer/subscription-seat-claimer.mjs", import.meta.url), "utf8");
    const grace = /const SEAT_RUN_GRACE_MS = ([\d_]+);/.exec(claimer);
    expect(grace).toBeTruthy();
    expect(Number(grace![1]!.replace(/_/g, ""))).toBe(SEAT_RUN_GRACE_MS);
    expect(claimer).not.toMatch(/const (SEARCH_)?RUN_TIMEOUT_MS =/);
    const runOnSeat = claimer.split("async function runOnSeat")[1]!.split("\n}\n")[0]!;
    expect(runOnSeat).toMatch(/const timeoutMs = runTimeoutMs\(maxSeconds\);/);
    expect(claimer.match(/runOnSeat\(seat, prompt, \{[^}]*maxSeconds: run\.max_seconds/g)?.length, "both call sites pass the row's ceiling").toBe(2);
  });

  it("a claimed deck edit is left alone past five minutes while its router can still be waiting, and only then returned", async () => {
    const { parkRun } = await import("../src/worker/ai/subscriptionSeats");
    const start = Date.parse("2026-11-24T18:00:00Z");
    await recordHeartbeat(env(), { seat: "claude_code", deviceId: "mac-reap", hostname: "her-mac", capabilities: [] }, new Date(start));
    await parkRun(env(), { id: "ccr_reap_deck", seat: "claude_code", purpose: "Reap test", prompt: "p", modelAccess: "PRIVATE_MODEL_ONLY", maxSeconds: 450 } as never);
    const got = await claimRun(env(), "mac-reap", ["claude_code"], new Date(start));
    expect(got?.id).toBe("ccr_reap_deck");
    const status = async () => (await t.db.prepare("SELECT status FROM subscription_seat_run WHERE id = 'ccr_reap_deck'").first<{ status: string }>())!.status;
    await reapSeatRuns(env(), new Date(start + CLAIM_TTL_MS + 60_000));
    expect(await status(), "six minutes in, the router may still be waiting").toBe("CLAIMED");
    await reapSeatRuns(env(), new Date(start + 450_000 + SEAT_RUN_GRACE_MS + 1_000));
    expect(await status(), "past its own ceiling and grace, it goes back to the pool").toBe("QUEUED");
  });
});
