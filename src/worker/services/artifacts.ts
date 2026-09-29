import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import { identityForFirmUserId } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause, type Actor } from "./authorize";
import { citationsFor, compileRecordQuery, describeAllowlist, RecordQueryRefused, ALLOWLIST } from "../../shared/meetings/roomQuery";
import {
  ARTIFACT_KINDS,
  KIND_WORDS,
  STAGE_WORDS,
  aboutColumnFor,
  artifactAskFromWords,
  isTerminal,
  panelPlansSchema,
  planningReplySchema,
  stateInWords,
  writingReplySchema,
  type ArtifactAbout,
  type ArtifactKind,
  type ArtifactPanel,
  type ArtifactSection,
  type ArtifactSpec,
  type ArtifactStage,
  type PanelPlan,
} from "../../shared/artifacts/artifact";
import { checkCitations, docxBytes, documentFor, panelNumbers, pptxBytes, slidesFor, stripUncited, textOfDocument, UncitedFigure } from "../../shared/artifacts/render";
import { readLaneFailure } from "../../shared/ai/laneFailure";
import { steerFor, cannotDetail } from "./instruction";
import { blockCard } from "./blocks";
import { deliver } from "./deliverables";
import { handOver, recipientFirmUserId } from "./employeeWork";

/**
 * ARTIFACTS ON DEMAND — THE ONE PRODUCER (owner, 19 Sep 2026).
 *
 * "Build me a dashboard / deck / doc on demand — yes I still want this; they need to live where we
 * would reuse them. Outside a meeting, isn't this just a work card? Work cards solve this."
 *
 * TWO DOORS, ONE FUNCTION. The live room (`meetingRoom.ts`, the `build` intent) and an ARTIFACT
 * work card (`workSweep.ts` → `runArtifactCard` below) both call `requestArtifactBuild`, and the
 * same `advanceArtifact` moves every row through the same four stages. `validate:artifacts` reads
 * the code and fails the build if a second producer appears or a door stops calling this one.
 *
 * THE PLAN COMPILER IS THE ONLY QUERY SURFACE. A panel is a `RecordQueryPlan` against the room's
 * allowlist (`roomQuery.ts`), compiled and run in code with the REQUESTER'S visibility clause —
 * never SQL from a model, never a table the room could not read. Every row comes back cited, and
 * `checkCitations` refuses a version that shows a number its rows do not hold. A model writes only
 * PLANS (planning) and PROSE (writing); the prose is stripped of any figure the panels cannot vouch
 * for before it is checked.
 *
 * THE MODEL RUNS ON THE CLOCK, NOT IN HER REQUEST (0211's lesson). `requestArtifactBuild` writes the
 * row and advances it inline through every stage that needs NO model — a dashboard from the room's
 * own blocks is READY before the request returns — and stops, with the stage named, at the first
 * one that does. The jobs tick (`serveArtifactsOnTick`) advances what is left, and a card's build
 * is advanced by its own sweep turn. Every state is on the row; the card and the room block poll it.
 *
 * LP MATERIAL STAYS ON PRIVATE LANES. `confidential` is derived — an LP object, an LP meeting, or
 * any allowlisted table marked confidential — and every model call carries it, so the router
 * refuses a training-permitted lane before a request exists. Free-first otherwise; no model is
 * pinned here.
 *
 * NOTHING HERE MAKES A RECORD. An artifact is a proposal she opens. This file writes `artifact`,
 * `artifact_version`, and — for a card — the deliverable and the card's own state, through the
 * existing doors (`deliver`, `handOver`, `blockCard`). It sends nothing.
 */

export class ArtifactError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  title: string;
  brief: string;
  company_id: string | null;
  opportunity_id: string | null;
  meeting_id: string | null;
  fund_id: string | null;
  lp_record_id: string | null;
  door: "ROOM" | "CARD";
  work_card_id: string | null;
  requested_by: string;
  requested_at: string;
  built_by: string;
  state: "REQUESTED" | "BUILDING" | "READY" | "FAILED";
  stage: ArtifactStage | null;
  stage_at: string | null;
  stage_lease_until: string | null;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  plans_json: string | null;
  confidential: number;
  current_version_no: number;
  privacy_label: string;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

export interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version_no: number;
  spec_json: string;
  cites_count: number;
  built_by: string;
  built_at: string;
  build_seconds: number | null;
  ai_run_ids_json: string;
}

/** How long one stage may hold the row. Two model calls at most, each under the router's own chain budget. */
export const STAGE_LEASE_MINUTES = 12;
/** A build that has not moved for this long is closed as abandoned by the tick, so a row cannot say "building" forever. */
export const ABANDONED_AFTER_MINUTES = 30;
export const MAX_ATTEMPTS = 3;
/** How many rows one tick advances. Each is at most two model calls. */
export const BUILDS_PER_TICK = 2;

const ABOUT_COLUMNS = ["company_id", "opportunity_id", "meeting_id", "fund_id", "lp_record_id"] as const;
type AboutColumn = (typeof ABOUT_COLUMNS)[number];
export type AboutInput = Partial<Record<AboutColumn, string | null>>;

// ── What it is about ───────────────────────────────────────────────────────────────────────────

/** The object's own name, so the title slide and the shelf can say it. Null when nothing named exists. */
export async function aboutLabel(env: Env, about: AboutInput): Promise<string | null> {
  const db = env.WP_OS_DB;
  if (about.company_id) {
    const r = await db.prepare("SELECT canonical_name FROM canonical_company WHERE id = ?1").bind(about.company_id).first<{ canonical_name: string }>();
    if (r) return r.canonical_name;
  }
  if (about.opportunity_id) {
    const r = await db.prepare("SELECT title FROM investment_opportunity WHERE id = ?1").bind(about.opportunity_id).first<{ title: string }>();
    if (r) return r.title;
  }
  if (about.fund_id) {
    const r = await db.prepare("SELECT name FROM fund WHERE id = ?1").bind(about.fund_id).first<{ name: string }>();
    if (r) return r.name;
  }
  if (about.lp_record_id) {
    const r = await db.prepare("SELECT legal_name FROM lp_record WHERE id = ?1").bind(about.lp_record_id).first<{ legal_name: string }>();
    if (r) return r.legal_name;
  }
  if (about.meeting_id) {
    const r = await db.prepare("SELECT title FROM meeting WHERE id = ?1").bind(about.meeting_id).first<{ title: string }>();
    if (r) return r.title;
  }
  return null;
}

/** An LP object, or a meeting with an LP, is confidential before a single table is read. */
async function aboutIsConfidential(env: Env, about: AboutInput): Promise<boolean> {
  if (about.lp_record_id) return true;
  if (about.meeting_id) {
    const m = await env.WP_OS_DB.prepare("SELECT meeting_type, lp_record_id FROM meeting WHERE id = ?1").bind(about.meeting_id).first<{ meeting_type: string; lp_record_id: string | null }>();
    if (m && (m.meeting_type === "LP" || m.lp_record_id !== null)) return true;
  }
  return false;
}

// ── Door: request ──────────────────────────────────────────────────────────────────────────────

