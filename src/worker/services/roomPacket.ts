import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { findVenues, SEARCH_MODEL } from "./liveSearch";
import { pageTextOf, urlStatus } from "../effects/urlLiveness";
import {
  SPONSORSHIP_TARGET,
  audienceTerms,
  buildConceptsPrompt,
  buildPacketPrompt,
  buildSponsorDiscoveryPrompt,
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
import { packetFilename, parkerIntroduction, renderPacketHtml, type PacketView, type SponsorView, type VenueView } from "../../shared/events/roomPacketPdf";
import { guidanceBlock } from "../../shared/skills/library";
import { writtenGuidance } from "./firmSkills";
import { emailPartnerDeliverable } from "./requestReply";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { notifyPartners } from "./notifications";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { uploadDocument } from "./documents";

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

export const BUILD_STAGES = ["QUEUED", "DISCOVER", "RESEARCH", "CONCEPTS", "VENUES", "PACKET", "PDF", "DONE"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

/** What the page says while Parker is on each stage. */
export const BUILD_STAGE_LABELS: Readonly<Record<BuildStage, string>> = {
  QUEUED: "waiting for Parker to pick it up",
  DISCOVER: "reading the firm's list and finding who pays to be in front of this audience",
  RESEARCH: "researching each sponsor — their programme, the people who run it, their own words",
  CONCEPTS: "ideating three concepts and choosing one",
  VENUES: "searching venues for the chosen concept",
  PACKET: "writing the packet — run of show, budget, structure, the pitch",
  PDF: "rendering the PDF and emailing both partners",
  DONE: "done",
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
}

export function emptyState(): BuildState {
  return { candidates: [], research: [], researched: [], inviteCheck: null, concepts: [], choiceRationale: null, pushback: null, venueHits: [], venueCitations: [], venueDetail: null, flags: [], pdfError: null, discoveryDetail: null, dropped: [] };
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

export interface ChainDeps {
  search?: VenueSearch;
  research?: ResearchSearch;
  synthesise?: Synthesise;
  urlCheck?: UrlCheck;
  pageText?: PageText;
  render?: RenderPdf;
  now?: Date;
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
    budgetContext: { expectedOutputTokens: 2500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", citations: [], detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model !== SEARCH_MODEL) return { ok: false, text: "", citations: [], detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  return { ok: true, text: run.output_text, citations: extractUrls(run.output_text), detail: "ok" };
};

async function defaultSynthesise(env: Env, actor: Actor, purpose: string, prompt: string, expectedOutputTokens: number): Promise<{ text: string; aiRunId: string | null }> {
  const { run } = await runAi(env, {
    purpose,
    actor,
    inputs: [prompt],
    // The prompt carries public research, a city, a theme and counts from the firm's own list —
    // no member identities beyond names already in its own records.
    sensitivity: "PUBLIC" as never,
    budgetContext: { expectedOutputTokens, providerKey: "openrouter" },
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
  input: { month: string; origin: PacketOrigin; brief?: RoomBrief | null; parentPacketId?: string | null },
): Promise<PacketRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const id = `rpk_${crypto.randomUUID()}`;
  const theme = input.brief?.audience ?? "Parker's proposal for the month";
  const title = input.brief ? `Room requested: ${input.brief.audience.slice(0, 70)}` : `Parker's Room for ${input.month}`;
  const existing = await env.WP_OS_DB.prepare(
    "SELECT * FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3",
  ).bind(firmScope, input.month, title).first<PacketRow>();
  if (existing) return existing;

  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_room_packet
       (id, title, theme, status, proposed_for_month, origin, brief_json, requested_by, parent_packet_id,
        firm_scope, created_by, build_stage)
     VALUES (?1,?2,?3,'DRAFT',?4,?5,?6,?7,?8,?9,?10,'QUEUED')`,
  )
    .bind(
      id, title, theme, input.month, input.origin,
      input.brief ? JSON.stringify(input.brief) : null,
      input.origin === "PARTNER_BRIEF" ? (actor.firmUserId ?? null) : null,
      input.parentPacketId ?? null,
      firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    )
    .run();

  await appendEvent(env, {
    eventType: "room_packet.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    objectType: "room_packet", objectId: id, firmScope,
    payload: { month: input.month, origin: input.origin, sponsors_named: input.brief?.sponsorProspects.length ?? 0, parent: input.parentPacketId ?? null },
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
  const title = `Parker: build the ${monthWord(draft.proposed_for_month)} Room packet — ${draft.title.slice(0, 60)}`;
  const card = await createWorkCardInternal(env, sweepIdentity(draft.firm_scope), {
    title,
    description: [
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
  const research = deps.research ?? defaultResearch;
  const check = deps.urlCheck ?? ((u: string) => urlStatus(u));
  const pageText = deps.pageText ?? ((u: string) => pageTextOf(u));
  const synth = (purpose: string, prompt: string, tokens: number) => (deps.synthesise ? deps.synthesise(prompt) : defaultSynthesise(env, actor, purpose, prompt, tokens));
  const stage: BuildStage = draft.build_stage === "QUEUED" ? "DISCOVER" : draft.build_stage;

  const failStage = async (detail: string): Promise<never> => {
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET build_error = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(draft.id, `${stage}: ${detail}`.slice(0, 500)).run();
    throw new RoomPacketError(502, "stage_failed", `${stage}: ${detail}`);
  };

  try {
    if (stage === "DISCOVER") {
      state.inviteCheck = await inviteCheck(env, firmScope, brief, draft.target_max || 40);
      const found = await research(env, actor, buildSponsorDiscoveryPrompt({ brief, city, month: draft.proposed_for_month }));
      if (!found.ok) return await failStage(`sponsor discovery search failed: ${found.detail}`);
      const parsed = parseSponsorCandidates(found.text, brief);
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
      const todo = state.candidates.filter((c) => !state.researched.some((r) => sameOrg(r, c.orgName))).slice(0, Math.max(0, Math.min(RESEARCH_PER_TICK, MAX_RESEARCHED - state.research.length)));
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
      const remaining = state.candidates.filter((c) => !state.researched.some((r) => sameOrg(r, c.orgName))).length;
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
        "SELECT theme FROM evt_room_packet WHERE firm_scope = ?1 AND id != ?2 AND status != 'DRAFT' ORDER BY created_at DESC LIMIT 8",
      ).bind(firmScope, draft.id).all<{ theme: string }>();
      const prompt = buildConceptsPrompt({
        month: draft.proposed_for_month, city, brief, recentThemes: (recent.results ?? []).map((r) => r.theme),
        inviteCheck: state.inviteCheck, sponsors: state.research, guidance: await guidanceFor(env, firmScope),
      });
      const { text } = await synth("Room packet: three concepts", prompt, 3000);
      const parsed = parseConcepts(text);
      if (!parsed) return await failStage("the concepts did not come back in a usable shape");
      state.concepts = parsed.concepts;
      state.choiceRationale = parsed.choiceRationale;
      state.pushback = parsed.pushback;
      await saveStage(env, draft.id, "VENUES", state);
      const chosen = parsed.concepts.find((c) => c.chosen)!;
      return { stage, next: "VENUES", note: `chose "${chosen.title}" (${chosen.format}) over ${parsed.concepts.length - 1} other(s)${parsed.pushback ? `; pushback: ${parsed.pushback.slice(0, 120)}` : ""}` };
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
      return { stage, next: "PDF", note: `"${packet.title}": ${packet.venues.length} venue(s), ${packet.sponsorProspects.length} sponsor(s) ranked, ${packet.runOfShow.length} run-of-show lines, ${economics.scenarios.length} slot(s) — the firm keeps $${economics.netHighUsd.toLocaleString("en-US")} if all land` };
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
              invite_check_json = ?23, pushback_md = ?24, build_stage = 'PDF', build_state_json = ?25,
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
    const why = "This card has no Room packet behind it — the request it was opened for is gone.";
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1").bind(card.id, why).run();
    return { finished: false, blocked: true, progressed: false, detail: why };
  }
  if (packet.status !== "DRAFT" && packet.build_stage !== "PDF") {
    // Dismissed by a person, or already built: the card closes without noise.
    await closeCard(env, card.id, packet.status === "DECLINED" ? "The request was dismissed before the packet was built." : `The packet is ${packet.status.toLowerCase()}.`);
    return { finished: true, blocked: false, progressed: false, detail: packet.status === "DECLINED" ? "the request was dismissed; nothing more to build" : `already ${packet.status.toLowerCase()}` };
  }
  const out = await runStage(env, packet, deps);
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
  const text = renderPacketText(packet, (venues?.results ?? []) as VenueLine[], (sponsors?.results ?? []) as SponsorLine[]);
  const monthName = monthWord(packet.proposed_for_month);
  const subject = `Parker: your ${monthName} Room — ${packet.title}${packet.document_id ? " (PDF inside)" : ""}`.slice(0, 180);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const to of ASSIGNING_PARTNERS) {
    const out = await emailPartnerDeliverable(env, {
      to, subject, text, objectType: "room_packet", objectId: packet.id, firmScope: packet.firm_scope, actorId: "aie_parker",
    });
    (out.sent ? sent : failed).push(to);
  }
  if (sent.length > 0) {
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET emailed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(packet.id).run();
  }
  // Inside the OS too, so the packet is findable from Home whether or not the mail was read.
  await notifyPartners(env, {
    kind: "MEETING",
    severity: "INFO",
    title: `Parker proposed a Room for ${monthName}: ${packet.title.slice(0, 70)}`,
    body: `${packet.central_question ?? packet.theme} · ${packet.sponsor_count} sponsor slot(s), $${Math.round(packet.sponsor_total_usd).toLocaleString("en-US")} if all land.${packet.document_id ? " PDF attached on Events & Rooms." : ""} Keep it or dismiss it there.`,
    objectType: "room_packet",
    objectId: packet.id,
    dedupeKey: `room_packet:${packet.id}:proposed`,
    firmScope: packet.firm_scope,
  }).catch(() => undefined);
  return { sent, failed };
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
                            firm_scope, created_by)
     VALUES (?1,?2,?3,'ROOM','MONTHLY',?4,'PLANNED',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  )
    .bind(
      eventId, packet.title,
      // The packet's format is the Room's flavour; DINNER and WORKSHOP already exist in the
      // event_type vocabulary, and anything else lands on OTHER rather than failing the CHECK.
      ["DINNER", "WORKSHOP"].includes(packet.format) ? packet.format : "OTHER",
      packet.theme, input.startsAt, input.endsAt ?? null, input.location ?? null,
      input.liveUrl ?? packet.live_url, packet.central_question, packet.id,
      packet.target_min, packet.target_max, packet.firm_scope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
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
 * The Rooms job (job_key `monthly_room_proposal`), every quarter hour, ONE cheap thing per run:
 *
 *   1. a DRAFT with no live card (a request whose card was never opened, or whose card was
 *      cancelled) — open Parker's card for it; the sweep builds it; else
 *   2. the FOLLOWING month has no packet — queue Parker's own Room for it and open its card; else
 *   3. nothing, and say so.
 *
 * No model runs here. The chain runs in the sweep, a stage per tick.
 */
export async function runMonthlyRoomProposal(
  env: Env,
  actor: Actor,
  now: string,
): Promise<{ generated: boolean; detail: string; packetId?: string }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const drafts = (await env.WP_OS_DB.prepare(
    `SELECT p.* FROM evt_room_packet p
       LEFT JOIN work_card c ON c.id = p.work_card_id
      WHERE p.firm_scope = ?1 AND p.status = 'DRAFT' AND p.build_attempts < ?2
        AND (p.work_card_id IS NULL OR c.id IS NULL OR c.state IN ('CANCELLED'))
      ORDER BY p.created_at ASC LIMIT 1`,
  ).bind(firmScope, MAX_BUILD_ATTEMPTS).all<PacketRow>()).results ?? [];
  if (drafts[0]) {
    const card = await openPacketCard(env, drafts[0]);
    return { generated: true, detail: `opened Parker's card for the Room that was asked for: ${drafts[0].title} (card ${card.cardId})`, packetId: drafts[0].id };
  }

  const month = followingMonth(now);
  const existing = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2",
  ).bind(firmScope, month).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    const building = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND status = 'DRAFT'",
    ).bind(firmScope).first<{ n: number }>();
    return {
      generated: false,
      detail: `${month} already has a proposal${(building?.n ?? 0) > 0 ? `; ${building!.n} request(s) being built by Parker in the sweep` : ""}`,
    };
  }

  const draft = await queueDraft(env, actor, { month, origin: "PARKER" });
  const card = await openPacketCard(env, draft);
  return { generated: true, detail: `queued Parker's own Room for ${month} (card ${card.cardId}); the sweep builds it`, packetId: draft.id };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof RoomPacketError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const briefSchema = z.object({
  audience: z.string().trim().min(3).max(400),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  city: z.string().trim().max(80).optional(),
  sponsor_prospects: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  notes: z.string().trim().max(1500).optional(),
  /** A declined packet this one is a rework of. */
  again_from: z.string().max(80).optional(),
});

/**
 * POST /api/rooms/packets — the two doors.
 *
 * An empty body is "Parker, think of one" (his own idea for the FOLLOWING month, or the month
 * given). A body with `audience` is her brief, and the packet records that it came from her.
 * Either way the draft is on the record and Parker's card is open before the route returns; the
 * build runs in the sweep, a stage every few minutes, and the page shows which stage he is on.
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
      draft = await queueDraft(ctx.env, actor, { month: b.month, brief, origin: "PARTNER_BRIEF", parentPacketId: b.again_from ?? null });
    } else {
      const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : followingMonth(new Date().toISOString());
      const city = typeof body.city === "string" && body.city.trim() ? body.city.trim().slice(0, 80) : null;
      draft = await queueDraft(ctx.env, actor, { month, origin: "PARKER", brief: city ? { audience: "Parker's own Room", month, city, sponsorProspects: [], notes: null } : null });
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
            build_stage, work_card_id, document_id, pushback_md
     FROM evt_room_packet ORDER BY proposed_for_month DESC, created_at DESC LIMIT 60`,
  ).all();
  return json({ packets: rows.results ?? [], stageLabels: BUILD_STAGE_LABELS, stages: BUILD_STAGES, keepTargetUsd: SPONSORSHIP_TARGET.keepUsd });
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
    const { build_state_json, ...rest } = packet;
    return json({ packet: rest, brief: parseBrief(packet.brief_json), venues: venues.results ?? [], sponsors: sponsors.results ?? [], flags: parseState(build_state_json).flags });
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

export { monthKey, packetFilename };
