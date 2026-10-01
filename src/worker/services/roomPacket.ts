import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { findVenues, SEARCH_MODEL, servedBySearchLane } from "./liveSearch";
import { blockCard } from "./blocks";
import { pageTextOf, urlStatus } from "../effects/urlLiveness";
import {
  SPONSORSHIP_TARGET,
  audienceTerms,
  buildConceptsPrompt,
  buildPacketPrompt,
  buildSponsorDiscoveryMorePrompt,
  buildSponsorDiscoveryPrompt,
  mergeCandidates,
  pickForResearch,
  buildSponsorResearchPrompt,
  computeEconomics,
  followingMonth,
  inviteVerdict,
  mergeBriefSponsors,
  monthKey,
  pageCarriesName,
  parseConcepts,
  parsePacket,
  parseSponsorCandidates,
  parseSponsorResearch,
  roomOneLiner,
  sameOrg,
  venueSearchBrief,
  verifyPacket,
  type InviteCheck,
  type PacketFlag,
  type PacketOrigin,
  type RoomBrief,
  type RoomConcept,
  type RoomEconomics,
  type RoomPacket,
  type RunOfShowLine,
  type SponsorCandidate,
  type SponsorResearch,
} from "../../shared/events/roomPacket";
import { packetFilename, parkerIntroduction, renderPacketHtml, renderWorkshopHtml, type PacketView, type SponsorView, type VenueView } from "../../shared/events/roomPacketPdf";
import {
  WORKSHOP_LENGTH_RANGE,
  WORKSHOP_SERIES,
  WORKSHOP_WHERE,
  buildWorkshopConceptsPrompt,
  buildWorkshopDiscoveryPrompt,
  buildWorkshopJudgePrompt,
  buildWorkshopPacketPrompt,
  computeWorkshopEconomics,
  packetKindOf,
  parkerWorkshopIntroduction,
  parseWorkshopConcepts,
  parseWorkshopNotes,
  parseWorkshopPacket,
  parseWorkshopVerdicts,
  renderWorkshopText,
  setWorkshopTitle,
  verifyWorkshopPacket,
  workshopTopic,
  normaliseSponsorship,
  type PacketKind,
  type WorkshopConcept,
  type WorkshopFlag,
  type WorkshopNote,
  type WorkshopView,
} from "../../shared/events/workshopPacket";
import { adjacencyWindow, classifyAsk, deliveryMonth, dueOn, planFor, topicFor, type Stream } from "../../shared/events/monthlyPlan";
import { markDelivered, recordSteer, steerForMonth, withdrawSteer, steerBoard, MonthSteerError } from "./monthSteer";
import { howToAnswer } from "../../shared/events/packetDecisionToken";
import { tokenForPacket } from "./packetReplyDecision";
import { guidanceBlock } from "../../shared/skills/library";
import { writtenGuidance } from "./firmSkills";
import { sendOrPreview } from "./previewApproval";
import { parkerAddressedNote, parkerSponsorAsk } from "../../shared/events/parkerNote";
import { sendPartnersEmail } from "./execEmail";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { notifyPartners } from "./notifications";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { uploadDocument } from "./documents";
import { buildAndFileEventKit, eventKitEmailBullets, eventKitOf } from "./eventKit";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import type { InstructionPiece } from "../../shared/work/instruction";

/**
 * Room proposals — Parker's job, run as a CHAIN (P51, docs/COMMUNITY.md; rebuilt 15 Sep 2026).
 *
 * SHAPE: queue → (card on Parker's desk) → discover sponsors → research each → ideate three
 * concepts and choose → search venues for the winner → write the packet → render the PDF and
 * email both partners → a human decides → it becomes a Room.
 *
 * WHY A CHAIN AND NOT ONE PROMPT. The operator's verdict on the one-prompt packet was "sub par",
 * and the standard she showed (a Gemini transcript) was a sequence of research steps and
 * judgements: what the named sponsor actually sponsors, who runs its partnerships, three concepts
 * compared, a venue with a reason, a run of show to the minute, a budget with its basis, and the
 * cold email. Each of those is its own model call or page fetch; several of them together are far
 * more than a Free-plan cron tick can carry. So the build is a work card (kind ROOM_PACKET) the
 * employee sweep works ONE STAGE PER TICK, with the state of earlier stages on the packet row —
 * a tick that dies loses a stage, not the packet, and the page says which stage Parker is on.
 *
 * WHY A PROPOSAL AND NOT A ROOM. Parker suggests at least one Room a month; West Peek runs far
 * fewer. That is the intended ratio, not a failure of the job — the value is a standing shelf of
 * ready proposals to choose from.
 *
 * WHY EVERY SEARCH RUNS FIRST. The model is only allowed to cite venues the search returned,
 * evidence the research verified, and contacts read off fetched pages; verifyPacket() strips
 * anything else. Giving it the real list up front means the good answer is also the easy one.
 */

export class RoomPacketError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface PacketRow {
  id: string;
  title: string;
  theme: string;
  central_question: string | null;
  status: string;
  proposed_for_month: string;
  format: string;
  live_url: string | null;
  target_min: number;
  target_max: number;
  audience: string | null;
  agenda_md: string | null;
  seed_questions_json: string;
  guest_ideas_json: string;
  economics_json: string;
  sponsor_thesis: string | null;
  ai_run_id: string | null;
  event_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  firm_scope: string;
  origin: PacketOrigin;
  brief_json: string | null;
  requested_by: string | null;
  sponsor_count: number;
  sponsor_total_usd: number;
  risks_json: string;
  commitment_md: string | null;
  build_error: string | null;
  build_attempts: number;
  parent_packet_id: string | null;
  emailed_at: string | null;
  build_stage: BuildStage;
  build_state_json: string | null;
  work_card_id: string | null;
  concepts_json: string;
  concept_choice_md: string | null;
  run_of_show_json: string;
  pitch_email_json: string | null;
  invite_check_json: string | null;
  pushback_md: string | null;
  document_id: string | null;
  created_at: string;
  /** ROOM or WORKSHOP (0171). Every row before then is a Room. */
  kind?: PacketKind | null;
  /** What only a Workshop has — see shared/events/workshopPacket.ts `WorkshopView`. */
  workshop_json?: string | null;
  /** The draft proposed event kit (0180) — see shared/events/eventKit.ts `EventKit`. */
  event_kit_json?: string | null;
  /** Where the kit is filed, so the email can link to it rather than carry it (0180). */
  event_kit_deliverable_id?: string | null;
}

/** The brief as stored. A malformed one is null, never a crash on the page. */
export function parseBrief(raw: string | null): RoomBrief | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Partial<RoomBrief>;
    if (!b || typeof b.audience !== "string" || typeof b.month !== "string") return null;
    return {
      audience: b.audience,
      month: b.month,
      city: typeof b.city === "string" ? b.city : null,
      sponsorProspects: Array.isArray(b.sponsorProspects) ? b.sponsorProspects.filter((x): x is string => typeof x === "string") : [],
      notes: typeof b.notes === "string" ? b.notes : null,
    };
  } catch {
    return null;
  }
}

async function requirePacket(env: Env, id: string): Promise<PacketRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>();
  if (!row) throw new RoomPacketError(404, "not_found", "no such Room packet");
  return row;
}

// ── The stages ───────────────────────────────────────────────────────────────

export const BUILD_STAGES = ["QUEUED", "DISCOVER", "RESEARCH", "CONCEPTS", "VENUES", "PACKET", "KIT", "PDF", "DONE"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

/** What the page says while Parker is on each stage. */
export const BUILD_STAGE_LABELS: Readonly<Record<BuildStage, string>> = {
  QUEUED: "waiting for Parker to pick it up",
  DISCOVER: "reading the firm's list and finding who pays to be in front of this audience",
  RESEARCH: "researching each sponsor — their programme, the people who run it, their own words",
  CONCEPTS: "ideating three concepts and choosing one",
  VENUES: "searching venues for the chosen concept",
  PACKET: "writing the packet — run of show, budget, structure, the pitch",
  KIT: "drafting the proposed event kit for the angle he would run — the run of show with who is on screen, the questions, the posts",
  PDF: "rendering the PDF and emailing both partners",
  DONE: "done",
};

/**
 * The same stages, read differently for a Workshop (16 Sep 2026): no sponsors are researched and
 * no venue is searched — a Workshop is virtual on West Peek Live — so DISCOVER is "what is the
 * audience asking this month", RESEARCH and VENUES are passed through, and the packet is the
 * delivery plan. One list of stages, so the page's progress bar and the sweep's retry logic are
 * one thing; the labels say what Parker is actually doing.
 */
export const WORKSHOP_STAGE_LABELS: Readonly<Record<BuildStage, string>> = {
  QUEUED: "waiting for Parker to pick it up",
  DISCOVER: "researching what small-business owners, solopreneurs and community builders are asking this month",
  RESEARCH: "(no sponsor research for a Workshop — sponsors are optional)",
  CONCEPTS: "ideating three ways to run it and choosing one",
  VENUES: "(no venue — a Workshop is virtual on West Peek Live)",
  PACKET: "writing the packet — the run of show with exercises, the delivery plan, the invitations",
  KIT: "drafting the proposed event kit for the angle he would run — the run of show with who is on screen, the questions, the posts",
  PDF: "rendering the PDF and emailing both partners",
  DONE: "done",
};

export function stageLabelFor(kind: PacketKind, stage: BuildStage): string {
  return kind === "WORKSHOP" ? WORKSHOP_STAGE_LABELS[stage] : BUILD_STAGE_LABELS[stage];
}

/**
 * The steps this chain has, in the words a person would use, for the interpretation pass.
 *
 * NAMED FOR THE MODEL, NOT FOR THE CODE. `services/instruction.ts` shows the model this list and
 * asks it to say which of her directives change one of these steps (a STEER) and which ask for
 * something none of them does (a CANNOT). Without the list every instruction comes back honourable
 * — the model has no way to know the chain cannot book a venue or invite anybody — and "it can be
 * steered" would be a claim nothing tested. Derived from the stage labels so a stage added to the
 * chain cannot be left out of the list the interpreter reads.
 */
const A_PARTNER_EXTENDS_SCOPE =
  "A Managing Partner's own instruction extends what you do here — apply it using judgement and whatever you already have access to, rather than treating it as out of scope. Only decline something that genuinely needs a tool, data source or integration that does not exist anywhere in this system, or that would need to pass through approval regardless of who asked.";

export const STAGE_STEPS: Readonly<Record<PacketKind, string[]>> = {
  ROOM: [
    ...BUILD_STAGES.filter((s) => s !== "QUEUED" && s !== "DONE").map((s) => BUILD_STAGE_LABELS[s]),
    "Nothing is booked, nobody outside the firm is contacted, and no money is committed — the result is a proposal a partner decides on.",
    A_PARTNER_EXTENDS_SCOPE,
  ],
  WORKSHOP: [
    ...BUILD_STAGES.filter((s) => s !== "QUEUED" && s !== "DONE" && s !== "RESEARCH" && s !== "VENUES").map((s) => WORKSHOP_STAGE_LABELS[s]),
    `A Workshop is virtual only (${WORKSHOP_WHERE}); no venue is researched and no sponsor is required.`,
    "Nothing is scheduled, nobody outside the firm is contacted, and the result is a proposal a partner decides on.",
    A_PARTNER_EXTENDS_SCOPE,
  ],
};

/** How many sponsors get the full research treatment, and how many per tick. */
export const MAX_RESEARCHED = 6;
export const RESEARCH_PER_TICK = 2;
/** How many pages are fetched to verify one sponsor's contact and evidence. */
const PAGES_PER_SPONSOR = 3;

export interface BuildState {
  candidates: SponsorCandidate[];
  research: SponsorResearch[];
  /** Organisations already researched (or given up on), so a retried tick does not repeat one. */
  researched: string[];
  inviteCheck: InviteCheck | null;
  concepts: RoomConcept[];
  choiceRationale: string | null;
  pushback: string | null;
  venueHits: Array<{ name: string; url: string; description: string | null }>;
  venueCitations: string[];
  venueDetail: string | null;
  flags: PacketFlag[];
  pdfError: string | null;
  discoveryDetail: string | null;
  /** Candidates discovery dropped, with the status their page answered — so the packet can say who was looked at. */
  dropped: Array<{ orgName: string; url: string; status: number | null }>;
  /** A Workshop's research: what the audience is asking, live-checked and judged. */
  workshopNotes: WorkshopNote[];
  workshopDropped: string[];
  workshopRejected: Array<{ url: string; reason: string }>;
  workshopFlags: WorkshopFlag[];
  /**
   * THE MONTH'S ONE SUBJECT, settled at the angles stage and carried forward.
   *
   * It is on the state rather than re-derived at each stage because for a month nobody set, PARKER
   * chose it — so it exists only in the answer he gave, and the packet stage must build on that one
   * rather than ask again and get a different subject.
   */
  workshopTopic: string | null;
  workshopTopicSetBy: "PARTNERS" | "PARKER" | null;
  /** The topic for a ROOM, settled the same way and for the same reason. */
  roomTopic: string | null;
  roomTopicSetBy: "PARTNERS" | "PARKER" | null;
}

export function emptyState(): BuildState {
  return { candidates: [], research: [], researched: [], inviteCheck: null, concepts: [], choiceRationale: null, pushback: null, venueHits: [], venueCitations: [], venueDetail: null, flags: [], pdfError: null, discoveryDetail: null, dropped: [], workshopNotes: [], workshopDropped: [], workshopRejected: [], workshopFlags: [], workshopTopic: null, workshopTopicSetBy: null, roomTopic: null, roomTopicSetBy: null };
}

export function parseState(raw: string | null): BuildState {
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw) as Partial<BuildState>;
    return { ...emptyState(), ...s };
  } catch {
    return emptyState();
  }
}

async function saveStage(env: Env, id: string, stage: BuildStage, state: BuildState): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE evt_room_packet SET build_stage = ?2, build_state_json = ?3, build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(id, stage, JSON.stringify(state)).run();
}

/** Injectable so the whole chain is testable without a model, a browser or a network. */
export type VenueSearch = typeof findVenues;
export type Synthesise = (prompt: string) => Promise<{ text: string; aiRunId: string | null }>;
export type ResearchSearch = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; citations: string[]; detail: string }>;
/** The status a URL answers with; null when nothing answered. */
export type UrlCheck = (url: string) => Promise<number | null>;

/**
 * What a status means for a cited page. Under 400 it answered; 401/403/405/429 it exists and
 * refused an automated read (a corporate site behind bot protection) — kept, and a person checks
 * it; anything else (404, 410, 5xx, nothing) is a page that is not there.
 */
export function evidenceVerdict(status: number | null): "live" | "guarded" | "dead" {
  if (status === null) return "dead";
  if (status < 400) return "live";
  if ([401, 403, 405, 429].includes(status)) return "guarded";
  return "dead";
}
const GUARDED_NOTE = " [page exists but refused an automated read — verify by hand]";
export type PageText = (url: string) => Promise<string | null>;
export type RenderPdf = (html: string) => Promise<{ pdfBase64: string; pageCount: number } | { pdfBase64: null; reason: string }>;

/** The judgement pass over what the search model found (a Workshop's research notes). */
export type Judge = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;

export interface ChainDeps {
  search?: VenueSearch;
  research?: ResearchSearch;
  judge?: Judge;
  synthesise?: Synthesise;
  urlCheck?: UrlCheck;
  pageText?: PageText;
  render?: RenderPdf;
  now?: Date;
  /**
   * WHAT THE PARTNER ASKED FOR ON THIS PARTICULAR PACKET, already read by a model.
   *
   * Set by `runRoomPacketCard` from `services/instruction.ts` before the first stage runs, and
   * prefixed to EVERY prompt this chain builds — the discovery search, the judgement pass and each
   * synthesis. Prefixed in one place rather than threaded through eight call sites, because a
   * steer that has to be remembered at each stage is a steer that will be forgotten at one of
   * them; that is exactly how `work_card.prompt` came to be read by nothing at all.
   */
  steer?: string;
  /**
   * The model call that reads what she asked for. Injectable for the same reason every other model
   * call in this chain is: a test proves the steering, not the provider. A test that forgets to
   * supply one gets a BLOCKED card rather than a silently unsteered packet, which is the right way
   * round — the whole defect being closed is work that carried on without her words.
   */
  interpret?: Interpreter;
}

function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []).map((u) => u.replace(/[.,;]+$/, ""))));
}

/** The search-grounded model, and only that model — an answer from a model that cannot search is refused. */
const defaultResearch: ResearchSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Parker: Room sponsor research",
    actor,
    inputs: [prompt],
    // Public web research; the query leaves for a search engine. Never raised.
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: true, expectedOutputTokens: 2500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", citations: [], detail: run.failure_reason ?? `run ${run.status}` };
  if (!servedBySearchLane(run.model)) return { ok: false, text: "", citations: [], detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  return { ok: true, text: run.output_text, citations: extractUrls(run.output_text), detail: "ok" };
};