export interface RequestArtifactInput {
  kind: ArtifactKind;
  /** Blank means the planning stage names it. */
  title?: string | null;
  brief: string;
  about: AboutInput;
  door: "ROOM" | "CARD";
  workCardId?: string | null;
  /** firm_user id of who asked. The build reads the record with THEIR visibility. */
  requestedBy: string;
  /** Roster name of the employee whose name goes on it. */
  builtBy: string;
  /** Panels the door already has (the room's own blocks). Null means a model plans them. */
  plans?: PanelPlan[] | null;
  privacyLabel: string;
  firmScope: string;
}

/**
 * THE DOOR. Both callers come through here and nowhere else. Authorises `artifact.build`, writes
 * the row REQUESTED, and advances it inline through every stage that needs no model.
 */
export async function requestArtifactBuild(env: Env, actor: Actor, input: RequestArtifactInput): Promise<ArtifactRow> {
  const authz = await authorize(env, actor, "artifact.build", { objectType: "artifact", firmScope: input.firmScope });
  if (authz.decision !== "ALLOW") throw new ArtifactError(403, "forbidden", authz.reason);
  if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind)) throw new ArtifactError(400, "invalid_input", `"${input.kind}" is not a kind of artifact. It can be a dashboard, a deck or a document.`);
  const brief = input.brief.trim();
  if (brief.length < 4) throw new ArtifactError(400, "invalid_input", "Say what it should be about.");
  const about: AboutInput = {};
  for (const c of ABOUT_COLUMNS) if (input.about[c]) about[c] = input.about[c];
  if (Object.keys(about).length === 0) throw new ArtifactError(400, "invalid_input", "An artifact lives on the thing it is about: name a company, a deal, a fund, an LP or a meeting.");
  const label = await aboutLabel(env, about);
  if (!label) throw new ArtifactError(404, "not_found", "The object this is about does not exist.");
  const plans = input.plans && input.plans.length > 0 ? panelPlansSchema.parse(input.plans) : null;
  const confidential = await aboutIsConfidential(env, about);
  const id = `art_${crypto.randomUUID()}`;
  const title = (input.title ?? "").trim() || `${KIND_WORDS[input.kind].label}: ${label}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO artifact (id, kind, title, brief, company_id, opportunity_id, meeting_id, fund_id, lp_record_id, door, work_card_id, requested_by, built_by, plans_json, confidential, privacy_label, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  )
    .bind(id, input.kind, title, brief, about.company_id ?? null, about.opportunity_id ?? null, about.meeting_id ?? null, about.fund_id ?? null, about.lp_record_id ?? null, input.door, input.workCardId ?? null, input.requestedBy, input.builtBy, plans ? JSON.stringify(plans) : null, confidential ? 1 : 0, input.privacyLabel, input.firmScope)
    .run();
  await appendEvent(env, {
    eventType: "artifact.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "artifact",
    objectId: id,
    firmScope: input.firmScope,
    payload: { kind: input.kind, door: input.door, plans: plans?.length ?? 0, confidential, about: Object.keys(about) },
  });
  // Everything that needs no model happens now; the rest is named on the row for the clock.
  await advanceArtifact(env, id, { allowModel: false });
  return (await loadArtifact(env, id))!;
}

export async function loadArtifact(env: Env, id: string): Promise<ArtifactRow | null> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM artifact WHERE id = ?1").bind(id).first<ArtifactRow>()) ?? null;
}

/**
 * Build it again: a refresh of a READY artifact, or a retry of a FAILED one. The plans are kept
 * (from the current version when there is one), so a refresh re-reads the record rather than
 * re-planning; a new version is written on READY and the old ones stay.
 */
export async function rebuildArtifact(env: Env, actor: Actor, id: string, why: "refresh" | "retry"): Promise<ArtifactRow> {
  const row = await loadArtifact(env, id);
  if (!row) throw new ArtifactError(404, "not_found", "no such artifact");
  const authz = await authorize(env, actor, "artifact.build", { objectType: "artifact", objectId: id, firmScope: row.firm_scope });
  if (authz.decision !== "ALLOW") throw new ArtifactError(403, "forbidden", authz.reason);
  if (!isTerminal(row.state)) throw new ArtifactError(409, "already_building", `It is already ${stateInWords(row)}; started ${elapsedWords(row.requested_at)} ago.`);
  let plans = row.plans_json;
  if (!plans && row.current_version_no > 0) {
    const v = await currentVersion(env, row);
    if (v) plans = JSON.stringify((JSON.parse(v.spec_json) as ArtifactSpec).panels.map((p) => ({ title: p.title, chart: p.chart, plan: p.plan })));
  }
  await env.WP_OS_DB.prepare(
    `UPDATE artifact SET state = 'REQUESTED', stage = NULL, stage_at = NULL, stage_lease_until = NULL, attempts = 0, error_code = NULL, error_message = NULL,
            plans_json = ?2, requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), requested_by = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1`,
  ).bind(id, plans, actor.firmUserId ?? row.requested_by).run();
  await appendEvent(env, { eventType: "artifact.rebuild_requested", actorType: "firm_user", actorId: actor.firmUserId ?? "system", objectType: "artifact", objectId: id, firmScope: row.firm_scope, payload: { why, version_no: row.current_version_no } });
  await advanceArtifact(env, id, { allowModel: false });
  return (await loadArtifact(env, id))!;
}

// ── The producer ───────────────────────────────────────────────────────────────────────────────

/** Injectable model seams, so the tests prove both doors to READY without a provider. */
export interface ArtifactDeps {
  plan?: ArtifactModelCall;
  write?: ArtifactModelCall;
  /** Prose put above every prompt — the card's steer. */
  steer?: string;
}
export type ArtifactModelCall = (env: Env, actor: Actor, args: { prompt: string; row: ArtifactRow; confidential: boolean }) => Promise<{ ok: boolean; text: string; aiRunId: string | null; detail: string }>;

const modelCall = (stage: "planning" | "writing"): ArtifactModelCall => async (env, actor, { prompt, row, confidential }) => {
  const { run } = await runAi(env, {
    purpose: `artifact ${row.id} ${stage}`,
    actor,
    inputs: [prompt],
    sensitivity: row.privacy_label as never,
    // FREE-FIRST, never pinned. The one thing that decides the lane is what the content is:
    // LP names, deal terms and fund figures ride only on private-capable lanes, derived from the
    // object and the allowlist rather than typed by anyone.
    budgetContext: { judgement: true, expectedOutputTokens: stage === "planning" ? 900 : 1600, ...(confidential ? { confidential: true } : { publicModelApproved: true, seatFirst: true }) },
    routing: { category: "INTELLIGENCE", taskClass: `artifact_${stage}`, ...(row.work_card_id ? { workCardId: row.work_card_id } : {}) },
  });
  return { ok: run.status === "COMPLETED" && Boolean(run.output_text), text: run.output_text ?? "", aiRunId: run.id, detail: run.failure_reason ?? run.status };
};

export interface AdvanceOutcome {
  status: "ready" | "failed" | "waiting_for_model" | "busy" | "none";
  stage: ArtifactStage | null;
  detail: string;
}

/**
 * Advance one artifact as far as it can go: to READY, to FAILED with the reason, or to the first
 * stage that needs a model when `allowModel` is false. Never throws: a build that dies leaves a
 * FAILED row with a sentence, not a stuck one.
 */
export async function advanceArtifact(env: Env, id: string, opts: { allowModel: boolean; deps?: ArtifactDeps; now?: Date } = { allowModel: true }): Promise<AdvanceOutcome> {
  const now = opts.now ?? new Date();
  const lease = new Date(now.getTime() + STAGE_LEASE_MINUTES * 60_000).toISOString();
  const claimed = await env.WP_OS_DB.prepare(
    `UPDATE artifact SET state = 'BUILDING', stage_lease_until = ?2, stage_at = ?3, updated_at = ?3
      WHERE id = ?1 AND state IN ('REQUESTED','BUILDING') AND (stage_lease_until IS NULL OR stage_lease_until < ?3)`,
  ).bind(id, lease, now.toISOString()).run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    const row = await loadArtifact(env, id);
    if (!row) return { status: "none", stage: null, detail: "no such artifact" };
    return isTerminal(row.state) ? { status: row.state === "READY" ? "ready" : "failed", stage: null, detail: stateInWords(row) } : { status: "busy", stage: row.stage, detail: "another run holds it" };
  }
  const row = (await loadArtifact(env, id))!;
  const runIds: string[] = [];
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [row.firm_scope] };
  const release = (stage: ArtifactStage) =>
    env.WP_OS_DB.prepare("UPDATE artifact SET stage = ?2, stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(id, stage).run();
  const setStage = (stage: ArtifactStage) =>
    env.WP_OS_DB.prepare("UPDATE artifact SET stage = ?2, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(id, stage).run();

  try {
    // 1 · PLANNING — a model proposes the panels from the brief, unless the door brought them.
    let plans: PanelPlan[];
    if (row.plans_json) {
      plans = panelPlansSchema.parse(JSON.parse(row.plans_json));
    } else {
      if (!opts.allowModel) {
        await release("planning");
        return { status: "waiting_for_model", stage: "planning", detail: STAGE_WORDS.planning };
      }
      await setStage("planning");
      const planner = opts.deps?.plan ?? modelCall("planning");
      const label = (await aboutLabel(env, row)) ?? row.title;
      const out = await planner(env, actor, { prompt: planningPrompt({ kind: row.kind, brief: row.brief, label, steer: opts.deps?.steer ?? "" }), row, confidential: row.confidential === 1 });
      if (out.aiRunId) runIds.push(out.aiRunId);
      if (!out.ok) throw new BuildFailed("planning_failed", `nobody could plan it: ${plainFailure(out.detail)}`, out.detail);
      const reply = parseJson(out.text, planningReplySchema);
      if (!reply) throw new BuildFailed("plan_unreadable", "the plan came back in a shape the builder could not read");
      plans = reply.panels;
      await env.WP_OS_DB.prepare("UPDATE artifact SET plans_json = ?2, title = CASE WHEN title LIKE 'Dashboard: %' OR title LIKE 'Deck: %' OR title LIKE 'Document: %' THEN ?3 ELSE title END WHERE id = ?1")
        .bind(id, JSON.stringify(plans), reply.title.slice(0, 120))
        .run();
    }

    // 2 · READING — every plan compiled and run in code, with the requester's visibility.
    await setStage("reading");
    const identity = await identityForFirmUserId(env, row.requested_by);
    if (!identity) throw new BuildFailed("requester_gone", "the partner who asked for it is no longer an active user, so the record cannot be read on their behalf");
    const { panels, refused } = await readPanels(env, identity, row.firm_scope, plans);
    if (panels.length === 0) throw new BuildFailed("nothing_readable", `none of the panels could be read from the record: ${refused.join("; ").slice(0, 300)}`);
    const confidential = row.confidential === 1 || panels.some((p) => p.confidential);
    if (confidential && row.confidential !== 1) await env.WP_OS_DB.prepare("UPDATE artifact SET confidential = 1 WHERE id = ?1").bind(id).run();

    // 3 · WRITING — a deck and a document carry findings; a dashboard is its panels.
    let sections: ArtifactSection[] = [];
    let summary: string | null = null;
    if (row.kind !== "dashboard") {
      if (!opts.allowModel) {
        await release("writing");
        return { status: "waiting_for_model", stage: "writing", detail: STAGE_WORDS.writing };
      }
      await setStage("writing");
      const writer = opts.deps?.write ?? modelCall("writing");
      const label = (await aboutLabel(env, row)) ?? row.title;
      const out = await writer(env, actor, { prompt: writingPrompt({ kind: row.kind, brief: row.brief, label, panels, steer: opts.deps?.steer ?? "" }), row, confidential });
      if (out.aiRunId) runIds.push(out.aiRunId);
      if (!out.ok) throw new BuildFailed("writing_failed", `nobody could write the findings: ${plainFailure(out.detail)}`, out.detail);
      const reply = parseJson(out.text, writingReplySchema);
      if (!reply) throw new BuildFailed("findings_unreadable", "the findings came back in a shape the builder could not read");
      const byId = new Map(panels.map((p) => [p.id, p]));
      const all = new Set<string>();
      for (const p of panels) for (const n of panelNumbers(p)) all.add(n);
      let stripped = 0;
      for (const s of reply.sections) {
        const panel = byId.get(s.panel.trim().toLowerCase()) ?? null;
        const allowed = panel ? panelNumbers(panel) : new Set<string>();
        const cleaned = stripUncited(s.prose, allowed);
        stripped += cleaned.stripped;
        sections.push({ heading: stripUncited(s.heading, allowed).prose, prose: cleaned.prose, panel_id: panel?.id ?? null });
      }
      if (reply.summary) {
        const cleaned = stripUncited(reply.summary, all);
        stripped += cleaned.stripped;
        summary = cleaned.prose;
      }
      if (stripped > 0) {
        await appendEvent(env, { eventType: "artifact.figures_stripped", actorType: "system", actorId: "artifacts", objectType: "artifact", objectId: id, firmScope: row.firm_scope, payload: { stripped } });
      }
    }

    // 4 · RENDERING — the spec, checked, becomes a version; the row becomes READY.
    await setStage("rendering");
    const fresh = (await loadArtifact(env, id))!;
    const versionNo = fresh.current_version_no + 1;
    const spec: ArtifactSpec = {
      kind: fresh.kind,
      title: fresh.title,
      brief: fresh.brief,
      about: { company_id: fresh.company_id, opportunity_id: fresh.opportunity_id, meeting_id: fresh.meeting_id, fund_id: fresh.fund_id, lp_record_id: fresh.lp_record_id, label: (await aboutLabel(env, fresh)) ?? fresh.title },
      built_by: fresh.built_by,
      built_at: now.toISOString(),
      version_no: versionNo,
      summary,
      panels,
      sections,
      sources: [...new Set(panels.flatMap((p) => p.cites))],
    };
    const { figures } = checkCitations(spec);
    const seconds = Math.max(0, (now.getTime() - new Date(fresh.requested_at).getTime()) / 1000);
    await env.WP_OS_DB.prepare(
      `INSERT INTO artifact_version (id, artifact_id, version_no, spec_json, cites_count, built_by, built_at, build_seconds, ai_run_ids_json, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(`arv_${crypto.randomUUID()}`, id, versionNo, JSON.stringify(spec), spec.sources.length, fresh.built_by, spec.built_at, seconds, JSON.stringify(runIds), fresh.firm_scope).run();
    await env.WP_OS_DB.prepare(
      `UPDATE artifact SET state = 'READY', stage = NULL, stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), error_code = NULL, error_message = NULL,
              current_version_no = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
    ).bind(id, versionNo).run();
    await appendEvent(env, { eventType: "artifact.ready", actorType: "system", actorId: "artifacts", objectType: "artifact", objectId: id, firmScope: row.firm_scope, payload: { version_no: versionNo, panels: panels.length, sections: sections.length, cites: spec.sources.length, figures, seconds: Math.round(seconds), refused } });
    return { status: "ready", stage: null, detail: `ready — v${versionNo}, ${panels.length} panel${panels.length === 1 ? "" : "s"}, ${spec.sources.length} rows cited` };
  } catch (err) {
    const failed = err instanceof BuildFailed ? err : err instanceof UncitedFigure ? new BuildFailed("uncited_figure", `it showed a figure the record does not hold (${err.message.slice(0, 160)})`) : new BuildFailed("build_error", plainFailure(err instanceof Error ? err.message : String(err)));
    await env.WP_OS_DB.prepare(
      `UPDATE artifact SET state = 'FAILED', stage = NULL, stage_lease_until = NULL, stage_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), attempts = attempts + 1,
              error_code = ?2, error_message = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
    ).bind(id, errorCodeFor(failed), failed.message.slice(0, 400)).run();
    await appendEvent(env, { eventType: "artifact.failed", actorType: "system", actorId: "artifacts", objectType: "artifact", objectId: id, firmScope: row.firm_scope, payload: { code: errorCodeFor(failed), detail: failed.message.slice(0, 300), runs: runIds } });
    return { status: "failed", stage: null, detail: failed.message };
  }
}

