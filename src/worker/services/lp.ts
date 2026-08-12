import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, decideApproval, requestApproval } from "./approvals";

/**
 * LP, fundraising, claims, and data-room control (P10).
 *
 * Law (plan §8/P10 + §15):
 * - An LP-facing claim CANNOT be published without (a) at least one linked evidence
 *   item that is itself approved/verified, and (b) an approved
 *   `lp_marketing_claim.approve` receipt (MP or compliance), consumed on publish.
 *   Both conditions are checked in the service, so no route can bypass them.
 * - AI may DRAFT claims (with its run trace). An AI can never submit, approve, or
 *   publish one, and can never make an LP promise or commitment.
 * - Sharing material is a human-gated act behind `lp_sensitive_communication.send`:
 *   every grant records recipient, artifact VERSION, permission, time, and expiry,
 *   and lives in an append-only ledger with append-only revocations.
 * - There is NO automated LP outreach and no native VDR: the data room stays
 *   external (provider_ref), and West Peek OS never serves artifact bytes on an LP
 *   route. Any actual send still goes through the P3 external-effect route.
 * - Nothing here asserts securities-law, marketing, or compliance sufficiency (D12,
 *   §12.4) — live LP use remains a counsel/compliance gate.
 */

export class LpError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const LP_TYPES = ["INDIVIDUAL", "FAMILY_OFFICE", "INSTITUTION", "FUND_OF_FUNDS", "CORPORATE", "OTHER"] as const;
export const LP_STATUSES = ["PROSPECT", "ENGAGED", "COMMITTED", "DECLINED", "CLOSED"] as const;
export const LP_STAGES = ["INTRODUCED", "MATERIALS_SHARED", "DILIGENCE", "TERMS", "COMMITTED", "PASSED", "WITHDRAWN"] as const;
export const LP_CLAIM_TYPES = ["TRACK_RECORD", "STRATEGY", "TEAM", "PORTFOLIO", "PROCESS", "OTHER"] as const;
export const LP_EVIDENCE_TYPES = ["DILIGENCE_CLAIM", "KNOWLEDGE_RECORD", "DOCUMENT"] as const;
export const DATA_ROOM_PERMISSIONS = ["VIEW", "DOWNLOAD"] as const;

/** Stage transitions. PASSED/WITHDRAWN are terminal. */
const STAGE_TRANSITIONS: Readonly<Record<(typeof LP_STAGES)[number], readonly (typeof LP_STAGES)[number][]>> = {
  INTRODUCED: ["MATERIALS_SHARED", "PASSED", "WITHDRAWN"],
  MATERIALS_SHARED: ["DILIGENCE", "PASSED", "WITHDRAWN"],
  DILIGENCE: ["TERMS", "PASSED", "WITHDRAWN"],
  TERMS: ["COMMITTED", "PASSED", "WITHDRAWN"],
  COMMITTED: [],
  PASSED: [],
  WITHDRAWN: [],
};

export interface LpClaimRow {
  id: string;
  claim_text: string;
  claim_type: string;
  status: string;
  drafted_by_type: "HUMAN" | "AI";
  drafted_by_id: string;
  ai_run_id: string | null;
  approval_card_id: string | null;
  published_at: string | null;
  privacy_label: string;
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
  if (authz.decision === "DENY") throw new LpError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new LpError(409, "approval_required", authz.reason);
}

// ── LP records, opportunities, diligence requests ──

