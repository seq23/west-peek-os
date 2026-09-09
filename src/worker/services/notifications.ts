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

/**
 * Tell each partner, as a notice ADDRESSED TO THEM.
 *
 * WHY THIS EXISTS, AND WHAT WAS BROKEN. A notification written with no `firmUserId` is a firm-wide
 * row — `handleListNotifications` shows it to everybody with `firm_user_id IS NULL OR = ?1`. It
 * reads fine. But `notify()` can only load a preference row for a named person, so a firm-wide
 * notice skips the preference block ENTIRELY: the per-kind switches, the minimum-severity rule and
 * quiet hours are all dead for it. Ten call sites existed and six of them were firm-wide, including
 * all three approval notices — the highest-volume kind in the system. The operator asked for quiet
 * hours and per-kind control, both were built correctly, and neither applied to the notifications
 * she gets most.
 *
 * The fix is addressing, not a new rule: a notice meant for the partners is written once per
 * partner, keyed by the recipient so each gets exactly one and neither gets two. Each partner then
 * has their own quiet hours honoured, in their own timezone, which is the whole point of a setting
 * that follows you when you travel.
 *
 * Falls back to ONE firm-wide row if no partner can be resolved. Saying nothing would be worse than
 * saying it to everybody, and a notification system that can drop a message when a lookup fails is
 * not one anybody should rely on.
 */
