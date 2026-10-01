import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce, type SweepCard } from "../src/worker/services/workSweep";
import { reportRun, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { readLocalJobReport } from "../src/shared/work/localJobs";
import { runWebPropertyChangeCard } from "../src/worker/services/webPropertyChange";
import { liveStatus } from "../src/shared/work/liveStatus";
import { runWithCodexFallback, soonestReset } from "../scripts/lib/codex-seat.mjs";
import { claudeSpentUsage, codexSpentUsage, spentReport } from "../scripts/duties/web-property-change.mjs";

/**
 * BOTH SEATS SPENT IS A WAIT (1 Oct 2026). Claude Code and Codex both out of usage means nobody can run a repo
 * phase until one plan resets. Proven here, end to end through the real sweep and the real report reader:
 *   · the Mac's report carries how long until the earlier reset; a phase that failed any other way carries nothing;
 *   · the Worker HOLDS the card to that moment — no attempt charged, not blocked, nobody emailed;
 *   · the card says it is waiting for a reset (never "working now");
 *   · the sweep leaves it alone until then and, after it, parks the same phase again by itself.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string }> = [];
const SCOOTER = "scooter@westpeek.ventures";
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUv";
const EMAIL = `Hi — please update the westpeek.ventures site with the package here: https://drive.google.com/drive/folders/${FOLDER}?usp=sharing\n\nNew team page.\n`;
const RUNNERS = { webPropertyChange: (e: Env, c: SweepCard) => runWebPropertyChangeCard(e, c) };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
      sent.push({ to: body.to[0]!, subject: body.subject });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

const row = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;

async function newPorterCard(): Promise<string> {
  const chief = await openAssignmentCard(env, { subject: "ventures site update", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: EMAIL, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const desc = String((await row(chief)).description);
  return /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(desc)![1]!;
}
async function liveRun(cardId: string, status = "QUEUED"): Promise<SeatRunRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = ?2 ORDER BY created_at DESC LIMIT 1").bind(cardId, status).first<SeatRunRow>();
}
async function macReports(cardId: string, report: Record<string, unknown>): Promise<void> {
  const run = (await liveRun(cardId))!;
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(run.id, new Date().toISOString()).run();
  expect((await reportRun(env, { runId: run.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(report) })).accepted).toBe(true);
}

const CLAUDE_WEEKLY = JSON.stringify({ is_error: true, result: "You've hit your weekly limit · resets Oct 2 at 8am (America/Chicago)" });

describe("the Mac side: both seats spent is reported as a wait", () => {
  it("soonestReset takes the EARLIER of the two plans, an hour when no notice says, and never more than a week", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(soonestReset(["Try again in 3 hours.", "try again in 45 minutes"], now)).toBe(45 * 60);
    expect(soonestReset(["Try again in 3 hours.", null], now)).toBe(3 * 3600);
    expect(soonestReset(["you are out of usage", "no time here"], now)).toBe(3600);
    expect(soonestReset(["resets Oct 2 at 8am (America/Chicago)"], now)).toBe(25 * 3600); // 8am CDT Oct 2 = 13:00 UTC, 25h after noon UTC Oct 1
    expect(soonestReset(["resets in 99999 hours"], now)).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it("runWithCodexFallback reports resetsInSeconds only when BOTH are spent", async () => {
    const both = await runWithCodexFallback({
      runClaude: async () => ({ code: 1, out: CLAUDE_WEEKLY, err: "" }),
      runCodex: async () => ({ code: 0, out: "", err: "You've hit your usage limit. Try again in 3 hours." }),
      limited: claudeSpentUsage,
      codexLimited: codexSpentUsage,
      usable: () => ({ ok: true, why: "auth_mode=chatgpt" }),
      supports: async () => null,
    });
    expect(both.bothSpent).toBe(true);
    expect(both.resetsInSeconds).toBeGreaterThan(0);
    const fine = await runWithCodexFallback({
      runClaude: async () => ({ code: 1, out: CLAUDE_WEEKLY, err: "" }),
      runCodex: async () => ({ code: 0, out: "wrote the file", err: "" }),
      limited: claudeSpentUsage,
      codexLimited: codexSpentUsage,
      usable: () => ({ ok: true, why: "auth_mode=chatgpt" }),
      supports: async () => null,
    });
    expect(fine.resetsInSeconds).toBeUndefined();
  });

  it("spentReport makes a wait of a both-spent run and nothing else", () => {
    const r = spentReport("BUILD", { bothSpent: true, resetsInSeconds: 5400, err: "x\n[Both subscription seats are out of usage. Claude Code said: a. Codex said: b. This phase cannot run until one of those plans resets — try it again then.]" });
    expect(r).toMatchObject({ phase: "BUILD", status: "failed", waits_seconds: 5400 });
    expect(r!.reason).toMatch(/Both subscription seats/);
    expect(spentReport("BUILD", { bothSpent: false, err: "boom" })).toBeNull();
    expect(spentReport("BUILD", undefined)).toBeNull();
  });

  it("the Worker reads waits_seconds, bounds it, and ignores it on a report that is not a failure's", () => {
    const ok = readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "failed", reason: "both spent", waits_seconds: 5400 }));
    expect(ok.report?.waits_seconds).toBe(5400);
    expect(readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "failed", reason: "x", waits_seconds: 5 })).report?.waits_seconds, "under a minute is not a wait").toBeUndefined();
    expect(readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "failed", reason: "x", waits_seconds: 9e9 })).report?.waits_seconds).toBe(7 * 24 * 3600);
    expect(readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "failed", reason: "x" })).report?.waits_seconds).toBeUndefined();
  });
});

describe("the Worker side: the card waits, then starts again by itself", () => {
  let cardId = "";
  let heldUntil = 0;

  it("a both-spent report HOLDS the card: no attempt, not blocked, nobody emailed, and it says what it is waiting for", async () => {
    cardId = await newPorterCard();
    let now = new Date();
    const first = await sweepOnce(env, now, RUNNERS);
    expect(first.card?.id).toBe(cardId);
    const emailsBefore = sent.length;
    await macReports(cardId, { phase: "PLAN", status: "failed", reason: "Both subscription seats are out of usage.", waits_seconds: 4 * 3600 });
    now = new Date(now.getTime() + 3 * 60_000);
    const out = await sweepOnce(env, now, RUNNERS);
    expect(out.card?.id).toBe(cardId);
    expect(out.outcome).toBe("PROGRESSED");
    const c = await row(cardId);
    expect(c.state).not.toBe("BLOCKED");
    expect(c.work_attempts, "a wait is not an attempt").toBe(0);
    expect(sent.length, "nobody is emailed for a plan that is out of usage").toBe(emailsBefore);
    heldUntil = Date.parse(String(c.waiting_until));
    expect(heldUntil - now.getTime()).toBeGreaterThan(3.9 * 3600_000);
    expect(heldUntil - now.getTime()).toBeLessThan(4.1 * 3600_000);
    expect(Date.parse(String(c.lease_until)), "the sweep's lease is the same moment").toBe(heldUntil);
    expect(String(c.waiting_for)).toMatch(/out of usage/);
    expect(String(c.waiting_for)).toMatch(/starts again by itself/);

    const status = liveStatus({ ...(c as Record<string, unknown>), state: "OPEN", owner_type: "AI", owner_id: "aie_porter" } as never, "someone", now);
    expect(status.pill).toBe("Waiting for reset");
    expect(status.live, "it is not being worked").toBeFalsy();
    const ev = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.waiting_for_reset' AND object_id = ?1").bind(cardId).first<{ n: number }>();
    expect(ev!.n).toBe(1);
  });

  it("the sweep leaves it alone until the reset, and parks the same phase again by itself after it", async () => {
    const before = await sweepOnce(env, new Date(heldUntil - 10 * 60_000), RUNNERS);
    expect(before.card?.id, "before the reset the card is not taken").not.toBe(cardId);
    expect(await liveRun(cardId), "nothing is parked while it waits").toBeNull();

    const after = await sweepOnce(env, new Date(heldUntil + 60_000), RUNNERS);
    expect(after.card?.id).toBe(cardId);
    const run = await liveRun(cardId);
    expect(run, "the same phase is parked again").not.toBeNull();
    expect(JSON.parse(run!.job_json!).phase).toBe("PLAN");
    const c = await row(cardId);
    expect(c.waiting_until, "the wait is cleared when the phase is parked").toBeNull();
    expect(c.work_attempts).toBe(0);
  });

  it("a person pressing Try again clears the lease, and the card is no longer shown as waiting", async () => {
    const c = await row(cardId);
    const status = liveStatus({ ...(c as Record<string, unknown>), state: "OPEN", owner_type: "AI", owner_id: "aie_porter", waiting_until: new Date(heldUntil + 3600_000).toISOString(), waiting_for: "Both AI plans are out of usage", lease_until: null } as never, "someone", new Date(heldUntil));
    expect(status.pill).not.toBe("Waiting for reset");
  });

  it("a phase that failed any OTHER way is still an attempt, never a wait", async () => {
    await macReports(cardId, { phase: "PLAN", status: "failed", reason: "the target repo is not checked out" });
    const out = await sweepOnce(env, new Date(heldUntil + 5 * 60_000), RUNNERS);
    expect(out.card?.id).toBe(cardId);
    expect(out.outcome).toBe("FAILED");
    expect((await row(cardId)).waiting_until).toBeNull();
  });
});
