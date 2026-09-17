import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, requestApproval } from "./approvals";
import { runAi, type AIRunRow, type RunAiDeps } from "../ai/runAi";
import { getDocumentVersion } from "./documents";
import { privacyLabelSchema, type PrivacyLabel } from "../../shared/privacy";

/**
 * Evidence/provenance substrate (P5, D16): diligence claims with mandatory source
 * provenance, contradictions, knowledge promotion, and source-of-truth resolution.
 *
 * SELF-PROMOTION BAN (structural — no code path can flip it):
 *   A claim whose extractor is AI, or whose only sources are
 *   MODEL_OUTPUT/TRANSCRIPT/WEB/VENDOR/OTHER, can NEVER be VERIFIED.
 *   - create: VERIFIED requires a HUMAN extractor + a DOCUMENT/HUMAN_STATEMENT source;
 *   - verify: AI-extracted → 409; no qualifying source → 409;
 *   - the database adds CHECK (NOT (extracted_by_type='AI' AND claim_status='VERIFIED'));
 *   - there is NO generic status-update route (unknown paths 404).
 *   The only way an AI extraction becomes VERIFIED is the human accept flow
 *   (acceptExtractedClaim): a human attaches a qualifying source and takes
 *   authorship of the claim; the AI origin stays recorded in ai_run_id.
 *
 * AI extraction runs through the runAi boundary (P4) with the document's privacy
 * label as sensitivity; candidates land AI_INFERRED with an ai_run_id link and are
 * quarantined (never VERIFIED, excluded from institutional truth) until human accept.
 */

