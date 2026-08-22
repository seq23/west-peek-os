import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import type { FirmUserIdentity } from "../auth";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { createClaim, type ClaimSourceType } from "./evidence";
import { deliver } from "./deliverables";
import { privacyLabelSchema } from "../../shared/privacy";
import { runAi } from "../ai/runAi";

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
/** owner_id comes back too: it is who asked, and therefore whose Home page a packet lands on. */
async function visibleProject(
  ctx: RouteContext,
  projectId: string,
): Promise<{ id: string; company_id: string | null; privacy_label: string; owner_id: string } | null> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  return ctx.env.WP_OS_DB.prepare(
    `SELECT id, company_id, privacy_label, owner_id FROM research_project WHERE id = ?1 AND ${visibility}`,
  )
    .bind(projectId)
    .first<{ id: string; company_id: string | null; privacy_label: string; owner_id: string }>();
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

  /*
   * WYATT HANDS IT OVER.
   *
   * Assembling a packet used to be where research stopped: the record existed, and nothing put it
   * in front of the person who asked for it. Now it is delivered — filed in Documents, listed on
   * Research, and on the Home page of whoever owns the project.
   *
   * SIGNED BY WYATT, NOT BY A CHIEF OF STAFF. The morning brief and the weekly agenda are
   * firm-wide things assembled by machinery, which is why they need a person attached to them.
   * Research already has one: Wyatt owns the research machine and is the analyst named on the page.
   * Routing his own work through somebody else's byline would be the anonymity problem in reverse.
   *
   * DELIVERED TO project.owner_id, which is who opened it — so Scooter's research lands on
   * Scooter's Home page and stays findable by both partners at INTERNAL.
   *
   * BEST EFFORT. A failed handover must not lose the packet: the assembly above is the record, and
   * this is how it reaches somebody. The catch is deliberate and the packet is returned either way.
   */
  try {
    await deliver(ctx.env, actorFromIdentity(ctx.identity!), {
      kind: "research_packet",
      title: parsed.data.title,
      body: renderPacketBody(parsed.data.summary, findings, openQuestions, contradictions, icReady, reasons),
      preparedBy: "Wyatt",
      preparedFor: project.owner_id,
      sourceType: "research_packet",
      sourceId: id,
      privacyLabel: project.privacy_label,
    });
  } catch {
    // The packet stands. It simply has not been handed over, which the Research page reports.
  }

  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM research_packet WHERE id = ?1").bind(id).first(), { status: 201 });
}

/**
 * The packet as a document somebody reads, rather than as JSON columns.
 *
 * WHY THE CONTRADICTIONS ARE IN THE BODY and not an appendix: a packet that quietly drops what the
 * record disagrees about is how a committee agrees on something the evidence does not support. They
 * travel with the work, in the middle of it, where they cannot be skipped.
 */
function renderPacketBody(
  summary: string,
  findings: readonly { statement: string; source_title?: string; reliability?: string }[],
  openQuestions: readonly { question: string }[],
  contradictions: readonly { summary?: string; description?: string }[],
  icReady: boolean,
  reasons: readonly string[],
): string {
  const out: string[] = [summary.trim(), ""];

  out.push("## What we established", "");
  if (findings.length === 0) out.push("Nothing yet. No findings have been recorded on this project.");
  for (const f of findings) {
    const src = f.source_title ? ` — ${f.source_title}${f.reliability ? ` (${f.reliability.toLowerCase()})` : ""}` : "";
    out.push(`- ${f.statement}${src}`);
  }
  out.push("");

  if (openQuestions.length > 0) {
    out.push("## Still open", "");
    for (const q of openQuestions) out.push(`- ${q.question}`);
    out.push("");
  }

  if (contradictions.length > 0) {
    out.push("## Where the record disagrees with itself", "");
    for (const c of contradictions) out.push(`- ${c.summary ?? c.description ?? "An unresolved contradiction on this company."}`);
    out.push("");
  }

  out.push("## Ready for committee?", "");
  out.push(icReady
    ? "Yes. Every question is closed and every finding is governed evidence."
    : `Not yet — ${reasons.join("; ")}.`);

  return out.join("\n");
}

// ── The guided half: what do we actually need to find out ──

