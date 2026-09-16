import { personaPrompt } from "../registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";
import type { RoomBrief, RoomConcept, RunOfShowLine } from "./roomPacket";

/**
 * Monthly Workshops — the Room chain with a different brief (16 Sep 2026).
 *
 * Operator: "we are introducing monthly workshops in addition to Rooms. September's is already
 * set: 'How to use AI for small businesses / solopreneurs'. November's is 'How to build community'.
 * We need workshops for October and December, and every month ongoing — the same workflow as
 * Rooms: a packet with three concepts compared, one chosen." And, the same day: "WORKSHOPS ARE
 * VIRTUAL ONLY. No venue research, no costed in-person option, no venue section in the Workshop
 * packet or PDF. Every Workshop runs on West Peek Live."
 *
 * ONE CHAIN, TWO KINDS. A Workshop is `evt_room_packet.kind = 'WORKSHOP'` on the same table, the
 * same queue, the same card on Parker's desk, the same one-stage-per-tick sweep, the same
 * approve/decline door and the same email. What differs is the BRIEF — the research question, the
 * three concepts, the packet, the PDF — and that is what this file holds. The Room branch of the
 * chain is untouched; the Workshop branch skips the sponsor stages and the venue stage entirely.
 *
 * THE FIXED "WHERE". Virtual · West Peek Live: a live stage for the facilitator, attendee join by
 * code, chat, hand-raise, breakouts for exercises. So the packet's "where" is a DELIVERY PLAN — the
 * platform run of show (stage segments versus breakout exercises), what the facilitator needs on
 * screen, the join-code invitation flow, a tech-check note — never a venue. The verifier strips a
 * venue if a model offers one, and the tests pin that a Workshop packet never carries one.
 */

export const PACKET_KINDS = ["ROOM", "WORKSHOP"] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];

export function packetKindOf(v: unknown): PacketKind {
  return v === "WORKSHOP" ? "WORKSHOP" : "ROOM";
}

/**
 * THE SERIES ON THE RECORD. Months the partners have already decided; Parker builds the packet
 * from the title and does not re-ideate the topic. Any other month is OPEN: Parker proposes three
 * and chooses. Kept in code, not in a table, because it is a decision the partners made once and a
 * row an admin path could edit would make it look revisable from a screen.
 */
export const WORKSHOP_SERIES: Readonly<Record<string, string>> = {
  "2026-09": "How to use AI for small businesses / solopreneurs",
  "2026-11": "How to build community",
};

export function setWorkshopTitle(month: string): string | null {
  return WORKSHOP_SERIES[month] ?? null;
}

export const WORKSHOP_WHERE = "Virtual · West Peek Live";
export const WORKSHOP_LENGTH_MINUTES = 90;
/** The audience a Workshop is for by default; the brief's audience narrows it. */
export const WORKSHOP_AUDIENCE = "small-business owners, solopreneurs and community builders";

export type WorkshopMode = "TEACH" | "DO" | "SHOW" | "MIXED";
export const WORKSHOP_MODES: readonly WorkshopMode[] = ["TEACH", "DO", "SHOW", "MIXED"];

/** A Workshop concept: the Room concept's fields (so the shared tables render it) plus what a Workshop is judged on. */
export interface WorkshopConcept extends RoomConcept {
  /** Who it is for, in one line. */
  whoItsFor: string;
  /** What they can DO after 90 minutes. */
  promise: string;
  mode: WorkshopMode;
  /** The template, checklist or artifact every attendee leaves with. */
  leaveWith: string;
  facilitator: WorkshopFacilitator;
}

export interface WorkshopFacilitator {
  /** "Sequoia Taylor", "Scooter Taylor", or a named guest. */
  name: string;
  kind: "PARTNER" | "GUEST";
  /** Why this person can teach this. */
  why: string;
  /** A guest carries a live page that shows they do this; a partner does not need one. Stripped if not judged. */
  evidenceUrl: string | null;
}

export interface WorkshopRunOfShowLine extends RunOfShowLine {
  /** On the live stage, or in breakouts doing the exercise. */
  segment: "STAGE" | "BREAKOUT";
}

export interface WorkshopDelivery {
  where: typeof WORKSHOP_WHERE;
  /** The platform plan: which segments are on stage and which are breakouts, in order. */
  platformRunOfShow: string[];
  /** Slides, screen share, a shared doc, a timer — what the facilitator needs on screen. */
  onScreen: string[];
  /** How people get in: the join-code invitation flow, in steps. */
  joinFlow: string[];
  techCheck: string;
}

export interface WorkshopInvitation {
  n: number;
  /** "10 days before", "the morning of". */
  sendWhen: string;
  subject: string;
  body: string;
}