export class EvidenceError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const CLAIM_STATUSES = ["VERIFIED", "FOUNDER_STATED", "THIRD_PARTY_SOURCED", "AI_INFERRED", "UNVERIFIED", "MISSING"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_SOURCE_TYPES = ["DOCUMENT", "TRANSCRIPT", "WEB", "VENDOR", "HUMAN_STATEMENT", "MODEL_OUTPUT", "OTHER"] as const;
export type ClaimSourceType = (typeof CLAIM_SOURCE_TYPES)[number];

/** Source types that can back a VERIFIED claim. Everything else cannot. */
export const VERIFICATION_QUALIFYING_SOURCES: readonly ClaimSourceType[] = ["DOCUMENT", "HUMAN_STATEMENT"];

export const CONTRADICTION_TYPES = ["VALUE", "PERIOD", "DEFINITION", "VERSION", "SOURCE", "OTHER"] as const;
export const CONTRADICTION_MATERIALITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const CONTRADICTION_STATUSES = ["OPEN", "INVESTIGATING", "RESOLVED", "ACCEPTED_RISK", "INVALID"] as const;

export interface DiligenceClaimRow {
  id: string;
  company_id: string | null;
  subject_type: string;
  subject_id: string;
  claim_text: string;
  metric_key: string | null;
  metric_value: string | null;
  period_start: string | null;
  period_end: string | null;
  claim_status: ClaimStatus;
  confidence: number;
  privacy_label: string;
  firm_scope: string;
  extracted_by_type: "HUMAN" | "AI";
  extracted_by_id: string;
  ai_run_id: string | null;
  superseded_by: string | null;
  created_at: string;
}

export interface ClaimSourceRow {
  id: string;
  claim_id: string;
  source_type: ClaimSourceType;
  document_version_id: string | null;
  location: string;
  source_date: string;
  method: string;
  note: string | null;
  created_by: string;
  firm_scope: string;
  created_at: string;
}

export interface ContradictionRow {
  id: string;
  contradiction_type: string;
  topic: string;
  company_id: string | null;
  materiality: string;
  status: string;
  required_question: string | null;
  assigned_owner: string | null;
  proposed_by_type: string;
  proposed_by_id: string;
  resolution_evidence_json: string | null;
  human_disposition_by: string | null;
  human_disposition_at: string | null;
  firm_scope: string;
  created_at: string;
}

export interface KnowledgeCandidateRow {
  id: string;
  candidate_type: string;
  payload_json: string;
  source_claim_ids_json: string;
  status: string;
  proposed_by_type: string;
  proposed_by_id: string;
  approval_card_id: string | null;
  firm_scope: string;
  created_at: string;
  resolved_at: string | null;
}

export interface KnowledgeRecordRow {
  id: string;
  title: string;
  body: string;
  provenance_json: string;
  confidence: number;
  version_no: number;
  supersedes_id: string | null;
  privacy_label: string;
  firm_scope: string;
  promoted_via_candidate_id: string;
  created_at: string;
}

export interface SourceConflictRow {
  id: string;
  conflict_key: string;
  system_a: string;
  system_b: string;
  record_ref_a: string;
  record_ref_b: string;
  field: string;
  value_a: string;
  value_b: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  firm_scope: string;
  created_at: string;
  resolved_at: string | null;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

// ── Claims ──

export interface ClaimSourceInput {
  source_type: ClaimSourceType;
  document_version_id?: string;
  location: string;
  source_date: string;
  method: string;
  note?: string;
}

export interface CreateClaimInput {
  company_id?: string;
  subject_type: string;
  subject_id: string;
  claim_text: string;
  metric_key?: string;
  metric_value?: string;
  period_start?: string;
  period_end?: string;
  claim_status?: ClaimStatus;
  confidence: number;
  privacy_label?: string;
  sources: ClaimSourceInput[];
}

export async function getClaim(env: Env, id: string): Promise<DiligenceClaimRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM diligence_claim WHERE id = ?1").bind(id).first<DiligenceClaimRow>();
}

export async function listClaimSources(env: Env, claimId: string): Promise<ClaimSourceRow[]> {
  const rows = await env.WP_OS_DB.prepare("SELECT * FROM claim_source WHERE claim_id = ?1 ORDER BY created_at, id")
    .bind(claimId)
    .all<ClaimSourceRow>();
  return rows.results ?? [];
}

async function insertClaimSource(env: Env, claimId: string, source: ClaimSourceInput, createdBy: string, firmScope: string): Promise<void> {
  if (source.source_type === "DOCUMENT") {
    if (!source.document_version_id) {
      throw new EvidenceError(400, "invalid_source", "DOCUMENT sources require document_version_id");
    }
    const version = await getDocumentVersion(env, source.document_version_id);
    if (!version) throw new EvidenceError(400, "invalid_source", `document_version '${source.document_version_id}' does not exist`);
  }
  await env.WP_OS_DB.prepare(
    `INSERT INTO claim_source (id, claim_id, source_type, document_version_id, location, source_date, method, note, created_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      `csrc_${crypto.randomUUID()}`,
      claimId,
      source.source_type,
      source.document_version_id ?? null,
      source.location,
      source.source_date,
      source.method,
      source.note ?? null,
      createdBy,
      firmScope,
    )
    .run();
}

function hasQualifyingSource(sources: Array<Pick<ClaimSourceInput, "source_type">>): boolean {
  return sources.some((s) => VERIFICATION_QUALIFYING_SOURCES.includes(s.source_type));
}

export interface CreateClaimOptions {
  /** Extractor identity; defaults to the calling HUMAN actor. */
  extractor?: { type: "HUMAN" | "AI"; id: string };
  aiRunId?: string;
  eventType?: string;
  actionKey?: string;
}

/**
 * Create a diligence claim with mandatory provenance. The self-promotion ban is
 * enforced HERE (service level), so no route can bypass it: VERIFIED requires a
 * HUMAN extractor and at least one DOCUMENT/HUMAN_STATEMENT source.
 */
export async function createClaim(env: Env, actor: Actor, input: CreateClaimInput, opts: CreateClaimOptions = {}): Promise<DiligenceClaimRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, opts.actionKey ?? "claim.create", { objectType: "diligence_claim", firmScope });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  if (input.company_id) {
    const company = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(input.company_id).first();
    if (!company) throw new EvidenceError(400, "unknown_company", `canonical_company '${input.company_id}' does not exist`);
  }
  if (input.sources.length === 0) {
    throw new EvidenceError(400, "source_required", "every claim requires at least one source (source/date/location/method)");
  }

  const extractor = opts.extractor ?? { type: "HUMAN" as const, id: actor.firmUserId ?? "system" };
  const status: ClaimStatus = input.claim_status ?? (extractor.type === "AI" ? "AI_INFERRED" : "UNVERIFIED");

  // Self-promotion ban, create path.
  if (status === "VERIFIED") {
    if (extractor.type === "AI") {
      throw new EvidenceError(409, "self_promotion_ban", "an AI-extracted claim can never be VERIFIED (self-promotion ban)");
    }
    if (!hasQualifyingSource(input.sources)) {
      throw new EvidenceError(
        409,
        "self_promotion_ban",
        "VERIFIED requires at least one DOCUMENT or HUMAN_STATEMENT source; MODEL_OUTPUT/TRANSCRIPT/WEB/VENDOR-only claims can never be VERIFIED",
      );
    }
  }
  if (extractor.type === "AI" && status !== "AI_INFERRED" && status !== "UNVERIFIED" && status !== "MISSING") {
    throw new EvidenceError(409, "self_promotion_ban", "AI-extracted claims enter as AI_INFERRED/UNVERIFIED and stay quarantined until human accept");
  }

  const id = `clm_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO diligence_claim
       (id, company_id, subject_type, subject_id, claim_text, metric_key, metric_value, period_start, period_end,
        claim_status, confidence, privacy_label, firm_scope, extracted_by_type, extracted_by_id, ai_run_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
  )
    .bind(
      id,
      input.company_id ?? null,
      input.subject_type,
      input.subject_id,
      input.claim_text,
      input.metric_key ?? null,
      input.metric_value ?? null,
      input.period_start ?? null,
      input.period_end ?? null,
      status,
      input.confidence,
      input.privacy_label ?? "INTERNAL",
      firmScope,
      extractor.type,
      extractor.id,
      opts.aiRunId ?? null,
    )
    .run();
  for (const source of input.sources) {
    await insertClaimSource(env, id, source, extractor.type === "HUMAN" ? extractor.id : (actor.firmUserId ?? extractor.id), firmScope);
  }

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: opts.eventType ?? "claim.created",
    actorType,
    actorId,
    objectType: "diligence_claim",
    objectId: id,
    firmScope,
    payload: {
      claim_status: status,
      extracted_by_type: extractor.type,
      ai_run_id: opts.aiRunId ?? null,
      company_id: input.company_id ?? null,
      metric_key: input.metric_key ?? null,
    },
  });
  return (await getClaim(env, id))!;
}

/**
 * Verify a claim (human only). The ONLY route that sets VERIFIED on an existing
 * claim — and it structurally refuses AI-extracted claims and claims without a
 * DOCUMENT/HUMAN_STATEMENT source (self-promotion ban, update path).
 */
export async function verifyClaim(env: Env, actor: Actor, claimId: string, extraSource?: ClaimSourceInput): Promise<DiligenceClaimRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "claim verification is human-reserved");
  const authz = await authorize(env, actor, "claim.verify", { objectType: "diligence_claim", objectId: claimId });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  const claim = await getClaim(env, claimId);
  if (!claim) throw new EvidenceError(404, "not_found");
  if (claim.superseded_by) throw new EvidenceError(409, "claim_superseded", "superseded claims cannot be verified; verify the replacement");
  if (claim.claim_status === "VERIFIED") throw new EvidenceError(409, "already_verified");
  if (claim.extracted_by_type === "AI") {
    throw new EvidenceError(
      409,
      "self_promotion_ban",
      "an AI-extracted claim can never be VERIFIED directly; a human must accept it with a DOCUMENT/HUMAN_STATEMENT source (claim accept flow)",
    );
  }

  if (extraSource) await insertClaimSource(env, claimId, extraSource, actor.firmUserId!, claim.firm_scope);
  const sources = await listClaimSources(env, claimId);
  if (!hasQualifyingSource(sources)) {
    throw new EvidenceError(
      409,
      "self_promotion_ban",
      "VERIFIED requires at least one DOCUMENT or HUMAN_STATEMENT source; MODEL_OUTPUT/TRANSCRIPT/WEB/VENDOR-only claims can never be VERIFIED",
    );
  }

  await env.WP_OS_DB.prepare("UPDATE diligence_claim SET claim_status = 'VERIFIED' WHERE id = ?1").bind(claimId).run();
  await appendEvent(env, {
    eventType: "claim.verified",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "diligence_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
    payload: { verified_by: actor.firmUserId!, qualifying_sources: sources.filter((s) => VERIFICATION_QUALIFYING_SOURCES.includes(s.source_type)).length },
  });
  return (await getClaim(env, claimId))!;
}