export async function createLpRecord(
  env: Env,
  actor: Actor,
  input: { legal_name: string; lp_type: (typeof LP_TYPES)[number]; relationship_owner?: string; contacts?: Array<{ contact_label: string; network_external_id?: string; contact_role?: string }> },
) {
  await mustAuthorize(env, actor, "lp_record.create", "lp_record");
  const id = `lpr_${crypto.randomUUID()}`;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_record (id, legal_name, lp_type, relationship_owner, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, input.legal_name, input.lp_type, input.relationship_owner ?? null, firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  for (const contact of input.contacts ?? []) {
    // Contacts are LINKS into Network OS truth, never a duplicate contact record (D5).
    await env.WP_OS_DB.prepare(
      "INSERT INTO lp_contact_link (id, lp_record_id, network_external_id, contact_label, contact_role, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(`lcl_${crypto.randomUUID()}`, id, contact.network_external_id ?? null, contact.contact_label, contact.contact_role ?? null, firmScope)
      .run();
  }
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "lp.record_created",
    actorType,
    actorId,
    objectType: "lp_record",
    objectId: id,
    firmScope,
    payload: { lp_type: input.lp_type },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM lp_record WHERE id = ?1").bind(id).first();
}

export async function createLpOpportunity(
  env: Env,
  actor: Actor,
  input: { lp_record_id: string; fund_id?: string; target_commitment?: number; notes?: string },
) {
  const lp = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM lp_record WHERE id = ?1").bind(input.lp_record_id).first<{ id: string; firm_scope: string }>();
  if (!lp) throw new LpError(400, "unknown_lp_record", `lp_record '${input.lp_record_id}' does not exist`);
  await mustAuthorize(env, actor, "lp_opportunity.create", "lp_opportunity", undefined, lp.firm_scope);
  const id = `lpo_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_opportunity (id, lp_record_id, fund_id, target_commitment, notes, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, input.lp_record_id, input.fund_id ?? null, input.target_commitment ?? null, input.notes ?? null, lp.firm_scope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "lp.opportunity_created",
    actorType,
    actorId,
    objectType: "lp_opportunity",
    objectId: id,
    firmScope: lp.firm_scope,
    payload: { lp_record_id: input.lp_record_id, fund_id: input.fund_id ?? null },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM lp_opportunity WHERE id = ?1").bind(id).first();
}

export async function transitionLpOpportunity(env: Env, actor: Actor, id: string, to: (typeof LP_STAGES)[number]) {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM lp_opportunity WHERE id = ?1").bind(id).first<{ id: string; stage: (typeof LP_STAGES)[number]; firm_scope: string }>();
  if (!row) throw new LpError(404, "not_found");
  await mustAuthorize(env, actor, "lp_opportunity.transition", "lp_opportunity", id, row.firm_scope);
  if (!STAGE_TRANSITIONS[row.stage].includes(to)) {
    throw new LpError(409, "illegal_transition", `LP opportunity cannot move ${row.stage} → ${to}`);
  }
  await env.WP_OS_DB.prepare("UPDATE lp_opportunity SET stage = ?2 WHERE id = ?1").bind(id, to).run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "lp.opportunity_transitioned",
    actorType,
    actorId,
    objectType: "lp_opportunity",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { from: row.stage, to },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM lp_opportunity WHERE id = ?1").bind(id).first();
}

export async function createDiligenceRequest(
  env: Env,
  actor: Actor,
  opportunityId: string,
  input: { request_text: string; requested_at: string; due_date?: string },
) {
  const opportunity = await env.WP_OS_DB.prepare("SELECT id, firm_scope FROM lp_opportunity WHERE id = ?1").bind(opportunityId).first<{ id: string; firm_scope: string }>();
  if (!opportunity) throw new LpError(404, "not_found");
  await mustAuthorize(env, actor, "lp_diligence_request.create", "lp_diligence_request", opportunityId, opportunity.firm_scope);
  const id = `lpd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_diligence_request (id, lp_opportunity_id, request_text, requested_at, due_date, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, opportunityId, input.request_text, input.requested_at, input.due_date ?? null, opportunity.firm_scope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM lp_diligence_request WHERE id = ?1").bind(id).first();
}

export async function respondToDiligenceRequest(env: Env, actor: Actor, requestId: string, note: string) {
  const request = await env.WP_OS_DB.prepare("SELECT * FROM lp_diligence_request WHERE id = ?1").bind(requestId).first<{ id: string; status: string; firm_scope: string }>();
  if (!request) throw new LpError(404, "not_found");
  if (actor.type !== "HUMAN") throw new LpError(403, "forbidden", "an LP-facing response is recorded by a human");
  await mustAuthorize(env, actor, "lp_diligence_request.respond", "lp_diligence_request", requestId, request.firm_scope);
  if (request.status !== "OPEN") throw new LpError(409, "already_answered");
  await env.WP_OS_DB.prepare(
    "UPDATE lp_diligence_request SET status = 'ANSWERED', response_note = ?2, responded_by = ?3, responded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(requestId, note, actor.firmUserId!)
    .run();
  await appendEvent(env, {
    eventType: "lp.diligence_answered",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_diligence_request",
    objectId: requestId,
    firmScope: request.firm_scope,
    payload: {},
  });
  return env.WP_OS_DB.prepare("SELECT * FROM lp_diligence_request WHERE id = ?1").bind(requestId).first();
}

// ── LP claims ──

export async function getLpClaim(env: Env, id: string): Promise<LpClaimRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM lp_claim WHERE id = ?1").bind(id).first<LpClaimRow>();
}

export async function draftLpClaim(
  env: Env,
  actor: Actor,
  input: { claim_text: string; claim_type: (typeof LP_CLAIM_TYPES)[number]; ai_run_id?: string },
): Promise<LpClaimRow> {
  await mustAuthorize(env, actor, "lp_claim.draft", "lp_claim");
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new LpError(400, "invalid_input", "an AI-drafted LP claim must record its ai_run_id (run_ai trace)");
  }
  const id = `lpc_${crypto.randomUUID()}`;
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_claim (id, claim_text, claim_type, drafted_by_type, drafted_by_id, ai_run_id, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, input.claim_text, input.claim_type, actor.type === "AI" ? "AI" : "HUMAN", actorId, input.ai_run_id ?? null, firmScope)
    .run();
  await appendEvent(env, {
    eventType: "lp.claim_drafted",
    actorType,
    actorId,
    objectType: "lp_claim",
    objectId: id,
    firmScope,
    payload: { claim_type: input.claim_type, drafted_by_type: actor.type === "AI" ? "AI" : "HUMAN" },
  });
  return (await getLpClaim(env, id))!;
}

export interface EvidenceCheck {
  evidence_type: string;
  evidence_ref_id: string;
  approved: boolean;
  reason: string;
}

/**
 * An evidence item counts only if it is APPROVED in its own subsystem:
 * a diligence claim must be VERIFIED (P5's self-promotion ban applies there),
 * a knowledge record must be current (it only exists behind an approved promotion),
 * a document must exist in the governed store.
 */
export async function checkEvidence(env: Env, evidenceType: string, refId: string): Promise<EvidenceCheck> {
  if (evidenceType === "DILIGENCE_CLAIM") {
    const row = await env.WP_OS_DB.prepare("SELECT claim_status, superseded_by FROM diligence_claim WHERE id = ?1")
      .bind(refId)
      .first<{ claim_status: string; superseded_by: string | null }>();
    if (!row) return { evidence_type: evidenceType, evidence_ref_id: refId, approved: false, reason: "diligence_claim_not_found" };
    // A superseded claim stays VERIFIED and readable (P5 keeps the chain), but it is
    // no longer current, so it can no longer substantiate an LP-facing statement.
    if (row.superseded_by) {
      return { evidence_type: evidenceType, evidence_ref_id: refId, approved: false, reason: `superseded_by:${row.superseded_by}` };
    }
    return {
      evidence_type: evidenceType,
      evidence_ref_id: refId,
      approved: row.claim_status === "VERIFIED",
      reason: row.claim_status === "VERIFIED" ? "verified" : `claim_status:${row.claim_status}`,
    };
  }
  if (evidenceType === "KNOWLEDGE_RECORD") {
    const row = await env.WP_OS_DB.prepare("SELECT id, superseded_by FROM knowledge_record WHERE id = ?1").bind(refId).first<{ id: string; superseded_by: string | null }>();
    if (!row) return { evidence_type: evidenceType, evidence_ref_id: refId, approved: false, reason: "knowledge_record_not_found" };
    return {
      evidence_type: evidenceType,
      evidence_ref_id: refId,
      approved: row.superseded_by === null,
      reason: row.superseded_by === null ? "current_knowledge_record" : "superseded",
    };
  }
  const doc = await env.WP_OS_DB.prepare("SELECT id FROM document WHERE id = ?1").bind(refId).first();
  return {
    evidence_type: evidenceType,
    evidence_ref_id: refId,
    approved: Boolean(doc),
    reason: doc ? "governed_document" : "document_not_found",
  };
}

export async function linkEvidence(
  env: Env,
  actor: Actor,
  claimId: string,
  input: { evidence_type: (typeof LP_EVIDENCE_TYPES)[number]; evidence_ref_id: string; note?: string },
) {
  const claim = await getLpClaim(env, claimId);
  if (!claim) throw new LpError(404, "not_found");
  await mustAuthorize(env, actor, "lp_claim.link_evidence", "lp_claim_evidence", claimId, claim.firm_scope);
  if (claim.status === "PUBLISHED") throw new LpError(409, "already_published", "a published claim's evidence set is frozen");
  const check = await checkEvidence(env, input.evidence_type, input.evidence_ref_id);
  if (check.reason.endsWith("_not_found")) throw new LpError(400, "unknown_evidence", check.reason);
  const id = `lce_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO lp_claim_evidence (id, lp_claim_id, evidence_type, evidence_ref_id, note, linked_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, claimId, input.evidence_type, input.evidence_ref_id, input.note ?? null, actor.firmUserId ?? actor.aiEmployeeId ?? "system", claim.firm_scope)
    .run();
  return { id, ...check };
}

export async function evidenceStatus(env: Env, claimId: string): Promise<{ items: EvidenceCheck[]; substantiated: boolean }> {
  const rows = await env.WP_OS_DB.prepare("SELECT evidence_type, evidence_ref_id FROM lp_claim_evidence WHERE lp_claim_id = ?1 ORDER BY created_at, id")
    .bind(claimId)
    .all<{ evidence_type: string; evidence_ref_id: string }>();
  const items: EvidenceCheck[] = [];
  for (const row of rows.results ?? []) items.push(await checkEvidence(env, row.evidence_type, row.evidence_ref_id));
  return { items, substantiated: items.length > 0 && items.every((i) => i.approved) };
}

/** DRAFT → PENDING_REVIEW, creating the reserved marketing-claim approval card. */
export async function submitLpClaim(env: Env, actor: Actor, claimId: string): Promise<{ claim: LpClaimRow; approval_card_id: string }> {
  const claim = await getLpClaim(env, claimId);
  if (!claim) throw new LpError(404, "not_found");
  if (actor.type !== "HUMAN") throw new LpError(403, "forbidden", "an AI can never submit an LP claim for approval");
  await mustAuthorize(env, actor, "lp_claim.submit", "lp_claim", claimId, claim.firm_scope);
  if (claim.status !== "DRAFT" && claim.status !== "REJECTED") {
    // A reviewer can refuse through `rejectLpClaim`, which sets REJECTED — but they
    // can equally refuse the CARD on the generic Approvals surface, which is what a
    // reviewer actually looks at and which knows nothing about lp_claim. Treat the
    // card's own negative disposition as the authority on whether review is over,
    // so the claim is revisable however the refusal was expressed. Anything else
    // strands the claim: PENDING_REVIEW forever, unpublishable and unresubmittable.
    const card = claim.approval_card_id
      ? await env.WP_OS_DB.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(claim.approval_card_id).first<{ state: string }>()
      : null;
    const reviewIsOver = card?.state === "rejected" || card?.state === "revise_requested";
    if (claim.status !== "PENDING_REVIEW" || !reviewIsOver) {
      throw new LpError(409, "illegal_state", `claim is ${claim.status}${card ? ` (approval card ${card.state})` : ""}`);
    }
  }

  const evidence = await evidenceStatus(env, claimId);
  if (!evidence.substantiated) {
    // Unsubstantiated claims never even reach a reviewer.
    throw new LpError(409, "unsubstantiated_claim", `every LP claim needs approved evidence: ${JSON.stringify(evidence.items.map((i) => i.reason))}`);
  }

  const card = await requestApproval(env, actor, {
    action_key: "lp_marketing_claim.approve",
    object_type: "lp_claim",
    object_id: claimId,
    title: `lp_marketing_claim.approve: ${claim.claim_text.slice(0, 80)}`,
    summary: `${evidence.items.length} approved evidence item(s) linked`,
    payload: { lp_claim_id: claimId, evidence: evidence.items },
    firm_scope: claim.firm_scope,
    submit: true,
  });
  await env.WP_OS_DB.prepare("UPDATE lp_claim SET status = 'PENDING_REVIEW', approval_card_id = ?2 WHERE id = ?1").bind(claimId, card.id).run();
  await appendEvent(env, {
    eventType: "lp.claim_submitted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
    payload: { approval_card_id: card.id, evidence_count: evidence.items.length },
  });
  return { claim: (await getLpClaim(env, claimId))!, approval_card_id: card.id };
}

/**
 * The negative disposition of a marketing-claim review (P6 precedent, ADR-011/ic.ts):
 * a reviewer who will not approve the language must be able to SAY so, or the claim
 * sits in PENDING_REVIEW forever — unpublishable for want of an approved receipt and
 * unrevisable because submit only accepts DRAFT/REJECTED. REJECT resolves the pending
 * card and returns the claim to REJECTED, which `submitLpClaim` already accepts, so
 * the language can be revised and re-reviewed. No receipt is required to refuse:
 * declining to authorise is not itself a reserved act, but it does need the role.
 */
export async function rejectLpClaim(env: Env, actor: Actor, claimId: string, reason: string): Promise<LpClaimRow> {
  const claim = await getLpClaim(env, claimId);
  if (!claim) throw new LpError(404, "not_found");
  if (actor.type !== "HUMAN") throw new LpError(403, "forbidden", "an AI can never decide an LP marketing claim");
  if (claim.status !== "PENDING_REVIEW") throw new LpError(409, "illegal_state", `claim is ${claim.status}`);

  // Same role test as an approval: authorize() DENYs anyone who could not have approved.
  const authz = await authorize(env, actor, "lp_marketing_claim.approve", {
    objectType: "lp_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
  });
  if (authz.decision === "DENY") throw new LpError(403, "forbidden", authz.reason);

  // Resolve the pending card so no approval is left dangling for a rejected claim.
  const card = await env.WP_OS_DB.prepare(
    `SELECT id, state FROM approval_card
      WHERE action_key = 'lp_marketing_claim.approve' AND object_type = 'lp_claim' AND object_id = ?1
      ORDER BY created_at DESC, id LIMIT 1`,
  )
    .bind(claimId)
    .first<{ id: string; state: string }>();
  if (card && card.state === "pending_review") {
    await decideApproval(env, actor, card.id, "rejected", reason);
  }

  await env.WP_OS_DB.prepare("UPDATE lp_claim SET status = 'REJECTED' WHERE id = ?1").bind(claimId).run();
  await appendEvent(env, {
    eventType: "lp.claim_rejected",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
    payload: { reason, approval_card_id: card?.id ?? null },
  });
  return (await getLpClaim(env, claimId))!;
}

/**
 * Publish. Requires BOTH gates at publish time: the receipt, and evidence that is
 * still approved (evidence can decay between review and publication).
 */
export async function publishLpClaim(env: Env, actor: Actor, claimId: string, receiptId?: string): Promise<LpClaimRow> {
  const claim = await getLpClaim(env, claimId);
  if (!claim) throw new LpError(404, "not_found");
  const authz = await authorize(
    env,
    actor,
    "lp_marketing_claim.approve",
    { objectType: "lp_claim", objectId: claimId, firmScope: claim.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new LpError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") throw new LpError(409, "approval_required", authz.reason);
  if (claim.status === "PUBLISHED") throw new LpError(409, "already_published");

  const evidence = await evidenceStatus(env, claimId);
  if (!evidence.substantiated) {
    throw new LpError(409, "unsubstantiated_claim", "evidence is no longer approved; publication refused");
  }

  await env.WP_OS_DB.prepare("UPDATE lp_claim SET status = 'PUBLISHED', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(claimId).run();
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "lp.claim_published",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "lp_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
    payload: { receipt_id: authz.receiptId ?? null, evidence_count: evidence.items.length },
  });
  return (await getLpClaim(env, claimId))!;
}

// ── Data room ──

export async function createArtifact(
  env: Env,
  actor: Actor,
  input: { title: string; version?: number; document_id?: string; provider_ref?: string; lp_claim_ids?: string[]; status?: "DRAFT" | "READY" },
) {
  await mustAuthorize(env, actor, "data_room_artifact.create", "data_room_artifact");
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  // Only PUBLISHED claims may be attached to material that leaves the building.
  for (const claimId of input.lp_claim_ids ?? []) {
    const claim = await getLpClaim(env, claimId);
    if (!claim) throw new LpError(400, "unknown_lp_claim", `lp_claim '${claimId}' does not exist`);
    if (claim.status !== "PUBLISHED") {
      throw new LpError(409, "unpublished_claim", `lp_claim '${claimId}' is ${claim.status}; only PUBLISHED claims may appear in shared material`);
    }
  }
  const id = `dra_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO data_room_artifact (id, title, version, document_id, provider_ref, lp_claim_ids_json, status, firm_scope, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      id,
      input.title,
      input.version ?? 1,
      input.document_id ?? null,
      input.provider_ref ?? null,
      JSON.stringify(input.lp_claim_ids ?? []),
      input.status ?? "DRAFT",
      firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  return env.WP_OS_DB.prepare("SELECT * FROM data_room_artifact WHERE id = ?1").bind(id).first();
}

/**
 * Grant recorded access to a specific artifact VERSION. Requires an approved
 * `lp_sensitive_communication.send` receipt (consumed here). This records the grant;
 * the external VDR performs the delivery.
 */
export async function grantAccess(
  env: Env,
  actor: Actor,
  input: {
    artifact_id: string;
    recipient_label: string;
    permission: (typeof DATA_ROOM_PERMISSIONS)[number];
    lp_record_id?: string;
    recipient_ref?: string;
    expires_at?: string;
    external_vdr_ref?: string;
    approval_receipt_id?: string;
  },
) {
  const artifact = await env.WP_OS_DB.prepare("SELECT * FROM data_room_artifact WHERE id = ?1").bind(input.artifact_id).first<{
    id: string;
    version: number;
    status: string;
    firm_scope: string;
  }>();
  if (!artifact) throw new LpError(404, "not_found");
  const authz = await authorize(
    env,
    actor,
    "lp_sensitive_communication.send",
    { objectType: "data_room_artifact", objectId: input.artifact_id, firmScope: artifact.firm_scope },
    { receiptId: input.approval_receipt_id },
  );
  if (authz.decision === "DENY") throw new LpError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") throw new LpError(409, "approval_required", authz.reason);
  if (artifact.status !== "READY") throw new LpError(409, "artifact_not_ready", `artifact is ${artifact.status}; only READY material may be shared`);

  const id = `dar_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO data_room_access_record
       (id, artifact_id, artifact_version, lp_record_id, recipient_label, recipient_ref, permission, granted_by, expires_at, approval_card_id, external_vdr_ref, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      artifact.id,
      artifact.version,
      input.lp_record_id ?? null,
      input.recipient_label,
      input.recipient_ref ?? null,
      input.permission,
      actor.firmUserId!,
      input.expires_at ?? null,
      authz.receiptId!,
      input.external_vdr_ref ?? null,
      artifact.firm_scope,
    )
    .run();
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "lp.data_room_access_granted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "data_room_access_record",
    objectId: id,
    firmScope: artifact.firm_scope,
    payload: {
      artifact_id: artifact.id,
      artifact_version: artifact.version,
      recipient_label: input.recipient_label,
      permission: input.permission,
      expires_at: input.expires_at ?? null,
      receipt_id: authz.receiptId ?? null,
    },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM data_room_access_record WHERE id = ?1").bind(id).first();
}

export async function revokeAccess(env: Env, actor: Actor, accessRecordId: string, reason: string) {
  const record = await env.WP_OS_DB.prepare("SELECT * FROM data_room_access_record WHERE id = ?1").bind(accessRecordId).first<{ id: string; firm_scope: string }>();
  if (!record) throw new LpError(404, "not_found");
  if (actor.type !== "HUMAN") throw new LpError(403, "forbidden", "revocation is a human act");
  await mustAuthorize(env, actor, "data_room_access.revoke", "data_room_access_record", accessRecordId, record.firm_scope);
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM data_room_revocation WHERE access_record_id = ?1").bind(accessRecordId).first();
  if (existing) throw new LpError(409, "already_revoked");
  const id = `drv_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare("INSERT INTO data_room_revocation (id, access_record_id, reason, revoked_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, accessRecordId, reason, actor.firmUserId!, record.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "lp.data_room_access_revoked",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "data_room_revocation",
    objectId: id,
    firmScope: record.firm_scope,
    payload: { access_record_id: accessRecordId, reason },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM data_room_revocation WHERE id = ?1").bind(id).first();
}

export interface AccessLedgerRow {
  id: string;
  artifact_id: string;
  artifact_version: number;
  recipient_label: string;
  permission: string;
  granted_by: string;
  granted_at: string;
  expires_at: string | null;
  approval_card_id: string;
  effective_status: "ACTIVE" | "EXPIRED" | "REVOKED";
  revoked_at?: string;
  revocation_reason?: string;
}

/** The access ledger with each grant's effective status computed at read time. */
export async function accessLedger(env: Env, now = new Date()): Promise<AccessLedgerRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT a.*, r.revoked_at AS revoked_at, r.reason AS revocation_reason
       FROM data_room_access_record a
       LEFT JOIN data_room_revocation r ON r.access_record_id = a.id
      ORDER BY a.granted_at DESC, a.id`,
  ).all<AccessLedgerRow & { revoked_at: string | null; revocation_reason: string | null }>();
  return (rows.results ?? []).map((row) => ({
    ...row,
    effective_status: row.revoked_at ? "REVOKED" : row.expires_at && new Date(row.expires_at) <= now ? "EXPIRED" : "ACTIVE",
  }));
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
  if (err instanceof LpError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const lpRecordSchema = z.object({
  legal_name: z.string().trim().min(1),
  lp_type: z.enum(LP_TYPES),
  relationship_owner: z.string().optional(),
  contacts: z
    .array(z.object({ contact_label: z.string().trim().min(1), network_external_id: z.string().optional(), contact_role: z.string().optional() }))
    .optional(),
});

export async function handleCreateLpRecord(ctx: RouteContext): Promise<Response> {
  const parsed = lpRecordSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createLpRecord(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListLpRecords(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM lp_record WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 500`).all();
  return json({ lp_records: rows.results ?? [] });
}

export async function handleGetLpRecord(ctx: RouteContext): Promise<Response> {
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM lp_record WHERE id = ?1").bind(ctx.params.id!).first<{ id: string; privacy_label: string }>();
  if (!row || !canAccessPrivacyLabel(ctx.identity!, row.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  const contacts = await ctx.env.WP_OS_DB.prepare("SELECT * FROM lp_contact_link WHERE lp_record_id = ?1 ORDER BY created_at, id").bind(row.id).all();
  const opportunities = await ctx.env.WP_OS_DB.prepare("SELECT * FROM lp_opportunity WHERE lp_record_id = ?1 ORDER BY created_at, id").bind(row.id).all();
  return json({ ...row, contacts: contacts.results ?? [], opportunities: opportunities.results ?? [] });
}

const lpOpportunitySchema = z.object({
  lp_record_id: z.string().trim().min(1),
  fund_id: z.string().optional(),
  target_commitment: z.number().optional(),
  notes: z.string().optional(),
});

export async function handleCreateLpOpportunity(ctx: RouteContext): Promise<Response> {
  const parsed = lpOpportunitySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createLpOpportunity(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleTransitionLpOpportunity(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ to: z.enum(LP_STAGES) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await transitionLpOpportunity(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.to));
  } catch (err) {
    return errorResponse(err);
  }
}

const diligenceSchema = z.object({ request_text: z.string().trim().min(1), requested_at: z.string().trim().min(1), due_date: z.string().optional() });

export async function handleCreateDiligenceRequest(ctx: RouteContext): Promise<Response> {
  const parsed = diligenceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createDiligenceRequest(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRespondDiligenceRequest(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ response_note: z.string().trim().min(1) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await respondToDiligenceRequest(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.response_note));
  } catch (err) {
    return errorResponse(err);
  }
}

const claimSchema = z.object({ claim_text: z.string().trim().min(1), claim_type: z.enum(LP_CLAIM_TYPES) });

export async function handleDraftLpClaim(ctx: RouteContext): Promise<Response> {
  const parsed = claimSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await draftLpClaim(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListLpClaims(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM lp_claim WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 500`).all();
  return json({ lp_claims: rows.results ?? [] });
}

export async function handleGetLpClaim(ctx: RouteContext): Promise<Response> {
  const claim = await getLpClaim(ctx.env, ctx.params.id!);
  if (!claim || !canAccessPrivacyLabel(ctx.identity!, claim.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  return json({ ...claim, evidence: await evidenceStatus(ctx.env, claim.id) });
}

const evidenceSchema = z.object({ evidence_type: z.enum(LP_EVIDENCE_TYPES), evidence_ref_id: z.string().trim().min(1), note: z.string().optional() });

export async function handleLinkEvidence(ctx: RouteContext): Promise<Response> {
  const parsed = evidenceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await linkEvidence(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSubmitLpClaim(ctx: RouteContext): Promise<Response> {
  try {
    return json(await submitLpClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRejectLpClaim(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ reason: z.string().trim().min(1) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await rejectLpClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.reason));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handlePublishLpClaim(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ approval_receipt_id: z.string().trim().min(1).optional() }).safeParse((await parseJsonBody(ctx.request)) ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await publishLpClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.approval_receipt_id));
  } catch (err) {
    return errorResponse(err);
  }
}

const artifactSchema = z.object({
  title: z.string().trim().min(1),
  version: z.number().int().positive().optional(),
  document_id: z.string().optional(),
  provider_ref: z.string().optional(),
  lp_claim_ids: z.array(z.string()).optional(),
  status: z.enum(["DRAFT", "READY"]).optional(),
});

export async function handleCreateArtifact(ctx: RouteContext): Promise<Response> {
  const parsed = artifactSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createArtifact(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListArtifacts(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM data_room_artifact ORDER BY title, version").all();
  return json({
    artifacts: rows.results ?? [],
    vdr_state: "EXTERNAL VDR UNPROVEN — PROVIDER NOT SELECTED (West Peek OS records access; it never serves data-room bytes)",
  });
}

const grantSchema = z.object({
  artifact_id: z.string().trim().min(1),
  recipient_label: z.string().trim().min(1),
  permission: z.enum(DATA_ROOM_PERMISSIONS),
  lp_record_id: z.string().optional(),
  recipient_ref: z.string().optional(),
  expires_at: z.string().optional(),
  external_vdr_ref: z.string().optional(),
  approval_receipt_id: z.string().optional(),
});

export async function handleGrantAccess(ctx: RouteContext): Promise<Response> {
  const parsed = grantSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await grantAccess(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRevokeAccess(ctx: RouteContext): Promise<Response> {
  const parsed = z.object({ reason: z.string().trim().min(1) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await revokeAccess(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.reason), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAccessLedger(ctx: RouteContext): Promise<Response> {
  return json({ access_records: await accessLedger(ctx.env) });
}
