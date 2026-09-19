import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, requestApproval } from "./approvals";
import { computePrimaryDeal, computeSecondaryStructure, premiumDiscount, safeDiv, xirr, type CarryBasis } from "../../shared/dealmath";
import { privacyLabelSchema } from "../../shared/privacy";
// Item 7: the manual route is one of four, and they all converge on `openIntoFunnel`.
import { manualArrival, openIntoFunnel } from "./dealIntake";

/**
 * Investment workflow (P6): opportunities, security classes, block links,
 * transactions, positions, ownership snapshots, pricing observations, deal math
 * packets, and the company 360 surface. IC packets/decisions live in ic.ts.
 *
 * Governing law: AI prepares; humans decide. Concretely here:
 * - Transactions execute ONLY behind an approved approval card for the
 *   type-specific reserved action (secondary_purchase.approve, secondary_sale.approve,
 *   follow_on.approve, exit.approve, investment.approve), verified through
 *   authorize() and consumed on execution. VOID routes through the MP-reserved
 *   transaction.void the same way.
 * - Duplicate/related blocks are LINKED (opportunity_block_link), never merged —
 *   there is no merge code path for opportunities at all.
 * - Deal math: manual entry always works (D6); the CALCULATED path fills derived
 *   metrics ONLY from the independently verified functions in src/shared/dealmath
 *   (docs/DEAL_MATH_VERIFICATION.md). tvpi/dpi stay manual (no verified formula).
 * - No endpoint stores or asserts a compliance status; brokerage/fund separation
 *   exists as data + controls (seller/broker/party fields, reserved approvals),
 *   never as a legal conclusion (D12).
 */

export class InvestmentError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const OPPORTUNITY_TYPES = ["EARLY_STAGE_PRIMARY", "FOLLOW_ON", "SECONDARY_PURCHASE", "SECONDARY_SALE", "OTHER"] as const;
export const OPPORTUNITY_STATUSES = ["NEW", "SCREENING", "DILIGENCE", "IC_READY", "IC_DECIDED", "CLOSED", "PASS", "WITHDRAWN"] as const;
export const TRANSACTION_TYPES = ["PURCHASE", "SALE", "PRIMARY_INVESTMENT", "FOLLOW_ON", "EXIT_PARTIAL", "EXIT_FULL"] as const;
export const TRANSACTION_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "EXECUTED", "VOID"] as const;
export const TRANSACTION_PARTY_TYPES = ["SELLER", "BUYER", "BROKER", "FUND_ENTITY", "OTHER"] as const;
export const PRICING_OBSERVATION_TYPES = ["BID", "ASK", "INDICATION", "EXECUTED_TRANSACTION", "PRIMARY_ROUND", "INTERNAL_ESTIMATE"] as const;
export const BLOCK_LINK_TYPES = ["DUPLICATE_CANDIDATE", "RELATED_BLOCK"] as const;
export const MATH_QUALITY_STATUSES = [
  "NOT_STARTED",
  "INPUTS_MISSING",
  "DRAFT_MATH_COMPLETE",
  "NEEDS_REVIEW",
  "IC_READY",
  "EXCEPTION_MEMO_REQUIRED",
  "REJECTED",
  "MATH_DOES_NOT_WORK",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type MathQualityStatus = (typeof MATH_QUALITY_STATUSES)[number];

/** Opportunity lifecycle. CLOSED/PASS/WITHDRAWN are terminal. */
const OPPORTUNITY_TRANSITIONS: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  NEW: ["SCREENING", "PASS", "WITHDRAWN"],
  SCREENING: ["DILIGENCE", "PASS", "WITHDRAWN"],
  DILIGENCE: ["IC_READY", "PASS", "WITHDRAWN"],
  IC_READY: ["IC_DECIDED", "PASS", "WITHDRAWN"],
  IC_DECIDED: ["CLOSED", "WITHDRAWN"],
  CLOSED: [],
  /*
   * A PASS IS A DECISION, NOT A GRAVE. The operator asked how to bring Synthient.ai back after the
   * firm passed on it, and the honest answer was that the table made it impossible — the same
   * dead-end shape that made "put it back" fail on a cancelled work card. Companies raise again,
   * change their team, ship the thing that was missing; a fund that cannot reconsider one has
   * confused a judgement with a filing.
   *
   * It reopens at SCREENING and never at the stage it left. The pass happened for a reason, and
   * dropping a reopened company straight back into diligence would carry forward work that was
   * done against a company that no longer exists in that form. The event ledger keeps the whole
   * walk — passed on this date by this person, reopened on that date by that one — so the history
   * of the reversal survives even though the status does not show it.
   */
  PASS: ["SCREENING"],
  WITHDRAWN: ["SCREENING"],
};

/** Human review transitions for math quality. INPUTS_MISSING resolves via update/calculate. */
const MATH_STATUS_TRANSITIONS: Readonly<Record<MathQualityStatus, readonly MathQualityStatus[]>> = {
  NOT_STARTED: ["INPUTS_MISSING", "DRAFT_MATH_COMPLETE", "NEEDS_REVIEW"],
  INPUTS_MISSING: ["DRAFT_MATH_COMPLETE", "NEEDS_REVIEW"],
  DRAFT_MATH_COMPLETE: ["NEEDS_REVIEW", "IC_READY", "EXCEPTION_MEMO_REQUIRED", "MATH_DOES_NOT_WORK", "REJECTED"],
  NEEDS_REVIEW: ["DRAFT_MATH_COMPLETE", "IC_READY", "EXCEPTION_MEMO_REQUIRED", "REJECTED", "MATH_DOES_NOT_WORK"],
  IC_READY: ["NEEDS_REVIEW", "EXCEPTION_MEMO_REQUIRED"],
  EXCEPTION_MEMO_REQUIRED: ["NEEDS_REVIEW", "REJECTED"],
  REJECTED: [],
  MATH_DOES_NOT_WORK: [],
};

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new InvestmentError(409, "approval_required", authz.reason);
}

async function requireCompany(env: Env, companyId: string): Promise<void> {
  const company = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(companyId).first();
  if (!company) throw new InvestmentError(400, "unknown_company", `canonical_company '${companyId}' does not exist`);
}

async function requireFund(env: Env, fundId: string): Promise<void> {
  const fund = await env.WP_OS_DB.prepare("SELECT id FROM fund WHERE id = ?1").bind(fundId).first();
  if (!fund) throw new InvestmentError(400, "unknown_fund", `fund '${fundId}' does not exist`);
}

// ── Security classes ──

export interface SecurityClassRow {
  id: string;
  company_id: string;
  class_name: string;
  seniority: string | null;
  notes: string | null;
  firm_scope: string;
  created_at: string;
}