/** The judge reads what the searcher wrote and holds it to the brief; it must not be the search model. */
const defaultJudge: Judge = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Parker: Workshop research judgement",
    actor,
    inputs: [prompt],
    sensitivity: "PUBLIC" as never,
    // JUDGEMENT, so the router keeps the search model out — this pass exists to hold what the
    // searcher wrote to the brief, and the searcher grading itself was Parker's block.
    budgetContext: { expectedOutputTokens: 1200, providerKey: "openrouter", judgement: true },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model === SEARCH_MODEL) return { ok: false, text: "", detail: "the judgement was routed to the search model" };
  return { ok: true, text: run.output_text, detail: "ok" };
};

async function defaultSynthesise(env: Env, actor: Actor, purpose: string, prompt: string, expectedOutputTokens: number): Promise<{ text: string; aiRunId: string | null }> {
  const { run } = await runAi(env, {
    purpose,
    actor,
    inputs: [prompt],
    // The prompt carries public research, a city, a theme and counts from the firm's own list —
    // no member identities beyond names already in its own records.
    sensitivity: "PUBLIC" as never,
    // The packet Sequoia forwards to Scooter. Not the place a cost posture economises.
    budgetContext: { expectedOutputTokens, providerKey: "openrouter", judgement: true },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) {
    throw new RoomPacketError(502, "synthesis_failed", run.failure_reason ?? `run ${run.status}`);
  }
  return { text: run.output_text, aiRunId: run.id };
}

/** Letter-portrait PDF through Browser Rendering — the deck's launch pattern, a page size apart. */
async function defaultRender(env: Env, html: string): Promise<{ pdfBase64: string; pageCount: number } | { pdfBase64: null; reason: string }> {
  const binding = (env as unknown as { BROWSER?: unknown }).BROWSER;
  if (!binding) return { pdfBase64: null, reason: "no browser is available here — the BROWSER binding is not configured" };
  let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
  try {
    const puppeteer = await import("@cloudflare/puppeteer");
    browser = (await puppeteer.launch(binding as never)) as unknown as { newPage(): Promise<any>; close(): Promise<void> };
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const bytes: Uint8Array = new Uint8Array(await page.pdf({ format: "letter", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } }));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const pageCount = (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { pdfBase64: btoa(binary), pageCount };
  } catch (err) {
    return { pdfBase64: null, reason: `the browser could not render the packet: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export const PARKER_ACTOR = (firmScope: string): Actor => ({ type: "AI", aiEmployeeId: "aie_parker", roles: [], firmScopes: [firmScope] });

// ── Queueing ─────────────────────────────────────────────────────────────────

/**
 * Put a Room on the queue as a DRAFT — the brief is on the record before any model is called —
 * and open the card on Parker's desk that the sweep will work.
 *
 * ONE QUEUE, TWO DOORS. A partner's brief and Parker's own monthly idea both land here; `origin`
 * says which. A second identical request in the same month joins the first.
 */
export async function queueDraft(
  env: Env,
  actor: Actor,
  input: { month: string; origin: PacketOrigin; brief?: RoomBrief | null; parentPacketId?: string | null; kind?: PacketKind },
): Promise<PacketRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const kind: PacketKind = input.kind ?? "ROOM";
  const id = `rpk_${crypto.randomUUID()}`;
  // A WORKSHOP IN A SERIES MONTH IS BUILT FROM THE SET TITLE, whatever was typed: the partners
  // decided September and November; the brief's own words are kept as notes for Parker.
  const setTitle = kind === "WORKSHOP" ? setWorkshopTitle(input.month) : null;
  let brief = input.brief ?? null;
  if (kind === "WORKSHOP") {
    const asked = brief?.audience?.trim() && brief.audience !== "Parker's own Room" ? brief.audience.trim() : null;
    brief = {
      audience: setTitle ?? asked ?? "Parker's own Workshop",
      month: input.month,
      city: null,
      sponsorProspects: brief?.sponsorProspects ?? [],
      notes: [setTitle && asked && asked !== setTitle ? `Asked as: ${asked}` : null, brief?.notes ?? null].filter(Boolean).join(" · ") || null,
      kind: "WORKSHOP",
    } as RoomBrief;
  }
  const theme = kind === "WORKSHOP" ? (setTitle ?? brief?.audience ?? "Parker's Workshop for the month") : (brief?.audience ?? "Parker's proposal for the month");
  const title =
    kind === "WORKSHOP"
      ? setTitle
        ? `Workshop: ${setTitle.slice(0, 70)}`
        : brief && brief.audience !== "Parker's own Workshop" && input.origin === "PARTNER_BRIEF"
          ? `Workshop requested: ${brief.audience.slice(0, 70)}`
          : `Parker's Workshop for ${input.month}`
      : brief
        ? `Room requested: ${brief.audience.slice(0, 70)}`
        : `Parker's Room for ${input.month}`;
  const existing = await env.WP_OS_DB.prepare(
    "SELECT * FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3",
  ).bind(firmScope, input.month, title).first<PacketRow>();
  if (existing) return existing;

  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_room_packet
       (id, title, theme, status, proposed_for_month, origin, brief_json, requested_by, parent_packet_id,
        firm_scope, created_by, build_stage, kind, format)
     VALUES (?1,?2,?3,'DRAFT',?4,?5,?6,?7,?8,?9,?10,'QUEUED',?11,?12)`,
  )
    .bind(
      id, title, theme, input.month, input.origin,
      brief ? JSON.stringify(brief) : null,
      input.origin === "PARTNER_BRIEF" ? (actor.firmUserId ?? null) : null,
      input.parentPacketId ?? null,
      firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
      kind, kind === "WORKSHOP" ? "WORKSHOP" : "DINNER",
    )
    .run();

  await appendEvent(env, {
    eventType: "room_packet.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    objectType: "room_packet", objectId: id, firmScope,
    payload: { month: input.month, origin: input.origin, kind, sponsors_named: brief?.sponsorProspects.length ?? 0, parent: input.parentPacketId ?? null, title_set: Boolean(setTitle) },
  });
  return await requirePacket(env, id);
}

/**
 * The card on Parker's desk. Idempotent: a draft has one card, and a card the sweep is already
 * working is left alone. The sweep finds the packet by `work_card_id`.
 */
export async function openPacketCard(env: Env, draft: PacketRow): Promise<{ opened: boolean; cardId: string }> {
  if (draft.work_card_id) {
    const live = await env.WP_OS_DB.prepare("SELECT id, state FROM work_card WHERE id = ?1").bind(draft.work_card_id).first<{ id: string; state: string }>();
    if (live && live.state !== "CANCELLED" && live.state !== "DONE") return { opened: false, cardId: live.id };
  }
  const brief = parseBrief(draft.brief_json);
  const kind = packetKindOf(draft.kind);
  const title = kind === "WORKSHOP"
    ? `Parker: build the ${monthWord(draft.proposed_for_month)} Workshop packet — ${draft.title.replace(/^Workshop(?: requested)?: /, "").slice(0, 60)}`
    : `Parker: build the ${monthWord(draft.proposed_for_month)} Room packet — ${draft.title.slice(0, 60)}`;
  const card = await createWorkCardInternal(env, sweepIdentity(draft.firm_scope), {
    title,
    description: kind === "WORKSHOP"
      ? [
          setWorkshopTitle(draft.proposed_for_month)
            ? `The ${monthWord(draft.proposed_for_month)} Workshop's title is SET by the partners: "${setWorkshopTitle(draft.proposed_for_month)}". Build its packet from that title; do not re-ideate the topic.${brief?.notes ? ` Notes: ${brief.notes}` : ""}`
            : brief && brief.audience !== "Parker's own Workshop" ? `A partner asked for this Workshop: "${brief.audience}"${brief.notes ? `. Notes: ${brief.notes}` : "."}` : `Parker's own Workshop for ${monthWord(draft.proposed_for_month)}: propose three and choose.`,
          "",
          `The chain, one stage per sweep tick: research what small-business owners, solopreneurs and community builders are asking this month (live search, every URL checked, every note judged) → three ways to run it compared, one chosen → the packet (the promise, the run of show to the minute with breakout exercises, what they leave with, the facilitator, the delivery plan on ${WORKSHOP_WHERE}, sponsorship optional, the promo line, three invitation emails, the budget) → the PDF, emailed to both partners.`,
          `Packet: ${draft.id}. Virtual only — no venue is researched. Nothing is scheduled and nobody outside the firm is contacted.`,
        ].join("\n")
      : [
          brief ? `A partner asked for this Room: "${brief.audience}"${brief.city ? ` in ${brief.city}` : ""}${brief.sponsorProspects.length ? `; sponsors named: ${brief.sponsorProspects.join(", ")}` : ""}${brief.notes ? `. Notes: ${brief.notes}` : "."}` : `Parker's own Room for ${monthWord(draft.proposed_for_month)}.`,
          "",
          "The chain, one stage per sweep tick: read the firm's list and discover who pays to reach this audience → research each sponsor (programme, the people who run partnerships, their own words) → three concepts compared, one chosen → venues for the winner → the packet (run of show to the minute, budget with basis, sponsorship structure priced to cost + the firm's keep, the pitch email) → the PDF, emailed to both partners.",
          `Packet: ${draft.id}. Nothing is booked and nobody outside the firm is contacted.`,
        ].join("\n"),
    owner_type: "AI",
    owner_id: "aie_parker",
    priority: "NORMAL",
    firm_scope: draft.firm_scope,
    next_action: "Run the chain; the packet lands on Events & Rooms and in both partners' inboxes.",
  });
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'ROOM_PACKET' WHERE id = ?1").bind(card.id),
    env.WP_OS_DB.prepare("UPDATE evt_room_packet SET work_card_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(draft.id, card.id),
  ]);
  return { opened: true, cardId: card.id };
}

// ── The invite-list reality check ────────────────────────────────────────────

/**
 * What the firm's own records can put in the room. Counts from `network_external_mapping`
 * (contacts synced from Network OS) matched on the audience's vocabulary in the fields a person
 * is described by. Names come ONLY from these records — never from a model.
 */
export async function inviteCheck(env: Env, firmScope: string, brief: RoomBrief | null, targetMax: number): Promise<InviteCheck> {
  const { label, terms } = audienceTerms(brief?.audience);
  const total = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM network_external_mapping WHERE resource = 'contact' AND firm_scope = ?1").bind(firmScope).first<{ n: number }>();
  const totalContacts = total?.n ?? 0;
  if (terms.length === 0) {
    const v = inviteVerdict(totalContacts, targetMax);
    return { totalContacts, matchingCount: totalContacts, matchedOn: [label], archetypes: [], namedFromRecords: [], verdict: v.verdict, note: `The audience is the community at large. ${v.note}` };
  }
  // The person is described in these five fields; the whole snapshot would also match an email
  // domain or a note about somebody else.
  const fields = ["$.person_type", "$.relationship_type", "$.tags", "$.context_summary", "$.company"];
  const clause = fields.map((f) => `lower(COALESCE(json_extract(snapshot_json, '${f}'), ''))`).join(" || ' ' || ");
  const where = terms.map((_, i) => `haystack LIKE ?${i + 2}`).join(" OR ");
  const sql = `SELECT full_name, company, relationship_type, person_type, tags FROM (
      SELECT json_extract(snapshot_json, '$.full_name') AS full_name, json_extract(snapshot_json, '$.company') AS company,
             json_extract(snapshot_json, '$.relationship_type') AS relationship_type, json_extract(snapshot_json, '$.person_type') AS person_type,
             json_extract(snapshot_json, '$.tags') AS tags, ${clause} AS haystack
        FROM network_external_mapping WHERE resource = 'contact' AND firm_scope = ?1)
    WHERE ${where} LIMIT 60`;
  const rows = (await env.WP_OS_DB.prepare(sql).bind(firmScope, ...terms.map((t) => `%${t}%`)).all<{ full_name: string | null; company: string | null; relationship_type: string | null; person_type: string | null; tags: string | null }>()).results ?? [];
  const matchingCount = rows.length;
  const archetypes = Array.from(new Set(rows.map((r) => [r.person_type === "lawyer" ? "lawyer" : r.relationship_type, r.company ? `at ${r.company}` : null].filter(Boolean).join(" ")).filter((s) => s.length > 3))).slice(0, 8);
  const namedFromRecords = rows.map((r) => (r.full_name ?? "").trim()).filter((n) => n.length > 2 && !n.startsWith("*")).slice(0, 12);
  const v = inviteVerdict(matchingCount, targetMax);
  return { totalContacts, matchingCount, matchedOn: [label], archetypes, namedFromRecords, verdict: v.verdict, note: v.note };
}

// ── The stage runner ─────────────────────────────────────────────────────────

export interface StageResult {
  stage: BuildStage;
  next: BuildStage;
  note: string;
}

/**
 * Run ONE stage of the chain for a draft. Each stage reads the state earlier stages left, does its
 * model calls and fetches, saves the state and the next stage. A stage that throws leaves the
 * packet where it was with `build_error` on it; the sweep counts the attempt and retries the same
 * stage, so a dead tick costs one stage.
 */