class BuildFailed extends Error {
  /** `raw` is the provider's own words, kept on the code as a lane kind so a card can name the lane's refusal. */
  constructor(public code: string, detail: string, public raw: string | null = null) {
    super(detail);
  }
}

/** `planning_failed/NO_LANE`: the stage that failed and, when a lane refused, which kind of refusal. */
function errorCodeFor(f: BuildFailed): string {
  const lane = f.raw ? readLaneFailure(f.raw) : null;
  return lane && lane.kind !== "NONE" ? `${f.code}/${lane.kind}${lane.lane ? `:${lane.lane}` : ""}` : f.code;
}

/** A provider's failure, in words the row can carry: the lane's kind of refusal, never its code. */
export function plainFailure(detail: string): string {
  const f = readLaneFailure(detail);
  const lane = f.lane ? ` (${f.lane})` : "";
  switch (f.kind) {
    case "NO_LANE": return `no model lane could take the work${lane} — every one is switched off or unavailable`;
    case "CREDIT": return `the lane refused it${lane} — the account behind it has run out of credit`;
    case "CREDENTIAL": return `the lane refused it${lane} — the firm is not signed in to it`;
    case "RATE_LIMIT": return `the lane turned it away${lane} for sending too much at once`;
    case "LANE_DOWN": return `the lane did not answer${lane}`;
    default: return detail.replace(/[_]+/g, " ").slice(0, 200);
  }
}