export async function createSecurityClass(
  env: Env,
  actor: Actor,
  input: { company_id: string; class_name: string; seniority?: string; notes?: string },
): Promise<SecurityClassRow> {
  await mustAuthorize(env, actor, "security_class.create", "security_class");
  await requireCompany(env, input.company_id);
  const id = `scl_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO security_class (id, company_id, class_name, seniority, notes, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, input.company_id, input.class_name, input.seniority ?? null, input.notes ?? null, actor.firmScopes[0] ?? "west-peek")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.security_class_created",
    actorType,
    actorId,
    objectType: "security_class",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { company_id: input.company_id, class_name: input.class_name },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM security_class WHERE id = ?1").bind(id).first<SecurityClassRow>())!;
}

// ── Opportunities ──

export interface OpportunityRow {
  id: string;
  /** Why the firm passed or withdrew. Null while the deal is live. */
  exit_reason?: string | null;
  company_id: string;
  opportunity_type: string;
  title: string;
  status: OpportunityStatus;
  source_channel: string | null;
  security_class_id: string | null;
  price_per_share: number | null;
  discount_premium: number | null;
  quantity: number | null;
  seller_name: string | null;
  broker_name: string | null;
  fees: number | null;
  carry: number | null;
  terms_json: string;
  privacy_label: string;
  /** Where the relationship that produced this deal started (P51). */
  relationship_origin: string;
  origin_event_id: string | null;
  relationship_started_at: string | null;
  /**
   * Set only on a holding entered as history rather than decided here (migration 0050). Non-null
   * means the status was placed, not walked — read it before treating the stage as a decision the
   * firm made. `as_of_date` is when the thing actually happened; `backfilled_at` is when it was typed in.
   */
  backfilled_at: string | null;
  backfill_reason: string | null;
  as_of_date: string | null;
  /**
   * JSON array of field names whose current value is a stand-in, not a fact (migration 0052).
   * Non-empty means any arithmetic resting on those fields is provisional and must be shown as such.
   */
  placeholder_fields: string;
  placeholder_note: string | null;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export interface CreateOpportunityInput {
  company_id: string;
  opportunity_type: (typeof OPPORTUNITY_TYPES)[number];
  title: string;
  source_channel?: string;
  security_class_id?: string;
  price_per_share?: number;
  discount_premium?: number;
  quantity?: number;
  seller_name?: string;
  broker_name?: string;
  fees?: number;
  carry?: number;
  terms?: Record<string, unknown>;
  privacy_label?: string;
  relationship_origin?: string;
  origin_event_id?: string;
  relationship_started_at?: string;
  /** Fields whose supplied value is a stand-in rather than a fact (migration 0052). */
  placeholder_fields?: string[];
  placeholder_note?: string;
}

export async function getOpportunity(env: Env, id: string): Promise<OpportunityRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM investment_opportunity WHERE id = ?1").bind(id).first<OpportunityRow>();
}

export async function createOpportunity(env: Env, actor: Actor, input: CreateOpportunityInput): Promise<OpportunityRow> {
  await mustAuthorize(env, actor, "opportunity.create", "investment_opportunity");
  await requireCompany(env, input.company_id);
  if (input.security_class_id) {
    const cls = await env.WP_OS_DB.prepare("SELECT id, company_id FROM security_class WHERE id = ?1").bind(input.security_class_id).first<{ id: string; company_id: string }>();
    if (!cls || cls.company_id !== input.company_id) {
      throw new InvestmentError(400, "unknown_security_class", "security_class does not exist or belongs to another company");
    }
  }
  const id = `opp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO investment_opportunity
       (id, company_id, opportunity_type, title, status, source_channel, security_class_id, price_per_share,
        discount_premium, quantity, seller_name, broker_name, fees, carry, terms_json, privacy_label,
        relationship_origin, origin_event_id, relationship_started_at, firm_scope, created_by,
        placeholder_fields, placeholder_note)
     VALUES (?1, ?2, ?3, ?4, 'NEW', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`,
  )
    .bind(
      id,
      input.company_id,
      input.opportunity_type,
      input.title,
      input.source_channel ?? null,
      input.security_class_id ?? null,
      input.price_per_share ?? null,
      input.discount_premium ?? null,
      input.quantity ?? null,
      input.seller_name ?? null,
      input.broker_name ?? null,
      input.fees ?? null,
      input.carry ?? null,
      JSON.stringify(input.terms ?? {}),
      input.privacy_label ?? "INTERNAL",
      // UNRECORDED rather than OTHER or INBOUND: a default that asserts something nobody checked
      // is worse than an honest gap, and it makes "we never captured this" countable.
      input.relationship_origin ?? "UNRECORDED",
      input.origin_event_id ?? null,
      input.relationship_started_at ?? null,
      actor.firmScopes[0] ?? "west-peek",
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      JSON.stringify(input.placeholder_fields ?? []),
      input.placeholder_note ?? null,
    )
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.opportunity_created",
    actorType,
    actorId,
    objectType: "investment_opportunity",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { company_id: input.company_id, opportunity_type: input.opportunity_type, title: input.title },
  });
  return (await getOpportunity(env, id))!;
}

const OPPORTUNITY_UPDATABLE_FIELDS = [
  // Provenance is updatable because it is almost always recorded shortly AFTER creation — a deal
  // is entered in a hurry and the "where did we meet them" answer arrives a day later. Making it
  // create-only would guarantee it stayed UNRECORDED.
  "relationship_origin",
  "origin_event_id",
  "relationship_started_at",
  "title",
  "source_channel",
  "security_class_id",
  "price_per_share",
  "discount_premium",
  "quantity",
  "seller_name",
  "broker_name",
  "fees",
  "carry",
  "privacy_label",
] as const;

/** Field updates only — lifecycle moves go through transitionOpportunity. */
export async function updateOpportunity(
  env: Env,
  actor: Actor,
  id: string,
  input: Partial<CreateOpportunityInput> & { terms?: Record<string, unknown> },
): Promise<OpportunityRow> {
  const row = await getOpportunity(env, id);
  if (!row) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity.update", "investment_opportunity", id, row.firm_scope);
  if (row.status === "CLOSED" || row.status === "PASS" || row.status === "WITHDRAWN") {
    throw new InvestmentError(409, "opportunity_terminal", `opportunity in terminal status ${row.status} cannot be edited`);
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of OPPORTUNITY_UPDATABLE_FIELDS) {
    if (field in input) {
      sets.push(`${field} = ?${binds.length + 2}`);
      binds.push((input as Record<string, unknown>)[field] ?? null);
      changed[field] = { from: row[field as keyof OpportunityRow], to: (input as Record<string, unknown>)[field] ?? null };
    }
  }
  if (input.terms !== undefined) {
    sets.push(`terms_json = ?${binds.length + 2}`);
    binds.push(JSON.stringify(input.terms));
    changed.terms = { from: JSON.parse(row.terms_json), to: input.terms };
  }
  if (sets.length > 0) {
    await env.WP_OS_DB.prepare(`UPDATE investment_opportunity SET ${sets.join(", ")} WHERE id = ?1`).bind(id, ...binds).run();
    const { actorType, actorId } = eventActor(actor);
    await appendEvent(env, {
      eventType: "investment.opportunity_updated",
      actorType,
      actorId,
      objectType: "investment_opportunity",
      objectId: id,
      firmScope: row.firm_scope,
      payload: { changed },
    });
  }
  return (await getOpportunity(env, id))!;
}

/**
 * Take a deal record off the board.
 *
 * NOT A PASS AND NOT A WITHDRAWAL. Those are decisions about a real company and the firm keeps them
 * for ever — what it declined is half the value of a pipeline. This says the ROW was wrong: a
 * duplicate, a typo, the same company entered twice under two spellings.
 *
 * Archive rather than delete, for the same reason documents are: transactions, deal math packets,
 * IC packets and the event spine all reference an opportunity by id. Destroying it would break
 * those references and erase the history the archive exists to preserve.
 */
export async function archiveOpportunity(
  env: Env,
  actor: Actor,
  id: string,
  reason: string,
): Promise<OpportunityRow> {
  const row = await getOpportunity(env, id);
  if (!row) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity.archive", "investment_opportunity", id, row.firm_scope);

  const trimmed = reason.trim();
  if (trimmed.length < 8) {
    throw new InvestmentError(
      400,
      "reason_required",
      "Say why this record should not exist — a duplicate, a typo, entered twice. Six months from now the reason is the only part that still helps.",
    );
  }

  /*
   * A BOOKED HOLDING IS NOT A MISTAKEN ROW. If the fund has executed a transaction against this
   * deal it owns something, and taking the record off the board would hide a real position. That
   * is a reversal, which is what `void` on the transaction is for, and it is MP-reserved.
   */
  const booked = await env.WP_OS_DB.prepare(
    'SELECT COUNT(*) AS n FROM "transaction" WHERE opportunity_id = ?1 AND status = \'EXECUTED\'',
  )
    .bind(id)
    .first<{ n: number }>();
  if ((booked?.n ?? 0) > 0) {
    throw new InvestmentError(
      409,
      "has_booked_transactions",
      "The fund has executed a transaction against this deal, so the record is not a mistake. Void the transaction first if it was booked in error.",
    );
  }

  await env.WP_OS_DB.prepare(
    `UPDATE investment_opportunity
        SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?2, archive_reason = ?3
      WHERE id = ?1`,
  )
    .bind(id, actor.firmUserId ?? actor.aiEmployeeId ?? "system", trimmed.slice(0, 600))
    .run();

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.opportunity_archived",
    actorType,
    actorId,
    objectType: "investment_opportunity",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { reason: trimmed.slice(0, 600), status_when_archived: row.status },
  });
  return (await getOpportunity(env, id))!;
}

/** Leaving the pipeline without investing. Both are decisions and both want a reason. */
const EXIT_STATUSES: readonly OpportunityStatus[] = ["PASS", "WITHDRAWN"];

export async function transitionOpportunity(
  env: Env,
  actor: Actor,
  id: string,
  to: OpportunityStatus,
  reason?: string,
): Promise<OpportunityRow> {
  const row = await getOpportunity(env, id);
  if (!row) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity.transition", "investment_opportunity", id, row.firm_scope);
  const allowed = OPPORTUNITY_TRANSITIONS[row.status];
  if (!allowed.includes(to)) {
    throw new InvestmentError(409, "illegal_transition", `opportunity cannot transition ${row.status} → ${to}`);
  }

  /*
   * A PASS CARRIES ITS REASON, and the minimum length is deliberate. "no" or "pass" satisfies a
   * non-empty check and tells a future reader nothing — the same reasoning the backfill lane
   * already applies. For a fund the record of what it declined is half the value of the pipeline,
   * and the reason is the whole of that half: "we passed in August" is a fact, "we passed because
   * the second founder had already left and nobody would say why" is what you want in front of you
   * when they come back raising.
   */
  const trimmed = (reason ?? "").trim();
  if (EXIT_STATUSES.includes(to) && trimmed.length < 12) {
    throw new InvestmentError(
      400,
      "reason_required",
      "Say why the firm is passing, in a sentence. A pass with no reason is worth nothing when they come back.",
    );
  }

  /*
   * CLOSED MEANS MONEY IS IN, and that is a partner's call.
   *
   * `opportunity.transition` is not a reserved action, so every stage move is ungated — right for
   * screening to diligence, wrong for the one that says the fund invested. The governance was
   * inverted: the decision that spends capital was a single unconfirmed click while the decision
   * that spends nothing was impossible.
   */
  if (to === "CLOSED" && !actor.roles.includes("MANAGING_PARTNER")) {
    throw new InvestmentError(
      403,
      "partner_decision",
      "Recording the fund as invested is a Managing Partner's decision.",
    );
  }

  await env.WP_OS_DB.prepare("UPDATE investment_opportunity SET status = ?2, exit_reason = ?3 WHERE id = ?1")
    .bind(id, to, EXIT_STATUSES.includes(to) ? trimmed.slice(0, 600) : row.exit_reason ?? null)
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.opportunity_transitioned",
    actorType,
    actorId,
    objectType: "investment_opportunity",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { from: row.status, to, ...(trimmed ? { reason: trimmed.slice(0, 600) } : {}) },
  });

  /*
   * REACHING THE COMMITTEE IS A STAGE MOVE AND NOTHING ELSE (ADR-019).
   *
   * The operator asked how a deal gets through the pipeline to IC and what happens to it when it
   * arrives. The answer is this line: entering IC_READY opens an ic_packet in DRAFT and a work card
   * for Poppy to assemble it. Nothing auto-decides, nothing auto-answers, and re-entering the stage
   * finds the open packet rather than minting a second one.
   *
   * Imported lazily because ic.ts imports this module — a static import both ways is a cycle.
   */
  if (to === "IC_READY") {
    const { openIcStage } = await import("./ic");
    await openIcStage(env, actor, id);
  }

  return (await getOpportunity(env, id))!;
}

/**
 * Record a holding that predates the system — the backfill lane (migration 0050).
 *
 * The lifecycle machine above is correct for every deal the firm decides from here on, and
 * deliberately offers no shortcut to CLOSED. History does not fit it. Sensori closed as a $10K SPV
 * before Fund I existed and never went to IC; the only options were to walk it up the ladder,
 * minting an ic_decision that never happened, or to leave a closed holding parked at NEW. Both put
 * something false on the board.
 *
 * This sets the status directly AND MARKS THE ROW AS BACKFILLED, permanently, with a reason and
 * the date the thing actually happened. The distinction the product must never lose is between
 * *a decision this firm made* and *a fact somebody typed in later*; a status alone cannot carry it,
 * so the flag carries it instead.
 *
 * Constraints that make this a lane rather than a hole in the machine:
 *   · a reason is required, and an empty one is refused — an unexplained backfill is the thing
 *     this is meant to prevent;
 *   · only a row still at NEW may be backfilled, so it can never overwrite a real lifecycle;
 *   · it is a distinct action key, so authority to backfill history is grantable separately from
 *     authority to move a live deal;
 *   · the event carries `backfill: true`, so the trail shows how the status was reached.
 */
export async function backfillOpportunity(
  env: Env,
  actor: Actor,
  id: string,
  input: { to: OpportunityStatus; reason: string; as_of_date?: string },
): Promise<OpportunityRow> {
  const row = await getOpportunity(env, id);
  if (!row) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity.backfill", "investment_opportunity", id, row.firm_scope);

  // Order matters. A backfilled row is no longer NEW, so testing the status first would answer
  // every second attempt with "not_backfillable" — technically true, and misleading: it reads as
  // "this deal is in flight" when the real answer is "history was already entered here". The
  // specific check goes first so the caller is told which of the two it actually hit.
  if (row.backfilled_at) {
    throw new InvestmentError(
      409,
      "already_backfilled",
      `this opportunity was backfilled on ${row.backfilled_at}; correct it with a compensating record, not a second backfill`,
    );
  }
  if (row.status !== "NEW") {
    throw new InvestmentError(
      409,
      "not_backfillable",
      `only an opportunity still at NEW may be backfilled; this one is ${row.status}`,
    );
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new InvestmentError(400, "reason_required", "a backfill must say why it is being entered as history");
  }

  const backfilledAt = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    `UPDATE investment_opportunity
        SET status = ?2, backfilled_at = ?3, backfill_reason = ?4, as_of_date = ?5
      WHERE id = ?1`,
  )
    .bind(id, input.to, backfilledAt, reason, input.as_of_date ?? null)
    .run();

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.opportunity_backfilled",
    actorType,
    actorId,
    objectType: "investment_opportunity",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { from: row.status, to: input.to, backfill: true, reason, as_of_date: input.as_of_date ?? null },
  });
  return (await getOpportunity(env, id))!;
}

/**
 * Fill in a value that was recorded as a placeholder.
 *
 * WHY THIS IS NOT updateOpportunity. That refuses to touch a CLOSED, PASS or WITHDRAWN record, and
 * rightly — a terminal opportunity is a decision, and decisions are not edited. But Sensori is
 * CLOSED and carries placeholder economics, so the ordinary door is shut on exactly the record
 * that most needs correcting. A placeholder was never a decision; it was a gap wearing a number's
 * clothes, and admitted as one at the moment it was written.
 *
 * So this door opens on terminal records, and is narrow in the way that makes that safe:
 *
 *   · it will only set a field that is CURRENTLY LISTED as a placeholder. Anything else is refused,
 *     so this cannot become a general edit path for closed deals by accident;
 *   · each field it sets is removed from the list, so the record heals as it is corrected and
 *     nobody has to remember to clear a flag;
 *   · it is its own action key, so the authority to correct provisional data is grantable apart
 *     from the authority to change a live deal.
 *
 * The result is that a placeholder is loud until it is true, and then it stops being anything at
 * all — which is the only honest lifecycle for a number that was invented to be replaced.
 */
export async function confirmPlaceholders(
  env: Env,
  actor: Actor,
  id: string,
  values: Record<string, number | string | null>,
): Promise<OpportunityRow> {
  const row = await getOpportunity(env, id);
  if (!row) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity.confirm_placeholder", "investment_opportunity", id, row.firm_scope);

  let outstanding: string[] = [];
  try {
    outstanding = JSON.parse(row.placeholder_fields || "[]") as string[];
  } catch {
    outstanding = [];
  }
  if (outstanding.length === 0) {
    throw new InvestmentError(409, "nothing_provisional", "this record has no placeholder values to confirm");
  }

  const fields = Object.keys(values);
  if (fields.length === 0) {
    throw new InvestmentError(400, "no_values", "supply at least one value to confirm");
  }
  const notProvisional = fields.filter((f) => !outstanding.includes(f));
  if (notProvisional.length > 0) {
    throw new InvestmentError(
      409,
      "not_a_placeholder",
      `${notProvisional.join(", ")} ${notProvisional.length === 1 ? "is" : "are"} not marked as provisional here; this door only corrects placeholders`,
    );
  }
  // Only ever the economics. A placeholder list is data, and data must not be able to name a
  // column and have it written — that would turn this into arbitrary SQL with extra steps.
  const settable = new Set(["price_per_share", "quantity", "fees", "carry", "discount_premium", "seller_name", "broker_name"]);
  const illegal = fields.filter((f) => !settable.has(f));
  if (illegal.length > 0) {
    throw new InvestmentError(400, "not_settable", `${illegal.join(", ")} cannot be set through this route`);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const f of fields) {
    sets.push(`${f} = ?${binds.length + 2}`);
    binds.push(values[f] ?? null);
  }
  const remaining = outstanding.filter((f) => !fields.includes(f));
  sets.push(`placeholder_fields = ?${binds.length + 2}`);
  binds.push(JSON.stringify(remaining));
  if (remaining.length === 0) {
    sets.push(`placeholder_note = NULL`);
  }

  await env.WP_OS_DB.prepare(`UPDATE investment_opportunity SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
    .run();

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.placeholders_confirmed",
    actorType,
    actorId,
    objectType: "investment_opportunity",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { confirmed: fields, values, still_provisional: remaining },
  });
  return (await getOpportunity(env, id))!;
}

const confirmPlaceholderSchema = z.object({
  values: z.record(z.union([z.number(), z.string(), z.null()])),
});

export async function handleConfirmPlaceholders(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = confirmPlaceholderSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await confirmPlaceholders(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.values));
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Block links (dedup by LINK, never merge) ──