export type WorkshopBudgetKey = "facilitator_fee" | "production_time" | "materials" | "contingency";
export const WORKSHOP_BUDGET_LABELS: Readonly<Record<WorkshopBudgetKey, string>> = {
  facilitator_fee: "Facilitator or guest fee",
  production_time: "Production time (prep, run, follow-up)",
  materials: "Templates, checklists and the artifact",
  contingency: "Contingency (10%)",
};

export interface WorkshopBudgetLine {
  key: WorkshopBudgetKey;
  label: string;
  lowUsd: number;
  highUsd: number;
  basis: string;
}

export interface WorkshopEconomics {
  kind: "WORKSHOP";
  lines: WorkshopBudgetLine[];
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  /** True when the Workshop is free/community by design and no sponsor is sought. */
  free: boolean;
  /** When a sponsor is sought: the ask; else 0. */
  sponsorshipUsd: number;
  /** The firm's keep at the ask, if any: sponsorship − high-case cost. */
  keepUsd: number;
}

export interface WorkshopSponsorship {
  /** Free/community by design, or a sponsor slot that fits. */
  free: boolean;
  /** Why free, or the category and ask that fits. Never a named prospect without evidence. */
  note: string;
  categoryFit: string | null;
  askUsd: number | null;
}

export interface WorkshopPacket {
  title: string;
  topic: string;
  whoItsFor: string;
  promise: string;
  mode: WorkshopMode;
  targetMin: number;
  targetMax: number;
  runOfShow: WorkshopRunOfShowLine[];
  /** The exercises attendees do, each in one line. */
  exercises: string[];
  leaveWith: string[];
  facilitator: WorkshopFacilitator;
  delivery: WorkshopDelivery;
  sponsorship: WorkshopSponsorship;
  promoOneLiner: string;
  invitations: WorkshopInvitation[];
  budgetLines: Array<{ key: WorkshopBudgetKey; lowUsd: number; highUsd: number; basis: string }>;
  risks: string[];
  commitmentMd: string | null;
  pushback: string | null;
  conceptChoiceMd: string | null;
}

/** A research note the discovery stage kept: what the audience is asking, from a live, judged page. */
export interface WorkshopNote {
  fact: string;
  source: string;
  url: string;
  date: string | null;
}

export interface WorkshopFlag {
  code: "venue_removed" | "unjudged_url_removed" | "guest_without_evidence" | "no_run_of_show" | "no_leave_with" | "no_invitations" | "length_off";
  detail: string;
}

/** What is stored in `evt_room_packet.workshop_json` and read by the page, the text and the PDF. */
export interface WorkshopView {
  whoItsFor: string;
  promise: string;
  mode: WorkshopMode;
  runOfShow: WorkshopRunOfShowLine[];
  exercises: string[];
  leaveWith: string[];
  facilitator: WorkshopFacilitator;
  delivery: WorkshopDelivery;
  sponsorship: WorkshopSponsorship;
  promoOneLiner: string;
  invitations: WorkshopInvitation[];
  economics: WorkshopEconomics;
  notes: WorkshopNote[];
  flags: WorkshopFlag[];
  topicSet: boolean;
}

// ── The brief ────────────────────────────────────────────────────────────────

/** Is this brief a Workshop's? The Room brief carries `kind` when it is; older rows carry nothing and are Rooms. */
export function briefKind(brief: (RoomBrief & { kind?: PacketKind }) | null | undefined): PacketKind {
  return packetKindOf(brief?.kind);
}

/** The topic a Workshop is built on: the set title for a series month, else what was asked. */
export function workshopTopic(month: string, brief: RoomBrief | null): { topic: string; set: boolean } {
  const set = setWorkshopTitle(month);
  if (set) return { topic: set, set: true };
  return { topic: brief?.audience?.trim() || "a workshop for the community this month", set: false };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function parkerIdentity(): string {
  return personaPrompt("Parker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")?.role ?? "AI employee");
}

const WHAT_A_WORKSHOP_IS = [
  "A West Peek Workshop is a 90-minute VIRTUAL working session on West Peek Live — a live stage for",
  "the facilitator, attendee join by code, chat, hand-raise, and breakouts for exercises — for",
  `${WORKSHOP_AUDIENCE}. The promise is what they can DO after 90 minutes, not what they will have`,
  "heard. Teach / do / show: a short teach, a real exercise in breakouts, a show-and-tell back on",
  "stage. Every attendee leaves with an artifact — a template, a checklist, a filled-in worksheet.",
  "It runs monthly beside the Room and the Community Mastermind. It can be free by design.",
].join("\n");

/**
 * STAGE 1 — what the audience is asking about this month. Run on the search model; every note
 * carries the URL of the page that says it; every URL is checked live and then JUDGED.
 */
