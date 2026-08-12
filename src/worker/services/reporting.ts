import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard } from "./approvals";

/**
 * LP reporting and fund-administration reconciliation (P12).
 *
 * Law (plan §8/P12 + §12.4):
 * - The administrator/accountant is AUTHORITATIVE for their domain. This service
 *   imports their figures as evidence and never writes back to them. There is no
 *   route, adapter, or code path in West Peek OS that mutates an administrator or
 *   accounting system.
 * - A discrepancy creates an EXCEPTION recording BOTH observed values. Resolving it
 *   records a human disposition; the recorded values are frozen by database trigger,
 *   so no role — including an MP, including direct SQL — can overwrite what the
 *   administrator reported.
 * - A packet cannot be distributed until EVERY required review row is COMPLETED, and
 *   distribution additionally needs the reserved `lp_sensitive_communication.send`
 *   receipt (P10 law: LP-facing material is human-gated).
 * - An AI may draft a packet with its run trace. It can never review, distribute,
 *   resolve an exception, issue a capital call, approve a distribution, initiate a
 *   wire, or change a bank account — those are reserved and DENY for AI actors.
 * - NOTHING HERE CERTIFIES financial, accounting, or valuation correctness. The
 *   proof this service can offer is about process, review, and discrepancy (§12.4).
 */

export class ReportingError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** Every packet needs all three before it can leave the building. */
export const REQUIRED_REVIEWS = ["FINANCE", "COMPLIANCE", "MANAGING_PARTNER"] as const;
export type ReviewType = (typeof REQUIRED_REVIEWS)[number];

/** Roles entitled to record each review. A reviewer cannot cover for another function. */
export const REVIEW_ROLES: Readonly<Record<ReviewType, readonly string[]>> = {
  FINANCE: ["MANAGING_PARTNER", "FUND_ADMINISTRATOR", "FINANCE_AUTHORITY"],
  COMPLIANCE: ["MANAGING_PARTNER", "COMPLIANCE_OFFICER"],
  MANAGING_PARTNER: ["MANAGING_PARTNER"],
};

export const RECORD_KINDS = ["POSITION", "CAPITAL_ACCOUNT", "DISTRIBUTION", "CAPITAL_CALL", "NAV", "OTHER"] as const;
export const RESOLUTIONS = ["ACCEPT_ADMINISTRATOR", "CORRECT_INTERNAL", "ESCALATE_TO_ADMINISTRATOR", "NO_ACTION"] as const;

/**
 * The administrator export contract. A live reconciliation needs a real
 * administrator source contract and human authorization (§7.2); until then runs are
 * stamped LOCAL_FIXTURE and the ledger says so.
 */
export const ADMINISTRATOR_EXPORT_CONTRACT_VERSION = "wpos-fundadmin-export-1.0.0";

export const administratorRecordSchema = z.object({
  record_kind: z.enum(RECORD_KINDS),
  /** Stable key the administrator uses for this record (their id, not ours). */
  record_key: z.string().trim().min(1),
  field: z.string().trim().min(1),
  /** The administrator's reported value, as a string so nothing is coerced silently. */
  value: z.string(),
});

export type AdministratorRecord = z.infer<typeof administratorRecordSchema>;

export interface PacketRow {
  id: string;
  period_id: string;
  version: number;
  title: string;
  status: string;
  distributed_at: string | null;
  drafted_by_type: "HUMAN" | "AI";
  privacy_label: string;
  firm_scope: string;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new ReportingError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new ReportingError(409, "approval_required", authz.reason);
}

export async function getPacket(env: Env, id: string): Promise<PacketRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM lp_reporting_packet WHERE id = ?1").bind(id).first<PacketRow>();
}

// ── Periods and packets ──