/**
 * Human accept of a quarantined AI extraction. The human attaches a qualifying
 * source and TAKES AUTHORSHIP (extracted_by becomes the human); the AI origin
 * stays recorded in ai_run_id. This is the only path from AI_INFERRED to a
 * human-standing status — the claim row is never AI-extracted AND VERIFIED.
 */
export async function acceptExtractedClaim(
  env: Env,
  actor: Actor,
  claimId: string,
  source: ClaimSourceInput,
  status: "VERIFIED" | "FOUNDER_STATED" | "THIRD_PARTY_SOURCED" = "VERIFIED",
): Promise<DiligenceClaimRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "accepting quarantined extractions is human-reserved");
  const authz = await authorize(env, actor, "claim.accept", { objectType: "diligence_claim", objectId: claimId });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  const claim = await getClaim(env, claimId);
  if (!claim) throw new EvidenceError(404, "not_found");
  if (claim.extracted_by_type !== "AI" || (claim.claim_status !== "AI_INFERRED" && claim.claim_status !== "UNVERIFIED")) {
    throw new EvidenceError(409, "not_quarantined_extraction", "only AI-extracted claims in AI_INFERRED/UNVERIFIED can be accepted");
  }
  if (!VERIFICATION_QUALIFYING_SOURCES.includes(source.source_type)) {
    throw new EvidenceError(409, "self_promotion_ban", "accept requires a DOCUMENT or HUMAN_STATEMENT source attached by the accepting human");
  }

  await insertClaimSource(env, claimId, source, actor.firmUserId!, claim.firm_scope);
  await env.WP_OS_DB.prepare(
    "UPDATE diligence_claim SET extracted_by_type = 'HUMAN', extracted_by_id = ?2, claim_status = ?3 WHERE id = ?1",
  )
    .bind(claimId, actor.firmUserId!, status)
    .run();
  await appendEvent(env, {
    eventType: "claim.accepted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "diligence_claim",
    objectId: claimId,
    firmScope: claim.firm_scope,
    payload: { accepted_by: actor.firmUserId!, resulting_status: status, original_extractor_type: "AI", ai_run_id: claim.ai_run_id },
  });
  return (await getClaim(env, claimId))!;
}

/** Supersede a claim: create the replacement, link superseded_by. The old claim stays readable. */
export async function supersedeClaim(env: Env, actor: Actor, claimId: string, input: CreateClaimInput): Promise<DiligenceClaimRow> {
  const prior = await getClaim(env, claimId);
  if (!prior) throw new EvidenceError(404, "not_found");
  if (prior.superseded_by) throw new EvidenceError(409, "already_superseded", `claim already superseded by ${prior.superseded_by}`);
  const authz = await authorize(env, actor, "claim.supersede", { objectType: "diligence_claim", objectId: claimId, firmScope: prior.firm_scope });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  const replacement = await createClaim(env, actor, input);
  await env.WP_OS_DB.prepare("UPDATE diligence_claim SET superseded_by = ?2 WHERE id = ?1").bind(claimId, replacement.id).run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "claim.superseded",
    actorType,
    actorId,
    objectType: "diligence_claim",
    objectId: claimId,
    firmScope: prior.firm_scope,
    payload: { superseded_by: replacement.id },
  });
  return replacement;
}

// ── AI extraction (through the runAi boundary, P4) ──

export interface ExtractedCandidate {
  claim_text: string;
  metric_key?: string;
  metric_value?: string;
  period_start?: string;
  period_end?: string;
  location: string;
}

/**
 * Deterministic candidate structuring from document text. In LOCKDOWN/LOCAL the
 * mock-local adapter does not produce structured claims, so candidates are parsed
 * from `metric: value` lines; a real provider's structured output would replace
 * this parser (real provider extraction is UNPROVEN — CREDENTIAL GATE).
 */
export function parseClaimCandidates(text: string): ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && candidates.length < 50; i++) {
    const line = lines[i]!.trim();
    const m = /^([A-Za-z][A-Za-z0-9_ ]{1,50}?)\s*[:=]\s*(\S.*)$/.exec(line);
    if (!m) continue;
    const metricKey = m[1]!.trim().toLowerCase().replaceAll(/\s+/g, "_");
    const metricValue = m[2]!.trim();
    const year = /(20\d{2})/.exec(line)?.[1];
    candidates.push({
      claim_text: line,
      metric_key: metricKey,
      metric_value: metricValue,
      period_start: year ? `${year}-01-01` : undefined,
      period_end: year ? `${year}-12-31` : undefined,
      location: `line ${i + 1}`,
    });
  }
  return candidates;
}

export interface ExtractClaimsResult {
  run: AIRunRow;
  candidates: DiligenceClaimRow[];
}

/**
 * Extract claim candidates from a stored document version through the governed
 * run_ai boundary. Sensitivity comes from the document's privacy label — the
 * egress pipeline (P4) decides what may leave. Every candidate lands AI_INFERRED
 * with an ai_run_id link (quarantined; self-promotion ban applies).
 */
