import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { consumeApprovalCard, decideApproval, requestApproval } from "./approvals";
import { getEvidenceSummary } from "./evidence";
import { InvestmentError, getDealMathPacket, getOpportunity, transitionOpportunity } from "./investment";
import { createWorkCardInternal } from "./workCards";
import type { FirmUserIdentity } from "../auth";

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
  /** Added by migration 0030 — the framework a packet of this kind is expected to cover. */
  sector: string;
  /** Added by migration 0030. The seat carrying the deal, and therefore barred from the bear case. */
  champion_user_id: string | null;
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

  /*
   * A REJECTION CARRIES ITS REASON, and it is checked HERE rather than by the transition below.
   * `ic_decision` is append-only: if the pass transition refused after the decision row was
   * written, the committee's verdict would be on the record with the deal stranded at IC_READY and
   * no way to withdraw either. Checking first means the whole act succeeds or none of it happens.
   */
  if (decision === "REJECT" && (rationale ?? "").trim().length < 12) {
    throw new InvestmentError(
      400,
      "reason_required",
      "Say why the committee is passing, in a sentence. A pass with no reason is worth nothing when they come back.",
    );
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

  /*
   * THE DECISION WRITES BACK TO THE DEAL (ADR-019), and a rejection lands in the pass pile.
   *
   * This used to send both APPROVE and REJECT to IC_DECIDED, and that stranded every deal the
   * committee turned down: IC_DECIDED can only move on to CLOSED or WITHDRAWN, so the one forward
   * move available to a rejected deal said the fund had invested in it. A pass is a decision with a
   * reason and belongs on the visible pass pile, where it stays readable and where PASS → SCREENING
   * already exists for the day the company comes back raising.
   *
   * Nothing is deleted and nothing is hidden. DEFER leaves the deal exactly where it is, because
   * "not yet" is not an exit.
   */
  if (decision !== "DEFER") {
    const opportunity = await getOpportunity(env, packet.opportunity_id);
    if (opportunity && opportunity.status === "IC_READY") {
      await transitionOpportunity(
        env,
        actor,
        opportunity.id,
        decision === "APPROVE" ? "IC_DECIDED" : "PASS",
        decision === "APPROVE" ? undefined : (rationale ?? ""),
      );
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

// ── ADR-019: what happens when a deal reaches the committee ──────────────────

/**
 * Poppy. The IC Facilitator holds `ic_decision` and `ic_learning_loop`, and assembling the packet is
 * literally her stated job — so the card that says "assemble it" is hers, by name, rather than
 * landing on whoever opens the page first.
 */
export const IC_FACILITATOR = "Poppy";

/** "Internal investment-decision workflows: evidence, dissent, decision capture, final rationale." */
export const IC_DECISION_MACHINE = 18;

/** The seat that carries a deal in, and therefore the seat barred from arguing against it. */
export const IC_CHAMPION_SEAT = "Pierce";

/** The seat that keeps what the firm knows about a company straight. */
export const IC_ANALYST_SEAT = "Wyatt";

export interface OpenQuestionRow {
  id: string;
  ic_packet_id: string;
  section_id: string | null;
  question: string;
  because: string;
  owed_by_kind: "PARTNER" | "CHAMPION" | "AI_EMPLOYEE" | "COUNTERPARTY" | "UNASSIGNED";
  owed_by: string | null;
  state: "OPEN" | "ANSWERED" | "WITHDRAWN";
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
  withdrawn_reason: string | null;
  firm_scope: string;
  created_at: string;
}

/** One gap, before it is written down. */
export interface DraftedQuestion {
  section_id: string | null;
  question: string;
  because: string;
  owed_by_kind: OpenQuestionRow["owed_by_kind"];
  owed_by: string | null;
}

/**
 * The gaps a packet drafted from the record will always have, worked out from the record itself.
 *
 * DETERMINISTIC, AND THAT IS THE POINT. No model is asked what is missing, because a model asked
 * that question will answer it — plausibly, and in prose that reads exactly like the parts of the
 * packet that are true. Every question below is the direct consequence of a row that is absent or a
 * count that is above zero, so it can be checked by looking.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is restate the diligence framework. `icReadiness()` already names
 * the sections still open, by name and never as a percentage; copying all eighteen in here as
 * questions would bury the six gaps that a section answer cannot supply.
 */
export async function draftOpenQuestions(env: Env, packet: IcPacketRow): Promise<DraftedQuestion[]> {
  const opportunity = await getOpportunity(env, packet.opportunity_id);
  const companyId = opportunity?.company_id ?? null;
  const out: DraftedQuestion[] = [];

  const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
    Number((await env.WP_OS_DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);

  // THE BEAR CASE, ALWAYS AND FIRST. It is the one question a packet is never allowed to be missing
  // quietly, and the one the champion may not answer — the firm's own rule, in icPortal.ts.
  out.push({
    section_id: "kill_case",
    question: "What is the strongest argument that we should NOT invest?",
    because:
      `${IC_CHAMPION_SEAT} carries this deal, so the case against it has to be written by somebody else. ` +
      "A committee where nobody argues the other side is a sales meeting for the investment.",
    owed_by_kind: "PARTNER",
    owed_by: null,
  });

  if (!packet.champion_user_id) {
    out.push({
      section_id: null,
      question: "Who is carrying this deal into the committee?",
      because:
        "No champion is named on the packet. Until somebody is, nothing is barred from the bear case " +
        "and nobody owes the answers below.",
      owed_by_kind: "PARTNER",
      owed_by: null,
    });
  }

  if (!packet.deal_math_packet_id) {
    out.push({
      section_id: "return_math",
      question: "What does this cost us, what do we own at close, and what would it have to return?",
      because:
        "No deal math is attached to this opportunity, so the packet carries no valuation, no cheque " +
        "size and no ownership figure. Manual entry is a supported path — the numbers do not have to " +
        "be calculated to be recorded.",
      owed_by_kind: "CHAMPION",
      owed_by: IC_CHAMPION_SEAT,
    });
  }

  if (companyId) {
    const unsourced = await count(
      `SELECT COUNT(*) AS n FROM diligence_claim c
        WHERE c.company_id = ?1 AND c.superseded_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM claim_source s WHERE s.claim_id = c.id)`,
      companyId,
    );
    if (unsourced > 0) {
      out.push({
        section_id: null,
        question: `Which of the ${unsourced} unsourced claim${unsourced === 1 ? "" : "s"} in the memo can we actually stand behind?`,
        because:
          "An unsourced claim is an assertion, not evidence. They are in the packet because hiding " +
          "them would be worse, and they are named here because a committee should know which parts " +
          "of the case have nothing under them.",
        owed_by_kind: "AI_EMPLOYEE",
        owed_by: IC_ANALYST_SEAT,
      });
    }

    const contradictions = await count(
      `SELECT COUNT(*) AS n FROM contradiction_record
        WHERE company_id = ?1 AND status IN ('OPEN','INVESTIGATING') AND materiality IN ('HIGH','CRITICAL')`,
      companyId,
    );
    if (contradictions > 0) {
      out.push({
        section_id: null,
        question: `The record contradicts itself in ${contradictions} material place${contradictions === 1 ? "" : "s"}. Which reading is right?`,
        because:
          "Contradictions travel with the packet deliberately. A packet that quietly drops them is " +
          "how a committee agrees on something the evidence does not support.",
        owed_by_kind: "PARTNER",
        owed_by: null,
      });
    }

    const metrics = await count("SELECT COUNT(*) AS n FROM portfolio_metric_snapshot WHERE company_id = ?1", companyId);
    if (metrics === 0) {
      out.push({
        section_id: "traction",
        question: "What are the company's numbers, and as of when?",
        because:
          "No metric has ever been recorded for this company, so the packet has nothing to show for " +
          "traction. A figure quoted in the room without a date is the one that gets believed longest.",
        owed_by_kind: "CHAMPION",
        owed_by: IC_CHAMPION_SEAT,
      });
    }
  }

  return out;
}

/** Write drafted questions. Existing ones are left exactly as they are — re-drafting tops up. */
export async function recordOpenQuestions(
  env: Env,
  actor: Actor,
  packet: IcPacketRow,
  questions: readonly DraftedQuestion[],
): Promise<number> {
  const existing = await env.WP_OS_DB.prepare(
    "SELECT question FROM ic_open_question WHERE ic_packet_id = ?1",
  )
    .bind(packet.id)
    .all<{ question: string }>();
  const seen = new Set((existing.results ?? []).map((r) => r.question));

  const { actorType, actorId } = eventActor(actor);
  let written = 0;
  for (const q of questions) {
    if (seen.has(q.question)) continue;
    seen.add(q.question);
    await env.WP_OS_DB.prepare(
      `INSERT INTO ic_open_question
         (id, ic_packet_id, section_id, question, because, owed_by_kind, owed_by,
          raised_by_type, raised_by_id, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        `icq_${crypto.randomUUID()}`, packet.id, q.section_id, q.question, q.because,
        q.owed_by_kind, q.owed_by,
        actor.type === "AI" ? "AI" : actor.type === "HUMAN" ? "HUMAN" : "SYSTEM",
        actorId, packet.firm_scope,
      )
      .run();
    written += 1;
  }
  if (written > 0) {
    await appendEvent(env, {
      eventType: "ic.questions_drafted",
      actorType,
      actorId,
      objectType: "ic_packet",
      objectId: packet.id,
      firmScope: packet.firm_scope,
      payload: { drafted: written },
    });
  }
  return written;
}

export interface IcStageOpened {
  packet: IcPacketRow;
  /** Null when a packet was already open — re-entering the stage never mints a second one. */
  work_card_id: string | null;
  questions_drafted: number;
  already_open: boolean;
}

/**
 * A deal has reached the committee stage.
 *
 * ONE STAGE TRANSITION IS THE WHOLE TRIGGER (ADR-019). `DILIGENCE → IC_READY` on the Dealflow spine
 * creates the packet in DRAFT and opens a work card for Poppy to assemble it. Nothing here decides
 * anything, answers anything, or moves the deal any further — the card is the mechanism, exactly as
 * an inbound email opens a card for the analyst rather than quietly creating a company.
 *
 * RE-ENTERING THE STAGE DOES NOT MINT A SECOND PACKET. A deal deferred by the committee goes back to
 * DRAFT and comes round again; a second packet would split its questions, its answers and its
 * audit trail across two records that both look authoritative.
 */
export async function openIcStage(env: Env, actor: Actor, opportunityId: string): Promise<IcStageOpened> {
  const open = await env.WP_OS_DB.prepare(
    "SELECT * FROM ic_packet WHERE opportunity_id = ?1 AND status <> 'DECIDED' ORDER BY created_at DESC, id LIMIT 1",
  )
    .bind(opportunityId)
    .first<IcPacketRow>();
  if (open) {
    return { packet: open, work_card_id: null, questions_drafted: 0, already_open: true };
  }

  const packet = await assembleIcPacket(env, actor, { opportunity_id: opportunityId });
  const drafted = await recordOpenQuestions(env, actor, packet, await draftOpenQuestions(env, packet));
  const opportunity = await getOpportunity(env, opportunityId);

  /*
   * The identity a stage-triggered card is filed under.
   *
   * Nobody typed this in; the deal moved and the card followed. Attributing it to whoever pressed
   * the stage button would put their name on work they did not create. It carries MANAGING_PARTNER
   * for the same reason the inbound-mail identity does: `work_card.create` is authorized per actor,
   * and a card that cannot be created is a deal that silently arrives at committee with nobody
   * told. The card itself asserts nothing and decides nothing.
   */
  const systemIdentity: FirmUserIdentity = {
    id: "system:ic_stage",
    email: "os@westpeek.ventures",
    fullName: "The deal pipeline",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: packet.firm_scope }],
  };

  const card = await createWorkCardInternal(env, systemIdentity, {
    title: `Assemble the IC packet: ${opportunity?.title ?? opportunityId}`,
    description: [
      `${opportunity?.title ?? opportunityId} reached the committee stage, so a packet was opened in draft.`,
      "",
      "Draft it from what the firm already holds — verified claims, diligence answers, portfolio",
      "metrics, deal math. Everything the record does not contain is a QUESTION for the partners and",
      "is never filled in from your own reasoning. A packet that invents its missing half is worse",
      "than a short one: it reads as complete, so nobody goes looking.",
      "",
      drafted > 0
        ? `${drafted} gap${drafted === 1 ? " was" : "s were"} already named from the record. Add any others you find.`
        : "No gaps were found in the record at the moment it arrived. Check that again as diligence lands.",
    ].join("\n"),
    owner_type: "AI",
    owner_id: IC_FACILITATOR,
    machine_id: IC_DECISION_MACHINE,
    firm_scope: packet.firm_scope,
    next_action: "Assemble the packet from the record, and name every gap as a question rather than filling it in.",
    prompt:
      "You facilitate and you never decide. Raise the contradiction nobody wants to raise, record " +
      "dissent as dissent rather than smoothing it into consensus, and leave the answer to the " +
      "partners. The deal champion may not write the case against the investment — if the bear case " +
      "comes back written by the champion, refuse it and say why.",
  });

  await appendEvent(env, {
    eventType: "ic.stage_opened",
    actorType: "system",
    actorId: "system:ic_stage",
    objectType: "ic_packet",
    objectId: packet.id,
    firmScope: packet.firm_scope,
    payload: { opportunity_id: opportunityId, work_card_id: card.id, questions_drafted: drafted },
  });

  return { packet, work_card_id: card.id, questions_drafted: drafted, already_open: false };
}

/** Every question on a packet, oldest first — answered and withdrawn ones included. */
export async function listOpenQuestions(env: Env, packetId: string): Promise<OpenQuestionRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT * FROM ic_open_question WHERE ic_packet_id = ?1 ORDER BY created_at, id",
  )
    .bind(packetId)
    .all<OpenQuestionRow>();
  return rows.results ?? [];
}

/**
 * Answer a question, or withdraw one the firm decided it does not need.
 *
 * WITHDRAWING IS NOT ANSWERING, and they are separate states for a reason: a packet that could
 * close its gaps by shrugging would show the same clean surface as one that did the work.
 */
export async function resolveOpenQuestion(
  env: Env,
  actor: Actor,
  questionId: string,
  input: { state: "ANSWERED" | "WITHDRAWN"; answer?: string; withdrawn_reason?: string },
): Promise<OpenQuestionRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM ic_open_question WHERE id = ?1")
    .bind(questionId)
    .first<OpenQuestionRow>();
  if (!row) throw new InvestmentError(404, "not_found");
  if (actor.type !== "HUMAN") {
    throw new InvestmentError(403, "forbidden", "A gap in the packet is closed by a person, not by the thing that found it.");
  }
  const authz = await authorize(env, actor, "ic_packet.question.answer", {
    objectType: "ic_packet",
    objectId: row.ic_packet_id,
    firmScope: row.firm_scope ?? "west-peek",
  });
  if (authz.decision !== "ALLOW") throw new InvestmentError(403, "forbidden", authz.reason);
  if (row.state !== "OPEN") throw new InvestmentError(409, "illegal_state", `this question is already ${row.state.toLowerCase()}`);

  if (input.state === "ANSWERED" && !input.answer?.trim()) {
    throw new InvestmentError(400, "empty_answer", "An answered question needs an answer.");
  }
  if (input.state === "WITHDRAWN" && !input.withdrawn_reason?.trim()) {
    throw new InvestmentError(400, "reason_required", "Say why the committee does not need this answered.");
  }

  // THE CHAMPION MAY NOT CLOSE THE BEAR CASE, for the same reason he may not write it. The rule is
  // enforced here rather than only in the interface, because an interface rule is a suggestion.
  const packet = await getIcPacket(env, row.ic_packet_id);
  if (
    row.section_id === "kill_case" &&
    packet?.champion_user_id &&
    packet.champion_user_id === actor.firmUserId
  ) {
    throw new InvestmentError(
      409,
      "champion_may_not_answer",
      "You are carrying this deal, so you cannot write the case against it. Someone else has to argue the other side — otherwise IC becomes a sales meeting for the investment.",
    );
  }

  await env.WP_OS_DB.prepare(
    `UPDATE ic_open_question
        SET state = ?2, answer = ?3, withdrawn_reason = ?4, answered_by = ?5,
            answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  )
    .bind(
      questionId, input.state,
      input.state === "ANSWERED" ? input.answer!.trim() : null,
      input.state === "WITHDRAWN" ? input.withdrawn_reason!.trim() : null,
      actor.firmUserId!,
    )
    .run();

  await appendEvent(env, {
    eventType: input.state === "ANSWERED" ? "ic.question_answered" : "ic.question_withdrawn",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ic_packet",
    objectId: row.ic_packet_id,
    firmScope: row.firm_scope ?? "west-peek",
    payload: { question_id: questionId, section_id: row.section_id },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM ic_open_question WHERE id = ?1").bind(questionId).first<OpenQuestionRow>())!;
}

export interface CommitteeSeat {
  name: string;
  /** What they do in the room, in a sentence. */
  role: string;
  /** True for the seats that actually decide. Everybody else prepares, records or answers. */
  decides: boolean;
}

/**
 * Who is in the room, derived rather than stored.
 *
 * A "seat the committee" table would be a list somebody has to remember to fill in, and an IC whose
 * membership is out of date is worse than one with none written down. Every seat below is a fact the
 * system already holds: the Managing Partners decide because that is what the role means, Poppy
 * facilitates because that is her job, and the champion is whoever is named on the packet.
 */
export async function committeeSeats(env: Env, packet: IcPacketRow | null): Promise<CommitteeSeat[]> {
  const partners = await env.WP_OS_DB.prepare(
    `SELECT u.id, u.full_name FROM firm_user u
       JOIN firm_user_role r ON r.firm_user_id = u.id
       JOIN role ro ON ro.id = r.role_id
      WHERE ro.key = 'MANAGING_PARTNER' AND u.status = 'ACTIVE'
      ORDER BY u.full_name`,
  ).all<{ id: string; full_name: string }>();

  const seats: CommitteeSeat[] = (partners.results ?? []).map((p) => ({
    name: p.full_name,
    role: "Decides. The committee is the two of them.",
    decides: true,
  }));

  const facilitator = await env.WP_OS_DB.prepare("SELECT name, status FROM ai_employee WHERE name = ?1")
    .bind(IC_FACILITATOR)
    .first<{ name: string; status: string }>();
  if (facilitator) {
    seats.push({
      name: facilitator.name,
      role:
        facilitator.status === "ACTIVE"
          ? "Assembles the packet, raises the contradiction nobody wants to raise, and records the dissent. Never decides."
          : "Would assemble the packet and record the dissent, and is currently switched off. The committee can still meet; nobody will prepare it or write it down.",
      decides: false,
    });
  }

  if (packet?.champion_user_id) {
    const champion = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1")
      .bind(packet.champion_user_id)
      .first<{ full_name: string }>();
    if (champion) {
      seats.push({
        name: champion.full_name,
        role: "Carries the deal in, and is therefore barred from writing the case against it.",
        decides: false,
      });
    }
  }

  return seats;
}

export interface IcDealView {
  opportunity_id: string;
  title: string;
  company_name: string | null;
  /** The record on Dealflow opens by company, so the committee band needs the id to open it. */
  company_id: string | null;
  /** Plain English, never the stored value. */
  stage: string;
  packet_id: string | null;
  packet_state: string;
  questions: OpenQuestionRow[];
  open_question_count: number;
  seats: CommitteeSeat[];
  /**
   * The latest decision on the packet. `id` travels because dissent is recorded AGAINST a decision:
   * a surface that shows the verdict without the handle to disagree with it is a surface that only
   * records agreement.
   */
  decision: { id: string; decision: string; rationale: string | null; created_at: string; decided_by: string } | null;
  /**
   * WHAT THE COMMITTEE ACTUALLY SAW, counted rather than described.
   *
   * A packet is a snapshot of the record on the day it was assembled, and "the committee has a
   * packet" is not the same statement as "the committee saw the four contradictions that were open
   * when it was written". Both counts travel: the number at assembly and the number right now, so a
   * contradiction raised AFTER the packet was drafted cannot reach the decision unannounced.
   */
  packet_evidence: {
    assembled_at: string;
    /** A name, never an id, and never a raw HUMAN/AI marker. */
    drafted_by: string;
    claims_seen: number;
    claims_unsourced: number;
    contradictions_at_assembly: number;
    contradictions_now: number;
    deal_math_attached: boolean;
  } | null;
  /**
   * DISSENT, KEPT WHOLE.
   *
   * It travels beside the decision rather than inside it, and it is never folded into the
   * rationale — a committee that records "we agreed" over a partner who did not is a committee
   * whose record is wrong about the one thing worth going back for. `dissent_record` is append-only
   * at the database, and this read never summarises it.
   */
  dissents: Array<{ id: string; decision: string; dissenter: string; dissent_text: string; created_at: string }>;
  /** The card Poppy holds for this packet, so the page can say whether anybody has started. */
  facilitator_card: { id: string; state: string; title: string } | null;
  /**
   * The approval card gating this packet, if it has been put in front of the partners.
   *
   * Sent because an IC APPROVE can never be recorded on role alone — it needs the receipt, and a
   * surface that offers the button without holding the receipt is offering a 409.
   */
  approval_card: { id: string; state: string } | null;
}

/** How a packet's state reads to somebody who has never seen this system. */
function packetStateInWords(status: string | null): string {
  switch (status) {
    case "DRAFT": return "Being assembled";
    case "IN_REVIEW": return "In front of the partners";
    case "DECIDED": return "Decided";
    default: return "No packet yet";
  }
}

/** What the committee did, in the words a partner would use. The stored value never reaches a page. */
export function decisionInWords(decision: string): string {
  switch (decision) {
    case "APPROVE": return "The firm is investing";
    case "REJECT": return "The firm passed";
    case "DEFER": return "Not yet";
    default: return decision.split("_").join(" ").toLowerCase();
  }
}

/**
 * A person's name from whichever roster they are on.
 *
 * Two rosters, one question. `drafted_by_id` and `dissenter_id` hold a firm user id or an employee
 * id depending on who acted, and printing either raw is exactly the defect this file has already
 * paid for twice — the id/name divergence that made Poppy's work card invisible. Unresolvable ids
 * come back as a sentence rather than as the id itself.
 */
async function nameFor(env: Env, kind: "HUMAN" | "AI" | "SYSTEM", id: string | null): Promise<string> {
  if (!id) return "Nobody recorded";
  if (kind === "AI") {
    const row = await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1 OR name = ?1").bind(id).first<{ name: string }>();
    return row?.name ?? "An employee whose seat has since been removed";
  }
  const row = await env.WP_OS_DB.prepare("SELECT full_name FROM firm_user WHERE id = ?1").bind(id).first<{ full_name: string }>();
  return row?.full_name ?? "Somebody who has since left the firm";
}

function stageInWords(status: string): string {
  switch (status) {
    case "IC_READY": return "At the committee";
    case "IC_DECIDED": return "The committee has decided";
    case "PASS": return "Passed";
    case "CLOSED": return "Invested";
    default: return status.split("_").join(" ").toLowerCase();
  }
}

/**
 * Every deal that is at, or has been through, the committee — with what it is waiting on.
 *
 * This is the read behind the IC section of the Meetings page. It answers the operator's question
 * directly: what happens to the page once a deal is at the IC stage. What happens is that it appears
 * here, with its packet, its unanswered questions and who owes each one.
 */
export async function icDealSurface(env: Env, opportunityId?: string): Promise<IcDealView[]> {
  /*
   * ONE READ, TWO CALLERS. Meetings asks for every deal at committee; a deal record asks about the
   * one deal it is showing. Giving the record its own query would let the two surfaces drift into
   * disagreeing about the same deal, which is the failure the whole committee section exists to
   * prevent — so the filter is a bind, not a second function.
   */
  const deals = opportunityId
    ? await env.WP_OS_DB.prepare(
        `SELECT o.id, o.title, o.status, o.company_id, c.canonical_name
           FROM investment_opportunity o
           LEFT JOIN canonical_company c ON c.id = o.company_id
          WHERE o.id = ?1`,
      )
        .bind(opportunityId)
        .all<{ id: string; title: string; status: string; company_id: string | null; canonical_name: string | null }>()
    : await env.WP_OS_DB.prepare(
        `SELECT o.id, o.title, o.status, o.company_id, c.canonical_name
           FROM investment_opportunity o
           LEFT JOIN canonical_company c ON c.id = o.company_id
          WHERE o.status IN ('IC_READY','IC_DECIDED')
             OR EXISTS (SELECT 1 FROM ic_packet p WHERE p.opportunity_id = o.id)
          ORDER BY o.created_at DESC, o.id
          LIMIT 50`,
      ).all<{ id: string; title: string; status: string; company_id: string | null; canonical_name: string | null }>();

  const out: IcDealView[] = [];
  for (const deal of deals.results ?? []) {
    const packet = await env.WP_OS_DB.prepare(
      "SELECT * FROM ic_packet WHERE opportunity_id = ?1 ORDER BY created_at DESC, id LIMIT 1",
    )
      .bind(deal.id)
      .first<IcPacketRow>();

    const questions = packet ? await listOpenQuestions(env, packet.id) : [];
    const decisions = packet
      ? (
          await env.WP_OS_DB.prepare(
            "SELECT id, decision, rationale, decided_by, created_at FROM ic_decision WHERE ic_packet_id = ?1 ORDER BY created_at DESC, id",
          )
            .bind(packet.id)
            .all<{ id: string; decision: string; rationale: string | null; decided_by: string; created_at: string }>()
        ).results ?? []
      : [];
    const latest = decisions[0] ?? null;
    const decision = latest
      ? {
          id: latest.id,
          decision: latest.decision,
          rationale: latest.rationale,
          created_at: latest.created_at,
          decided_by: await nameFor(env, "HUMAN", latest.decided_by),
        }
      : null;

    /*
     * DISSENT IS READ FOR EVERY DECISION ON THE PACKET, not just the last one.
     *
     * A deferred deal comes round again, so a packet can carry several decisions, and a dissent
     * recorded against the first one is exactly the thing somebody wants in front of them when the
     * second is being taken. Hanging dissent off `decision` alone would drop it the moment the
     * committee met twice.
     */
    const dissentRows = decisions.length
      ? (
          await env.WP_OS_DB.prepare(
            `SELECT d.id, d.ic_decision_id, d.dissenter_id, d.dissent_text, d.created_at
               FROM dissent_record d
              WHERE d.ic_decision_id IN (${decisions.map((_, i) => `?${i + 1}`).join(", ")})
              ORDER BY d.created_at DESC, d.id`,
          )
            .bind(...decisions.map((d) => d.id))
            .all<{ id: string; ic_decision_id: string; dissenter_id: string; dissent_text: string; created_at: string }>()
        ).results ?? []
      : [];
    const dissents: IcDealView["dissents"] = [];
    for (const row of dissentRows) {
      const against = decisions.find((d) => d.id === row.ic_decision_id);
      dissents.push({
        id: row.id,
        decision: decisionInWords(against?.decision ?? ""),
        dissenter: await nameFor(env, "HUMAN", row.dissenter_id),
        dissent_text: row.dissent_text,
        created_at: row.created_at,
      });
    }

    let packetEvidence: IcDealView["packet_evidence"] = null;
    if (packet) {
      let snapshot: { total_claims?: number; claims?: Array<unknown>; unresolved_material_contradictions?: unknown[] } = {};
      try {
        snapshot = JSON.parse(packet.evidence_summary_json || "{}");
      } catch {
        // A packet whose snapshot cannot be read still has to say so rather than vanish from the
        // record; the counts below fall back to zero and the page reports what it can.
        snapshot = {};
      }
      const claims = Array.isArray(snapshot.claims) ? (snapshot.claims as Array<{ id?: string }>) : [];
      const unsourced = claims.length
        ? Number(
            (
              await env.WP_OS_DB.prepare(
                `SELECT COUNT(*) AS n FROM diligence_claim c
                  WHERE c.id IN (${claims.map((_, i) => `?${i + 1}`).join(", ")})
                    AND NOT EXISTS (SELECT 1 FROM claim_source s WHERE s.claim_id = c.id)`,
              )
                .bind(...claims.map((c) => c.id ?? ""))
                .first<{ n: number }>()
            )?.n ?? 0,
          )
        : 0;
      packetEvidence = {
        assembled_at: packet.created_at,
        drafted_by: await nameFor(env, packet.drafted_by_type, packet.drafted_by_id),
        claims_seen: Number(snapshot.total_claims ?? claims.length),
        claims_unsourced: unsourced,
        contradictions_at_assembly: Array.isArray(snapshot.unresolved_material_contradictions)
          ? snapshot.unresolved_material_contradictions.length
          : 0,
        contradictions_now: (await currentUnresolvedContradictions(env, packet)).length,
        deal_math_attached: packet.deal_math_packet_id !== null,
      };
    }

    /*
     * THE OWNER IS LOOKED UP BY ID, because that is what the column holds.
     *
     * `IC_FACILITATOR` is the display name "Poppy". The card is CREATED through
     * `createWorkCardInternal`, which resolves an AI owner's name to their seat id — so the row
     * says `aie_poppy` and this read, binding "Poppy", matched nothing. Ever. The stage view
     * silently reported no packet-assembly card for every deal at committee, which reads as "the
     * card was never opened" rather than as a bug.
     *
     * Exactly the id/name divergence `validate:value-shapes` exists for, and the second time this
     * firm has paid for it — the first was the email intake path writing "Wyatt" into `owner_id`.
     * Resolved in the statement so the name and the id can never be typed apart again.
     */
    const card = packet
      ? await env.WP_OS_DB.prepare(
          /*
           * `=`, NOT `LIKE`, AND THIS ONE TOOK THE WHOLE SURFACE DOWN.
           *
           * The pattern carries no wildcard — it is the exact title this code composes — so LIKE was
           * only ever being used as equality. But D1 caps a LIKE pattern at 64 characters and
           * refuses anything longer with `LIKE or GLOB pattern too complex: SQLITE_ERROR`. The
           * prefix "Assemble the IC packet: " is 24 of those, so any deal whose title runs past
           * ~40 characters — an ordinary company name and a stage label — threw. The throw is not
           * caught per-deal: it propagates out of `icDealSurface`, `GET /api/ic/deals` answers 500,
           * and the Meetings page renders its empty state — "No deal has reached the committee.
           * That is not a fault" — for a committee with deals sitting in front of it.
           *
           * Equality has no such limit and is what was meant. Caught by `e2e/p6-investment.spec.ts`,
           * whose marker pushes the title past the cap exactly as a real company name does.
           */
          `SELECT id, state, title FROM work_card
            WHERE owner_type = 'AI'
              AND owner_id = (SELECT id FROM ai_employee WHERE name = ?1)
              AND title = ?2
            ORDER BY created_at DESC, id LIMIT 1`,
        )
          .bind(IC_FACILITATOR, `Assemble the IC packet: ${deal.title}`)
          .first<{ id: string; state: string; title: string }>()
      : null;

    out.push({
      opportunity_id: deal.id,
      title: deal.title,
      company_name: deal.canonical_name,
      company_id: deal.company_id,
      stage: stageInWords(deal.status),
      packet_id: packet?.id ?? null,
      packet_state: packetStateInWords(packet?.status ?? null),
      questions,
      open_question_count: questions.filter((q) => q.state === "OPEN").length,
      seats: await committeeSeats(env, packet ?? null),
      decision,
      packet_evidence: packetEvidence,
      dissents,
      facilitator_card: card ?? null,
      approval_card: packet ? await pendingCardFor(env, packet.id) : null,
    });
  }
  return out;
}

// ── HTTP handlers for the question surface ───────────────────────────────────

const raiseQuestionSchema = z.object({
  section_id: z.string().trim().max(60).nullish(),
  question: z.string().trim().min(8).max(500),
  because: z.string().trim().min(8).max(1000),
  owed_by_kind: z.enum(["PARTNER", "CHAMPION", "AI_EMPLOYEE", "COUNTERPARTY", "UNASSIGNED"]),
  owed_by: z.string().trim().max(200).nullish(),
});

/** GET /api/ic/packets/:id/questions */
export async function handleListIcQuestions(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  if (!packetId) return json({ error: "invalid_input" }, { status: 400 });
  return json({ questions: await listOpenQuestions(ctx.env, packetId) });
}

/** POST /api/ic/packets/:id/questions — name a gap. Naming one is never the same as filling it in. */
export async function handleRaiseIcQuestion(ctx: RouteContext): Promise<Response> {
  const packetId = ctx.params.id;
  const parsed = raiseQuestionSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!packetId || !parsed.success) {
    return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  }
  try {
    const packet = await getIcPacket(ctx.env, packetId);
    if (!packet) return json({ error: "not_found" }, { status: 404 });
    const actor = actorFromIdentity(ctx.identity!);
    const authz = await authorize(ctx.env, actor, "ic_packet.question.raise", {
      objectType: "ic_packet",
      objectId: packetId,
      firmScope: packet.firm_scope,
    });
    if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
    await recordOpenQuestions(ctx.env, actor, packet, [
      {
        section_id: parsed.data.section_id ?? null,
        question: parsed.data.question,
        because: parsed.data.because,
        owed_by_kind: parsed.data.owed_by_kind,
        owed_by: parsed.data.owed_by ?? null,
      },
    ]);
    return json({ questions: await listOpenQuestions(ctx.env, packetId) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const resolveQuestionSchema = z.object({
  state: z.enum(["ANSWERED", "WITHDRAWN"]),
  answer: z.string().trim().max(20_000).nullish(),
  withdrawn_reason: z.string().trim().max(1000).nullish(),
});

/** POST /api/ic/questions/:id/resolve */
export async function handleResolveIcQuestion(ctx: RouteContext): Promise<Response> {
  const questionId = ctx.params.id;
  const parsed = resolveQuestionSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!questionId || !parsed.success) {
    return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  }
  try {
    return json(
      await resolveOpenQuestion(ctx.env, actorFromIdentity(ctx.identity!), questionId, {
        state: parsed.data.state,
        answer: parsed.data.answer ?? undefined,
        withdrawn_reason: parsed.data.withdrawn_reason ?? undefined,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/ic/deals — every deal at or past the committee, and what each is waiting on. */
export async function handleIcDealSurface(ctx: RouteContext): Promise<Response> {
  // Poppy runs this. If she is switched off, the packet does not get assembled and nobody records
  // the dissent — a fact the committee band states rather than discovers mid-meeting. Read here
  // (as `/api/meetings` also does) so the band that moved to Dealflow does not have to fetch the
  // whole meetings list to learn one employee's status.
  const facilitator = await ctx.env.WP_OS_DB.prepare("SELECT name, status FROM ai_employee WHERE name = ?1")
    .bind(IC_FACILITATOR)
    .first<{ name: string; status: string }>();
  return json({ deals: await icDealSurface(ctx.env), facilitator: facilitator ?? null });
}

/**
 * GET /api/ic/deals/:id — the committee's view of ONE deal, for the deal's own record.
 *
 * `deal` is null rather than a 404 for an opportunity the committee has never seen, because "this
 * deal has not been to the committee" is an answer and a 404 is a malfunction. The record renders
 * the two states differently and cannot do that if they arrive the same way.
 */
export async function handleIcDealForOpportunity(ctx: RouteContext): Promise<Response> {
  const [deal] = await icDealSurface(ctx.env, ctx.params.id!);
  return json({ deal: deal ?? null });
}