function parseJson<S extends z.ZodTypeAny>(raw: string, schema: S): z.infer<S> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const checked = schema.safeParse(JSON.parse(candidate.slice(start, end + 1)));
    return checked.success ? (checked.data as z.infer<S>) : null;
  } catch {
    return null;
  }
}

/** Compile and run every plan. A plan the compiler refuses is dropped BY NAME and reported; it never becomes SQL. */
export async function readPanels(env: Env, identity: FirmUserIdentity, firmScope: string, plans: PanelPlan[]): Promise<{ panels: ArtifactPanel[]; refused: string[] }> {
  const panels: ArtifactPanel[] = [];
  const refused: string[] = [];
  const visibility = privacyVisibilityClause(identity);
  for (let i = 0; i < plans.length; i += 1) {
    const p = plans[i]!;
    try {
      const compiled = compileRecordQuery(p.plan, { firmScope, visibility });
      const res = await env.WP_OS_DB.prepare(compiled.sql).bind(...compiled.params).all<Record<string, unknown>>();
      const rows = res.results ?? [];
      // A chart needs a grouping; a plan that asked for one without it is shown as the table it is.
      const chart = p.chart !== "table" && p.plan.group_by ? p.chart : "table";
      panels.push({
        id: `p${panels.length + 1}`,
        title: p.title,
        chart,
        plan: p.plan,
        table: compiled.table,
        columns: compiled.columns,
        rows,
        cites: citationsFor(compiled, rows),
        sql: compiled.sql,
        confidential: compiled.confidential,
        note: rows.length === 0 ? "The record holds nothing matching that." : null,
      });
    } catch (err) {
      refused.push(`"${p.title}": ${err instanceof RecordQueryRefused ? err.message : String(err)}`);
    }
  }
  return { panels, refused };
}

// ── Prompts ────────────────────────────────────────────────────────────────────────────────────

export function planningPrompt(args: { kind: ArtifactKind; brief: string; label: string; steer: string }): string {
  return [
    args.steer,
    `You are planning ${KIND_WORDS[args.kind].a} for a Managing Partner of a venture fund, about "${args.label}".`,
    `THE BRIEF: ${args.brief}`,
    "",
    "You do NOT write SQL and you do NOT see any rows. You choose between two and six PANELS, each a PLAN against one of the tables below — a table, a set of columns, filters, and optionally a grouping with an aggregate for a chart. Filter to the object the brief is about wherever a column allows it (a company id, a fund id, an LP id). Use group_by + metric for a bar, line or pie; otherwise the panel is a table.",
    "Tables you may read (name: columns):",
    describeAllowlist(),
    "",
    'Reply with ONLY this JSON: {"title":"a title a partner would give it","panels":[{"title":"what this panel shows","chart":"table|bar|line|pie","plan":{"table":"<table>","select":["col",…],"where":[{"column":"col","op":"eq|neq|gt|gte|lt|lte|like|in|is_null|not_null","value":…}],"group_by":"col","metric":{"fn":"count|sum|avg|min|max","column":"col"},"order_by":{"column":"col","dir":"asc|desc"},"limit":25}}]}',
  ].filter(Boolean).join("\n");
}

