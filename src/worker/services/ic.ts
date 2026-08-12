import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, decideApproval, requestApproval } from "./approvals";
import { getEvidenceSummary } from "./evidence";
import { InvestmentError, getDealMathPacket, getOpportunity, transitionOpportunity } from "./investment";

/**
 * Investment Committee (P6): packets, decisions, dissent.
 *
 * Governing law (canon §3.4 + plan §8/P6):
 * - AI may DRAFT a packet; AI can NEVER record an IC decision or a dissent, and can
 *   never mark a human approval. `investment.approve` is human-reserved (MP), so
 *   authorize() denies AI actors outright.
 * - An APPROVE decision requires an approved `investment.approve` approval card for
 *   THIS packet, verified by authorize() and consumed on record (never replayable).
 *   REJECT/DEFER are negative dispositions: they still require an MP (role checked
 *   through authorize()), and they resolve the pending card through the normal
 *   approval state machine rather than consuming it as a capital authorization.
 * - Unresolved material contradictions are structurally un-hidable: the packet stores
 *   the assembly-time snapshot AND every read recomputes the CURRENT unresolved
 *   material set, so a contradiction opened after assembly still reaches the decision.
 * - ic_decision and dissent_record are append-only at the DB layer (0006 triggers).
 * - Nothing here asserts legal/compliance sufficiency (D12).
 */

export const IC_DECISIONS = ["APPROVE", "REJECT", "DEFER"] as const;
export type IcDecisionKind = (typeof IC_DECISIONS)[number];

export const IC_PACKET_STATUSES = ["DRAFT", "IN_REVIEW", "DECIDED"] as const;

export interface IcPacketRow {
  id: string;
  opportunity_id: string;
  deal_math_packet_id: string | null;
  evidence_summary_json: string;
  unresolved_contradictions_json: string;
  drafted_by_type: "HUMAN" | "AI";
  drafted_by_id: string;
  ai_run_id: string | null;
  status: "DRAFT" | "IN_REVIEW" | "DECIDED";
  firm_scope: string;
  created_at: string;
}

export interface IcDecisionRow {
  id: string;
  ic_packet_id: string;
  decision: IcDecisionKind;
  decided_by: string;
  rationale: string | null;
  firm_scope: string;
  created_at: string;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

export async function getIcPacket(env: Env, id: string): Promise<IcPacketRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM ic_packet WHERE id = ?1").bind(id).first<IcPacketRow>();
}

/** The approval card currently gating this packet, if any. */
async function pendingCardFor(env: Env, packetId: string): Promise<{ id: string; state: string } | null> {
  return env.WP_OS_DB.prepare(
    `SELECT id, state FROM approval_card
      WHERE action_key = 'investment.approve' AND object_type = 'ic_packet' AND object_id = ?1
      ORDER BY created_at DESC, id LIMIT 1`,
  )
    .bind(packetId)
    .first<{ id: string; state: string }>();
}

export interface AssembleIcPacketInput {
  opportunity_id: string;
  deal_math_packet_id?: string;
  /** Set when an AI employee drafted the packet through run_ai (quarantine rules apply). */
  ai_run_id?: string;
}

/**
 * Assemble an IC packet from the canonical company's evidence + the opportunity's
 * deal math. `visibleClause` restricts the CLAIM snapshot to what the assembling
 * identity may see; unresolved material contradictions are never filtered.
 */
export async function assembleIcPacket(
  env: Env,
  actor: Actor,
  input: AssembleIcPacketInput,
  visibleClause = "1=1",
): Promise<IcPacketRow> {
  const opportunity = await getOpportunity(env, input.opportunity_id);
  if (!opportunity) throw new InvestmentError(400, "unknown_opportunity", `investment_opportunity '${input.opportunity_id}' does not exist`);
  const authz = await authorize(env, actor, "ic_packet.assemble", {
    objectType: "ic_packet",
    firmScope: opportunity.firm_scope,
  });
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new InvestmentError(409, "approval_required", authz.reason);

  let dealMathPacketId: string | null = null;
  if (input.deal_math_packet_id) {
    const packet = await getDealMathPacket(env, input.deal_math_packet_id);
    if (!packet) throw new InvestmentError(400, "unknown_deal_math_packet", `deal_math_packet '${input.deal_math_packet_id}' does not exist`);
    if (packet.opportunity_id !== opportunity.id) {
      throw new InvestmentError(400, "packet_opportunity_mismatch", "deal math packet belongs to a different opportunity");
    }
    dealMathPacketId = packet.id;
  }
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new InvestmentError(400, "invalid_input", "an AI-drafted packet must record its ai_run_id (run_ai trace)");
  }

  const summary = await getEvidenceSummary(env, visibleClause, opportunity.company_id);
  const id = `icp_${crypto.randomUUID()}`;
  const { actorType, actorId } = eventActor(actor);
  await env.WP_OS_DB.prepare(
    `INSERT INTO ic_packet
       (id, opportunity_id, deal_math_packet_id, evidence_summary_json, unresolved_contradictions_json,
        drafted_by_type, drafted_by_id, ai_run_id, status, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'DRAFT', ?9)`,
  )
    .bind(
      id,
      opportunity.id,
      dealMathPacketId,
      JSON.stringify(summary ?? {}),
      JSON.stringify(summary?.unresolved_material_contradictions ?? []),
      actor.type === "AI" ? "AI" : "HUMAN",
      actorId,
      input.ai_run_id ?? null,
      opportunity.firm_scope,
    )
    .run();

  await appendEvent(env, {
    eventType: "ic.packet_assembled",
    actorType,
    actorId,
    objectType: "ic_packet",
    objectId: id,
    firmScope: opportunity.firm_scope,
    payload: {
      opportunity_id: opportunity.id,
      company_id: opportunity.company_id,
      deal_math_packet_id: dealMathPacketId,
      drafted_by_type: actor.type === "AI" ? "AI" : "HUMAN",
      ai_run_id: input.ai_run_id ?? null,
      unresolved_material_contradictions: (summary?.unresolved_material_contradictions ?? []).length,
    },
  });
  return (await getIcPacket(env, id))!;
}