/**
 * Wyatt turns a topic into the questions the research has to answer.
 *
 * Operator, item 18: "Research as a guided conversation" with the research employee "who builds a
 * schema then produces the report".
 *
 * WHAT THE PAGE WAS. Two text boxes — a title and a question — and then a list of empty sections.
 * A partner who types "AI inference" has said what they are curious about and not what would settle
 * it, and the gap between those is the whole job. So the page asked the hardest part of research as
 * its first field and gave no help with it.
 *
 * THE SCHEMA IS THE GUIDANCE. Naming the five or six questions that would actually resolve a topic
 * is where an analyst earns their place, and it is a thing a model does well because it is a
 * question about the SHAPE of an enquiry rather than about the world. Answering them is the part
 * that needs evidence, and that is the existing engine's job.
 *
 * PROPOSED, NOT CREATED. They come back as a list a partner accepts, edits or throws away. A
 * research plan somebody did not agree to is a plan they will not use — and this is the one step
 * where being slightly wrong sends the whole packet in the wrong direction.
 */
export async function handleProposeQuestions(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  // Visibility first, then the fields this needs. `visibleProject` deliberately selects only what
  // the privacy check requires, so the title and question are read separately rather than widening
  // a function every other caller depends on.
  const visible = await visibleProject(ctx, ctx.params.id!);
  if (!visible) return json({ error: "not_found" }, { status: 404 });
  const project = await ctx.env.WP_OS_DB.prepare("SELECT title, question FROM research_project WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ title: string; question: string }>();
  if (!project) return json({ error: "not_found" }, { status: 404 });

  const existing = (
    await ctx.env.WP_OS_DB.prepare("SELECT question FROM research_question WHERE project_id = ?1")
      .bind(ctx.params.id!)
      .all<{ question: string }>()
  ).results ?? [];

  const { run } = await runAi(ctx.env, {
    purpose: `Propose the research schema for ${project.title}`,
    actor,
    inputs: [
      [
        "You are an analyst at an early-stage venture fund, scoping a piece of research before it starts.",
        "",
        `Topic: ${project.title}`,
        `The partner's question: ${project.question}`,
        existing.length > 0
          ? `Already being asked (do not repeat these): ${existing.map((q) => q.question).join(" | ")}`
          : "",
        "",
        "Name the 5 to 7 questions that would actually settle this, as a JSON array of strings and",
        "nothing else. Rules:",
        "- Each must be answerable with evidence somebody could go and find. Not 'is this a good",
        "  market' but 'how much did the three largest players spend on inference in the last year'.",
        "- Include at least one that would DISCONFIRM the obvious thesis, because research that can",
        "  only agree with the person who commissioned it is not research.",
        "- Include one about who is already doing this, since the useful version of most questions",
        "  is comparative.",
        "- No question whose answer is a matter of opinion, and none that restates the topic.",
      ]
        .filter(Boolean)
        .join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 600 },
    routing: { category: "RESEARCH", taskClass: "research_scoping" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json({ error: "propose_failed", detail: run.failure_reason ?? `The run did not complete (${run.status}).` }, { status: 502 });
  }

  // Models decorate JSON however firmly they are asked not to; reading the first array out of the
  // text is more robust than refusing an answer that is present but wrapped.
  const match = /\[[\s\S]*\]/.exec(run.output_text);
  let questions: string[] = [];
  try {
    questions = match ? (JSON.parse(match[0]) as unknown[]).map(String).filter((q) => q.trim().length > 8) : [];
  } catch {
    questions = [];
  }
  if (questions.length === 0) {
    return json({ error: "propose_failed", detail: "The answer could not be read as a list of questions." }, { status: 502 });
  }

  return json({
    questions: questions.slice(0, 8),
    note: "Proposed, not added. Keep the ones worth answering.",
  });
}

// ── The 1:1 with the analyst ──

/**
 * Ask Wyatt something about this project, and keep the thread with the project.
 *
 * Operator: "i dont see the chat 1:1 for research", and on the two buttons that were there:
 * "this is confusing." Correctly — neither was a conversation. One returned a list of proposed
 * questions, the other produced a packet. Calling the page a guided conversation while it held
 * neither was precisely the gap between claim and behaviour this review exists to close.
 *
 * HE ANSWERS WITH THE PROJECT IN FRONT OF HIM — its question, its open questions, its findings so
 * far. An analyst who has to be re-told the brief every message is a search box with a nicer font.
 *
 * A FAILED TURN IS A VISIBLE TURN. Same rule as University: a provider failure must never lose the
 * conversation, and the honest way to do that is to show that it happened rather than to drop the
 * message and leave the thread looking as though nothing was asked.
 */
export async function handleResearchReply(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (message.length < 2) return json({ error: "invalid_input", detail: "Say something." }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "ai.run", { objectType: "research_project", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const visible = await visibleProject(ctx, ctx.params.id!);
  if (!visible) return json({ error: "not_found" }, { status: 404 });
  const project = await ctx.env.WP_OS_DB.prepare("SELECT title, question FROM research_project WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<{ title: string; question: string }>();
  if (!project) return json({ error: "not_found" }, { status: 404 });

  const priorTurns = (
    await ctx.env.WP_OS_DB.prepare(
      "SELECT role, body FROM research_turn WHERE project_id = ?1 AND state = 'OK' ORDER BY turn_no ASC LIMIT 30",
    )
      .bind(ctx.params.id!)
      .all<{ role: string; body: string }>()
  ).results ?? [];

  const open = (
    await ctx.env.WP_OS_DB.prepare("SELECT question, status, answer FROM research_question WHERE project_id = ?1")
      .bind(ctx.params.id!)
      .all<{ question: string; status: string; answer: string | null }>()
  ).results ?? [];

  const nextNo = priorTurns.length + 1;
  const askId = `rt_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO research_turn (id, project_id, turn_no, role, body) VALUES (?1, ?2, ?3, 'PARTNER', ?4)",
  )
    .bind(askId, ctx.params.id!, nextNo, message)
    .run();

  const { run } = await runAi(ctx.env, {
    purpose: `Research 1:1 on ${project.title}`,
    actor,
    inputs: [
      [
        "You are Wyatt, the analyst at an early-stage venture fund, in a working conversation with a",
        "partner about a piece of research you are running for them.",
        "",
        `The project: ${project.title}`,
        `What they want answered: ${project.question}`,
        open.length > 0
          ? `Questions on the plan: ${open.map((q) => `${q.question} [${q.status}${q.answer ? `: ${q.answer}` : ""}]`).join(" | ")}`
          : "No questions have been set on the plan yet.",
        "",
        "ANSWER THE QUESTION ABOUT THE SUBJECT. This page exists to get deep research on a sector or",
        "a company, so a partner asking about one wants what is actually true about it — not a work",
        "plan. Operator, on an early answer that described a methodology: \"why would u ask wyatt that",
        "as a test for research? this tab is about getting deep research on a sector or company.\"",
        "",
        "So: lead with what you know and how confident you are in it. Name the specific companies,",
        "numbers and dates you are drawing on. Mark anything you are inferring rather than citing.",
        "Only mention what you would go and check when the answer genuinely is not available, and",
        "then in one line at the end rather than as the substance of the reply.",
        "",
        "Direct, short, never padded. When you do not know, say so — a guess dressed as an answer is",
        "the one thing that makes research worthless. Do not restate the question back at them.",
        "",
        "The conversation so far:",
        ...priorTurns.map((t) => `${t.role === "PARTNER" ? "Partner" : "You"}: ${t.body}`),
        `Partner: ${message}`,
      ].join("\n"),
    ],
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 700 },
    routing: { category: "RESEARCH", taskClass: "research_conversation" },
  });

  const ok = run.status === "COMPLETED" && Boolean(run.output_text);
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO research_turn (id, project_id, turn_no, role, body, state, detail, ai_run_id) VALUES (?1, ?2, ?3, 'ANALYST', ?4, ?5, ?6, ?7)",
  )
    .bind(
      `rt_${crypto.randomUUID()}`,
      ctx.params.id!,
      nextNo + 1,
      ok ? run.output_text! : "Wyatt could not answer that just now.",
      ok ? "OK" : "FAILED",
      ok ? null : (run.failure_reason ?? `run ${run.status}`),
      run.id,
    )
    .run();

  return json({ ok, reply: ok ? run.output_text : null, detail: ok ? null : run.failure_reason });
}

/** The thread, oldest first — it is read as a conversation. */
export async function handleResearchThread(ctx: RouteContext): Promise<Response> {
  const visible = await visibleProject(ctx, ctx.params.id!);
  if (!visible) return json({ error: "not_found" }, { status: 404 });
  const turns = (
    await ctx.env.WP_OS_DB.prepare(
      "SELECT id, turn_no, role, body, state, detail, created_at FROM research_turn WHERE project_id = ?1 ORDER BY turn_no ASC",
    )
      .bind(ctx.params.id!)
      .all()
  ).results ?? [];
  return json({ turns });
}