export function writingPrompt(args: { kind: ArtifactKind; brief: string; label: string; panels: ArtifactPanel[]; steer: string }): string {
  const panelText = args.panels
    .map((p) => {
      const rows = p.rows.slice(0, 20).map((r) => p.columns.map((c) => `${c}=${r[c] === null || r[c] === undefined ? "—" : String(r[c])}`).join(", "));
      return `PANEL ${p.id} — "${p.title}" (${p.table}, ${p.rows.length} rows${p.rows.length > 20 ? ", first 20 shown" : ""}):\n${rows.length ? rows.map((r) => `  ${r}`).join("\n") : "  (nothing matched)"}`;
    })
    .join("\n\n");
  return [
    args.steer,
    `You are writing the findings of ${KIND_WORDS[args.kind].a} for a Managing Partner of a venture fund, about "${args.label}".`,
    `THE BRIEF: ${args.brief}`,
    "",
    "Below are the panels, already read from the firm's record. Write one short finding per panel worth a finding — a heading and one paragraph. EVERY NUMBER YOU WRITE MUST APPEAR IN THAT PANEL'S ROWS, exactly; a number that is not in the rows is removed from the sentence before anyone reads it. Do not invent a name, a date or a figure. If a panel holds nothing, say so in a sentence.",
    "",
    panelText,
    "",
    'Reply with ONLY this JSON: {"summary":"one line, the decision or the headline","sections":[{"panel":"p1","heading":"…","prose":"…"}]}',
  ].filter(Boolean).join("\n");
}

// ── The clock ──────────────────────────────────────────────────────────────────────────────────

/**
 * On every tick: close what was abandoned, then advance up to BUILDS_PER_TICK room-door rows
 * (a card's build is advanced by its own sweep turn). Returns a line only when it did something,
 * so the Jobs page never fills with inert rows (0193's lesson).
 */
export async function serveArtifactsOnTick(env: Env, now: Date = new Date()): Promise<{ served: boolean; summary: string; outcomes: AdvanceOutcome[] }> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MINUTES * 60_000).toISOString();
  await env.WP_OS_DB.prepare(
    `UPDATE artifact SET state = 'FAILED', stage = NULL, stage_lease_until = NULL, error_code = 'abandoned',
            error_message = 'the build stopped part-way and never finished', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE state = 'BUILDING' AND stage_at IS NOT NULL AND stage_at < ?1 AND (stage_lease_until IS NULL OR stage_lease_until < ?2)`,
  ).bind(cutoff, now.toISOString()).run();
  const due = (
    await env.WP_OS_DB.prepare(
      `SELECT id FROM artifact WHERE state IN ('REQUESTED','BUILDING') AND work_card_id IS NULL AND (stage_lease_until IS NULL OR stage_lease_until < ?1) AND attempts < ?2
        ORDER BY requested_at ASC LIMIT ?3`,
    ).bind(now.toISOString(), MAX_ATTEMPTS, BUILDS_PER_TICK).all<{ id: string }>()
  ).results ?? [];
  const outcomes: AdvanceOutcome[] = [];
  for (const d of due) outcomes.push(await advanceArtifact(env, d.id, { allowModel: true, now }));
  const moved = outcomes.filter((o) => o.status !== "busy" && o.status !== "none");
  return { served: moved.length > 0, summary: moved.length ? `artifacts: ${moved.map((o) => `${o.status}${o.detail ? ` (${o.detail.slice(0, 80)})` : ""}`).join("; ")}` : "no artifact was waiting", outcomes };
}

// ── Door: the work card ────────────────────────────────────────────────────────────────────────

export const ARTIFACT_CARD_STEPS = [
  "choose what to read from the record",
  "read the record",
  "write the findings",
  "lay it out and file it",
  "A Managing Partner's own instruction extends what you do here — apply it using judgement and whatever you already have access to, rather than treating it as out of scope. Only decline something that genuinely needs a tool, data source or integration that does not exist anywhere in this system, or that would need to pass through approval regardless of who asked.",
] as const;

interface ArtifactCard {
  id: string;
  title: string;
  description: string | null;
  prompt: string | null;
  owner_id: string | null;
  firm_scope: string;
  meeting_id?: string | null;
  privacy_label?: string;
  requested_by_email?: string | null;
  preview_owner_id?: string | null;
  result_recipient?: string | null;
  preview_first?: number | null;
  created_by?: string | null;
  kind?: string | null;
}

