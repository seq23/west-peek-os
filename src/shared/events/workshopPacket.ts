import { personaPrompt } from "../registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";
import type { RoomBrief, RoomConcept, RunOfShowLine } from "./roomPacket";
import {
  ANGLE_KINDS,
  MONTHLY_PLAN,
  WORKSHOP_SERIES,
  angleKindOf,
  angleRules,
  planFor,
  plannedSubjectsNear,
  sameSubject,
  topicFor,
  type AngleKind,
} from "./monthlyPlan";

export { WORKSHOP_SERIES };

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
 * THE SERIES ON THE RECORD — now DERIVED from `MONTHLY_PLAN` (17 Sep 2026).
 *
 * This used to be the list. It is now a view of the one list, because the plan has to say four
 * things this record could not: a month the partners set, a month Parker picks himself, a month
 * somebody OUTSIDE the firm is running, and a month with no session at all. A second copy here
 * would be the "two components each keeping their own list with no link" defect, and the link is
 * exactly what adjacency depends on — it has to be able to read the externally hosted month.
 */
export function setWorkshopTitle(month: string): string | null {
  return WORKSHOP_SERIES[month] ?? null;
}

export const WORKSHOP_WHERE = "Virtual · West Peek Live";

/**
 * HOW LONG A WORKSHOP IS — 45 minutes to an hour, never 90 (17 Sep 2026).
 *
 * It was `WORKSHOP_LENGTH_MINUTES = 90`, and the number 90 was ALSO typed into seven places in the
 * prose Parker is given, the run-of-show instruction, the verifier's message, the packet text, the
 * PDF and the page. That is how it drifted: the constant was one of eight copies, so changing it
 * changed nothing a model ever read.
 *
 * Expressed as a RANGE, because she gave a range, and every piece of prose below now interpolates
 * `WORKSHOP_LENGTH_RANGE` rather than repeating a literal. A hardcoded duration in prose is the
 * defect, not the wrong number.
 */
export const WORKSHOP_LENGTH_MIN_MINUTES = 45;
export const WORKSHOP_LENGTH_MAX_MINUTES = 60;
export const WORKSHOP_LENGTH_RANGE = `${WORKSHOP_LENGTH_MIN_MINUTES}–${WORKSHOP_LENGTH_MAX_MINUTES} minutes`;
/** The audience a Workshop is for by default; the brief's audience narrows it. */
export const WORKSHOP_AUDIENCE = "small-business owners, solopreneurs and community builders";

export type WorkshopMode = "TEACH" | "DO" | "SHOW" | "MIXED";
export const WORKSHOP_MODES: readonly WorkshopMode[] = ["TEACH", "DO", "SHOW", "MIXED"];

/**
 * A Workshop concept — which is an ANGLE on the month's one topic, never a topic of its own.
 *
 * `title` is the angle's NAME. The subject lives on the packet, once, in `topic`. A concept has no
 * field that can hold a different subject, which is the structural half of item 2; `angleOn` is the
 * checked half — the model must copy the topic into it, and three different values is three
 * subjects, which is rejected rather than stored.
 */
export interface WorkshopConcept extends RoomConcept {
  /** Who it is for, in one line. */
  whoItsFor: string;
  /** What they can DO in the session. */
  promise: string;
  mode: WorkshopMode;
  /** The template, checklist or artifact every attendee leaves with. */
  leaveWith: string;
  facilitator: WorkshopFacilitator;
  /** The co-host beside the host. A co-host is the NORM, not the exception. */
  coHost: WorkshopFacilitator | null;
  /** The month's topic, copied by the model. Every concept's must be the same, or the answer is discarded. */
  angleOn: string;
  /** What this angle varies: the name, the framing, the format, the venue, the experience, the cut of the audience. */
  angleKind: AngleKind;
}

/**
 * WHO RUNS IT. Scooter hosts by default, usually with a co-host (17 Sep 2026).
 *
 * Parker defaulted this to Sequoia, which is simply wrong about who does the work: Scooter is the
 * host. The default is named as a constant rather than typed into the parser, the prompt and the
 * verifier separately — the same drift that put "90 minutes" in eight places.
 */
