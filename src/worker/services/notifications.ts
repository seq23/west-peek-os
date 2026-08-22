import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause } from "./authorize";
import type { PrivacyLabel } from "../../shared/privacy";

/**
 * Notifications (P20, GAP-19).
 *
 * In-app is the floor: it needs no credential, no external service, and no network beyond the
 * app. Push is an optional channel and its unavailability is RECORDED (`notification_delivery`
 * status UNAVAILABLE) rather than quietly ignored.
 *
 * Quiet hours suppress DELIVERY, never the record. A held notification is still in the centre,
 * still readable, and marked `HELD_QUIET_HOURS` so the operator can see what happened while they
 * were not looking. CRITICAL severity is never held — quiet hours are a preference, and a
 * critical exception outranks a preference.
 *
 * Deduplication is by an explicit key supplied by the emitter, so the same portfolio alert or
 * budget breach produces one notification rather than one per evaluation.
 */

export const NOTIFICATION_KINDS = [
  "APPROVAL",
  "EMPLOYEE_EXCEPTION",
  "PORTFOLIO_RISK",
  "BUDGET_THRESHOLD",
  "PROVIDER_FAILURE",
  "MEETING",
  "INTELLIGENCE_BRIEF",
  "LP_ISSUE",
  "RECONCILIATION_DISCREPANCY",
  "URGENT_DEAL_EVENT",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface NotifyInput {
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  objectType?: string;
  objectId?: string;
  /** Recipient; omit for a firm-wide notification. */
  firmUserId?: string | null;
  privacyLabel?: PrivacyLabel;
  /** Stable across repeats of the same underlying fact. */
  dedupeKey: string;
  firmScope?: string;
  now?: Date;
}

interface QuietHours {
  /** Hours 0–23 **in `timezone`**, not in UTC. See `hourIn` for why that distinction matters. */
  start?: number;
  end?: number;
  /** An IANA zone, e.g. "America/New_York". Absent means the hours are UTC (rows written before
   *  22 Aug 2026), which is preserved so an old preference does not silently change meaning. */
  timezone?: string;
}

/**
 * The hour it is, right now, where the reader says they are.
 *
 * WHY A ZONE AND NOT AN OFFSET, which is the actual bug this fixes. Quiet hours were stored as a UTC
 * hour computed from the browser's offset, so "hold everything from 9 PM" drifted by an hour twice a
 * year at daylight saving — and moved by five hours the moment a partner opened the app in London.
 * Operator, 22 Aug 2026: "i could be traveling on diff time zone so let me select time zone for
 * quiet hours."
 *
 * A NAMED ZONE survives both. 9 PM in New York is 9 PM in New York in February and in July, and it
 * stays 9 PM in New York while she is in London — which is what somebody means by "don't wake me".
 *
 * Falls back to UTC on an unknown zone rather than throwing: a bad string in a preference row must
 * not be able to stop a notification being delivered.
 */
function hourIn(now: Date, timezone: string | undefined): number {
  if (!timezone) return now.getUTCHours();
  try {
    const hour = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: timezone }).format(now);
    const parsed = Number(hour);
    return Number.isFinite(parsed) ? parsed % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Is `now` inside the user's quiet window? Handles windows that cross midnight. */
export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (quiet.start === undefined || quiet.end === undefined) return false;
  const hour = hourIn(now, quiet.timezone);
  if (quiet.start === quiet.end) return false;
  if (quiet.start < quiet.end) return hour >= quiet.start && hour < quiet.end;
  return hour >= quiet.start || hour < quiet.end;
}

interface PreferenceRow {
  firm_user_id: string;
  quiet_hours_json: string;
  kinds_json: string;
  push_enabled: number;
}

/**
 * Emit a notification. Never throws into the caller's flow: a notification failing must not roll
 * back the governed work that triggered it, so the outcome is returned instead.
 */