export async function extractClaimsFromDocument(
  env: Env,
  actor: Actor,
  documentVersionId: string,
  opts: { company_id?: string; subject_type?: string; subject_id?: string },
  deps: RunAiDeps = {},
): Promise<ExtractClaimsResult> {
  const authz = await authorize(env, actor, "claim.extract", { objectType: "document_version", objectId: documentVersionId });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  const version = await getDocumentVersion(env, documentVersionId);
  if (!version) throw new EvidenceError(404, "not_found");
  const doc = await env.WP_OS_DB.prepare("SELECT * FROM document WHERE id = ?1").bind(version.document_id).first<{ id: string; title: string; privacy_label: string }>();
  if (!doc) throw new EvidenceError(404, "not_found");
  if (typeof env.WP_OS_DOCUMENTS === "undefined") {
    throw new EvidenceError(503, "documents_degraded", "document storage is unavailable: R2 binding WP_OS_DOCUMENTS is not configured (degraded mode, §3.5)");
  }
  const object = await env.WP_OS_DOCUMENTS.get(version.r2_key);
  if (!object) throw new EvidenceError(503, "content_missing", "version row exists but R2 object is absent");
  const text = new TextDecoder().decode(await object.arrayBuffer());

  // The governed boundary: cost/privacy/egress/quarantine all apply (P4).
  const { run } = await runAi(
    env,
    {
      purpose: `claim extraction from document ${doc.id} (${doc.title})`,
      actor,
      inputs: [text],
      sensitivity: doc.privacy_label as PrivacyLabel,
      /*
       * MECHANICAL, AND CONFIDENTIAL — the only call site in this system that is both, and the pair
       * is the point of having two words instead of one.
       *
       * MECHANICAL: this extracts claims into structured rows that a later stage verifies against
       * the source. Nobody reads its prose; the extraction is checked, not trusted. It is exactly
       * the kind of work the cheap tier exists for.
       *
       * CONFIDENTIAL: the document is a deal document. Deal terms may not reach a lane whose terms
       * permit training, whatever it costs, and `sensitivity` alone would not have said so — a
       * document labelled PUBLIC can still name a counterparty and a price.
       */
      budgetContext: { mechanical: true, confidential: true },
    },
    deps,
  );
  if (run.status !== "COMPLETED") {
    // Blocked/deferred runs are visible in the run ledger; no candidates extracted.
    return { run, candidates: [] };
  }

  const parsed = parseClaimCandidates(text);
  const candidates: DiligenceClaimRow[] = [];
  for (const c of parsed) {
    const claim = await createClaim(
      env,
      actor,
      {
        company_id: opts.company_id,
        subject_type: opts.subject_type ?? "company",
        subject_id: opts.subject_id ?? opts.company_id ?? doc.id,
        claim_text: c.claim_text,
        metric_key: c.metric_key,
        metric_value: c.metric_value,
        period_start: c.period_start,
        period_end: c.period_end,
        claim_status: "AI_INFERRED",
        confidence: 0.5,
        privacy_label: doc.privacy_label,
        sources: [
          {
            source_type: "MODEL_OUTPUT",
            document_version_id: version.id,
            location: c.location,
            source_date: run.created_at.slice(0, 10),
            method: `run_ai:${run.model ?? "unknown"}`,
            note: `trace ${run.trace_id}`,
          },
        ],
      },
      { extractor: { type: "AI", id: run.model ?? "ai" }, aiRunId: run.id, eventType: "claim.extracted", actionKey: "claim.extract" },
    );
    candidates.push(claim);
  }
  return { run, candidates };
}

// ── Contradictions ──

export interface ContradictionLinkInput {
  claim_id: string;
  side_label: string;
}

export interface CreateContradictionInput {
  contradiction_type: (typeof CONTRADICTION_TYPES)[number];
  topic: string;
  company_id?: string;
  materiality: (typeof CONTRADICTION_MATERIALITIES)[number];
  required_question?: string;
  assigned_owner?: string;
  claim_links: ContradictionLinkInput[];
}

export async function getContradiction(env: Env, id: string): Promise<ContradictionRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM contradiction_record WHERE id = ?1").bind(id).first<ContradictionRow>();
}