export function buildWorkshopDiscoveryPrompt(input: { month: string; topic: string; set: boolean; brief: RoomBrief | null }): string {
  return [
    parkerIdentity(),
    "",
    WHAT_A_WORKSHOP_IS,
    "",
    input.set
      ? `The ${input.month} Workshop's title is SET by the partners: "${input.topic}". Research what ${WORKSHOP_AUDIENCE} are asking about THIS right now — so the session teaches the questions they actually have.`
      : `The ${input.month} Workshop is OPEN. Research what ${WORKSHOP_AUDIENCE} are asking about right now${input.brief?.audience ? ` around: ${input.brief.audience}` : ""} — the questions, tools, decisions and frustrations that are live this month.`,
    input.brief?.notes ? `The partner's notes: ${input.brief.notes}` : "",
    "",
    "Find 6–10 specific things: a question people are asking (with where), a tool or change that is",
    "prompting it, a number that shows the scale, a named example of someone doing it well. Each",
    "must come from a real, live page you cite — a forum thread, a survey, a reputable report, a",
    "practitioner's post. Prefer the last ~6 months.",
    "",
    "RULES: a url on every entry (the page that states it) — no url, no entry; one entry per url;",
    "specific beats general; no content farms. Say the month (YYYY-MM) if the page shows one.",
    "",
    'Return ONLY JSON: {"results":[{"fact":"…","source":"…","url":"https://…","date":"YYYY-MM"}]}',
  ].filter((l) => l !== "").join("\n");
}

export function buildWorkshopJudgePrompt(input: { topic: string; notes: readonly WorkshopNote[] }): string {
  return [
    parkerIdentity(),
    "",
    "You are the JUDGE, not the researcher. A web-search model produced the notes below on what",
    `${WORKSHOP_AUDIENCE} are asking about, for a Workshop on: ${input.topic}. Hold each note to`,
    "the brief and return a verdict per note. Be strict: fewer, all sound, beats ten with a stretch.",
    "",
    "KEEP a note only if ALL of these hold:",
    "- It is about what this audience is asking or doing on this topic, or plainly shapes what a",
    "  90-minute working session should teach.",
    "- It is specific: a question as asked, a number, a named tool or example, a stated finding.",
    "- The url plausibly belongs to a page that states it (the source named matches the domain).",
    "- The source is credible for the claim: a forum where these people actually talk, a survey,",
    "  a reputable report, a practitioner's own post. A content farm or an SEO listicle fails.",
    "- Where currency matters, it is from roughly the last 12 months or a live, maintained page.",
    "",
    "NOTES:",
    JSON.stringify(input.notes.map((n) => ({ fact: n.fact, source: n.source, url: n.url, date: n.date })), null, 1),
    "",
    'Return ONLY JSON: {"verdicts":[{"url":"https://…","keep":true,"reason":"one line"}]} — one verdict per note, url copied exactly.',
  ].join("\n");
}

function notesBlock(notes: readonly WorkshopNote[]): string {
  if (notes.length === 0) return "RESEARCH NOTES: none survived the checks. Cite nothing; design from what you know this audience needs and say where a source would strengthen it.";
  return [
    "RESEARCH NOTES — what the audience is asking, from live pages that were checked and judged.",
    "The ONLY URLs you may cite anywhere (a guest facilitator's evidence included) are these:",
    ...notes.map((n, i) => `${i + 1}. ${n.fact}${n.date ? ` (${n.date})` : ""} — ${n.source} — ${n.url}`),
  ].join("\n");
}

/**
 * STAGE 3 — THREE CONCEPTS, ONE CHOSEN. For a SET month, all three are ways to run THAT title —
 * different promises, modes and exercises — and the title is not up for discussion. For an OPEN
 * month, three different topics; the chosen one names the Workshop.
 */
