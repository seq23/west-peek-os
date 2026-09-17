import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { inQuietHours, notify } from "../src/worker/services/notifications";

/**
 * P20 — Notifications + the mobile/PWA command surface (GAP-19, GAP-20).
 *
 * Rules under test:
 * - In-app delivery works with no credential and no external service.
 * - Dedupe by key: the same underlying fact produces ONE notification.
 * - Quiet hours and preferences hold DELIVERY, never the record; a held notification is still
 *   readable and says why it was held.
 * - CRITICAL is never held by quiet hours or by a preference.
 * - Push is recorded UNAVAILABLE on every notification rather than silently skipped.
 * - Read and acknowledge are distinct; acknowledgement is a human act on the audit spine.
 * - Real subsystems emit: submitting an approval card notifies, and a dead-lettered job notifies.
 * - The PWA manifest and service worker exist, and the worker NEVER caches /api/*.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("quiet-hours arithmetic", () => {
  it("handles a window inside one day and one that crosses midnight", () => {
    expect(inQuietHours({ start: 21, end: 7 }, new Date("2026-08-12T23:00:00.000Z"))).toBe(true);
    expect(inQuietHours({ start: 21, end: 7 }, new Date("2026-08-12T03:00:00.000Z"))).toBe(true);
    expect(inQuietHours({ start: 21, end: 7 }, new Date("2026-08-12T12:00:00.000Z"))).toBe(false);
    expect(inQuietHours({ start: 9, end: 17 }, new Date("2026-08-12T12:00:00.000Z"))).toBe(true);
    expect(inQuietHours({}, new Date())).toBe(false);
    /*
     * `end` IS EXCLUSIVE, so 0–23 is not the whole clock and 23:xx falls outside it.
     *
     * Ported from `fix/quiet-hours-test-covers-hour-23`, whose integration half is already on main
     * (the fixture below is clock-relative now). The unit half was not, and it is the durable
     * guard: the branch existed because the suite failed on main every night in the 23:00 hour
     * (15 Sep 2026, run 35034066666) against a fixture whose comment called `{ start: 0, end: 23 }`
     * "a window covering the whole clock". A full-clock window cannot be expressed at all —
     * `start === end` means off — and stating that here is what stops somebody "fixing" it back.
     */
    expect(inQuietHours({ start: 0, end: 23 }, new Date("2026-09-15T23:15:00.000Z"))).toBe(false);
    expect(inQuietHours({ start: 22, end: 1 }, new Date("2026-09-15T23:15:00.000Z"))).toBe(true);
    expect(inQuietHours({ start: 23, end: 2 }, new Date("2026-09-15T00:15:00.000Z"))).toBe(true);
    // `start === end` is "no quiet hours", not "always".
    expect(inQuietHours({ start: 9, end: 9 }, new Date("2026-09-15T09:30:00.000Z"))).toBe(false);
  });
});

describe("in-app delivery is the floor and push is honestly unavailable", () => {
  it("delivers in-app with no credential and records push as UNAVAILABLE", async () => {
    const result = await notify(env, {
      kind: "PORTFOLIO_RISK",
      severity: "WARNING",
      title: "Runway below threshold",
      body: "Acme runway is under 6 months.",
      dedupeKey: "test:runway:1",
    });
    expect(result.created).toBe(true);
    expect(result.status).toBe("DELIVERED_IN_APP");

    const deliveries = await call<{ deliveries: Array<{ channel: string; status: string; detail: string }> }>(
      `/api/notifications/${result.id}/deliveries`,
      MP,
    );
    const push = deliveries.body.deliveries.find((d) => d.channel === "PUSH")!;
    expect(push.status).toBe("UNAVAILABLE");
    expect(push.detail).toContain("CREDENTIAL GATE");
    expect(deliveries.body.deliveries.find((d) => d.channel === "IN_APP")!.status).toBe("DELIVERED");
  });

  it("dedupes the same fact to one notification", async () => {
    const again = await notify(env, {
      kind: "PORTFOLIO_RISK",
      severity: "WARNING",
      title: "Runway below threshold (again)",
      dedupeKey: "test:runway:1",
    });
    expect(again.created).toBe(false);
    const count = await t.db.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key = 'test:runway:1'").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("orders the centre by severity and counts unread", async () => {
    await notify(env, { kind: "URGENT_DEAL_EVENT", severity: "CRITICAL", title: "Block expires today", dedupeKey: "test:deal:1" });
    const res = await call<{ notifications: any[]; unread_count: number; critical_unread: number; note: string }>("/api/notifications", MP);
    expect(res.status).toBe(200);
    expect(res.body.notifications[0]!.severity).toBe("CRITICAL");
    expect(res.body.unread_count).toBeGreaterThan(0);
    expect(res.body.critical_unread).toBe(1);
    expect(res.body.note).toContain("held notifications still appear here");
  });
});