/** Create a contradiction (human or AI-proposed; AI proposals enter OPEN with proposed-by recorded). */
export async function createContradiction(env: Env, actor: Actor, input: CreateContradictionInput): Promise<ContradictionRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "contradiction.create", { objectType: "contradiction_record", firmScope });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  if (input.claim_links.length < 2) {
    throw new EvidenceError(400, "invalid_input", "a contradiction links at least two conflicting claims");
  }
  for (const link of input.claim_links) {
    const claim = await getClaim(env, link.claim_id);
    if (!claim) throw new EvidenceError(400, "unknown_claim", `diligence_claim '${link.claim_id}' does not exist`);
  }

  const id = `ctr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO contradiction_record
       (id, contradiction_type, topic, company_id, materiality, status, required_question, assigned_owner, proposed_by_type, proposed_by_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, 'OPEN', ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      input.contradiction_type,
      input.topic,
      input.company_id ?? null,
      input.materiality,
      input.required_question ?? null,
      input.assigned_owner ?? null,
      actor.type,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      firmScope,
    )
    .run();
  for (const link of input.claim_links) {
    await env.WP_OS_DB.prepare(
      "INSERT INTO contradiction_claim_link (contradiction_id, claim_id, side_label, firm_scope) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(id, link.claim_id, link.side_label, firmScope)
      .run();
  }
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "contradiction.created",
    actorType,
    actorId,
    objectType: "contradiction_record",
    objectId: id,
    firmScope,
    payload: { contradiction_type: input.contradiction_type, materiality: input.materiality, company_id: input.company_id ?? null, claim_ids: input.claim_links.map((l) => l.claim_id) },
  });
  return (await getContradiction(env, id))!;
}

/** OPEN → INVESTIGATING, with an assigned human owner. */
export async function investigateContradiction(env: Env, actor: Actor, id: string, assignedOwner?: string): Promise<ContradictionRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "contradiction investigation is human-reserved");
  const authz = await authorize(env, actor, "contradiction.update", { objectType: "contradiction_record", objectId: id });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  const row = await getContradiction(env, id);
  if (!row) throw new EvidenceError(404, "not_found");
  if (row.status !== "OPEN") throw new EvidenceError(409, "illegal_transition", `cannot investigate a contradiction in status ${row.status}`);

  const owner = assignedOwner ?? actor.firmUserId!;
  await env.WP_OS_DB.prepare("UPDATE contradiction_record SET status = 'INVESTIGATING', assigned_owner = ?2 WHERE id = ?1").bind(id, owner).run();
  await appendEvent(env, {
    eventType: "contradiction.investigating",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "contradiction_record",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { assigned_owner: owner },
  });
  return (await getContradiction(env, id))!;
}

/**
 * Human-only disposition: RESOLVED / ACCEPTED_RISK / INVALID with evidence.
 * AI may propose and flag; only humans resolve (governing law).
 */
export async function resolveContradiction(
  env: Env,
  actor: Actor,
  id: string,
  disposition: "RESOLVED" | "ACCEPTED_RISK" | "INVALID",
  resolutionEvidence: Record<string, unknown>,
): Promise<ContradictionRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "contradiction disposition is human-reserved");
  const authz = await authorize(env, actor, "contradiction.resolve", { objectType: "contradiction_record", objectId: id });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  const row = await getContradiction(env, id);
  if (!row) throw new EvidenceError(404, "not_found");
  if (row.status !== "OPEN" && row.status !== "INVESTIGATING") {
    throw new EvidenceError(409, "illegal_transition", `contradiction in status ${row.status} cannot be disposed again`);
  }

  const now = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    `UPDATE contradiction_record
        SET status = ?2, resolution_evidence_json = ?3, human_disposition_by = ?4, human_disposition_at = ?5
      WHERE id = ?1`,
  )
    .bind(id, disposition, JSON.stringify(resolutionEvidence), actor.firmUserId!, now)
    .run();
  await appendEvent(env, {
    eventType: "contradiction.resolved",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "contradiction_record",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { disposition, materiality: row.materiality, company_id: row.company_id },
  });
  return (await getContradiction(env, id))!;
}

export interface ContradictionCandidate {
  contradiction_type: "VALUE" | "PERIOD" | "DEFINITION";
  topic: string;
  company_id: string;
  metric_key: string;
  claim_ids: string[];
  rationale: string;
}

/**
 * Deterministic contradiction detection. Groups current (non-superseded) claims
 * by company + metric_key and proposes candidates when values, periods, or
 * definitions differ. This NEVER creates records — humans decide (AI may flag).
 */
export async function proposeContradictionCandidates(env: Env, companyId: string): Promise<ContradictionCandidate[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, metric_key, metric_value, period_start, period_end, claim_text
       FROM diligence_claim
      WHERE company_id = ?1 AND superseded_by IS NULL AND metric_key IS NOT NULL AND metric_value IS NOT NULL
      ORDER BY metric_key, id`,
  )
    .bind(companyId)
    .all<{ id: string; metric_key: string; metric_value: string; period_start: string | null; period_end: string | null; claim_text: string }>();

  const groups = new Map<string, typeof rows.results>();
  for (const row of rows.results ?? []) {
    const list = groups.get(row.metric_key) ?? [];
    list.push(row);
    groups.set(row.metric_key, list);
  }

  const candidates: ContradictionCandidate[] = [];
  for (const [metricKey, claims] of groups) {
    if (!claims || claims.length < 2) continue;
    const topic = `${metricKey} (company ${companyId})`;

    const values = new Set(claims.map((c) => c.metric_value));
    if (values.size > 1) {
      candidates.push({
        contradiction_type: "VALUE",
        topic,
        company_id: companyId,
        metric_key: metricKey,
        claim_ids: claims.map((c) => c.id),
        rationale: `${values.size} differing values for metric '${metricKey}': ${[...values].join(" vs ")}`,
      });
      continue; // a VALUE conflict subsumes period/definition reads of the same group
    }

    const periods = new Set(claims.map((c) => `${c.period_start ?? "?"}→${c.period_end ?? "?"}`));
    if (periods.size > 1) {
      candidates.push({
        contradiction_type: "PERIOD",
        topic,
        company_id: companyId,
        metric_key: metricKey,
        claim_ids: claims.map((c) => c.id),
        rationale: `same value but ${periods.size} differing periods for metric '${metricKey}'`,
      });
      continue;
    }

    const normalize = (text: string) => text.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    const definitions = new Set(claims.map((c) => normalize(c.claim_text)));
    if (definitions.size > 1) {
      candidates.push({
        contradiction_type: "DEFINITION",
        topic,
        company_id: companyId,
        metric_key: metricKey,
        claim_ids: claims.map((c) => c.id),
        rationale: `same value and period but differing claim wording (possible definition mismatch) for metric '${metricKey}'`,
      });
    }
  }
  return candidates;
}

// ── Company evidence summary (downstream visibility — the P6 IC hook) ──

export interface EvidenceSummary {
  company_id: string;
  total_claims: number;
  claims_by_status: Record<ClaimStatus, number>;
  claims: DiligenceClaimRow[];
  /**
   * ALL unresolved material contradictions (OPEN/INVESTIGATING at HIGH/CRITICAL).
   * Structurally un-hidable: no query parameter or role affects this section;
   * IC packets must always see them.
   */
  unresolved_material_contradictions: ContradictionRow[];
}

export async function getEvidenceSummary(env: Env, identityVisibleClause: string, companyId: string): Promise<EvidenceSummary | null> {
  const company = await env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(companyId).first();
  if (!company) return null;

  const claims = await env.WP_OS_DB.prepare(
    `SELECT * FROM diligence_claim WHERE company_id = ?1 AND ${identityVisibleClause} ORDER BY created_at, id`,
  )
    .bind(companyId)
    .all<DiligenceClaimRow>();
  const byStatus = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0])) as Record<ClaimStatus, number>;
  for (const claim of claims.results ?? []) byStatus[claim.claim_status] += 1;

  const contradictions = await env.WP_OS_DB.prepare(
    `SELECT * FROM contradiction_record
      WHERE company_id = ?1 AND status IN ('OPEN','INVESTIGATING') AND materiality IN ('HIGH','CRITICAL')
      ORDER BY created_at, id`,
  )
    .bind(companyId)
    .all<ContradictionRow>();

  return {
    company_id: companyId,
    total_claims: (claims.results ?? []).length,
    claims_by_status: byStatus,
    claims: claims.results ?? [],
    unresolved_material_contradictions: contradictions.results ?? [],
  };
}