export async function runStage(env: Env, draft: PacketRow, deps: ChainDeps = {}): Promise<StageResult> {
  const firmScope = draft.firm_scope;
  const actor = PARKER_ACTOR(firmScope);
  const brief = parseBrief(draft.brief_json);
  const city = brief?.city ?? "New York";
  const state = parseState(draft.build_state_json);
  /*
   * EVERY PROMPT THIS CHAIN BUILDS CARRIES WHAT SHE ASKED FOR, and it is done HERE rather than at
   * each of the eight places a prompt is built. A steer that each stage has to remember to include
   * is a steer one stage will forget, which is the shape of the defect this closes: her words were
   * on the card the whole time and not one stage read them.
   */
  const withSteer = (prompt: string): string => (deps.steer ? `${deps.steer}\n\n${prompt}` : prompt);
  const rawResearch = deps.research ?? defaultResearch;
  const research: ResearchSearch = (e, a, prompt) => rawResearch(e, a, withSteer(prompt));
  const check = deps.urlCheck ?? ((u: string) => urlStatus(u));
  const pageText = deps.pageText ?? ((u: string) => pageTextOf(u));
  const synth = (purpose: string, prompt: string, tokens: number) =>
    deps.synthesise ? deps.synthesise(withSteer(prompt)) : defaultSynthesise(env, actor, purpose, withSteer(prompt), tokens);
  const rawJudge = deps.judge ?? defaultJudge;
  const judge: Judge = (e, a, prompt) => rawJudge(e, a, withSteer(prompt));
  const stage: BuildStage = draft.build_stage === "QUEUED" ? "DISCOVER" : draft.build_stage;

  const failStage = async (detail: string): Promise<never> => {
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET build_error = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(draft.id, `${stage}: ${detail}`.slice(0, 500)).run();
    throw new RoomPacketError(502, "stage_failed", `${stage}: ${detail}`);
  };

  // A WORKSHOP TAKES THE SAME STAGES WITH A DIFFERENT BRIEF — and no sponsors, no venue.
  if (packetKindOf(draft.kind) === "WORKSHOP") {
    try {
      return await runWorkshopStage(env, draft, stage, state, { research, judge, synth, check, render: deps.render ?? ((html: string) => defaultRender(env, html)), actor });
    } catch (err) {
      if (err instanceof RoomPacketError) throw err;
      return await failStage(err instanceof Error ? err.message : String(err));
    }
  }

  try {
    if (stage === "DISCOVER") {
      state.inviteCheck = await inviteCheck(env, firmScope, brief, draft.target_max || 40);
      const found = await research(env, actor, buildSponsorDiscoveryPrompt({ brief, city, month: draft.proposed_for_month }));
      if (!found.ok) return await failStage(`sponsor discovery search failed: ${found.detail}`);
      const firstPass = parseSponsorCandidates(found.text, brief);
      // A SECOND SEARCH FROM OTHER LISTS. One sponsor page is an answer key, not a market; the
      // second pass names what the first found and is told not to cite those hosts again.
      const more = await research(env, actor, buildSponsorDiscoveryMorePrompt({ brief, city, month: draft.proposed_for_month, already: firstPass }));
      const parsed = more.ok ? mergeCandidates(firstPass, parseSponsorCandidates(more.text, brief)) : firstPass;
      // Every evidence URL is asked for its status before the candidate is kept. A citation the
      // search transcribed wrongly would otherwise reach the packet as proof.
      const checked = await Promise.all(parsed.map(async (c) => { const status = await check(c.evidenceUrl); return { c, status, verdict: evidenceVerdict(status) }; }));
      state.candidates = checked.filter((x) => x.verdict !== "dead").map((x) => (x.verdict === "guarded" ? { ...x.c, evidenceNote: `${x.c.evidenceNote}${GUARDED_NOTE}` } : x.c));
      state.dropped = checked.filter((x) => x.verdict === "dead").map((x) => ({ orgName: x.c.orgName, url: x.c.evidenceUrl, status: x.status }));
      // A seed she named that discovery did not return is still researched: its evidence comes
      // from its own research stage, or the packet says it has none.
      for (const named of brief?.sponsorProspects ?? []) {
        if (!state.candidates.some((c) => sameOrg(c.orgName, named))) {
          state.candidates.unshift({ orgName: named, category: "OTHER", evidenceUrl: "", evidenceNote: "", whyThisAudience: "named by the partner", fromBrief: true });
        }
      }
      state.discoveryDetail = `${parsed.length} candidate(s) found, ${state.dropped.length} dropped because the cited page did not answer${state.dropped.length ? ` (${state.dropped.map((d) => `${d.orgName}: ${d.status ?? "no answer"}`).join(", ")})` : ""}`;
      await saveStage(env, draft.id, "RESEARCH", state);
      return { stage, next: "RESEARCH", note: `${state.candidates.length} sponsor candidate(s) with live evidence; ${state.inviteCheck.matchingCount} of ${state.inviteCheck.totalContacts} contacts match the audience (${state.inviteCheck.verdict})` };
    }

    if (stage === "RESEARCH") {
      // Hers first, then round-robin by category, so the six researched are not six of one kind.
      const shortlist = pickForResearch(state.candidates, MAX_RESEARCHED);
      const todo = shortlist.filter((c) => !state.researched.some((r) => sameOrg(r, c.orgName))).slice(0, Math.max(0, Math.min(RESEARCH_PER_TICK, MAX_RESEARCHED - state.research.length)));
      for (const c of todo) {
        const r = await research(env, actor, buildSponsorResearchPrompt({ orgName: c.orgName, roomLine: roomOneLiner(brief, city), audience: brief?.audience ?? "operators, founders and their advisers" }));
        state.researched.push(c.orgName);
        if (!r.ok) continue;
        const raw = parseSponsorResearch(r.text);
        // Evidence: discovery's URL (already live) plus up to three of the research's, each checked.
        const evidence: SponsorResearch["evidence"] = c.evidenceUrl ? [{ url: c.evidenceUrl, note: c.evidenceNote }] : [];
        const extra = raw.history.filter((h) => !evidence.some((e) => e.url === h.url)).slice(0, PAGES_PER_SPONSOR);
        const live = await Promise.all(extra.map(async (h) => { const status = await check(h.url); return { h, verdict: evidenceVerdict(status) }; }));
        for (const x of live) if (x.verdict === "live") evidence.push(x.h); else if (x.verdict === "guarded") evidence.push({ ...x.h, note: `${x.h.note}${GUARDED_NOTE}` });
        // Contact: the first named person whose page, fetched, actually carries the name.
        let contact: SponsorResearch["contact"] = null;
        for (const cand of raw.contacts.slice(0, PAGES_PER_SPONSOR)) {
          const text = await pageText(cand.sourceUrl);
          if (text && pageCarriesName(text, cand.name)) { contact = { name: cand.name, title: cand.title, sourceUrl: cand.sourceUrl }; break; }
        }
        state.research.push({
          orgName: c.orgName,
          category: c.category !== "OTHER" ? c.category : raw.category ?? "OTHER",
          hasSponsorshipHistory: evidence.length > 0,
          evidence,
          contact,
          strategicLanguage: raw.strategicLanguage.map((s) => s.phrase),
          summary: raw.summary,
          fromBrief: c.fromBrief,
        });
      }
      const remaining = shortlist.filter((c) => !state.researched.some((r) => sameOrg(r, c.orgName))).length;
      const done = remaining === 0 || state.research.length >= MAX_RESEARCHED;
      await saveStage(env, draft.id, done ? "CONCEPTS" : "RESEARCH", state);
      const last = state.research.slice(-todo.length);
      return {
        stage,
        next: done ? "CONCEPTS" : "RESEARCH",
        note: `researched ${last.map((r) => `${r.orgName} (${r.hasSponsorshipHistory ? `${r.evidence.length} evidence` : "no history"}${r.contact ? `, contact ${r.contact.name}` : ""})`).join("; ") || "nothing new"}; ${done ? "research complete" : `${remaining} to go`}`,
      };
    }

    if (stage === "CONCEPTS") {
      const recent = await env.WP_OS_DB.prepare(
        "SELECT title FROM evt_room_packet WHERE firm_scope = ?1 AND id != ?2 AND status != 'DRAFT' ORDER BY created_at DESC LIMIT 8",
      ).bind(firmScope, draft.id).all<{ title: string }>();
      /*
       * THE MONTH'S ONE TOPIC, settled before ideation: the partners' plan entry, then whatever a
       * human typed into the request form, then nothing — and nothing means Parker picks it in this
       * same call. He never waits and never asks which of the three he is in.
       */
      const { topic: roomTopic, setBy: roomSetBy, steer: planSteer } = topicFor(draft.proposed_for_month, "ROOM", brief?.audience ?? null);
      /*
       * AND EVERYTHING SHE HAS SAID SINCE, FOR THIS MONTH. `steerForMonth` merges the plan's
       * standing steer with the steers she recorded against this month from the page — the ones
       * that were deliberately NOT built when she gave them. This is the single place the Room
       * stream reads them, because "a steer that has to be remembered at each stage is a steer that
       * will be forgotten at one of them", and it is here rather than at queue time because a steer
       * given AFTER the draft was minted must still reach the packet.
       */
      const roomSteerRows = await steerForMonth(env, firmScope, draft.proposed_for_month, "ROOM", planSteer);
      const roomSteer = roomSteerRows.text;
      const ran = await whatActuallyRan(env, firmScope, draft.proposed_for_month, "ROOM");
      const prompt = buildConceptsPrompt({
        month: draft.proposed_for_month, city, topic: roomTopic, setBy: roomSetBy, steer: roomSteer, brief, ran,
        recentThemes: (recent.results ?? []).map((r) => r.title),
        inviteCheck: state.inviteCheck, sponsors: state.research, guidance: await guidanceFor(env, firmScope),
      });
      // Marked at the moment the words are IN the prompt, which is the moment it is true. A steer
      // marked delivered by a build that then failed would be a steer silently dropped.
      if (roomSteer) await markDelivered(env, roomSteerRows.rows, draft.id);
      const { text } = await synth("Room packet: one topic, three angles", prompt, 3000);
      // A three-subject answer is REJECTED, not flagged: the stage fails, the sweep retries it, and
      // nothing with three subjects in it is ever stored.
      const parsed = parseConcepts(text, roomSetBy === "PARTNERS" ? roomTopic : null);
      if (!parsed) return await failStage("the angles did not come back in a usable shape — every angle must be on the ONE topic for the month, and each must say so in `angle_on`");
      state.concepts = parsed.concepts;
      state.roomTopic = parsed.topic;
      state.roomTopicSetBy = roomSetBy;
      state.choiceRationale = parsed.choiceRationale;
      state.pushback = parsed.pushback;
      await saveStage(env, draft.id, "VENUES", state);
      const chosen = parsed.concepts.find((c) => c.chosen)!;
      return { stage, next: "VENUES", note: `topic "${parsed.topic}" (${roomSetBy === "PARTNERS" ? "the partners'" : "Parker's own pick"}); chose the angle "${chosen.title}" (${chosen.format}) over ${parsed.concepts.length - 1} other angle(s) on the same topic${parsed.pushback ? `; pushback: ${parsed.pushback.slice(0, 120)}` : ""}` };
    }

    if (stage === "VENUES") {
      const chosen = state.concepts.find((c) => c.chosen) ?? null;
      const search = deps.search ?? findVenues;
      const found = await search(env, actor, city, venueSearchBrief(chosen, brief, draft.target_max || 40));
      state.venueHits = found.hits.map((h) => ({ name: h.name, url: h.url ?? "", description: h.description }));
      state.venueCitations = found.citations;
      state.venueDetail = found.detail;
      await saveStage(env, draft.id, "PACKET", state);
      return { stage, next: "PACKET", note: `${state.venueHits.length} venue candidate(s) for "${chosen?.title ?? draft.title}"` };
    }

    if (stage === "PACKET") {
      const recent = await env.WP_OS_DB.prepare(
        "SELECT theme FROM evt_room_packet WHERE firm_scope = ?1 AND id != ?2 AND status != 'DRAFT' ORDER BY created_at DESC LIMIT 8",
      ).bind(firmScope, draft.id).all<{ theme: string }>();
      const prompt = buildPacketPrompt({
        month: draft.proposed_for_month,
        recentThemes: (recent.results ?? []).map((r) => r.theme),
        venueCandidates: state.venueHits,
        city,
        brief,
        concepts: state.concepts,
        choiceRationale: state.choiceRationale,
        pushback: state.pushback,
        sponsors: state.research,
        inviteCheck: state.inviteCheck,
        guidance: await guidanceFor(env, firmScope),
      });
      const { text, aiRunId } = await synth("Room packet proposal", prompt, 7000);
      const parsed = parsePacket(text);
      if (!parsed) return await failStage("the proposal did not come back as a usable packet");
      const allowed = [...state.venueHits.map((h) => h.url), ...state.venueCitations].filter(Boolean);
      const verified = verifyPacket(parsed, allowed, state.research);
      const packet = mergeBriefSponsors(verified.packet, brief, state.research);
      state.flags = verified.flags;
      const economics = computeEconomics({
        venues: packet.venues,
        targetAttendees: Math.round((packet.targetMin + packet.targetMax) / 2),
        structure: packet.structure,
        budgetLines: packet.budgetLines,
      });
      if (!economics.reachesKeep) state.flags.push({ code: "structure_short_of_keep", detail: `All slots sold bring $${economics.sponsorTargetHighUsd.toLocaleString("en-US")} against $${economics.requiredUsd.toLocaleString("en-US")} needed for cost plus the firm's keep.` });
      await storePacket(env, draft, packet, economics, aiRunId, state, actor);
      return { stage, next: "KIT", note: `"${packet.title}": ${packet.venues.length} venue(s), ${packet.sponsorProspects.length} sponsor(s) ranked, ${packet.runOfShow.length} run-of-show lines, ${economics.scenarios.length} slot(s) — the firm keeps $${economics.netHighUsd.toLocaleString("en-US")} if all land` };
    }


    /*
     * THE KIT — one draft proposed event kit for the angle he would run, both streams.
     *
     * It is here, between the packet and the PDF, because it READS the packet (the chosen angle,
     * the run of show, the hosts) and because the PDF stage sends the email that has to carry its
     * link. See services/eventKit.ts for why it is a stage and not a paragraph in the packet
     * prompt, and why the email carries a link instead of the kit.
     */
    if (stage === "KIT") {
      const built = await requirePacket(env, draft.id);
      const kit = await buildAndFileEventKit(env, actor, built, (prompt) => synth("Draft proposed event kit", prompt, 6000).then((r) => ({ text: r.text, aiRunId: r.aiRunId })))
        .catch((err) => { throw new RoomPacketError(502, "stage_failed", `KIT: ${err instanceof Error ? err.message : String(err)}`); });
      await saveStage(env, draft.id, "PDF", state);
      return { stage, next: "PDF", note: `draft event kit "${kit.kit.header.eventTitle}" — ${kit.kit.header.slot.label}, ${kit.kit.runOfShow.length} run-of-show row(s) each with who is on screen, ${kit.kit.discussionGuide.questions.length} question(s), ${kit.kit.socialPosts.length} post(s); ${kit.kit.open.length} thing(s) left open${kit.link ? `; filed at ${kit.link}` : "; not filed"}${kit.kit.flags.length ? `; flags: ${kit.kit.flags.map((f) => f.code).join(", ")}` : ""}` };
    }

    if (stage === "PDF") {
      const built = await requirePacket(env, draft.id);
      const view = await packetView(env, built);
      const render = deps.render ?? ((html: string) => defaultRender(env, html));
      const out = await render(renderPacketHtml(view));
      let documentId: string | null = null;
      if (out.pdfBase64 === null) {
        state.pdfError = out.reason;
      } else {
        const { document } = await uploadDocument(env, actor, {
          title: `Room packet — ${built.title} (${monthWord(built.proposed_for_month)})`,
          doc_type: "ROOM_PACKET",
          privacy_label: "INTERNAL",
          content_base64: out.pdfBase64,
          content_type: "application/pdf",
        });
        documentId = document.id;
        state.pdfError = null;
        await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET document_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(built.id, documentId).run();
      }
      await saveStage(env, draft.id, "DONE", state);
      const mail = await emailPacket(env, { ...built, document_id: documentId });
      return { stage, next: "DONE", note: `${documentId ? `PDF ${documentId} (${out.pdfBase64 !== null ? out.pageCount : 0} pages)` : `no PDF: ${state.pdfError}`}; emailed to ${mail.sent.length ? mail.sent.join(" and ") : "nobody"}${mail.failed.length ? ` (not sent: ${mail.failed.join(", ")})` : ""}` };
    }

    return { stage, next: "DONE", note: "already done" };
  } catch (err) {
    if (err instanceof RoomPacketError) throw err;
    return await failStage(err instanceof Error ? err.message : String(err));
  }
}

/**
 * THE WORKSHOP BRANCH of the chain (16 Sep 2026). DISCOVER researches what the audience is asking
 * this month — the search model finds pages, every URL is checked live, every note is judged by a
 * second model before it is kept. RESEARCH and VENUES are passed straight through: sponsors are
 * optional for a Workshop and the "where" is fixed (Virtual · West Peek Live). CONCEPTS ideates
 * three ways to run it (or three topics, for an open month) and chooses one; PACKET writes the
 * delivery plan; PDF renders and emails, exactly as a Room does.
 */
/**
 * ADJACENCY MEASURES WHAT RAN, NOT WHAT WAS PROPOSED — and that distinction is the whole item.
 *
 * Operator: "adjacency is a light rule. for one month. and just make sure they are not too
 * similar."
 *
 * The trap it had to be built around, in her own facts: October's Workshop is hosted by a friend of
 * Scooter's and is about content creation. Parker's OWN October Workshop packet — an AI back-office
 * idea — was declined. The old rule read `evt_room_packet.title` for the last eight packets
 * regardless of whether any of them happened, so November would have avoided a dead idea and
 * walked straight into the subject that is actually being run.
 *
 * So this reads two things and neither of them is a proposal:
 *   · `evt_event` — what is on the calendar for the window, INCLUDING sessions the firm did not
 *     build (migration 0176 puts October's on the record precisely so this can see it);
 *   · packets a human KEPT (APPROVED or SCHEDULED) for the window, which is the same fact recorded
 *     one step earlier.
 *
 * Declined and still-proposed packets are deliberately absent. `MONTHLY_PLAN` contributes its own
 * half inside the prompt builder, so a month that is planned but not yet calendared still counts.
 */
async function whatActuallyRan(
  env: Env,
  firmScope: string,
  month: string,
  stream: Stream,
): Promise<Array<{ month: string; topic: string; note: string }>> {
  const window = adjacencyWindow(month);
  const out: Array<{ month: string; topic: string; note: string }> = [];

  const events = (await env.WP_OS_DB.prepare(
    `SELECT title, theme, starts_at, packet_id FROM evt_event
      WHERE firm_scope = ?1 AND COALESCE(kind,'ROOM') = ?2 AND status != 'CANCELLED'
        AND substr(starts_at, 1, 7) IN (${window.map((_, i) => `?${i + 3}`).join(", ")})`,
  ).bind(firmScope, stream, ...window).all<{ title: string; theme: string | null; starts_at: string; packet_id: string | null }>()).results ?? [];
  for (const e of events) {
    out.push({
      month: e.starts_at.slice(0, 7),
      topic: e.theme?.trim() || e.title,
      note: e.packet_id ? "the firm ran it" : "somebody outside the firm ran it — it is still what ran",
    });
  }

  const kept = (await env.WP_OS_DB.prepare(
    `SELECT theme, title, proposed_for_month FROM evt_room_packet
      WHERE firm_scope = ?1 AND COALESCE(kind,'ROOM') = ?2 AND status IN ('APPROVED','SCHEDULED')
        AND proposed_for_month IN (${window.map((_, i) => `?${i + 3}`).join(", ")})`,
  ).bind(firmScope, stream, ...window).all<{ theme: string | null; title: string; proposed_for_month: string }>()).results ?? [];
  for (const k of kept) {
    out.push({ month: k.proposed_for_month, topic: k.theme?.trim() || k.title, note: "the firm kept it" });
  }

  return out.filter((r, i, xs) => xs.findIndex((y) => y.topic.toLowerCase() === r.topic.toLowerCase()) === i);
}