/** The live (not snapshot) unresolved material contradictions for a packet's company. */
export async function currentUnresolvedContradictions(env: Env, packet: IcPacketRow): Promise<unknown[]> {
  const opportunity = await getOpportunity(env, packet.opportunity_id);
  if (!opportunity) return [];
  const rows = await env.WP_OS_DB.prepare(
    `SELECT * FROM contradiction_record
      WHERE company_id = ?1 AND status IN ('OPEN','INVESTIGATING') AND materiality IN ('HIGH','CRITICAL')
      ORDER BY created_at, id`,
  )
    .bind(opportunity.company_id)
    .all();
  return rows.results ?? [];
}

/** DRAFT → IN_REVIEW, creating + submitting the MP-reserved investment.approve card. */
export async function submitIcPacket(env: Env, actor: Actor, packetId: string): Promise<{ packet: IcPacketRow; approval_card_id: string }> {
  const packet = await getIcPacket(env, packetId);
  if (!packet) throw new InvestmentError(404, "not_found");
  if (packet.status !== "DRAFT") throw new InvestmentError(409, "illegal_state", `ic packet is ${packet.status}, not DRAFT`);
  const opportunity = await getOpportunity(env, packet.opportunity_id);
  const unresolved = await currentUnresolvedContradictions(env, packet);

  const card = await requestApproval(env, actor, {
    action_key: "investment.approve",
    object_type: "ic_packet",
    object_id: packetId,
    title: `investment.approve: IC packet for ${opportunity?.title ?? packet.opportunity_id}`,
    summary: `${unresolved.length} unresolved material contradiction(s) visible at submission`,
    payload: {
      ic_packet_id: packetId,
      opportunity_id: packet.opportunity_id,
      company_id: opportunity?.company_id ?? null,
      deal_math_packet_id: packet.deal_math_packet_id,
      unresolved_material_contradictions: unresolved.length,
    },
    firm_scope: packet.firm_scope,
    submit: true,
  });

  await env.WP_OS_DB.prepare("UPDATE ic_packet SET status = 'IN_REVIEW' WHERE id = ?1").bind(packetId).run();
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "ic.packet_submitted",
    actorType,
    actorId,
    objectType: "ic_packet",
    objectId: packetId,
    firmScope: packet.firm_scope,
    payload: { approval_card_id: card.id, unresolved_material_contradictions: unresolved.length },
  });
  return { packet: (await getIcPacket(env, packetId))!, approval_card_id: card.id };
}

/**
 * Record an IC decision. APPROVE requires an approved receipt for this packet;
 * REJECT/DEFER require an MP and resolve the pending card through the approval
 * state machine. AI actors are denied by authorize() (investment.approve is reserved).
 */
