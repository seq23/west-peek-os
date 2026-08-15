import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import type { FirmUserIdentity } from "../auth";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { createClaim, type ClaimSourceType } from "./evidence";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Research / Analyst Workstation (P21, GAP-14).
 *
 * The console that was missing: launch research, define the questions, record the sources with
 * their reliability, record findings against those sources, map a market, and assemble an
 * IC-ready packet.
 *
 * THE ONE RULE THAT MATTERS: a research finding is not evidence. It becomes institutional truth
 * only by being PROMOTED into the existing P5 `diligence_claim` substrate through `createClaim`,
 * which keeps the source provenance, the confidence, and the self-promotion ban. There is no
 * second evidence store here and no path that writes around P5.
 *
 * A packet is IC-ready only when every question is closed and every finding it carries has been
 * promoted. Anything else is stated as not ready, with the reason.
 */

export class ResearchError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ResearchError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Research source kind → the claim source vocabulary P5 already uses. */
export function claimSourceTypeFor(kind: string): ClaimSourceType {
  switch (kind) {
    case "DOCUMENT":
      return "DOCUMENT";
    case "URL":
      return "WEB";
    case "HUMAN":
      return "HUMAN_STATEMENT";
    case "INTELLIGENCE_ITEM":
      return "WEB";
    case "INTERNAL_RECORD":
      return "OTHER";
    default:
      return "OTHER";
  }
}

const projectSchema = z.object({
  title: z.string().trim().min(1),
  question: z.string().trim().min(1),
  company_id: z.string().trim().min(1).optional(),
  privacy_label: privacyLabelSchema.default("INTERNAL"),
});

export async function handleCreateProject(ctx: RouteContext): Promise<Response> {
  const parsed = projectSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "research_project.create", { objectType: "research_project" });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));

  if (parsed.data.company_id) {
    const company = await ctx.env.WP_OS_DB.prepare("SELECT id FROM canonical_company WHERE id = ?1").bind(parsed.data.company_id).first();
    if (!company) return json({ error: "unknown_company", detail: "research attaches to a canonical company (D3)" }, { status: 404 });
  }

  const id = `rprj_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO research_project (id, title, question, company_id, owner_id, privacy_label, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(id, parsed.data.title, parsed.data.question, parsed.data.company_id ?? null, ctx.identity!.id, parsed.data.privacy_label, actor.firmScopes[0] ?? "west-peek")
    .run();

  // The opening question is a question, not a preamble.
  await ctx.env.WP_OS_DB.prepare("INSERT INTO research_question (id, project_id, question) VALUES (?1, ?2, ?3)")
    .bind(`rqst_${crypto.randomUUID()}`, id, parsed.data.question)
    .run();

  await appendEvent(ctx.env, {
    eventType: "research_project.opened",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "research_project",
    objectId: id,
    payload: { title: parsed.data.title, company_id: parsed.data.company_id ?? null },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_project WHERE id = ?1").bind(id).first(), { status: 201 });
}

export async function handleListProjects(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = (
    await ctx.env.WP_OS_DB.prepare(`SELECT * FROM research_project WHERE ${visibility} ORDER BY created_at DESC LIMIT 100`).all()
  ).results ?? [];
  return json({
    projects: rows,
    rule: "A finding becomes institutional truth only by promotion into the governed diligence-claim substrate. This console holds no separate evidence store.",
  });
}

export async function handleGetProject(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const project = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM research_project WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<{ id: string; company_id: string | null }>();
  if (!project) return json({ error: "not_found" }, { status: 404 });

  const questions = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_question WHERE project_id = ?1 ORDER BY created_at").bind(project.id).all()).results ?? [];
  const sources = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_source WHERE project_id = ?1 ORDER BY created_at").bind(project.id).all()).results ?? [];
  const findings = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT f.*, s.title AS source_title, s.reliability, c.claim_status
         FROM research_finding f
         JOIN research_source s ON s.id = f.source_id
         LEFT JOIN diligence_claim c ON c.id = f.promoted_claim_id
        WHERE f.project_id = ?1 ORDER BY f.created_at`,
    )
      .bind(project.id)
      .all()
  ).results ?? [];
  const maps = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM market_map WHERE project_id = ?1 ORDER BY created_at").bind(project.id).all()).results ?? [];
  const packets = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_packet WHERE project_id = ?1 ORDER BY created_at DESC").bind(project.id).all()).results ?? [];

  // Contradictions come from the EXISTING P5 substrate for this company — the research console
  // reads the firm's contradiction record, it does not keep its own.
  const contradictions = project.company_id
    ? (
        await ctx.env.WP_OS_DB.prepare(
          `SELECT cr.* FROM contradiction_record cr WHERE cr.company_id = ?1 AND cr.status IN ('OPEN','INVESTIGATING') ORDER BY cr.created_at DESC`,
        )
          .bind(project.company_id)
          .all()
      ).results ?? []
    : [];

  return json({ project, questions, sources, findings, market_maps: maps, packets, open_contradictions: contradictions });
}