/** What a card's words are about: its meeting, else a company named in them (and that company's latest deal). */
export async function aboutForCard(env: Env, card: ArtifactCard): Promise<AboutInput> {
  const about: AboutInput = {};
  if (card.meeting_id) {
    about.meeting_id = card.meeting_id;
    const m = await env.WP_OS_DB.prepare("SELECT company_id, lp_record_id FROM meeting WHERE id = ?1").bind(card.meeting_id).first<{ company_id: string | null; lp_record_id: string | null }>();
    if (m?.company_id) about.company_id = m.company_id;
    if (m?.lp_record_id) about.lp_record_id = m.lp_record_id;
  }
  const words = `${card.title} ${card.prompt ?? ""} ${card.description ?? ""}`;
  // An id in her words wins over a name.
  for (const m of words.matchAll(/\b((?:cc|opp|mtg|fund|lpr)_[A-Za-z0-9-]{6,})\b/g)) {
    const col = aboutColumnFor(m[1]!);
    if (col && !about[col]) about[col] = m[1]!;
  }
  if (!about.company_id) {
    const companies = (await env.WP_OS_DB.prepare("SELECT id, canonical_name FROM canonical_company WHERE firm_scope = ?1 AND length(canonical_name) >= 3 ORDER BY length(canonical_name) DESC LIMIT 400").bind(card.firm_scope).all<{ id: string; canonical_name: string }>()).results ?? [];
    const lower = words.toLowerCase();
    const hit = companies.find((c) => lower.includes(c.canonical_name.toLowerCase()));
    if (hit) about.company_id = hit.id;
  }
  if (about.company_id && !about.opportunity_id) {
    const opp = await env.WP_OS_DB.prepare("SELECT id FROM investment_opportunity WHERE company_id = ?1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(about.company_id).first<{ id: string }>();
    if (opp) about.opportunity_id = opp.id;
  }
  if (!about.fund_id && /\bfund\b/i.test(words) && Object.keys(about).length === 0) {
    const fund = await env.WP_OS_DB.prepare("SELECT id FROM fund WHERE firm_scope = ?1 ORDER BY vintage_year DESC, created_at DESC LIMIT 1").bind(card.firm_scope).first<{ id: string }>();
    if (fund) about.fund_id = fund.id;
  }
  return about;
}

/**
 * Work one ARTIFACT card to a conclusion: her words interpreted, the artifact requested through
 * the one door, built, then FILED as the card's deliverable and handed over the way 0196 made sure
 * of — or BLOCKED with the reason when it cannot be.
 */
export async function runArtifactCard(env: Env, sweepCard: { id: string }, deps: ArtifactDeps & { interpret?: Parameters<typeof steerFor>[3] } = {}): Promise<{ finished: boolean; blocked: boolean; detail: string; artifact_id: string | null }> {
  // The whole row, not the sweep's slice: the words, the meeting and the recipient all live on it.
  const card = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(sweepCard.id).first<ArtifactCard>();
  if (!card) return { finished: false, blocked: false, detail: "no such card", artifact_id: null };
  const employee = card.owner_id ? await env.WP_OS_DB.prepare("SELECT id, name FROM ai_employee WHERE id = ?1").bind(card.owner_id).first<{ id: string; name: string }>() : null;
  const name = employee?.name ?? "Your chief of staff";
  const actor: Actor = employee ? { type: "AI", aiEmployeeId: employee.id, roles: [], firmScopes: [card.firm_scope] } : { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] };
  const words = (card.prompt ?? "").trim() || card.title;

  const steer = await steerFor(env, actor, {
    cardId: card.id,
    cardKind: "ARTIFACT",
    title: card.title,
    employee: name,
    chain: `${name} building ${KIND_WORDS[artifactAskFromWords(words)?.kind ?? "document"].a} from the firm's record`,
    steps: [...ARTIFACT_CARD_STEPS],
    firmScope: card.firm_scope,
  }, deps.interpret);
  if (steer.cannot.length > 0) {
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: name,
      detail: steer.failure ? undefined : cannotDetail(name, steer.cannot),
    });
    return { finished: false, blocked: true, detail: why, artifact_id: null };
  }

  let row = await env.WP_OS_DB.prepare("SELECT * FROM artifact WHERE work_card_id = ?1").bind(card.id).first<ArtifactRow>();
  if (!row) {
    const ask = artifactAskFromWords(words) ?? { kind: "document" as const };
    const about = await aboutForCard(env, card);
    if (Object.keys(about).length === 0) {
      const why = await blockCard(env, card, {
        reason: "the_brief_is_missing",
        trying: card.title,
        employee: name,
        detail: `Say which company, deal, fund, LP or meeting this ${KIND_WORDS[ask.kind].label.toLowerCase()} is about — ${name} keeps it there so it can be found again.`,
      });
      return { finished: false, blocked: true, detail: why, artifact_id: null };
    }
    const requester = await recipientFirmUserId(env, { requested_by_email: card.requested_by_email ?? null, preview_owner_id: card.preview_owner_id ?? card.created_by ?? null });
    try {
      row = await requestArtifactBuild(env, { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] }, {
        kind: ask.kind,
        brief: words,
        about,
        door: "CARD",
        workCardId: card.id,
        requestedBy: requester,
        builtBy: name,
        privacyLabel: card.privacy_label ?? "INTERNAL",
        firmScope: card.firm_scope,
      });
    } catch (err) {
      const why = await blockCard(env, card, { reason: "the_brief_is_missing", trying: card.title, employee: name, detail: err instanceof ArtifactError ? err.message : `${name} could not open the build: ${String(err).slice(0, 160)}` });
      return { finished: false, blocked: true, detail: why, artifact_id: null };
    }
  } else if (isTerminal(row.state) && row.state === "FAILED") {
    // A retry after a block or a lane failure: the row is reopened and built again.
    await env.WP_OS_DB.prepare("UPDATE artifact SET state = 'REQUESTED', stage = NULL, stage_lease_until = NULL, error_code = NULL, error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id).run();
  }

  const outcome = row.state === "READY" ? ({ status: "ready", stage: null, detail: "ready" } as AdvanceOutcome) : await advanceArtifact(env, row.id, { allowModel: true, deps: { ...deps, steer: steer.text } });
  const fresh = (await loadArtifact(env, row.id))!;

  if (outcome.status === "ready") {
    await finishArtifactCard(env, card, fresh, name);
    return { finished: true, blocked: false, detail: `${name} built it: ${fresh.title}`, artifact_id: fresh.id };
  }
  const laneKind = /\/([A-Z_]+)(?::([a-z0-9_]+))?$/.exec(fresh.error_code ?? "");
  const why = await blockCard(env, card, {
    reason: laneKind?.[1] === "NO_LANE" ? "no_lane_could_take_the_work" : laneKind ? "a_lane_refused_the_work" : "tried_and_could_not_finish",
    trying: card.title,
    employee: name,
    detail: `${name} could not build the ${KIND_WORDS[fresh.kind].label.toLowerCase()}: ${fresh.error_message ?? outcome.detail}. Say what to change, or press Try again on the artifact.`,
    ...(laneKind?.[2] ? { laneKey: laneKind[2] } : {}),
  });
  return { finished: false, blocked: true, detail: why, artifact_id: fresh.id };
}

/**
 * FINISHED WORK REACHES HER (#116, kept). The artifact is the deliverable: a filed copy under the
 * existing kinds points at it and carries the document rendering in full, it lands on her Home,
 * it is handed over by her rule (preview or send), and a card raised from a meeting returns to
 * the room. Then the card is DONE.
 */
async function finishArtifactCard(env: Env, card: ArtifactCard, row: ArtifactRow, employee: string): Promise<void> {
  const version = await currentVersion(env, row);
  const spec = version ? (JSON.parse(version.spec_json) as ArtifactSpec) : null;
  const body = spec ? artifactMarkdown(spec, row.id) : `${row.title}\n\nOpen it: #/documents/a/${row.id}`;
  let deliverableId: string | null = null;
  try {
    const filed = await deliver(env, { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] }, {
      kind: "employee_finding",
      title: row.title,
      body,
      preparedBy: employee,
      preparedFor: row.requested_by,
      sourceType: "artifact",
      sourceId: row.id,
      privacyLabel: row.privacy_label,
    });
    deliverableId = filed.id;
  } catch (err) {
    await appendEvent(env, { eventType: "deliverable.not_filed", actorType: "system", actorId: "artifacts", objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { artifact_id: row.id, detail: String(err).slice(0, 300) } });
  }
  await handOver(env, { id: card.id, title: card.title, kind: card.kind ?? "ARTIFACT", firm_scope: card.firm_scope, result_recipient: card.result_recipient ?? null, preview_first: card.preview_first ?? null, preview_owner_id: card.preview_owner_id ?? null, requested_by_email: card.requested_by_email ?? null }, { employee, finding: body, deliverableId });
  if (card.meeting_id) {
    try {
      const { returnCardToRoom } = await import("./meetingRoom");
      await returnCardToRoom(env, card.id, { employee, finding: `${row.title} — ${KIND_WORDS[row.kind].label.toLowerCase()} v${row.current_version_no}, open it under Documents.`, deliverableId });
    } catch (err) {
      await appendEvent(env, { eventType: "meeting.room_return_failed", actorType: "system", actorId: "artifacts", objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { meeting_id: card.meeting_id, detail: String(err).slice(0, 300) } });
    }
  }
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL, description = ?2 WHERE id = ?1")
    .bind(card.id, `${card.description ? `${card.description}\n` : ""}• Built ${KIND_WORDS[row.kind].label.toLowerCase()} "${row.title}" (v${row.current_version_no}). Open it under Documents.`.slice(0, 8000))
    .run();
}