export async function notify(env: Env, input: NotifyInput): Promise<{ created: boolean; id: string | null; status: string }> {
  const now = input.now ?? new Date();
  const existing = await env.WP_OS_DB.prepare("SELECT id, delivery_status FROM notification WHERE dedupe_key = ?1")
    .bind(input.dedupeKey)
    .first<{ id: string; delivery_status: string }>();
  if (existing) return { created: false, id: existing.id, status: existing.delivery_status };

  let deliveryStatus = "DELIVERED_IN_APP";
  let inAppDetail = "shown in the notification centre";
  let pref: PreferenceRow | null = null;
  if (input.firmUserId) {
    pref = await env.WP_OS_DB.prepare("SELECT * FROM notification_preference WHERE firm_user_id = ?1")
      .bind(input.firmUserId)
      .first<PreferenceRow>();
  }

  if (pref) {
    let kinds: Record<string, { enabled?: boolean; min_severity?: NotificationSeverity }> = {};
    try {
      kinds = JSON.parse(pref.kinds_json) as typeof kinds;
    } catch {
      kinds = {};
    }
    const rule = kinds[input.kind];
    const order: Record<NotificationSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
    if (rule?.enabled === false && input.severity !== "CRITICAL") {
      deliveryStatus = "SUPPRESSED_BY_PREFERENCE";
      inAppDetail = "held: the recipient switched this kind off (CRITICAL would still be delivered)";
    } else if (rule?.min_severity && order[input.severity] < order[rule.min_severity] && input.severity !== "CRITICAL") {
      deliveryStatus = "SUPPRESSED_BY_PREFERENCE";
      inAppDetail = `held: below the recipient's minimum severity (${rule.min_severity})`;
    } else {
      let quiet: QuietHours = {};
      try {
        quiet = JSON.parse(pref.quiet_hours_json) as QuietHours;
      } catch {
        quiet = {};
      }
      if (input.severity !== "CRITICAL" && inQuietHours(quiet, now)) {
        deliveryStatus = "HELD_QUIET_HOURS";
        inAppDetail = "held during quiet hours; the record is still in the centre";
      }
    }
  }

  const id = `ntf_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO notification (id, kind, severity, title, body, object_type, object_id, firm_user_id, privacy_label, dedupe_key, delivery_status, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      input.kind,
      input.severity,
      input.title,
      input.body ?? "",
      input.objectType ?? null,
      input.objectId ?? null,
      input.firmUserId ?? null,
      input.privacyLabel ?? "INTERNAL",
      input.dedupeKey,
      deliveryStatus,
      input.firmScope ?? "west-peek",
    )
    .run();

  await env.WP_OS_DB.prepare(
    "INSERT INTO notification_delivery (id, notification_id, channel, status, detail) VALUES (?1, ?2, 'IN_APP', ?3, ?4)",
  )
    .bind(`ndl_${crypto.randomUUID()}`, id, deliveryStatus === "DELIVERED_IN_APP" ? "DELIVERED" : "HELD", inAppDetail)
    .run();

  // Push is recorded as UNAVAILABLE rather than silently skipped: no push service, VAPID key, or
  // subscription exists in this environment, and the operator should be able to see that.
  await env.WP_OS_DB.prepare(
    "INSERT INTO notification_delivery (id, notification_id, channel, status, detail) VALUES (?1, ?2, 'PUSH', 'UNAVAILABLE', ?3)",
  )
    .bind(
      `ndl_${crypto.randomUUID()}`,
      id,
      "no push service is configured in this environment (no VAPID key, no subscription): UNPROVEN — CREDENTIAL GATE",
    )
    .run();

  return { created: true, id, status: deliveryStatus };
}

/** Fire-and-forget wrapper: a notification must never break the work that triggered it. */
export async function notifyQuietly(env: Env, input: NotifyInput): Promise<void> {
  try {
    await notify(env, input);
  } catch (err) {
    console.error("notification failed", err);
  }
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleListNotifications(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const clauses = [visibility, "(firm_user_id IS NULL OR firm_user_id = ?1)"];
  if (unreadOnly) clauses.push("read_at IS NULL");

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM notification WHERE ${clauses.join(" AND ")} ORDER BY
       CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, created_at DESC LIMIT 200`,
  )
    .bind(ctx.identity!.id)
    .all<Record<string, unknown>>();
  const notifications = rows.results ?? [];

  const unread = notifications.filter((n) => n.read_at === null);
  return json({
    notifications,
    unread_count: unread.length,
    critical_unread: unread.filter((n) => n.severity === "CRITICAL").length,
    note: "Quiet hours and preferences hold DELIVERY, never the record: held notifications still appear here, marked with why.",
  });
}

