import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import type { FirmUserIdentity } from "../auth";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { isMachinePaused } from "./machines";
import { createWorkCardInternal } from "./workCards";
import { privacyLabelSchema } from "../../shared/privacy";
import { BLOCKING_LENSES, DEFAULT_LENS_STACK, LENS_BENCH, LENS_KEYS, lensDef } from "../../shared/registry/lenses";

/**
 * Intent-to-execution work packets + the Institutional Lens Bench (P18; GAP-08, GAP-09).
 *
 * The flow, in full:
 *   rough thought → interpretation → ambiguities → assumptions → risks → output definition →
 *   acceptance criteria → lens stack → employee → machine → capability → model → cost → execute
 *
 * Enhancement is DETERMINISTIC by default and is labelled as such. It never rewrites the
 * operator's own words: `original_text` is immutable at the database layer, and every derived
 * field lives in its own column beside it.
 *
 * The lens bench records structured products only — verdict, critique, evidence references,
 * summary. Nothing in this module can write a reasoning trace, because no such column exists.
 * The Truth/Compliance Gate is BLOCKING: an ADVERSE verdict moves the packet to
 * BLOCKED_BY_LENS and execution is refused until the work changes.
 */

export class PacketError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof PacketError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export interface WorkPacketRow {
  id: string;
  capture_id: string | null;
  original_text: string;
  enhancement_strength: string;
  interpretation: string;
  ambiguities_json: string;
  assumptions_json: string;
  risks_json: string;
  output_definition: string;
  acceptance_criteria_json: string;
  lens_stack_json: string;
  recommended_employee_id: string | null;
  machine_id: number | null;
  capability_keys_json: string;
  task_class: string | null;
  cost_estimate_usd: number | null;
  cost_basis: string;
  privacy_label: string;
  status: string;
  work_card_id: string | null;
  ai_run_id: string | null;
  enhancement_origin: string;
  created_by: string;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

// ── Deterministic enhancement ──

export interface EnhancementResult {
  interpretation: string;
  ambiguities: string[];
  assumptions: string[];
  risks: string[];
  output_definition: string;
  acceptance_criteria: string[];
}

const VAGUE_TERMS = ["asap", "soon", "some", "a few", "maybe", "better", "improve", "look into", "clean up", "etc"];
const RISK_TERMS: Array<{ term: string; risk: string }> = [
  { term: "lp", risk: "LP-facing content: publication needs evidence and the reserved marketing-claim approval." },
  { term: "legal", risk: "Legal content: West Peek OS may prepare but never issue a legal conclusion." },
  { term: "compliance", risk: "Compliance content: a conclusion here is human-reserved." },
  { term: "wire", risk: "Capital movement is human-reserved and can never be automated." },
  { term: "valuation", risk: "Valuation approval is MP-reserved; a computed figure is not an approved one." },
  { term: "founder", risk: "Founder-character judgement is MP-reserved." },
  { term: "introduce", risk: "Relationship-sensitive introductions are MP-reserved." },
];

/**
 * Deterministic intent enhancement. Same input, same output — no model involved.
 *
 * It reads the operator's text for: an explicit deliverable, a deadline, named entities, vague
 * terms, and topics that touch reserved authority. Everything it produces is derived from the
 * text in front of it, so an operator can always see why a line appeared.
 */
export function enhanceIntent(text: string, strength: "NONE" | "LIGHT" | "STANDARD" | "DEEP"): EnhancementResult {
  if (strength === "NONE") {
    return {
      interpretation: "",
      ambiguities: [],
      assumptions: [],
      risks: [],
      output_definition: "",
      acceptance_criteria: [],
    };
  }

  const lower = text.toLowerCase();
  const sentences = text
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const first = sentences[0] ?? text.trim();

  const ambiguities: string[] = [];
  const assumptions: string[] = [];
  const risks: string[] = [];
  const acceptance: string[] = [];

  for (const term of VAGUE_TERMS) {
    if (lower.includes(term)) ambiguities.push(`"${term}" is not specific enough to act on — say what and by when.`);
  }
  if (!/\b(by|before|due|deadline|today|tomorrow|week|month|q[1-4])\b/i.test(text)) {
    ambiguities.push("No deadline is stated. Assumed: no fixed date, so this is not urgent work.");
    assumptions.push("No deadline was given; treated as non-urgent.");
  }
  if (!/\b(memo|list|summary|packet|draft|analysis|model|deck|note|brief|report|answer)\b/i.test(text)) {
    ambiguities.push("The deliverable is not named. Assumed: a written summary.");
    assumptions.push("Deliverable assumed to be a written summary because none was named.");
  }

  for (const { term, risk } of RISK_TERMS) {
    if (lower.includes(term)) risks.push(risk);
  }
  if (risks.length === 0) risks.push("No reserved-authority topic detected in the text.");

  const outputDefinition =
    /\bmemo\b/i.test(text)
      ? "A written memo."
      : /\blist\b/i.test(text)
        ? "A list, with a line per item and its source."
        : /\banalys/i.test(text)
          ? "An analysis stating its inputs, method, and conclusion separately."
          : "A written summary of findings with sources.";

  acceptance.push("Every factual claim names where it came from.");
  acceptance.push("Anything uncertain is marked uncertain rather than smoothed over.");
  if (strength === "DEEP") {
    acceptance.push("A counter-case is stated, not just the supporting case.");
    acceptance.push("The output says explicitly what it does NOT cover.");
    assumptions.push("Deep enhancement: the packet is expected to survive hostile review before it is useful.");
  }
  if (risks.some((r) => r.includes("reserved"))) {
    acceptance.push("The output prepares a decision; it does not make one.");
  }

  const interpretation =
    strength === "LIGHT"
      ? `Interpreted as: ${first}`
      : `Interpreted as: ${first}. Derived deterministically from the operator's own text — no model produced this reading, and the original wording is preserved verbatim.`;

  return {
    interpretation,
    ambiguities,
    assumptions,
    risks,
    output_definition: outputDefinition,
    acceptance_criteria: acceptance,
  };
}

// ── Recommendation ──

/**
 * Recommend an employee/machine/capability for a packet, from records that exist:
 * an ACTIVE employee assigned to the machine, and the machine whose domain matches the topic.
 * Returns nulls rather than guessing when nothing qualifies.
 */
async function recommendRouting(
  env: Env,
  text: string,
): Promise<{ machineId: number | null; employeeId: string | null; capabilityKeys: string[]; why: string }> {
  const lower = text.toLowerCase();
  const machines = (
    await env.WP_OS_DB.prepare("SELECT id, key, name, purpose FROM machine").all<{ id: number; key: string; name: string; purpose: string }>()
  ).results ?? [];

  // Score by literal keyword overlap between the intent text and the machine's own purpose.
  let best: { id: number; score: number; name: string } | null = null;
  for (const m of machines) {
    const words = `${m.name} ${m.purpose}`
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 4);
    const score = new Set(words.filter((w) => lower.includes(w))).size;
    if (score > 0 && (!best || score > best.score)) best = { id: m.id, score, name: m.name };
  }
  if (!best) {
    return { machineId: null, employeeId: null, capabilityKeys: [], why: "No machine purpose overlapped the intent text; routing is left to the operator." };
  }