/**
 * A project the caller may not READ is a project they may not ADD TO. Every mutation below
 * resolves the project through this helper, so the visibility rule that governs the read path
 * governs the write path too.
 */
async function visibleProject(ctx: RouteContext, projectId: string): Promise<{ id: string; company_id: string | null; privacy_label: string } | null> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  return ctx.env.WP_OS_DB.prepare(`SELECT id, company_id, privacy_label FROM research_project WHERE id = ?1 AND ${visibility}`)
    .bind(projectId)
    .first<{ id: string; company_id: string | null; privacy_label: string }>();
}

const questionSchema = z.object({ question: z.string().trim().min(1) });

export async function handleAddQuestion(ctx: RouteContext): Promise<Response> {
  const parsed = questionSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "research_question.add", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));
  const project = await visibleProject(ctx, ctx.params.id!);
  if (!project) return json({ error: "not_found" }, { status: 404 });

  const id = `rqst_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare("INSERT INTO research_question (id, project_id, question) VALUES (?1, ?2, ?3)")
    .bind(id, ctx.params.id!, parsed.data.question)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_question WHERE id = ?1").bind(id).first(), { status: 201 });
}

const answerSchema = z.object({
  status: z.enum(["ANSWERED", "UNANSWERABLE"]),
  answer: z.string().trim().min(1),
});

export async function handleAnswerQuestion(ctx: RouteContext): Promise<Response> {
  const parsed = answerSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const visibility = privacyVisibilityClause(ctx.identity!, "p.privacy_label");
  const question = await ctx.env.WP_OS_DB.prepare(
    `SELECT q.id, q.project_id, q.status FROM research_question q
       JOIN research_project p ON p.id = q.project_id
      WHERE q.id = ?1 AND ${visibility}`,
  )
    .bind(ctx.params.id!)
    .first<{ id: string; project_id: string; status: string }>();
  if (!question) return json({ error: "not_found" }, { status: 404 });
  if (question.status !== "OPEN") return json({ error: "already_closed" }, { status: 409 });

  await ctx.env.WP_OS_DB.prepare("UPDATE research_question SET status = ?2, answer = ?3 WHERE id = ?1")
    .bind(question.id, parsed.data.status, parsed.data.answer)
    .run();
  await ctx.env.WP_OS_DB.prepare("UPDATE research_project SET status = 'IN_PROGRESS' WHERE id = ?1 AND status = 'OPEN'")
    .bind(question.project_id)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_question WHERE id = ?1").bind(question.id).first());
}

const sourceSchema = z.object({
  kind: z.enum(["DOCUMENT", "URL", "HUMAN", "INTELLIGENCE_ITEM", "INTERNAL_RECORD"]),
  ref_id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  url: z.string().trim().url().optional(),
  reliability: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).default("UNKNOWN"),
  reliability_basis: z.string().trim().default(""),
  note: z.string().trim().default(""),
});

export async function handleAddSource(ctx: RouteContext): Promise<Response> {
  const parsed = sourceSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "research_source.add", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));
  if (!(await visibleProject(ctx, ctx.params.id!))) return json({ error: "not_found" }, { status: 404 });

  const b = parsed.data;
  // A reliability judgement above UNKNOWN has to say what it rests on, or it is just a mood.
  if (b.reliability !== "UNKNOWN" && b.reliability_basis.length === 0) {
    return json(
      { error: "reliability_basis_required", detail: `stating ${b.reliability} reliability requires saying what that judgement rests on` },
      { status: 400 },
    );
  }
  if (b.kind === "DOCUMENT" && !b.ref_id) {
    return json({ error: "ref_required", detail: "a DOCUMENT source must name the document version it refers to" }, { status: 400 });
  }

  const id = `rsrc_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO research_source (id, project_id, kind, ref_id, title, url, reliability, reliability_basis, note, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(id, ctx.params.id!, b.kind, b.ref_id ?? null, b.title, b.url ?? null, b.reliability, b.reliability_basis, b.note, ctx.identity!.id)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_source WHERE id = ?1").bind(id).first(), { status: 201 });
}

const findingSchema = z.object({
  source_id: z.string().trim().min(1),
  question_id: z.string().trim().min(1).optional(),
  statement: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
});

