import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { notifyQuietly } from "./notifications";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { requestApproval } from "./approvals";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Portfolio monitoring, alerts, support, and outcomes (P8).
 *
 * Governing law (plan §8/P8):
 * - Metrics are ALWAYS dated; deterioration is measured period-over-period between
 *   the two most recent snapshots, using the metric's declared direction.
 * - Severity comes from OPERATOR-set bands on the metric definition. With no bands
 *   configured the alert is raised at LOW and labelled `severity_unconfigured` —
 *   the system never invents a threshold and never claims alert quality (§6, §12.4).
 * - De-duplication is escalation-safe: a repeat at the same or lower severity
 *   increments occurrence_count; a WORSE severity always opens a new alert linked by
 *   escalated_from. Suppression rules cap noise at `max_severity` and can never hide
 *   anything worse.
 * - AI may propose a support match. It can never accept one, and acting on a match
 *   (an introduction/outreach) is the MP-reserved `introduction.relationship_sensitive`
 *   action — the send itself still goes through the P3 external-effect route.
 * - Outcomes are append-only and keep the relationship and value notes verbatim.
 */

export class PortfolioError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const METRIC_DIRECTIONS = ["HIGHER_IS_BETTER", "LOWER_IS_BETTER"] as const;
export const ALERT_TYPES = ["METRIC_DETERIORATION", "STALE_UPDATE", "MISSING_METRIC", "THRESHOLD_BREACH"] as const;
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const SUPPORT_REQUEST_TYPES = ["HIRING", "CUSTOMER_INTRO", "FUNDRAISE", "OPERATIONS", "LEGAL", "OTHER"] as const;
export const SUPPORT_MATCH_TYPES = ["PERSON", "COMPANY", "RESOURCE"] as const;
export const SUPPORT_OUTCOME_TYPES = ["HELPED", "PARTIALLY_HELPED", "NO_EFFECT", "HARMED", "UNKNOWN"] as const;