// ── Knowledge promotion (institutional memory; humans decide) ──

export async function getKnowledgeCandidate(env: Env, id: string): Promise<KnowledgeCandidateRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM knowledge_promotion_candidate WHERE id = ?1").bind(id).first<KnowledgeCandidateRow>();
}

export interface ProposeKnowledgeInput {
  candidate_type: string;
  payload: { title: string; body: string; confidence?: number; supersedes_knowledge_id?: string };
  source_claim_ids: string[];
}

/** Propose a promotion candidate + its approval card (knowledge.promote, MP approver). */
export async function proposeKnowledgePromotion(env: Env, actor: Actor, input: ProposeKnowledgeInput): Promise<KnowledgeCandidateRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "knowledge_promotion.propose", { objectType: "knowledge_promotion_candidate", firmScope });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  if (input.source_claim_ids.length === 0) {
    throw new EvidenceError(400, "invalid_input", "a promotion candidate must cite at least one source claim");
  }
  for (const claimId of input.source_claim_ids) {
    const claim = await getClaim(env, claimId);
    if (!claim) throw new EvidenceError(400, "unknown_claim", `diligence_claim '${claimId}' does not exist`);
  }
  if (input.payload.supersedes_knowledge_id) {
    const prior = await env.WP_OS_DB.prepare("SELECT id FROM knowledge_record WHERE id = ?1")
      .bind(input.payload.supersedes_knowledge_id)
      .first();
    if (!prior) throw new EvidenceError(400, "unknown_knowledge_record", `knowledge_record '${input.payload.supersedes_knowledge_id}' does not exist`);
  }

  const id = `kpc_${crypto.randomUUID()}`;
  const proposedById = actor.firmUserId ?? actor.aiEmployeeId ?? "system";
  await env.WP_OS_DB.prepare(
    `INSERT INTO knowledge_promotion_candidate (id, candidate_type, payload_json, source_claim_ids_json, status, proposed_by_type, proposed_by_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5, ?6, ?7)`,
  )
    .bind(id, input.candidate_type, JSON.stringify(input.payload), JSON.stringify(input.source_claim_ids), actor.type, proposedById, firmScope)
    .run();

  const card = await requestApproval(env, actor, {
    action_key: "knowledge.promote",
    object_type: "knowledge_promotion_candidate",
    object_id: id,
    title: `Promote to institutional knowledge: ${input.payload.title}`,
    summary: input.payload.body.slice(0, 280),
    payload: { candidate_id: id, source_claim_ids: input.source_claim_ids },
    submit: true,
  });
  await env.WP_OS_DB.prepare("UPDATE knowledge_promotion_candidate SET approval_card_id = ?2 WHERE id = ?1").bind(id, card.id).run();

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "knowledge_promotion.proposed",
    actorType,
    actorId,
    objectType: "knowledge_promotion_candidate",
    objectId: id,
    firmScope,
    payload: { approval_card_id: card.id, source_claim_ids: input.source_claim_ids },
  });
  return (await getKnowledgeCandidate(env, id))!;
}

/**
 * Apply an APPROVED promotion: creates the knowledge_record with full provenance.
 * Goes through authorize() with the reserved action knowledge.promote — no
 * approved receipt, no promotion. The receipt is consumed on success.
 */