export function buildWorkshopConceptsPrompt(input: { month: string; topic: string; set: boolean; brief: RoomBrief | null; notes: readonly WorkshopNote[]; recentTitles: readonly string[]; guidance?: string }): string {
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";
  return [
    parkerIdentity(),
    "",
    WHAT_A_WORKSHOP_IS,
    methods,
    input.set
      ? [
          `THE ${input.month} WORKSHOP'S TITLE IS SET BY THE PARTNERS AND IS NOT UP FOR DISCUSSION: "${input.topic}".`,
          "Ideate THREE distinct ways to RUN it — three concepts that differ in the PROMISE (what they can do",
          "after 90 minutes), the MODE (teach / do / show / mixed), the central exercise and what they leave",
          "with — compare them, and choose one. Every concept's `title` is the set title, verbatim.",
        ].join("\n")
      : [
          `THE ${input.month} WORKSHOP IS OPEN. Ideate THREE distinct Workshops${input.brief?.audience ? ` around: ${input.brief.audience}` : ""} — three different topics this`,
          "audience is asking about now (use the research notes), compare them, and choose one. The chosen",
          "concept's title names the Workshop.",
        ].join("\n"),
    input.brief?.notes ? `The partner's notes: ${input.brief.notes}` : "",
    "",
    notesBlock(input.notes),
    input.recentTitles.length ? `\nRECENT WORKSHOPS AND ROOMS — do not repeat:\n${input.recentTitles.map((t) => `- ${t}`).join("\n")}` : "",
    "",
    "FOR EACH CONCEPT: title; who_its_for (one line); promise (what they can DO after 90 minutes, one",
    "sentence, concrete); mode (TEACH, DO, SHOW or MIXED); signature_exercise (the one exercise people",
    "will describe afterwards); leave_with (the template/checklist/artifact); facilitator — name, kind",
    "(PARTNER = Sequoia Taylor or Scooter Taylor; GUEST = a named person with evidence_url from the",
    "research notes that shows they do this), why; cost_band ('$0 — free by design' or '$500–1,500 guest fee').",
    "Compare honestly on: who it draws; how much they can actually DO in 90 minutes virtually; whether",
    "the artifact is real; whether the facilitator is credible. CHOOSE ONE and say why it wins.",
    "PUSHBACK: if the topic is off for this audience or this month, say so in `pushback` in plain words",
    "and propose the adjustment. Empty string if none.",
    "",
    "Return ONLY JSON:",
    JSON.stringify({
      concepts: [
        { title: "…", who_its_for: "…", promise: "…", mode: "DO", signature_exercise: "…", leave_with: "…", facilitator: { name: "Sequoia Taylor", kind: "PARTNER", why: "…", evidence_url: null }, cost_band: "$0 — free by design", chosen: true },
      ],
      choice_rationale: "why the chosen one wins, and what the other two lose on",
      pushback: "",
    }, null, 1),
  ].filter((l) => l !== "").join("\n");
}

/**
 * STAGE 5 — THE PACKET for the chosen concept. No venue: the "where" is fixed and the packet's
 * job is the delivery plan on West Peek Live. Sponsors optional. The invitation sequence is three
 * emails for a partner to send; nothing is sent from here.
 */
export function buildWorkshopPacketPrompt(input: {
  month: string;
  topic: string;
  set: boolean;
  brief: RoomBrief | null;
  notes: readonly WorkshopNote[];
  concepts: readonly WorkshopConcept[];
  choiceRationale: string | null;
  pushback: string | null;
  guidance?: string;
}): string {
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";
  const chosen = input.concepts.find((c) => c.chosen) ?? input.concepts[0] ?? null;
  return [
    parkerIdentity(),
    "",
    WHAT_A_WORKSHOP_IS,
    methods,
    `WRITE THE PACKET for the ${input.month} Workshop${input.set ? ` — title SET by the partners: "${input.topic}" (keep it verbatim)` : ""}.`,
    chosen
      ? `THE CHOSEN CONCEPT: "${chosen.title}" — for ${chosen.whoItsFor}. Promise: ${chosen.promise}. Mode: ${chosen.mode}. Signature exercise: ${chosen.signatureMoment}. Leave with: ${chosen.leaveWith}. Facilitator: ${chosen.facilitator.name} (${chosen.facilitator.kind}) — ${chosen.facilitator.why}.`
      : "",
    input.choiceRationale ? `WHY IT WON: ${input.choiceRationale}` : "",
    input.pushback ? `PUSHBACK ALREADY RAISED (carry it): ${input.pushback}` : "",
    input.brief?.notes ? `The partner's notes: ${input.brief.notes}` : "",
    "",
    notesBlock(input.notes),
    "",
    `THE "WHERE" IS FIXED: ${WORKSHOP_WHERE}. Do NOT propose a venue, a city, a room, catering or an`,
    "in-person option. Instead write the DELIVERY PLAN: platform_run_of_show (which segments are on",
    "the live stage and which are breakout exercises, in order), on_screen (slides, screen share, a",
    "shared doc, a timer — what the facilitator needs), join_flow (the join-code invitation flow, in",
    "steps: invite → code → join → breakout assignment), tech_check (one paragraph: when, who, what).",
    "",
    "THE RUN OF SHOW: 90 minutes to the minute, each line with time, minutes, what, who, and",
    "segment STAGE or BREAKOUT. At least two BREAKOUT exercises. exercises: each exercise in one line.",
    "leave_with: the artifact(s) every attendee leaves with, concretely named.",
    "SPONSORSHIP IS OPTIONAL: free = true with a one-line why when it should be free/community; else",
    "free = false with the category that fits and the ask — NEVER a named prospect (that needs",
    "evidence Parker has not researched here; say the category and that research can follow).",
    "promo_one_liner: one sentence to promote it. invitations: exactly 3 emails a partner sends —",
    "n, send_when, subject, body (80–140 words, first person as the facilitator, the join-code step",
    "in the last one). budget_lines: facilitator_fee, production_time, materials — each low/high USD",
    "with basis; $0 lines are fine when true. No venue line, no food, no travel.",
    "risks: 3–5. commitment_md: what keeping it commits the firm to (a date, a facilitator's time, an",
    "invitation to the community). pushback: where the brief is off, or empty.",
    "",
    "Return ONLY JSON:",
    JSON.stringify({
      title: "…", who_its_for: "…", promise: "…", mode: "DO", target_min: 20, target_max: 60,
      run_of_show: [{ time: "12:00 PM", minutes: 10, what: "…", who: "Sequoia (facilitator)", segment: "STAGE" }],
      exercises: ["…"], leave_with: ["…"],
      facilitator: { name: "Sequoia Taylor", kind: "PARTNER", why: "…", evidence_url: null },
      delivery: { platform_run_of_show: ["…"], on_screen: ["…"], join_flow: ["…"], tech_check: "…" },
      sponsorship: { free: true, note: "…", category_fit: null, ask_usd: null },
      promo_one_liner: "…",
      invitations: [{ n: 1, send_when: "10 days before", subject: "…", body: "…" }],
      budget_lines: [{ key: "facilitator_fee", low_usd: 0, high_usd: 0, basis: "…" }, { key: "production_time", low_usd: 400, high_usd: 900, basis: "…" }, { key: "materials", low_usd: 0, high_usd: 200, basis: "…" }],
      risks: ["…"], commitment_md: "…", pushback: "",
    }, null, 1),
  ].filter((l) => l !== "").join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s.replace(/[.,;)]+$/, "") : null;
}
function jsonBody(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
}
function modeOf(v: unknown): WorkshopMode {
  const m = str(v)?.toUpperCase();
  return (WORKSHOP_MODES as readonly string[]).includes(m ?? "") ? (m as WorkshopMode) : "MIXED";
}
function facilitatorOf(v: unknown): WorkshopFacilitator {
  const f = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = str(f.name) ?? "Sequoia Taylor";
  const kind: WorkshopFacilitator["kind"] = str(f.kind)?.toUpperCase() === "GUEST" && !/^(sequoia|scooter) taylor$/i.test(name) ? "GUEST" : "PARTNER";
  return { name, kind, why: str(f.why) ?? "", evidenceUrl: httpUrl(f.evidence_url) };
}