export type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface MetricDefinitionRow {
  id: string;
  metric_key: string;
  name: string;
  unit: string | null;
  direction: (typeof METRIC_DIRECTIONS)[number];
  severity_bands_json: string;
  stale_after_days: number | null;
  description: string | null;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export interface MetricSnapshotRow {
  id: string;
  company_id: string;
  metric_key: string;
  as_of_date: string;
  period_label: string | null;
  value: number;
  source: string;
  update_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export interface AlertRow {
  id: string;
  company_id: string;
  alert_type: (typeof ALERT_TYPES)[number];
  metric_key: string | null;
  severity: Severity;
  status: string;
  dedupe_key: string;
  detail_json: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  escalated_from: string | null;
  decided_by: string | null;
  decision_note: string | null;
  suppression_rule_id: string | null;
  firm_scope: string;
  created_at: string;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new PortfolioError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new PortfolioError(409, "approval_required", authz.reason);
}

async function requireCompany(env: Env, companyId: string): Promise<void> {
  const row = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(companyId).first();
  if (!row) throw new PortfolioError(400, "unknown_company", `canonical_company '${companyId}' does not exist`);
}

// ── Metric definitions ──

export async function createMetricDefinition(
  env: Env,
  actor: Actor,
  input: { metric_key: string; name: string; direction: (typeof METRIC_DIRECTIONS)[number]; unit?: string; severity_bands?: Record<string, number>; stale_after_days?: number; description?: string },
): Promise<MetricDefinitionRow> {
  await mustAuthorize(env, actor, "portfolio_metric_definition.create", "portfolio_metric_definition");
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM portfolio_metric_definition WHERE metric_key = ?1 AND firm_scope = ?2")
    .bind(input.metric_key, firmScope)
    .first();
  if (existing) throw new PortfolioError(409, "metric_exists", `metric '${input.metric_key}' is already defined`);
  const id = `pmd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO portfolio_metric_definition (id, metric_key, name, unit, direction, severity_bands_json, stale_after_days, description, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      input.metric_key,
      input.name,
      input.unit ?? null,
      input.direction,
      JSON.stringify(input.severity_bands ?? {}),
      input.stale_after_days ?? null,
      input.description ?? null,
      firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  return (await env.WP_OS_DB.prepare("SELECT * FROM portfolio_metric_definition WHERE id = ?1").bind(id).first<MetricDefinitionRow>())!;
}

async function getMetricDefinition(env: Env, metricKey: string, firmScope: string): Promise<MetricDefinitionRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM portfolio_metric_definition WHERE metric_key = ?1 AND firm_scope = ?2")
    .bind(metricKey, firmScope)
    .first<MetricDefinitionRow>();
}

// ── Updates and snapshots ──

export async function createPortfolioUpdate(
  env: Env,
  actor: Actor,
  input: { company_id: string; received_at: string; source: string; period_label?: string; summary?: string; document_id?: string; privacy_label?: string },
) {
  await mustAuthorize(env, actor, "portfolio_update.create", "portfolio_update");
  await requireCompany(env, input.company_id);
  const id = `pup_${crypto.randomUUID()}`;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await env.WP_OS_DB.prepare(
    `INSERT INTO portfolio_update (id, company_id, period_label, received_at, summary, source, document_id, privacy_label, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      input.company_id,
      input.period_label ?? null,
      input.received_at,
      input.summary ?? null,
      input.source,
      input.document_id ?? null,
      input.privacy_label ?? "INTERNAL",
      firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "portfolio.update_recorded",
    actorType,
    actorId,
    objectType: "portfolio_update",
    objectId: id,
    firmScope,
    payload: { company_id: input.company_id, period_label: input.period_label ?? null, received_at: input.received_at },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM portfolio_update WHERE id = ?1").bind(id).first();
}

export async function createMetricSnapshot(
  env: Env,
  actor: Actor,
  input: { company_id: string; metric_key: string; as_of_date: string; value: number; source: string; period_label?: string; update_id?: string; privacy_label?: string },
): Promise<MetricSnapshotRow> {
  await mustAuthorize(env, actor, "portfolio_metric_snapshot.create", "portfolio_metric_snapshot");
  await requireCompany(env, input.company_id);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const definition = await getMetricDefinition(env, input.metric_key, firmScope);
  if (!definition) throw new PortfolioError(400, "unknown_metric", `metric '${input.metric_key}' is not defined`);
  const id = `pms_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO portfolio_metric_snapshot (id, company_id, metric_key, as_of_date, period_label, value, source, update_id, privacy_label, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      input.company_id,
      input.metric_key,
      input.as_of_date,
      input.period_label ?? null,
      input.value,
      input.source,
      input.update_id ?? null,
      input.privacy_label ?? "INTERNAL",
      firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "portfolio.metric_snapshot_recorded",
    actorType,
    actorId,
    objectType: "portfolio_metric_snapshot",
    objectId: id,
    firmScope,
    payload: { company_id: input.company_id, metric_key: input.metric_key, as_of_date: input.as_of_date, value: input.value },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM portfolio_metric_snapshot WHERE id = ?1").bind(id).first<MetricSnapshotRow>())!;
}

// ── Deterministic alert evaluation ──

export interface DeteriorationAssessment {
  deteriorated: boolean;
  change_pct: number;
  severity: Severity;
  severity_configured: boolean;
}

/**
 * Pure period-over-period assessment. `change_pct` is the deterioration magnitude in
 * percent of the prior value (positive = worse). Severity comes from the operator's
 * bands; with no bands the result is LOW and flagged `severity_configured: false`.
 */
export function assessDeterioration(previous: number, current: number, direction: string, bands: Record<string, number>): DeteriorationAssessment {
  const worse = direction === "HIGHER_IS_BETTER" ? current < previous : current > previous;
  const magnitude = previous === 0 ? (worse ? Infinity : 0) : Math.abs((current - previous) / previous) * 100;
  if (!worse) return { deteriorated: false, change_pct: 0, severity: "LOW", severity_configured: Object.keys(bands).length > 0 };
  const configured = Object.keys(bands).length > 0;
  let severity: Severity = "LOW";
  for (const level of ["MEDIUM", "HIGH", "CRITICAL"] as const) {
    const threshold = bands[level];
    if (typeof threshold === "number" && magnitude >= threshold) severity = level;
  }
  return { deteriorated: true, change_pct: magnitude, severity, severity_configured: configured };
}

async function activeSuppression(env: Env, alert: { company_id: string; alert_type: string; metric_key: string | null; firm_scope: string }, now: Date) {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM alert_suppression_rule
      WHERE firm_scope = ?1
        AND (company_id IS NULL OR company_id = ?2)
        AND (alert_type IS NULL OR alert_type = ?3)
        AND (metric_key IS NULL OR metric_key = ?4)`,
  )
    .bind(alert.firm_scope, alert.company_id, alert.alert_type, alert.metric_key)
    .all<{ id: string; max_severity: Severity; expires_at: string | null }>();
  return (rows.results ?? []).filter((r) => !r.expires_at || new Date(r.expires_at) > now);
}

/**
 * Raise (or de-duplicate) an alert. Returns the alert row plus what happened, so
 * callers and tests can see escalation explicitly.
 */
export async function raiseAlert(
  env: Env,
  actor: Actor,
  input: { company_id: string; alert_type: (typeof ALERT_TYPES)[number]; metric_key?: string; severity: Severity; dedupe_key: string; detail?: Record<string, unknown>; firm_scope?: string },
  now = new Date(),
): Promise<{ alert: AlertRow; disposition: "CREATED" | "DEDUPED" | "ESCALATED" | "SUPPRESSED" }> {
  const firmScope = input.firm_scope ?? actor.firmScopes[0] ?? "west-peek";
  const open = await env.WP_OS_DB.prepare(
    "SELECT * FROM portfolio_alert WHERE dedupe_key = ?1 AND status IN ('OPEN','ACKNOWLEDGED','SUPPRESSED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
  )
    .bind(input.dedupe_key)
    .first<AlertRow>();

  // Escalation-safe de-duplication: same or lower severity folds into the open row.
  if (open && SEVERITY_RANK[input.severity] <= SEVERITY_RANK[open.severity]) {
    await env.WP_OS_DB.prepare("UPDATE portfolio_alert SET occurrence_count = occurrence_count + 1, last_seen_at = ?2 WHERE id = ?1")
      .bind(open.id, now.toISOString())
      .run();
    return { alert: (await getAlert(env, open.id))!, disposition: "DEDUPED" };
  }

  const suppressions = await activeSuppression(env, { company_id: input.company_id, alert_type: input.alert_type, metric_key: input.metric_key ?? null, firm_scope: firmScope }, now);
  // A suppression rule can only ever silence severities at or below its cap.
  const suppressing = suppressions.find((r) => SEVERITY_RANK[input.severity] <= SEVERITY_RANK[r.max_severity]);

  const id = `pal_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO portfolio_alert (id, company_id, alert_type, metric_key, severity, status, dedupe_key, detail_json, escalated_from, suppression_rule_id, first_seen_at, last_seen_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)`,
  )
    .bind(
      id,
      input.company_id,
      input.alert_type,
      input.metric_key ?? null,
      input.severity,
      suppressing ? "SUPPRESSED" : "OPEN",
      input.dedupe_key,
      JSON.stringify(input.detail ?? {}),
      open ? open.id : null,
      suppressing ? suppressing.id : null,
      now.toISOString(),
      firmScope,
    )
    .run();
  if (open) {
    // The escalated-from alert is closed by supersession, never edited away.
    await env.WP_OS_DB.prepare("UPDATE portfolio_alert SET status = 'RESOLVED', decision_note = ?2 WHERE id = ?1")
      .bind(open.id, `superseded by higher-severity alert ${id}`)
      .run();
  }
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: open ? "portfolio.alert_escalated" : suppressing ? "portfolio.alert_suppressed" : "portfolio.alert_raised",
    actorType,
    actorId,
    objectType: "portfolio_alert",
    objectId: id,
    firmScope,
    payload: { company_id: input.company_id, alert_type: input.alert_type, metric_key: input.metric_key ?? null, severity: input.severity, escalated_from: open?.id ?? null },
  });
  // P20: an OPEN alert is an exception a human should see. A suppressed one is not.
  if (!suppressing) {
    await notifyQuietly(env, {
      kind: "PORTFOLIO_RISK",
      severity: input.severity === "CRITICAL" ? "CRITICAL" : input.severity === "HIGH" ? "WARNING" : "INFO",
      title: `${input.severity} portfolio alert: ${input.alert_type}`,
      body: `company ${input.company_id}${input.metric_key ? ` · ${input.metric_key}` : ""}`,
      objectType: "portfolio_alert",
      objectId: id,
      privacyLabel: "CONFIDENTIAL",
      dedupeKey: `portfolio_alert:${id}`,
      firmScope,
    });
  }
  return { alert: (await getAlert(env, id))!, disposition: open ? "ESCALATED" : suppressing ? "SUPPRESSED" : "CREATED" };
}