describe("preferences hold delivery, never the record", () => {
  it("holds a WARNING during quiet hours but keeps it readable, and never holds a CRITICAL", async () => {
    const saved = await call<{ push_note: string }>("/api/notifications/preferences", SEQUOIA, "POST", {
      quiet_hours: { start: 0, end: 23 },
      push_enabled: true,
    });
    expect(saved.status).toBe(201);
    expect(saved.body.push_note).toContain("UNPROVEN — CREDENTIAL GATE");

    const held = await notify(env, {
      kind: "MEETING",
      severity: "WARNING",
      title: "Meeting in 30 minutes",
      firmUserId: "fu_sequoia_taylor",
      dedupeKey: "test:meeting:1",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(held.status).toBe("HELD_QUIET_HOURS");

    const critical = await notify(env, {
      kind: "URGENT_DEAL_EVENT",
      severity: "CRITICAL",
      title: "Wire instruction changed",
      firmUserId: "fu_sequoia_taylor",
      dedupeKey: "test:critical:1",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(critical.status).toBe("DELIVERED_IN_APP");

    // Held notifications are still in the recipient's centre with the reason attached.
    const centre = await call<{ notifications: any[] }>("/api/notifications", SEQUOIA);
    const heldRow = centre.body.notifications.find((n: any) => n.id === held.id)!;
    expect(heldRow.delivery_status).toBe("HELD_QUIET_HOURS");
    const deliveries = await call<{ deliveries: Array<{ channel: string; detail: string }> }>(`/api/notifications/${held.id}/deliveries`, SEQUOIA);
    expect(deliveries.body.deliveries.find((d) => d.channel === "IN_APP")!.detail).toContain("quiet hours");
  });

  it("suppresses a kind the recipient switched off, except at CRITICAL", async () => {
    await call("/api/notifications/preferences", SEQUOIA, "POST", {
      kinds: { INTELLIGENCE_BRIEF: { enabled: false } },
      push_enabled: false,
    });
    const suppressed = await notify(env, {
      kind: "INTELLIGENCE_BRIEF",
      severity: "INFO",
      title: "Brief ready",
      firmUserId: "fu_sequoia_taylor",
      dedupeKey: "test:brief:1",
    });
    expect(suppressed.status).toBe("SUPPRESSED_BY_PREFERENCE");

    const criticalSameKind = await notify(env, {
      kind: "INTELLIGENCE_BRIEF",
      severity: "CRITICAL",
      title: "Brief flags a compliance exposure",
      firmUserId: "fu_sequoia_taylor",
      dedupeKey: "test:brief:critical",
    });
    expect(criticalSameKind.status).toBe("DELIVERED_IN_APP");
  });
});

describe("read and acknowledge are different acts", () => {
  it("marks read, then acknowledges once, and records the acknowledgement on the spine", async () => {
    const created = await notify(env, { kind: "APPROVAL", severity: "WARNING", title: "Card waiting", dedupeKey: "test:ack:1" });
    const read = await call<{ read_at: string | null; acked_at: string | null }>(`/api/notifications/${created.id}/read`, MP, "POST");
    expect(read.body.read_at).not.toBeNull();
    expect(read.body.acked_at).toBeNull();

    const acked = await call<{ acked_at: string | null; acked_by: string }>(`/api/notifications/${created.id}/acknowledge`, MP, "POST");
    expect(acked.body.acked_at).not.toBeNull();
    expect(acked.body.acked_by).toBe("fu_scooter_taylor");

    const again = await call(`/api/notifications/${created.id}/acknowledge`, MP, "POST");
    expect(again.status).toBe(409);

    const evt = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'notification.acknowledged' AND object_id = ?1")
      .bind(created.id)
      .first();
    expect(evt).not.toBeNull();
  });
});

describe("acting on a notification requires being entitled to it (final-review finding)", () => {
  it("refuses to let one user read or acknowledge another user's targeted notification", async () => {
    const targeted = await notify(env, {
      kind: "LP_ISSUE",
      severity: "WARNING",
      title: "Addressed to Sequoia only",
      firmUserId: "fu_sequoia_taylor",
      dedupeKey: "test:targeting:1",
    });
    expect(targeted.created).toBe(true);

    // Scooter is a Managing Partner and may see the LABEL, but the notification is addressed to
    // Sequoia: acknowledging it would put Scooter's name on Sequoia's exception.
    const read = await call(`/api/notifications/${targeted.id}/read`, MP, "POST");
    expect(read.status).toBe(404);
    const ack = await call(`/api/notifications/${targeted.id}/acknowledge`, MP, "POST");
    expect(ack.status).toBe(404);

    const row = await t.db.prepare("SELECT read_by, acked_by FROM notification WHERE id = ?1").bind(targeted.id).first<{ read_by: string | null; acked_by: string | null }>();
    expect(row!.read_by).toBeNull();
    expect(row!.acked_by).toBeNull();

    // The addressee can.
    const theirs = await call(`/api/notifications/${targeted.id}/acknowledge`, SEQUOIA, "POST");
    expect(theirs.status).toBe(200);
  });

  it("hides delivery rows behind the notification's own visibility", async () => {
    const targeted = await t.db.prepare("SELECT id FROM notification WHERE dedupe_key = 'test:targeting:1'").first<{ id: string }>();
    const other = await call(`/api/notifications/${targeted!.id}/deliveries`, MP);
    expect(other.status).toBe(404);
    const owner = await call<{ deliveries: any[] }>(`/api/notifications/${targeted!.id}/deliveries`, SEQUOIA);
    expect(owner.status).toBe(200);
    expect(owner.body.deliveries.length).toBeGreaterThan(0);
  });
});

describe("real subsystems emit notifications", () => {
  it("submitting an approval card notifies that a decision is waiting", async () => {
    const card = await call<{ id: string; title: string }>("/api/approvals", MP, "POST", {
      action_key: "governance.policy_change",
      object_type: "provider_registry",
      object_id: "openai",
      title: "Kill-switch OpenAI",
      submit: true,
    });
    expect(card.status).toBe(201);

    /*
     * ONE ROW PER PARTNER, keyed by the recipient. A firm-wide notification (no `firm_user_id`)
     * reads fine on the page and skips the preference block entirely — `notify()` can only load a
     * preference row for a NAMED person — so quiet hours, the per-kind switches and the
     * minimum-severity rule were all dead for approvals, the highest-volume kind in the system.
     * The old assertion matched on the bare `approval:<id>` key and so pinned that shape in place.
     */
    const rows = await t.db
      .prepare("SELECT * FROM notification WHERE dedupe_key LIKE ?1")
      .bind(`approval:${card.body.id}%`)
      .all<{ kind: string; title: string; firm_user_id: string | null }>();
    const addressed = rows.results ?? [];
    expect(addressed.length).toBeGreaterThan(0);
    for (const row of addressed) {
      expect(row.kind).toBe("APPROVAL");
      expect(row.title).toContain("Kill-switch OpenAI");
      // Addressed to a person, which is the only way that person's quiet hours can be consulted.
      expect(row.firm_user_id, "an approval notice must name who it is for").toBeTruthy();
    }
    // And nobody is told twice about the same card.
    expect(new Set(addressed.map((r) => r.firm_user_id)).size).toBe(addressed.length);
  });

  it("a dead-lettered scheduled job raises a CRITICAL notification", async () => {
    // Activate an employee, point a job at it with a data class that can never egress, and force
    // the FRONTIER path so the run genuinely fails rather than being refused.
    const activation = await call<{ id: string }>("/api/ai/employees/aie_wells/request-activation", MP, "POST", { reason: "P20" });
    await call(`/api/approvals/${activation.body.id}/decide`, MP, "POST", { decision: "approved", note: "ok" });
    await call("/api/ai/employees/aie_wells/activate", MP, "POST", { approval_receipt_id: activation.body.id, reason: "P20" });

    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();

    await call("/api/jobs", MP, "POST", {
      job_key: "notify_dead_letter",
      name: "A job that cannot succeed",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "INTERVAL",
      interval_minutes: 5,
      target_kind: "EMPLOYEE",
      target_id: "aie_wells",
      data_class: "MNPI_SENSITIVE",
      max_attempts: 1,
    });
    await call("/api/jobs/notify_dead_letter/status", MP, "POST", { status: "ACTIVE", reason: "on" });
    const run = await call<{ run: { id: string; status: string } }>("/api/jobs/notify_dead_letter/run", MP, "POST");
    expect(run.body.run.status).toBe("DEAD_LETTER");

    // Filtered in JS rather than with LIKE: the key carries a UUID whose underscores are LIKE
    // wildcards, and D1 refused the pattern outright ("LIKE or GLOB pattern too complex").
    const rows = await t.db
      .prepare("SELECT * FROM notification WHERE kind = 'PROVIDER_FAILURE'")
      .all<{ severity: string; kind: string; firm_user_id: string | null; dedupe_key: string; title: string; body: string }>();
    // Keyed on the JOB and the hour, not the run: a job that keeps failing rings once an hour, and
    // the notice says "keeps failing", never "stopped" — the job is still scheduled.
    const jobId = (await t.db.prepare("SELECT id FROM scheduled_job WHERE job_key = 'notify_dead_letter'").first<{ id: string }>())!.id;
    const addressed = (rows.results ?? []).filter((r) => r.dedupe_key.startsWith(`job_dead_letter:${jobId}:`));
    expect(addressed.length).toBeGreaterThan(0);
    for (const row of addressed) {
      expect(row.severity).toBe("CRITICAL");
      expect(row.kind).toBe("PROVIDER_FAILURE");
      expect(row.firm_user_id).toBeTruthy();
      expect(row.title).toMatch(/keeps failing/);
      expect(row.title).not.toMatch(/stopped/);
      expect(row.body).toMatch(/still scheduled and will try again/);
    }
  });

  it("a partner's own quiet hours apply to the notifications she actually gets", async () => {
    /*
     * THE POINT OF ALL THE ADDRESSING. Quiet hours, the per-kind switches and the minimum-severity
     * rule were written correctly and could never fire for approvals, portfolio alerts, dead-letter
     * jobs, LP chasers or employee lifecycle notices — six of the ten call sites — because a
     * firm-wide row has nobody whose preferences could be read. This proves the loop closes for the
     * kind the operator sees most.
     */
    const saved = await call("/api/notifications/preferences", MP, "POST", {
      // A window built around NOW, so this does not depend on when the suite runs. (It used to be
      // 0–23, which is "every hour but 23:00" — the suite went red at 23:xx UTC on 15 Sep 2026.)
      quiet_hours: { start: new Date().getUTCHours(), end: (new Date().getUTCHours() + 2) % 24, timezone: "UTC" },
      push_enabled: false,
    });
    expect(saved.status).toBe(201);

    const card = await call<{ id: string }>("/api/approvals", MP, "POST", {
      action_key: "governance.policy_change",
      object_type: "provider_registry",
      object_id: "anthropic",
      title: "Quiet-hours check",
      submit: true,
    });
    expect(card.status).toBe(201);

    const scooter = await t.db
      .prepare("SELECT id FROM firm_user WHERE email = 'scooter@westpeek.ventures'")
      .first<{ id: string }>();
    const mine = await t.db
      .prepare("SELECT delivery_status FROM notification WHERE dedupe_key LIKE ?1 AND firm_user_id = ?2")
      .bind(`approval:${card.body.id}%`, scooter!.id)
      .first<{ delivery_status: string }>();
    expect(mine?.delivery_status, "her quiet hours must reach the notice she was sent").toBe("HELD_QUIET_HOURS");

    // HELD, NEVER HIDDEN. Holding is about not interrupting her, not about losing the record — the
    // notice is still on the page, which is what the copy now says.
    const listed = await call<{ notifications: Array<{ id: string }> }>("/api/notifications", MP);
    expect(listed.status).toBe(200);
    expect(listed.body.notifications.length).toBeGreaterThan(0);
  });
});

describe("the PWA surface exists and never caches institutional state", () => {
  const clientDir = fileURLToPath(new URL("../src/client", import.meta.url));

  it("ships an installable manifest", () => {
    const manifest = JSON.parse(readFileSync(`${clientDir}/public/manifest.webmanifest`, "utf8")) as {
      name: string;
      start_url: string;
      display: string;
      icons: unknown[];
    };
    expect(manifest.name).toBe("West Peek OS");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it("has a service worker that refuses to cache /api/* and has no fake push handler", () => {
    const sw = readFileSync(`${clientDir}/public/sw.js`, "utf8");
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    expect(sw).toMatch(/never served from cache/i);
    // No push handler is registered, because no push service exists to register one for.
    expect(sw).not.toContain('addEventListener("push"');
    expect(sw).not.toContain("addEventListener('push'");
  });

  it("links the manifest and registers the worker from the app entry", () => {
    const html = readFileSync(`${clientDir}/index.html`, "utf8");
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="viewport"');
    const main = readFileSync(`${clientDir}/main.tsx`, "utf8");
    expect(main).toContain('navigator.serviceWorker.register("/sw.js")');
  });
});

/**
 * Dismissing in bulk.
 *
 * Its absence was half of why the page defaulted to showing already-read items: with no way to
 * clear them, hiding them would have left the inbox looking permanently empty. The two defects
 * held each other up.
 */
describe("dismissing everything at once", () => {
  it("marks every unread notification read for this reader", async () => {
    await notify(env, {
      kind: "APPROVAL",
      severity: "WARNING",
      title: "bulk one",
      firmUserId: "fu_scooter_taylor",
      objectType: "approval_card",
      objectId: `apc_bulk_${crypto.randomUUID().slice(0, 8)}`,
      dedupeKey: `bulk-one-${crypto.randomUUID()}`,
    });
    await notify(env, {
      kind: "APPROVAL",
      severity: "INFO",
      title: "bulk two",
      firmUserId: "fu_scooter_taylor",
      objectType: "approval_card",
      objectId: `apc_bulk_${crypto.randomUUID().slice(0, 8)}`,
      dedupeKey: `bulk-two-${crypto.randomUUID()}`,
    });

    const before = await call<{ unread_count: number }>("/api/notifications", MP);
    expect(before.body.unread_count).toBeGreaterThan(0);

    const res = await call<{ marked: number }>("/api/notifications/read-all", MP, "POST", {});
    expect(res.status).toBe(200);
    expect(res.body.marked).toBeGreaterThan(0);

    const after = await call<{ unread_count: number }>("/api/notifications", MP);
    expect(after.body.unread_count).toBe(0);
  });

  it("dismisses without acknowledging anything", async () => {
    // Acknowledgement records that a human accepted responsibility and lands on the audit spine.
    // Nobody accepts responsibility for eighteen things with one click, so bulk must not do it.
    const id = `apc_ack_${crypto.randomUUID().slice(0, 8)}`;
    await notify(env, {
      kind: "APPROVAL",
      severity: "CRITICAL",
      title: "must still be acknowledged by hand",
      firmUserId: "fu_scooter_taylor",
      objectType: "approval_card",
      objectId: id,
      dedupeKey: `ack-by-hand-${crypto.randomUUID()}`,
    });
    await call("/api/notifications/read-all", MP, "POST", {});

    const list = await call<{ notifications: Array<{ title: string; read_at: string | null; acked_at: string | null }> }>(
      "/api/notifications",
      MP,
    );
    const row = list.body.notifications.find((n) => n.title === "must still be acknowledged by hand")!;
    expect(row.read_at).not.toBeNull();
    expect(row.acked_at).toBeNull();
  });

  it("is reachable by its own name rather than being read as an id", async () => {
    // "read-all" is a perfectly good notification id as far as the router is concerned.
    const res = await call<{ marked: number }>("/api/notifications/read-all", MP, "POST", {});
    expect(res.status).toBe(200);
    expect(typeof res.body.marked).toBe("number");
  });
});

/**
 * Deciding an approval retires the notification that asked for it.
 *
 * Submitting a card raised "Approval waiting" and nothing ever retired it, so the inbox filled with
 * unread requests for decisions already made — each linking to a card no longer in the queue. The
 * operator's report was exactly that: a notification about an approval that is not in the approval
 * queue at all.
 */
describe("an answered approval stops asking", () => {
  it("marks the waiting notification read once the card is decided", async () => {
    const created = await call<{ id: string }>("/api/approvals", SEQUOIA, "POST", {
      action_key: "ai_employee.activate",
      object_type: "ai_employee",
      object_id: "aiemp_test_subject",
      title: "Notification retirement test",
      submit: true,
    });
    expect(created.status).toBe(201);
    const cardId = created.body.id;

    const before = await call<{ notifications: Array<Record<string, any>> }>("/api/notifications", SEQUOIA);
    const waiting = before.body.notifications.filter(
      (n) => n.object_type === "approval_card" && n.object_id === cardId && n.read_at === null,
    );
    expect(waiting.length, "submitting should raise an unread approval notification").toBeGreaterThan(0);

    const decided = await call(`/api/approvals/${cardId}/decide`, SEQUOIA, "POST", {
      decision: "approved",
      note: "deciding it",
    });
    expect(decided.status).toBe(200);

    const after = await call<{ notifications: Array<Record<string, any>> }>("/api/notifications", SEQUOIA);
    const stillWaiting = after.body.notifications.filter(
      (n) => n.object_type === "approval_card" && n.object_id === cardId && n.read_at === null,
    );
    expect(stillWaiting, "a decided approval must not still be asking").toEqual([]);

    // Read, not deleted: what was asked and when is part of the record.
    const kept = after.body.notifications.filter(
      (n) => n.object_type === "approval_card" && n.object_id === cardId,
    );
    expect(kept.length).toBeGreaterThan(0);
  });
});

/**
 * THE COUNT IS OVER EVERYTHING; THE LIST IS A PAGE OF IT.
 *
 * `handleListNotifications` reads at most 200 rows, ordered by SEVERITY first and only then by
 * recency. `unread_count` and `critical_unread` were derived from that array, so both were true of
 * the page and false of the firm the moment a 201st row existed: the page fills with CRITICAL and
 * WARNING — read or unread, the ordering does not care — and unread INFO falls off the end
 * uncounted. The inbox would then have printed "You are caught up" over unread notifications
 * sitting in the database.
 *
 * That is the same false quiet the health board exists to catch, committed by the surface that
 * reports it. Production held 87 rows on 9 Sep 2026, growing at roughly that a month, so this is
 * the fix landing before the bug — which is the only time it costs nothing.
 */
describe("the unread count is counted over everything, not over the visible page", () => {
  const READER = "fu_scooter_taylor";

  it("still counts unread rows the 200-row page cannot show", async () => {
    // Clear the decks so this test owns the arithmetic rather than inheriting it.
    await call("/api/notifications/read-all", MP, "POST", {});
    const start = await call<{ unread_count: number }>("/api/notifications", MP);
    expect(start.body.unread_count, "the reader should start caught up").toBe(0);

    /*
     * 205 WARNINGs and then one INFO. Severity ordering puts every WARNING ahead of the INFO, so
     * the INFO is row 206 and cannot appear in a 200-row page — while remaining unread, and while
     * being exactly the sort of thing ("a brief is ready") a partner still wants counted.
     */
    const OVER_THE_CAP = 205;
    for (let n = 0; n < OVER_THE_CAP; n += 1) {
      await notify(env, {
        kind: "APPROVAL", severity: "WARNING", title: `cap filler ${n}`,
        firmUserId: READER, dedupeKey: `cap-filler-${n}-${crypto.randomUUID()}`,
      });
    }
    const buriedKey = `cap-buried-${crypto.randomUUID()}`;
    await notify(env, {
      kind: "INTELLIGENCE_BRIEF", severity: "INFO", title: "the buried one",
      firmUserId: READER, dedupeKey: buriedKey,
    });

    const res = await call<{
      notifications: Array<{ title: string }>; unread_count: number; truncated: boolean;
    }>("/api/notifications", MP);

    // The premise, asserted rather than assumed: the page really is truncated and really does not
    // contain the buried row. Without this the test could pass for the wrong reason.
    expect(res.body.notifications.length, "the page should be at its cap").toBe(200);
    expect(res.body.truncated, "and should say so").toBe(true);
    expect(
      res.body.notifications.some((n) => n.title === "the buried one"),
      "the buried notification must genuinely be off the page for this test to mean anything",
    ).toBe(false);

    // The fix: the count knows about it anyway.
    expect(res.body.unread_count).toBe(OVER_THE_CAP + 1);
  });

  it("says caught up only when the firm is caught up, not when the page looks empty", async () => {
    await call("/api/notifications/read-all", MP, "POST", {});
    const res = await call<{ unread_count: number; truncated: boolean }>("/api/notifications", MP);
    expect(res.body.unread_count).toBe(0);
  });
});

/**
 * WHAT THE BADGE COUNTS AND WHAT THE PAGE SHOWS ARE THE SAME NUMBER, FOR EVERY STATE.
 *
 * Operator, 9 Sep 2026: "the west peek os home screen still says 12 unread even tho i read it all
 * and dismissed or took responsibility." The client half of that — a status bar holding its own
 * frozen copy of the count — is pinned in `tests/notificationBadge.test.ts`. This is the server
 * half: the badge reads `/api/notifications?unread=1` and the page reads `/api/notifications`, two
 * different requests, and nothing but this test makes them agree about what "waiting" means.
 *
 * THREE ACTIONS, AND THEY ARE NOT THE SAME ACT. Dismiss records that she has seen it. Take
 * responsibility puts her name and the time on the audit spine AND implies she saw it, so it sets
 * `read_at` too. Both therefore clear the badge, which is correct for a badge labelled UNREAD: the
 * number answers "is there anything I have not looked at", and by then she has. What acknowledging
 * additionally does is recorded, permanent, and visible on the row — it is not what this number is
 * for.
 */
describe("the badge and the page agree, whatever she just did", () => {
  const READER = "fu_scooter_taylor";

  /**
   * Both surfaces, read the way the two components read them.
   *
   * `waitingOnPage` is only comparable when the page is NOT truncated. The full list is capped at
   * 200 rows and ordered by severity, so on a busy inbox an unread row can legitimately be off the
   * page while still being counted — which is the whole reason `truncated` exists. The invariant
   * that always holds is that both surfaces report the SAME NUMBER; the rendered-row comparison is
   * the stronger form, asserted where it applies.
   */
  async function bothViews() {
    const badge = await call<{ unread_count: number; notifications: Array<{ id: string }> }>(
      "/api/notifications?unread=1", MP,
    );
    const page = await call<{ unread_count: number; truncated: boolean; notifications: Array<{ id: string; read_at: string | null }> }>(
      "/api/notifications", MP,
    );
    return {
      badgeCount: badge.body.unread_count,
      badgeRows: badge.body.notifications.length,
      pageCount: page.body.unread_count,
      truncated: page.body.truncated,
      waitingOnPage: page.body.notifications.filter((n) => n.read_at === null).length,
    };
  }

  /** The two surfaces must never disagree about the number, whatever the page could fit. */
  function agree(v: Awaited<ReturnType<typeof bothViews>>, expected: number, when: string): void {
    expect(v.badgeCount, `the badge is wrong ${when}`).toBe(expected);
    expect(v.pageCount, `the page and the badge disagree ${when}`).toBe(v.badgeCount);
    // The unread-only view is never truncated at these volumes, so its rows ARE the count.
    expect(v.badgeRows, `the unread list and its own count disagree ${when}`).toBe(v.badgeCount);
    if (!v.truncated) {
      expect(v.waitingOnPage, `the page renders a different number of waiting items ${when}`).toBe(v.badgeCount);
    }
  }

  it("agrees before anything is acted on, after a dismiss, and after taking responsibility", async () => {
    await call("/api/notifications/read-all", MP, "POST", {});

    const ids: string[] = [];
    for (const severity of ["CRITICAL", "WARNING", "INFO"] as const) {
      const res = await notify(env, {
        kind: "EMPLOYEE_EXCEPTION", severity, title: `agree ${severity}`,
        firmUserId: READER, dedupeKey: `agree-${severity}-${crypto.randomUUID()}`,
      });
      expect(res.created).toBe(true);
      ids.push(res.id!);
    }

    // Hard-fails on nothing to examine: every assertion below is vacuously true over an empty set.
    const start = await bothViews();
    expect(start.badgeCount, "nothing was outstanding, so this proves nothing").toBe(3);
    agree(start, 3, "before she acts");

    // 1 · Dismiss one.
    expect((await call(`/api/notifications/${ids[0]}/read`, MP, "POST", {})).status).toBe(200);
    agree(await bothViews(), 2, "after she dismissed one");

    // 2 · Take responsibility for another. Acknowledging implies reading, so it clears too.
    expect((await call(`/api/notifications/${ids[1]}/acknowledge`, MP, "POST", {})).status).toBe(200);
    agree(await bothViews(), 1, "after she took responsibility for one");

    // And the stronger act is still recorded on the row rather than merely clearing a number.
    const acked = await env.WP_OS_DB.prepare(
      "SELECT acked_at, acked_by, read_at FROM notification WHERE id = ?1",
    ).bind(ids[1]).first<{ acked_at: string | null; acked_by: string | null; read_at: string | null }>();
    expect(acked!.acked_at, "acknowledgement did not persist").toBeTruthy();
    expect(acked!.acked_by).toBe(READER);
    expect(acked!.read_at, "acknowledging must imply reading, or the badge and the row disagree").toBeTruthy();

    // 3 · Clear the rest in bulk.
    await call("/api/notifications/read-all", MP, "POST", {});
    agree(await bothViews(), 0, "after she dismissed everything");
  });

  it("never counts a notification addressed to the other partner", async () => {
    /*
     * The production shape on 9 Sep 2026: all twenty-six unread rows were addressed to Scooter and
     * NONE to Sequoia, so her true count was zero while her badge showed a stale twelve. If the
     * count ever stopped filtering by recipient, one partner's inbox would inflate the other's.
     */
    await call("/api/notifications/read-all", MP, "POST", {});
    await call("/api/notifications/read-all", SEQUOIA, "POST", {});

    const res = await notify(env, {
      kind: "EMPLOYEE_EXCEPTION", severity: "WARNING", title: "for scooter only",
      firmUserId: "fu_scooter_taylor", dedupeKey: `scooter-only-${crypto.randomUUID()}`,
    });
    expect(res.created).toBe(true);

    const his = await call<{ unread_count: number }>("/api/notifications?unread=1", MP);
    const hers = await call<{ unread_count: number }>("/api/notifications?unread=1", SEQUOIA);
    expect(his.body.unread_count, "the addressee did not see their own notification").toBe(1);
    expect(hers.body.unread_count, "the other partner's badge counted a notification that is not hers").toBe(0);
  });
});

/**
 * NOTHING IS EVER RECORDED AS DECIDED BY SOMEONE WHO HAS NEVER SIGNED IN.
 *
 * Operator, 9 Sep 2026: "scooter doesnt check his OS much so fix everything and clear his
 * responsibilities and dismiss everything." `fu_scooter_taylor` had 26 unread notifications and has
 * NEVER AUTHENTICATED — zero events on the spine, zero notifications read, zero approvals decided.
 *
 * The easy way to clear them would have been to stamp `read_by` and `acked_by` with his name, and
 * it would have been a falsification: twenty-six decisions on the audit spine that a man who has
 * never opened the product did not make, and every later question of who knew what answered wrongly
 * and confidently. Of the 26, thirteen warned about faults that are now closed and twelve were
 * superseded briefings — none of them obligations he incurred.
 *
 * So they are cleared by DERIVATION and nothing is written. These assert that, and assert the other
 * half: a notice whose condition is still true is never cleared, because a clean screen over a live
 * fault costs the operator the signal AND keeps the fault.
 */
describe("clearing a notice never records a decision nobody made", () => {
  const NEVER_SIGNED_IN = "fu_scooter_taylor";

  /*
   * Its own database. An earlier block in this file deliberately writes 206 notifications to prove
   * the 200-row page cap, and these rows are backdated so they would fall off that page — which
   * would make every assertion below vacuous for the wrong reason.
   */
  let own: TestDb;
  let ownEnv: Env;

  beforeAll(async () => {
    own = await createTestDb();
    ownEnv = makeTestEnv(own.db);
  });
  afterAll(async () => {
    await disposeTestDb(own);
  });

  async function get<T>(path: string): Promise<T> {
    const res = await handleRequest(req(path, MP), ownEnv);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  /** Plant a fault and the warning that would have been written about it. */
  async function faultAndWarning(key: string, resolved: boolean): Promise<string> {
    const seen = "2026-09-01T00:00:00.000Z";
    await ownEnv.WP_OS_DB.prepare(
      `INSERT INTO health_fault (id, check_key, label, first_seen_at, escalated_at, resolved_at, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'west-peek')`,
    )
      .bind(`hf_${key}`, key, `The ${key} check`, seen, resolved ? "2026-09-05T00:00:00.000Z" : null)
      .run();

    const res = await notify(ownEnv, {
      kind: "PROVIDER_FAILURE", severity: "WARNING", title: `${key} is down`,
      objectType: "health_fault", objectId: key,
      firmUserId: NEVER_SIGNED_IN, dedupeKey: `hf-warn-${key}`,
    });
    expect(res.created, "the warning was not written, so there is nothing to clear").toBe(true);
    // Written as if it had been sent while the fault was open.
    await ownEnv.WP_OS_DB.prepare("UPDATE notification SET created_at = ?2 WHERE id = ?1")
      .bind(res.id, "2026-09-02T00:00:00.000Z")
      .run();
    return res.id!;
  }

  it("stops counting a warning whose fault is closed, and keeps one whose fault is open", async () => {
    const closedId = await faultAndWarning("clear_closed", true);
    const openId = await faultAndWarning("clear_open", false);

    const body = await get<{
      unread_count: number;
      cleared: { resolved: number; superseded: number };
      notifications: Array<{ id: string; stale_reason: string | null }>;
    }>("/api/notifications");

    // Hard-fails on nothing examined.
    expect(body.notifications.length, "no notifications came back at all").toBeGreaterThan(0);

    const closedRow = body.notifications.find((n) => n.id === closedId);
    const openRow = body.notifications.find((n) => n.id === openId);
    expect(closedRow, "the cleared notice vanished entirely instead of being marked").toBeTruthy();
    expect(closedRow!.stale_reason, "a warning about a fixed fault is still counted as waiting").toBe("RESOLVED");
    expect(openRow!.stale_reason, "a warning about a STILL-OPEN fault was cleared").toBeNull();

    expect(body.cleared.resolved, "the clearing was silent rather than accounted for").toBeGreaterThan(0);

    // The badge counts what is outstanding: the open one, never the closed one.
    const badge = await get<{ unread_count: number; notifications: Array<{ id: string }> }>(
      "/api/notifications?unread=1",
    );
    expect(badge.notifications.some((n) => n.id === openId), "the live fault fell off the badge").toBe(true);
    expect(badge.notifications.some((n) => n.id === closedId), "a fixed fault is still on the badge").toBe(false);
  });

  it("writes NOTHING to a cleared notice — no read_by, no acked_by, no timestamps", async () => {
    /*
     * THE ASSERTION THIS BLOCK EXISTS FOR. `read_by` and `acked_by` name a person. Stamping them for
     * a partner who has never authenticated would put decisions on the spine that he did not make,
     * and the record would then answer "did Scooter see the outage" with a confident yes.
     */
    const rows = (
      await ownEnv.WP_OS_DB.prepare(
        `SELECT n.id, n.read_at, n.read_by, n.acked_at, n.acked_by
           FROM notification n WHERE n.object_type = 'health_fault' AND n.firm_user_id = ?1`,
      ).bind(NEVER_SIGNED_IN).all<{ id: string; read_at: string | null; read_by: string | null; acked_at: string | null; acked_by: string | null }>()
    ).results ?? [];

    expect(rows.length, "no fault notices to check").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.read_by, `${r.id} was recorded as read by somebody`).toBeNull();
      expect(r.acked_by, `${r.id} was recorded as acknowledged by somebody`).toBeNull();
      expect(r.read_at, `${r.id} was recorded as read`).toBeNull();
      expect(r.acked_at, `${r.id} was recorded as acknowledged`).toBeNull();
    }
  });

  it("never stamps a decision for a user who has never authenticated", async () => {
    /*
     * The invariant stated over the WHOLE table rather than over the rows this test made: nobody
     * who has produced no events on the spine may appear as having read, acknowledged or decided
     * anything. Authentication is what produces events, so an actor with none has never been here.
     */
    const users = (
      await ownEnv.WP_OS_DB.prepare(
        `SELECT u.id, u.full_name,
                (SELECT COUNT(*) FROM event_record e WHERE e.actor_type = 'firm_user' AND e.actor_id = u.id) AS acted,
                (SELECT COUNT(*) FROM notification n WHERE n.read_by = u.id OR n.acked_by = u.id) AS stamped
           FROM firm_user u WHERE u.status = 'ACTIVE'`,
      ).all<{ id: string; full_name: string; acted: number; stamped: number }>()
    ).results ?? [];

    expect(users.length, "no firm users to examine").toBeGreaterThan(0);
    const neverActed = users.filter((u) => u.acted === 0);
    expect(neverActed.length, "every user has acted, so this invariant examined nothing").toBeGreaterThan(0);
    for (const u of neverActed) {
      expect(u.stamped, `${u.full_name} has never acted but is recorded as having handled ${u.stamped} notification(s)`).toBe(0);
    }
  });
});