/** No url, no note; one per url. */
export function parseWorkshopNotes(raw: string): WorkshopNote[] {
  const p = jsonBody(raw);
  const out: WorkshopNote[] = [];
  for (const r of list(p?.results)) {
    const fact = str(r.fact);
    const url = httpUrl(r.url);
    if (!fact || !url) continue;
    if (out.some((o) => o.url.toLowerCase() === url.toLowerCase())) continue;
    out.push({ fact, source: str(r.source) ?? new URL(url).hostname, url, date: str(r.date) });
  }
  return out;
}

export function parseWorkshopVerdicts(raw: string): Map<string, { keep: boolean; reason: string }> {
  const p = jsonBody(raw);
  const out = new Map<string, { keep: boolean; reason: string }>();
  for (const r of list(p?.verdicts)) {
    const url = httpUrl(r.url);
    if (!url) continue;
    out.set(url.toLowerCase(), { keep: r.keep === true, reason: str(r.reason) ?? "no reason given" });
  }
  return out;
}

/**
 * Three concepts, exactly one chosen. For a SET month every title is forced to the set title — a
 * model that "improves" a title the partners decided is corrected, not obeyed.
 */
export function parseWorkshopConcepts(raw: string, setTitle: string | null): { concepts: WorkshopConcept[]; choiceRationale: string | null; pushback: string | null } | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const concepts: WorkshopConcept[] = [];
  for (const c of list(p.concepts)) {
    const title = setTitle ?? str(c.title);
    if (!title) continue;
    const promise = str(c.promise) ?? "";
    const mode = modeOf(c.mode);
    const leaveWith = str(c.leave_with) ?? "";
    const facilitator = facilitatorOf(c.facilitator);
    concepts.push({
      title,
      format: "WORKSHOP",
      premise: promise,
      tone: mode.toLowerCase(),
      valueToSponsor: leaveWith,
      whoItFits: str(c.who_its_for) ?? "",
      costBand: str(c.cost_band) ?? "$0 — free by design",
      signatureMoment: str(c.signature_exercise) ?? "",
      venueDirection: WORKSHOP_WHERE,
      chosen: c.chosen === true,
      whoItsFor: str(c.who_its_for) ?? "",
      promise,
      mode,
      leaveWith,
      facilitator,
    });
  }
  if (concepts.length === 0) return null;
  const firstChosen = concepts.findIndex((c) => c.chosen);
  concepts.forEach((c, i) => { c.chosen = i === (firstChosen === -1 ? 0 : firstChosen); });
  return { concepts: concepts.slice(0, 3), choiceRationale: str(p.choice_rationale), pushback: str(p.pushback) };
}