export async function getAlert(env: Env, id: string): Promise<AlertRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM portfolio_alert WHERE id = ?1").bind(id).first<AlertRow>();
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Deterministic evaluation for one company: period-over-period deterioration on
 * every defined metric, plus stale-update and missing-metric detection against the
 * operator's `stale_after_days`. Pure data in, alerts out — no AI involved.
 */
export async function evaluateCompanyAlerts(env: Env, actor: Actor, companyId: string, now = new Date()) {
  await mustAuthorize(env, actor, "portfolio_alert.evaluate", "portfolio_alert", companyId);
  await requireCompany(env, companyId);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const definitions = await env.WP_OS_DB.prepare("SELECT * FROM portfolio_metric_definition WHERE firm_scope = ?1").bind(firmScope).all<MetricDefinitionRow>();
  const results: Array<{ alert: AlertRow; disposition: string }> = [];

  for (const definition of definitions.results ?? []) {
    const snapshots = await env.WP_OS_DB.prepare(
      "SELECT * FROM portfolio_metric_snapshot WHERE company_id = ?1 AND metric_key = ?2 ORDER BY as_of_date DESC, rowid DESC LIMIT 2",
    )
      .bind(companyId, definition.metric_key)
      .all<MetricSnapshotRow>();
    const [current, previous] = snapshots.results ?? [];

    if (!current) {
      if (definition.stale_after_days !== null) {
        results.push(
          await raiseAlert(
            env,
            actor,
            {
              company_id: companyId,
              alert_type: "MISSING_METRIC",
              metric_key: definition.metric_key,
              severity: "MEDIUM",
              dedupe_key: `${companyId}:MISSING_METRIC:${definition.metric_key}`,
              detail: { reason: "no snapshot recorded for a monitored metric" },
              firm_scope: firmScope,
            },
            now,
          ),
        );
      }
      continue;
    }

    if (previous) {
      const bands = JSON.parse(definition.severity_bands_json) as Record<string, number>;
      const assessment = assessDeterioration(previous.value, current.value, definition.direction, bands);
      if (assessment.deteriorated) {
        results.push(
          await raiseAlert(
            env,
            actor,
            {
              company_id: companyId,
              alert_type: "METRIC_DETERIORATION",
              metric_key: definition.metric_key,
              severity: assessment.severity,
              dedupe_key: `${companyId}:METRIC_DETERIORATION:${definition.metric_key}`,
              detail: {
                previous: { value: previous.value, as_of_date: previous.as_of_date },
                current: { value: current.value, as_of_date: current.as_of_date },
                change_pct: assessment.change_pct,
                direction: definition.direction,
                // Honest labelling: with no operator bands this severity is a floor,
                // not a judgement about how bad the change is.
                severity_source: assessment.severity_configured ? "operator_bands" : "severity_unconfigured",
              },
              firm_scope: firmScope,
            },
            now,
          ),
        );
      }
    }

    if (definition.stale_after_days !== null) {
      const ageDays = (now.getTime() - new Date(current.as_of_date).getTime()) / DAY_MS;
      if (ageDays > definition.stale_after_days) {
        results.push(
          await raiseAlert(
            env,
            actor,
            {
              company_id: companyId,
              alert_type: "STALE_UPDATE",
              metric_key: definition.metric_key,
              severity: "MEDIUM",
              dedupe_key: `${companyId}:STALE_UPDATE:${definition.metric_key}`,
              detail: { last_as_of_date: current.as_of_date, age_days: Math.floor(ageDays), stale_after_days: definition.stale_after_days },
              firm_scope: firmScope,
            },
            now,
          ),
        );
      }
    }
  }
  return results;
}