async function runWorkshopStage(
  env: Env,
  draft: PacketRow,
  stage: BuildStage,
  state: BuildState,
  deps: { research: ResearchSearch; judge: Judge; synth: (purpose: string, prompt: string, tokens: number) => Promise<{ text: string; aiRunId: string | null }>; check: UrlCheck; render: RenderPdf; actor: Actor },
): Promise<StageResult> {
  const firmScope = draft.firm_scope;
  const brief = parseBrief(draft.brief_json);
  /*
   * THE MONTH'S ONE TOPIC, RESOLVED BEFORE ANY IDEATION. A partner's plan entry wins; then what a
   * human typed into the request form; then nothing — and "nothing" means Parker chooses it in the
   * concepts call. There is no branch in which he waits or asks which situation he is in.
   */
  const { topic, set, setBy, steer: planSteer } = workshopTopic(draft.proposed_for_month, brief);
  const fail = (detail: string): never => { throw new Error(detail); };

  if (stage === "DISCOVER") {
    let notes: WorkshopNote[] = [];
    let why = "";
    let nudge = "";
    for (let attempt = 0; attempt < 2 && notes.length === 0; attempt += 1) {
      const found = await deps.research(env, deps.actor, buildWorkshopDiscoveryPrompt({ month: draft.proposed_for_month, topic, set, brief }) + (nudge ? `\n\n${nudge}` : ""));
      if (!found.ok) { why = `the live search failed: ${found.detail}`; continue; }
      const parsed = parseWorkshopNotes(found.text);
      const checked = await Promise.all(parsed.map(async (n) => ({ n, verdict: evidenceVerdict(await deps.check(n.url)) })));
      const live = checked.filter((c) => c.verdict !== "dead").map((c) => c.n);
      state.workshopDropped = checked.filter((c) => c.verdict === "dead").map((c) => c.n.url);
      if (live.length === 0) {
        why = parsed.length === 0 ? "the search answered with no usable entry (no url on any)" : `every cited page was dead: ${state.workshopDropped.join(", ")}`;
        nudge = `Your previous answer was discarded: ${why}. Every entry MUST carry the url of a live page that states it.`;
        continue;
      }
      /*
       * A JUDGE THAT COULD NOT ANSWER IS EMPTY RESEARCH, NOT A DEAD STAGE.
       *
       * These two lines used to `fail(...)`, which threw out of the retry loop, out of the stage
       * and out of the card — three ticks of that and the sweep blocked Parker's October Workshop
       * with "DISCOVER: the judgement pass failed: the judgement was routed to the search model".
       * Every other failure in this stage already degrades, and the comment eight lines below says
       * why it can: a Workshop CAN be designed from what the firm knows this audience needs. A
       * judge that fell over is one of those cases, and it belongs with them rather than being the
       * one path that stops the work dead.
       */
      const judged = await deps.judge(env, deps.actor, buildWorkshopJudgePrompt({ topic: topic ?? "the subject Parker is about to choose for this month", notes: live }));
      if (!judged.ok) { why = `the judgement pass failed: ${judged.detail}`; continue; }
      const verdicts = parseWorkshopVerdicts(judged.text);
      if (verdicts.size === 0) { why = "the judge answered with no verdicts"; continue; }
      state.workshopRejected = [];
      for (const n of live) {
        const v = verdicts.get(n.url.toLowerCase());
        if (v?.keep) notes.push(n);
        else state.workshopRejected.push({ url: n.url, reason: v?.reason ?? "the judge gave no verdict on it" });
      }
      if (notes.length === 0) {
        why = `the judge rejected every note: ${state.workshopRejected.map((r) => `${r.url} — ${r.reason}`).join("; ")}`;
        nudge = `Your previous answer was discarded. Rejected: ${state.workshopRejected.map((r) => `${r.url} (${r.reason})`).join("; ")}. Find specific, dated questions and findings on credible pages.`;
      }
    }
    // A Workshop CAN be designed from what the firm knows this audience needs; a Room's sponsors
    // cannot. So no note is not a failure — the packet says the research came back empty.
    state.workshopNotes = notes;
    state.discoveryDetail = notes.length ? `${notes.length} note(s) on what the audience is asking, live-checked and judged` : `no research note survived (${why || "nothing usable"}); designing from the brief`;
    await saveStage(env, draft.id, "CONCEPTS", state);
    return { stage, next: "CONCEPTS", note: state.discoveryDetail };
  }

  if (stage === "RESEARCH" || stage === "VENUES") {
    // Passed through: a Workshop researches no sponsor and searches no venue.
    const next: BuildStage = stage === "RESEARCH" ? "CONCEPTS" : "PACKET";
    await saveStage(env, draft.id, next, state);
    return { stage, next, note: stage === "RESEARCH" ? "no sponsor research for a Workshop" : `no venue — ${WORKSHOP_WHERE}` };
  }

  if (stage === "CONCEPTS") {
    const ran = await whatActuallyRan(env, firmScope, draft.proposed_for_month, "WORKSHOP");
    /*
     * THE SAME ONE PLACE, FOR THE OTHER STREAM. The Workshop's steers are read here and nowhere
     * else in the chain; `validate:steer-waits` fails if either stream's concepts prompt is built
     * from a bare plan steer again, because two streams each remembering their own half is the
     * "two components each keeping their own list with no link" defect this repo names.
     */
    const steerRows = await steerForMonth(env, firmScope, draft.proposed_for_month, "WORKSHOP", planSteer);
    const steer = steerRows.text;
    const prompt = buildWorkshopConceptsPrompt({ month: draft.proposed_for_month, topic, set, setBy, steer, brief, notes: state.workshopNotes, ran, guidance: await guidanceFor(env, firmScope) });
    if (steer) await markDelivered(env, steerRows.rows, draft.id);
    const { text } = await deps.synth("Workshop packet: one topic, three angles", prompt, 3000);
    /*
     * A THREE-SUBJECT ANSWER IS REJECTED HERE, NOT ACCEPTED AND FLAGGED.
     *
     * `parseWorkshopConcepts` returns null when the angles are not all on one subject, and this
     * line turns that into a stage failure: the sweep retries the stage with the reason on the
     * card, and after the third attempt the card blocks and a human sees it. Nothing with three
     * subjects in it is ever stored.
     */
    const parsed = parseWorkshopConcepts(text, set ? topic : null);
    if (!parsed) return fail("the angles did not come back in a usable shape — every angle must be on the ONE topic for the month, and each must say so in `angle_on`");
    state.concepts = parsed.concepts;
    state.workshopTopic = parsed.topic;
    state.workshopTopicSetBy = setBy;
    state.choiceRationale = parsed.choiceRationale;
    state.pushback = parsed.pushback;
    await saveStage(env, draft.id, "PACKET", state);
    const chosen = parsed.concepts.find((c) => c.chosen)! as WorkshopConcept;
    return { stage, next: "PACKET", note: `topic "${parsed.topic}" (${setBy === "PARTNERS" ? "the partners'" : "Parker's own pick"}); chose the angle "${chosen.title}" (${chosen.angleKind.toLowerCase()}, ${chosen.mode.toLowerCase()}: ${chosen.promise.slice(0, 80)}) over ${parsed.concepts.length - 1} other angle(s) on the same topic${parsed.pushback ? `; pushback: ${parsed.pushback.slice(0, 120)}` : ""}` };
  }

  if (stage === "PACKET") {
    const settled = state.workshopTopic ?? topic;
    if (!settled) return fail("no topic was settled for this month; the angles stage must run first");
    const prompt = buildWorkshopPacketPrompt({
      month: draft.proposed_for_month, topic: settled, set, brief, notes: state.workshopNotes,
      concepts: state.concepts as WorkshopConcept[], choiceRationale: state.choiceRationale, pushback: state.pushback,
      guidance: await guidanceFor(env, firmScope),
    });
    const { text, aiRunId } = await deps.synth("Workshop packet proposal", prompt, 6000);
    const parsed = parseWorkshopPacket(text, settled);
    if (!parsed) return fail("the proposal did not come back as a usable Workshop packet");
    const verified = verifyWorkshopPacket(parsed, state.workshopNotes.map((n) => n.url), text);
    const economics = computeWorkshopEconomics(verified.packet);
    state.workshopFlags = verified.flags;
    await storeWorkshopPacket(env, draft, verified.packet, economics, aiRunId, state, setBy);
    return { stage, next: "KIT", note: `"${verified.packet.title}": ${verified.packet.runOfShow.length} run-of-show lines (${verified.packet.runOfShow.filter((l) => l.segment === "BREAKOUT").length} breakouts), ${verified.packet.leaveWith.length} artifact(s), ${verified.packet.invitations.length} invitation(s), free to attend${verified.packet.sponsorship.suggested ? `, suggested sponsor ${verified.packet.sponsorship.suggested.categoryFit} at $${(verified.packet.sponsorship.suggested.askUsd ?? 0).toLocaleString("en-US")}` : ", no sponsor suggested"}${verified.flags.length ? `; flags: ${verified.flags.map((f) => f.code).join(", ")}` : ""}` };
  }

  // THE SAME KIT STAGE, THE SAME CODE. A Workshop kit and a Room kit differ only in the source
  // read off the packet — see services/eventKit.ts `eventKitSourceFor`. Two implementations would
  // be the "two components each keeping their own list" defect, one stream deep.
  if (stage === "KIT") {
    const built = await requirePacket(env, draft.id);
    const kit = await buildAndFileEventKit(env, deps.actor, built, (prompt) => deps.synth("Draft proposed event kit", prompt, 6000).then((r) => ({ text: r.text, aiRunId: r.aiRunId })))
      .catch((err) => { throw new RoomPacketError(502, "stage_failed", `KIT: ${err instanceof Error ? err.message : String(err)}`); });
    await saveStage(env, draft.id, "PDF", state);
    return { stage, next: "PDF", note: `draft event kit "${kit.kit.header.eventTitle}" — ${kit.kit.header.slot.label}, ${kit.kit.runOfShow.length} run-of-show row(s) each with who is on screen, ${kit.kit.discussionGuide.questions.length} question(s), ${kit.kit.socialPosts.length} post(s); ${kit.kit.open.length} thing(s) left open${kit.link ? `; filed at ${kit.link}` : "; not filed"}${kit.kit.flags.length ? `; flags: ${kit.kit.flags.map((f) => f.code).join(", ")}` : ""}` };
  }

  if (stage === "PDF") {
    const built = await requirePacket(env, draft.id);
    const view = await packetView(env, built);
    const w = workshopViewOf(built);
    if (!w) return fail("the Workshop packet was not stored; nothing to render");
    const out = await deps.render(renderWorkshopHtml(view, w));
    let documentId: string | null = null;
    if (out.pdfBase64 === null) {
      state.pdfError = out.reason;
    } else {
      const { document } = await uploadDocument(env, deps.actor, {
        title: `Workshop packet — ${built.title} (${monthWord(built.proposed_for_month)})`,
        doc_type: "ROOM_PACKET",
        privacy_label: "INTERNAL",
        content_base64: out.pdfBase64,
        content_type: "application/pdf",
      });
      documentId = document.id;
      state.pdfError = null;
      await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET document_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(built.id, documentId).run();
    }
    await saveStage(env, draft.id, "DONE", state);
    const mail = await emailPacket(env, { ...built, document_id: documentId });
    return { stage, next: "DONE", note: `${documentId ? `PDF ${documentId} (${out.pdfBase64 !== null ? out.pageCount : 0} pages)` : `no PDF: ${state.pdfError}`}; emailed to ${mail.sent.length ? mail.sent.join(" and ") : "nobody"}${mail.failed.length ? ` (not sent: ${mail.failed.join(", ")})` : ""}` };
  }

  return { stage, next: "DONE", note: "already done" };
}

/** The Workshop's rows: the packet row with `workshop_json`. NO venue rows and NO sponsor rows are written — ever. */
async function storeWorkshopPacket(env: Env, draft: PacketRow, packet: WorkshopPacketShape, economics: ReturnType<typeof computeWorkshopEconomics>, aiRunId: string | null, state: BuildState, topicSetBy: "PARTNERS" | "PARKER"): Promise<void> {
  const firmScope = draft.firm_scope;
  const clash = await env.WP_OS_DB.prepare(
    "SELECT id FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3 AND id != ?4",
  ).bind(firmScope, draft.proposed_for_month, packet.title, draft.id).first<{ id: string }>();
  const title = clash ? `${packet.title} (${draft.proposed_for_month})` : packet.title;
  const view: WorkshopView = {
    topic: packet.topic, topicSetBy,
    whoItsFor: packet.whoItsFor, promise: packet.promise, mode: packet.mode, runOfShow: packet.runOfShow, exercises: packet.exercises,
    leaveWith: packet.leaveWith, facilitator: packet.facilitator, coHost: packet.coHost, delivery: packet.delivery, sponsorship: packet.sponsorship,
    promoOneLiner: packet.promoOneLiner, invitations: packet.invitations, economics, notes: state.workshopNotes, flags: state.workshopFlags,
    topicSet: topicSetBy === "PARTNERS",
  };
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      `UPDATE evt_room_packet
          SET title = ?2, theme = ?3, central_question = ?4, status = 'PROPOSED', format = 'WORKSHOP',
              target_min = ?5, target_max = ?6, audience = ?7, agenda_md = NULL, seed_questions_json = ?8,
              guest_ideas_json = '[]', economics_json = ?9, sponsor_thesis = ?10, ai_run_id = ?11,
              sponsor_count = ?12, sponsor_total_usd = ?13, risks_json = ?14, commitment_md = ?15,
              concepts_json = ?16, concept_choice_md = ?17, run_of_show_json = ?18, pitch_email_json = NULL,
              invite_check_json = NULL, pushback_md = ?19, build_stage = 'KIT', build_state_json = ?20,
              workshop_json = ?21, live_url = 'https://westpeek.live',
              build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    ).bind(
      draft.id, title, packet.topic, packet.promise,
      packet.targetMin, packet.targetMax, packet.whoItsFor, JSON.stringify(packet.exercises),
      JSON.stringify(economics), packet.sponsorship.suggested ? packet.sponsorship.suggested.why : null, aiRunId,
      packet.sponsorship.suggested ? 1 : 0, economics.suggestedSponsorshipUsd, JSON.stringify(packet.risks), packet.commitmentMd,
      JSON.stringify(state.concepts), packet.conceptChoiceMd ?? state.choiceRationale, JSON.stringify(packet.runOfShow),
      packet.pushback ?? state.pushback, JSON.stringify(state), JSON.stringify(view),
    ),
    // A rebuild replaces what an earlier attempt wrote, and a Workshop never has a venue.
    env.WP_OS_DB.prepare("DELETE FROM evt_packet_venue WHERE packet_id = ?1").bind(draft.id),
    env.WP_OS_DB.prepare("DELETE FROM evt_sponsor_prospect WHERE packet_id = ?1 AND stage = 'IDENTIFIED'").bind(draft.id),
  ]);
  await appendEvent(env, {
    eventType: "room_packet.proposed",
    actorType: "ai_employee",
    actorId: "aie_parker",
    objectType: "room_packet", objectId: draft.id, firmScope,
    payload: { kind: "WORKSHOP", month: draft.proposed_for_month, origin: draft.origin, topic: packet.topic, topic_set_by: topicSetBy, attendance_free: true, suggested_sponsor: packet.sponsorship.suggested?.categoryFit ?? null, cost_high_usd: economics.estimatedCostHighUsd, concept: state.concepts.find((c) => c.chosen)?.title ?? null, flags: state.workshopFlags.map((f) => f.code) },
  });
}

type WorkshopPacketShape = NonNullable<ReturnType<typeof parseWorkshopPacket>>;

/** The Workshop half of a packet row, or null for a Room / an unbuilt Workshop. */
export function workshopViewOf(packet: Pick<PacketRow, "kind" | "workshop_json">): WorkshopView | null {
  if (packetKindOf(packet.kind) !== "WORKSHOP" || !packet.workshop_json) return null;
  try { return JSON.parse(packet.workshop_json) as WorkshopView; } catch { return null; }
}

async function guidanceFor(env: Env, firmScope: string): Promise<string> {
  // Both sources: the reviewed library and whatever the partners have adopted for this machine.
  return [
    guidanceBlock(["west_peek_live_events", "brand_sponsorship_revenue"]),
    await writtenGuidance(env, ["west_peek_live_events", "brand_sponsorship_revenue"], firmScope),
  ].filter((block) => block.length > 0).join("\n");
}

/** The packet's rows, written in ONE batch: the row, its venues, its ranked prospects. */
async function storePacket(env: Env, draft: PacketRow, packet: RoomPacket, economics: RoomEconomics, aiRunId: string | null, state: BuildState, actor: Actor): Promise<void> {
  const firmScope = draft.firm_scope;
  // A title Parker reuses within the month would trip the unique index; suffix rather than fail.
  const clash = await env.WP_OS_DB.prepare(
    "SELECT id FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3 AND id != ?4",
  ).bind(firmScope, draft.proposed_for_month, packet.title, draft.id).first<{ id: string }>();
  const title = clash ? `${packet.title} (${draft.proposed_for_month})` : packet.title;

  const statements = [
    env.WP_OS_DB.prepare(
      `UPDATE evt_room_packet
          SET title = ?2, theme = ?3, central_question = ?4, status = 'PROPOSED', format = ?5,
              target_min = ?6, target_max = ?7, audience = ?8, agenda_md = ?9, seed_questions_json = ?10,
              guest_ideas_json = ?11, economics_json = ?12, sponsor_thesis = ?13, ai_run_id = ?14,
              sponsor_count = ?15, sponsor_total_usd = ?16, risks_json = ?17, commitment_md = ?18,
              concepts_json = ?19, concept_choice_md = ?20, run_of_show_json = ?21, pitch_email_json = ?22,
              invite_check_json = ?23, pushback_md = ?24, build_stage = 'KIT', build_state_json = ?25,
              build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    ).bind(
      draft.id, title, packet.theme, packet.centralQuestion, packet.format,
      packet.targetMin, packet.targetMax, packet.audience, packet.agendaMd,
      JSON.stringify(packet.seedQuestions), JSON.stringify(packet.guestIdeas),
      JSON.stringify(economics), packet.sponsorThesis, aiRunId,
      economics.sponsorCount, economics.sponsorTargetHighUsd, JSON.stringify(packet.risks), packet.commitmentMd,
      JSON.stringify(state.concepts), packet.conceptChoiceMd ?? state.choiceRationale, JSON.stringify(packet.runOfShow),
      packet.pitchEmail ? JSON.stringify(packet.pitchEmail) : null,
      state.inviteCheck ? JSON.stringify(state.inviteCheck) : null,
      packet.pushback ?? state.pushback,
      JSON.stringify(state),
    ),
    // A rebuild replaces what an earlier attempt wrote; a packet is one packet.
    env.WP_OS_DB.prepare("DELETE FROM evt_packet_venue WHERE packet_id = ?1").bind(draft.id),
    env.WP_OS_DB.prepare("DELETE FROM evt_sponsor_prospect WHERE packet_id = ?1 AND stage = 'IDENTIFIED'").bind(draft.id),
    ...packet.venues.map((venue) =>
      env.WP_OS_DB.prepare(
        `INSERT INTO evt_packet_venue
           (id, packet_id, name, city, address, capacity, price_low_usd, price_high_usd, price_note,
            booking_phone, booking_email, booking_url, source_url, estimate_low_usd, estimate_high_usd, estimate_basis,
            why_here, room_minimum_usd, is_fallback)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
      ).bind(
        `rpv_${crypto.randomUUID()}`, draft.id, venue.name, venue.city, venue.address, venue.capacity,
        venue.priceLowUsd, venue.priceHighUsd, venue.priceNote, venue.bookingPhone,
        venue.bookingEmail, venue.bookingUrl, venue.sourceUrl,
        venue.estimateLowUsd, venue.estimateHighUsd, venue.estimateBasis,
        venue.whyHere, venue.roomMinimumUsd, venue.isFallback ? 1 : 0,
      ),
    ),
    // Every ranked prospect becomes a pipeline row on this packet, Parker's to work.
    ...packet.sponsorProspects.slice(0, 10).map((sp) =>
      env.WP_OS_DB.prepare(
        `INSERT INTO evt_sponsor_prospect
           (id, org_name, tier, category, ask_low_usd, ask_high_usd, pitch, ask_detail, stage,
            packet_id, source_url, note, owner_employee, firm_scope, created_by,
            evidence_url, evidence_note, contact_name, contact_title, contact_source_url, contact_url, fit_argument, rank, sponsorship_summary)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'IDENTIFIED',?9,?10,?11,'Parker',?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
      ).bind(
        `spp_${crypto.randomUUID()}`, sp.orgName, sp.tier, sp.category,
        sp.askUsd, sp.askUsd, sp.pitch, sp.fitArgument, draft.id, sp.evidenceUrl,
        sp.note ?? (sp.fromBrief ? "Named by the partner in her brief." : "Found by Parker."),
        firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
        sp.evidenceUrl, sp.evidenceNote, sp.contactName, sp.contactTitle, sp.contactSourceUrl, sp.contactSourceUrl, sp.fitArgument, sp.rank,
        state.research.find((r) => sameOrg(r.orgName, sp.orgName))?.summary ?? null,
      ),
    ),
  ];
  await env.WP_OS_DB.batch(statements);

  await appendEvent(env, {
    eventType: "room_packet.proposed",
    actorType: "ai_employee",
    actorId: "aie_parker",
    objectType: "room_packet", objectId: draft.id, firmScope,
    payload: {
      month: draft.proposed_for_month, origin: draft.origin, venues: packet.venues.length,
      sponsors: packet.sponsorProspects.length, sponsor_count: economics.sponsorCount, keep_usd: economics.netHighUsd,
      concept: state.concepts.find((c) => c.chosen)?.title ?? null, flags: state.flags.map((f) => f.code),
    },
  });
}