export async function handleRecordFinding(ctx: RouteContext): Promise<Response> {
  const parsed = findingSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "research_finding.record", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));
  if (!(await visibleProject(ctx, ctx.params.id!))) return json({ error: "not_found" }, { status: 404 });

  const source = await ctx.env.WP_OS_DB.prepare("SELECT id, project_id FROM research_source WHERE id = ?1")
    .bind(parsed.data.source_id)
    .first<{ id: string; project_id: string }>();
  if (!source || source.project_id !== ctx.params.id!) {
    return json({ error: "source_not_found", detail: "a finding must cite a source recorded on THIS project" }, { status: 404 });
  }

  const id = `rfnd_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO research_finding (id, project_id, question_id, source_id, statement, confidence, recorded_by_type, recorded_by_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      id,
      ctx.params.id!,
      parsed.data.question_id ?? null,
      parsed.data.source_id,
      parsed.data.statement,
      parsed.data.confidence,
      actor.type === "AI" ? "AI" : "HUMAN",
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();
  return json(
    {
      finding: await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_finding WHERE id = ?1").bind(id).first(),
      note: "Recorded as research, not as evidence. Promote it to create a governed diligence claim.",
    },
    { status: 201 },
  );
}

const promoteSchema = z.object({
  subject_type: z.string().trim().min(1).default("company"),
  subject_id: z.string().trim().min(1).optional(),
  metric_key: z.string().trim().min(1).optional(),
  metric_value: z.string().trim().min(1).optional(),
});

/**
 * Promote a finding into the governed evidence substrate. This is the ONLY way research becomes
 * institutional truth, and it runs the ordinary P5 `createClaim` path — so the claim enters
 * UNVERIFIED (or AI_INFERRED for an AI actor), carries its source type, location, date, and
 * method, and remains subject to the self-promotion ban.
 */
export async function promoteFinding(
  env: Env,
  identity: FirmUserIdentity,
  findingId: string,
  body: z.infer<typeof promoteSchema>,
): Promise<{ finding: Record<string, unknown>; claim: Record<string, unknown> }> {
  const actor = actorFromIdentity(identity);
  // Promotion writes into the governed evidence substrate, so it obeys the project's own
  // visibility: a finding on a project you cannot read is not yours to promote.
  const projectVisibility = privacyVisibilityClause(identity, "p.privacy_label");
  const finding = await env.WP_OS_DB.prepare(
    `SELECT f.*, s.kind AS source_kind, s.title AS source_title, s.url AS source_url, s.reliability,
            p.company_id, p.privacy_label
       FROM research_finding f
       JOIN research_source s ON s.id = f.source_id
       JOIN research_project p ON p.id = f.project_id
      WHERE f.id = ?1 AND ${projectVisibility}`,
  )
    .bind(findingId)
    .first<{
      id: string;
      statement: string;
      confidence: number;
      promoted_claim_id: string | null;
      source_kind: string;
      source_title: string;
      source_url: string | null;
      reliability: string;
      company_id: string | null;
      privacy_label: string;
      recorded_by_type: string;
      created_at: string;
    }>();
  if (!finding) throw new ResearchError(404, "not_found");
  if (finding.promoted_claim_id) throw new ResearchError(409, "already_promoted", "this finding is already a governed claim");

  const authz = await authorize(env, actor, "research_finding.promote", { objectType: "research_finding", objectId: findingId });
  if (authz.decision !== "ALLOW") throw new ResearchError(403, "forbidden", authz.reason);

  const claim = await createClaim(env, actor, {
    company_id: finding.company_id ?? undefined,
    subject_type: body.subject_type,
    subject_id: body.subject_id ?? finding.company_id ?? "unspecified",
    claim_text: finding.statement,
    metric_key: body.metric_key,
    metric_value: body.metric_value,
    confidence: finding.confidence,
    privacy_label: finding.privacy_label,
    sources: [
      {
        source_type: claimSourceTypeFor(finding.source_kind),
        location: finding.source_url ?? finding.source_title,
        source_date: finding.created_at.slice(0, 10),
        method: `research finding promoted from project console; researcher-stated source reliability ${finding.reliability}`,
        note: `research_finding:${finding.id}`,
      },
    ],
  });

  await env.WP_OS_DB.prepare("UPDATE research_finding SET promoted_claim_id = ?2, promoted_at = ?3, promoted_by = ?4 WHERE id = ?1")
    .bind(findingId, claim.id, new Date().toISOString(), actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();

  await appendEvent(env, {
    eventType: "research_finding.promoted",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "research_finding",
    objectId: findingId,
    payload: { claim_id: claim.id, claim_status: claim.claim_status },
  });

  return {
    finding: (await env.WP_OS_DB.prepare("SELECT * FROM research_finding WHERE id = ?1").bind(findingId).first())!,
    claim: claim as unknown as Record<string, unknown>,
  };
}

export async function handlePromoteFinding(ctx: RouteContext): Promise<Response> {
  const parsed = promoteSchema.safeParse((await parseJsonBody(ctx.request)) ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const result = await promoteFinding(ctx.env, ctx.identity!, ctx.params.id!, parsed.data);
    return json(
      {
        ...result,
        note: "The claim entered the governed evidence substrate with its source provenance. Verification is a separate human act (P5).",
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

const mapSchema = z.object({
  name: z.string().trim().min(1),
  segments: z.array(z.object({ name: z.string().trim().min(1), members: z.array(z.string().trim().min(1)).default([]), note: z.string().trim().default("") })).min(1),
  note: z.string().trim().default(""),
});

export async function handleCreateMarketMap(ctx: RouteContext): Promise<Response> {
  const parsed = mapSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "market_map.create", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));
  if (!(await visibleProject(ctx, ctx.params.id!))) return json({ error: "not_found" }, { status: 404 });

  const id = `mmap_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare("INSERT INTO market_map (id, project_id, name, segments_json, note, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, ctx.params.id!, parsed.data.name, JSON.stringify(parsed.data.segments), parsed.data.note, ctx.identity!.id)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM market_map WHERE id = ?1").bind(id).first(), { status: 201 });
}

