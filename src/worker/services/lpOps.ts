import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, canAccessPrivacyLabel } from "./authorize";
import { notifyPartners } from "./notifications";

/**
 * LP / fund-admin / VDR operating surface (P24, GAP-18).
 *
 * P10 and P12 built the workflows. This adds the operating view over them: where administrator
 * data would come from, whether a contract for it exists at all, when reconciliation is next due,
 * how stale the last import is, which diligence requests are outstanding, what has been shared and
 * revoked in the data room, and where each LP relationship stands.
 *
 * Authority is unchanged and restated in the payload: the administrator, the accountant, and the
 * VDR are authoritative for their own domains. `contract_state = LIVE` can only be reached by an
 * actual import, so a firm cannot mark itself integrated by filling in a form.
 */

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export async function handleLpOpsOverview(ctx: RouteContext): Promise<Response> {
  // LP data is LP_PRIVATE and banking data is BANKING_RESTRICTED. A user without the scope gets
  // a refusal, not an empty page that implies there is nothing to see.
  if (!canAccessPrivacyLabel(ctx.identity!, "LP_PRIVATE")) {
    return json({ error: "forbidden", detail: "the LP operating surface requires LP_PRIVATE scope" }, { status: 403 });
  }
  const now = new Date();

  const sources = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM admin_source ORDER BY kind, source_key").all<{
      id: string;
      source_key: string;
      name: string;
      kind: string;
      contract_state: string;
      export_format: string;
      freshness_sla_days: number;
      last_import_at: string | null;
      note: string;
    }>()
  ).results ?? [];

  const schedules = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT s.*, f.name AS fund_name FROM reconciliation_schedule s JOIN fund f ON f.id = s.fund_id WHERE s.active = 1`,
    ).all<{ id: string; fund_id: string; fund_name: string; cadence: string; next_due_at: string; last_run_id: string | null }>()
  ).results ?? [];

  const runs = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, fund_id, source_mode, created_at FROM fund_reconciliation_run ORDER BY created_at DESC LIMIT 20").all<{
      id: string;
      fund_id: string;
      source_mode: string;
      created_at: string;
    }>()
  ).results ?? [];

  const exceptions = canAccessPrivacyLabel(ctx.identity!, "BANKING_RESTRICTED")
    ? (
        await ctx.env.WP_OS_DB.prepare(
          "SELECT id, fund_id, record_kind, record_key, field, exception_kind, difference, status, created_at FROM fund_reconciliation_exception WHERE status = 'OPEN' ORDER BY created_at DESC LIMIT 50",
        ).all<Record<string, unknown>>()
      ).results ?? []
    : null;

  const packets = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT p.id, p.period_id, p.version, p.status, p.distributed_at,
              (SELECT COUNT(*) FROM reporting_review r WHERE r.packet_id = p.id AND r.status = 'COMPLETED') AS reviews_completed,
              (SELECT COUNT(*) FROM reporting_review r WHERE r.packet_id = p.id) AS reviews
         FROM lp_reporting_packet p ORDER BY p.created_at DESC LIMIT 20`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const diligence = (
    await ctx.env.WP_OS_DB.prepare(
      "SELECT id, lp_opportunity_id, request_text, status, due_date, created_at FROM lp_diligence_request WHERE status = 'OPEN' ORDER BY created_at DESC LIMIT 50",
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const access = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT a.id, a.artifact_id, a.recipient_label, a.permission, a.granted_at,
              (SELECT COUNT(*) FROM data_room_revocation r WHERE r.access_record_id = a.id) AS revocations
         FROM data_room_access_record a ORDER BY a.granted_at DESC LIMIT 50`,
    ).all<{ id: string; artifact_id: string; recipient_label: string; permission: string; granted_at: string; revocations: number }>()
  ).results ?? [];

  const engagements = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT e.*, r.legal_name FROM lp_engagement e JOIN lp_record r ON r.id = e.lp_record_id ORDER BY e.updated_at DESC`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  return json({
    sources: sources.map((s) => {
      const age = daysSince(s.last_import_at, now);
      return {
        ...s,
        days_since_import: age,
        freshness:
          s.contract_state === "NO_CONTRACT"
            ? "NEVER_IMPORTED — no source contract exists"
            : age === null
              ? "NEVER_IMPORTED"
              : age <= s.freshness_sla_days
                ? "FRESH"
                : `STALE by ${age - s.freshness_sla_days} day(s)`,
      };
    }),
    reconciliation_schedules: schedules.map((s) => ({
      ...s,
      due: new Date(s.next_due_at).getTime() <= now.getTime(),
      days_until_due: Math.ceil((new Date(s.next_due_at).getTime() - now.getTime()) / 86_400_000),
    })),
    recent_runs: runs,
    open_exceptions: exceptions,
    exceptions_note:
      exceptions === null ? "Reconciliation exceptions are BANKING_RESTRICTED and are not visible with your scopes." : undefined,
    reporting_packets: packets,
    outstanding_diligence: diligence,
    data_room_access: access.map((a) => ({ ...a, revoked: a.revocations > 0 })),
    lp_engagements: engagements,
    authority:
      "The fund administrator, the accountant, and the VDR are authoritative for their own domains. West Peek OS records, compares, and escalates; it never overwrites an administrator figure and has no code path that writes to one.",
    gates: {
      fund_admin: "UNPROVEN — SOURCE CONTRACT GATE: no administrator system has been read and no export format has been agreed.",
      vdr: "UNPROVEN — PROVIDER NOT SELECTED: West Peek OS records what was shared and revoked; it has never delivered a document.",
      distribution: "LP distribution proves routing and review only. Actual delivery is an external effect that has never run.",
    },
  });
}

const sourceSchema = z.object({
  source_key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(["FUND_ADMIN", "ACCOUNTING", "VDR"]),
  contract_state: z.enum(["NO_CONTRACT", "FORMAT_AGREED"]),
  export_format: z.string().trim().default(""),
  freshness_sla_days: z.number().int().positive().default(30),
  note: z.string().trim().default(""),
});

/**
 * Register or update an administrator source. `LIVE` is deliberately NOT accepted from a caller:
 * a source becomes LIVE only when an import actually happens, so a firm cannot declare itself
 * integrated by filling in a form.
 */
export async function handleRegisterAdminSource(ctx: RouteContext): Promise<Response> {
  const parsed = sourceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "admin_source.register", { objectType: "admin_source" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const b = parsed.data;
  if (b.contract_state === "FORMAT_AGREED" && b.export_format.length === 0) {
    return json({ error: "format_required", detail: "FORMAT_AGREED must name the agreed export format" }, { status: 400 });
  }

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO admin_source (id, source_key, name, kind, contract_state, export_format, freshness_sla_days, note, registered_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (source_key) DO UPDATE SET
       name = excluded.name, kind = excluded.kind, contract_state = excluded.contract_state,
       export_format = excluded.export_format, freshness_sla_days = excluded.freshness_sla_days, note = excluded.note`,
  )
    .bind(`asrc_${crypto.randomUUID()}`, b.source_key, b.name, b.kind, b.contract_state, b.export_format, b.freshness_sla_days, b.note, ctx.identity!.id)
    .run();

  return json(
    {
      source: await ctx.env.WP_OS_DB.prepare("SELECT * FROM admin_source WHERE source_key = ?1").bind(b.source_key).first(),
      note: "contract_state LIVE cannot be set by hand. It is reached only when a reconciliation import actually reads this source.",
    },
    { status: 201 },
  );
}

const scheduleSchema = z.object({
  fund_id: z.string().trim().min(1),
  cadence: z.enum(["MONTHLY", "QUARTERLY"]),
  next_due_at: z.string().trim().min(1),
});

export async function handleSetReconciliationSchedule(ctx: RouteContext): Promise<Response> {
  const parsed = scheduleSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "reconciliation_schedule.set", { objectType: "reconciliation_schedule" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const fund = await ctx.env.WP_OS_DB.prepare("SELECT id FROM fund WHERE id = ?1").bind(parsed.data.fund_id).first();
  if (!fund) return json({ error: "fund_not_found" }, { status: 404 });

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO reconciliation_schedule (id, fund_id, cadence, next_due_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (fund_id) DO UPDATE SET cadence = excluded.cadence, next_due_at = excluded.next_due_at, active = 1`,
  )
    .bind(`rsch_${crypto.randomUUID()}`, parsed.data.fund_id, parsed.data.cadence, parsed.data.next_due_at, ctx.identity!.id)
    .run();

  return json(
    {
      schedule: await ctx.env.WP_OS_DB.prepare("SELECT * FROM reconciliation_schedule WHERE fund_id = ?1").bind(parsed.data.fund_id).first(),
      note: "A schedule says when reconciliation is DUE. Running it still requires administrator records, which need a source contract that does not yet exist.",
    },
    { status: 201 },
  );
}

const engagementSchema = z.object({
  state: z.enum(["NOT_ENGAGED", "IN_CONVERSATION", "IN_DILIGENCE", "AWAITING_DECISION", "COMMITTED", "DECLINED"]),
  next_step: z.string().trim().default(""),
  note: z.string().trim().default(""),
});

export async function handleUpdateLpEngagement(ctx: RouteContext): Promise<Response> {
  const parsed = engagementSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (!canAccessPrivacyLabel(ctx.identity!, "LP_PRIVATE")) {
    return json({ error: "forbidden", detail: "LP engagement is LP_PRIVATE" }, { status: 403 });
  }
  const authz = await authorize(ctx.env, actor, "lp_engagement.update", { objectType: "lp_record", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const lp = await ctx.env.WP_OS_DB.prepare("SELECT id, legal_name FROM lp_record WHERE id = ?1").bind(ctx.params.id!).first<{ id: string; legal_name: string }>();
  if (!lp) return json({ error: "not_found" }, { status: 404 });

  const current = await ctx.env.WP_OS_DB.prepare("SELECT state FROM lp_engagement WHERE lp_record_id = ?1").bind(lp.id).first<{ state: string }>();
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO lp_engagement (lp_record_id, state, owner_id, next_step, last_touch_at, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?3, ?5)
     ON CONFLICT (lp_record_id) DO UPDATE SET
       state = excluded.state, owner_id = excluded.owner_id, next_step = excluded.next_step,
       last_touch_at = excluded.last_touch_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(lp.id, parsed.data.state, ctx.identity!.id, parsed.data.next_step, now)
    .run();

  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO lp_engagement_change (id, lp_record_id, from_state, to_state, note, actor_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(`lpec_${crypto.randomUUID()}`, lp.id, current?.state ?? "NOT_ENGAGED", parsed.data.state, parsed.data.note, ctx.identity!.id)
    .run();

  await appendEvent(ctx.env, {
    eventType: "lp_engagement.updated",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "lp_record",
    objectId: lp.id,
    payload: { from: current?.state ?? "NOT_ENGAGED", to: parsed.data.state },
  });

  if (parsed.data.state === "AWAITING_DECISION") {
    await notifyPartners(ctx.env, {
      kind: "LP_ISSUE",
      severity: "WARNING",
      title: `${lp.legal_name} is awaiting a decision`,
      body: parsed.data.next_step,
      objectType: "lp_record",
      objectId: lp.id,
      privacyLabel: "LP_PRIVATE",
      dedupeKey: `lp_awaiting:${lp.id}:${now.slice(0, 10)}`,
    });
  }

  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM lp_engagement WHERE lp_record_id = ?1").bind(lp.id).first());
}