export async function applyKnowledgePromotion(env: Env, actor: Actor, candidateId: string, receiptId?: string): Promise<KnowledgeRecordRow> {
  const candidate = await getKnowledgeCandidate(env, candidateId);
  if (!candidate) throw new EvidenceError(404, "not_found");
  if (candidate.status !== "PENDING") throw new EvidenceError(409, "already_resolved", `candidate is ${candidate.status}`);

  const authz = await authorize(
    env,
    actor,
    "knowledge.promote",
    { objectType: "knowledge_promotion_candidate", objectId: candidateId, firmScope: candidate.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new EvidenceError(409, "approval_required", authz.reason);

  const payload = JSON.parse(candidate.payload_json) as ProposeKnowledgeInput["payload"];
  const sourceClaimIds = JSON.parse(candidate.source_claim_ids_json) as string[];

  let versionNo = 1;
  let supersedesId: string | null = null;
  if (payload.supersedes_knowledge_id) {
    const prior = await env.WP_OS_DB.prepare("SELECT id, version_no FROM knowledge_record WHERE id = ?1")
      .bind(payload.supersedes_knowledge_id)
      .first<{ id: string; version_no: number }>();
    if (!prior) throw new EvidenceError(400, "unknown_knowledge_record");
    versionNo = prior.version_no + 1;
    supersedesId = prior.id;
  }

  const recordId = `knw_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO knowledge_record
       (id, title, body, provenance_json, confidence, version_no, supersedes_id, privacy_label, firm_scope, promoted_via_candidate_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      recordId,
      payload.title,
      payload.body,
      JSON.stringify({
        source_claim_ids: sourceClaimIds,
        candidate_id: candidateId,
        approval_card_id: authz.receiptId ?? null,
        promoted_by: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      }),
      payload.confidence ?? 1,
      versionNo,
      supersedesId,
      "INTERNAL",
      candidate.firm_scope,
      candidateId,
    )
    .run();
  await env.WP_OS_DB.prepare("UPDATE knowledge_promotion_candidate SET status = 'APPROVED', resolved_at = ?2 WHERE id = ?1")
    .bind(candidateId, new Date().toISOString())
    .run();
  if (authz.receiptId) await consumeApprovalCard(env, authz.receiptId, { actorId: actor.firmUserId ?? "system" });

  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "knowledge.promoted",
    actorType,
    actorId,
    objectType: "knowledge_record",
    objectId: recordId,
    firmScope: candidate.firm_scope,
    payload: { candidate_id: candidateId, version_no: versionNo, supersedes_id: supersedesId, source_claim_ids: sourceClaimIds },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM knowledge_record WHERE id = ?1").bind(recordId).first<KnowledgeRecordRow>())!;
}

/** Reject a promotion candidate (human only). */
export async function rejectKnowledgePromotion(env: Env, actor: Actor, candidateId: string): Promise<KnowledgeCandidateRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "rejecting a promotion candidate is human-reserved");
  const candidate = await getKnowledgeCandidate(env, candidateId);
  if (!candidate) throw new EvidenceError(404, "not_found");
  if (candidate.status !== "PENDING") throw new EvidenceError(409, "already_resolved", `candidate is ${candidate.status}`);
  await env.WP_OS_DB.prepare("UPDATE knowledge_promotion_candidate SET status = 'REJECTED', resolved_at = ?2 WHERE id = ?1")
    .bind(candidateId, new Date().toISOString())
    .run();
  await appendEvent(env, {
    eventType: "knowledge_promotion.rejected",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "knowledge_promotion_candidate",
    objectId: candidateId,
    firmScope: candidate.firm_scope,
    payload: {},
  });
  return (await getKnowledgeCandidate(env, candidateId))!;
}

// ── Source conflicts + append-only resolution decisions ──

export interface CreateSourceConflictInput {
  conflict_key: string;
  system_a: string;
  system_b: string;
  record_ref_a: string;
  record_ref_b: string;
  field: string;
  value_a: string;
  value_b: string;
}

export async function createSourceConflict(env: Env, actor: Actor, input: CreateSourceConflictInput): Promise<SourceConflictRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "source_conflict.create", { objectType: "source_conflict", firmScope });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);

  const id = `scf_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO source_conflict (id, conflict_key, system_a, system_b, record_ref_a, record_ref_b, field, value_a, value_b, status, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'OPEN', ?10)`,
  )
    .bind(id, input.conflict_key, input.system_a, input.system_b, input.record_ref_a, input.record_ref_b, input.field, input.value_a, input.value_b, firmScope)
    .run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "source_conflict.created",
    actorType,
    actorId,
    objectType: "source_conflict",
    objectId: id,
    firmScope,
    payload: { conflict_key: input.conflict_key, field: input.field },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM source_conflict WHERE id = ?1").bind(id).first<SourceConflictRow>())!;
}

/** Resolve a source conflict (human only); the resolution decision is append-only. */
export async function resolveSourceConflict(
  env: Env,
  actor: Actor,
  id: string,
  input: { winning_source: string; rationale: string },
): Promise<SourceConflictRow> {
  if (actor.type !== "HUMAN") throw new EvidenceError(403, "forbidden", "source-conflict resolution is human-reserved");
  const authz = await authorize(env, actor, "source_conflict.resolve", { objectType: "source_conflict", objectId: id });
  if (authz.decision === "DENY") throw new EvidenceError(403, "forbidden", authz.reason);
  const row = await env.WP_OS_DB.prepare("SELECT * FROM source_conflict WHERE id = ?1").bind(id).first<SourceConflictRow>();
  if (!row) throw new EvidenceError(404, "not_found");
  if (row.status === "RESOLVED") throw new EvidenceError(409, "already_resolved");

  await env.WP_OS_DB.prepare(
    "INSERT INTO source_resolution_decision (id, source_conflict_id, winning_source, rationale, decided_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(`srd_${crypto.randomUUID()}`, id, input.winning_source, input.rationale, actor.firmUserId!, row.firm_scope)
    .run();
  await env.WP_OS_DB.prepare("UPDATE source_conflict SET status = 'RESOLVED', resolution = ?2, resolved_by = ?3, resolved_at = ?4 WHERE id = ?1")
    .bind(id, input.rationale, actor.firmUserId!, new Date().toISOString())
    .run();
  await appendEvent(env, {
    eventType: "source_conflict.resolved",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "source_conflict",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { winning_source: input.winning_source, decided_by: actor.firmUserId! },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM source_conflict WHERE id = ?1").bind(id).first<SourceConflictRow>())!;
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
  if (err instanceof EvidenceError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const claimSourceSchema = z.object({
  source_type: z.enum(CLAIM_SOURCE_TYPES),
  document_version_id: z.string().trim().min(1).optional(),
  location: z.string().trim().min(1),
  source_date: z.string().trim().min(1),
  method: z.string().trim().min(1),
  note: z.string().optional(),
});

const createClaimSchema = z.object({
  company_id: z.string().trim().min(1).optional(),
  subject_type: z.string().trim().min(1),
  subject_id: z.string().trim().min(1),
  claim_text: z.string().trim().min(1),
  metric_key: z.string().trim().min(1).optional(),
  metric_value: z.string().optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  claim_status: z.enum(CLAIM_STATUSES).optional(),
  confidence: z.number().min(0).max(1),
  privacy_label: privacyLabelSchema.optional(),
  sources: z.array(claimSourceSchema).min(1),
});

export async function handleCreateClaim(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const claim = await createClaim(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(claim, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListClaims(ctx: RouteContext): Promise<Response> {
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
    clauses.push(`claim_status = ?${binds.length + 1}`);
    binds.push(status);
  }
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM diligence_claim WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT 500`,
  )
    .bind(...binds)
    .all<DiligenceClaimRow>();
  return json({ claims: rows.results ?? [] });
}

export async function handleGetClaim(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const claim = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM diligence_claim WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<DiligenceClaimRow>();
  if (!claim) return json({ error: "not_found" }, { status: 404 });
  const sources = await listClaimSources(ctx.env, claim.id);
  return json({ ...claim, sources });
}

const verifySchema = z.object({ source: claimSourceSchema.optional() });

export async function handleVerifyClaim(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = verifySchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const claim = await verifyClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.source);
    return json(claim);
  } catch (err) {
    return errorResponse(err);
  }
}

const acceptSchema = z.object({
  source: claimSourceSchema,
  status: z.enum(["VERIFIED", "FOUNDER_STATED", "THIRD_PARTY_SOURCED"]).optional(),
});