// ── The runner the sweep calls ───────────────────────────────────────────────

/**
 * Work Parker's card one stage at a time. `progressed` tells the sweep the tick did its job and the
 * card is not done — the next tick continues it and no attempt is charged.
 */
export async function runRoomPacketCard(
  env: Env,
  card: SweepCard,
  deps: ChainDeps = {},
): Promise<{ finished: boolean; blocked: boolean; progressed: boolean; detail: string }> {
  const packet = await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE work_card_id = ?1").bind(card.id).first<PacketRow>();
  if (!packet) {
    const why = await blockCard(env, card, { reason: "the_request_is_gone", trying: card.title, employee: "Parker" });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  /*
   * THE STAGES THAT STILL HAVE WORK AFTER THE PACKET IS PROPOSED.
   *
   * Storing the packet flips `status` to PROPOSED while the chain is still running — the kit and the
   * PDF come after it. This used to be the single literal "PDF", and adding the kit stage in front
   * of it silently closed the card one stage early: the packet was proposed, the guard saw a
   * non-DRAFT row on a stage it did not recognise, and Parker's own card reported "already
   * proposed" having never written a kit. Derived from the stage list, so a stage added after the
   * packet cannot be left out of it again.
   */
  const stillBuilding: readonly BuildStage[] = BUILD_STAGES.slice(BUILD_STAGES.indexOf("KIT"), BUILD_STAGES.indexOf("DONE"));
  if (packet.status !== "DRAFT" && !stillBuilding.includes(packet.build_stage)) {
    // Dismissed by a person, or already built: the card closes without noise.
    await closeCard(env, card.id, packet.status === "DECLINED" ? "The request was dismissed before the packet was built." : `The packet is ${packet.status.toLowerCase()}.`);
    return { finished: true, blocked: false, progressed: false, detail: packet.status === "DECLINED" ? "the request was dismissed; nothing more to build" : `already ${packet.status.toLowerCase()}` };
  }

  /*
   * WHAT SHE ASKED FOR, READ BY A MODEL, BEFORE ANY STAGE RUNS (16 Sep 2026).
   *
   * This chain read the packet row, the month and the roster, and NOTHING ELSE. Not
   * `work_card.prompt`, not a steering note left while the build was running, not the answer she
   * typed to clear a block. She asked Parker for "a packet on workshops, much like he does for
   * rooms" and that sentence reached no model: it was stored on the card and read by nothing, so
   * he built the default and then stopped.
   *
   * `steerFor` is the fix, and it is checked BEFORE `runStage` rather than inside it so that a
   * chain which cannot honour her words never starts. The brief is passed in as well: it is a
   * human's prose that lives on the packet row rather than on the card, and leaving it out would
   * mean the words she typed into the request form were the one kind this pass could not see.
   */
  const steer = await steerFor(env, PARKER_ACTOR(card.firm_scope), {
    cardId: card.id,
    cardKind: "ROOM_PACKET",
    title: card.title,
    employee: "Parker",
    chain: packetKindOf(packet.kind) === "WORKSHOP" ? "a monthly Workshop packet" : "a monthly Room packet",
    steps: STAGE_STEPS[packetKindOf(packet.kind)],
    firmScope: card.firm_scope,
    extra: briefAsInstruction(packet),
  }, deps.interpret);
  if (steer.cannot.length > 0) {
    // A STAGE WHOSE INPUT INCLUDES PROSE IT CANNOT HONOUR SAYS SO. Doing the default and reporting
    // a finished packet would be the exact failure that produced the wrong thing the first time.
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: "Parker",
      detail: steer.failure ? undefined : cannotDetail("Parker", steer.cannot),
    });
    return { finished: false, blocked: true, progressed: false, detail: why };
  }

  const out = await runStage(env, packet, { ...deps, ...(steer.text ? { steer: steer.text } : {}) });
  const fresh = await requirePacket(env, packet.id);
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET next_action = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(card.id, `${out.next === "DONE" ? "Done" : `Next: ${BUILD_STAGE_LABELS[out.next]}`}. Last: ${out.note}`.slice(0, 900)).run();
  if (out.next === "DONE") {
    await closeCard(env, card.id, [
      `• ${fresh.title} — proposed for ${monthWord(fresh.proposed_for_month)}.`,
      fresh.document_id ? `• PDF: https://os.joinwestpeek.com/api/documents/${fresh.document_id}/download` : `• No PDF this time: ${parseState(fresh.build_state_json).pdfError ?? "unknown"}`,
      `• ${out.note}`,
      "• Keep it or dismiss it on Events & Rooms: https://os.joinwestpeek.com/#/rooms",
    ].join("\n"));
    return { finished: true, blocked: false, progressed: false, detail: `${fresh.title} — packet built${fresh.document_id ? " with PDF" : ""} and emailed` };
  }
  return { finished: false, blocked: false, progressed: true, detail: `${out.stage} done: ${out.note}` };
}

/**
 * The human's prose that lives on the PACKET rather than on the card.
 *
 * A partner asking for a Room types an audience and some notes into the request form, and those go
 * into `brief_json`, not into `work_card.prompt`. Leaving them out of the interpretation pass would
 * mean the one place she actually types a brief was the one place this could not see — which is
 * the defect with a new name. Parker's own monthly proposal has no human words and contributes
 * nothing, which is why a scheduled packet costs no interpretation call at all.
 */
function briefAsInstruction(packet: PacketRow): InstructionPiece[] {
  if (packet.origin !== "PARTNER_BRIEF") return [];
  const brief = parseBrief(packet.brief_json);
  if (!brief) return [];
  const words = [
    brief.audience?.trim() && !/^Parker's own/i.test(brief.audience) ? brief.audience.trim() : null,
    brief.city ? `In ${brief.city}.` : null,
    brief.sponsorProspects.length ? `Sponsors she named: ${brief.sponsorProspects.join(", ")}.` : null,
    brief.notes?.trim() || null,
  ]
    .filter(Boolean)
    .join(" ");
  return words ? [{ source: "BRIEF", text: words, who: packet.requested_by }] : [];
}

async function closeCard(env: Env, cardId: string, finding: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(cardId, finding).run();
}

// ── The one-call form (tests, and "build it now") ────────────────────────────

export interface GenerateResult {
  packet: PacketRow;
  flags: PacketFlag[];
  venuesKept: number;
  stages: StageResult[];
}

/** How many times a stage is attempted before the draft is left for a person, with the last error on it. */
export const MAX_BUILD_ATTEMPTS = 3;

/**
 * Queue a draft and run every stage to the end, in one call. What the tests use, with every
 * dependency injected; production runs the same stages through the card.
 */
export async function generatePacket(
  env: Env,
  actor: Actor,
  input: { month: string; city?: string; brief?: RoomBrief | null; origin?: PacketOrigin; parentPacketId?: string | null },
  deps: ChainDeps = {},
): Promise<GenerateResult> {
  const brief = input.brief ?? null;
  const draft = await queueDraft(env, actor, {
    month: input.month,
    origin: input.origin ?? (brief ? "PARTNER_BRIEF" : "PARKER"),
    brief: brief ? { ...brief, city: brief.city ?? input.city ?? null } : null,
    parentPacketId: input.parentPacketId ?? null,
  });
  if (draft.status !== "DRAFT") return { packet: draft, flags: [], venuesKept: 0, stages: [] };
  return buildDraft(env, draft, deps);
}

/** Run the remaining stages of a draft to the end. */
export async function buildDraft(env: Env, draft: PacketRow, deps: ChainDeps = {}): Promise<GenerateResult> {
  const stages: StageResult[] = [];
  let current = draft;
  await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET build_attempts = build_attempts + 1 WHERE id = ?1").bind(draft.id).run();
  for (let guard = 0; guard < 24 && current.build_stage !== "DONE"; guard++) {
    stages.push(await runStage(env, current, deps));
    current = await requirePacket(env, draft.id);
  }
  const venues = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_packet_venue WHERE packet_id = ?1").bind(draft.id).first<{ n: number }>();
  return { packet: current, flags: parseState(current.build_state_json).flags, venuesKept: venues?.n ?? 0, stages };
}

// ── The view, the text and the email ─────────────────────────────────────────

interface VenueLine { name: string; city: string | null; address?: string | null; capacity: number | null; price_low_usd: number | null; price_high_usd: number | null; price_note: string | null; booking_phone: string | null; booking_email: string | null; source_url: string; estimate_low_usd?: number | null; estimate_high_usd?: number | null; estimate_basis?: string | null; why_here?: string | null; room_minimum_usd?: number | null; is_fallback?: number | null }
interface SponsorLine { org_name: string; category: string; tier?: string | null; ask_low_usd: number | null; pitch: string | null; ask_detail: string | null; source_url: string | null; note: string | null; evidence_url?: string | null; evidence_note?: string | null; contact_name?: string | null; contact_title?: string | null; contact_source_url?: string | null; fit_argument?: string | null; rank?: number | null }

const PACKET_VENUE_COLUMNS = "name, city, address, capacity, price_low_usd, price_high_usd, price_note, booking_phone, booking_email, source_url, estimate_low_usd, estimate_high_usd, estimate_basis, why_here, room_minimum_usd, is_fallback";
const PACKET_SPONSOR_COLUMNS = "org_name, category, tier, ask_low_usd, pitch, ask_detail, source_url, note, evidence_url, evidence_note, contact_name, contact_title, contact_source_url, fit_argument, rank";

function list<T>(raw: string | null | undefined): T[] {
  try { const v: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
}
function obj<T>(raw: string | null | undefined): T | null {
  try { const v: unknown = JSON.parse(raw ?? "null"); return v && typeof v === "object" ? (v as T) : null; } catch { return null; }
}

/** Everything the PDF and the email render, read from the rows. */
export async function packetView(env: Env, packet: PacketRow): Promise<PacketView> {
  const [venues, sponsors] = await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(`SELECT ${PACKET_VENUE_COLUMNS} FROM evt_packet_venue WHERE packet_id = ?1 ORDER BY is_fallback, estimate_low_usd`).bind(packet.id),
    env.WP_OS_DB.prepare(`SELECT ${PACKET_SPONSOR_COLUMNS} FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY COALESCE(rank, 99), created_at`).bind(packet.id),
  ]);
  return viewFromRows(packet, (venues?.results ?? []) as VenueLine[], (sponsors?.results ?? []) as SponsorLine[]);
}