export function parseWorkshopPacket(raw: string, setTitle: string | null): WorkshopPacket | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const title = setTitle ?? str(p.title);
  const promise = str(p.promise);
  if (!title || !promise) return null;
  const runOfShow: WorkshopRunOfShowLine[] = list(p.run_of_show)
    .map((l) => ({ time: str(l.time) ?? "", minutes: num(l.minutes) ?? 0, what: str(l.what) ?? "", who: str(l.who) ?? "", segment: (str(l.segment)?.toUpperCase() === "BREAKOUT" ? "BREAKOUT" : "STAGE") as "STAGE" | "BREAKOUT" }))
    .filter((l) => l.time && l.what);
  const d = (p.delivery && typeof p.delivery === "object" ? p.delivery : {}) as Record<string, unknown>;
  const s = (p.sponsorship && typeof p.sponsorship === "object" ? p.sponsorship : {}) as Record<string, unknown>;
  const sponsorship: WorkshopSponsorship = {
    free: s.free !== false,
    note: str(s.note) ?? (s.free !== false ? "Free by design — a community session." : ""),
    categoryFit: s.free === false ? str(s.category_fit) : null,
    askUsd: s.free === false ? num(s.ask_usd) : null,
  };
  const keys: WorkshopBudgetKey[] = ["facilitator_fee", "production_time", "materials"];
  const budgetLines = list(p.budget_lines)
    .map((l) => ({ key: str(l.key) as WorkshopBudgetKey, lowUsd: num(l.low_usd) ?? 0, highUsd: num(l.high_usd) ?? 0, basis: str(l.basis) ?? "" }))
    .filter((l) => keys.includes(l.key));
  return {
    title,
    topic: title,
    whoItsFor: str(p.who_its_for) ?? WORKSHOP_AUDIENCE,
    promise,
    mode: modeOf(p.mode),
    targetMin: num(p.target_min) ?? 20,
    targetMax: num(p.target_max) ?? 60,
    runOfShow,
    exercises: strings(p.exercises),
    leaveWith: strings(p.leave_with),
    facilitator: facilitatorOf(p.facilitator),
    delivery: {
      where: WORKSHOP_WHERE,
      platformRunOfShow: strings(d.platform_run_of_show),
      onScreen: strings(d.on_screen),
      joinFlow: strings(d.join_flow),
      techCheck: str(d.tech_check) ?? "",
    },
    sponsorship,
    promoOneLiner: str(p.promo_one_liner) ?? "",
    invitations: list(p.invitations)
      .map((i, n) => ({ n: num(i.n) ?? n + 1, sendWhen: str(i.send_when) ?? "", subject: str(i.subject) ?? "", body: str(i.body) ?? "" }))
      .filter((i) => i.subject && i.body)
      .slice(0, 3),
    budgetLines,
    risks: strings(p.risks),
    commitmentMd: str(p.commitment_md),
    pushback: str(p.pushback),
    conceptChoiceMd: str(p.concept_choice_md),
  };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * The rules the prompt asked for, made safe afterwards: no venue anywhere (a model that offered one
 * has it removed and the packet says so), only judged URLs, a guest facilitator without judged
 * evidence becomes a partner-led session with the guest named as an idea, the length is 90.
 */