export async function handleAcceptClaim(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const claim = await acceptExtractedClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.source, parsed.data.status);
    return json(claim);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleSupersedeClaim(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createClaimSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const replacement = await supersedeClaim(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data);
    return json(replacement, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const extractSchema = z.object({
  document_version_id: z.string().trim().min(1),
  company_id: z.string().trim().min(1).optional(),
  subject_type: z.string().trim().min(1).optional(),
  subject_id: z.string().trim().min(1).optional(),
});

export async function handleExtractClaims(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = extractSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await extractClaimsFromDocument(ctx.env, actorFromIdentity(ctx.identity!), parsed.data.document_version_id, parsed.data);
    return json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Contradiction handlers ──

const createContradictionSchema = z.object({
  contradiction_type: z.enum(CONTRADICTION_TYPES),
  topic: z.string().trim().min(1),
  company_id: z.string().trim().min(1).optional(),
  materiality: z.enum(CONTRADICTION_MATERIALITIES),
  required_question: z.string().optional(),
  assigned_owner: z.string().optional(),
  claim_links: z.array(z.object({ claim_id: z.string().trim().min(1), side_label: z.string().trim().min(1) })).min(2),
});

export async function handleCreateContradiction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createContradictionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const row = await createContradiction(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListContradictions(ctx: RouteContext): Promise<Response> {
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
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM contradiction_record WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT 500`,
  )
    .bind(...binds)
    .all<ContradictionRow>();
  return json({ contradictions: rows.results ?? [] });
}

export async function handleGetContradiction(ctx: RouteContext): Promise<Response> {
  const row = await getContradiction(ctx.env, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const links = await ctx.env.WP_OS_DB.prepare("SELECT * FROM contradiction_claim_link WHERE contradiction_id = ?1 ORDER BY created_at, claim_id")
    .bind(row.id)
    .all();
  return json({ ...row, claim_links: links.results ?? [] });
}

const investigateSchema = z.object({ assigned_owner: z.string().trim().min(1).optional() });

export async function handleInvestigateContradiction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = investigateSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const row = await investigateContradiction(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.assigned_owner);
    return json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

const resolveContradictionSchema = z.object({
  disposition: z.enum(["RESOLVED", "ACCEPTED_RISK", "INVALID"]),
  resolution_evidence: z.record(z.unknown()).default({}),
});

export async function handleResolveContradiction(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = resolveContradictionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const row = await resolveContradiction(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.disposition, parsed.data.resolution_evidence);
    return json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Company evidence handlers ──

export async function handleEvidenceSummary(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const summary = await getEvidenceSummary(ctx.env, visibility, ctx.params.id!);
  if (!summary) return json({ error: "not_found" }, { status: 404 });
  return json(summary);
}

export async function handleContradictionCandidates(ctx: RouteContext): Promise<Response> {
  const company = await ctx.env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(ctx.params.id!).first();
  if (!company) return json({ error: "not_found" }, { status: 404 });
  const candidates = await proposeContradictionCandidates(ctx.env, ctx.params.id!);
  return json({ candidates });
}

// ── Knowledge promotion handlers ──

const proposeKnowledgeSchema = z.object({
  candidate_type: z.string().trim().min(1),
  payload: z.object({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).optional(),
    supersedes_knowledge_id: z.string().trim().min(1).optional(),
  }),
  source_claim_ids: z.array(z.string().trim().min(1)).min(1),
});

export async function handleProposeKnowledge(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = proposeKnowledgeSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const candidate = await proposeKnowledgePromotion(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(candidate, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListKnowledgeCandidates(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM knowledge_promotion_candidate WHERE status = ?1 ORDER BY created_at DESC, id LIMIT 200")
        .bind(status)
        .all<KnowledgeCandidateRow>()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM knowledge_promotion_candidate ORDER BY created_at DESC, id LIMIT 200").all<KnowledgeCandidateRow>();
  return json({ candidates: rows.results ?? [] });
}

const applyKnowledgeSchema = z.object({ approval_receipt_id: z.string().trim().min(1).optional() });

export async function handleApplyKnowledge(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = applyKnowledgeSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const record = await applyKnowledgePromotion(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.approval_receipt_id);
    return json(record, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRejectKnowledge(ctx: RouteContext): Promise<Response> {
  try {
    const candidate = await rejectKnowledgePromotion(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!);
    return json(candidate);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListKnowledgeRecords(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM knowledge_record WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all<KnowledgeRecordRow>();
  return json({ records: rows.results ?? [] });
}

export async function handleGetKnowledgeRecord(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const row = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM knowledge_record WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<KnowledgeRecordRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}

// ── Source conflict handlers ──

const createSourceConflictSchema = z.object({
  conflict_key: z.string().trim().min(1),
  system_a: z.string().trim().min(1),
  system_b: z.string().trim().min(1),
  record_ref_a: z.string().trim().min(1),
  record_ref_b: z.string().trim().min(1),
  field: z.string().trim().min(1),
  value_a: z.string(),
  value_b: z.string(),
});

export async function handleCreateSourceConflict(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = createSourceConflictSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const row = await createSourceConflict(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListSourceConflicts(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM source_conflict WHERE status = ?1 ORDER BY created_at DESC, id LIMIT 200")
        .bind(status)
        .all<SourceConflictRow>()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM source_conflict ORDER BY created_at DESC, id LIMIT 200").all<SourceConflictRow>();
  return json({ conflicts: rows.results ?? [] });
}

export async function handleGetSourceConflict(ctx: RouteContext): Promise<Response> {
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM source_conflict WHERE id = ?1").bind(ctx.params.id!).first<SourceConflictRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  const decisions = await ctx.env.WP_OS_DB.prepare("SELECT * FROM source_resolution_decision WHERE source_conflict_id = ?1 ORDER BY created_at, id")
    .bind(row.id)
    .all();
  return json({ ...row, decisions: decisions.results ?? [] });
}

const resolveSourceConflictSchema = z.object({
  winning_source: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
});

export async function handleResolveSourceConflict(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = resolveSourceConflictSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const row = await resolveSourceConflict(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data);
    return json(row);
  } catch (err) {
    return errorResponse(err);
  }
}