/** The document rendering as Markdown — what the filed deliverable carries, so Home shows the whole thing. */
export function artifactMarkdown(spec: ArtifactSpec, artifactId: string): string {
  const lines: string[] = [];
  for (const b of documentFor(spec)) {
    if (b.type === "heading") lines.push(`${b.level === 1 ? "#" : "##"} ${b.text}`, "");
    else if (b.type === "paragraph") lines.push(b.text, "");
    else if (b.type === "sources") lines.push(...b.lines.map((l) => `- ${l}`), "");
    else {
      lines.push(`| ${b.columns.join(" | ")} |`, `|${b.columns.map(() => "---").join("|")}|`, ...b.rows.map((r) => `| ${r.join(" | ")} |`), "");
    }
  }
  lines.push(`Open the ${spec.kind} in the app: #/documents/a/${artifactId}`);
  return lines.join("\n");
}

async function currentVersion(env: Env, row: ArtifactRow): Promise<ArtifactVersionRow | null> {
  if (row.current_version_no === 0) return null;
  return (await env.WP_OS_DB.prepare("SELECT * FROM artifact_version WHERE artifact_id = ?1 AND version_no = ?2").bind(row.id, row.current_version_no).first<ArtifactVersionRow>()) ?? null;
}

// ── Status, in words ───────────────────────────────────────────────────────────────────────────

export interface BuildExpectations {
  usualSeconds: number;
  slowSeconds: number;
  measuredFrom: number;
}

/** Until thirty builds exist: a model-free dashboard is seconds; a written deck is two model calls. */
export const FALLBACK_EXPECTATIONS: Readonly<Record<ArtifactKind, BuildExpectations>> = {
  dashboard: { usualSeconds: 20, slowSeconds: 60, measuredFrom: 0 },
  deck: { usualSeconds: 120, slowSeconds: 240, measuredFrom: 0 },
  document: { usualSeconds: 120, slowSeconds: 240, measuredFrom: 0 },
};

/** What a build of this kind usually takes, measured from this firm's own completed versions. */
export async function measuredExpectations(env: Env, kind: ArtifactKind): Promise<BuildExpectations> {
  const rows = (
    await env.WP_OS_DB.prepare(
      "SELECT v.build_seconds AS secs FROM artifact_version v JOIN artifact a ON a.id = v.artifact_id WHERE a.kind = ?1 AND v.build_seconds IS NOT NULL ORDER BY v.built_at DESC LIMIT 30",
    ).bind(kind).all<{ secs: number }>()
  ).results ?? [];
  const secs = rows.map((r) => Number(r.secs)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (secs.length < 3) return FALLBACK_EXPECTATIONS[kind];
  const at = (q: number) => secs[Math.min(secs.length - 1, Math.floor(q * secs.length))]!;
  return { usualSeconds: Math.max(1, Math.round(at(0.5))), slowSeconds: Math.max(1, Math.round(at(0.9))), measuredFrom: secs.length };
}

function elapsedWords(sinceIso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(sinceIso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export interface ArtifactStatus {
  id: string;
  kind: ArtifactKind;
  title: string;
  state: ArtifactRow["state"];
  stage: ArtifactStage | null;
  /** The whole state in one line — what the row, the block and the card print. */
  words: string;
  elapsed_seconds: number;
  usual_seconds: number;
  slow_seconds: number;
  /** True once a moving build has passed what one usually takes; the row says so rather than pretending. */
  slow: boolean;
  error_code: string | null;
  error_message: string | null;
  version_no: number;
  built_by: string;
  requested_at: string;
  built_at: string | null;
  cites_count: number;
  attempts: number;
  can_retry: boolean;
  about: ArtifactAbout;
  door: "ROOM" | "CARD";
  work_card_id: string | null;
  confidential: boolean;
}

export async function artifactStatus(env: Env, row: ArtifactRow, now: Date = new Date()): Promise<ArtifactStatus> {
  const [expect, version] = await Promise.all([measuredExpectations(env, row.kind), currentVersion(env, row)]);
  const elapsed = Math.max(0, Math.round((now.getTime() - new Date(row.requested_at).getTime()) / 1000));
  const moving = !isTerminal(row.state);
  const slow = moving && elapsed > expect.usualSeconds;
  let words = stateInWords(row);
  if (moving) words += ` · ${elapsedWords(row.requested_at, now)} so far · usually about ${Math.max(1, Math.round(expect.usualSeconds / 60)) || 1} min${slow ? " · running long" : ""}`;
  if (row.state === "READY" && version) words = `ready · v${version.version_no} · ${version.cites_count} row${version.cites_count === 1 ? "" : "s"} cited`;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    state: row.state,
    stage: row.stage,
    words,
    elapsed_seconds: elapsed,
    usual_seconds: expect.usualSeconds,
    slow_seconds: expect.slowSeconds,
    slow,
    error_code: row.error_code,
    error_message: row.error_message,
    version_no: row.current_version_no,
    built_by: row.built_by,
    requested_at: row.requested_at,
    built_at: version?.built_at ?? null,
    cites_count: version?.cites_count ?? 0,
    attempts: row.attempts,
    can_retry: row.state === "FAILED",
    about: { company_id: row.company_id, opportunity_id: row.opportunity_id, meeting_id: row.meeting_id, fund_id: row.fund_id, lp_record_id: row.lp_record_id, label: (await aboutLabel(env, row)) ?? row.title },
    door: row.door,
    work_card_id: row.work_card_id,
    confidential: row.confidential === 1,
  };
}

/** The statuses of several artifacts at once — the room's blocks and the card list read this. */
export async function artifactStatuses(env: Env, ids: string[]): Promise<Record<string, ArtifactStatus>> {
  const out: Record<string, ArtifactStatus> = {};
  for (const id of [...new Set(ids)]) {
    const row = await loadArtifact(env, id);
    if (row) out[id] = await artifactStatus(env, row);
  }
  return out;
}

// ── Routes ─────────────────────────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof ArtifactError) return json({ error: err.code, detail: err.message }, { status: err.status });
  if (err instanceof z.ZodError) return json({ error: "invalid_input", issues: err.issues }, { status: 400 });
  throw err;
}

async function visibleArtifact(ctx: RouteContext, id: string): Promise<ArtifactRow> {
  const row = await loadArtifact(ctx.env, id);
  if (!row || !canAccessPrivacyLabel(ctx.identity!, row.privacy_label)) throw new ArtifactError(404, "not_found", "no such artifact");
  return row;
}

const createSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().trim().max(120).optional(),
  brief: z.string().trim().min(4).max(2000),
  about: z.object({
    company_id: z.string().trim().optional(),
    opportunity_id: z.string().trim().optional(),
    meeting_id: z.string().trim().optional(),
    fund_id: z.string().trim().optional(),
    lp_record_id: z.string().trim().optional(),
  }),
  plans: panelPlansSchema.optional(),
  built_by: z.string().trim().min(2).max(40).optional(),
});