export interface BlockLinkRow {
  id: string;
  opportunity_id_a: string;
  opportunity_id_b: string;
  link_type: string;
  basis_json: string;
  status: string;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export interface BlockLinkCandidate {
  opportunity_id: string;
  matched_dimensions: string[];
  link_type: "DUPLICATE_CANDIDATE" | "RELATED_BLOCK";
}

function normText(value: string | null): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

function withinPct(a: number | null, b: number | null, pct: number): boolean {
  if (a === null || b === null || a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= pct;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Deterministic duplicate/related-block detection across issuer, seller, block size,
 * share class, price, fees, broker, and timing. Pure comparison — it creates
 * PROPOSED links; only a human confirms or rejects. There is NO merge path.
 *
 * Rule: same canonical company (issuer) required; then
 * - DUPLICATE_CANDIDATE when seller AND block size (±10%) AND price (±5%) all match, or
 *   when ≥4 of the 7 non-issuer dimensions match;
 * - RELATED_BLOCK when ≥2 non-issuer dimensions match;
 * - otherwise no candidate.
 */
export function detectBlockLinkCandidates(target: OpportunityRow, others: OpportunityRow[]): BlockLinkCandidate[] {
  const candidates: BlockLinkCandidate[] = [];
  for (const other of others) {
    if (other.id === target.id || other.company_id !== target.company_id) continue;
    const matched: string[] = [];
    if (normText(target.seller_name) && normText(target.seller_name) === normText(other.seller_name)) matched.push("seller");
    if (normText(target.broker_name) && normText(target.broker_name) === normText(other.broker_name)) matched.push("broker");
    if (target.security_class_id && target.security_class_id === other.security_class_id) matched.push("share_class");
    if (withinPct(target.quantity, other.quantity, 0.1)) matched.push("block_size");
    if (withinPct(target.price_per_share, other.price_per_share, 0.05)) matched.push("price");
    if (withinPct(target.fees, other.fees, 0.05)) matched.push("fees");
    if (Math.abs(new Date(target.created_at).getTime() - new Date(other.created_at).getTime()) <= 30 * DAY_MS) matched.push("timing");
    const sellerBlockPrice = matched.includes("seller") && matched.includes("block_size") && matched.includes("price");
    if (sellerBlockPrice || matched.length >= 4) {
      candidates.push({ opportunity_id: other.id, matched_dimensions: matched, link_type: "DUPLICATE_CANDIDATE" });
    } else if (matched.length >= 2) {
      candidates.push({ opportunity_id: other.id, matched_dimensions: matched, link_type: "RELATED_BLOCK" });
    }
  }
  return candidates;
}

export async function createBlockLink(
  env: Env,
  actor: Actor,
  input: { opportunity_id_a: string; opportunity_id_b: string; link_type: (typeof BLOCK_LINK_TYPES)[number]; basis?: Record<string, unknown> },
): Promise<BlockLinkRow> {
  if (input.opportunity_id_a === input.opportunity_id_b) throw new InvestmentError(400, "invalid_input", "cannot link an opportunity to itself");
  const a = await getOpportunity(env, input.opportunity_id_a);
  const b = await getOpportunity(env, input.opportunity_id_b);
  if (!a || !b) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity_block_link.propose", "opportunity_block_link", undefined, a.firm_scope);
  // Idempotent per unordered pair + type: a second scan does not duplicate links.
  const existing = await env.WP_OS_DB.prepare(
    `SELECT id FROM opportunity_block_link
      WHERE ((opportunity_id_a = ?1 AND opportunity_id_b = ?2) OR (opportunity_id_a = ?2 AND opportunity_id_b = ?1))
        AND link_type = ?3 AND status != 'REJECTED'`,
  )
    .bind(input.opportunity_id_a, input.opportunity_id_b, input.link_type)
    .first<{ id: string }>();
  if (existing) {
    return (await env.WP_OS_DB.prepare("SELECT * FROM opportunity_block_link WHERE id = ?1").bind(existing.id).first<BlockLinkRow>())!;
  }
  const id = `obl_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO opportunity_block_link (id, opportunity_id_a, opportunity_id_b, link_type, basis_json, status, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, 'PROPOSED', ?6, ?7)`,
  )
    .bind(id, input.opportunity_id_a, input.opportunity_id_b, input.link_type, JSON.stringify(input.basis ?? {}), a.firm_scope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.block_link_proposed",
    actorType,
    actorId,
    objectType: "opportunity_block_link",
    objectId: id,
    firmScope: a.firm_scope,
    payload: { opportunity_id_a: input.opportunity_id_a, opportunity_id_b: input.opportunity_id_b, link_type: input.link_type },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM opportunity_block_link WHERE id = ?1").bind(id).first<BlockLinkRow>())!;
}

/** Deterministic scan: detect candidates for an opportunity and create PROPOSED links. */
export async function scanBlockLinks(env: Env, actor: Actor, opportunityId: string): Promise<BlockLinkRow[]> {
  const target = await getOpportunity(env, opportunityId);
  if (!target) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity_block_link.propose", "opportunity_block_link", undefined, target.firm_scope);
  const others = await env.WP_OS_DB.prepare(
    "SELECT * FROM investment_opportunity WHERE company_id = ?1 AND id != ?2 AND status NOT IN ('CLOSED','PASS','WITHDRAWN')",
  )
    .bind(target.company_id, opportunityId)
    .all<OpportunityRow>();
  const links: BlockLinkRow[] = [];
  for (const candidate of detectBlockLinkCandidates(target, others.results ?? [])) {
    links.push(
      await createBlockLink(env, actor, {
        opportunity_id_a: opportunityId,
        opportunity_id_b: candidate.opportunity_id,
        link_type: candidate.link_type,
        basis: { matched_dimensions: candidate.matched_dimensions, detection: "deterministic_scan" },
      }),
    );
  }
  return links;
}

/** Human confirm/reject of a proposed link. AI can never decide (governing law). */
export async function decideBlockLink(env: Env, actor: Actor, linkId: string, decision: "CONFIRMED" | "REJECTED"): Promise<BlockLinkRow> {
  if (actor.type !== "HUMAN") throw new InvestmentError(403, "forbidden", "block-link decisions are human-reserved");
  const link = await env.WP_OS_DB.prepare("SELECT * FROM opportunity_block_link WHERE id = ?1").bind(linkId).first<BlockLinkRow>();
  if (!link) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "opportunity_block_link.decide", "opportunity_block_link", linkId, link.firm_scope);
  if (link.status !== "PROPOSED") throw new InvestmentError(409, "already_decided", `link is ${link.status}`);
  await env.WP_OS_DB.prepare("UPDATE opportunity_block_link SET status = ?2 WHERE id = ?1").bind(linkId, decision).run();
  await appendEvent(env, {
    eventType: decision === "CONFIRMED" ? "investment.block_link_confirmed" : "investment.block_link_rejected",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "opportunity_block_link",
    objectId: linkId,
    firmScope: link.firm_scope,
    payload: { opportunity_id_a: link.opportunity_id_a, opportunity_id_b: link.opportunity_id_b, link_type: link.link_type },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM opportunity_block_link WHERE id = ?1").bind(linkId).first<BlockLinkRow>())!;
}

// ── Transactions ──

export interface TransactionRow {
  id: string;
  company_id: string;
  opportunity_id: string | null;
  transaction_type: (typeof TRANSACTION_TYPES)[number];
  security_class_id: string;
  quantity: number;
  price_per_share: number;
  gross_amount: number;
  fees: number;
  carry: number;
  net_amount: number;
  transaction_date: string;
  status: (typeof TRANSACTION_STATUSES)[number];
  approval_card_id: string | null;
  /**
   * The fund the position is booked to when this executes (migration 0209). Named on the draft so
   * that a partner's approval can be the last human act. NULL on a draft written through the older
   * API without one — that draft executes only through the explicit route, with the fund named there.
   */
  fund_id: string | null;
  /** Which entity holds it — "SPV", "Fund I direct", "Warehouse" (migration 0209). */
  vehicle: string | null;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

export interface TransactionPartyInput {
  party_type: (typeof TRANSACTION_PARTY_TYPES)[number];
  party_name: string;
  party_ref_id?: string;
}

export interface CreateTransactionInput {
  company_id: string;
  opportunity_id?: string;
  transaction_type: (typeof TRANSACTION_TYPES)[number];
  security_class_id: string;
  quantity: number;
  price_per_share: number;
  fees?: number;
  carry?: number;
  transaction_date: string;
  parties?: TransactionPartyInput[];
  /** Phase D: the fund the position is booked to on execution, and the entity that holds it. */
  fund_id?: string;
  vehicle?: string;
}

const BUY_SIDE_TYPES: readonly string[] = ["PURCHASE", "PRIMARY_INVESTMENT", "FOLLOW_ON"];

export async function getTransaction(env: Env, id: string): Promise<TransactionRow | null> {
  return env.WP_OS_DB.prepare('SELECT * FROM "transaction" WHERE id = ?1').bind(id).first<TransactionRow>();
}

/** Buy side: net cash out = gross + fees. Sell side: net cash in = gross − fees − carry. */
export function computeNetAmount(type: string, gross: number, fees: number, carry: number): number {
  return BUY_SIDE_TYPES.includes(type) ? gross + fees : gross - fees - carry;
}

export async function createTransaction(env: Env, actor: Actor, input: CreateTransactionInput): Promise<TransactionRow> {
  await mustAuthorize(env, actor, "transaction.create", "transaction");
  await requireCompany(env, input.company_id);
  const cls = await env.WP_OS_DB.prepare("SELECT id, company_id FROM security_class WHERE id = ?1").bind(input.security_class_id).first<{ id: string; company_id: string }>();
  if (!cls || cls.company_id !== input.company_id) {
    throw new InvestmentError(400, "unknown_security_class", "security_class does not exist or belongs to another company");
  }
  if (input.opportunity_id) {
    const opp = await getOpportunity(env, input.opportunity_id);
    if (!opp || opp.company_id !== input.company_id) {
      throw new InvestmentError(400, "unknown_opportunity", "opportunity does not exist or belongs to another company");
    }
  }
  if (input.quantity <= 0 || input.price_per_share <= 0) {
    throw new InvestmentError(400, "invalid_input", "quantity and price_per_share must be positive");
  }
  // A fund named on the draft must exist now, not at execution: the approval that executes it is
  // a partner's click, and "unknown_fund" is not an answer to give a partner who has just said yes.
  if (input.fund_id) await requireFund(env, input.fund_id);
  const gross = input.quantity * input.price_per_share;
  const fees = input.fees ?? 0;
  const carry = input.carry ?? 0;
  const net = computeNetAmount(input.transaction_type, gross, fees, carry);
  const id = `txn_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO "transaction"
       (id, company_id, opportunity_id, transaction_type, security_class_id, quantity, price_per_share,
        gross_amount, fees, carry, net_amount, transaction_date, status, firm_scope, created_by, fund_id, vehicle)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'DRAFT', ?13, ?14, ?15, ?16)`,
  )
    .bind(
      id,
      input.company_id,
      input.opportunity_id ?? null,
      input.transaction_type,
      input.security_class_id,
      input.quantity,
      input.price_per_share,
      gross,
      fees,
      carry,
      net,
      input.transaction_date,
      actor.firmScopes[0] ?? "west-peek",
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      input.fund_id ?? null,
      input.vehicle ?? null,
    )
    .run();
  for (const party of input.parties ?? []) {
    await addTransactionParty(env, actor, id, party);
  }
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.transaction_created",
    actorType,
    actorId,
    objectType: "transaction",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { company_id: input.company_id, transaction_type: input.transaction_type, gross_amount: gross, net_amount: net },
  });
  return (await getTransaction(env, id))!;
}

export async function listTransactionParties(env: Env, transactionId: string) {
  const rows = await env.WP_OS_DB.prepare("SELECT * FROM transaction_party WHERE transaction_id = ?1 ORDER BY created_at, id")
    .bind(transactionId)
    .all();
  return rows.results ?? [];
}

export async function addTransactionParty(env: Env, actor: Actor, transactionId: string, party: TransactionPartyInput) {
  const txn = await getTransaction(env, transactionId);
  if (!txn) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "transaction.party.add", "transaction", transactionId, txn.firm_scope);
  if (txn.status !== "DRAFT") throw new InvestmentError(409, "illegal_state", "parties can be added only while the transaction is DRAFT");
  const id = `txp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO transaction_party (id, transaction_id, party_type, party_name, party_ref_id, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, transactionId, party.party_type, party.party_name, party.party_ref_id ?? null, txn.firm_scope)
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM transaction_party WHERE id = ?1").bind(id).first();
}

/**
 * The type-specific reserved action that gates a transaction's execution.
 * Secondary purchases/sales, follow-ons, and exits map to their dedicated register
 * keys; plain primary purchases map to investment.approve.
 */
export function reservedActionForTransaction(txn: TransactionRow, opportunity: OpportunityRow | null): string {
  switch (txn.transaction_type) {
    case "PURCHASE":
      return opportunity?.opportunity_type === "SECONDARY_PURCHASE" ? "secondary_purchase.approve" : "investment.approve";
    case "SALE":
      return opportunity?.opportunity_type === "SECONDARY_SALE" ? "secondary_sale.approve" : "exit.approve";
    case "PRIMARY_INVESTMENT":
      return "investment.approve";
    case "FOLLOW_ON":
      return "follow_on.approve";
    case "EXIT_PARTIAL":
    case "EXIT_FULL":
      return "exit.approve";
  }
}

/**
 * Submit a DRAFT transaction for approval: creates + submits the approval card for
 * the type-specific reserved action, and moves the transaction to PENDING_APPROVAL.
 */
export async function submitTransactionForApproval(env: Env, actor: Actor, transactionId: string): Promise<TransactionRow> {
  const txn = await getTransaction(env, transactionId);
  if (!txn) throw new InvestmentError(404, "not_found");
  if (txn.status !== "DRAFT") {
    // A reviewer refuses the card on the generic Approvals surface, which knows
    // nothing about `transaction`. Without this, the transaction keeps a stale
    // PENDING_APPROVAL status and no fresh card can ever be requested through this
    // surface. Treat the card's own disposition as the authority on whether review
    // is over (same rule as `submitLpClaim`, ADR-016). NOT auto-VOID: `VOID` means
    // "reverse a booked transaction" and is MP-reserved — a refused submission has
    // booked nothing.
    const card = txn.approval_card_id
      ? await env.WP_OS_DB.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(txn.approval_card_id).first<{ state: string }>()
      : null;
    const reviewIsOver = card?.state === "rejected" || card?.state === "revise_requested";
    if (txn.status !== "PENDING_APPROVAL" || !reviewIsOver) {
      throw new InvestmentError(409, "illegal_state", `transaction is ${txn.status}, not DRAFT${card ? ` (approval card ${card.state})` : ""}`);
    }
  }
  const opportunity = txn.opportunity_id ? await getOpportunity(env, txn.opportunity_id) : null;
  const actionKey = reservedActionForTransaction(txn, opportunity);
  // The card says what approving it DOES (Phase D, decision Q1): with a fund on the draft, approval
  // books the position; without one, approval is a decision and the booking still needs the fund
  // named on the explicit route. A partner should read that on the card, not discover it afterwards.
  const company = await env.WP_OS_DB.prepare("SELECT canonical_name FROM canonical_company WHERE id = ?1").bind(txn.company_id).first<{ canonical_name: string }>();
  const fund = txn.fund_id ? await env.WP_OS_DB.prepare("SELECT name FROM fund WHERE id = ?1").bind(txn.fund_id).first<{ name: string }>() : null;
  const card = await requestApproval(env, actor, {
    action_key: actionKey,
    object_type: "transaction",
    object_id: transactionId,
    title: `${actionKey}: ${txn.transaction_type} ${txn.quantity} @ ${txn.price_per_share} (${company?.canonical_name ?? `company ${txn.company_id}`})`,
    summary:
      `gross ${txn.gross_amount}, fees ${txn.fees}, carry ${txn.carry}, net ${txn.net_amount}, date ${txn.transaction_date}` +
      (txn.vehicle ? `, held via ${txn.vehicle}` : "") +
      (fund
        ? `. Approving books the position to ${fund.name} — no further step.`
        : ". No fund is named on this draft, so approving decides it and the booking is executed separately with the fund named."),
    payload: {
      transaction_id: transactionId,
      transaction_type: txn.transaction_type,
      company_id: txn.company_id,
      fund_id: txn.fund_id,
      vehicle: txn.vehicle,
      executes_on_approval: txn.fund_id !== null,
    },
    firm_scope: txn.firm_scope,
    submit: true,
  });
  await env.WP_OS_DB.prepare('UPDATE "transaction" SET status = \'PENDING_APPROVAL\', approval_card_id = ?2 WHERE id = ?1').bind(transactionId, card.id).run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.transaction_submitted",
    actorType,
    actorId,
    objectType: "transaction",
    objectId: transactionId,
    firmScope: txn.firm_scope,
    payload: { action_key: actionKey, approval_card_id: card.id },
  });
  // A standing authority may have approved the card at submission. That is a partner's decision
  // made in advance, and it books the same way a click does (`bookOnApproval`).
  if (card.state === "approved") await bookOnApproval(env, actor, card);
  return (await getTransaction(env, transactionId))!;
}

export interface PositionRow {
  id: string;
  company_id: string;
  fund_id: string;
  security_class_id: string;
  quantity: number;
  cost_basis: number;
  acquired_via_transaction_id: string | null;
  status: string;
  firm_scope: string;
  opened_at: string;
  closed_at: string | null;
}

async function findOpenPosition(env: Env, companyId: string, fundId: string, securityClassId: string): Promise<PositionRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM position WHERE company_id = ?1 AND fund_id = ?2 AND security_class_id = ?3 AND status = 'OPEN'",
  )
    .bind(companyId, fundId, securityClassId)
    .first<PositionRow>();
}

interface PositionEffect {
  position_id: string;
  quantity_delta: number;
  cost_basis_delta: number;
  resulting_quantity: number;
  resulting_cost_basis: number;
  closed: boolean;
}

/** Apply the position effect of an executed transaction; returns the effect detail (recorded on the spine). */
async function applyPositionEffect(env: Env, actor: Actor, txn: TransactionRow, fundId: string): Promise<PositionEffect> {
  await requireFund(env, fundId);
  const buySide = BUY_SIDE_TYPES.includes(txn.transaction_type);
  const existing = await findOpenPosition(env, txn.company_id, fundId, txn.security_class_id);

  if (buySide) {
    if (existing) {
      const quantity = existing.quantity + txn.quantity;
      const costBasis = existing.cost_basis + txn.net_amount;
      await env.WP_OS_DB.prepare("UPDATE position SET quantity = ?2, cost_basis = ?3 WHERE id = ?1").bind(existing.id, quantity, costBasis).run();
      return { position_id: existing.id, quantity_delta: txn.quantity, cost_basis_delta: txn.net_amount, resulting_quantity: quantity, resulting_cost_basis: costBasis, closed: false };
    }
    const id = `pos_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO position (id, company_id, fund_id, security_class_id, quantity, cost_basis, acquired_via_transaction_id, status, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'OPEN', ?8)`,
    )
      .bind(id, txn.company_id, fundId, txn.security_class_id, txn.quantity, txn.net_amount, txn.id, txn.firm_scope)
      .run();
    return { position_id: id, quantity_delta: txn.quantity, cost_basis_delta: txn.net_amount, resulting_quantity: txn.quantity, resulting_cost_basis: txn.net_amount, closed: false };
  }

  // Sell side: reduce (or close) the open position. cost basis relieved pro-rata.
  if (!existing) throw new InvestmentError(409, "no_open_position", "no OPEN position for (company, fund, security class) to sell from");
  if (txn.quantity > existing.quantity) {
    throw new InvestmentError(409, "insufficient_position", `position holds ${existing.quantity}, cannot sell ${txn.quantity}`);
  }
  const remaining = existing.quantity - txn.quantity;
  const relieved = (existing.cost_basis * txn.quantity) / existing.quantity;
  const newCostBasis = existing.cost_basis - relieved;
  const closed = remaining === 0;
  await env.WP_OS_DB.prepare("UPDATE position SET quantity = ?2, cost_basis = ?3, status = ?4, closed_at = ?5 WHERE id = ?1")
    .bind(existing.id, remaining, newCostBasis, closed ? "CLOSED" : "OPEN", closed ? new Date().toISOString() : null)
    .run();
  return { position_id: existing.id, quantity_delta: -txn.quantity, cost_basis_delta: -relieved, resulting_quantity: remaining, resulting_cost_basis: newCostBasis, closed };
}

/** Reverse a previously applied position effect (void path). */
async function reversePositionEffect(env: Env, txn: TransactionRow, effect: PositionEffect): Promise<void> {
  const position = await env.WP_OS_DB.prepare("SELECT * FROM position WHERE id = ?1").bind(effect.position_id).first<PositionRow>();
  if (!position) throw new InvestmentError(409, "cannot_reverse", "position row for the execution effect no longer exists");
  const quantity = position.quantity - effect.quantity_delta;
  const costBasis = position.cost_basis - effect.cost_basis_delta;
  if (Math.abs(quantity) > 1e-9 && quantity < 0) throw new InvestmentError(409, "cannot_reverse", "reversal would drive the position negative (later activity)");
  const reopened = position.status === "CLOSED" && quantity > 0;
  const closedNow = quantity <= 1e-9;
  await env.WP_OS_DB.prepare("UPDATE position SET quantity = ?2, cost_basis = ?3, status = ?4, closed_at = ?5 WHERE id = ?1")
    .bind(position.id, closedNow ? 0 : quantity, costBasis, closedNow ? "CLOSED" : "OPEN", closedNow ? (position.closed_at ?? new Date().toISOString()) : reopened ? null : position.closed_at)
    .run();
}

/**
 * Execute an approved transaction. authorize() with the type-specific reserved action
 * + an approved receipt is the only way in; the receipt is consumed on success.
 * Execution applies the position effect and records it on the spine.
 */
export async function executeTransaction(env: Env, actor: Actor, transactionId: string, receiptId: string | undefined, fundIdGiven?: string): Promise<TransactionRow> {
  const txn = await getTransaction(env, transactionId);
  if (!txn) throw new InvestmentError(404, "not_found");
  // The fund the draft named (Phase D) wins over one typed at execution: the card the partner
  // approved said where the position would be booked, and a different fund here would book
  // something other than what was approved.
  const fundId = txn.fund_id ?? fundIdGiven;
  if (txn.fund_id && fundIdGiven && fundIdGiven !== txn.fund_id) {
    throw new InvestmentError(409, "fund_mismatch", `the draft names fund ${txn.fund_id}; it cannot be booked to ${fundIdGiven}`);
  }
  const opportunity = txn.opportunity_id ? await getOpportunity(env, txn.opportunity_id) : null;
  const actionKey = reservedActionForTransaction(txn, opportunity);
  const authz = await authorize(env, actor, actionKey, { objectType: "transaction", objectId: transactionId, firmScope: txn.firm_scope }, { receiptId });
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new InvestmentError(409, "approval_required", authz.reason);
  if (txn.status !== "PENDING_APPROVAL" && txn.status !== "APPROVED") {
    throw new InvestmentError(409, "illegal_state", `transaction is ${txn.status}; only PENDING_APPROVAL/APPROVED can execute`);
  }
  if (!fundId) throw new InvestmentError(400, "invalid_input", "fund_id is required to book the position effect");

  const effect = await applyPositionEffect(env, actor, txn, fundId);
  await env.WP_OS_DB.prepare('UPDATE "transaction" SET status = \'EXECUTED\' WHERE id = ?1').bind(transactionId).run();
  if (authz.receiptId) await consumeApprovalCard(env, authz.receiptId, { actorId: actor.firmUserId ?? "system" });

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.transaction_executed",
    actorType,
    actorId,
    objectType: "transaction",
    objectId: transactionId,
    firmScope: txn.firm_scope,
    payload: { action_key: actionKey, receipt_id: authz.receiptId ?? null, fund_id: fundId, position_effect: effect },
  });
  await appendEvent(env, {
    eventType: effect.quantity_delta > 0 && effect.resulting_quantity === effect.quantity_delta ? "investment.position_opened" : "investment.position_updated",
    actorType,
    actorId,
    objectType: "position",
    objectId: effect.position_id,
    firmScope: txn.firm_scope,
    payload: { transaction_id: transactionId, ...effect },
  });
  return (await getTransaction(env, transactionId))!;
}

/**
 * APPROVAL EXECUTES THE BOOKING (Phase D: portfolio, design §6, decision Q1 — owner, 18 Sep 2026).
 *
 * The ladder used to have a rung after the partner's decision: come back to the deal record, paste
 * the card's id into a box, press "Book it". `RecordInvestment.tsx` carried that box and the e2e
 * journey walked it. The owner's words were that there has to be an easy, intuitive way to book a
 * company as a real Fund I position, and the design's answer is that the partner's approval of the
 * `investment.approve` card IS the booking — no receipt paste, no third click.
 *
 * WHAT IS UNCHANGED, and it is the whole of the governance:
 *   · nothing reaches `position` except `applyPositionEffect`, and nothing calls that except
 *     `executeTransaction` — this function calls `executeTransaction`, with the approved card as
 *     the receipt, exactly as the explicit route does; `validate:booking` reads the code to keep it so;
 *   · `executeTransaction` re-verifies the receipt through `authorize()` — state approved, this
 *     action key, this object, decided by somebody who still holds the role — and consumes it, so
 *     the card cannot book twice and the explicit route afterwards answers `receipt_already_consumed`;
 *   · the fund is the one the DRAFT named (0209). A draft with no fund — the older API shape — is
 *     not booked here, because the ledger cannot book to a fund nobody named; the decision stands
 *     and the explicit route books it with the fund given. Both outcomes are said in the result and
 *     written on the spine, so an approval that booked nothing is never silent (Rule 0).
 *
 * Called from `decideApproval` (a partner's click) and from `submitTransactionForApproval` when a
 * standing authority approved the card at submission — the same act, decided in advance.
 */
export interface BookingOnApproval {
  executed: boolean;
  transaction_id: string;
  position_id: string | null;
  reason: string;
}

export async function bookOnApproval(
  env: Env,
  actor: Actor,
  card: { id: string; state: string; action_key: string; object_type: string; object_id: string; firm_scope: string },
): Promise<BookingOnApproval | null> {
  if (card.object_type !== "transaction" || card.state !== "approved") return null;
  const txn = await getTransaction(env, card.object_id);
  if (!txn) return null;
  const opportunity = txn.opportunity_id ? await getOpportunity(env, txn.opportunity_id) : null;
  if (reservedActionForTransaction(txn, opportunity) !== card.action_key) return null;
  if (txn.status === "EXECUTED") {
    return { executed: false, transaction_id: txn.id, position_id: null, reason: "already_executed" };
  }
  if (!txn.fund_id) {
    const { actorType, actorId } = eventActor(actor);
    await appendEvent(env, {
      eventType: "investment.booking_awaits_fund",
      actorType,
      actorId,
      objectType: "transaction",
      objectId: txn.id,
      firmScope: txn.firm_scope,
      payload: { approval_card_id: card.id, reason: "no_fund_on_draft" },
    });
    return {
      executed: false,
      transaction_id: txn.id,
      position_id: null,
      reason: "Approved, not booked: the draft names no fund. Book it on the company's record with the fund named, or draft it again from Portfolio.",
    };
  }
  const executed = await executeTransaction(env, actor, txn.id, card.id, txn.fund_id);
  const position = await env.WP_OS_DB.prepare(
    "SELECT id FROM position WHERE company_id = ?1 AND fund_id = ?2 AND security_class_id = ?3 AND status = 'OPEN'",
  )
    .bind(executed.company_id, txn.fund_id, executed.security_class_id)
    .first<{ id: string }>();
  return { executed: true, transaction_id: txn.id, position_id: position?.id ?? null, reason: "booked_on_approval" };
}

/**
 * Void a transaction (MP-reserved transaction.void + receipt). The record is never
 * deleted; for EXECUTED transactions the recorded position effect is reversed.
 */
export async function voidTransaction(env: Env, actor: Actor, transactionId: string, receiptId?: string): Promise<TransactionRow> {
  const txn = await getTransaction(env, transactionId);
  if (!txn) throw new InvestmentError(404, "not_found");
  if (txn.status === "VOID") throw new InvestmentError(409, "already_void");
  const authz = await authorize(env, actor, "transaction.void", { objectType: "transaction", objectId: transactionId, firmScope: txn.firm_scope }, { receiptId });
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new InvestmentError(409, "approval_required", authz.reason);

  if (txn.status === "EXECUTED") {
    // Recover the recorded position effect from the spine to reverse it exactly.
    const event = await env.WP_OS_DB.prepare(
      "SELECT payload_json FROM event_record WHERE event_type = 'investment.transaction_executed' AND object_type = 'transaction' AND object_id = ?1 ORDER BY created_at DESC LIMIT 1",
    )
      .bind(transactionId)
      .first<{ payload_json: string }>();
    if (!event) throw new InvestmentError(409, "cannot_reverse", "no execution effect recorded on the spine; cannot prove reversal");
    const effect = (JSON.parse(event.payload_json) as { position_effect: PositionEffect }).position_effect;
    await reversePositionEffect(env, txn, effect);
  }
  await env.WP_OS_DB.prepare('UPDATE "transaction" SET status = \'VOID\' WHERE id = ?1').bind(transactionId).run();
  if (authz.receiptId) await consumeApprovalCard(env, authz.receiptId, { actorId: actor.firmUserId ?? "system" });
  await appendEvent(env, {
    eventType: "investment.transaction_voided",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "transaction",
    objectId: transactionId,
    firmScope: txn.firm_scope,
    payload: { prior_status: txn.status, receipt_id: authz.receiptId ?? null },
  });
  return (await getTransaction(env, transactionId))!;
}

// ── Ownership snapshots ──

export async function createOwnershipSnapshot(
  env: Env,
  actor: Actor,
  input: { company_id: string; fund_id: string; as_of_date: string; ownership_pct: number; fully_diluted_shares?: number; dilution_assumptions?: Record<string, unknown>; source: string },
) {
  await mustAuthorize(env, actor, "ownership_snapshot.create", "ownership_snapshot");
  await requireCompany(env, input.company_id);
  await requireFund(env, input.fund_id);
  const id = `ows_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO ownership_snapshot (id, company_id, fund_id, as_of_date, ownership_pct, fully_diluted_shares, dilution_assumptions_json, source, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, input.company_id, input.fund_id, input.as_of_date, input.ownership_pct, input.fully_diluted_shares ?? null, JSON.stringify(input.dilution_assumptions ?? {}), input.source, actor.firmScopes[0] ?? "west-peek")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.ownership_snapshot_created",
    actorType,
    actorId,
    objectType: "ownership_snapshot",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { company_id: input.company_id, fund_id: input.fund_id, as_of_date: input.as_of_date, ownership_pct: input.ownership_pct },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM ownership_snapshot WHERE id = ?1").bind(id).first();
}

// ── Pricing observations ──

export async function createPricingObservation(
  env: Env,
  actor: Actor,
  input: {
    company_id: string;
    observation_type: (typeof PRICING_OBSERVATION_TYPES)[number];
    price_per_share?: number;
    implied_valuation?: number;
    block_size?: number;
    seller_type?: string;
    fees?: number;
    carry?: number;
    observed_at: string;
    source: string;
    privacy_label?: string;
  },
) {
  await mustAuthorize(env, actor, "pricing_observation.create", "pricing_observation");
  await requireCompany(env, input.company_id);
  const id = `pro_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO pricing_observation
       (id, company_id, observation_type, price_per_share, implied_valuation, block_size, seller_type, fees, carry, observed_at, source, privacy_label, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id,
      input.company_id,
      input.observation_type,
      input.price_per_share ?? null,
      input.implied_valuation ?? null,
      input.block_size ?? null,
      input.seller_type ?? null,
      input.fees ?? null,
      input.carry ?? null,
      input.observed_at,
      input.source,
      input.privacy_label ?? "INTERNAL",
      actor.firmScopes[0] ?? "west-peek",
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.pricing_observation_created",
    actorType,
    actorId,
    objectType: "pricing_observation",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { company_id: input.company_id, observation_type: input.observation_type, price_per_share: input.price_per_share ?? null },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM pricing_observation WHERE id = ?1").bind(id).first();
}

// ── Deal math packets ──

export interface DealMathPacketRow {
  id: string;
  opportunity_id: string;
  deal_type: string;
  source_inputs_json: string;
  assumption_set_json: string;
  valuation: number | null;
  check_size: number | null;
  ownership_at_close: number | null;
  expected_exit_ownership: number | null;
  dilution_assumptions_json: string;
  pro_rata_status: string | null;
  reserve_requirement: number | null;
  moic: number | null;
  tvpi: number | null;
  dpi: number | null;
  xirr: number | null;
  fund_contribution: number | null;
  concentration_impact: number | null;
  secondary_discount_premium: number | null;
  margin_of_safety_note: string | null;
  math_quality_status: MathQualityStatus;
  missing_inputs_json: string;
  entry_mode: "MANUAL" | "CALCULATED";
  reviewed_by: string | null;
  approval_status: string;
  ic_ready: number;
  firm_scope: string;
  created_by: string;
  created_at: string;
}

/** Required source inputs per deal type for the CALCULATED path (verified formulas only). */
export const REQUIRED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  EARLY_STAGE_PRIMARY: ["check_size", "round_size", "pre_money", "exit_value", "future_dilution_pct", "hold_years", "fund_size"],
  FOLLOW_ON: ["check_size", "round_size", "pre_money", "exit_value", "future_dilution_pct", "hold_years", "fund_size"],
  SECONDARY_PURCHASE: ["deal_size", "round_price", "secondary_price", "exit_multiple", "hold_years", "entry_date", "exit_date"],
  SECONDARY_SALE: ["deal_size", "round_price", "secondary_price"],
  OTHER: [],
};

export function missingInputsFor(dealType: string, inputs: Record<string, unknown>): string[] {
  const required = REQUIRED_INPUTS[dealType] ?? [];
  return required.filter((key) => {
    const value = inputs[key];
    if (value === undefined || value === null || value === "") return true;
    if (typeof value === "number" && !Number.isFinite(value)) return true;
    return false;
  });
}

export async function getDealMathPacket(env: Env, id: string): Promise<DealMathPacketRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM deal_math_packet WHERE id = ?1").bind(id).first<DealMathPacketRow>();
}

async function appendAssumptionLedger(env: Env, packetId: string, firmScope: string, changedBy: string, change: Record<string, unknown>): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO assumption_ledger (id, packet_id, change_json, firm_scope, changed_by) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(`asl_${crypto.randomUUID()}`, packetId, JSON.stringify(change), firmScope, changedBy)
    .run();
}

async function syncAssumptionRows(env: Env, packetId: string, firmScope: string, actorId: string, assumptions: Record<string, unknown>, source: string): Promise<void> {
  for (const [key, value] of Object.entries(assumptions)) {
    await env.WP_OS_DB.prepare(
      "INSERT INTO deal_math_assumption (id, packet_id, assumption_key, assumption_value, source, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(`dma_${crypto.randomUUID()}`, packetId, key, String(value), source, firmScope, actorId)
      .run();
  }
}

export interface DealMathPacketInput {
  deal_type: string;
  source_inputs?: Record<string, unknown>;
  assumption_set?: Record<string, unknown>;
  // Manual metric entry (D6): any derived metric may be hand-entered.
  valuation?: number;
  check_size?: number;
  ownership_at_close?: number;
  expected_exit_ownership?: number;
  dilution_assumptions?: Record<string, unknown>;
  pro_rata_status?: string;
  reserve_requirement?: number;
  moic?: number;
  tvpi?: number;
  dpi?: number;
  xirr?: number;
  fund_contribution?: number;
  concentration_impact?: number;
  secondary_discount_premium?: number;
  margin_of_safety_note?: string;
}

const MANUAL_METRIC_FIELDS = [
  "valuation",
  "check_size",
  "ownership_at_close",
  "expected_exit_ownership",
  "pro_rata_status",
  "reserve_requirement",
  "moic",
  "tvpi",
  "dpi",
  "xirr",
  "fund_contribution",
  "concentration_impact",
  "secondary_discount_premium",
  "margin_of_safety_note",
] as const;

/** Manual packet entry (D6). Missing required inputs are tracked, never blocking. */
export async function createDealMathPacket(env: Env, actor: Actor, opportunityId: string, input: DealMathPacketInput): Promise<DealMathPacketRow> {
  const opportunity = await getOpportunity(env, opportunityId);
  if (!opportunity) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "deal_math_packet.create", "deal_math_packet", undefined, opportunity.firm_scope);

  const inputs = input.source_inputs ?? {};
  const missing = missingInputsFor(input.deal_type, inputs);
  const status: MathQualityStatus = missing.length > 0 ? "INPUTS_MISSING" : "DRAFT_MATH_COMPLETE";
  const id = `dmp_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO deal_math_packet
       (id, opportunity_id, deal_type, source_inputs_json, assumption_set_json, valuation, check_size, ownership_at_close,
        expected_exit_ownership, dilution_assumptions_json, pro_rata_status, reserve_requirement, moic, tvpi, dpi, xirr,
        fund_contribution, concentration_impact, secondary_discount_premium, margin_of_safety_note,
        math_quality_status, missing_inputs_json, entry_mode, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'MANUAL', ?23, ?24)`,
  )
    .bind(
      id,
      opportunityId,
      input.deal_type,
      JSON.stringify(inputs),
      JSON.stringify(input.assumption_set ?? {}),
      input.valuation ?? null,
      input.check_size ?? null,
      input.ownership_at_close ?? null,
      input.expected_exit_ownership ?? null,
      JSON.stringify(input.dilution_assumptions ?? {}),
      input.pro_rata_status ?? null,
      input.reserve_requirement ?? null,
      input.moic ?? null,
      input.tvpi ?? null,
      input.dpi ?? null,
      input.xirr ?? null,
      input.fund_contribution ?? null,
      input.concentration_impact ?? null,
      input.secondary_discount_premium ?? null,
      input.margin_of_safety_note ?? null,
      status,
      JSON.stringify(missing),
      opportunity.firm_scope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  const actorId = actor.firmUserId ?? actor.aiEmployeeId ?? "system";
  await syncAssumptionRows(env, id, opportunity.firm_scope, actorId, input.assumption_set ?? {}, "manual_entry");
  await appendAssumptionLedger(env, id, opportunity.firm_scope, actorId, { kind: "packet_created", entry_mode: "MANUAL", source_inputs: inputs, assumption_set: input.assumption_set ?? {}, missing_inputs: missing });
  const { actorType, actorId: eventActorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.deal_math_packet_created",
    actorType,
    actorId: eventActorId,
    objectType: "deal_math_packet",
    objectId: id,
    firmScope: opportunity.firm_scope,
    payload: { opportunity_id: opportunityId, deal_type: input.deal_type, entry_mode: "MANUAL", math_quality_status: status },
  });
  return (await getDealMathPacket(env, id))!;
}

/** Update inputs/assumptions/manual metrics. Every change appends to the assumption ledger. */
export async function updateDealMathPacket(env: Env, actor: Actor, packetId: string, input: Partial<DealMathPacketInput>): Promise<DealMathPacketRow> {
  const packet = await getDealMathPacket(env, packetId);
  if (!packet) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "deal_math_packet.update", "deal_math_packet", packetId, packet.firm_scope);
  if (packet.math_quality_status === "REJECTED" || packet.math_quality_status === "MATH_DOES_NOT_WORK") {
    throw new InvestmentError(409, "packet_terminal", `packet in terminal status ${packet.math_quality_status} cannot be edited`);
  }

  const actorId = actor.firmUserId ?? actor.aiEmployeeId ?? "system";
  const change: Record<string, unknown> = { kind: "packet_updated" };
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (column: string, value: unknown) => {
    sets.push(`${column} = ?${binds.length + 2}`);
    binds.push(value);
  };

  let inputs = JSON.parse(packet.source_inputs_json) as Record<string, unknown>;
  if (input.source_inputs !== undefined) {
    change.source_inputs = { from: inputs, to: input.source_inputs };
    inputs = input.source_inputs;
    push("source_inputs_json", JSON.stringify(inputs));
  }
  if (input.assumption_set !== undefined) {
    change.assumption_set = { from: JSON.parse(packet.assumption_set_json), to: input.assumption_set };
    push("assumption_set_json", JSON.stringify(input.assumption_set));
    await syncAssumptionRows(env, packetId, packet.firm_scope, actorId, input.assumption_set, "manual_update");
  }
  if (input.dilution_assumptions !== undefined) {
    push("dilution_assumptions_json", JSON.stringify(input.dilution_assumptions));
  }
  const metricChanges: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of MANUAL_METRIC_FIELDS) {
    if (field in input) {
      metricChanges[field] = { from: packet[field as keyof DealMathPacketRow], to: (input as Record<string, unknown>)[field] ?? null };
      push(field, (input as Record<string, unknown>)[field] ?? null);
    }
  }
  if (Object.keys(metricChanges).length > 0) change.metrics = metricChanges;

  const missing = missingInputsFor(packet.deal_type, inputs);
  push("missing_inputs_json", JSON.stringify(missing));
  // Manual edits move the packet back to draft/inputs-missing from any review state.
  const nextStatus: MathQualityStatus = missing.length > 0 ? "INPUTS_MISSING" : "DRAFT_MATH_COMPLETE";
  push("math_quality_status", nextStatus);
  push("ic_ready", 0);
  push("reviewed_by", null);
  change.missing_inputs = missing;
  change.resulting_status = nextStatus;

  await env.WP_OS_DB.prepare(`UPDATE deal_math_packet SET ${sets.join(", ")} WHERE id = ?1`).bind(packetId, ...binds).run();
  await appendAssumptionLedger(env, packetId, packet.firm_scope, actorId, change);
  const { actorType, actorId: eventActorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.deal_math_packet_updated",
    actorType,
    actorId: eventActorId,
    objectType: "deal_math_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { resulting_status: nextStatus, missing_inputs: missing },
  });
  return (await getDealMathPacket(env, packetId))!;
}

/**
 * The CALCULATED path (D6 + ADR-005): run ONLY the independently verified functions
 * (src/shared/dealmath; docs/DEAL_MATH_VERIFICATION.md) over the packet's source
 * inputs and fill the derived metrics those functions produce. Metrics without a
 * verified formula (tvpi, dpi) are NEVER touched here — manual entry only.
 */
export async function calculateDealMathPacket(env: Env, actor: Actor, opportunityId: string): Promise<DealMathPacketRow> {
  const opportunity = await getOpportunity(env, opportunityId);
  if (!opportunity) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "deal_math.calculate", "deal_math_packet", undefined, opportunity.firm_scope);
  const packets = await env.WP_OS_DB.prepare("SELECT * FROM deal_math_packet WHERE opportunity_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(opportunityId)
    .all<DealMathPacketRow>();
  const packet = (packets.results ?? [])[0];
  if (!packet) throw new InvestmentError(404, "not_found", "no deal math packet for this opportunity");

  const inputs = JSON.parse(packet.source_inputs_json) as Record<string, unknown>;
  const missing = missingInputsFor(packet.deal_type, inputs);
  const actorId = actor.firmUserId ?? actor.aiEmployeeId ?? "system";
  if (missing.length > 0) {
    await env.WP_OS_DB.prepare("UPDATE deal_math_packet SET math_quality_status = 'INPUTS_MISSING', missing_inputs_json = ?2, ic_ready = 0 WHERE id = ?1")
      .bind(packet.id, JSON.stringify(missing))
      .run();
    await appendAssumptionLedger(env, packet.id, packet.firm_scope, actorId, { kind: "calculate_refused", missing_inputs: missing });
    throw new InvestmentError(409, "inputs_missing", `missing required inputs: ${missing.join(", ")}`);
  }

  const num = (key: string): number => Number(inputs[key]);
  const str = (key: string): string => String(inputs[key]);
  const derived: Record<string, number | null> = {};

  if (packet.deal_type === "EARLY_STAGE_PRIMARY" || packet.deal_type === "FOLLOW_ON") {
    const r = computePrimaryDeal({
      instrument: (inputs.instrument as "priced" | "post-money-safe" | "convertible-note") ?? "priced",
      checkSize: num("check_size"),
      roundSize: num("round_size"),
      preMoney: num("pre_money"),
      valuationCap: inputs.valuation_cap === undefined ? undefined : num("valuation_cap"),
      discountPct: inputs.discount_pct === undefined ? undefined : num("discount_pct"),
      noteInterestPct: inputs.note_interest_pct === undefined ? undefined : num("note_interest_pct"),
      nextRoundYears: inputs.next_round_years === undefined ? undefined : num("next_round_years"),
      futureDilutionPct: num("future_dilution_pct"),
      exitValue: num("exit_value"),
      holdYears: num("hold_years"),
      carryPct: inputs.carry_pct === undefined ? undefined : num("carry_pct"),
      prefPct: inputs.pref_pct === undefined ? undefined : num("pref_pct"),
      carryBasis: (inputs.carry_basis as CarryBasis) ?? "none",
      liqPrefMultiple: inputs.liq_pref_multiple === undefined ? undefined : num("liq_pref_multiple"),
      preferenceType: (inputs.preference_type as "non-participating" | "participating") ?? "non-participating",
      fundSize: num("fund_size"),
    });
    derived.valuation = r.postMoney;
    derived.check_size = num("check_size");
    derived.ownership_at_close = r.ownershipPct;
    derived.expected_exit_ownership = r.exitOwnershipPct;
    derived.moic = r.netMoic;
    derived.fund_contribution = r.fundContribution;
    derived.reserve_requirement = r.proRataNeed;
    derived.concentration_impact = safeDiv(num("check_size"), num("fund_size")) * 100;
    if (inputs.entry_date && inputs.exit_date) {
      derived.xirr = xirr([
        { date: str("entry_date"), amount: -(num("check_size") + r.upfrontFee + r.mgmtFees) },
        { date: str("exit_date"), amount: r.netProceeds },
      ]);
    }
  } else if (packet.deal_type === "SECONDARY_PURCHASE" || packet.deal_type === "SECONDARY_SALE") {
    const pd = premiumDiscount(num("round_price"), num("secondary_price"));
    derived.secondary_discount_premium = pd.pct;
    derived.check_size = num("deal_size");
    if (packet.deal_type === "SECONDARY_PURCHASE") {
      const invested = num("deal_size");
      const holdYears = num("hold_years");
      const structure = computeSecondaryStructure(
        "packet",
        inputs.upfront_pct === undefined ? 0 : num("upfront_pct"),
        inputs.mgmt_pct === undefined ? 0 : num("mgmt_pct"),
        inputs.carry_pct === undefined ? 0 : num("carry_pct"),
        inputs.pref_pct === undefined ? 0 : num("pref_pct"),
        (inputs.carry_basis as CarryBasis) ?? "hard",
        {
          dealSize: invested,
          basePrice: invested,
          investedCapital: invested,
          grossExit: invested * num("exit_multiple"),
          holdYears,
          entryDate: str("entry_date"),
          exitDate: str("exit_date"),
          legalCost: inputs.legal_cost === undefined ? 0 : num("legal_cost"),
          ongoingCost: inputs.ongoing_cost === undefined ? 0 : num("ongoing_cost"),
          allocations: {
            upfront: { investor: 1, sponsor: 0, client: 0 },
            mgmt: { investor: 1, sponsor: 0, client: 0 },
            carry: { investor: 1, sponsor: 0, client: 0 },
            legal: { investor: 1, sponsor: 0, client: 0 },
            ongoing: { investor: 1, sponsor: 0, client: 0 },
          },
          interimFlows: [],
        },
      );
      derived.moic = structure.netMultiple;
      derived.xirr = structure.irr;
      if (inputs.fund_size !== undefined) derived.concentration_impact = safeDiv(invested, num("fund_size")) * 100;
    }
  } else {
    throw new InvestmentError(400, "unsupported_deal_type", `no verified calculation for deal_type '${packet.deal_type}' — manual entry remains available (D6)`);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [field, value] of Object.entries(derived)) {
    sets.push(`${field} = ?${binds.length + 2}`);
    binds.push(value);
  }
  sets.push(`entry_mode = 'CALCULATED'`, `math_quality_status = 'DRAFT_MATH_COMPLETE'`, `missing_inputs_json = '[]'`, `ic_ready = 0`, `reviewed_by = NULL`);
  await env.WP_OS_DB.prepare(`UPDATE deal_math_packet SET ${sets.join(", ")} WHERE id = ?1`).bind(packet.id, ...binds).run();
  await appendAssumptionLedger(env, packet.id, packet.firm_scope, actorId, { kind: "calculated", deal_type: packet.deal_type, verified_functions: true, derived });
  const { actorType, actorId: eventActorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "investment.deal_math_calculated",
    actorType,
    actorId: eventActorId,
    objectType: "deal_math_packet",
    objectId: packet.id,
    firmScope: packet.firm_scope,
    payload: { opportunity_id: opportunityId, deal_type: packet.deal_type, derived },
  });
  return (await getDealMathPacket(env, packet.id))!;
}

/** Human review transition of math quality status. Sets reviewed_by / ic_ready. */
export async function reviewDealMathPacket(env: Env, actor: Actor, packetId: string, to: MathQualityStatus): Promise<DealMathPacketRow> {
  if (actor.type !== "HUMAN") throw new InvestmentError(403, "forbidden", "deal-math review is human-reserved");
  const packet = await getDealMathPacket(env, packetId);
  if (!packet) throw new InvestmentError(404, "not_found");
  await mustAuthorize(env, actor, "deal_math_packet.review", "deal_math_packet", packetId, packet.firm_scope);
  const allowed = MATH_STATUS_TRANSITIONS[packet.math_quality_status];
  if (!allowed.includes(to)) {
    throw new InvestmentError(409, "illegal_transition", `math quality cannot transition ${packet.math_quality_status} → ${to}`);
  }
  await env.WP_OS_DB.prepare("UPDATE deal_math_packet SET math_quality_status = ?2, reviewed_by = ?3, ic_ready = ?4 WHERE id = ?1")
    .bind(packetId, to, actor.firmUserId!, to === "IC_READY" ? 1 : 0)
    .run();
  await appendAssumptionLedger(env, packetId, packet.firm_scope, actor.firmUserId!, { kind: "review_transition", from: packet.math_quality_status, to });
  await appendEvent(env, {
    eventType: "investment.deal_math_reviewed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "deal_math_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { from: packet.math_quality_status, to, ic_ready: to === "IC_READY" },
  });
  return (await getDealMathPacket(env, packetId))!;
}

// ── Company 360 (D3: one canonical identity underlying every view) ──

export async function getCompany360(env: Env, companyId: string) {
  const company = await env.WP_OS_DB.prepare("SELECT * FROM canonical_company WHERE id = ?1").bind(companyId).first();
  if (!company) return null;
  const all = async <T>(sql: string, ...binds: string[]): Promise<T[]> => {
    const rows = await env.WP_OS_DB.prepare(sql).bind(...binds).all<T>();
    return rows.results ?? [];
  };
  const opportunities = await all<OpportunityRow>("SELECT * FROM investment_opportunity WHERE company_id = ?1 ORDER BY created_at, id", companyId);
  const opportunityIds = opportunities.map((o) => o.id);
  const dealMathPackets = opportunityIds.length
    ? await all<DealMathPacketRow>(
        `SELECT * FROM deal_math_packet WHERE opportunity_id IN (${opportunityIds.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY created_at, id`,
        ...opportunityIds,
      )
    : [];
  const icPackets = opportunityIds.length
    ? await all(
        `SELECT * FROM ic_packet WHERE opportunity_id IN (${opportunityIds.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY created_at, id`,
        ...opportunityIds,
      )
    : [];
  return {
    company,
    security_classes: await all<SecurityClassRow>("SELECT * FROM security_class WHERE company_id = ?1 ORDER BY created_at, id", companyId),
    opportunities,
    transactions: await all<TransactionRow>('SELECT * FROM "transaction" WHERE company_id = ?1 ORDER BY created_at, id', companyId),
    positions: await all<PositionRow>("SELECT * FROM position WHERE company_id = ?1 ORDER BY opened_at, id", companyId),
    ownership_snapshots: await all("SELECT * FROM ownership_snapshot WHERE company_id = ?1 ORDER BY as_of_date, id", companyId),
    pricing_observations: await all("SELECT * FROM pricing_observation WHERE company_id = ?1 ORDER BY observed_at, id", companyId),
    claims: await all("SELECT * FROM diligence_claim WHERE company_id = ?1 ORDER BY created_at, id", companyId),
    contradictions: await all("SELECT * FROM contradiction_record WHERE company_id = ?1 ORDER BY created_at, id", companyId),
    deal_math_packets: dealMathPackets,
    ic_packets: icPackets,
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
  if (err instanceof InvestmentError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const createSecurityClassSchema = z.object({
  company_id: z.string().trim().min(1),
  class_name: z.string().trim().min(1),
  seniority: z.string().optional(),
  notes: z.string().optional(),
});

export async function handleCreateSecurityClass(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createSecurityClassSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createSecurityClass(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListSecurityClasses(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const rows = companyId
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM security_class WHERE company_id = ?1 ORDER BY created_at, id").bind(companyId).all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM security_class ORDER BY created_at, id LIMIT 500").all();
  return json({ security_classes: rows.results ?? [] });
}

/** Must stay in step with the relationship_origin CHECK in migration 0044. */
export const RELATIONSHIP_ORIGINS = [
  "UNRECORDED", "ROOM", "MASTERMIND", "OFFICE", "COUNCIL", "COMMUNITY_INTRO",
  "PORTFOLIO_REFERRAL", "LP_REFERRAL", "INBOUND", "OUTBOUND", "NETWORK", "OTHER",
] as const;

const createOpportunitySchema = z.object({
  company_id: z.string().trim().min(1),
  opportunity_type: z.enum(OPPORTUNITY_TYPES),
  title: z.string().trim().min(1),
  source_channel: z.string().optional(),
  security_class_id: z.string().trim().min(1).optional(),
  price_per_share: z.number().optional(),
  discount_premium: z.number().optional(),
  quantity: z.number().optional(),
  seller_name: z.string().optional(),
  broker_name: z.string().optional(),
  fees: z.number().optional(),
  carry: z.number().optional(),
  terms: z.record(z.unknown()).optional(),
  privacy_label: privacyLabelSchema.optional(),
  // P51 — "the output is early inclusion". The gap between when the relationship started and when
  // the deal appeared is the only measurement that tests whether the community model works.
  relationship_origin: z.enum(RELATIONSHIP_ORIGINS).optional(),
  origin_event_id: z.string().trim().max(80).optional(),
  // A record can be born provisional (migration 0052). Stand-in economics are legitimate when the
  // paperwork is not to hand — they are only dangerous when nothing says they are stand-ins.
  placeholder_fields: z.array(z.string().trim().min(1)).optional(),
  placeholder_note: z.string().trim().min(1).optional(),
  relationship_started_at: z.string().trim().max(40).optional(),
});

/**
 * THE MANUAL DOOR — a partner pressing "Add a company", and route 1 of 4 (item 7).
 *
 * It goes through `openIntoFunnel` like every other route rather than calling `createOpportunity`
 * itself. What that buys is not the write, which was always correct here: it is that the arrival is
 * MATCHED and RECORDED by the same code as the other three, so "where did this deal come from" has
 * one answer for the whole pipeline instead of an answer for three routes and a blank for the door
 * partners actually use. The record it opens is unchanged — same schema, same authorization, same
 * 201 body — because this is the one route with an authenticated human behind it and it has never
 * needed anyone's permission to write.
 */
export async function handleCreateOpportunity(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createOpportunitySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const company = await ctx.env.WP_OS_DB.prepare("SELECT canonical_name FROM canonical_company WHERE id = ?1")
    .bind(parsed.data.company_id)
    .first<{ canonical_name: string }>();
  if (!company) {
    return errorResponse(new InvestmentError(400, "unknown_company", `canonical_company '${parsed.data.company_id}' does not exist`));
  }
  try {
    const entry = await openIntoFunnel(ctx.env, manualArrival(ctx.identity!, { ...parsed.data, company: company.canonical_name }));
    return json(entry.opportunity, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListOpportunities(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const status = url.searchParams.get("status");
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const clauses = [visibility];
  const binds: string[] = [];
  if (companyId) {
    clauses.push(`company_id = ?${binds.length + 1}`);
    binds.push(companyId);
  }
  if (status) {
    clauses.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  // Archived records are off the board. `?archived=1` shows what was taken off it and why, so the
  // removal is auditable rather than a disappearance.
  clauses.push(url.searchParams.get("archived") === "1" ? "archived_at IS NOT NULL" : "archived_at IS NULL");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM investment_opportunity WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT 500`)
    .bind(...binds)
    .all<OpportunityRow>();
  return json({ opportunities: rows.results ?? [] });
}

export async function handleGetOpportunity(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const row = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM investment_opportunity WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<OpportunityRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const links = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM opportunity_block_link WHERE opportunity_id_a = ?1 OR opportunity_id_b = ?1 ORDER BY created_at, id",
  )
    .bind(row.id)
    .all();
  const packets = await ctx.env.WP_OS_DB.prepare("SELECT * FROM deal_math_packet WHERE opportunity_id = ?1 ORDER BY created_at, id").bind(row.id).all();
  const icPackets = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ic_packet WHERE opportunity_id = ?1 ORDER BY created_at, id").bind(row.id).all();
  return json({ ...row, block_links: links.results ?? [], deal_math_packets: packets.results ?? [], ic_packets: icPackets.results ?? [] });
}

const updateOpportunitySchema = createOpportunitySchema.partial().omit({ company_id: true, opportunity_type: true });

export async function handleUpdateOpportunity(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = updateOpportunitySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await updateOpportunity(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

const transitionOpportunitySchema = z.object({
  to: z.enum(OPPORTUNITY_STATUSES),
  /** Required when leaving the pipeline. Long enough to be worth reading later. */
  reason: z.string().trim().max(600).optional(),
});

export async function handleTransitionOpportunity(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = transitionOpportunitySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(
      await transitionOpportunity(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to, parsed.data.reason),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * `reason` has a real minimum length on purpose. "backfill" or "old" would satisfy a
 * non-empty check and tell a future reader nothing, which is the entire failure this lane exists
 * to avoid.
 */
const backfillOpportunitySchema = z.object({
  to: z.enum(OPPORTUNITY_STATUSES),
  reason: z.string().trim().min(12),
  as_of_date: z.string().trim().min(1).optional(),
});

const archiveOpportunitySchema = z.object({ reason: z.string().trim().min(8).max(600) });

export async function handleArchiveOpportunity(ctx: RouteContext): Promise<Response> {
  const parsed = archiveOpportunitySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) {
    return json(
      { error: "reason_required", detail: "Say why this record should not exist — a duplicate, a typo, entered twice." },
      { status: 400 },
    );
  }
  try {
    return json(await archiveOpportunity(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.reason));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleBackfillOpportunity(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = backfillOpportunitySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await backfillOpportunity(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleScanBlockLinks(ctx: RouteContext): Promise<Response> {
  try {
    const links = await scanBlockLinks(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!);
    return json({ links }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const createBlockLinkSchema = z.object({
  opportunity_id_b: z.string().trim().min(1),
  link_type: z.enum(BLOCK_LINK_TYPES),
  basis: z.record(z.unknown()).optional(),
});

export async function handleCreateBlockLink(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createBlockLinkSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const link = await createBlockLink(ctx.env, actorFromIdentity(ctx.identity!), { ...parsed.data, opportunity_id_a: ctx.params.id! });
    return json(link, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const decideBlockLinkSchema = z.object({ decision: z.enum(["CONFIRMED", "REJECTED"]) });

export async function handleDecideBlockLink(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = decideBlockLinkSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await decideBlockLink(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.decision));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListBlockLinks(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const opportunityId = url.searchParams.get("opportunity_id");
  const rows = opportunityId
    ? await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM opportunity_block_link WHERE opportunity_id_a = ?1 OR opportunity_id_b = ?1 ORDER BY created_at, id",
      )
        .bind(opportunityId)
        .all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM opportunity_block_link ORDER BY created_at DESC, id LIMIT 500").all();
  return json({ links: rows.results ?? [] });
}

// ── Transaction handlers ──

const partySchema = z.object({
  party_type: z.enum(TRANSACTION_PARTY_TYPES),
  party_name: z.string().trim().min(1),
  party_ref_id: z.string().optional(),
});

const createTransactionSchema = z.object({
  company_id: z.string().trim().min(1),
  opportunity_id: z.string().trim().min(1).optional(),
  transaction_type: z.enum(TRANSACTION_TYPES),
  security_class_id: z.string().trim().min(1),
  quantity: z.number().positive(),
  price_per_share: z.number().positive(),
  fees: z.number().optional(),
  carry: z.number().optional(),
  transaction_date: z.string().trim().min(1),
  parties: z.array(partySchema).optional(),
  // Phase D: named on the draft so approval can execute (0209). Optional here so the older
  // API shape still drafts; a draft without a fund executes only through the explicit route.
  fund_id: z.string().trim().min(1).optional(),
  vehicle: z.string().trim().min(1).max(80).optional(),
});

export async function handleCreateTransaction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createTransaction(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListTransactions(ctx: RouteContext): Promise<Response> {
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
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM "transaction" WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT 500`)
    .bind(...binds)
    .all<TransactionRow>();
  return json({ transactions: rows.results ?? [] });
}

export async function handleGetTransaction(ctx: RouteContext): Promise<Response> {
  const txn = await getTransaction(ctx.env, ctx.params.id!);
  if (!txn) return json({ error: "not_found" }, { status: 404 });
  return json({ ...txn, parties: await listTransactionParties(ctx.env, txn.id) });
}

export async function handleAddTransactionParty(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = partySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await addTransactionParty(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSubmitTransaction(ctx: RouteContext): Promise<Response> {
  try {
    return json(await submitTransactionForApproval(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

const executeTransactionSchema = z.object({
  approval_receipt_id: z.string().trim().min(1).optional(),
  fund_id: z.string().trim().min(1).optional(),
});

export async function handleExecuteTransaction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = executeTransactionSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await executeTransaction(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.approval_receipt_id, parsed.data.fund_id));
  } catch (err) {
    return errorResponse(err);
  }
}

const voidTransactionSchema = z.object({ approval_receipt_id: z.string().trim().min(1).optional() });

export async function handleVoidTransaction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = voidTransactionSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await voidTransaction(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.approval_receipt_id));
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Position / snapshot / observation handlers ──

export async function handleListPositions(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const fundId = url.searchParams.get("fund_id");
  const clauses = ["1=1"];
  const binds: string[] = [];
  if (companyId) {
    clauses.push(`company_id = ?${binds.length + 1}`);
    binds.push(companyId);
  }
  if (fundId) {
    clauses.push(`fund_id = ?${binds.length + 1}`);
    binds.push(fundId);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM position WHERE ${clauses.join(" AND ")} ORDER BY opened_at, id LIMIT 500`)
    .bind(...binds)
    .all<PositionRow>();
  return json({ positions: rows.results ?? [] });
}

const snapshotSchema = z.object({
  company_id: z.string().trim().min(1),
  fund_id: z.string().trim().min(1),
  as_of_date: z.string().trim().min(1),
  ownership_pct: z.number(),
  fully_diluted_shares: z.number().optional(),
  dilution_assumptions: z.record(z.unknown()).optional(),
  source: z.string().trim().min(1),
});

export async function handleCreateOwnershipSnapshot(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createOwnershipSnapshot(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListOwnershipSnapshots(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const rows = companyId
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM ownership_snapshot WHERE company_id = ?1 ORDER BY as_of_date, id").bind(companyId).all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM ownership_snapshot ORDER BY as_of_date DESC, id LIMIT 500").all();
  return json({ ownership_snapshots: rows.results ?? [] });
}

const observationSchema = z.object({
  company_id: z.string().trim().min(1),
  observation_type: z.enum(PRICING_OBSERVATION_TYPES),
  price_per_share: z.number().optional(),
  implied_valuation: z.number().optional(),
  block_size: z.number().optional(),
  seller_type: z.string().optional(),
  fees: z.number().optional(),
  carry: z.number().optional(),
  observed_at: z.string().trim().min(1),
  source: z.string().trim().min(1),
  privacy_label: privacyLabelSchema.optional(),
});

export async function handleCreatePricingObservation(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = observationSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createPricingObservation(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListPricingObservations(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const companyId = url.searchParams.get("company_id");
  const type = url.searchParams.get("observation_type");
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const clauses = [visibility];
  const binds: string[] = [];
  if (companyId) {
    clauses.push(`company_id = ?${binds.length + 1}`);
    binds.push(companyId);
  }
  if (type) {
    clauses.push(`observation_type = ?${binds.length + 1}`);
    binds.push(type);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM pricing_observation WHERE ${clauses.join(" AND ")} ORDER BY observed_at DESC, id LIMIT 500`)
    .bind(...binds)
    .all();
  return json({ pricing_observations: rows.results ?? [] });
}

// ── Deal math handlers ──

const dealMathPacketSchema = z.object({
  deal_type: z.enum(OPPORTUNITY_TYPES),
  source_inputs: z.record(z.unknown()).optional(),
  assumption_set: z.record(z.unknown()).optional(),
  valuation: z.number().optional(),
  check_size: z.number().optional(),
  ownership_at_close: z.number().optional(),
  expected_exit_ownership: z.number().optional(),
  dilution_assumptions: z.record(z.unknown()).optional(),
  pro_rata_status: z.string().optional(),
  reserve_requirement: z.number().optional(),
  moic: z.number().optional(),
  tvpi: z.number().optional(),
  dpi: z.number().optional(),
  xirr: z.number().optional(),
  fund_contribution: z.number().optional(),
  concentration_impact: z.number().optional(),
  secondary_discount_premium: z.number().optional(),
  margin_of_safety_note: z.string().optional(),
});

export async function handleCreateDealMathPacket(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = dealMathPacketSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createDealMathPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleUpdateDealMathPacket(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = dealMathPacketSchema.partial().omit({ deal_type: true }).safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await updateDealMathPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetDealMathPacket(ctx: RouteContext): Promise<Response> {
  const packet = await getDealMathPacket(ctx.env, ctx.params.id!);
  if (!packet) return json({ error: "not_found" }, { status: 404 });
  const assumptions = await ctx.env.WP_OS_DB.prepare("SELECT * FROM deal_math_assumption WHERE packet_id = ?1 ORDER BY created_at, id").bind(packet.id).all();
  const ledger = await ctx.env.WP_OS_DB.prepare("SELECT * FROM assumption_ledger WHERE packet_id = ?1 ORDER BY created_at, id").bind(packet.id).all();
  return json({ ...packet, assumptions: assumptions.results ?? [], ledger: ledger.results ?? [] });
}

export async function handleCalculateDealMath(ctx: RouteContext): Promise<Response> {
  try {
    return json(await calculateDealMathPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

const reviewDealMathSchema = z.object({ to: z.enum(MATH_QUALITY_STATUSES) });

export async function handleReviewDealMathPacket(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = reviewDealMathSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await reviewDealMathPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to));
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Company 360 handler ──

export async function handleCompany360(ctx: RouteContext): Promise<Response> {
  const view = await getCompany360(ctx.env, ctx.params.id!);
  if (!view) return json({ error: "not_found" }, { status: 404 });
  return json(view);
}

/**
 * Where deals come from (P51, docs/COMMUNITY.md).
 *
 * "The output is not engagement. The output is early inclusion." That sentence rules out the
 * dashboard this would otherwise be — members, attendance, engagement rate — and points at the one
 * measurement that actually tests the community thesis: for each deal, where the relationship
 * started, and how long BEFORE the deal existed.
 *
 * `leadDays` is the whole point. A deal sourced from a Room eleven months before the company
 * incorporated is the community working. The same deal recorded the week it appeared is a
 * coincidence. Averaging them would hide the difference, so both the count and the lead time are
 * reported per origin.
 *
 * `unrecorded` is deliberately prominent. If most deals have no provenance, every number here is
 * unreliable and a reader should know that before drawing a conclusion from the rest.
 */
export async function handleDealProvenance(ctx: RouteContext): Promise<Response> {
  const byOrigin = await ctx.env.WP_OS_DB.prepare(
    `SELECT relationship_origin AS origin,
            COUNT(*) AS deals,
            SUM(CASE WHEN relationship_started_at IS NOT NULL THEN 1 ELSE 0 END) AS dated,
            AVG(CASE WHEN relationship_started_at IS NOT NULL
                     THEN julianday(created_at) - julianday(relationship_started_at) END) AS avg_lead_days
     FROM investment_opportunity
     -- Archived means the record should not exist — a duplicate, a typo, a test. Counting it here
     -- puts a row nobody wants into the firm's own measure of where its deals come from.
     WHERE archived_at IS NULL
     GROUP BY relationship_origin
     ORDER BY deals DESC`,
  ).all<{ origin: string; deals: number; dated: number; avg_lead_days: number | null }>();

  // The backfill queue: deals a person can still remember the answer for. Newest first, because
  // provenance is recoverable for a week and guesswork after a month.
  const unrecorded = await ctx.env.WP_OS_DB.prepare(
    `SELECT o.id, o.title, o.created_at, c.canonical_name AS company
     FROM investment_opportunity o
     LEFT JOIN canonical_company c ON c.id = o.company_id
     WHERE o.relationship_origin = 'UNRECORDED' AND o.archived_at IS NULL
     ORDER BY o.created_at DESC LIMIT 50`,
  ).all();

  const rows = byOrigin.results ?? [];
  const total = rows.reduce((sum, r) => sum + Number(r.deals), 0);
  const unrecordedCount = Number(rows.find((r) => r.origin === "UNRECORDED")?.deals ?? 0);

  return json({
    byOrigin: rows.map((r) => ({
      origin: r.origin,
      deals: Number(r.deals),
      dated: Number(r.dated),
      avgLeadDays: r.avg_lead_days === null ? null : Math.round(r.avg_lead_days),
    })),
    total,
    unrecordedCount,
    unrecorded: unrecorded.results ?? [],
  });
}

/**
 * The dealflow board: every live deal, where it is, and how long it has been there.
 *
 * WHY IT IS ITS OWN ENDPOINT rather than a richer /api/opportunities. The list endpoint answers
 * "what opportunities exist"; the board answers "what needs me". Those want different data — the
 * board needs the LAST TIME EACH DEAL MOVED, which lives in the event spine, and joining that onto
 * every opportunity list would make the cheap query expensive for callers that never look at it.
 *
 * MOVEMENT COMES FROM THE EVENT RECORD, not from created_at. A company that reached diligence
 * yesterday after two months of screening is fresh; dating staleness from creation would paint
 * every hard-won deal red and teach the operator to ignore the colour. Where a deal has never
 * moved — still sitting at NEW — creation IS the last movement, which is the correct reading.
 *
 * A REMOVED RECORD IS OFF THE BOARD, and it was not. `archived_at` (0098) was written by "Remove
 * this record" and read by nothing here, so the row came straight back on the next reload and the
 * control looked broken. Every other list that can show an opportunity already filters it; this one,
 * the most visible of them, did not.
 *
 * A PASS CARRIES ITS REASON THIS FAR. The reason is the whole value of a recorded no, and the board
 * selected every column except that one — so the pass pile could say a company had been declined
 * and never say why, which is the state the reason was added to prevent.
 */
export async function handleDealflowBoard(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "o.privacy_label");

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT o.id, o.title, o.status, o.opportunity_type, o.relationship_origin, o.created_at,
            o.backfilled_at, o.as_of_date, o.placeholder_fields, o.placeholder_note,
            o.price_per_share, o.quantity, o.source_channel, o.exit_reason,
            o.recommendation, o.recommendation_note, o.recommended_by, o.recommended_at,
            c.canonical_name AS company_name, c.id AS company_id,
            (SELECT MAX(e.created_at)
               FROM event_record e
              WHERE e.object_id = o.id
                AND e.event_type IN ('investment.opportunity_transitioned', 'investment.opportunity_backfilled')
            ) AS last_moved_at
       FROM investment_opportunity o
       JOIN canonical_company c ON c.id = o.company_id
      WHERE ${visibility} AND o.archived_at IS NULL
      ORDER BY o.created_at DESC
      LIMIT 500`,
  ).all<Record<string, unknown>>();

  const deals: Array<Record<string, unknown>> = (rows.results ?? []).map((r) => {
    let provisional: string[] = [];
    try {
      provisional = JSON.parse(String(r.placeholder_fields ?? "[]")) as string[];
    } catch {
      provisional = [];
    }
    return {
      ...r,
      // Never moved means it is still where it started, and creation is when that began.
      in_stage_since: (r.last_moved_at as string | null) ?? (r.created_at as string),
      placeholder_fields: provisional,
      backfilled: Boolean(r.backfilled_at),
      /*
       * Arrived by email and nobody has looked at it yet.
       *
       * Operator: machine-filed deals should be "distinguishable at a glance from ones you entered,
       * and a junk one is one press to dismiss." Derived rather than stored: an emailed deal that
       * has never moved off NEW is, by definition, one nobody has acted on — and the moment somebody
       * transitions it the flag goes away on its own. A stored "reviewed" boolean would be one more
       * thing that can disagree with what actually happened.
       */
      arrived_by_email: String(r.source_channel ?? "").startsWith("email:"),
      unreviewed: String(r.source_channel ?? "").startsWith("email:") && r.status === "NEW" && !r.last_moved_at,
    };
  });

  const counts: Record<string, number> = {};
  for (const d of deals) counts[String(d.status)] = (counts[String(d.status)] ?? 0) + 1;

  /*
   * WHAT IS WAITING ON A PERSON, on the board itself (design/DEALS_SECTION_DESIGN.md §4).
   *
   * A meeting can PROPOSE a stage move (Phase B, `meeting_stage_proposal`), and until 18 Sep 2026
   * that proposal surfaced only on the meeting's own After face — so the one page built around
   * "where every company stands" never said that a move was waiting for a click. Folded into this
   * response rather than given a route of its own: the rows and the proposals are read under the
   * same visibility clause, so a proposal can never be shown for a deal the reader may not see.
   * Accepting one is the existing `POST /api/meeting-stage-proposals/:id/decide`; nothing here
   * writes.
   */
  const proposalRows = await ctx.env.WP_OS_DB.prepare(
    `SELECT p.id, p.meeting_id, m.title AS meeting_title, m.occurred_at, m.scheduled_at,
            p.opportunity_id, p.from_status, p.to_status, p.rationale, p.created_at,
            p.proposed_by_type, p.proposed_by_id,
            c.canonical_name AS company_name, c.id AS company_id
       FROM meeting_stage_proposal p
       JOIN investment_opportunity o ON o.id = p.opportunity_id
       JOIN canonical_company c ON c.id = o.company_id
       JOIN meeting m ON m.id = p.meeting_id
      WHERE p.state = 'PROPOSED' AND ${visibility} AND o.archived_at IS NULL
      ORDER BY p.created_at DESC
      LIMIT 50`,
  ).all<Record<string, unknown>>();
  const proposals: Array<Record<string, unknown>> = [];
  for (const r of proposalRows.results ?? []) {
    // A name, never an id: the proposer is on one of two rosters and the row says which.
    const kind = String(r.proposed_by_type ?? "");
    const id = String(r.proposed_by_id ?? "");
    let proposed_by = "Somebody";
    if (kind === "AI") {
      const row = await ctx.env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1 OR name = ?1").bind(id).first<{ name: string }>();
      proposed_by = row?.name ?? "An employee whose seat has since been removed";
    } else if (kind === "HUMAN") {
      const row = await ctx.env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1").bind(id).first<{ full_name: string }>();
      proposed_by = row?.full_name ?? "Somebody who has since left the firm";
    } else {
      proposed_by = "The system";
    }
    const { proposed_by_type: _t, proposed_by_id: _i, ...rest } = r;
    proposals.push({ ...rest, proposed_by, meeting_at: (r.occurred_at as string | null) ?? (r.scheduled_at as string | null) });
  }

  return json({
    deals,
    counts,
    proposals,
    /** Stated so the board never has to explain its own colour in prose. */
    how_staleness_works:
      "A deal is stalled when it has sat in one stage longer than that stage allows. Each stage has " +
      "its own clock, because a week unscreened and a week in diligence are not the same problem. " +
      "The clock starts when the deal last MOVED, not when it was created.",
  });
}

/*
 * `handlePortfolioComposition` lived here until 18 Sep 2026 and read CLOSED opportunities on its
 * own, while Portfolio read `position` on its own — two portfolios. Both now read
 * `services/portfolioHoldings.ts`.
 */

// ── An employee's view on a deal ──

const recommendationSchema = z.object({
  recommendation: z.enum(["PASS", "LOOK_CLOSER"]).nullable(),
  note: z.string().trim().min(1).max(600).optional(),
  by: z.string().trim().min(1).max(60).optional(),
});

/**
 * Record what an employee thinks should happen to a deal, without it happening.
 *
 * Operator rule: "every arrival survives until i've seen it but it comes with a recommendation to
 * scrap it... never scrap our inbound stuff without our input."
 *
 * THE EASIER IMPLEMENTATION WAS THE WRONG ONE. Letting the analyst pass a deal outright is a single
 * transition and no schema — but a passed deal has LEFT the funnel, so seeing what was turned away
 * becomes something a partner has to remember to go and look for, and the thing you forget to look
 * at is the thing decided by nobody. This keeps the deal where they are already looking, carrying
 * the view and the reason, with the decision still one press either way.
 *
 * IT MOVES NOTHING. Status is untouched: a recommendation is not a state, and the transition it
 * argues for stays the separate, already-governed act.
 */
export async function handleRecommendOpportunity(ctx: RouteContext): Promise<Response> {
  const parsed = recommendationSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "opportunity.recommend", {
    objectType: "investment_opportunity",
    objectId: ctx.params.id!,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const existing = await ctx.env.WP_OS_DB.prepare("SELECT id, status FROM investment_opportunity WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ id: string; status: string }>();
  if (!existing) return json({ error: "not_found" }, { status: 404 });

  const by = parsed.data.by ?? actor.aiEmployeeId ?? "a partner";
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE investment_opportunity
        SET recommendation = ?2, recommendation_note = ?3, recommended_by = ?4,
            recommended_at = CASE WHEN ?2 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
      WHERE id = ?1`,
  )
    .bind(ctx.params.id!, parsed.data.recommendation, parsed.data.note ?? null, parsed.data.recommendation === null ? null : by)
    .run();

  await appendEvent(ctx.env, {
    eventType: parsed.data.recommendation === null ? "investment.recommendation_cleared" : "investment.recommended",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "investment_opportunity",
    objectId: ctx.params.id!,
    payload: { recommendation: parsed.data.recommendation, note: parsed.data.note ?? null, by },
  });

  return json({ ok: true, recommendation: parsed.data.recommendation, by });
}