  const paused = await isMachinePaused(env, best.id);
  if (paused.paused) {
    return {
      machineId: null,
      employeeId: null,
      capabilityKeys: [],
      why: `${best.name} matched the intent but is PAUSED (${paused.reason ?? "no reason recorded"}); no machine is recommended.`,
    };
  }

  const employee = await env.WP_OS_DB.prepare(
    `SELECT e.id FROM ai_employee e
       JOIN ai_employee_assignment a ON a.ai_employee_id = e.id AND a.active = 1
      WHERE a.machine_id = ?1 AND e.status = 'ACTIVE' LIMIT 1`,
  )
    .bind(best.id)
    .first<{ id: string }>();

  const capabilities = (
    await env.WP_OS_DB.prepare(
      `SELECT c.capability_key FROM capability c
         JOIN capability_assignment a ON a.capability_id = c.id AND a.active = 1
        WHERE a.target_kind = 'MACHINE' AND a.target_id = ?1 AND c.state = 'ACTIVE'`,
    )
      .bind(String(best.id))
      .all<{ capability_key: string }>()
  ).results ?? [];

  return {
    machineId: best.id,
    employeeId: employee?.id ?? null,
    capabilityKeys: capabilities.map((c) => c.capability_key),
    why: `${best.name} matched ${best.score} term(s) from its own declared purpose${employee ? "; an ACTIVE employee is assigned to it" : "; no ACTIVE employee is assigned to it yet"}.`,
  };
}

// ── Packet lifecycle ──