/** POST /api/artifacts — ask for one directly (the Documents page). The same door as the room and the card. */
export async function handleRequestArtifactBuild(ctx: RouteContext): Promise<Response> {
  const parsed = createSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const identity = ctx.identity!;
  try {
    const row = await requestArtifactBuild(ctx.env, actorFromIdentity(identity), {
      ...parsed.data,
      about: parsed.data.about,
      door: "ROOM",
      requestedBy: identity.id,
      builtBy: parsed.data.built_by ?? "Walter",
      plans: parsed.data.plans ?? null,
      privacyLabel: "INTERNAL",
      firmScope: identity.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek",
    });
    return json(await artifactStatus(ctx.env, row), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** GET /api/artifacts?about=<id>&q=<title words>&kind=… — the shelf. */
export async function handleListBuiltArtifacts(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const about = url.searchParams.get("about")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().toLowerCase() || null;
  const kind = url.searchParams.get("kind")?.trim() || null;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const conds = [`a.firm_scope = ?1`, `(${privacyVisibilityClause(ctx.identity!, "a.privacy_label")})`];
  const params: Array<string | number> = [ctx.identity!.authorityScopes.find((s) => s.scopeKey === "firm_scope")?.scopeValue ?? "west-peek"];
  if (about) {
    const col = aboutColumnFor(about);
    if (!col) return json({ artifacts: [], note: "That is not something an artifact can be about." });
    conds.push(`a.${col} = ?${params.push(about)}`);
  }
  if (kind && (ARTIFACT_KINDS as readonly string[]).includes(kind)) conds.push(`a.kind = ?${params.push(kind)}`);
  const card = url.searchParams.get("card")?.trim() || null;
  if (card) conds.push(`a.work_card_id = ?${params.push(card)}`);
  if (q) conds.push(`lower(a.title) LIKE ?${params.push(`%${q.replace(/[%_]/g, "")}%`)}`);
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT a.*, v.cites_count AS cites_count, v.built_at AS built_at
         FROM artifact a LEFT JOIN artifact_version v ON v.artifact_id = a.id AND v.version_no = a.current_version_no
        WHERE ${conds.join(" AND ")} ORDER BY a.updated_at DESC LIMIT ${limit}`,
    ).bind(...params).all<ArtifactRow & { cites_count: number | null; built_at: string | null }>()
  ).results ?? [];
  const labels = new Map<string, string>();
  const artifacts = [];
  for (const r of rows) {
    const key = `${r.company_id}|${r.opportunity_id}|${r.meeting_id}|${r.fund_id}|${r.lp_record_id}`;
    if (!labels.has(key)) labels.set(key, (await aboutLabel(ctx.env, r)) ?? r.title);
    artifacts.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      state: r.state,
      stage: r.stage,
      words: stateInWords(r),
      built_by: r.built_by,
      built_at: r.built_at,
      requested_at: r.requested_at,
      cites_count: r.cites_count ?? 0,
      version_no: r.current_version_no,
      door: r.door,
      work_card_id: r.work_card_id,
      about: { company_id: r.company_id, opportunity_id: r.opportunity_id, meeting_id: r.meeting_id, fund_id: r.fund_id, lp_record_id: r.lp_record_id, label: labels.get(key)! },
      error_message: r.error_message,
    });
  }
  return json({ artifacts, note: artifacts.length === 0 ? (q || about ? "Nothing built matches that." : "Nothing has been built yet. Ask the room for a dashboard, a deck or a document, or give an employee a card that asks for one.") : null });
}

/** GET /api/artifacts/:id — the status, the current version's spec, its derivations, and every version. */
export async function handleGetBuiltArtifact(ctx: RouteContext): Promise<Response> {
  try {
    const row = await visibleArtifact(ctx, ctx.params.id!);
    const url = new URL(ctx.request.url);
    const wanted = Number(url.searchParams.get("version") ?? row.current_version_no) || row.current_version_no;
    const status = await artifactStatus(ctx.env, row);
    const versions = (await ctx.env.WP_OS_DB.prepare("SELECT id, version_no, cites_count, built_by, built_at, build_seconds FROM artifact_version WHERE artifact_id = ?1 ORDER BY version_no DESC").bind(row.id).all<Omit<ArtifactVersionRow, "spec_json" | "artifact_id" | "ai_run_ids_json">>()).results ?? [];
    const version = wanted > 0 ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM artifact_version WHERE artifact_id = ?1 AND version_no = ?2").bind(row.id, wanted).first<ArtifactVersionRow>() : null;
    const spec = version ? (JSON.parse(version.spec_json) as ArtifactSpec) : null;
    return json({
      ...status,
      brief: row.brief,
      spec,
      slides: spec ? slidesFor(spec) : null,
      document: spec ? documentFor(spec) : null,
      shown_version_no: version?.version_no ?? null,
      versions,
    });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/artifacts/:id/refresh and /retry — build it again; the old version stays. */
export async function handleRebuildArtifact(ctx: RouteContext): Promise<Response> {
  try {
    const why = ctx.request.url.endsWith("/retry") ? "retry" : "refresh";
    const row = await rebuildArtifact(ctx.env, actorFromIdentity(ctx.identity!), (await visibleArtifact(ctx, ctx.params.id!)).id, why);
    return json(await artifactStatus(ctx.env, row), { status: 202 });
  } catch (err) {
    return fail(err);
  }
}

/** GET /api/artifacts/:id/export.pptx | export.docx — the same derivation the page renders, as a file. */
export async function handleExportArtifact(ctx: RouteContext): Promise<Response> {
  try {
    const row = await visibleArtifact(ctx, ctx.params.id!);
    const format = ctx.request.url.endsWith(".docx") ? "docx" : "pptx";
    const url = new URL(ctx.request.url);
    const wanted = Number(url.searchParams.get("version") ?? row.current_version_no) || row.current_version_no;
    const version = wanted > 0 ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM artifact_version WHERE artifact_id = ?1 AND version_no = ?2").bind(row.id, wanted).first<ArtifactVersionRow>() : null;
    if (!version) return json({ error: "not_ready", detail: `There is nothing to export yet — it is ${stateInWords(row)}.` }, { status: 409 });
    const spec = JSON.parse(version.spec_json) as ArtifactSpec;
    const bytes = format === "pptx" ? pptxBytes(spec) : docxBytes(spec);
    const slug = row.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || row.kind;
    await appendEvent(ctx.env, { eventType: "artifact.exported", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "artifact", objectId: row.id, firmScope: row.firm_scope, payload: { format, version_no: version.version_no } });
    // A Uint8Array over its own buffer; the cast is only the DOM lib's ArrayBufferLike narrowing.
    return new Response(bytes as unknown as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": format === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-disposition": `attachment; filename="${version.built_at.slice(0, 10)}-${slug}-v${version.version_no}.${format}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return fail(err);
  }
}

/** The lines a card's page shows for its artifact — used by the work-card read. */
export function artifactLineForCard(status: ArtifactStatus | null): string | null {
  if (!status) return null;
  return `${KIND_WORDS[status.kind].label} "${status.title}" — ${status.words}`;
}

/** The text a document rendering holds, for tests and the validator's round trip. */
export function documentText(spec: ArtifactSpec): string[] {
  return textOfDocument(documentFor(spec));
}

/** Exposed for the tests: the allowlist the planner is shown is the compiler's own. */
export const PLANNER_TABLES = Object.keys(ALLOWLIST);
