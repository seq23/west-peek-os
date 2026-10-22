import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { allSeatAvailability, laneAvailability, recordHeartbeat, seatVerdict, type DeviceRow } from "../src/worker/ai/subscriptionSeats";

/**
 * ONE SEAT, TWO CLAIMERS ON THE SAME MAC (22 Oct 2026). The seat claimer declares "web_search"; the
 * local-jobs claimer declares "local_job" and heartbeats on the same claude_code seat. Reading only
 * the newest row made the Claude Code seat look unable to search whenever the jobs claimer checked
 * in last, so Parker's and Wynn's TLC searches skipped it, landed on a failing Codex, and emailed
 * the owner STUCK. What has to be true: any fresh machine that declared search makes the seat able
 * to search, whichever one checked in last.
 */
const NOW = new Date("2026-10-22T17:16:00.000Z");
const row = (device: string, ago: number, caps: string[], exhaustedUntil: string | null = null): DeviceRow => ({
  seat: "claude_code",
  device_id: device,
  hostname: null,
  agent_version: null,
  last_seen_at: new Date(NOW.getTime() - ago * 1000).toISOString(),
  exhausted_until: exhaustedUntil,
  exhausted_reason: null,
  capabilities_json: JSON.stringify(caps),
} as DeviceRow);

describe("a seat with two claimers", () => {
  it("can search when the jobs claimer checked in last", () => {
    const v = seatVerdict("claude_code", [row("mac-jobs", 1, ["local_job", "web_property_change"]), row("mac", 3, ["web_search"])], NOW);
    expect(v.available).toBe(true);
    expect(v.canSearch).toBe(true);
    expect(v.deviceId).toBe("mac");
  });
  it("cannot search when no fresh claimer declared it", () => {
    const v = seatVerdict("claude_code", [row("mac-jobs", 1, ["local_job"]), row("mac", 600, ["web_search"])], NOW);
    expect(v.available).toBe(true);
    expect(v.canSearch).toBe(false);
  });
  it("is out of usage when any fresh claimer says so", () => {
    const v = seatVerdict("claude_code", [row("mac-jobs", 1, ["local_job"]), row("mac", 3, ["web_search"], "2026-10-22T20:00:00.000Z")], NOW);
    expect(v.available).toBe(false);
  });
  it("is asleep when no claimer is fresh", () => {
    expect(seatVerdict("claude_code", [row("mac", 600, ["web_search"])], NOW).available).toBe(false);
  });
});

describe("in the database", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
  });
  afterAll(async () => { await disposeTestDb(t); });
  it("both readers agree the seat can search after the jobs claimer's later heartbeat", async () => {
    await recordHeartbeat(env, { seat: "claude_code", deviceId: "mac", capabilities: ["web_search"] }, new Date(NOW.getTime() - 3000));
    await recordHeartbeat(env, { seat: "claude_code", deviceId: "mac-jobs", capabilities: ["local_job"] }, new Date(NOW.getTime() - 1000));
    expect((await laneAvailability(env, "claude_code", NOW)).canSearch).toBe(true);
    const all = await allSeatAvailability(env, NOW);
    expect(all.find((a) => a.seat === "claude_code")!.canSearch).toBe(true);
  });
});