export async function recordIcDecision(
  env: Env,
  actor: Actor,
  packetId: string,
  decision: IcDecisionKind,
  rationale?: string,
  receiptId?: string,
): Promise<IcDecisionRow> {
  const packet = await getIcPacket(env, packetId);
  if (!packet) throw new InvestmentError(404, "not_found");
  if (packet.status === "DECIDED") throw new InvestmentError(409, "illegal_state", "ic packet is already DECIDED");

  const authz = await authorize(
    env,
    actor,
    "investment.approve",
    { objectType: "ic_packet", objectId: packetId, firmScope: packet.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);
  if (decision === "APPROVE" && authz.decision !== "ALLOW") {
    // No valid receipt: an IC APPROVE can never be recorded on role alone.
    throw new InvestmentError(409, "approval_required", authz.reason);
  }

  const decisionId = `icd_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO ic_decision (id, ic_packet_id, decision, decided_by, rationale, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(decisionId, packetId, decision, actor.firmUserId!, rationale ?? null, packet.firm_scope)
    .run();

  if (decision === "APPROVE") {
    await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
    await env.WP_OS_DB.prepare("UPDATE ic_packet SET status = 'DECIDED' WHERE id = ?1").bind(packetId).run();
  } else {
    // Resolve any pending card so no approval is left dangling for a decided packet.
    const card = await pendingCardFor(env, packetId);
    if (card && card.state === "pending_review") {
      await decideApproval(env, actor, card.id, decision === "REJECT" ? "rejected" : "revise_requested", rationale);
    }
    await env.WP_OS_DB.prepare("UPDATE ic_packet SET status = ?2 WHERE id = ?1")
      .bind(packetId, decision === "REJECT" ? "DECIDED" : "DRAFT")
      .run();
  }

  await appendEvent(env, {
    eventType: "ic.decision_recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ic_decision",
    objectId: decisionId,
    firmScope: packet.firm_scope,
    payload: {
      ic_packet_id: packetId,
      opportunity_id: packet.opportunity_id,
      decision,
      receipt_id: decision === "APPROVE" ? (authz.receiptId ?? null) : null,
    },
  });

  // APPROVE/REJECT conclude the opportunity's IC stage; DEFER leaves it open.
  if (decision !== "DEFER") {
    const opportunity = await getOpportunity(env, packet.opportunity_id);
    if (opportunity && opportunity.status === "IC_READY") {
      await transitionOpportunity(env, actor, opportunity.id, "IC_DECIDED");
    }
  }

  return (await env.WP_OS_DB.prepare("SELECT * FROM ic_decision WHERE id = ?1").bind(decisionId).first<IcDecisionRow>())!;
}

/** Attach a dissent record to a decision (human only; append-only). */
export async function recordDissent(env: Env, actor: Actor, icDecisionId: string, dissentText: string) {
  const decision = await env.WP_OS_DB.prepare("SELECT * FROM ic_decision WHERE id = ?1").bind(icDecisionId).first<IcDecisionRow>();
  if (!decision) throw new InvestmentError(404, "not_found");
  if (actor.type !== "HUMAN") throw new InvestmentError(403, "forbidden", "dissent is a human judgment record");
  const authz = await authorize(env, actor, "dissent.create", {
    objectType: "dissent_record",
    firmScope: decision.firm_scope,
  });
  if (authz.decision === "DENY") throw new InvestmentError(403, "forbidden", authz.reason);

  const id = `dsr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO dissent_record (id, ic_decision_id, dissenter_id, dissent_text, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, icDecisionId, actor.firmUserId!, dissentText, decision.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "ic.dissent_recorded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "dissent_record",
    objectId: id,
    firmScope: decision.firm_scope,
    payload: { ic_decision_id: icDecisionId, ic_packet_id: decision.ic_packet_id },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM dissent_record WHERE id = ?1").bind(id).first();
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

const assembleSchema = z.object({
  opportunity_id: z.string().trim().min(1),
  deal_math_packet_id: z.string().trim().min(1).optional(),
});

export async function handleAssembleIcPacket(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = assembleSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const packet = await assembleIcPacket(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      parsed.data,
      privacyVisibilityClause(ctx.identity!, "privacy_label"),
    );
    return json(packet, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListIcPackets(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const opportunityId = url.searchParams.get("opportunity_id");
  const rows = opportunityId
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM ic_packet WHERE opportunity_id = ?1 ORDER BY created_at DESC, id").bind(opportunityId).all<IcPacketRow>()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM ic_packet ORDER BY created_at DESC, id LIMIT 500").all<IcPacketRow>();
  return json({ ic_packets: rows.results ?? [] });
}

/**
 * A packet read ALWAYS carries the current unresolved material contradictions —
 * not just the assembly-time snapshot — so late contradictions cannot be hidden
 * from the decision.
 */
export async function handleGetIcPacket(ctx: RouteContext): Promise<Response> {
  const packet = await getIcPacket(ctx.env, ctx.params.id!);
  if (!packet) return json({ error: "not_found" }, { status: 404 });
  const decisions = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ic_decision WHERE ic_packet_id = ?1 ORDER BY created_at, id")
    .bind(packet.id)
    .all<IcDecisionRow>();
  const decisionIds = (decisions.results ?? []).map((d) => d.id);
  const dissents = decisionIds.length
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM dissent_record WHERE ic_decision_id IN (${decisionIds.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY created_at, id`,
      )
        .bind(...decisionIds)
        .all()
    : { results: [] };
  const dealMath = packet.deal_math_packet_id ? await getDealMathPacket(ctx.env, packet.deal_math_packet_id) : null;
  return json({
    ...packet,
    deal_math_packet: dealMath,
    unresolved_material_contradictions_current: await currentUnresolvedContradictions(ctx.env, packet),
    decisions: decisions.results ?? [],
    dissents: dissents.results ?? [],
  });
}

export async function handleSubmitIcPacket(ctx: RouteContext): Promise<Response> {
  try {
    return json(await submitIcPacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

const decideSchema = z.object({
  decision: z.enum(IC_DECISIONS),
  rationale: z.string().optional(),
  receipt_id: z.string().trim().min(1).optional(),
});

export async function handleRecordIcDecision(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const decision = await recordIcDecision(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.data.decision,
      parsed.data.rationale,
      parsed.data.receipt_id,
    );
    return json(decision, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const dissentSchema = z.object({ dissent_text: z.string().trim().min(1) });

export async function handleRecordDissent(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = dissentSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await recordDissent(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.dissent_text), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