export function verifyWorkshopPacket(packet: WorkshopPacket, judgedUrls: readonly string[], raw?: string): { packet: WorkshopPacket; flags: WorkshopFlag[] } {
  const flags: WorkshopFlag[] = [];
  const allowed = new Set(judgedUrls.map((u) => u.toLowerCase()));
  const out: WorkshopPacket = { ...packet, delivery: { ...packet.delivery, where: WORKSHOP_WHERE } };

  if (raw && /"venues?"\s*:\s*\[\s*\{/.test(raw)) flags.push({ code: "venue_removed", detail: "the model offered a venue; a Workshop is virtual on West Peek Live and the venue was removed" });

  const stripUrls = (s: string): string =>
    s.replace(/https?:\/\/[^\s)\]"'<>]+/g, (u) => {
      if (allowed.has(u.replace(/[.,;)]+$/, "").toLowerCase())) return u;
      flags.push({ code: "unjudged_url_removed", detail: `${u} was not among the checked sources and was removed` });
      return "[link removed: not a checked source]";
    });
  out.promise = stripUrls(out.promise);
  out.promoOneLiner = stripUrls(out.promoOneLiner);
  out.exercises = out.exercises.map(stripUrls);
  out.leaveWith = out.leaveWith.map(stripUrls);
  out.invitations = out.invitations.map((i) => ({ ...i, body: stripUrls(i.body) }));
  out.runOfShow = out.runOfShow.map((l) => ({ ...l, what: stripUrls(l.what) }));
  out.delivery = { ...out.delivery, platformRunOfShow: out.delivery.platformRunOfShow.map(stripUrls), onScreen: out.delivery.onScreen.map(stripUrls), joinFlow: out.delivery.joinFlow.map(stripUrls), techCheck: stripUrls(out.delivery.techCheck) };

  if (out.facilitator.kind === "GUEST") {
    const ok = out.facilitator.evidenceUrl && allowed.has(out.facilitator.evidenceUrl.toLowerCase());
    if (!ok) {
      flags.push({ code: "guest_without_evidence", detail: `${out.facilitator.name} was proposed as a guest facilitator without a checked page showing they do this; the session is partner-led with them named as an idea` });
      out.facilitator = { name: "Sequoia Taylor", kind: "PARTNER", why: `Partner-led. Guest idea to verify: ${out.facilitator.name} — ${out.facilitator.why}`.slice(0, 400), evidenceUrl: null };
    }
  }
  if (out.runOfShow.length === 0) flags.push({ code: "no_run_of_show", detail: "no run of show was written" });
  if (out.leaveWith.length === 0) flags.push({ code: "no_leave_with", detail: "the packet does not say what attendees leave with" });
  if (out.invitations.length < 3) flags.push({ code: "no_invitations", detail: `${out.invitations.length} invitation email(s) drafted; the sequence is three` });
  const minutes = out.runOfShow.reduce((n, l) => n + (l.minutes || 0), 0);
  if (minutes > 0 && Math.abs(minutes - WORKSHOP_LENGTH_MINUTES) > 15) flags.push({ code: "length_off", detail: `the run of show adds up to ${minutes} minutes; a Workshop is ${WORKSHOP_LENGTH_MINUTES}` });
  return { packet: out, flags };
}

// ── The money ────────────────────────────────────────────────────────────────

/** Facilitator fee + production time (+ materials, + 10%). No venue, no F&B, no room hire — ever. */
export function computeWorkshopEconomics(packet: Pick<WorkshopPacket, "budgetLines" | "sponsorship">): WorkshopEconomics {
  const given = new Map(packet.budgetLines.map((l) => [l.key, l]));
  const defaults: Record<Exclude<WorkshopBudgetKey, "contingency">, { low: number; high: number; basis: string }> = {
    facilitator_fee: { low: 0, high: 0, basis: "partner-led; no fee" },
    production_time: { low: 400, high: 900, basis: "rule of thumb: 6–12 hours of prep, run and follow-up at an operator's rate" },
    materials: { low: 0, high: 200, basis: "rule of thumb: the template and checklist, designed once" },
  };
  const lines: WorkshopBudgetLine[] = [];
  for (const key of ["facilitator_fee", "production_time", "materials"] as const) {
    const g = given.get(key);
    const d = defaults[key];
    lines.push({ key, label: WORKSHOP_BUDGET_LABELS[key], lowUsd: g ? g.lowUsd : d.low, highUsd: g ? g.highUsd : d.high, basis: g?.basis || d.basis });
  }
  const subLow = lines.reduce((n, l) => n + l.lowUsd, 0);
  const subHigh = lines.reduce((n, l) => n + l.highUsd, 0);
  lines.push({ key: "contingency", label: WORKSHOP_BUDGET_LABELS.contingency, lowUsd: Math.round(subLow * 0.1), highUsd: Math.round(subHigh * 0.1), basis: "10% of everything above" });
  const estimatedCostLowUsd = Math.round(subLow * 1.1);
  const estimatedCostHighUsd = Math.round(subHigh * 1.1);
  const sponsorshipUsd = packet.sponsorship.free ? 0 : Math.max(0, packet.sponsorship.askUsd ?? 0);
  return {
    kind: "WORKSHOP",
    lines,
    estimatedCostLowUsd,
    estimatedCostHighUsd,
    free: packet.sponsorship.free,
    sponsorshipUsd,
    keepUsd: sponsorshipUsd - estimatedCostHighUsd,
  };
}

// ── Text ─────────────────────────────────────────────────────────────────────

const usd = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);

export function parkerWorkshopIntroduction(): string[] {
  return [
    "I'm Parker, West Peek's Event Marketing Coordinator. I build the firm's monthly Workshops end to end — what the audience is asking this month, three ways to run it compared, the run of show with its exercises, the delivery plan on West Peek Live, the invitations — and hand you a packet you can act on.",
    "This is the Workshop of the month. It is virtual on West Peek Live; nothing is scheduled and nobody outside the firm has been contacted.",
  ];
}