export async function notifyPartners(
  env: Env,
  input: Omit<NotifyInput, "firmUserId"> & { dedupeKey: string },
): Promise<void> {
  // Read from the ROLE JOIN, not a name list. `MANAGING_PARTNERS` in the registry holds names and
  // ownership, and a notification needs a `firm_user.id` — the sixth place in this codebase where a
  // name was used where an id was required. Whoever actually holds the role is the audience.
  const partners = await env.WP_OS_DB.prepare(
    `SELECT fu.id FROM firm_user fu
       JOIN firm_user_role fur ON fur.firm_user_id = fu.id
       JOIN role r ON r.id = fur.role_id
      WHERE r.key = 'MANAGING_PARTNER' AND fu.status = 'ACTIVE'
      ORDER BY fu.id`,
  ).all<{ id: string }>();

  const recipients = partners.results ?? [];
  if (recipients.length === 0) {
    await notifyQuietly(env, input);
    return;
  }
  for (const p of recipients) {
    await notifyQuietly(env, { ...input, firmUserId: p.id, dedupeKey: `${input.dedupeKey}:${p.id}` });
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

/**
 * Why a notification has stopped being outstanding WITHOUT anybody deciding anything about it.
 *
 * THE PROBLEM THIS SOLVES, in the operator's words on 9 Sep 2026: "scooter doesnt check his OS much
 * so fix everything and clear his responsibilities and dismiss everything". `fu_scooter_taylor` had
 * 26 unread notifications and has NEVER SIGNED IN — zero events on the spine, zero notifications
 * read, zero approvals decided. Of those 26, thirteen were fault warnings whose faults are now
 * resolved and twelve were superseded morning-briefing notices. They are not obligations he
 * incurred; they accumulated at him.
 *
 * MARKING THEM READ OR DISMISSED WOULD HAVE BEEN THE EASY FIX AND A FALSIFICATION. `read_by` and
 * `acked_by` name a person, and stamping them would put twenty-six decisions on the audit spine
 * that a man who has never opened the product did not make. Any later question of who knew what,
 * and when, would be answered wrongly and confidently — which is worse than a cluttered screen.
 *
 * DERIVED, THEREFORE SELF-MAINTAINING. Nothing is written. A warning stops being outstanding
 * because the fault it describes is closed; a briefing notice stops because a newer briefing
 * exists. That is true of both partners, applies to notices that do not exist yet, and cannot drift
 * — where a one-off bulk clear would fix twenty-six rows today and let the twenty-seventh pile up
 * tomorrow.
 *
 * A STILL-TRUE CONDITION IS NEVER CLEARED. `silent_failures` was open at the time of writing, so
 * its warning stays outstanding on both partners' lists. Clearing a warning whose subject is still
 * broken is the one outcome worse than leaving it: the operator loses the signal AND keeps the
 * fault.
 *
 * `first_seen_at <= n.created_at` is what ties a notice to the OCCURRENCE it was written about
 * rather than to the check key. `runHealthEscalation` opens a NEW `health_fault` row each time a
 * check goes down again, so without that bound a fault recurring next month would silently
 * resurrect August's warning — while the recurrence writes its own notice anyway.
 */
const STALE_REASON_SQL = `CASE
  WHEN n.object_type = 'health_fault' AND NOT EXISTS (
         SELECT 1 FROM health_fault hf
          WHERE hf.check_key = n.object_id
            AND hf.resolved_at IS NULL
            AND hf.first_seen_at <= n.created_at)
    THEN 'RESOLVED'
  WHEN n.kind = 'INTELLIGENCE_BRIEF' AND n.created_at < (
         SELECT MAX(n2.created_at) FROM notification n2
          WHERE n2.kind = 'INTELLIGENCE_BRIEF'
            AND n2.firm_user_id IS n.firm_user_id
            AND n2.firm_scope = n.firm_scope)
    THEN 'SUPERSEDED'
  ELSE NULL
END`;

export async function handleListNotifications(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const clauses = [visibility, "(firm_user_id IS NULL OR firm_user_id = ?1)"];
  /*
   * `?unread=1` MEANS OUTSTANDING, which is what the status bar has always been trying to ask.
   * Unread AND still true: a warning about a fault that has since been fixed is not something
   * waiting on anybody, and a badge that keeps counting it teaches its reader the number is
   * decorative.
   */
  if (unreadOnly) clauses.push(`read_at IS NULL AND (${STALE_REASON_SQL}) IS NULL`);

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT n.*, ${STALE_REASON_SQL} AS stale_reason FROM notification n
      WHERE ${clauses.join(" AND ")} ORDER BY
       CASE n.severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, n.created_at DESC LIMIT 200`,
  )
    .bind(ctx.identity!.id)
    .all<Record<string, unknown>>();
  const notifications = rows.results ?? [];

  /*
   * COUNTED OVER EVERYTHING, NOT OVER THE PAGE — which is a correctness fix, not a tidy-up.
   *
   * The counts were derived from `notifications`, and that array is capped at 200 by the LIMIT
   * above. The ORDER BY is severity first, so once the firm passes two hundred rows the page fills
   * with CRITICAL and WARNING — read or unread, the ordering does not care — and unread INFO falls
   * off the end. `unread_count` would then have reported a number that was true of the page and
   * false of the firm, and the inbox would have said "You are caught up" with unread notifications
   * sitting in the database. A monitor that under-reports as it gets busier is the worst possible
   * failure mode for one.
   *
   * Not yet fired: production holds 87 notifications today, growing at roughly that a month. This
   * is the fix landing before the bug does, which is the only time it is cheap.
   */
  const totals = await ctx.env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS unread,
            SUM(CASE WHEN n.severity = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
            SUM(CASE WHEN (${STALE_REASON_SQL}) = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN (${STALE_REASON_SQL}) = 'SUPERSEDED' THEN 1 ELSE 0 END) AS superseded
       FROM notification n
      WHERE ${visibility} AND (n.firm_user_id IS NULL OR n.firm_user_id = ?1) AND n.read_at IS NULL`,
  )
    .bind(ctx.identity!.id)
    .first<{ unread: number; critical: number | null; resolved: number | null; superseded: number | null }>();

  const stale = (totals?.resolved ?? 0) + (totals?.superseded ?? 0);

  return json({
    notifications,
    // OUTSTANDING, not merely unread. See STALE_REASON_SQL: a warning about a fault that has since
    // been fixed is not waiting on anybody.
    unread_count: Math.max(0, (totals?.unread ?? 0) - stale),
    critical_unread: totals?.critical ?? 0,
    /*
     * SAID OUT LOUD RATHER THAN SILENTLY SUBTRACTED. "You had 26 and now you have 4" needs to be
     * accountable, or it is just a number that moved. These two say exactly what stopped being
     * outstanding and why — and nothing was written to any of those rows to make it so.
     */
    cleared: {
      resolved: totals?.resolved ?? 0,
      superseded: totals?.superseded ?? 0,
      note:
        "Cleared because the condition ended, not because anybody decided anything. A warning whose " +
        "fault is closed and a briefing a newer one replaced stop waiting on you; nothing is marked " +
        "read or dismissed on your behalf, and everything is still here.",
    },
    // Said plainly, because a list that is quietly shorter than the count above it is the kind of
    // disagreement between two numbers on one screen that makes a partner distrust both.
    truncated: notifications.length >= 200,
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