export function viewFromRows(packet: PacketRow, venues: VenueLine[], sponsors: SponsorLine[]): PacketView {
  // "Named by you" comes from HER BRIEF, matched on the organisation — not from the word
  // "partner" appearing in a note (Cooley's note said "not a direct sponsorship lead … partner
  // page" and was tagged as hers in the first production PDF).
  const named = parseBrief(packet.brief_json)?.sponsorProspects ?? [];
  return {
    packetId: packet.id,
    title: packet.title,
    theme: packet.theme,
    centralQuestion: packet.central_question,
    month: packet.proposed_for_month,
    format: packet.format,
    targetMin: packet.target_min,
    targetMax: packet.target_max,
    audience: packet.audience,
    origin: packet.origin,
    brief: parseBrief(packet.brief_json),
    pushback: packet.pushback_md,
    concepts: list<RoomConcept>(packet.concepts_json),
    conceptChoiceMd: packet.concept_choice_md,
    runOfShow: list<RunOfShowLine>(packet.run_of_show_json),
    agendaMd: packet.agenda_md,
    seedQuestions: list<string>(packet.seed_questions_json),
    guestIdeas: list<{ description: string; why: string | null }>(packet.guest_ideas_json),
    venues: venues.map((v): VenueView => ({
      name: v.name, city: v.city, address: v.address ?? null, capacity: v.capacity, whyHere: v.why_here ?? null, roomMinimumUsd: v.room_minimum_usd ?? null,
      priceLowUsd: v.price_low_usd, priceHighUsd: v.price_high_usd, priceNote: v.price_note,
      estimateLowUsd: v.estimate_low_usd ?? v.price_low_usd, estimateHighUsd: v.estimate_high_usd ?? v.price_high_usd, estimateBasis: v.estimate_basis ?? null,
      bookingPhone: v.booking_phone, bookingEmail: v.booking_email, sourceUrl: v.source_url, isFallback: Boolean(v.is_fallback),
    })),
    sponsors: sponsors.map((s): SponsorView => ({
      rank: s.rank ?? null, orgName: s.org_name, category: s.category, tier: s.tier ?? "SUPPORTING", askUsd: s.ask_low_usd,
      fitArgument: s.fit_argument ?? s.ask_detail, pitch: s.pitch, evidenceUrl: s.evidence_url ?? s.source_url, evidenceNote: s.evidence_note ?? null,
      contactName: s.contact_name ?? null, contactTitle: s.contact_title ?? null, contactSourceUrl: s.contact_source_url ?? null,
      note: s.note, fromBrief: named.some((n) => sameOrg(n, s.org_name)),
    })),
    economics: obj<RoomEconomics>(packet.economics_json && packet.economics_json !== "{}" ? packet.economics_json : null),
    sponsorThesis: packet.sponsor_thesis,
    risks: list<string>(packet.risks_json),
    commitmentMd: packet.commitment_md,
    pitchEmail: obj<{ to: string; subject: string; body: string }>(packet.pitch_email_json),
    inviteCheck: obj<InviteCheck>(packet.invite_check_json),
    alsoLookedAt: parseState(packet.build_state_json).dropped.map((d) => d.orgName),
    generatedAt: new Date().toISOString(),
  };
}

export function monthWord(yyyyMm: string): string {
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const m = Number(yyyyMm.slice(5, 7));
  return `${names[m - 1] ?? yyyyMm} ${yyyyMm.slice(0, 4)}`;
}

const usdText = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);
const tierWord = (t: string | null | undefined): string => (t === "PRESENTING" ? "title" : t === "IN_KIND" ? "in kind" : "supporting");

/**
 * THE KIT IN THE EMAIL: THE TL;DR AND THE LINK, NEVER THE TEXT.
 *
 * Item settled by the owner's own product — West Peek Live's instruction pages say "The email never
 * carries the text, so correcting a page corrects it for everyone who already has the link." A kit
 * is a draft: the date is proposed, a co-host may still be open, the questions get edited. So the
 * mail carries the proposed title, the proposed date and time, the duration shape and the one line
 * on why this angle — enough to react to without clicking — and then the link.
 *
 * ONE SECTION, BOTH STREAMS. A Room's kit and a Workshop's kit are the same object.
 */
function kitSection(packet: PacketRow): ExecEmailInput["sections"] {
  const kit = eventKitOf(packet);
  if (!kit) return [];
  return [{ label: "The draft event kit", bullets: eventKitEmailBullets(kit, packet.event_kit_deliverable_id ?? null) }];
}

/**
 * The busy-executive summary above the packet (16 Sep 2026): the concept, the venue, the money,
 * and the one decision — keep it or dismiss it. The whole packet is the details under it.
 */
export function packetSummary(packet: PacketRow, venues: VenueLine[], sponsors: SponsorLine[], token?: string): { tldr: string; sections: ExecEmailInput["sections"] } {
  const v = viewFromRows(packet, venues, sponsors);
  const eco = v.economics;
  const chosen = v.concepts.find((c) => c.chosen);
  const others = v.concepts.filter((c) => !c.chosen);
  const firstVenue = v.venues.find((x) => !x.isFallback) ?? v.venues[0];
  const total = eco ? `${usdText(eco.estimatedCostLowUsd)}–${usdText(eco.estimatedCostHighUsd)}` : "not costed";
  const asked = v.brief ? `${v.brief.audience}${v.brief.city ? ` in ${v.brief.city}` : ""}` : `Parker's own Room for ${monthWord(v.month)}`;
  return {
    tldr: `**${monthWord(v.month)} Room — topic: ${packet.theme || v.title}.** I looked at ${v.concepts.length || 3} angles on it and chose **${chosen?.title ?? v.title}**${others.length ? ` over ${others.map((c) => c.title).join(" and ")}` : ""}. ${v.targetMin}–${v.targetMax} people, ${total}. Reply to keep it or say no.`,
    sections: [
      {
        label: "Who I am",
        bullets: [
          "I'm **Parker**, West Peek's Event Marketing Coordinator. I plan the firm's monthly Rooms and Workshops.",
          "Each month I pick one topic, work up three angles on it, choose one, and send you the packet.",
          `What you asked for: ${asked}.`,
        ],
      },
      {
        label: "What I did",
        bullets: [
          "Read the firm's list, found who pays to reach this audience, researched each sponsor on live pages.",
          `Compared **${v.concepts.length}** concepts and chose one; sourced venues; priced the room to cost plus the firm's keep.`,
          packet.document_id ? `Filed the packet as a PDF: https://os.joinwestpeek.com/api/documents/${packet.document_id}/download` : "The PDF did not file; the packet is on Events & Rooms.",
        ],
      },
      {
        label: "What I found",
        bullets: [
          chosen ? `Concept: **${chosen.title}** — ${chosen.premise}` : "No concept chosen.",
          ...(others.length ? [`Beat: ${others.map((c) => `**${c.title}**`).join(", ")}.`] : []),
          firstVenue ? `Venue: **${firstVenue.name}**${firstVenue.city ? `, ${firstVenue.city}` : ""}, est. ${usdText(firstVenue.estimateLowUsd)}–${usdText(firstVenue.estimateHighUsd)}.` : "Venue: none survived sourcing; a person finds the space.",
          eco ? `Money: cost ${total}; all slots sold ${usdText(eco.sponsorTargetHighUsd)} — ${eco.reachesKeep ? "the firm's keep is reached" : `SHORT by ${usdText(eco.requiredUsd - eco.sponsorTargetHighUsd)}`}.` : "Money: not costed.",
          v.sponsors.length ? `Sponsors: ${v.sponsors.slice(0, 3).map((sp) => `**${sp.orgName}**`).join(", ")}${v.sponsors.length > 3 ? ` and ${v.sponsors.length - 3} more` : ""}.` : "Sponsors: none named.",
          ...(v.inviteCheck ? [`Our own list: **${v.inviteCheck.matchingCount}** of **${v.inviteCheck.totalContacts}** contacts fit — ${v.inviteCheck.verdict.replace(/_/g, " ").toLowerCase()}.`] : []),
        ],
      },
      ...(token
        ? [{ label: "How to answer this email", bullets: howToAnswer({ token, what: "Room" }) }]
        : []),
      ...kitSection(packet),
      {
        label: "Your call",
        bullets: [
          "Reply here, or decide it on the page: https://os.joinwestpeek.com/#/rooms",
          ...(v.pushback ? [`Where I push back: ${v.pushback}`] : []),
          "Nothing is booked and nobody outside the firm has been contacted.",
        ],
      },
    ],
  };
}

/** The Workshop as plain text, from its stored view. */
export function renderWorkshopPacketText(packet: PacketRow, w: WorkshopView): string {
  return renderWorkshopText({
    title: packet.title.replace(/^Workshop: /, ""),
    month: packet.proposed_for_month,
    monthWord: monthWord(packet.proposed_for_month),
    documentId: packet.document_id,
    brief: parseBrief(packet.brief_json),
    concepts: list<WorkshopConcept>(packet.concepts_json),
    conceptChoiceMd: packet.concept_choice_md,
    pushback: packet.pushback_md,
    view: w,
    risks: list<string>(packet.risks_json),
    commitmentMd: packet.commitment_md,
  });
}

/** The busy-executive summary above a Workshop packet: the promise, who runs it, what it costs, the one decision. */
export function workshopSummary(packet: PacketRow, w: WorkshopView, token?: string): { tldr: string; sections: ExecEmailInput["sections"] } {
  const title = packet.title.replace(/^Workshop: /, "");
  const concepts = list<WorkshopConcept>(packet.concepts_json);
  const others = concepts.filter((c) => !c.chosen);
  const chosen = concepts.find((c) => c.chosen);
  const eco = w.economics;
  const sponsorship = normaliseSponsorship(w.sponsorship);
  const usd = (n: number): string => `$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  return {
    /*
     * THE TL;DR IS THE TOPIC AND THE ANGLES IN ONE GLANCE — item 9. What a reader needs first is
     * "what is this month about, and which way did he go", not a cost band.
     */
    tldr: `**${monthWord(packet.proposed_for_month)} Workshop — topic: ${w.topic ?? title}.** I looked at ${concepts.length || 3} angles on it and chose **${chosen?.title ?? title}**${others.length ? ` over ${others.map((c) => c.title).join(" and ")}` : ""}. ${WORKSHOP_LENGTH_RANGE}, ${WORKSHOP_WHERE}, free to attend. Reply to keep it or say no.`,
    sections: [
      {
        label: "Who I am",
        bullets: [
          "I'm **Parker**, West Peek's Event Marketing Coordinator. I plan the firm's monthly Rooms and Workshops.",
          "Each month I pick one topic, work up three angles on it, choose one, and send you the packet.",
          "Nothing is booked and nobody outside the firm has been contacted until one of you says yes.",
        ],
      },
      {
        label: "The topic and the angles",
        bullets: [
          `Topic: **${w.topic ?? title}** — ${w.topicSetBy === "PARKER" ? "my own pick; nobody had set one" : "set by you"}.`,
          `Chosen angle: **${chosen?.title ?? title}** — ${w.promise}`,
          ...others.slice(0, 2).map((c) => `Also considered: **${c.title}** — ${c.promise}`),
          `For ${w.whoItsFor} · ${w.mode.toLowerCase()} · ${WORKSHOP_LENGTH_RANGE}.`,
        ],
      },
      {
        label: "Who runs it and what it costs",
        bullets: [
          `Host: **${w.facilitator.name}**${w.facilitator.kind === "GUEST" ? " (guest)" : ""}. Co-host: ${w.coHost ? `**${w.coHost.name}**${w.coHost.kind === "GUEST" ? " (guest)" : ""}` : "**nobody named yet** — usually there is one"}.`,
          `**Free to attend**, always, by design. It costs the firm ${usd(eco.estimatedCostLowUsd)}–${usd(eco.estimatedCostHighUsd)}.`,
          sponsorship.suggested
            ? `A small sponsor worth asking anyway: **${sponsorship.suggested.categoryFit}** at about ${usd(sponsorship.suggested.askUsd ?? 0)} — optional, and it would cover ${usd(eco.wouldCoverUsd)} of that.`
            : "I did not suggest a sponsor and I should have — ask me again.",
          ...(w.leaveWith.length ? [`They leave with: ${w.leaveWith.slice(0, 2).join("; ")}.`] : []),
          ...(w.flags.length ? [`Worth knowing: ${w.flags.map((f) => f.detail).join("; ").slice(0, 300)}.`] : []),
        ],
      },
      ...(token
        ? [{
            /*
             * HOW TO ANSWER, SPELLED OUT IN THE MAIL ITSELF — item 9: "Nobody should have to
             * remember the scheme." A worked example of BOTH answers, and the code belongs to this
             * packet only, so there is nothing to look up and no ID to copy.
             */
            label: "How to answer this email",
            bullets: howToAnswer({ token, what: "Workshop" }),
          }]
        : []),
      ...kitSection(packet),
      {
        label: "Your call",
        bullets: [
          "Reply here, or decide it on the page: https://os.joinwestpeek.com/#/rooms",
          ...(packet.pushback_md ? [`Where I push back: ${packet.pushback_md}`] : []),
          ...(packet.document_id ? [`The full packet as a PDF: https://os.joinwestpeek.com/api/documents/${packet.document_id}/download`] : []),
        ],
      },
    ],
  };
}