export async function createPeriod(
  env: Env,
  actor: Actor,
  input: { fund_id: string; label: string; period_start: string; period_end: string },
) {
  const fund = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM fund WHERE id = ?1").bind(input.fund_id).first<{ id: string; firm_scope: string }>();
  if (!fund) throw new ReportingError(400, "unknown_fund", `fund '${input.fund_id}' does not exist`);
  await mustAuthorize(env, actor, "reporting_period.create", "lp_reporting_period", undefined, fund.firm_scope);
  const id = `lrp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_reporting_period (id, fund_id, label, period_start, period_end, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, fund.id, input.label, input.period_start, input.period_end, fund.firm_scope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "reporting.period_opened",
    actorType,
    actorId,
    objectType: "lp_reporting_period",
    objectId: id,
    firmScope: fund.firm_scope,
    payload: { fund_id: fund.id, label: input.label },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM lp_reporting_period WHERE id = ?1").bind(id).first();
}

export async function createPacket(
  env: Env,
  actor: Actor,
  periodId: string,
  input: { title: string; version?: number; document_id?: string; summary?: string; ai_run_id?: string },
): Promise<PacketRow> {
  const period = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM lp_reporting_period WHERE id = ?1").bind(periodId).first<{ id: string; firm_scope: string }>();
  if (!period) throw new ReportingError(404, "not_found");
  await mustAuthorize(env, actor, "reporting_packet.create", "lp_reporting_packet", periodId, period.firm_scope);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new ReportingError(400, "invalid_input", "an AI-drafted reporting packet must record its ai_run_id (run_ai trace)");
  }
  const id = `lrk_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_reporting_packet (id, period_id, version, title, document_id, summary, drafted_by_type, drafted_by_id, ai_run_id, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(id, periodId, input.version ?? 1, input.title, input.document_id ?? null, input.summary ?? null, actor.type === "AI" ? "AI" : "HUMAN", actorId, input.ai_run_id ?? null, period.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "reporting.packet_drafted",
    actorType,
    actorId,
    objectType: "lp_reporting_packet",
    objectId: id,
    firmScope: period.firm_scope,
    payload: { period_id: periodId, version: input.version ?? 1, drafted_by_type: actor.type === "AI" ? "AI" : "HUMAN" },
  });
  return (await getPacket(env, id))!;
}