const packetSchema = z.object({ title: z.string().trim().min(1), summary: z.string().trim().default("") });

/**
 * Assemble a packet. IC readiness is COMPUTED, never asserted: a packet is IC-ready only when
 * every question is closed and every finding has been promoted into governed evidence. Otherwise
 * it is assembled anyway — the work is still useful — and says exactly why it is not ready.
 */
export async function handleAssemblePacket(ctx: RouteContext): Promise<Response> {
  const parsed = packetSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "research_packet.assemble", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return errorResponse(new ResearchError(403, "forbidden", authz.reason));

  const project = await visibleProject(ctx, ctx.params.id!);
  if (!project) return json({ error: "not_found" }, { status: 404 });

  const questions = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, question, status, answer FROM research_question WHERE project_id = ?1").bind(project.id).all<{ id: string; question: string; status: string; answer: string | null }>()
  ).results ?? [];
  const findings = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, statement, confidence, promoted_claim_id FROM research_finding WHERE project_id = ?1").bind(project.id).all<{ id: string; statement: string; confidence: number; promoted_claim_id: string | null }>()
  ).results ?? [];
  const contradictions = project.company_id
    ? (
        await ctx.env.WP_OS_DB.prepare(
          "SELECT id, contradiction_type, topic, materiality, status FROM contradiction_record WHERE company_id = ?1 AND status IN ('OPEN','INVESTIGATING')",
        )
          .bind(project.company_id)
          .all<Record<string, unknown>>()
      ).results ?? []
    : [];

  const openQuestions = questions.filter((q) => q.status === "OPEN");
  const unpromoted = findings.filter((f) => f.promoted_claim_id === null);
  const reasons: string[] = [];
  if (openQuestions.length > 0) reasons.push(`${openQuestions.length} question(s) still open`);
  if (unpromoted.length > 0) reasons.push(`${unpromoted.length} finding(s) not promoted into governed evidence`);
  if (findings.length === 0) reasons.push("no findings recorded");
  if (contradictions.length > 0) reasons.push(`${contradictions.length} unresolved contradiction(s) on this company — these are shown, never filtered`);

  const icReady = openQuestions.length === 0 && unpromoted.length === 0 && findings.length > 0;
  const id = `rpkt_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO research_packet (id, project_id, title, summary, findings_json, open_questions_json, contradictions_json, ic_ready, ic_readiness_note, assembled_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      project.id,
      parsed.data.title,
      parsed.data.summary,
      JSON.stringify(findings),
      JSON.stringify(openQuestions),
      JSON.stringify(contradictions),
      icReady ? 1 : 0,
      icReady
        ? "Every question is closed and every finding is governed evidence."
        : `NOT IC-ready: ${reasons.join("; ")}.`,
      ctx.identity!.id,
    )
    .run();

  if (icReady) {
    await ctx.env.WP_OS_DB.prepare("UPDATE research_project SET status = 'PACKAGED' WHERE id = ?1").bind(project.id).run();
  }

  await appendEvent(ctx.env, {
    eventType: "research_packet.assembled",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "research_packet",
    objectId: id,
    payload: { project_id: project.id, ic_ready: icReady, open_questions: openQuestions.length, unpromoted_findings: unpromoted.length },
  });

  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_packet WHERE id = ?1").bind(id).first(), { status: 201 });
}