const createSchema = z.object({
  text: z.string().trim().min(1),
  capture_id: z.string().trim().min(1).optional(),
  enhancement_strength: z.enum(["NONE", "LIGHT", "STANDARD", "DEEP"]).default("STANDARD"),
  lens_stack: z.array(z.enum(LENS_KEYS)).optional(),
  privacy_label: privacyLabelSchema.default("INTERNAL"),
});

export async function createPacket(env: Env, actor: Actor, body: z.infer<typeof createSchema>): Promise<WorkPacketRow> {
  const authz = await authorize(env, actor, "work_packet.create", { objectType: "work_packet" });
  if (authz.decision !== "ALLOW") throw new PacketError(403, "forbidden", authz.reason);

  const enhancement = enhanceIntent(body.text, body.enhancement_strength);
  const routing = await recommendRouting(env, body.text);
  const lensStack = body.lens_stack ?? [...DEFAULT_LENS_STACK];

  const id = `wpk_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_packet
       (id, capture_id, original_text, enhancement_strength, interpretation, ambiguities_json,
        assumptions_json, risks_json, output_definition, acceptance_criteria_json, lens_stack_json,
        recommended_employee_id, machine_id, capability_keys_json, cost_basis, privacy_label,
        enhancement_origin, created_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
  )
    .bind(
      id,
      body.capture_id ?? null,
      body.text,
      body.enhancement_strength,
      enhancement.interpretation,
      JSON.stringify(enhancement.ambiguities),
      JSON.stringify(enhancement.assumptions),
      JSON.stringify(enhancement.risks),
      enhancement.output_definition,
      JSON.stringify(enhancement.acceptance_criteria),
      JSON.stringify(lensStack),
      routing.employeeId,
      routing.machineId,
      JSON.stringify(routing.capabilityKeys),
      routing.why,
      body.privacy_label,
      body.enhancement_strength === "NONE" ? "NONE" : "DETERMINISTIC",
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      actor.firmScopes[0] ?? "west-peek",
    )
    .run();

  await appendRevision(env, id, actor, "packet created");
  await appendEvent(env, {
    eventType: "work_packet.created",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "work_packet",
    objectId: id,
    payload: { enhancement_strength: body.enhancement_strength, machine_id: routing.machineId, lens_stack: lensStack },
  });

  return (await getPacket(env, id))!;
}

async function getPacket(env: Env, id: string): Promise<WorkPacketRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM work_packet WHERE id = ?1").bind(id).first<WorkPacketRow>();
}

/**
 * A packet the caller may not READ is a packet they may not ACT ON. Without this, an unscoped
 * user could run a lens on, revise, or execute a RESTRICTED packet they cannot see — so the
 * mutation paths take the identity and apply the same SQL visibility clause the read path uses.
 */
async function getVisiblePacket(env: Env, identity: FirmUserIdentity, id: string): Promise<WorkPacketRow | null> {
  const visibility = privacyVisibilityClause(identity, "privacy_label");
  return env.WP_OS_DB.prepare(`SELECT * FROM work_packet WHERE id = ?1 AND ${visibility}`).bind(id).first<WorkPacketRow>();
}

async function appendRevision(env: Env, packetId: string, actor: Actor, note: string): Promise<void> {
  const packet = await getPacket(env, packetId);
  if (!packet) return;
  const last = await env.WP_OS_DB.prepare("SELECT MAX(version_no) AS v FROM work_packet_revision WHERE packet_id = ?1")
    .bind(packetId)
    .first<{ v: number | null }>();
  await env.WP_OS_DB.prepare(
    "INSERT INTO work_packet_revision (id, packet_id, version_no, snapshot_json, note, changed_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      `wpr_${crypto.randomUUID()}`,
      packetId,
      (last?.v ?? 0) + 1,
      JSON.stringify(packet),
      note,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
}

const updateSchema = z.object({
  interpretation: z.string().trim().optional(),
  output_definition: z.string().trim().optional(),
  acceptance_criteria: z.array(z.string().trim().min(1)).optional(),
  assumptions: z.array(z.string().trim().min(1)).optional(),
  risks: z.array(z.string().trim().min(1)).optional(),
  lens_stack: z.array(z.enum(LENS_KEYS)).optional(),
  machine_id: z.number().int().positive().nullable().optional(),
  recommended_employee_id: z.string().trim().min(1).nullable().optional(),
  capability_keys: z.array(z.string().trim().min(1)).optional(),
  task_class: z.string().trim().min(1).nullable().optional(),
  note: z.string().trim().min(1).optional(),
});

export async function updatePacket(
  env: Env,
  identity: FirmUserIdentity,
  id: string,
  body: z.infer<typeof updateSchema>,
): Promise<WorkPacketRow> {
  const actor = actorFromIdentity(identity);
  const packet = await getVisiblePacket(env, identity, id);
  if (!packet) throw new PacketError(404, "not_found");
  if (packet.status === "EXECUTING" || packet.status === "COMPLETE") {
    throw new PacketError(409, "illegal_state", `a ${packet.status} packet cannot be revised`);
  }
  const authz = await authorize(env, actor, "work_packet.update", { objectType: "work_packet", objectId: id });
  if (authz.decision !== "ALLOW") throw new PacketError(403, "forbidden", authz.reason);

  await env.WP_OS_DB.prepare(
    `UPDATE work_packet SET
       interpretation = ?2, output_definition = ?3, acceptance_criteria_json = ?4, assumptions_json = ?5,
       risks_json = ?6, lens_stack_json = ?7, machine_id = ?8, recommended_employee_id = ?9,
       capability_keys_json = ?10, task_class = ?11, updated_at = ?12
     WHERE id = ?1`,
  )
    .bind(
      id,
      body.interpretation ?? packet.interpretation,
      body.output_definition ?? packet.output_definition,
      body.acceptance_criteria ? JSON.stringify(body.acceptance_criteria) : packet.acceptance_criteria_json,
      body.assumptions ? JSON.stringify(body.assumptions) : packet.assumptions_json,
      body.risks ? JSON.stringify(body.risks) : packet.risks_json,
      body.lens_stack ? JSON.stringify(body.lens_stack) : packet.lens_stack_json,
      body.machine_id !== undefined ? body.machine_id : packet.machine_id,
      body.recommended_employee_id !== undefined ? body.recommended_employee_id : packet.recommended_employee_id,
      body.capability_keys ? JSON.stringify(body.capability_keys) : packet.capability_keys_json,
      body.task_class !== undefined ? body.task_class : packet.task_class,
      new Date().toISOString(),
    )
    .run();

  await appendRevision(env, id, actor, body.note ?? "packet revised");
  return (await getPacket(env, id))!;
}

// ── Lens bench ──

const lensSchema = z.object({
  lens_key: z.enum(LENS_KEYS),
  verdict: z.enum(["PASS", "CONCERN", "ADVERSE"]),
  critique: z.string().trim().min(1),
  summary: z.string().trim().default(""),
  evidence_refs: z.array(z.string().trim().min(1)).default([]),
  use_ai: z.boolean().default(false),
});

/**
 * Record a lens finding. When `use_ai` is set, the critique is drafted through the governed AI
 * boundary — and only an UNQUARANTINED completed run may supply it, because a quarantined output
 * is not yet governed content. In every case only the four declared product fields are stored.
 */
export async function runLens(env: Env, identity: FirmUserIdentity, packetId: string, body: z.infer<typeof lensSchema>) {
  const actor = actorFromIdentity(identity);
  const packet = await getVisiblePacket(env, identity, packetId);
  if (!packet) throw new PacketError(404, "not_found");
  const stack = JSON.parse(packet.lens_stack_json) as string[];
  if (!stack.includes(body.lens_key)) {
    throw new PacketError(409, "lens_not_in_stack", `${body.lens_key} is not part of this packet's lens stack`);
  }
  const authz = await authorize(env, actor, "lens.run", { objectType: "work_packet", objectId: packetId });
  if (authz.decision !== "ALLOW") throw new PacketError(403, "forbidden", authz.reason);

  const existing = await env.WP_OS_DB.prepare("SELECT id FROM lens_output WHERE packet_id = ?1 AND lens_key = ?2")
    .bind(packetId, body.lens_key)
    .first();
  if (existing) throw new PacketError(409, "lens_already_run", "a lens finding is append-only; revise the packet and open a new one");

  let critique = body.critique;
  let runId: string | null = null;
  let producedBy: "HUMAN" | "AI" | "DETERMINISTIC" = actor.type === "HUMAN" ? "HUMAN" : "AI";

  if (body.use_ai) {
    const def = lensDef(body.lens_key)!;
    const { run } = await runAi(env, {
      purpose: `lens ${body.lens_key}: ${def.job}`,
      actor,
      inputs: [
        `Original intent: ${packet.original_text}`,
        `Interpretation: ${packet.interpretation}`,
        `Output definition: ${packet.output_definition}`,
        `Produce: ${def.produces}`,
      ],
      sensitivity: (packet.privacy_label as never) ?? "INTERNAL",
      budgetContext: { judgement: true },
      routing: { taskClass: packet.task_class ?? undefined, machineId: packet.machine_id ?? undefined, category: "OPERATIONS" },
    });
    runId = run.id;
    if (run.status === "COMPLETED" && run.output_quarantine === 0 && run.output_text) {
      critique = run.output_text;
      producedBy = "AI";
    } else {
      // A quarantined or blocked run cannot supply the finding. The operator's own critique
      // stands, and the run id is recorded so the attempt is visible.
      producedBy = actor.type === "HUMAN" ? "HUMAN" : "AI";
    }
  }

  const id = `lout_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO lens_output (id, packet_id, lens_key, verdict, critique, summary, evidence_refs_json, produced_by_type, produced_by_id, ai_run_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      packetId,
      body.lens_key,
      body.verdict,
      critique,
      body.summary,
      JSON.stringify(body.evidence_refs),
      producedBy,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      runId,
    )
    .run();

  // A blocking lens with an ADVERSE verdict stops the packet until the work changes.
  if (body.verdict === "ADVERSE" && (BLOCKING_LENSES as readonly string[]).includes(body.lens_key)) {
    await env.WP_OS_DB.prepare("UPDATE work_packet SET status = 'BLOCKED_BY_LENS', updated_at = ?2 WHERE id = ?1")
      .bind(packetId, new Date().toISOString())
      .run();
  }

  await appendEvent(env, {
    eventType: "lens.recorded",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "work_packet",
    objectId: packetId,
    payload: { lens_key: body.lens_key, verdict: body.verdict, blocking: (BLOCKING_LENSES as readonly string[]).includes(body.lens_key) },
  });

  return {
    lens: await env.WP_OS_DB.prepare("SELECT * FROM lens_output WHERE id = ?1").bind(id).first(),
    packet: await getPacket(env, packetId),
  };
}

// ── Execution ──

/**
 * Execute an accepted packet. Refuses when:
 * - a blocking lens returned ADVERSE (the packet is BLOCKED_BY_LENS);
 * - a blocking lens in the stack has not run at all — silence is not a pass;
 * - the target machine is PAUSED.
 * On success it opens a governed work card and runs the task through `run_ai` with the packet's
 * task class, machine, and capability attribution.
 */
export async function executePacket(env: Env, identity: FirmUserIdentity, packetId: string) {
  const actor = actorFromIdentity(identity);
  const packet = await getVisiblePacket(env, identity, packetId);
  if (!packet) throw new PacketError(404, "not_found");
  if (packet.status === "COMPLETE" || packet.status === "EXECUTING") {
    throw new PacketError(409, "illegal_state", `packet is already ${packet.status}`);
  }
  if (packet.status === "BLOCKED_BY_LENS") {
    throw new PacketError(409, "blocked_by_lens", "a blocking lens returned ADVERSE; revise the packet and re-run the gate");
  }
  const authz = await authorize(env, actor, "work_packet.execute", { objectType: "work_packet", objectId: packetId });
  if (authz.decision !== "ALLOW") throw new PacketError(403, "forbidden", authz.reason);

  const stack = JSON.parse(packet.lens_stack_json) as string[];
  const outputs = (
    await env.WP_OS_DB.prepare("SELECT lens_key, verdict FROM lens_output WHERE packet_id = ?1").bind(packetId).all<{ lens_key: string; verdict: string }>()
  ).results ?? [];
  const missingBlocking = stack.filter(
    (k) => (BLOCKING_LENSES as readonly string[]).includes(k) && !outputs.some((o) => o.lens_key === k),
  );
  if (missingBlocking.length > 0) {
    throw new PacketError(
      409,
      "blocking_lens_not_run",
      `these lenses must run before execution: ${missingBlocking.join(", ")} — silence is not a pass`,
    );
  }

  if (packet.machine_id !== null) {
    const paused = await isMachinePaused(env, packet.machine_id);
    if (paused.paused) {
      throw new PacketError(409, "machine_paused", `machine ${packet.machine_id} is PAUSED: ${paused.reason ?? "no reason recorded"}`);
    }
  }

  await env.WP_OS_DB.prepare("UPDATE work_packet SET status = 'EXECUTING', updated_at = ?2 WHERE id = ?1")
    .bind(packetId, new Date().toISOString())
    .run();

  // The packet becomes real governed work: a work card, then a governed AI run.
  const workCard = (await createWorkCardInternal(env, identity, {
    capture_id: packet.capture_id ?? undefined,
    title: packet.output_definition || packet.original_text.slice(0, 120),
    machine_id: packet.machine_id ?? undefined,
    privacy_label: packet.privacy_label,
    firm_scope: packet.firm_scope,
    next_action: "execute work packet",
  })) as { id: string };

  const { run } = await runAi(env, {
    purpose: `work packet: ${packet.output_definition || packet.original_text.slice(0, 80)}`,
    actor,
    inputs: [
      `Original intent (verbatim): ${packet.original_text}`,
      `Interpretation: ${packet.interpretation}`,
      `Acceptance criteria: ${packet.acceptance_criteria_json}`,
      `Assumptions: ${packet.assumptions_json}`,
    ],
    sensitivity: (packet.privacy_label as never) ?? "INTERNAL",
    budgetContext: { judgement: true },
    aiEmployeeId: packet.recommended_employee_id ?? undefined,
    routing: {
      taskClass: packet.task_class ?? undefined,
      machineId: packet.machine_id ?? undefined,
      workCardId: workCard.id,
      category: "OPERATIONS",
    },
  });

  const completed = run.status === "COMPLETED";
  await env.WP_OS_DB.prepare(
    "UPDATE work_packet SET status = ?2, work_card_id = ?3, ai_run_id = ?4, updated_at = ?5 WHERE id = ?1",
  )
    .bind(packetId, completed ? "COMPLETE" : "FAILED", workCard.id, run.id, new Date().toISOString())
    .run();

  await appendRevision(env, packetId, actor, `executed: run ${run.status}`);
  await appendEvent(env, {
    eventType: "work_packet.executed",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "work_packet",
    objectId: packetId,
    payload: { work_card_id: workCard.id, ai_run_id: run.id, run_status: run.status },
  });

  return { packet: await getPacket(env, packetId), work_card: workCard, run };
}

// ── HTTP handlers ──

export async function handleCreatePacket(ctx: RouteContext): Promise<Response> {
  const parsed = createSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const packet = await createPacket(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json({ packet, lens_bench: LENS_BENCH }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListPackets(ctx: RouteContext): Promise<Response> {
  // A packet carries the privacy label of the work it describes. Visibility is enforced in SQL,
  // never by the client choosing what to render (P3 rule).
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = (
    await ctx.env.WP_OS_DB.prepare(`SELECT * FROM work_packet WHERE ${visibility} ORDER BY created_at DESC LIMIT 100`).all<WorkPacketRow>()
  ).results ?? [];
  return json({ packets: rows, lens_bench: LENS_BENCH });
}

export async function handleGetPacket(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const packet = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM work_packet WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<WorkPacketRow>();
  // A packet the caller may not see is not_found, not forbidden: existence is not disclosed.
  if (!packet) return json({ error: "not_found" }, { status: 404 });
  const lenses = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM lens_output WHERE packet_id = ?1 ORDER BY created_at").bind(packet.id).all()).results ?? [];
  const revisions = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, version_no, note, changed_by, created_at FROM work_packet_revision WHERE packet_id = ?1 ORDER BY version_no")
      .bind(packet.id)
      .all()
  ).results ?? [];
  return json({
    packet,
    lens_outputs: lenses,
    revisions,
    lens_bench: LENS_BENCH,
    note: "Lens findings store verdict, critique, evidence references, and summary. No chain-of-thought is stored — the table has no column for one.",
  });
}

export async function handleUpdatePacket(ctx: RouteContext): Promise<Response> {
  const parsed = updateSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await updatePacket(ctx.env, ctx.identity!, ctx.params.id!, parsed.data));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleRunLens(ctx: RouteContext): Promise<Response> {
  const parsed = lensSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await runLens(ctx.env, ctx.identity!, ctx.params.id!, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleExecutePacket(ctx: RouteContext): Promise<Response> {
  try {
    return json(await executePacket(ctx.env, ctx.identity!, ctx.params.id!));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleLensBench(_ctx: RouteContext): Promise<Response> {
  return json({
    lenses: LENS_BENCH,
    default_stack: DEFAULT_LENS_STACK,
    blocking: BLOCKING_LENSES,
    storage_rule:
      "Lens findings persist verdict, critique, evidence references, and summary only. Private model reasoning is never stored: no column exists for it.",
  });
}