/** Human disposition of an alert. AI can never close an alert. */
export async function decideAlert(env: Env, actor: Actor, alertId: string, to: "ACKNOWLEDGED" | "RESOLVED", note?: string): Promise<AlertRow> {
  const alert = await getAlert(env, alertId);
  if (!alert) throw new PortfolioError(404, "not_found");
  if (actor.type !== "HUMAN") throw new PortfolioError(403, "forbidden", "alert disposition is human-reserved");
  await mustAuthorize(env, actor, "portfolio_alert.decide", "portfolio_alert", alertId, alert.firm_scope);
  if (alert.status === "RESOLVED") throw new PortfolioError(409, "already_resolved");
  await env.WP_OS_DB.prepare("UPDATE portfolio_alert SET status = ?2, decided_by = ?3, decision_note = ?4 WHERE id = ?1")
    .bind(alertId, to, actor.firmUserId!, note ?? null)
    .run();
  await appendEvent(env, {
    eventType: "portfolio.alert_decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "portfolio_alert",
    objectId: alertId,
    firmScope: alert.firm_scope,
    payload: { from: alert.status, to, severity: alert.severity },
  });
  return (await getAlert(env, alertId))!;
}

export async function createSuppressionRule(
  env: Env,
  actor: Actor,
  input: { company_id?: string; alert_type?: string; metric_key?: string; max_severity?: "LOW" | "MEDIUM" | "HIGH"; reason: string; expires_at?: string },
) {
  await mustAuthorize(env, actor, "alert_suppression_rule.create", "alert_suppression_rule");
  if (actor.type !== "HUMAN") throw new PortfolioError(403, "forbidden", "suppression rules are human-set");
  const id = `asr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO alert_suppression_rule (id, company_id, alert_type, metric_key, max_severity, reason, expires_at, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      input.company_id ?? null,
      input.alert_type ?? null,
      input.metric_key ?? null,
      input.max_severity ?? "LOW",
      input.reason,
      input.expires_at ?? null,
      actor.firmScopes[0] ?? "west-peek",
      actor.firmUserId!,
    )
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM alert_suppression_rule WHERE id = ?1").bind(id).first();
}

// ── Support requests, matches, outcomes ──

export interface SupportMatchRow {
  id: string;
  support_request_id: string;
  match_type: string;
  target_label: string;
  target_ref: string | null;
  rationale: string;
  proposed_by_type: "HUMAN" | "AI";
  proposed_by_id: string;
  ai_run_id: string | null;
  status: "PROPOSED" | "ACCEPTED" | "REJECTED" | "ACTED";
  approval_card_id: string | null;
  decided_by: string | null;
  firm_scope: string;
  created_at: string;
}

export async function createSupportRequest(
  env: Env,
  actor: Actor,
  input: { company_id: string; request_type: (typeof SUPPORT_REQUEST_TYPES)[number]; description: string; urgency?: "LOW" | "NORMAL" | "HIGH"; alert_id?: string },
) {
  await mustAuthorize(env, actor, "support_request.create", "support_request");
  await requireCompany(env, input.company_id);
  const id = `sur_${crypto.randomUUID()}`;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await env.WP_OS_DB.prepare(
    `INSERT INTO support_request (id, company_id, request_type, description, urgency, alert_id, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, input.company_id, input.request_type, input.description, input.urgency ?? "NORMAL", input.alert_id ?? null, firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "portfolio.support_requested",
    actorType,
    actorId,
    objectType: "support_request",
    objectId: id,
    firmScope,
    payload: { company_id: input.company_id, request_type: input.request_type, urgency: input.urgency ?? "NORMAL" },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM support_request WHERE id = ?1").bind(id).first();
}

/** AI may propose a match (with its run trace). Proposing contacts nobody. */
export async function proposeSupportMatch(
  env: Env,
  actor: Actor,
  requestId: string,
  input: { match_type: (typeof SUPPORT_MATCH_TYPES)[number]; target_label: string; rationale: string; target_ref?: string; ai_run_id?: string },
): Promise<SupportMatchRow> {
  const request = await env.WP_OS_DB.prepare("SELECT * FROM support_request WHERE id = ?1").bind(requestId).first<{ id: string; firm_scope: string; status: string }>();
  if (!request) throw new PortfolioError(404, "not_found");
  await mustAuthorize(env, actor, "support_match.propose", "support_match", requestId, request.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new PortfolioError(400, "invalid_input", "an AI-proposed match must record its ai_run_id (run_ai trace)");
  }
  const id = `sum_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO support_match (id, support_request_id, match_type, target_label, target_ref, rationale, proposed_by_type, proposed_by_id, ai_run_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(id, requestId, input.match_type, input.target_label, input.target_ref ?? null, input.rationale, actor.type === "AI" ? "AI" : "HUMAN", actorId, input.ai_run_id ?? null, request.firm_scope)
    .run();
  await env.WP_OS_DB.prepare("UPDATE support_request SET status = 'MATCHED' WHERE id = ?1 AND status = 'OPEN'").bind(requestId).run();
  await appendEvent(env, {
    eventType: "portfolio.support_match_proposed",
    actorType,
    actorId,
    objectType: "support_match",
    objectId: id,
    firmScope: request.firm_scope,
    payload: { support_request_id: requestId, proposed_by_type: actor.type === "AI" ? "AI" : "HUMAN", ai_run_id: input.ai_run_id ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM support_match WHERE id = ?1").bind(id).first<SupportMatchRow>())!;
}

/**
 * Human accept/reject of a proposed match. Accepting creates (and submits) the
 * MP-reserved `introduction.relationship_sensitive` approval card — accepting a
 * match is NOT permission to contact anyone.
 */
export async function decideSupportMatch(env: Env, actor: Actor, matchId: string, decision: "ACCEPTED" | "REJECTED"): Promise<SupportMatchRow> {
  const match = await env.WP_OS_DB.prepare("SELECT * FROM support_match WHERE id = ?1").bind(matchId).first<SupportMatchRow>();
  if (!match) throw new PortfolioError(404, "not_found");
  if (actor.type !== "HUMAN") throw new PortfolioError(403, "forbidden", "support-match decisions are human-reserved");
  await mustAuthorize(env, actor, "support_match.decide", "support_match", matchId, match.firm_scope);
  if (match.status !== "PROPOSED") throw new PortfolioError(409, "already_decided", `match is ${match.status}`);

  let approvalCardId: string | null = null;
  if (decision === "ACCEPTED") {
    const card = await requestApproval(env, actor, {
      action_key: "introduction.relationship_sensitive",
      object_type: "support_match",
      object_id: matchId,
      title: `introduction.relationship_sensitive: ${match.target_label}`,
      summary: match.rationale,
      payload: { support_match_id: matchId, support_request_id: match.support_request_id },
      firm_scope: match.firm_scope,
      submit: true,
    });
    approvalCardId = card.id;
  }
  await env.WP_OS_DB.prepare("UPDATE support_match SET status = ?2, decided_by = ?3, approval_card_id = ?4 WHERE id = ?1")
    .bind(matchId, decision, actor.firmUserId!, approvalCardId)
    .run();
  await appendEvent(env, {
    eventType: "portfolio.support_match_decided",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "support_match",
    objectId: matchId,
    firmScope: match.firm_scope,
    payload: { decision, approval_card_id: approvalCardId },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM support_match WHERE id = ?1").bind(matchId).first<SupportMatchRow>())!;
}

export async function recordSupportOutcome(
  env: Env,
  actor: Actor,
  requestId: string,
  input: { outcome_type: (typeof SUPPORT_OUTCOME_TYPES)[number]; support_match_id?: string; value_note?: string; relationship_note?: string },
) {
  const request = await env.WP_OS_DB.prepare("SELECT * FROM support_request WHERE id = ?1").bind(requestId).first<{ id: string; firm_scope: string }>();
  if (!request) throw new PortfolioError(404, "not_found");
  if (actor.type !== "HUMAN") throw new PortfolioError(403, "forbidden", "support outcomes are recorded by the humans involved");
  await mustAuthorize(env, actor, "support_outcome.record", "support_outcome", requestId, request.firm_scope);
  const id = `suo_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO support_outcome (id, support_request_id, support_match_id, outcome_type, value_note, relationship_note, recorded_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, requestId, input.support_match_id ?? null, input.outcome_type, input.value_note ?? null, input.relationship_note ?? null, actor.firmUserId!, request.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "portfolio.support_outcome_recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "support_outcome",
    objectId: id,
    firmScope: request.firm_scope,
    payload: { support_request_id: requestId, outcome_type: input.outcome_type },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM support_outcome WHERE id = ?1").bind(id).first();
}

/**
 * Observed alert VOLUME (§8/P8: alert volume is measured). This reports counts
 * only — it is not a precision, recall, or alert-quality claim, which would require
 * real use and operator feedback.
 */
export async function alertVolume(env: Env, firmScope: string) {
  const byDay = await env.WP_OS_DB.prepare(
    `SELECT substr(first_seen_at, 1, 10) AS day, COUNT(*) AS count
       FROM portfolio_alert WHERE firm_scope = ?1 GROUP BY day ORDER BY day DESC LIMIT 60`,
  )
    .bind(firmScope)
    .all<{ day: string; count: number }>();
  const bySeverity = await env.WP_OS_DB.prepare(
    `SELECT severity, status, COUNT(*) AS count FROM portfolio_alert WHERE firm_scope = ?1 GROUP BY severity, status`,
  )
    .bind(firmScope)
    .all<{ severity: string; status: string; count: number }>();
  return {
    note: "Observed counts only. Alert quality (precision/false-positive rate) is UNPROVEN until real use and operator feedback.",
    by_day: byDay.results ?? [],
    by_severity_status: bySeverity.results ?? [],
  };
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof PortfolioError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const metricDefinitionSchema = z.object({
  metric_key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  direction: z.enum(METRIC_DIRECTIONS),
  unit: z.string().optional(),
  severity_bands: z.record(z.number()).optional(),
  stale_after_days: z.number().int().positive().optional(),
  description: z.string().optional(),
});

export async function handleCreateMetricDefinition(ctx: RouteContext): Promise<Response> {
  const parsed = metricDefinitionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createMetricDefinition(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListMetricDefinitions(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM portfolio_metric_definition ORDER BY metric_key").all();
  return json({ metric_definitions: rows.results ?? [] });
}

const updateSchema = z.object({
  company_id: z.string().trim().min(1),
  received_at: z.string().trim().min(1),
  source: z.string().trim().min(1),
  period_label: z.string().optional(),
  summary: z.string().optional(),
  document_id: z.string().optional(),
  privacy_label: privacyLabelSchema.optional(),
});

export async function handleCreatePortfolioUpdate(ctx: RouteContext): Promise<Response> {
  const parsed = updateSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createPortfolioUpdate(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const snapshotSchema = z.object({
  company_id: z.string().trim().min(1),
  metric_key: z.string().trim().min(1),
  as_of_date: z.string().trim().min(1),
  value: z.number(),
  source: z.string().trim().min(1),
  period_label: z.string().optional(),
  update_id: z.string().optional(),
  privacy_label: privacyLabelSchema.optional(),
});

export async function handleCreateMetricSnapshot(ctx: RouteContext): Promise<Response> {
  const parsed = snapshotSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createMetricSnapshot(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListMetricSnapshots(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = companyId
    ? await ctx.env.WP_OS_DB.prepare(`SELECT * FROM portfolio_metric_snapshot WHERE company_id = ?1 AND ${visibility} ORDER BY as_of_date DESC, id LIMIT 500`).bind(companyId).all()
    : await ctx.env.WP_OS_DB.prepare(`SELECT * FROM portfolio_metric_snapshot WHERE ${visibility} ORDER BY as_of_date DESC, id LIMIT 500`).all();
  return json({ metric_snapshots: rows.results ?? [] });
}

export async function handleEvaluateAlerts(ctx: RouteContext): Promise<Response> {
  try {
    const results = await evaluateCompanyAlerts(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!);
    return json({ results }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListAlerts(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const status = url.searchParams.get("status");
  const clauses = ["1=1"];
  const binds: string[] = [];
  if (companyId) {
    clauses.push(`company_id = ?${binds.length + 1}`);
    binds.push(companyId);
  }
  if (status) {
    clauses.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM portfolio_alert WHERE ${clauses.join(" AND ")} ORDER BY last_seen_at DESC, id LIMIT 500`)
    .bind(...binds)
    .all<AlertRow>();
  return json({ alerts: rows.results ?? [] });
}

const alertDecisionSchema = z.object({ to: z.enum(["ACKNOWLEDGED", "RESOLVED"]), note: z.string().optional() });

export async function handleDecideAlert(ctx: RouteContext): Promise<Response> {
  const parsed = alertDecisionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideAlert(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to, parsed.data.note));
  } catch (err) {
    return errorResponse(err);
  }
}

const suppressionSchema = z.object({
  company_id: z.string().optional(),
  alert_type: z.enum(ALERT_TYPES).optional(),
  metric_key: z.string().optional(),
  max_severity: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  reason: z.string().trim().min(1),
  expires_at: z.string().optional(),
});

export async function handleCreateSuppressionRule(ctx: RouteContext): Promise<Response> {
  const parsed = suppressionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createSuppressionRule(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const supportRequestSchema = z.object({
  company_id: z.string().trim().min(1),
  request_type: z.enum(SUPPORT_REQUEST_TYPES),
  description: z.string().trim().min(1),
  urgency: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  alert_id: z.string().optional(),
});

export async function handleCreateSupportRequest(ctx: RouteContext): Promise<Response> {
  const parsed = supportRequestSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createSupportRequest(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListSupportRequests(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const rows = companyId
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM support_request WHERE company_id = ?1 ORDER BY created_at DESC, id").bind(companyId).all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM support_request ORDER BY created_at DESC, id LIMIT 500").all();
  return json({ support_requests: rows.results ?? [] });
}

export async function handleGetSupportRequest(ctx: RouteContext): Promise<Response> {
  const request = await ctx.env.WP_OS_DB.prepare("SELECT * FROM support_request WHERE id = ?1").bind(ctx.params.id!).first();
  if (!request) return json({ error: "not_found" }, { status: 404 });
  const matches = await ctx.env.WP_OS_DB.prepare("SELECT * FROM support_match WHERE support_request_id = ?1 ORDER BY created_at, id").bind(ctx.params.id!).all();
  const outcomes = await ctx.env.WP_OS_DB.prepare("SELECT * FROM support_outcome WHERE support_request_id = ?1 ORDER BY created_at, id").bind(ctx.params.id!).all();
  return json({ ...request, matches: matches.results ?? [], outcomes: outcomes.results ?? [] });
}

const matchSchema = z.object({
  match_type: z.enum(SUPPORT_MATCH_TYPES),
  target_label: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  target_ref: z.string().optional(),
});

export async function handleProposeSupportMatch(ctx: RouteContext): Promise<Response> {
  const parsed = matchSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await proposeSupportMatch(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const matchDecisionSchema = z.object({ decision: z.enum(["ACCEPTED", "REJECTED"]) });

export async function handleDecideSupportMatch(ctx: RouteContext): Promise<Response> {
  const parsed = matchDecisionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideSupportMatch(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.decision));
  } catch (err) {
    return errorResponse(err);
  }
}

const outcomeSchema = z.object({
  outcome_type: z.enum(SUPPORT_OUTCOME_TYPES),
  support_match_id: z.string().optional(),
  value_note: z.string().optional(),
  relationship_note: z.string().optional(),
});

export async function handleRecordSupportOutcome(ctx: RouteContext): Promise<Response> {
  const parsed = outcomeSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordSupportOutcome(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAlertVolume(ctx: RouteContext): Promise<Response> {
  const scopes = ctx.identity!.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  return json(await alertVolume(ctx.env, scopes[0] ?? "west-peek"));
}