/** DRAFT → IN_REVIEW, opening one PENDING row per required review. */
export async function submitPacket(env: Env, actor: Actor, packetId: string) {
  const packet = await getPacket(env, packetId);
  if (!packet) throw new ReportingError(404, "not_found");
  if (actor.type !== "HUMAN") throw new ReportingError(403, "forbidden", "an AI can never submit a reporting packet for review");
  await mustAuthorize(env, actor, "reporting_packet.submit", "lp_reporting_packet", packetId, packet.firm_scope);
  if (packet.status !== "DRAFT") throw new ReportingError(409, "illegal_state", `packet is ${packet.status}`);

  for (const reviewType of REQUIRED_REVIEWS) {
    await env.WP_OS_DB.prepare(
      "INSERT OR IGNORE INTO reporting_review (id, packet_id, review_type, firm_scope) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(`rvw_${crypto.randomUUID()}`, packetId, reviewType, packet.firm_scope)
      .run();
  }
  await env.WP_OS_DB.prepare("UPDATE lp_reporting_packet SET status = 'IN_REVIEW' WHERE id = ?1").bind(packetId).run();
  await appendEvent(env, {
    eventType: "reporting.packet_submitted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_reporting_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { required_reviews: [...REQUIRED_REVIEWS] },
  });
  return reviewState(env, packetId);
}

export async function reviewState(env: Env, packetId: string) {
  const rows = await env.WP_OS_DB.prepare("SELECT * FROM reporting_review WHERE packet_id = ?1 ORDER BY review_type").bind(packetId).all<{
    review_type: ReviewType;
    status: string;
  }>();
  const reviews = rows.results ?? [];
  return {
    packet_id: packetId,
    reviews,
    outstanding: REQUIRED_REVIEWS.filter((r) => reviews.find((row) => row.review_type === r)?.status !== "COMPLETED"),
    all_complete: reviews.length === REQUIRED_REVIEWS.length && reviews.every((r) => r.status === "COMPLETED"),
  };
}

export async function recordReview(
  env: Env,
  actor: Actor,
  packetId: string,
  input: { review_type: ReviewType; status: "COMPLETED" | "REJECTED"; note?: string },
) {
  const packet = await getPacket(env, packetId);
  if (!packet) throw new ReportingError(404, "not_found");
  if (actor.type !== "HUMAN") throw new ReportingError(403, "forbidden", "a reporting review is a human act; an AI can never record one");
  await mustAuthorize(env, actor, "reporting_review.record", "reporting_review", packetId, packet.firm_scope);
  if (packet.status !== "IN_REVIEW") throw new ReportingError(409, "illegal_state", `packet is ${packet.status}`);

  // A reviewer must actually hold the function they are signing off for.
  const allowed = REVIEW_ROLES[input.review_type];
  if (!allowed.some((role) => actor.roles.includes(role))) {
    throw new ReportingError(403, "wrong_reviewer_role", `${input.review_type} review requires one of: ${allowed.join(", ")}`);
  }

  const review = await env.WP_OS_DB.prepare("SELECT * FROM reporting_review WHERE packet_id = ?1 AND review_type = ?2")
    .bind(packetId, input.review_type)
    .first<{ id: string; status: string }>();
  if (!review) throw new ReportingError(404, "review_not_found");
  if (review.status !== "PENDING") throw new ReportingError(409, "already_reviewed", `${input.review_type} is ${review.status}`);

  await env.WP_OS_DB.prepare(
    "UPDATE reporting_review SET status = ?2, reviewer_id = ?3, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), note = ?4 WHERE id = ?1",
  )
    .bind(review.id, input.status, actor.firmUserId!, input.note ?? null)
    .run();

  const state = await reviewState(env, packetId);
  if (state.all_complete) {
    await env.WP_OS_DB.prepare("UPDATE lp_reporting_packet SET status = 'APPROVED' WHERE id = ?1").bind(packetId).run();
  } else if (input.status === "REJECTED") {
    // A rejected review ends THIS packet. Without this the packet would sit in
    // IN_REVIEW forever: `all_complete` can never become true, the review cannot be
    // re-recorded, and submit only accepts DRAFT — an unreachable state with no way out.
    // WITHDRAWN is terminal on purpose: a reviewer's refusal is not edited away, and
    // the corrected report goes out as a NEW VERSION of the period (same supersession
    // rule the rest of the system follows).
    await env.WP_OS_DB.prepare("UPDATE lp_reporting_packet SET status = 'WITHDRAWN' WHERE id = ?1").bind(packetId).run();
  }
  await appendEvent(env, {
    eventType: "reporting.review_recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "reporting_review",
    objectId: review.id,
    firmScope: packet.firm_scope,
    payload: { packet_id: packetId, review_type: input.review_type, status: input.status },
  });
  return state;
}

/**
 * Distribute a packet. TWO independent gates: every required review COMPLETED, and
 * an approved `lp_sensitive_communication.send` receipt. Distribution records who
 * received which VERSION; the delivery itself is an external effect or an external
 * system, never something this service performs.
 */
export async function distributePacket(
  env: Env,
  actor: Actor,
  packetId: string,
  input: { recipients: Array<{ recipient_label: string; lp_record_id?: string }>; approval_receipt_id?: string; delivery_note?: string },
) {
  const packet = await getPacket(env, packetId);
  if (!packet) throw new ReportingError(404, "not_found");
  if (actor.type !== "HUMAN") throw new ReportingError(403, "forbidden", "an AI can never distribute LP reporting");
  if (packet.status === "DISTRIBUTED") throw new ReportingError(409, "already_distributed");
  // A withdrawn packet is refused by name rather than by its incomplete review set,
  // so the reason a reviewer sees is the real one.
  if (packet.status === "WITHDRAWN") throw new ReportingError(409, "packet_withdrawn", "a review was rejected; issue a corrected version of this period");

  // Review gate FIRST: an unreviewed packet is refused before any receipt is read,
  // so a valid receipt can never stand in for a missing review.
  const state = await reviewState(env, packetId);
  if (!state.all_complete) {
    throw new ReportingError(409, "reviews_incomplete", `outstanding required reviews: ${state.outstanding.join(", ")}`);
  }

  const authz = await authorize(
    env,
    actor,
    "lp_sensitive_communication.send",
    { objectType: "lp_reporting_packet", objectId: packetId, firmScope: packet.firm_scope },
    { receiptId: input.approval_receipt_id },
  );
  if (authz.decision === "DENY") throw new ReportingError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") throw new ReportingError(409, "approval_required", authz.reason);

  const receipts: unknown[] = [];
  for (const recipient of input.recipients) {
    const id = `dre_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      "INSERT INTO distribution_receipt (id, packet_id, packet_version, lp_record_id, recipient_label, approval_card_id, distributed_by, delivery_note, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
      .bind(id, packetId, packet.version, recipient.lp_record_id ?? null, recipient.recipient_label, authz.receiptId!, actor.firmUserId!, input.delivery_note ?? null, packet.firm_scope)
      .run();
    receipts.push(await env.WP_OS_DB.prepare("SELECT * FROM distribution_receipt WHERE id = ?1").bind(id).first());
  }

  await env.WP_OS_DB.prepare("UPDATE lp_reporting_packet SET status = 'DISTRIBUTED', distributed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), approval_card_id = ?2 WHERE id = ?1")
    .bind(packetId, authz.receiptId!)
    .run();
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "reporting.packet_distributed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_reporting_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { recipients: input.recipients.length, packet_version: packet.version, receipt_id: authz.receiptId },
  });
  return { packet: (await getPacket(env, packetId))!, distribution_receipts: receipts };
}

// ── Reconciliation ──

export interface InternalRecordLookup {
  record_kind: string;
  record_key: string;
  field: string;
  value: string | null;
}

/**
 * Compare imported administrator records against the internal values supplied for
 * the same keys. Pure and deterministic: given both sides, the exception set is
 * fully determined. Neither side is modified — the output is a list of differences.
 */
export function compareRecords(
  administrator: AdministratorRecord[],
  internal: InternalRecordLookup[],
): Array<{ record_kind: string; record_key: string; field: string; administrator_value: string | null; internal_value: string | null; difference: number | null; exception_kind: string }> {
  const key = (kind: string, k: string, f: string) => `${kind}::${k}::${f}`;
  const internalByKey = new Map(internal.map((r) => [key(r.record_kind, r.record_key, r.field), r]));
  const seen = new Set<string>();
  const exceptions: ReturnType<typeof compareRecords> = [];

  for (const record of administrator) {
    const k = key(record.record_kind, record.record_key, record.field);
    seen.add(k);
    const match = internalByKey.get(k);
    if (!match || match.value === null) {
      exceptions.push({
        record_kind: record.record_kind,
        record_key: record.record_key,
        field: record.field,
        administrator_value: record.value,
        internal_value: null,
        difference: null,
        exception_kind: "MISSING_INTERNAL",
      });
      continue;
    }
    if (match.value === record.value) continue;
    // Numeric fields get a signed difference (internal − administrator) so the size
    // and direction of the gap are visible; non-numeric ones report no difference
    // rather than a misleading 0.
    const adminNum = Number(record.value);
    const internalNum = Number(match.value);
    const numeric = record.value.trim() !== "" && match.value.trim() !== "" && Number.isFinite(adminNum) && Number.isFinite(internalNum);
    exceptions.push({
      record_kind: record.record_kind,
      record_key: record.record_key,
      field: record.field,
      administrator_value: record.value,
      internal_value: match.value,
      difference: numeric ? internalNum - adminNum : null,
      exception_kind: "VALUE_MISMATCH",
    });
  }

  // Internal records the administrator did not report at all.
  for (const record of internal) {
    const k = key(record.record_kind, record.record_key, record.field);
    if (seen.has(k)) continue;
    exceptions.push({
      record_kind: record.record_kind,
      record_key: record.record_key,
      field: record.field,
      administrator_value: null,
      internal_value: record.value,
      difference: null,
      exception_kind: "MISSING_ADMINISTRATOR",
    });
  }
  return exceptions;
}

export async function runReconciliation(
  env: Env,
  actor: Actor,
  input: {
    fund_id: string;
    period_id?: string;
    source_system: string;
    source_reference?: string;
    administrator_records: AdministratorRecord[];
    internal_records: InternalRecordLookup[];
  },
) {
  const fund = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM fund WHERE id = ?1").bind(input.fund_id).first<{ id: string; firm_scope: string }>();
  if (!fund) throw new ReportingError(400, "unknown_fund", `fund '${input.fund_id}' does not exist`);
  if (actor.type !== "HUMAN") throw new ReportingError(403, "forbidden", "importing administrator records is a human act");
  await mustAuthorize(env, actor, "reconciliation_run.import", "fund_reconciliation_run", undefined, fund.firm_scope);

  const exceptions = compareRecords(input.administrator_records, input.internal_records);
  const runId = `frr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO fund_reconciliation_run
       (id, fund_id, period_id, source_system, source_contract_version, source_reference, source_mode, record_count, matched_count, exception_count, run_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'LOCAL_FIXTURE', ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      runId,
      fund.id,
      input.period_id ?? null,
      input.source_system,
      ADMINISTRATOR_EXPORT_CONTRACT_VERSION,
      input.source_reference ?? null,
      input.administrator_records.length,
      input.administrator_records.length - exceptions.filter((e) => e.exception_kind !== "MISSING_ADMINISTRATOR").length,
      exceptions.length,
      actor.firmUserId!,
      fund.firm_scope,
    )
    .run();

  const stored: unknown[] = [];
  for (const exception of exceptions) {
    const id = `fre_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO fund_reconciliation_exception
         (id, run_id, fund_id, record_kind, record_key, field, administrator_value, internal_value, difference, exception_kind, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
      .bind(id, runId, fund.id, exception.record_kind, exception.record_key, exception.field, exception.administrator_value, exception.internal_value, exception.difference, exception.exception_kind, fund.firm_scope)
      .run();
    stored.push(await env.WP_OS_DB.prepare("SELECT * FROM fund_reconciliation_exception WHERE id = ?1").bind(id).first());
  }

  await appendEvent(env, {
    eventType: "reconciliation.run_completed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "fund_reconciliation_run",
    objectId: runId,
    firmScope: fund.firm_scope,
    payload: {
      fund_id: fund.id,
      source_system: input.source_system,
      source_mode: "LOCAL_FIXTURE",
      record_count: input.administrator_records.length,
      exception_count: exceptions.length,
      // Explicit: importing the administrator's figures never writes back to them.
      administrator_records_written: 0,
    },
  });

  const run = await env.WP_OS_DB.prepare("SELECT * FROM fund_reconciliation_run WHERE id = ?1").bind(runId).first();
  return {
    run,
    exceptions: stored,
    source_state: "UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE (fixture import; no live administrator system has been read or written)",
  };
}

/**
 * Record a human disposition of a discrepancy. This changes `status` and nothing
 * else — the trigger on the table refuses any edit to the recorded values. Changing
 * an OFFICIAL figure (accepting the administrator's number into our books, or
 * correcting our own) is separately reserved and needs a receipt.
 */
export async function resolveException(
  env: Env,
  actor: Actor,
  exceptionId: string,
  input: { resolution: (typeof RESOLUTIONS)[number]; note: string; approval_receipt_id?: string },
) {
  const exception = await env.WP_OS_DB.prepare("SELECT * FROM fund_reconciliation_exception WHERE id = ?1").bind(exceptionId).first<{
    id: string;
    status: string;
    firm_scope: string;
  }>();
  if (!exception) throw new ReportingError(404, "not_found");
  if (actor.type !== "HUMAN") throw new ReportingError(403, "forbidden", "resolving a fund-admin discrepancy is human-reserved");
  if (exception.status !== "OPEN") throw new ReportingError(409, "already_resolved", `exception is ${exception.status}`);

  // Dispositions that restate an official figure are reserved; escalating or taking
  // no action is not, because neither changes a number.
  const changesOfficialFigure = input.resolution === "ACCEPT_ADMINISTRATOR" || input.resolution === "CORRECT_INTERNAL";
  let receiptId: string | null = null;
  if (changesOfficialFigure) {
    const authz = await authorize(
      env,
      actor,
      "official_valuation_or_capital_account.change",
      { objectType: "fund_reconciliation_exception", objectId: exceptionId, firmScope: exception.firm_scope },
      { receiptId: input.approval_receipt_id },
    );
    if (authz.decision === "DENY") throw new ReportingError(403, "forbidden", authz.reason);
    if (authz.decision !== "ALLOW") throw new ReportingError(409, "approval_required", authz.reason);
    receiptId = authz.receiptId!;
  }

  const id = `rre_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO reconciliation_resolution (id, exception_id, resolution, note, resolved_by, approval_card_id, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, exceptionId, input.resolution, input.note, actor.firmUserId!, receiptId, exception.firm_scope)
    .run();
  await env.WP_OS_DB.prepare("UPDATE fund_reconciliation_exception SET status = ?2 WHERE id = ?1")
    .bind(exceptionId, input.resolution === "ESCALATE_TO_ADMINISTRATOR" ? "ESCALATED" : "RESOLVED")
    .run();
  if (receiptId) await consumeApprovalCard(env, receiptId, { actorId: actor.firmUserId! });

  await appendEvent(env, {
    eventType: "reconciliation.exception_resolved",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "fund_reconciliation_exception",
    objectId: exceptionId,
    firmScope: exception.firm_scope,
    payload: {
      resolution: input.resolution,
      receipt_id: receiptId,
      // The administrator's record was read, compared, and left exactly as reported.
      administrator_record_overwritten: false,
    },
  });
  return {
    exception: await env.WP_OS_DB.prepare("SELECT * FROM fund_reconciliation_exception WHERE id = ?1").bind(exceptionId).first(),
    resolution: await env.WP_OS_DB.prepare("SELECT * FROM reconciliation_resolution WHERE id = ?1").bind(id).first(),
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
  if (err instanceof ReportingError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const periodSchema = z.object({
  fund_id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  period_start: z.string().trim().min(1),
  period_end: z.string().trim().min(1),
});

export async function handleCreatePeriod(ctx: RouteContext): Promise<Response> {
  const parsed = periodSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createPeriod(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListPeriods(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM lp_reporting_period WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all();
  return json({ periods: rows.results ?? [] });
}

const packetSchema = z.object({
  title: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  document_id: z.string().optional(),
  summary: z.string().optional(),
  ai_run_id: z.string().optional(),
});

export async function handleCreatePacket(ctx: RouteContext): Promise<Response> {
  const parsed = packetSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListPackets(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM lp_reporting_packet WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all();
  return json({
    packets: rows.results ?? [],
    certification_state: "NO FINANCIAL, ACCOUNTING, OR VALUATION CORRECTNESS IS CERTIFIED — this surface records process, review, and discrepancy only",
  });
}

export async function handleGetPacket(ctx: RouteContext): Promise<Response> {
  const packet = await getPacket(ctx.env, ctx.params.id!);
  if (!packet || !canAccessPrivacyLabel(ctx.identity!, packet.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  const receipts = await ctx.env.WP_OS_DB.prepare("SELECT * FROM distribution_receipt WHERE packet_id = ?1 ORDER BY created_at, id").bind(packet.id).all();
  return json({ ...packet, ...(await reviewState(ctx.env, packet.id)), distribution_receipts: receipts.results ?? [] });
}

export async function handleSubmitPacket(ctx: RouteContext): Promise<Response> {
  try {
    return json(await submitPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

const reviewSchema = z.object({
  review_type: z.enum(REQUIRED_REVIEWS),
  status: z.enum(["COMPLETED", "REJECTED"]),
  note: z.string().optional(),
});

export async function handleRecordReview(ctx: RouteContext): Promise<Response> {
  const parsed = reviewSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordReview(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

const distributeSchema = z.object({
  recipients: z.array(z.object({ recipient_label: z.string().trim().min(1), lp_record_id: z.string().optional() })).min(1),
  approval_receipt_id: z.string().optional(),
  delivery_note: z.string().optional(),
});

export async function handleDistributePacket(ctx: RouteContext): Promise<Response> {
  const parsed = distributeSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await distributePacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

const reconciliationSchema = z.object({
  fund_id: z.string().trim().min(1),
  period_id: z.string().optional(),
  source_system: z.string().trim().min(1),
  source_reference: z.string().optional(),
  administrator_records: z.array(administratorRecordSchema).min(1),
  internal_records: z
    .array(z.object({ record_kind: z.string().trim().min(1), record_key: z.string().trim().min(1), field: z.string().trim().min(1), value: z.string().nullable() }))
    .default([]),
});

export async function handleRunReconciliation(ctx: RouteContext): Promise<Response> {
  const parsed = reconciliationSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await runReconciliation(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListReconciliationRuns(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM fund_reconciliation_run ORDER BY created_at DESC, id LIMIT 100").all();
  return json({
    runs: rows.results ?? [],
    source_state: "UNPROVEN — FUND-ADMIN SOURCE CONTRACT GATE (no live administrator system is configured; West Peek OS never writes to one)",
    contract_version: ADMINISTRATOR_EXPORT_CONTRACT_VERSION,
  });
}

export async function handleListExceptions(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const runId = url.searchParams.get("run_id");
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = runId
    ? await ctx.env.WP_OS_DB.prepare(`SELECT * FROM fund_reconciliation_exception WHERE ${visibility} AND run_id = ?1 ORDER BY created_at, id`).bind(runId).all()
    : await ctx.env.WP_OS_DB.prepare(`SELECT * FROM fund_reconciliation_exception WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all();
  return json({ exceptions: rows.results ?? [] });
}

const resolveSchema = z.object({
  resolution: z.enum(RESOLUTIONS),
  note: z.string().trim().min(1),
  approval_receipt_id: z.string().optional(),
});

export async function handleResolveException(ctx: RouteContext): Promise<Response> {
  const parsed = resolveSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await resolveException(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