/** The packet as plain text — under the rule in the email, and what a partner can forward. */
export function renderWorkshopText(input: { title: string; month: string; monthWord: string; documentId: string | null; brief: RoomBrief | null; concepts: readonly WorkshopConcept[]; conceptChoiceMd: string | null; pushback: string | null; view: WorkshopView; risks: readonly string[]; commitmentMd: string | null }): string {
  const v = input.view;
  const eco = v.economics;
  const chosen = input.concepts.find((c) => c.chosen);
  const others = input.concepts.filter((c) => !c.chosen);
  const lines: string[] = [
    ...parkerWorkshopIntroduction(),
    "",
    `${input.title} — the ${input.monthWord} Workshop${v.topicSet ? " (title set by the partners)" : ""}`,
    input.documentId ? `Download the packet (PDF): https://os.joinwestpeek.com/api/documents/${input.documentId}/download` : "",
    "",
    input.brief?.notes ? `WHAT WAS ASKED FOR\n${input.brief.audience}${input.brief.notes ? `\nNotes: ${input.brief.notes}` : ""}\n` : "",
    input.pushback ? `WHERE I PUSH BACK\n${input.pushback}\n` : "",
    `WHO IT IS FOR\n${v.whoItsFor}`,
    "",
    `THE PROMISE — what they can do after 90 minutes\n${v.promise}`,
    "",
    `THE CONCEPT — ${chosen?.title ?? input.title} (${v.mode.toLowerCase()})${input.conceptChoiceMd ? `\nWhy it won: ${input.conceptChoiceMd}` : ""}${others.length ? `\nAlso considered: ${others.map((c) => `${c.title} — ${c.promise}`).join("; ")}` : ""}`,
    "",
    `FACILITATOR\n${v.facilitator.name} (${v.facilitator.kind === "PARTNER" ? "partner" : "guest"}) — ${v.facilitator.why}${v.facilitator.evidenceUrl ? ` — ${v.facilitator.evidenceUrl}` : ""}`,
    "",
    "RUN OF SHOW — 90 minutes",
    ...(v.runOfShow.length ? v.runOfShow.map((l) => `${l.time}${l.minutes ? ` (${l.minutes} min)` : ""} — ${l.segment === "BREAKOUT" ? "BREAKOUT: " : ""}${l.what}${l.who ? ` — ${l.who}` : ""}`) : ["No run of show written."]),
    "",
    "EXERCISES",
    ...(v.exercises.length ? v.exercises.map((e) => `- ${e}`) : ["- none written"]),
    "",
    "WHAT THEY LEAVE WITH",
    ...(v.leaveWith.length ? v.leaveWith.map((e) => `- ${e}`) : ["- not stated"]),
    "",
    `WHERE — ${WORKSHOP_WHERE}`,
    "Platform run of show:",
    ...v.delivery.platformRunOfShow.map((s) => `- ${s}`),
    "On screen:",
    ...v.delivery.onScreen.map((s) => `- ${s}`),
    "Join flow:",
    ...v.delivery.joinFlow.map((s, i) => `${i + 1}. ${s}`),
    v.delivery.techCheck ? `Tech check: ${v.delivery.techCheck}` : "",
    "",
    `PROMO LINE\n${v.promoOneLiner || "—"}`,
    "",
    "INVITATIONS — three emails, yours to send",
    ...v.invitations.flatMap((i) => [`${i.n}. ${i.sendWhen} — Subject: ${i.subject}`, ...i.body.split("\n").map((b) => `   ${b}`), ""]),
    "SPONSORSHIP",
    v.sponsorship.free ? `Free by design. ${v.sponsorship.note}` : `A sponsor fits: ${v.sponsorship.categoryFit ?? "category not stated"}, ask ${usd(v.sponsorship.askUsd)}. ${v.sponsorship.note} (No prospect is named without evidence; sponsor research can follow.)`,
    "",
    "BUDGET",
    ...eco.lines.map((l) => `- ${l.label}: ${usd(l.lowUsd)}–${usd(l.highUsd)} — ${l.basis}`),
    `Total ${usd(eco.estimatedCostLowUsd)}–${usd(eco.estimatedCostHighUsd)}.${eco.free ? " Carried by the firm as community work." : ` Sponsorship ${usd(eco.sponsorshipUsd)}; the firm keeps ${usd(eco.keepUsd)} at the high case.`}`,
    "",
    v.notes.length ? `WHAT THE AUDIENCE IS ASKING (sources checked and judged)\n${v.notes.map((n) => `- ${n.fact} — ${n.url}`).join("\n")}` : "",
    "",
    "RISKS",
    ...(input.risks.length ? input.risks.map((r) => `- ${r}`) : ["- none stated"]),
    "",
    "WHAT SAYING KEEP COMMITS THE FIRM TO",
    input.commitmentMd ?? "Parker did not say — decide before you keep it.",
    "",
    "Keep it or dismiss it: https://os.joinwestpeek.com/#/rooms",
    "— Parker, via West Peek OS. Virtual on West Peek Live; nothing is scheduled and nobody outside the firm has been contacted.",
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}
