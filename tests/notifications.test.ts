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

    const row = await t.db.prepare("SELECT * FROM notification WHERE dedupe_key = ?1").bind(`approval:${card.body.id}`).first<{ kind: string; title: string }>();
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("APPROVAL");
    expect(row!.title).toContain("Kill-switch OpenAI");
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

    const row = await t.db
      .prepare("SELECT * FROM notification WHERE dedupe_key = ?1")
      .bind(`job_dead_letter:${run.body.run.id}`)
      .first<{ severity: string; kind: string }>();
    expect(row).not.toBeNull();
    expect(row!.severity).toBe("CRITICAL");
    expect(row!.kind).toBe("PROVIDER_FAILURE");
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
    expect(sw).toContain("Institutional state is never served from cache");
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