export const WORKSHOP_DEFAULT_HOST = "Scooter Taylor";
export const WORKSHOP_PARTNERS = ["Scooter Taylor", "Sequoia Taylor"] as const;

export interface WorkshopFacilitator {
  /** "Scooter Taylor", "Sequoia Taylor", or a named guest. */
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

/**
 * THE MONEY, AFTER THE CONTRADICTION WAS TAKEN OUT OF IT (17 Sep 2026).
 *
 * Operator: "we should always try to find a small sponsor for a workshop even if we dont use them
 * since its free to put them on. but suggest a small sponsor is always fine."
 *
 * Two statements that only LOOK like they disagree, and the old shape made them disagree in the
 * copy. `free: boolean` meant BOTH "attendance costs nothing" and "no sponsor is sought", so a
 * packet could say "Free by design — no sponsor sought" on the same page as a sponsor suggestion,
 * or suppress the suggestion entirely to stay consistent with itself. One boolean, two questions.
 *
 * They are now two fields and neither can contradict the other:
 *   · attendance is free — an INVARIANT, forced true by the verifier, never a model's choice;
 *   · a small sponsor is SUGGESTED on every packet — expected output, optional to act on, and
 *     costing nothing to have suggested, which is her whole point.
 */
export interface WorkshopEconomics {
  kind: "WORKSHOP";
  lines: WorkshopBudgetLine[];
  estimatedCostLowUsd: number;
  estimatedCostHighUsd: number;
  /** ALWAYS true. Attendance is free by design; a Workshop is never ticketed. */
  attendanceFree: true;
  /** The SUGGESTED small ask, if one was suggested. Nothing has been sold and nobody approached. */
  suggestedSponsorshipUsd: number;
  /** What that suggestion would cover of the high-case cost, if the firm chose to use it. */
  wouldCoverUsd: number;
}

export interface WorkshopSuggestedSponsor {
  /** The CATEGORY that fits. Never a named prospect — that needs evidence Parker has not researched. */
  categoryFit: string;
  /** A small ask. Null when Parker gave a category but no number. */
  askUsd: number | null;
  /** Why this category fits this audience and this topic. */
  why: string;
}

export interface WorkshopSponsorship {
  /** INVARIANT: attendance is free, always, by design. The verifier forces it; a model cannot set it. */
  attendanceFree: true;
  /** Expected on EVERY packet. Null only when Parker failed to suggest one, which is flagged. */
  suggested: WorkshopSuggestedSponsor | null;
  /** One line on the posture: free to attend, and what a sponsor would be for. */
  note: string;
}

/**
 * Stored Workshop JSON written before 17 Sep 2026 carries `{ free, categoryFit, askUsd }`. A page
 * that crashed on an older row would be a worse bug than the one being fixed, so the old shape is
 * read forward here rather than migrated — one function, at the one place stored JSON re-enters.
 */
export function normaliseSponsorship(raw: unknown): WorkshopSponsorship {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (s.attendanceFree === true || s.suggested !== undefined) {
    const sug = (s.suggested && typeof s.suggested === "object" ? s.suggested : null) as Record<string, unknown> | null;
    return {
      attendanceFree: true,
      suggested: sug && str(sug.categoryFit)
        ? { categoryFit: str(sug.categoryFit)!, askUsd: num(sug.askUsd), why: str(sug.why) ?? "" }
        : null,
      note: str(s.note) ?? "",
    };
  }
  const legacyCategory = str(s.categoryFit);
  return {
    attendanceFree: true,
    suggested: legacyCategory ? { categoryFit: legacyCategory, askUsd: num(s.askUsd), why: str(s.note) ?? "" } : null,
    note: str(s.note) ?? "Free to attend by design.",
  };
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
  /** The co-host beside the host. A co-host is the norm; null is the exception and is said out loud. */
  coHost: WorkshopFacilitator | null;
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
  code:
    | "venue_removed"
    | "unjudged_url_removed"
    | "guest_without_evidence"
    | "no_run_of_show"
    | "no_leave_with"
    | "no_invitations"
    | "length_off"
    /** Parker did not suggest a sponsor. Suggesting one is expected on every packet — it is free. */
    | "no_sponsor_suggested"
    /** Parker did not name a co-host. A co-host is the norm, so its absence is reported, not silent. */
    | "no_co_host";
  detail: string;
}

/** What is stored in `evt_room_packet.workshop_json` and read by the page, the text and the PDF. */
export interface WorkshopView {
  /** THE MONTH'S ONE SUBJECT. The packet holds exactly one, which is why it cannot hold three. */
  topic: string;
  /** Who decided the topic: a partner handed it over, or Parker chose it because nobody had. */
  topicSetBy: "PARTNERS" | "PARKER";
  whoItsFor: string;
  promise: string;
  mode: WorkshopMode;
  runOfShow: WorkshopRunOfShowLine[];
  exercises: string[];
  leaveWith: string[];
  facilitator: WorkshopFacilitator;
  coHost: WorkshopFacilitator | null;
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

/**
 * THE MONTH'S ONE TOPIC, AND WHO SET IT — resolved BEFORE any ideation happens.
 *
 * This is the structural half of "one topic a month, several angles inside it". The topic is not
 * something the concepts stage produces and then three of them compete over: it is settled here,
 * from the plan or from what a human typed, and the concepts are handed it. When nobody has set
 * one, `topic` comes back null and Parker picks it himself in the concepts call — he never waits,
 * never blocks and is never asked which situation he is in, because the two paths differ only by
 * whether this function returns a string.
 */
export function workshopTopic(
  month: string,
  brief: RoomBrief | null,
): { topic: string | null; set: boolean; setBy: "PARTNERS" | "PARKER"; steer: string | null } {
  const resolved = topicFor(month, "WORKSHOP", brief?.audience ?? null);
  return { topic: resolved.topic, set: resolved.setBy === "PARTNERS", setBy: resolved.setBy, steer: resolved.steer };
}

/** True when the plan says somebody outside the firm is running that month — Parker builds nothing. */
export function workshopIsExternal(month: string): boolean {
  return planFor(month, "WORKSHOP")?.status === "EXTERNAL";
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function parkerIdentity(): string {
  return personaPrompt("Parker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")?.role ?? "AI employee");
}

/**
 * WHAT A WORKSHOP IS, derived from the constants rather than restating them.
 *
 * Every number and name in here is interpolated. That is the whole point of the rewrite: the last
 * version typed "90 minutes" into this paragraph and into six other strings, so the constant was
 * decoration and the prose was the truth.
 */
const WHAT_A_WORKSHOP_IS = [
  `A West Peek Workshop is a ${WORKSHOP_LENGTH_RANGE} VIRTUAL working session on West Peek Live — a live stage for`,
  "the facilitator, attendee join by code, chat, hand-raise, and breakouts for exercises — for",
  `${WORKSHOP_AUDIENCE}. The promise is what they can DO by the end, not what they will have heard.`,
  "Teach / do / show: a short teach, a real exercise in breakouts, a show-and-tell back on stage.",
  "Every attendee leaves with an artifact — a template, a checklist, a filled-in worksheet.",
  "It runs monthly beside the Room and the Community Mastermind.",
  "",
  `WHO RUNS IT: ${WORKSHOP_DEFAULT_HOST} hosts. A CO-HOST is the norm, not the exception — name one`,
  `(the other partner, or a credible guest) and say what each of them carries. ${WORKSHOP_PARTNERS[1]} co-hosts`,
  "when the topic is hers; a guest co-host needs a live page from the research notes showing they do this.",
  "",
  "THE MONEY, AND THE TWO HALVES OF IT DO NOT CONTRADICT EACH OTHER:",
  "- ATTENDANCE IS FREE. Always, by design. A Workshop is never ticketed and you never propose that it is.",
  "- AND YOU ALWAYS SUGGEST A SMALL SPONSOR ANYWAY. In the partner's words: \"we should always try to",
  "  find a small sponsor for a workshop even if we dont use them since its free to put them on.\"",
  "  So every packet carries a suggested sponsor CATEGORY and a small ask. It costs nothing to have",
  "  suggested, the firm may simply not use it, and a packet without one is an incomplete packet.",
  "  NEVER name a company as a prospect — the category and the ask, with why it fits.",
].join("\n");

/**
 * STAGE 1 — what the audience is asking about this month. Run on the search model; every note
 * carries the URL of the page that says it; every URL is checked live and then JUDGED.
 */
export function buildWorkshopDiscoveryPrompt(input: { month: string; topic: string | null; set: boolean; brief: RoomBrief | null }): string {
  return [
    parkerIdentity(),
    "",
    WHAT_A_WORKSHOP_IS,
    "",
    input.topic
      ? `The ${input.month} Workshop's TOPIC is "${input.topic}"${input.set ? " — set by the partners" : ""}. Research what ${WORKSHOP_AUDIENCE} are asking about THIS right now — so the session teaches the questions they actually have, and so you have several ANGLES to choose between.`
      : `Nobody has set a topic for the ${input.month} Workshop, so you will choose one. Research what ${WORKSHOP_AUDIENCE} are asking about right now${input.brief?.notes ? ` around: ${input.brief.notes}` : ""} — the questions, tools, decisions and frustrations that are live this month — so the topic you pick is new and fresh rather than a repeat.`,
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
    `  ${WORKSHOP_LENGTH_RANGE} working session should teach.`,
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
 * ADJACENCY, AND WHY IT READS WHAT RAN RATHER THAN WHAT WAS PROPOSED.
 *
 * Operator: "adjacency is a light rule. for one month. and just make sure they are not too
 * similar." One month back, soft.
 *
 * The trap it had to be built around: October's Workshop is hosted by somebody outside the firm and
 * is about content creation. Parker's own October packet — an AI back-office idea — was DECLINED.
 * An adjacency rule reading his proposals would make November avoid a dead idea and walk straight
 * into the subject that is actually being run. So `ran` is the caller's list of what really
 * happened (kept packets, calendared events) and the plan contributes the externally hosted month,
 * which the record here cannot know about because it was never a packet in this system.
 */
function adjacencyBlock(month: string, ran: readonly { month: string; topic: string; note: string }[]): string {
  const all = [...plannedSubjectsNear(month, "WORKSHOP"), ...ran]
    .filter((r, i, xs) => xs.findIndex((y) => sameSubject(y.topic, r.topic)) === i);
  if (all.length === 0) return "";
  return [
    "",
    "WHAT ACTUALLY RAN LAST MONTH — a LIGHT rule, one month back: do not propose a topic that is",
    "nearly the same as one of these. Adjacent is fine; near-identical is not. This is what RAN,",
    "not what was proposed, so a declined idea is not on it and a session somebody else hosted is.",
    ...all.map((r) => `- ${r.month}: ${r.topic} (${r.note})`),
  ].join("\n");
}

/**
 * STAGE 3 — ONE TOPIC, THREE ANGLES, ONE CHOSEN.
 *
 * The shape that replaced "three concepts compared". The topic is either handed in (a partner set
 * it, or typed it) or chosen by Parker in this same call — and once chosen it is the ONE subject
 * every angle is on. Both paths run without a human present.
 */
export function buildWorkshopConceptsPrompt(input: {
  month: string;
  topic: string | null;
  set: boolean;
  setBy: "PARTNERS" | "PARKER";
  steer: string | null;
  brief: RoomBrief | null;
  notes: readonly WorkshopNote[];
  ran: readonly { month: string; topic: string; note: string }[];
  guidance?: string;
}): string {
  const methods = input.guidance && input.guidance.trim().length > 0 ? `\n${input.guidance}\n` : "";
  const known = input.topic;
  return [
    parkerIdentity(),
    "",
    WHAT_A_WORKSHOP_IS,
    methods,
    known
      ? angleRules({ topic: known, stream: "WORKSHOP", setBy: input.setBy })
      : [
          `NOBODY HAS SET A TOPIC FOR THE ${input.month} WORKSHOP, SO YOU CHOOSE ONE. Do not ask, do not wait,`,
          "do not propose alternatives to choose between. Pick the ONE subject this audience needs now —",
          "something NEW and fresh, grounded in the research notes below — name it in `topic`, and then give",
          "THREE ANGLES ON THAT ONE SUBJECT.",
          "",
          "An angle varies the NAME, the FRAMING, the FORMAT, the VENUE, the EXPERIENCE or which cut of the",
          "audience it is aimed at. An angle NEVER varies what the session is about.",
          "",
          "The partner's own example, verbatim: \"Black lawyers is a topic. Community is a topic. but angles",
          "are things like names / venues / type of event and for workshops the angles can be 'Community as",
          "a Service' the new model OR How to find your Brand's community.\"",
          "",
          "EVERY concept MUST carry `angle_on` set to the topic you chose, copied EXACTLY, and `angle_kind`",
          `from ${ANGLE_KINDS.join(" / ")}. Three different \`angle_on\` values is three subjects, and the whole`,
          "answer is DISCARDED and asked for again.",
        ].join("\n"),
    input.steer ? `\nWHAT THE PARTNERS WANT OUT OF THE ANGLES, in their words:\n${input.steer}` : "",
    input.brief?.notes ? `The partner's notes: ${input.brief.notes}` : "",
    "",
    notesBlock(input.notes),
    adjacencyBlock(input.month, input.ran),
    "",
    "FOR EACH ANGLE: title (the NAME of this angle — catchy, something a person could be invited to);",
    "angle_on (the topic, copied exactly); angle_kind; who_its_for (one line); promise (what they can DO",
    `by the end of ${WORKSHOP_LENGTH_RANGE}, one sentence, concrete); mode (TEACH, DO, SHOW or MIXED);`,
    "signature_exercise (the one exercise people will describe afterwards); leave_with (the",
    `template/checklist/artifact); facilitator — name, kind (PARTNER = ${WORKSHOP_PARTNERS.join(" or ")};`,
    "GUEST = a named person with evidence_url from the research notes that shows they do this), why;",
    `co_host — the same shape, and name one: a co-host is the norm. Default host is ${WORKSHOP_DEFAULT_HOST}.`,
    "cost_band ('$0 to attend — free by design').",
    "Compare honestly on: who each NAME and FRAMING draws; how much they can actually DO in",
    `${WORKSHOP_LENGTH_RANGE} virtually; whether the artifact is real; whether the hosts are credible.`,
    "CHOOSE ONE and say why it wins.",
    "PUSHBACK: if the topic is off for this audience or this month, say so in `pushback` in plain words",
    "and propose the adjustment. Empty string if none.",
    "",
    "Return ONLY JSON:",
    JSON.stringify({
      topic: known ?? "the one subject you chose",
      concepts: [
        {
          title: "the name of this angle", angle_on: known ?? "the one subject you chose", angle_kind: "NAME",
          who_its_for: "…", promise: "…", mode: "DO", signature_exercise: "…", leave_with: "…",
          facilitator: { name: WORKSHOP_DEFAULT_HOST, kind: "PARTNER", why: "…", evidence_url: null },
          co_host: { name: WORKSHOP_PARTNERS[1], kind: "PARTNER", why: "…", evidence_url: null },
          cost_band: "$0 to attend — free by design", chosen: true,
        },
      ],
      choice_rationale: "why the chosen angle wins, and what the other two lose on",
      pushback: "",
    }, null, 1),
  ].filter((l) => l !== "").join("\n");
}

/**
 * STAGE 5 — THE PACKET for the chosen angle. No venue: the "where" is fixed and the packet's job is
 * the delivery plan on West Peek Live. The invitation sequence is three emails for a partner to
 * send; nothing is sent from here.
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
    `WRITE THE PACKET for the ${input.month} Workshop. THE TOPIC IS "${input.topic}"${input.set ? " — set by the partners; keep it verbatim" : " — you chose it; it is now fixed"}.`,
    chosen
      ? `THE CHOSEN ANGLE: "${chosen.title}" (${chosen.angleKind.toLowerCase()}) — for ${chosen.whoItsFor}. Promise: ${chosen.promise}. Mode: ${chosen.mode}. Signature exercise: ${chosen.signatureMoment}. Leave with: ${chosen.leaveWith}. Host: ${chosen.facilitator.name} (${chosen.facilitator.kind}) — ${chosen.facilitator.why}.${chosen.coHost ? ` Co-host: ${chosen.coHost.name} (${chosen.coHost.kind}) — ${chosen.coHost.why}.` : ""}`
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
    `THE RUN OF SHOW: ${WORKSHOP_LENGTH_RANGE} to the minute — the total must land inside that range —`,
    "each line with time, minutes, what, who, and segment STAGE or BREAKOUT. At least two BREAKOUT",
    "exercises. exercises: each exercise in one line.",
    "leave_with: the artifact(s) every attendee leaves with, concretely named.",
    `facilitator: the HOST (default ${WORKSHOP_DEFAULT_HOST}). co_host: name one — a co-host is the norm.`,
    "sponsorship: attendance is ALWAYS free, and you ALWAYS suggest a small sponsor anyway —",
    "suggested.category_fit (a CATEGORY, never a named company), suggested.ask_usd (small), suggested.why,",
    "and note (one line: free to attend, and what a sponsor would be for).",
    "promo_one_liner: one sentence to promote it. invitations: exactly 3 emails a partner sends —",
    "n, send_when, subject, body (80–140 words, first person as the host, the join-code step",
    "in the last one). budget_lines: facilitator_fee, production_time, materials — each low/high USD",
    "with basis; $0 lines are fine when true. No venue line, no food, no travel.",
    "risks: 3–5. commitment_md: what keeping it commits the firm to (a date, the hosts' time, an",
    "invitation to the community). pushback: where the brief is off, or empty.",
    "",
    "Return ONLY JSON:",
    JSON.stringify({
      title: "…", who_its_for: "…", promise: "…", mode: "DO", target_min: 20, target_max: 60,
      run_of_show: [{ time: "12:00 PM", minutes: 10, what: "…", who: `${WORKSHOP_DEFAULT_HOST.split(" ")[0]} (host)`, segment: "STAGE" }],
      exercises: ["…"], leave_with: ["…"],
      facilitator: { name: WORKSHOP_DEFAULT_HOST, kind: "PARTNER", why: "…", evidence_url: null },
      co_host: { name: WORKSHOP_PARTNERS[1], kind: "PARTNER", why: "…", evidence_url: null },
      delivery: { platform_run_of_show: ["…"], on_screen: ["…"], join_flow: ["…"], tech_check: "…" },
      sponsorship: { note: "Free to attend by design; a sponsor would cover the materials.", suggested: { category_fit: "…", ask_usd: 750, why: "…" } },
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
function isPartnerName(name: string): boolean {
  return (WORKSHOP_PARTNERS as readonly string[]).some((p) => p.toLowerCase() === name.toLowerCase());
}
/** The HOST. Scooter by default — never Sequoia by default, which is what it used to be. */
function facilitatorOf(v: unknown, fallbackName = WORKSHOP_DEFAULT_HOST): WorkshopFacilitator {
  const f = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = str(f.name) ?? fallbackName;
  const kind: WorkshopFacilitator["kind"] = str(f.kind)?.toUpperCase() === "GUEST" && !isPartnerName(name) ? "GUEST" : "PARTNER";
  return { name, kind, why: str(f.why) ?? "", evidenceUrl: httpUrl(f.evidence_url) };
}
/** A co-host is the norm — but an invented one is worse than none, so a nameless object is null. */
function coHostOf(v: unknown, hostName: string): WorkshopFacilitator | null {
  const f = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = str(f.name);
  if (!name || name.toLowerCase() === hostName.toLowerCase()) return null;
  const kind: WorkshopFacilitator["kind"] = str(f.kind)?.toUpperCase() === "GUEST" && !isPartnerName(name) ? "GUEST" : "PARTNER";
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
 * THREE ANGLES ON ONE TOPIC, EXACTLY ONE CHOSEN — AND A THREE-SUBJECT ANSWER IS REJECTED HERE.
 *
 * This is the half of item 2 that is a guarantee rather than a request. The prompt asks for angles;
 * a prompt is a request. What makes it structural is that:
 *
 *   1 · THE PACKET HAS ONE TOPIC FIELD. A concept carries no subject of its own — its `title` is
 *       the angle's NAME — so three subjects have nowhere to be stored even if a model produced
 *       them. This is why `topic` comes back from here as a single string.
 *   2 · EVERY CONCEPT MUST DECLARE `angle_on`, AND THEY MUST ALL BE THE SAME SUBJECT. A model
 *       answering with three different subjects fills three different `angle_on` values — that is
 *       what the shape asks for and what actually happens — and this returns NULL, which fails the
 *       stage. The sweep retries it with the failure on the card. It is not discouraged; it does
 *       not get stored.
 *   3 · WHEN A PARTNER SET THE TOPIC, `angle_on` must be THAT topic. A model that "improved" a
 *       subject the partners decided is rejected, not obeyed.
 *
 * `setTopic` null means the month was open and Parker chose: the topic is read from the answer's
 * own `topic` field (or, failing that, the first concept's `angle_on`), and rule 2 still applies.
 */
export function parseWorkshopConcepts(
  raw: string,
  setTopic: string | null,
): { topic: string; concepts: WorkshopConcept[]; choiceRationale: string | null; pushback: string | null } | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const rows = list(p.concepts);
  if (rows.length === 0) return null;

  const declared = rows.map((c) => str(c.angle_on));
  const topic = setTopic ?? str(p.topic) ?? declared.find((d): d is string => Boolean(d)) ?? null;
  if (!topic) return null;
  // THE REJECTION. Every angle must be on the one subject; a missing declaration is a missing
  // guarantee and is refused for the same reason a differing one is.
  if (declared.some((d) => !sameSubject(d, topic))) return null;

  const concepts: WorkshopConcept[] = [];
  for (const c of rows) {
    const title = str(c.title);
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
      costBand: str(c.cost_band) ?? "$0 to attend — free by design",
      signatureMoment: str(c.signature_exercise) ?? "",
      venueDirection: WORKSHOP_WHERE,
      chosen: c.chosen === true,
      angleOn: topic,
      angleKind: angleKindOf(c.angle_kind),
      whoItsFor: str(c.who_its_for) ?? "",
      promise,
      mode,
      leaveWith,
      facilitator,
      coHost: coHostOf(c.co_host, facilitator.name),
    });
  }
  if (concepts.length === 0) return null;
  const firstChosen = concepts.findIndex((c) => c.chosen);
  concepts.forEach((c, i) => { c.chosen = i === (firstChosen === -1 ? 0 : firstChosen); });
  return { topic, concepts: concepts.slice(0, 3), choiceRationale: str(p.choice_rationale), pushback: str(p.pushback) };
}

export function parseWorkshopPacket(raw: string, topic: string): WorkshopPacket | null {
  const p = jsonBody(raw);
  if (!p) return null;
  // The TITLE is the angle's name and the model may write it. The TOPIC is not its to change.
  const title = str(p.title) ?? topic;
  const promise = str(p.promise);
  if (!promise) return null;
  const runOfShow: WorkshopRunOfShowLine[] = list(p.run_of_show)
    .map((l) => ({ time: str(l.time) ?? "", minutes: num(l.minutes) ?? 0, what: str(l.what) ?? "", who: str(l.who) ?? "", segment: (str(l.segment)?.toUpperCase() === "BREAKOUT" ? "BREAKOUT" : "STAGE") as "STAGE" | "BREAKOUT" }))
    .filter((l) => l.time && l.what);
  const d = (p.delivery && typeof p.delivery === "object" ? p.delivery : {}) as Record<string, unknown>;
  const sponsorship = normaliseSponsorship(sponsorshipFromModel(p.sponsorship));
  const keys: WorkshopBudgetKey[] = ["facilitator_fee", "production_time", "materials"];
  const budgetLines = list(p.budget_lines)
    .map((l) => ({ key: str(l.key) as WorkshopBudgetKey, lowUsd: num(l.low_usd) ?? 0, highUsd: num(l.high_usd) ?? 0, basis: str(l.basis) ?? "" }))
    .filter((l) => keys.includes(l.key));
  const facilitator = facilitatorOf(p.facilitator);
  return {
    title,
    topic,
    whoItsFor: str(p.who_its_for) ?? WORKSHOP_AUDIENCE,
    promise,
    mode: modeOf(p.mode),
    targetMin: num(p.target_min) ?? 20,
    targetMax: num(p.target_max) ?? 60,
    runOfShow,
    exercises: strings(p.exercises),
    leaveWith: strings(p.leave_with),
    facilitator,
    coHost: coHostOf(p.co_host, facilitator.name),
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

/** The model's snake_case sponsorship, lifted into the shape `normaliseSponsorship` reads. */
function sponsorshipFromModel(v: unknown): Record<string, unknown> {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const raw = (s.suggested && typeof s.suggested === "object" ? s.suggested : {}) as Record<string, unknown>;
  // A model that answered in the OLD shape (`category_fit`/`ask_usd` at the top level) still lands.
  const categoryFit = str(raw.category_fit) ?? str(raw.categoryFit) ?? str(s.category_fit) ?? str(s.categoryFit);
  const askUsd = num(raw.ask_usd) ?? num(raw.askUsd) ?? num(s.ask_usd) ?? num(s.askUsd);
  const why = str(raw.why) ?? str(s.why) ?? str(s.note) ?? "";
  return {
    attendanceFree: true,
    suggested: categoryFit ? { categoryFit, askUsd, why } : null,
    note: str(s.note) ?? "Free to attend by design.",
  };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * The rules the prompt asked for, made safe afterwards: no venue anywhere, only judged URLs, a
 * guest host or co-host without judged evidence is demoted to a partner-led session with the guest
 * named as an idea, attendance free is FORCED rather than trusted, a missing sponsor suggestion or
 * co-host is reported rather than silently accepted, and the run of show must land inside the
 * length range.
 */
export function verifyWorkshopPacket(packet: WorkshopPacket, judgedUrls: readonly string[], raw?: string): { packet: WorkshopPacket; flags: WorkshopFlag[] } {
  const flags: WorkshopFlag[] = [];
  const allowed = new Set(judgedUrls.map((u) => u.toLowerCase()));
  const out: WorkshopPacket = {
    ...packet,
    delivery: { ...packet.delivery, where: WORKSHOP_WHERE },
    // THE INVARIANT, forced rather than trusted: attendance is free, always, by design.
    sponsorship: { ...packet.sponsorship, attendanceFree: true },
  };

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
      flags.push({ code: "guest_without_evidence", detail: `${out.facilitator.name} was proposed as a guest host without a checked page showing they do this; the session is partner-led with them named as an idea` });
      out.facilitator = { name: WORKSHOP_DEFAULT_HOST, kind: "PARTNER", why: `Partner-led. Guest idea to verify: ${out.facilitator.name} — ${out.facilitator.why}`.slice(0, 400), evidenceUrl: null };
    }
  }
  if (out.coHost && out.coHost.kind === "GUEST") {
    const ok = out.coHost.evidenceUrl && allowed.has(out.coHost.evidenceUrl.toLowerCase());
    if (!ok) {
      flags.push({ code: "guest_without_evidence", detail: `${out.coHost.name} was proposed as a guest co-host without a checked page showing they do this; the co-host seat is the other partner's with them named as an idea` });
      const other = WORKSHOP_PARTNERS.find((n) => n.toLowerCase() !== out.facilitator.name.toLowerCase()) ?? WORKSHOP_PARTNERS[1];
      out.coHost = { name: other, kind: "PARTNER", why: `Partner co-host. Guest idea to verify: ${out.coHost.name} — ${out.coHost.why}`.slice(0, 400), evidenceUrl: null };
    }
  }
  if (!out.coHost) flags.push({ code: "no_co_host", detail: "no co-host was named; a Workshop usually has one, so decide who it is before you keep this" });
  if (!out.sponsorship.suggested) {
    flags.push({ code: "no_sponsor_suggested", detail: "no sponsor was suggested; attendance is free either way, and suggesting a small sponsor costs nothing — ask again for one" });
  }
  if (out.runOfShow.length === 0) flags.push({ code: "no_run_of_show", detail: "no run of show was written" });
  if (out.leaveWith.length === 0) flags.push({ code: "no_leave_with", detail: "the packet does not say what attendees leave with" });
  if (out.invitations.length < 3) flags.push({ code: "no_invitations", detail: `${out.invitations.length} invitation email(s) drafted; the sequence is three` });
  const minutes = out.runOfShow.reduce((n, l) => n + (l.minutes || 0), 0);
  if (minutes > 0 && (minutes < WORKSHOP_LENGTH_MIN_MINUTES - 5 || minutes > WORKSHOP_LENGTH_MAX_MINUTES + 5)) {
    flags.push({ code: "length_off", detail: `the run of show adds up to ${minutes} minutes; a Workshop is ${WORKSHOP_LENGTH_RANGE}` });
  }
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