/** The packet as plain text — the email body, and what a partner can forward. */
export function renderPacketText(packet: PacketRow, venues: VenueLine[], sponsors: SponsorLine[]): string {
  const v = viewFromRows(packet, venues, sponsors);
  const eco = v.economics;
  const chosen = v.concepts.find((c) => c.chosen);
  const others = v.concepts.filter((c) => !c.chosen);
  const lines: string[] = [
    ...parkerIntroduction(),
    "",
    `${v.title} — proposed for ${monthWord(v.month)}`,
    v.origin === "PARTNER_BRIEF" ? "Asked for by a partner." : "Parker's own idea for the month.",
    packet.document_id ? `Download the packet (PDF): https://os.joinwestpeek.com/api/documents/${packet.document_id}/download` : "",
    "",
    v.brief ? `WHAT WAS ASKED FOR\n${v.brief.audience}${v.brief.city ? ` · ${v.brief.city}` : ""}${v.brief.sponsorProspects.length ? `\nSponsor prospects named: ${v.brief.sponsorProspects.join(", ")}` : ""}${v.brief.notes ? `\nNotes: ${v.brief.notes}` : ""}\n` : "",
    v.pushback ? `WHERE I PUSH BACK\n${v.pushback}\n` : "",
    `THEME\n${v.theme}`,
    v.centralQuestion ? `\nCENTRAL QUESTION\n${v.centralQuestion}` : "",
    "",
    chosen ? `THE CONCEPT — ${chosen.title} (${chosen.format.replace(/_/g, " ").toLowerCase()})\n${chosen.premise}\nSignature moment: ${chosen.signatureMoment}${v.conceptChoiceMd ? `\nWhy it won: ${v.conceptChoiceMd}` : ""}${others.length ? `\nAlso considered (in the appendix): ${others.map((c) => `${c.title} — ${c.costBand}`).join("; ")}` : ""}\n` : "",
    v.inviteCheck ? `CAN OUR OWN LIST FILL IT? ${v.inviteCheck.verdict.replace(/_/g, " ")}\n${v.inviteCheck.matchingCount} of ${v.inviteCheck.totalContacts} contacts in the firm's records read as ${v.inviteCheck.matchedOn.join(" / ")}. ${v.inviteCheck.note}${v.inviteCheck.archetypes.length ? `\nArchetypes on the list: ${v.inviteCheck.archetypes.join("; ")}` : ""}${v.inviteCheck.namedFromRecords.length ? `\nA starting list, from our records: ${v.inviteCheck.namedFromRecords.join(", ")}` : ""}\n` : "",
    `WHO IS IN THE ROOM (${v.targetMin}–${v.targetMax} people)`,
    v.audience ?? "Parker did not say.",
    ...v.guestIdeas.map((g) => `- ${g.description}${g.why ? ` — ${g.why}` : ""}`),
    "",
    `RUN OF SHOW — ${v.format.replace(/_/g, " ").toLowerCase()}`,
    ...(v.runOfShow.length ? v.runOfShow.map((l) => `${l.time}${l.minutes ? ` (${l.minutes} min)` : ""} — ${l.what}${l.who ? ` — ${l.who}` : ""}`) : [v.agendaMd ?? "No run-of-show written."]),
    "",
    "QUESTIONS TO SEED IT WITH",
    ...(v.seedQuestions.length ? v.seedQuestions.map((q) => `- ${q}`) : ["- none suggested"]),
    "",
    "VENUE SHORTLIST (nothing verified until a person has called)",
    ...(v.venues.length
      ? v.venues.map((x) => `- ${x.name}${x.isFallback ? " (fallback)" : ""}${x.city ? `, ${x.city}` : ""}${x.capacity ? ` (holds ${x.capacity})` : ""}${x.whyHere ? ` — ${x.whyHere}` : ""}. Est. ${usdText(x.estimateLowUsd)}–${usdText(x.estimateHighUsd)}${x.roomMinimumUsd ? `; room minimum ${usdText(x.roomMinimumUsd)}` : ""}${x.estimateBasis ? ` (${x.estimateBasis})` : ""}${x.priceLowUsd === null && x.priceHighUsd === null ? "; price not published" : `; published ${usdText(x.priceLowUsd ?? x.priceHighUsd)}–${usdText(x.priceHighUsd ?? x.priceLowUsd)}`}${x.priceNote ? ` — ${x.priceNote}` : ""}${x.bookingPhone ? ` · ${x.bookingPhone}` : ""}${x.bookingEmail ? ` · ${x.bookingEmail}` : ""} · ${x.sourceUrl}`)
      : ["- no venue survived sourcing; a person finds the space"]),
    "",
    "BUDGET",
    ...(eco?.lines ?? []).map((l) => `- ${l.label}: ${usdText(l.lowUsd)}–${usdText(l.highUsd)} — ${l.basis}`),
    eco ? `Total ${usdText(eco.estimatedCostLowUsd)}–${usdText(eco.estimatedCostHighUsd)} at ${eco.targetAttendees} people.` : "Not costed.",
    "",
    "SPONSORSHIP STRUCTURE",
    eco ? eco.structure.rationale : "",
    ...(eco?.structure.slots ?? []).map((s) => `- ${s.count} × ${tierWord(s.tier)} at ${usdText(s.askUsd)}: ${s.gets}`),
    eco?.structure.exclusiveUsd ? `- Exclusive option: one sponsor takes the room at ${usdText(eco.structure.exclusiveUsd)}${eco.structure.exclusiveGets ? ` — ${eco.structure.exclusiveGets}` : ""}` : "",
    eco ? `Priced against the high-case cost ${usdText(eco.estimatedCostHighUsd)} + the firm's target keep ${usdText(eco.keepTargetUsd)} = ${usdText(eco.requiredUsd)}. All slots sold: ${usdText(eco.sponsorTargetHighUsd)} — ${eco.reachesKeep ? "target reached" : `SHORT by ${usdText(eco.requiredUsd - eco.sponsorTargetHighUsd)}`}.` : "",
    ...(eco?.scenarios ?? []).map((sc) => `- At ${sc.sponsors} (${sc.description}, ${usdText(sc.sponsorshipUsd)}): ${usdText(sc.netLowUsd)} to ${usdText(sc.netHighUsd)} left for the firm`),
    v.sponsorThesis ? `What a sponsor underwrites: ${v.sponsorThesis}` : "",
    "",
    `SPONSORS, RANKED (${v.sponsors.length})`,
    ...(v.sponsors.length
      ? v.sponsors.flatMap((sp) => [
          `${sp.rank ?? "-"}. ${sp.orgName} (${sp.category.replace(/_/g, " ").toLowerCase()}) — ${tierWord(String(sp.tier))}, ask ${usdText(sp.askUsd)}${sp.fromBrief ? " [named by you]" : ""}`,
          `   Evidence: ${sp.evidenceUrl ? `${sp.evidenceNote ? `${sp.evidenceNote} — ` : ""}${sp.evidenceUrl}` : "NO sponsorship history found on a public page"}`,
          `   Contact: ${sp.contactName ? `${sp.contactName}, ${sp.contactTitle ?? ""} (read from ${sp.contactSourceUrl ?? "a page"})` : "no named contact on a public page — a person finds one"}`,
          sp.fitArgument ? `   Fit: ${sp.fitArgument}` : "   Fit: Parker did not say.",
          sp.pitch ? `   Open with: ${sp.pitch}` : "",
          sp.note ? `   [${sp.note}]` : "",
        ])
      : ["- none named"]),
    "",
    v.alsoLookedAt.length ? `Also looked at, left out because the cited page did not answer when checked: ${v.alsoLookedAt.join(", ")}.` : "",
    "",
    v.pitchEmail ? `THE PITCH — a draft for Sequoia to send to ${v.pitchEmail.to || "the rank-1 sponsor"}\nSubject: ${v.pitchEmail.subject}\n\n${v.pitchEmail.body}\n` : "",
    "RISKS",
    ...(v.risks.length ? v.risks.map((r) => `- ${r}`) : ["- none stated"]),
    "",
    "WHAT SAYING KEEP COMMITS THE FIRM TO",
    v.commitmentMd ?? "Parker did not say — decide before you keep it.",
    "",
    "Keep it or dismiss it: https://os.joinwestpeek.com/#/rooms",
    "— Parker, via West Peek OS. Nothing is booked and nobody outside the firm has been contacted.",
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The finished packet, to both partners, by email — with Parker's introduction and the PDF link.
 *
 * Operator: "when i request a room they should email me and scooter with the deliverable as well";
 * "he needs to send the room of the month to both me and scooter and he needs to intro himself and
 * what he does for the firm in each one." Destination-restricted to the two partner addresses in
 * `emailPartnerDeliverable`.
 */
export async function emailPacket(env: Env, packet: PacketRow): Promise<{ sent: string[]; failed: string[] }> {
  if (packet.status !== "PROPOSED") return { sent: [], failed: [] };
  const [venues, sponsors] = await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(`SELECT ${PACKET_VENUE_COLUMNS} FROM evt_packet_venue WHERE packet_id = ?1 ORDER BY is_fallback, estimate_low_usd`).bind(packet.id),
    env.WP_OS_DB.prepare(`SELECT ${PACKET_SPONSOR_COLUMNS} FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY COALESCE(rank, 99), created_at`).bind(packet.id),
  ]);
  const venueRows = (venues?.results ?? []) as VenueLine[];
  const sponsorRows = (sponsors?.results ?? []) as SponsorLine[];
  const workshop = workshopViewOf(packet);
  const text = workshop ? renderWorkshopPacketText(packet, workshop) : renderPacketText(packet, venueRows, sponsorRows);
  const monthName = monthWord(packet.proposed_for_month);
  /*
   * THE REPLY CODE IS MINTED BEFORE THE MESSAGE IS COMPOSED, because the message has to teach the
   * reader how to use it (item 9) — the code, spelled out, with a worked example of keeping and of
   * saying no. It is idempotent per packet: a re-sent email carries the code the first one carried,
   * so a partner holding the older mail still has a code that works.
   */
  const minted = await tokenForPacket(env, packet);
  const summary = workshop
    ? workshopSummary(packet, workshop, minted.token)
    : packetSummary(packet, venueRows, sponsorRows, minted.token);
  /*
   * ONE EMAIL, TO BOTH OF THEM. Two separate messages were two conversations about one decision —
   * and with a single-use reply code in the mail, the second copy would carry a code the first
   * reply had already spent, with nothing on the page to say so.
   */
  const out = await sendPartnersEmail(env, {
    to: ASSIGNING_PARTNERS,
    email: { employee: "Parker", what: `your ${monthName} ${workshop ? "Workshop" : "Room"} — ${packet.title.replace(/^Workshop: /, "")}${packet.document_id ? " (PDF inside)" : ""}`, tldr: summary.tldr, sections: summary.sections, details: text },
    objectType: "room_packet", objectId: packet.id, firmScope: packet.firm_scope, actorId: "aie_parker",
  });
  const sent: string[] = out.sent ? [...out.recipients] : [];
  const failed: string[] = out.sent ? [] : [...out.recipients];
  if (sent.length > 0) {
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET emailed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(packet.id).run();
  }
  // Inside the OS too, so the packet is findable from Home whether or not the mail was read.
  await notifyPartners(env, {
    kind: "MEETING",
    severity: "INFO",
    title: `Parker proposed a ${workshop ? "Workshop" : "Room"} for ${monthName}: ${packet.title.replace(/^Workshop: /, "").slice(0, 70)}`,
    body: workshop
      ? `${workshop.promise} · ${WORKSHOP_WHERE} · free to attend${normaliseSponsorship(workshop.sponsorship).suggested ? `, suggested sponsor ${normaliseSponsorship(workshop.sponsorship).suggested!.categoryFit}` : ""}.${packet.document_id ? " PDF attached on Events & Rooms." : ""} Keep it or dismiss it there.`
      : `${packet.central_question ?? packet.theme} · ${packet.sponsor_count} sponsor slot(s), $${Math.round(packet.sponsor_total_usd).toLocaleString("en-US")} if all land.${packet.document_id ? " PDF attached on Events & Rooms." : ""} Keep it or dismiss it there.`,
    objectType: "room_packet",
    objectId: packet.id,
    dedupeKey: `room_packet:${packet.id}:proposed`,
    firmScope: packet.firm_scope,
  }).catch(() => undefined);
  /*
   * AND THE ADDRESSED NOTE, WHEN THE CARD SAYS WHO THIS IS FOR (18 Sep 2026).
   *
   * Everything above is the partners' copy: a status report to two people who already know what a
   * West Peek Room is. It is addressed to nobody outside the firm, which is why a partner who
   * wanted a sponsor to see the packet had exactly one move left — forward it from her own mailbox,
   * putting her name on Parker's work.
   *
   * `result_recipient` on the card is her answering "Who is this for?". When it names somebody,
   * Parker composes a SECOND, DIFFERENT message — a letter to that person, with none of the firm's
   * economics in it — and puts it through the lane. Nothing is sent by this: the recipient is
   * outside the firm, so the send boundary refuses it until she presses Send it, and then it goes
   * from Parker's own address in Parker's own words.
   */
  await emailAddressedNote(env, packet, { workshop: workshop !== null, monthName });
  return { sent, failed };
}

/**
 * The covering note to the person the card names, through the preview lane.
 *
 * QUIET WHEN THERE IS NOBODY TO WRITE TO, and that is a legitimate stop rather than an inert
 * branch: most packets are for the partners to decide on and have no outside recipient at all. It
 * says so on the spine either way, so "Parker sent nothing" can be told apart from "Parker was
 * never asked to".
 */