/**
 * Fetch a notification the caller is actually entitled to act on: visible at their privacy scope
 * AND either firm-wide or addressed to them. Acting on someone else's notification would put a
 * false name on `read_by` / `acked_by`, which the audit spine then carries forever.
 */
async function actionableNotification(
  ctx: RouteContext,
  id: string,
): Promise<{ id: string; kind: string; read_at: string | null; acked_at: string | null } | null> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  return ctx.env.WP_OS_DB.prepare(
    `SELECT id, kind, read_at, acked_at FROM notification
      WHERE id = ?1 AND ${visibility} AND (firm_user_id IS NULL OR firm_user_id = ?2)`,
  )
    .bind(id, ctx.identity!.id)
    .first<{ id: string; kind: string; read_at: string | null; acked_at: string | null }>();
}

export async function handleReadNotification(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "notification.read", { objectType: "notification", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const row = await actionableNotification(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  if (row.read_at === null) {
    await ctx.env.WP_OS_DB.prepare("UPDATE notification SET read_at = ?2, read_by = ?3 WHERE id = ?1")
      .bind(row.id, new Date().toISOString(), ctx.identity!.id)
      .run();
  }
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM notification WHERE id = ?1").bind(row.id).first());
}

/**
 * Acknowledge: a stronger statement than "read". It records that a human saw the exception and
 * accepted responsibility for it, so it is audited on the event spine.
 */
export async function handleAckNotification(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "acknowledgement is a human act" }, { status: 403 });
  const authz = await authorize(ctx.env, actor, "notification.acknowledge", { objectType: "notification", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const row = await actionableNotification(ctx, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  if (row.acked_at !== null) return json({ error: "already_acknowledged" }, { status: 409 });

  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    "UPDATE notification SET acked_at = ?2, acked_by = ?3, read_at = COALESCE(read_at, ?2), read_by = COALESCE(read_by, ?3) WHERE id = ?1",
  )
    .bind(row.id, now, ctx.identity!.id)
    .run();

  await appendEvent(ctx.env, {
    eventType: "notification.acknowledged",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "notification",
    objectId: row.id,
    payload: { kind: row.kind },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM notification WHERE id = ?1").bind(row.id).first());
}

const preferenceSchema = z.object({
  quiet_hours: z
    .object({
      start: z.number().int().min(0).max(23),
      end: z.number().int().min(0).max(23),
      // Validated as a real zone by trying it, rather than against a list that would go stale.
      timezone: z
        .string()
        .trim()
        .min(1)
        .refine((tz) => {
          try {
            new Intl.DateTimeFormat("en-GB", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, "not a timezone this system recognises")
        .optional(),
    })
    .optional(),
  kinds: z
    .record(z.object({ enabled: z.boolean().optional(), min_severity: z.enum(["INFO", "WARNING", "CRITICAL"]).optional() }))
    .optional(),
  push_enabled: z.boolean().default(false),
});

export async function handleSetNotificationPreferences(ctx: RouteContext): Promise<Response> {
  const parsed = preferenceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "notification_preference.set", { objectType: "notification_preference", objectId: ctx.identity!.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO notification_preference (firm_user_id, quiet_hours_json, kinds_json, push_enabled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (firm_user_id) DO UPDATE SET
       quiet_hours_json = excluded.quiet_hours_json,
       kinds_json = excluded.kinds_json,
       push_enabled = excluded.push_enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(
      ctx.identity!.id,
      JSON.stringify(parsed.data.quiet_hours ?? {}),
      JSON.stringify(parsed.data.kinds ?? {}),
      parsed.data.push_enabled ? 1 : 0,
      new Date().toISOString(),
    )
    .run();

  return json(
    {
      preference: await ctx.env.WP_OS_DB.prepare("SELECT * FROM notification_preference WHERE firm_user_id = ?1").bind(ctx.identity!.id).first(),
      push_note:
        "push_enabled records your preference only. No push service is configured in this environment, so push delivery is UNPROVEN — CREDENTIAL GATE and every push delivery row is recorded UNAVAILABLE.",
    },
    { status: 201 },
  );
}

export async function handleGetNotificationPreferences(ctx: RouteContext): Promise<Response> {
  const pref = await ctx.env.WP_OS_DB.prepare("SELECT * FROM notification_preference WHERE firm_user_id = ?1").bind(ctx.identity!.id).first();
  return json({
    preference: pref ?? null,
    kinds: NOTIFICATION_KINDS,
    rules: {
      quiet_hours: "Holds delivery of INFO and WARNING. The record is always kept and always readable.",
      critical: "CRITICAL notifications are never held by quiet hours or by a preference.",
      push: "No push service is configured: every push delivery attempt is recorded UNAVAILABLE rather than skipped.",
    },
  });
}

export async function handleNotificationDeliveries(ctx: RouteContext): Promise<Response> {
  // Delivery rows are only readable through a notification the caller may see: reading them
  // otherwise would confirm the existence of a notification behind a privacy label.
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const notification = await ctx.env.WP_OS_DB.prepare(
    `SELECT id FROM notification WHERE id = ?1 AND ${visibility} AND (firm_user_id IS NULL OR firm_user_id = ?2)`,
  )
    .bind(ctx.params.id!, ctx.identity!.id)
    .first();
  if (!notification) return json({ error: "not_found" }, { status: 404 });

  const rows = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM notification_delivery WHERE notification_id = ?1 ORDER BY created_at").bind(ctx.params.id!).all()
  ).results ?? [];
  return json({ deliveries: rows });
}

/**
 * Mark everything currently unread as read, for this reader.
 *
 * WHY IN BULK. Clearing a list one row at a time is not a feature, it is an omission — and the
 * absence of this is why the page defaulted to showing already-read items: with no way to clear
 * them, hiding them would have made the list look permanently empty.
 *
 * READ, NEVER ACKNOWLEDGED. Acknowledgement records that a human saw an exception and accepted
 * responsibility for it, and it lands on the audit spine. Nobody accepts responsibility for
 * eighteen things with one click, so this deliberately cannot do that — the two acts stay
 * different, which is the distinction the original design got right.
 *
 * SCOPED TO WHAT THE READER CAN SEE, so a bulk action can never quietly clear a notification aimed
 * at the other partner or above this reader's privacy label.
 */
export async function handleReadAllNotifications(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "notification.read", { objectType: "notification", objectId: "*" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const now = new Date().toISOString();

  const result = await ctx.env.WP_OS_DB.prepare(
    `UPDATE notification
        SET read_at = ?2, read_by = ?3
      WHERE read_at IS NULL
        AND (firm_user_id IS NULL OR firm_user_id = ?1)
        AND ${visibility}`,
  )
    .bind(ctx.identity!.id, now, ctx.identity!.id)
    .run();

  return json({
    marked: result.meta?.changes ?? 0,
    note: "Marked read. Anything needing you to accept responsibility still has to be acknowledged one at a time.",
  });
}
