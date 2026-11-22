import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { claimRun, parkRun, reapSeatRuns, readRun } from "../src/worker/ai/subscriptionSeats";
import { LOCAL_JOB_KINDS } from "../src/shared/work/localJobs";

/**
 * THE LOCAL-JOB CLAIMER KEEPS THE MAC'S DAY (owner's ruling 21 Nov 2026, Central): it claims only
 * 10:00-21:59 CT, behind `~/bin/mac-window`. How it breaks, each proven here:
 *   - OUTAGE: the guard says "outside" (or is missing) and the claimer still claims. It must exit
 *     with a named line having made no request at all.
 *   - DATA: a job queued just before 22:00 is closed by its queue ceiling before 10:00, or claimed
 *     twice when the window opens. It must still be QUEUED at the next window and claimed once.
 */
const CLAIMER = path.resolve(__dirname, "../scripts/claimer/local-job-claimer.mjs");
let dir: string;
let server: Server;
let hits: string[] = [];
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "macday-"));
  server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

function fakeGuard(name: string, body: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
function runClaimer(guard: string, extra: Record<string, string> = {}) {
  hits = [];
  return spawnSync(process.execPath, [CLAIMER, "--once"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, MAC_WINDOW_BIN: guard, WP_OS_BASE_URL: base, CF_ACCESS_CLIENT_ID: "x", CF_ACCESS_CLIENT_SECRET: "y", WP_OS_MAC_ACCESS_CLIENT_ID: "x", WP_OS_MAC_ACCESS_CLIENT_SECRET: "y", ...extra },
  });
}

describe("outage: the claimer never claims outside its window", () => {
  it("the guard says outside: one OUTSIDE_WINDOW line, exit 0, and no request reaches the Worker", () => {
    const r = runClaimer(fakeGuard("closed", 'echo "OUTSIDE_WINDOW LIGHT opens 10:00"; exit 1'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^OUTSIDE_WINDOW ventures\.westpeek\.os\.local-jobs LIGHT \(mac-window: LIGHT opens 10:00\): nothing claimed; queued jobs stay queued/m);
    expect(hits, "no heartbeat, no claim").toEqual([]);
  });

  it("no guard on the machine (missing, or an answer it does not understand): a named stop, a non-zero exit, no request", () => {
    for (const guard of [path.join(dir, "no-such-mac-window"), fakeGuard("broken", "exit 2")]) {
      const r = runClaimer(guard);
      expect(r.status).toBe(78);
      expect(r.stdout).toMatch(/NAMED STOP \[MAC_WINDOW_MISSING\] ventures\.westpeek\.os\.local-jobs/);
      expect(hits).toEqual([]);
    }
  });

  it("the guard says inside: the claimer passes the gate and goes on to its own checks (here: no claude on PATH)", () => {
    const r = runClaimer(fakeGuard("open", "echo INSIDE; exit 0"), { PATH: "/usr/bin:/bin" });
    expect(r.stdout).not.toMatch(/OUTSIDE_WINDOW|MAC_WINDOW_MISSING/);
    expect(r.stdout).toMatch(/This machine cannot run jobs: missing [^\n]*claude/);
    expect(r.status, "non-zero, so launchd retries inside the window").toBe(1);
  });
});

describe("data: a job queued before 22:00 waits out the closed hours and is claimed once", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => { t = await createTestDb(); env = makeTestEnv(t.db, {} as Partial<Env>); });
  afterAll(async () => { await disposeTestDb(t); });

  it.each(LOCAL_JOB_KINDS.map((k) => [k.kind, k.queueMaxSeconds] as const))("%s: queued 21:59 CT, still QUEUED at 13:00 CT, claimed once, a second claim gets nothing", async (kind, ceiling) => {
    const queuedAt = new Date("2026-11-23T03:59:00.000Z"); // Sun 22 Nov 21:59 CST, the last LIGHT minute
    const id = await parkRun(env, { seat: "claude_code", purpose: `macday ${kind}`, prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: JSON.stringify({ card_kind: kind, queue_max_seconds: ceiling }), maxSeconds: 600 });
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(id, queuedAt.toISOString()).run();
    // The reaper runs every minute all night; the window opens at 10:00 and a 3-hour build may hold the claimer till 13:00.
    for (const at of ["2026-11-23T09:59:00Z", "2026-11-23T15:59:00Z", "2026-11-23T16:00:00Z", "2026-11-23T19:00:00Z"]) {
      const out = await reapSeatRuns(env, new Date(at));
      expect(out.abandoned, `not closed at ${at}`).not.toContain(id);
    }
    expect((await readRun(env, id))!.status).toBe("QUEUED");
    const first = await claimRun(env, "mac-a.local-jobs", ["claude_code"], new Date("2026-11-23T19:00:00Z"), ["LOCAL_JOB"]);
    expect(first?.id).toBe(id);
    const second = await claimRun(env, "mac-b.local-jobs", ["claude_code"], new Date("2026-11-23T19:00:05Z"), ["LOCAL_JOB"]);
    expect(second?.id, "never handed out twice").not.toBe(id);
    expect((await readRun(env, id))!.claimed_by).toBe("mac-a.local-jobs");
  });

  it("the ceiling still bounds the wait: a job nobody took for longer than it is closed, so a queue is never inert", async () => {
    const ceiling = LOCAL_JOB_KINDS[0]!.queueMaxSeconds;
    expect(ceiling, "outlasts the closed hours 22:00-10:00 with room to work down a queue").toBeGreaterThanOrEqual(12 * 3600 + 3 * 3600);
    const id = await parkRun(env, { seat: "claude_code", purpose: "macday stale", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: JSON.stringify({ queue_max_seconds: ceiling }) });
    const created = new Date("2026-11-20T03:59:00.000Z");
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(id, created.toISOString()).run();
    const out = await reapSeatRuns(env, new Date(created.getTime() + ceiling * 1000 + 60_000));
    expect(out.abandoned).toContain(id);
  });
});