async function emailAddressedNote(
  env: Env,
  packet: PacketRow,
  opts: { workshop: boolean; monthName: string },
): Promise<void> {
  if (!packet.work_card_id) return;
  const card = await env.WP_OS_DB.prepare(
    `SELECT id, kind, result_recipient, preview_first, preview_owner_id, requested_by_email, firm_scope
       FROM work_card WHERE id = ?1`,
  )
    .bind(packet.work_card_id)
    .first<{
      id: string;
      kind: string | null;
      result_recipient: string | null;
      preview_first: number | null;
      preview_owner_id: string | null;
      requested_by_email: string | null;
      firm_scope: string;
    }>();
  const to = (card?.result_recipient ?? "").trim().toLowerCase();
  if (!card || !to) return;

  const what = opts.workshop ? "Workshop" : "Room";
  const workshopView = workshopViewOf(packet);
  const note = parkerAddressedNote({
    recipient: to,
    what,
    monthName: opts.monthName,
    title: packet.title.replace(/^Workshop: /, ""),
    premise: workshopView?.promise ?? packet.central_question ?? packet.theme,
    venue: opts.workshop ? WORKSHOP_WHERE : null,
    targetMin: packet.target_min,
    targetMax: packet.target_max,
    packetUrl: packet.document_id
      ? `https://os.joinwestpeek.com/api/documents/${packet.document_id}/download`
      : null,
    theAsk: parkerSponsorAsk({ what, monthName: opts.monthName }),
  });

  const out = await sendOrPreview(env, {
    to,
    email: note,
    objectType: "room_packet",
    objectId: packet.id,
    workCardId: card.id,
    cardKind: card.kind ?? null,
    cardAsked: card.preview_first === 1 ? true : card.preview_first === 0 ? false : null,
    tickedByFirmUserId: card.preview_owner_id ?? null,
    requestedByEmail: card.requested_by_email ?? null,
    firmScope: packet.firm_scope,
    actorId: "aie_parker",
    what: `Parker's note to ${to} about the ${opts.monthName} ${what}`,
  });

  await appendEvent(env, {
    eventType: out.previewed ? "room_packet.note_previewed" : "room_packet.note_sent",
    actorType: "ai_employee",
    actorId: "aie_parker",
    objectType: "room_packet",
    objectId: packet.id,
    firmScope: packet.firm_scope,
    payload: { recipient: to, owner: out.owner ?? null, approval_id: out.approvalId ?? null, detail: out.reason },
  }).catch(() => undefined);
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Approve or decline a proposal. HUMAN ONLY.
 *
 * A Room commits the firm to spend, to a guest list, and to approaching sponsors in West Peek's
 * name. An AI employee approving its own proposal would make the proposal the decision.
 */
export async function decidePacket(
  env: Env,
  actor: Actor,
  id: string,
  decision: "APPROVED" | "DECLINED",
  note?: string,
): Promise<PacketRow> {
  const packet = await requirePacket(env, id);
  if (actor.type !== "HUMAN") {
    throw new RoomPacketError(403, "human_required", "A Room is approved by a person, not by the employee who proposed it.");
  }
  const authz = await authorize(env, actor, "room_packet.decide", {
    objectType: "room_packet", objectId: id, firmScope: packet.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);
  if (packet.status !== "PROPOSED" && packet.status !== "DRAFT") {
    throw new RoomPacketError(409, "illegal_state", `packet is ${packet.status}`);
  }
  if (packet.status === "DRAFT" && decision === "APPROVED") {
    throw new RoomPacketError(409, "not_built", "This Room has not been built yet; there is nothing to keep.");
  }

  const statements = [
    env.WP_OS_DB.prepare(
      `UPDATE evt_room_packet SET status = ?2, decided_by = ?3, decision_note = ?4,
              decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1`,
    ).bind(id, decision, actor.firmUserId ?? "system", note ?? null),
  ];
  // A dismissed draft takes its card off Parker's desk; the sweep would otherwise keep building it.
  if (packet.status === "DRAFT" && decision === "DECLINED" && packet.work_card_id) {
    statements.push(env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED', next_action = 'The Room request was dismissed.' WHERE id = ?1 AND state IN ('OPEN','IN_PROGRESS')").bind(packet.work_card_id));
  }
  await env.WP_OS_DB.batch(statements);

  await appendEvent(env, {
    eventType: decision === "APPROVED" ? "room_packet.approved" : "room_packet.declined",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "room_packet", objectId: id, firmScope: packet.firm_scope,
    payload: { note: note ?? null },
  });
  return await requirePacket(env, id);
}

/** Turn an approved packet into a real Room on the calendar. */
export async function scheduleRoom(
  env: Env,
  actor: Actor,
  id: string,
  input: { startsAt: string; endsAt?: string | null; location?: string | null; liveUrl?: string | null },
): Promise<{ packet: PacketRow; eventId: string }> {
  const packet = await requirePacket(env, id);
  if (packet.status !== "APPROVED") throw new RoomPacketError(409, "illegal_state", "only an approved packet becomes a Room");
  const authz = await authorize(env, actor, "event.manage", {
    objectType: "event", firmScope: packet.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const eventId = `evt_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_event (id, title, event_type, event_class, cadence, theme, status, starts_at,
                            ends_at, location, live_url, summary, packet_id, target_min, target_max,
                            firm_scope, created_by, kind)
     VALUES (?1,?2,?3,?15,'MONTHLY',?4,'PLANNED',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?16)`,
  )
    .bind(
      eventId, packet.title,
      // The packet's format is the Room's flavour; DINNER and WORKSHOP already exist in the
      // event_type vocabulary, and anything else lands on OTHER rather than failing the CHECK.
      ["DINNER", "WORKSHOP"].includes(packet.format) ? packet.format : "OTHER",
      packet.theme, input.startsAt, input.endsAt ?? null,
      // A Workshop's "where" is fixed: virtual, on West Peek Live.
      packetKindOf(packet.kind) === "WORKSHOP" ? WORKSHOP_WHERE : (input.location ?? null),
      input.liveUrl ?? packet.live_url, packet.central_question, packet.id,
      packet.target_min, packet.target_max, packet.firm_scope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      // A Workshop is not a ROOM in event_class's vocabulary; `kind` names the series it is in.
      packetKindOf(packet.kind) === "WORKSHOP" ? "OTHER" : "ROOM",
      packetKindOf(packet.kind),
    )
    .run();

  await env.WP_OS_DB.prepare(
    "UPDATE evt_room_packet SET status = 'SCHEDULED', event_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(id, eventId).run();

  await appendEvent(env, {
    eventType: "room_packet.scheduled",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "event", objectId: eventId, firmScope: packet.firm_scope,
    payload: { packet_id: id },
  });

  return { packet: await requirePacket(env, id), eventId };
}

/** A person confirms or corrects a venue's details after actually calling. */
export async function verifyVenue(
  env: Env,
  actor: Actor,
  venueId: string,
  verification: "CONFIRMED" | "WRONG" | "UNREACHABLE",
  note?: string,
): Promise<void> {
  if (actor.type !== "HUMAN") {
    throw new RoomPacketError(403, "human_required", "Only a person who called can mark a venue verified.");
  }
  const result = await env.WP_OS_DB.prepare(
    `UPDATE evt_packet_venue SET verification = ?2, note = ?3, verified_by = ?4,
            verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?1`,
  ).bind(venueId, verification, note ?? null, actor.firmUserId ?? "system").run();
  if (!result.meta.changes) throw new RoomPacketError(404, "not_found", "no such venue");
}

// ── The job ──────────────────────────────────────────────────────────────────

/**
 * The Rooms job (job_key `monthly_room_proposal`), ONCE AN HOUR, ONE cheap thing per run:
 *
 *   1. a DRAFT with no live card — open Parker's card. THIS IS A BACKSTOP, NOT THE PATH; else
 *   2. the month being delivered has no packet — queue Parker's own Room for it and open its card;
 *      else
 *   3. nothing, and say so.
 *
 * ─── ACT ON THE EVENT, POLL AS A BACKSTOP (18 Sep 2026) ────────────────────────────────────────
 *
 * Step 1 used to be the path a one-off took: she asked, and up to fifteen minutes later a tick
 * noticed. It is not any more — `handleGeneratePacket` opens Parker's card IN THE REQUEST PATH, so
 * a one-off is on his desk the moment she presses the button, which is zero wait rather than a
 * shorter one.
 *
 * That makes this step a safety net for something that should not occur, and ninety-six ticks a day
 * to catch it is the runaway shape migration 0193 removed from the deck lane. So 0194 drops it to
 * hourly — AND MAKES IT LOUD. A draft whose `work_card_id` was never set means the request path
 * failed to open a card: that is a DEFECT, it notifies the partners and says so in the summary,
 * rather than looking like a poll quietly doing its job. A CANCELLED card is different — that is a
 * human cancelling work and the net legitimately picking it back up — and the two are told apart
 * rather than both being called "opened Parker's card".
 *
 * `tz` is the job's own zone (`scheduled_job.daily_at_tz`, the mechanism from 0193). "The 1st of the
 * month prior" is a local-time boundary and reading it in UTC mints November's packets on the
 * evening of 30 September by her calendar. Omitted, it reads UTC exactly as before.
 *
 * No model runs here. The chain runs in the sweep, a stage per tick.
 */
export async function runMonthlyRoomProposal(
  env: Env,
  actor: Actor,
  now: string,
  tz?: string | null,
): Promise<{ generated: boolean; detail: string; packetId?: string; backstopCaught?: boolean }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const drafts = (await env.WP_OS_DB.prepare(
    `SELECT p.* FROM evt_room_packet p
       LEFT JOIN work_card c ON c.id = p.work_card_id
      WHERE p.firm_scope = ?1 AND p.status = 'DRAFT' AND p.build_attempts < ?2
        AND (p.work_card_id IS NULL OR c.id IS NULL OR c.state IN ('CANCELLED'))
      ORDER BY p.created_at ASC LIMIT 1`,
  ).bind(firmScope, MAX_BUILD_ATTEMPTS).all<PacketRow>()).results ?? [];
  if (drafts[0]) {
    const neverOpened = drafts[0].work_card_id === null;
    const card = await openPacketCard(env, drafts[0]);
    if (neverOpened) {
      /*
       * THE BACKSTOP CAUGHT SOMETHING, WHICH MEANS THE EVENT PATH MISSED. Said out loud, to the
       * partners, because the cost of it being quiet is a one-off that waited an hour and nobody
       * ever learning the request path is broken. Deduped on the packet so a defect reports once.
       */
      await notifyPartners(env, {
        kind: "EMPLOYEE_EXCEPTION",
        severity: "WARNING",
        title: "The Rooms backstop had to open a card the request path should have opened",
        body:
          `"${drafts[0].title}" was queued as a draft with no card on Parker's desk. Asking for a Room opens his ` +
          `card in the same breath, so a draft reaching the hourly backstop means that failed. The work is running ` +
          `now (card ${card.cardId}) — this notice is about the miss, not the Room.`,
        objectType: "room_packet",
        objectId: drafts[0].id,
        dedupeKey: `rooms-backstop-miss:${drafts[0].id}`,
        firmScope,
      });
      return {
        generated: true,
        backstopCaught: true,
        detail:
          `DEFECT — the backstop opened a card the request path should have opened: ${drafts[0].title} ` +
          `(card ${card.cardId}). Asking for a Room opens Parker's card immediately; a draft that reached this ` +
          `hourly net means that did not happen. Partners notified.`,
        packetId: drafts[0].id,
      };
    }
    return { generated: true, detail: `re-opened Parker's card after the last one was cancelled: ${drafts[0].title} (card ${card.cardId})`, packetId: drafts[0].id };
  }

  /*
   * ── THE CADENCE: BOTH STREAMS DELIVER ON THE 1st OF THE MONTH PRIOR ──────────────────────────
   *
   * Operator, 17 Sep 2026: "Both streams deliver on the 1st of the month prior. November's lands
   * 1 October."
   *
   * THIS IS WHERE THE MONTHLY CARD IS MINTED, and it already landed on the 1st — by accident. The
   * guard was "the following month has no packet", which becomes true the moment the month rolls
   * over, so the first tick after midnight on the 1st queued it. True, and true for the wrong
   * reason: nothing named the rule, nothing tested it, and anyone changing the guard would have
   * moved the cadence without knowing there was one.
   *
   * `deliveryMonth` and `dueOn` name it. The check is a FLOOR rather than a window — a tick on the
   * 3rd because the 1st was missed still delivers — because a cadence that only fires on one exact
   * day silently skips a month the first time a cron is late, and work sitting unqueued is a
   * failure this system has already had.
   *
   * ONE ROOM AND ONE WORKSHOP A MONTH, each guarded on its own, and still one cheap thing per run:
   * the Room on this tick, the Workshop on the next. Since 0194 that is an hour later rather than a
   * quarter of an hour, and both still land on the 1st — the floor is the rule, not the minute.
   */
  const month = deliveryMonth(now, tz);
  const skipped: string[] = [];
  for (const kind of ["ROOM", "WORKSHOP"] as const) {
    /*
     * A MONTH THAT IS NOT PARKER'S IS NOT QUEUED, and saying so is the point.
     *
     * October's Workshop is hosted by a friend of Scooter's; no Room runs in September or October.
     * Without this the job would queue a packet for a session somebody else is running — Parker
     * spending four model calls on work that is already somebody's, and a proposal on the shelf
     * competing with the real thing.
     */
    const plan = planFor(month, kind);
    if (plan?.status === "EXTERNAL") {
      skipped.push(`${month}'s ${kind === "WORKSHOP" ? "Workshop" : "Room"} is hosted by ${plan.host ?? "somebody outside the firm"} (${plan.topic ?? "topic not recorded"}), so it is not Parker's to build`);
      continue;
    }
    if (plan?.status === "NOT_RUNNING") {
      skipped.push(`no ${kind === "WORKSHOP" ? "Workshop" : "Room"} runs in ${month}`);
      continue;
    }
    const existing = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND COALESCE(kind, 'ROOM') = ?3",
    ).bind(firmScope, month, kind).first<{ n: number }>();
    if ((existing?.n ?? 0) > 0) continue;
    const draft = await queueDraft(env, actor, { month, origin: "PARKER", kind });
    const card = await openPacketCard(env, draft);
    const topic = plan?.status === "SET" ? plan.topic : null;
    return {
      generated: true,
      detail: `queued Parker's own ${kind === "WORKSHOP" ? "Workshop" : "Room"} for ${month}, due ${dueOn(month)}${topic ? ` — topic set by the partners: "${topic}"; he works up angles on it` : " — he picks the topic himself and works up angles on it"} (card ${card.cardId}); the sweep builds it`,
      packetId: draft.id,
    };
  }
  const building = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND status = 'DRAFT'",
  ).bind(firmScope).first<{ n: number }>();
  return {
    generated: false,
    detail: `${month} (due ${dueOn(month)}) is covered${skipped.length ? `: ${skipped.join("; ")}` : " — it already has a Room and a Workshop proposal"}${(building?.n ?? 0) > 0 ? `; ${building!.n} request(s) being built by Parker in the sweep` : ""}`,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof RoomPacketError) return json({ error: err.code, detail: err.message }, { status: err.status });
  // A steer is asked for through the same doors, so its errors have to come back through the same
  // hole. Without this a 403 on the steer path escapes as a 500 and reads as an outage.
  if (err instanceof MonthSteerError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const briefSchema = z.object({
  kind: z.enum(["ROOM", "WORKSHOP"]).optional(),
  audience: z.string().trim().min(3).max(400),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  city: z.string().trim().max(80).optional(),
  sponsor_prospects: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  notes: z.string().trim().max(1500).optional(),
  /** A declined packet this one is a rework of. */
  again_from: z.string().max(80).optional(),
  /**
   * WHICH OF THE TWO ASKS THIS IS, declared rather than inferred. NOW builds it; STEER records it
   * against the month and gives it to Parker when he builds that month's packet. Omitted, the door
   * decides only where the calendar makes it unambiguous and otherwise asks — see `classifyAsk`.
   */
  intent: z.enum(["NOW", "STEER"]).optional(),
});

/**
 * POST /api/rooms/packets — the two doors, and now the two KINDS of ask.
 *
 * An empty body is "Parker, think of one" (his own idea for the FOLLOWING month, or the month
 * given). A body with `audience` is her brief, and the packet records that it came from her.
 *
 * ─── A ONE-OFF AND A STEER ARE NOT THE SAME ASK (18 Sep 2026) ─────────────────────────────────
 *
 * Operator: "a one off should be delivered and acted upon immediately; asking for a specific topic
 * or angle to next months propoals should come when the month's proposal comes".
 *
 * Until today this route could not tell them apart and did the first thing to both: an ask on
 * 18 September naming November opened a card titled "Parker: build the November 2026 Room packet"
 * in state OPEN, and the sweep would have built and emailed November's packet that afternoon.
 * Reproduced before this was written, not inferred from reading it.
 *
 *   intent NOW    — Parker's card opens HERE, in the request path, before this route returns. Zero
 *                   wait; the sweep runs a stage every few minutes and the page shows which.
 *   intent STEER  — NOTHING is built. Her words are recorded against the month they are FOR, shown
 *                   on the page until then, and handed to Parker when he builds that month.
 *
 * NO INTENT, NO GUESS. `classifyAsk` settles it where the calendar is unambiguous and REFUSES where
 * it is not, returning both readings for her to pick from. A 400 costs a click; silently building
 * November's Room in September cost the thing this route exists to protect.
 */
export async function handleGeneratePacket(ctx: RouteContext): Promise<Response> {
  const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const actor = actorFromIdentity(ctx.identity!);
  try {
    let draft: PacketRow;
    if (typeof body.audience === "string" && body.audience.trim().length > 0) {
      const parsed = briefSchema.safeParse(body);
      if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
      const b = parsed.data;
      const brief: RoomBrief = {
        audience: b.audience,
        month: b.month,
        city: b.city && b.city.length > 0 ? b.city : null,
        sponsorProspects: (b.sponsor_prospects ?? []).filter((x) => x.length > 0),
        notes: b.notes && b.notes.length > 0 ? b.notes : null,
      };
      /*
       * THE FORK. It happens before `queueDraft` because a steer must never become a draft: a draft
       * is a thing Parker builds, and the whole requirement is that this one is not built yet.
       */
      const ask = classifyAsk({ month: b.month, declared: b.intent ?? null, nowIso: new Date().toISOString() });
      if (ask.intent === null) {
        return json(
          {
            error: "intent_required",
            detail: `Say which of these you mean. ${ask.why}.`,
            readings: ask.readings,
            // The two values the client must send back, named so a caller does not have to guess.
            intents: [
              { intent: "NOW", means: ask.readings[0] },
              { intent: "STEER", means: ask.readings[1] },
            ],
          },
          { status: 400 },
        );
      }
      if (ask.intent === "STEER") {
        const steer = await recordSteer(ctx.env, actor, {
          month: b.month,
          stream: (b.kind ?? "ROOM") === "WORKSHOP" ? "WORKSHOP" : "ROOM",
          // Her words, unedited — the audience line is what she typed, and the notes with it.
          words: [b.audience, b.notes].filter((x) => x && x.trim()).join(" — "),
        });
        return json(
          {
            steer,
            queued: false,
            // What she is owed and when, in the reply, so the page never has to re-derive it.
            deliversWith: b.month,
            dueOn: dueOn(b.month),
            why: ask.why,
          },
          { status: 201 },
        );
      }
      draft = await queueDraft(ctx.env, actor, { month: b.month, brief, origin: "PARTNER_BRIEF", parentPacketId: b.again_from ?? null, kind: b.kind ?? "ROOM" });
    } else {
      const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : followingMonth(new Date().toISOString());
      const city = typeof body.city === "string" && body.city.trim() ? body.city.trim().slice(0, 80) : null;
      const kind: PacketKind = packetKindOf(body.kind);
      /*
       * NO `intent` FORK ON THIS BRANCH, DELIBERATELY. "Parker, think of one" carries no words to
       * steer WITH — a steer with nothing in it is not a steer, it is an empty row she would then
       * see on the page and have to withdraw. An empty-bodied ask is a one-off by construction.
       */
      draft = await queueDraft(ctx.env, actor, { month, origin: "PARKER", kind, brief: city && kind === "ROOM" ? { audience: "Parker's own Room", month, city, sponsorProspects: [], notes: null } : null });
    }
    const card = draft.status === "DRAFT" ? await openPacketCard(ctx.env, draft) : null;
    return json({ packet: await requirePacket(ctx.env, draft.id), queued: draft.status === "DRAFT", cardId: card?.cardId ?? draft.work_card_id }, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleListPackets(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, title, theme, central_question, status, proposed_for_month, format, target_min,
            target_max, audience, sponsor_thesis, economics_json, event_id, decided_by, decided_at,
            decision_note, created_at, origin, brief_json, requested_by, sponsor_count,
            sponsor_total_usd, build_error, build_attempts, parent_packet_id, emailed_at,
            build_stage, work_card_id, document_id, pushback_md, kind
     FROM evt_room_packet ORDER BY proposed_for_month DESC, created_at DESC LIMIT 60`,
  ).all();
  /*
   * THE STEERS RIDE ALONG WITH THE PACKETS, in the call the page already makes.
   *
   * An instruction she gave in September that is invisible until October is an instruction she
   * cannot correct, and correcting it is the whole reason for showing it. A second endpoint and a
   * second hook would have been a second thing to remember to load — and the page that forgot it
   * would look exactly like a page with no steers on it.
   */
  const firmScope = actorFromIdentity(ctx.identity!).firmScopes[0] ?? "west-peek";
  return json({
    packets: rows.results ?? [],
    steers: await steerBoard(ctx.env, firmScope),
    stageLabels: BUILD_STAGE_LABELS,
    workshopStageLabels: WORKSHOP_STAGE_LABELS,
    stages: BUILD_STAGES,
    keepTargetUsd: SPONSORSHIP_TARGET.keepUsd,
    workshopSeries: WORKSHOP_SERIES_FOR_PAGE,
  });
}

/**
 * POST /api/rooms/steers/:id/withdraw — she changed her mind before the month came round.
 *
 * Visible and correctable are one requirement, not two: showing her an instruction she cannot take
 * back is showing her a fait accompli. The row is marked withdrawn rather than deleted, because
 * what she told Parker in September is part of why November looks the way it does.
 */
export async function handleWithdrawSteer(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json({ steer: await withdrawSteer(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id) });
  } catch (err) {
    return fail(err);
  }
}

export async function handleGetPacket(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const packet = await requirePacket(ctx.env, ctx.params.id);
    const venues = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM evt_packet_venue WHERE packet_id = ?1 ORDER BY is_fallback, price_low_usd",
    ).bind(packet.id).all();
    const sponsors = await ctx.env.WP_OS_DB.prepare(
      `SELECT id, org_name, tier, category, stage, ask_low_usd, ask_high_usd, committed_usd, pitch, ask_detail, source_url, note, decline_reason,
              evidence_url, evidence_note, contact_name, contact_title, contact_source_url, fit_argument, rank, sponsorship_summary
         FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY COALESCE(rank, 99), created_at`,
    ).bind(packet.id).all();
    // The build state is Parker's working memory, not the packet; the page gets the flags only.
    const { build_state_json, workshop_json, ...rest } = packet;
    const workshop = workshopViewOf(packet);
    return json({ packet: rest, brief: parseBrief(packet.brief_json), venues: venues.results ?? [], sponsors: sponsors.results ?? [], flags: workshop ? workshop.flags : parseState(build_state_json).flags, workshop });
  } catch (err) {
    return fail(err);
  }
}

const decideSchema = z.object({
  decision: z.enum(["APPROVED", "DECLINED"]),
  note: z.string().max(1000).optional(),
});

export async function handleDecidePacket(ctx: RouteContext): Promise<Response> {
  const parsed = decideSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await decidePacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.decision, parsed.data.note));
  } catch (err) {
    return fail(err);
  }
}

const scheduleSchema = z.object({
  starts_at: z.string().min(10),
  ends_at: z.string().nullish(),
  location: z.string().max(300).nullish(),
  live_url: z.string().max(500).nullish(),
});

export async function handleScheduleRoom(ctx: RouteContext): Promise<Response> {
  const parsed = scheduleSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(
      await scheduleRoom(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, {
        startsAt: parsed.data.starts_at,
        endsAt: parsed.data.ends_at,
        location: parsed.data.location,
        liveUrl: parsed.data.live_url,
      }),
      { status: 201 },
    );
  } catch (err) {
    return fail(err);
  }
}

const verifyVenueSchema = z.object({
  verification: z.enum(["CONFIRMED", "WRONG", "UNREACHABLE"]),
  note: z.string().max(500).optional(),
});

export async function handleVerifyVenue(ctx: RouteContext): Promise<Response> {
  const parsed = verifyVenueSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await verifyVenue(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.verification, parsed.data.note);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}

/** The set months, for the page's request form: a Workshop in one of these months carries the partners' title. */
const WORKSHOP_SERIES_FOR_PAGE = WORKSHOP_SERIES;

export { monthKey, packetFilename };
