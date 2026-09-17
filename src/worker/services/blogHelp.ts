import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { SEARCH_MODEL } from "./liveSearch";
import { blockCard } from "./blocks";
import { urlIsLive } from "../effects/urlLiveness";
import { deliver, recentFeedbackFor } from "./deliverables";
import { notifyQuietly } from "./notifications";
import { sendPartnerEmail } from "./execEmail";
import type { SweepCard } from "./workSweep";
import { guidanceBlock } from "../../shared/skills/library";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { describeModes, readBlogAsk, type BlogAsk, type BlogMode } from "../../shared/intake/blogHelp";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";

/**
 * Blog help, worked by a partner's chief of staff (16 Sep 2026).
 *
 * Operator: "The partners are starting blogs. When a partner emails os@joinwestpeek.com with a
 * request like 'help me make an outline for a blog post on X and do research', 'write a blog post
 * on X', or 'help me come up with a phrase I can repeat across posts to build authority', Porter
 * must route it to that partner's chief of staff as a BLOG_HELP card with the ask parsed into a
 * mode." The parse happens at the door (`shared/intake/blogHelp.ts`, called from
 * `openAssignmentCard`); this file is the runner the sweep hands the card to.
 *
 * ── HOW IT RUNS, and why in this order ────────────────────────────────────────────────────────
 *
 *   1. RESEARCH FIRST, THROUGH THE SEARCH MODEL. Whatever the mode, the piece is grounded in
 *      current sources: the search model returns facts each with the URL it came from, every
 *      URL is checked live, and what survives is put to a second model — the JUDGE — which holds
 *      each fact to the brief (about the topic, specific, from a page that plausibly says it).
 *      This is the pattern `productions.ts` arrived at after a search model sent Scooter a
 *      Russian press page and the Space Force. No source reaches the partner unjudged.
 *   2. THEN THE WRITING, THROUGH THE DEFAULT MODEL, with the partner's voice cues (who they are,
 *      what they cover, what they said about the last pieces), West Peek's positioning, and the
 *      judged notes — and the rule that ONLY those URLs may be cited. Anything else the writer
 *      cites is stripped on the way out.
 *   3. THEN THE DELIVERABLE (kind `blog_help`, filed to Documents as markdown, on the partner's
 *      Home under their chief of staff) and ONE email in the busy-executive format.
 *
 * A card with no usable source for an OUTLINE or a DRAFT is BLOCKED with the reason, and nothing
 * is emailed — a spine that leans on nothing is not help. A PHRASE-only ask can stand on the
 * positioning alone and says so.
 */

export const BLOG_HELP_KIND = "BLOG_HELP";

/**
 * West Peek's positioning, for the writer. Read from docs/COMMUNITY.md ("the source of truth for
 * the community model") and the firm's own description of itself; kept short because the writer
 * is a partner's voice, not the firm's brochure.
 */
export const WEST_PEEK_POSITIONING = [
  "West Peek Ventures is an earliest-stage venture fund built around a free professional mastermind",
  "community of 5,000+ founders, operators, investors and specialists. Its belief: good people should",
  "meet good people. The output of the community is not engagement; it is EARLY INCLUSION — West Peek",
  "wants to meet founders while they are still thinking about leaving their job, validating an idea,",
  "looking for a cofounder, or making their first hires, because those conversations happen between",
  "operators, lawyers, recruiters and executives, not investors. The rhythm is a monthly Community",
  "Mastermind, a monthly themed Room, and a monthly Workshop. Community is an operating advantage, not a channel.",
].join(" ");

// ── Reading the card ─────────────────────────────────────────────────────────

export interface BlogCard extends SweepCard {
  request_json?: string | null;
  description?: string | null;
}

interface Partner {
  firmUserId: string;
  fullName: string;
  email: string;
  employee: { id: string; name: string; role: string };
}

/**
 * Who asked, and who works it. The requester is the authenticated address on the card; when a card
 * was opened by hand with no email, the chief of staff's own role names the partner.
 */
async function partnerFor(env: Env, card: BlogCard): Promise<Partner | null> {
  const employee = AI_EMPLOYEE_ROSTER.find((e) => `aie_${e.name.toLowerCase()}` === card.owner_id);
  const role = employee?.role ?? "Chief of Staff";
  const byEmail = card.requested_by_email
    ? await env.WP_OS_DB.prepare("SELECT id, full_name, email FROM firm_user WHERE lower(email) = ?1").bind(card.requested_by_email.toLowerCase()).first<{ id: string; full_name: string; email: string }>()
    : null;
  const first = role.match(/^([A-Za-z]+)'s chief of staff/i)?.[1];
  const byRole = !byEmail && first
    ? await env.WP_OS_DB.prepare("SELECT id, full_name, email FROM firm_user WHERE lower(full_name) LIKE ?1 LIMIT 1").bind(`${first.toLowerCase()}%`).first<{ id: string; full_name: string; email: string }>()
    : null;
  const user = byEmail ?? byRole;
  if (!user?.email) return null;
  return {
    firmUserId: user.id,
    fullName: user.full_name,
    email: user.email.toLowerCase(),
    employee: { id: card.owner_id ?? "aie_wren", name: employee?.name ?? "Wren", role },
  };
}

// ── Model calls, injectable ──────────────────────────────────────────────────

export type BlogModelCall = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export type UrlCheck = (url: string) => Promise<boolean>;

const defaultSearch: BlogModelCall = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "blog help: research",
    actor,
    inputs: [prompt],
    // Public web research; the query leaves for a search engine. Never raised.
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: true, expectedOutputTokens: 2500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model !== SEARCH_MODEL) return { ok: false, text: "", detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  return { ok: true, text: run.output_text, detail: "ok" };
};

const defaultJudge: BlogModelCall = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "blog help: judgement",
    actor,
    inputs: [prompt],
    sensitivity: "PUBLIC" as never,
    budgetContext: { expectedOutputTokens: 1200, providerKey: "openrouter", judgement: true },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model === SEARCH_MODEL) return { ok: false, text: "", detail: "the judgement was routed to the search model" };
  return { ok: true, text: run.output_text, detail: "ok" };
};

const defaultWrite: BlogModelCall = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "blog help: writing",
    actor,
    inputs: [prompt],
    // The partner's ask and the firm's positioning; nothing about a company, a deal or an LP.
    sensitivity: "INTERNAL" as never,
    // Written in a partner's voice and sent under her name.
    budgetContext: { expectedOutputTokens: 3500, providerKey: "openrouter", judgement: true },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model === SEARCH_MODEL) return { ok: false, text: "", detail: "the writing was routed to the search model" };
  return { ok: true, text: run.output_text, detail: "ok" };
};

// ── Parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
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

export interface ResearchNote {
  fact: string;
  whyItMatters: string;
  source: string;
  url: string;
  date: string | null;
}

/** No URL, no note — the citation is the whole value of a search-grounded answer. One per URL. */
export function parseResearch(raw: string): ResearchNote[] {
  const p = jsonBody(raw);
  const out: ResearchNote[] = [];
  for (const r of list(p?.results)) {
    const fact = str(r.fact) ?? str(r.finding);
    const url = httpUrl(r.url);
    if (!fact || !url) continue;
    if (out.some((o) => o.url.toLowerCase() === url.toLowerCase())) continue;
    out.push({ fact, whyItMatters: str(r.why_it_matters) ?? "", source: str(r.source) ?? new URL(url).hostname, url, date: str(r.date) });
  }
  return out;
}

export function parseVerdicts(raw: string): Map<string, { keep: boolean; reason: string }> {
  const p = jsonBody(raw);
  const out = new Map<string, { keep: boolean; reason: string }>();
  for (const r of list(p?.verdicts)) {
    const url = httpUrl(r.url);
    if (!url) continue;
    out.set(url.toLowerCase(), { keep: r.keep === true, reason: str(r.reason) ?? "no reason given" });
  }
  return out;
}

export interface OutlinePiece {
  title: string;
  alternates: string[];
  thesis: string;
  sections: Array<{ heading: string; proves: string; leansOn: Array<{ fact: string; url: string }> }>;
  opening: string;
  closing: string;
  notes: Array<{ note: string; url: string }>;
}

export interface DraftPiece {
  title: string;
  bodyMarkdown: string;
  sources: Array<{ n: number; url: string; note: string }>;
  words: number;
}

export interface PhrasePiece {
  candidates: Array<{ phrase: string; reasoning: string; recursAs: string }>;
  recommendation: string;
  why: string;
}

function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

/** Only judged URLs may be cited. Anything else the writer produced is dropped and counted. */
export function parseOutline(raw: string, allowed: ReadonlySet<string>): { piece: OutlinePiece | null; strippedUrls: number } {
  const p = jsonBody(raw);
  if (!p) return { piece: null, strippedUrls: 0 };
  let stripped = 0;
  const keepUrl = (u: unknown): string | null => {
    const url = httpUrl(u);
    if (!url) return null;
    if (allowed.has(url.toLowerCase())) return url;
    stripped += 1;
    return null;
  };
  const title = str(p.title);
  const thesis = str(p.thesis);
  const sections = list(p.sections)
    .map((s) => ({
      heading: str(s.heading) ?? "",
      proves: str(s.proves) ?? "",
      leansOn: list(s.leans_on)
        .map((l) => ({ fact: str(l.fact) ?? "", url: keepUrl(l.url) ?? "" }))
        .filter((l) => l.fact && l.url),
    }))
    .filter((s) => s.heading);
  if (!title || !thesis || sections.length === 0) return { piece: null, strippedUrls: stripped };
  return {
    piece: {
      title,
      alternates: (Array.isArray(p.alternates) ? (p.alternates as unknown[]) : []).map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean).slice(0, 3),
      thesis,
      sections,
      opening: str(p.opening) ?? "",
      closing: str(p.closing) ?? "",
      notes: list(p.research_notes)
        .map((n) => ({ note: str(n.note) ?? "", url: keepUrl(n.url) ?? "" }))
        .filter((n) => n.note && n.url)
        .slice(0, 5),
    },
    strippedUrls: stripped,
  };
}

export function parseDraft(raw: string, allowed: ReadonlySet<string>): { piece: DraftPiece | null; strippedUrls: number } {
  const p = jsonBody(raw);
  if (!p) return { piece: null, strippedUrls: 0 };
  const title = str(p.title);
  const body = str(p.body_markdown) ?? str(p.body);
  if (!title || !body) return { piece: null, strippedUrls: 0 };
  let stripped = 0;
  const sources: DraftPiece["sources"] = [];
  for (const s of list(p.sources)) {
    const url = httpUrl(s.url);
    const n = Number(s.n);
    if (!url || !Number.isFinite(n)) continue;
    if (!allowed.has(url.toLowerCase())) { stripped += 1; continue; }
    sources.push({ n, url, note: str(s.note) ?? "" });
  }
  // A bare URL in the body that is not one of the judged sources is not a source; it goes.
  const cleaned = body.replace(/https?:\/\/[^\s)\]"'<>]+/g, (u) => {
    if (allowed.has(u.replace(/[.,;)]+$/, "").toLowerCase())) return u;
    stripped += 1;
    return "[source removed: not among the checked sources]";
  });
  return { piece: { title, bodyMarkdown: cleaned, sources, words: wordCount(cleaned) }, strippedUrls: stripped };
}

export function parsePhrases(raw: string): PhrasePiece | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const candidates = list(p.candidates)
    .map((c) => ({ phrase: str(c.phrase) ?? "", reasoning: str(c.reasoning) ?? "", recursAs: str(c.recurs_as) ?? str(c.how_it_recurs) ?? "" }))
    .filter((c) => c.phrase)
    .slice(0, 5);
  if (candidates.length === 0) return null;
  return { candidates, recommendation: str(p.recommendation) ?? candidates[0]!.phrase, why: str(p.why) ?? "" };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function identity(employee: { name: string; role: string }): string {
  return personaPrompt(employee.name, employee.role);
}

export function buildResearchPrompt(employee: { name: string; role: string }, partner: string, ask: BlogAsk): string {
  return [
    identity(employee),
    "",
    `${partner}, the Managing Partner you work for, is writing a blog and asked: "${ask.ask.slice(0, 1200)}"`,
    `TOPIC: ${ask.topic}`,
    "",
    "TASK: research the topic using CURRENT sources. Find 6–10 specific facts, numbers, examples or",
    "arguments a post on this topic could lean on. Each must come from a real, live page you cite.",
    "",
    "RULES:",
    "- A url on every entry, the page that actually states the fact. No url, no entry — entries",
    "  without one are discarded unread. One entry per url.",
    "- Specific beats general: a number with a date, a named example, a stated finding. 'Many",
    "  experts believe' is not a fact.",
    "- Prefer primary and reputable sources (research, official data, the company's own page, a",
    "  named journalist's reporting). Avoid content farms and listicles.",
    "- Say the publication month if the page shows one (YYYY-MM), else null.",
    "- why_it_matters: one line on what this fact lets the post argue.",
    "",
    'Return ONLY JSON: {"results":[{"fact":"…","why_it_matters":"…","source":"…","url":"https://…","date":"YYYY-MM"}]}',
  ].join("\n");
}

export function buildJudgePrompt(employee: { name: string; role: string }, ask: BlogAsk, notes: readonly ResearchNote[]): string {
  return [
    identity(employee),
    "",
    "You are the JUDGE, not the researcher. A web-search model produced the research notes below",
    `for a blog post on: ${ask.topic}. Hold each note to the brief and return a verdict per note.`,
    "Be strict: fewer, all sound, beats ten with a stretch.",
    "",
    "KEEP a note only if ALL of these hold:",
    "- It is about the topic, or plainly supports an argument a post on the topic would make.",
    "- It is specific: a number, a named example, a stated finding, a quoted position.",
    "- The url plausibly belongs to a page that states it (the source named matches the domain;",
    "  a generic homepage, a search page or an unrelated organisation's page fails).",
    "- The source is credible for the claim (research, official data, the organisation's own",
    "  page, a named outlet). A content farm, an SEO listicle, or an anonymous aggregator fails.",
    "- Where the fact depends on being current (a number, a trend), it is dated within the last",
    "  ~18 months or the page is plainly a live, maintained source.",
    "",
    "NOTES:",
    JSON.stringify(notes.map((n) => ({ fact: n.fact, source: n.source, url: n.url, date: n.date })), null, 1),
    "",
    'Return ONLY JSON: {"verdicts":[{"url":"https://…","keep":true,"reason":"one line"}]} — one verdict per note, url copied exactly.',
  ].join("\n");
}

function voiceBlock(partner: { fullName: string }, profile: { sectors: string[]; themes: string[] } | null, feedback: string): string {
  const first = partner.fullName.split(" ")[0] ?? partner.fullName;
  return [
    `WHOSE VOICE THIS IS: ${partner.fullName}, Managing Partner at West Peek Ventures. Write as ${first} would:`,
    "first person, plain, direct, specific; an operator who has done the thing, not a commentator.",
    "Short sentences. No hedging, no throat-clearing, no 'in today's fast-paced world'. Opinions",
    "stated as opinions. Numbers and names over adjectives. Never a sentence that could read as",
    "selling access to the community or marketing the fund.",
    profile && (profile.sectors.length || profile.themes.length)
      ? `WHAT ${first.toUpperCase()} COVERS AND THINKS ABOUT (from their profile): ${[...profile.sectors, ...profile.themes].join(", ")}.`
      : "",
    feedback,
  ]
    .filter(Boolean)
    .join("\n");
}

function notesBlock(notes: readonly ResearchNote[]): string {
  if (notes.length === 0) return "RESEARCH NOTES: none survived the checks. Cite nothing; argue from experience and positioning, and say where a source would strengthen it.";
  return [
    "RESEARCH NOTES — the ONLY sources you may cite. Every URL in your answer must be one of these,",
    "copied exactly; any other URL is removed before the partner sees it.",
    ...notes.map((n, i) => `${i + 1}. ${n.fact}${n.date ? ` (${n.date})` : ""} — ${n.source} — ${n.url}${n.whyItMatters ? `\n   Why it matters: ${n.whyItMatters}` : ""}`),
  ].join("\n");
}

export function buildOutlinePrompt(input: { employee: { name: string; role: string }; partner: { fullName: string }; profile: { sectors: string[]; themes: string[] } | null; feedback: string; ask: BlogAsk; notes: readonly ResearchNote[] }): string {
  return [
    identity(input.employee),
    "",
    `${input.partner.fullName.split(" ")[0]} asked: "${input.ask.ask.slice(0, 1200)}"`,
    `TOPIC: ${input.ask.topic}`,
    "",
    "WEST PEEK'S POSITIONING (the ground the post stands on; never a pitch):",
    WEST_PEEK_POSITIONING,
    "",
    voiceBlock(input.partner, input.profile, input.feedback),
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    notesBlock(input.notes),
    "",
    "TASK: build the OUTLINE for this post — the spine a partner can write from in one sitting.",
    "- title: a working title. alternates: exactly 3 others, each a different angle.",
    "- thesis: ONE sentence — the claim the whole post makes.",
    "- sections: 4–7, in order. For each: heading; proves (what this section establishes, one",
    "  line); leans_on: the 2–3 facts from the research notes it should use, each as",
    "  {fact, url} with the url copied exactly. A section may lean on fewer if fewer fit.",
    "- opening: a suggested first paragraph (3–5 sentences) in the partner's voice.",
    "- closing: a suggested last paragraph (2–4 sentences): the takeaway, no call to action to",
    "  invest or join anything.",
    "- research_notes: the 5 most useful notes as {note, url}, in the partner's words.",
    "",
    'Return ONLY JSON: {"title":"…","alternates":["…","…","…"],"thesis":"…","sections":[{"heading":"…","proves":"…","leans_on":[{"fact":"…","url":"https://…"}]}],"opening":"…","closing":"…","research_notes":[{"note":"…","url":"https://…"}]}',
  ].join("\n");
}

/** "900 words", "about 600 words", "under 500 words" in the ask, else the default band. */
export function wordBand(ask: string): { min: number; max: number; stated: boolean } {
  const m = ask.match(/(?:about|around|roughly|~|under|max(?:imum)?|no more than|at most)?\s*(\d{3,4})\s*words?/i);
  if (!m) return { min: 900, max: 1400, stated: false };
  const n = Number(m[1]);
  const under = /\b(under|max|no more than|at most)\b/i.test(m[0]);
  return under ? { min: Math.round(n * 0.6), max: n, stated: true } : { min: Math.round(n * 0.8), max: Math.round(n * 1.2), stated: true };
}

export function buildDraftPrompt(input: { employee: { name: string; role: string }; partner: { fullName: string }; profile: { sectors: string[]; themes: string[] } | null; feedback: string; ask: BlogAsk; notes: readonly ResearchNote[]; band: { min: number; max: number }; outline?: OutlinePiece | null; nudge?: string }): string {
  return [
    identity(input.employee),
    "",
    `${input.partner.fullName.split(" ")[0]} asked: "${input.ask.ask.slice(0, 1200)}"`,
    `TOPIC: ${input.ask.topic}`,
    "",
    "WEST PEEK'S POSITIONING (the ground the post stands on; never a pitch):",
    WEST_PEEK_POSITIONING,
    "",
    voiceBlock(input.partner, input.profile, input.feedback),
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    notesBlock(input.notes),
    "",
    ...(input.outline ? ["FOLLOW THIS SPINE:", `Thesis: ${input.outline.thesis}`, ...input.outline.sections.map((s, i) => `${i + 1}. ${s.heading} — ${s.proves}`), ""] : []),
    `TASK: write the FULL POST, ${input.band.min}–${input.band.max} words, in the partner's voice, ready to publish after a read.`,
    "- Markdown: a title line is NOT needed (title is a separate field); use ## for section headings",
    "  every 150–300 words; short paragraphs; a list only where the content is a list.",
    "- Cite with numbered markers [1], [2]… at the end of the sentence a fact comes from, and list",
    "  the sources as {n, url, note} — url copied EXACTLY from the research notes. Cite nothing else.",
    "- No invented quotes, no invented numbers. If the notes do not support a claim, do not make it.",
    "- End on the takeaway, not on 'reach out' or 'join us'.",
    ...(input.nudge ? ["", input.nudge] : []),
    "",
    'Return ONLY JSON: {"title":"…","body_markdown":"…","sources":[{"n":1,"url":"https://…","note":"…"}]}',
  ].join("\n");
}

export function buildPhrasePrompt(input: { employee: { name: string; role: string }; partner: { fullName: string }; profile: { sectors: string[]; themes: string[] } | null; feedback: string; ask: BlogAsk; notes: readonly ResearchNote[] }): string {
  return [
    identity(input.employee),
    "",
    `${input.partner.fullName.split(" ")[0]} asked: "${input.ask.ask.slice(0, 1200)}"`,
    "",
    "WEST PEEK'S POSITIONING:",
    WEST_PEEK_POSITIONING,
    "",
    voiceBlock(input.partner, input.profile, input.feedback),
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    notesBlock(input.notes),
    "",
    "TASK: propose 5 SIGNATURE PHRASES — a line the partner can repeat across posts so readers",
    "come to associate it with them and the way they see things. For each:",
    "- phrase: 3–10 words. Concrete, sayable, not a slogan an agency would write. It should be",
    "  TRUE of how West Peek actually works (early inclusion, good people meeting good people,",
    "  community as an operating advantage) without naming the fund.",
    "- reasoning: why this one builds authority — what claim it stakes and why it is defensible.",
    "- recurs_as: how it would recur — as an opening line, a sign-off, a section header, a",
    "  refrain the argument returns to — with one example sentence using it.",
    "Then recommendation: the one to commit to, and why: two lines.",
    "",
    'Return ONLY JSON: {"candidates":[{"phrase":"…","reasoning":"…","recurs_as":"…"}],"recommendation":"…","why":"…"}',
  ].join("\n");
}

// ── Rendering the deliverable ────────────────────────────────────────────────

export function renderOutlineMd(o: OutlinePiece): string {
  return [
    `## Outline — ${o.title}`,
    "",
    `**Working title:** ${o.title}`,
    ...(o.alternates.length ? ["**Alternates:**", ...o.alternates.map((a) => `- ${a}`)] : []),
    "",
    `**Thesis:** ${o.thesis}`,
    "",
    "### The spine",
    ...o.sections.flatMap((s, i) => [
      "",
      `#### ${i + 1}. ${s.heading}`,
      `Proves: ${s.proves}`,
      ...(s.leansOn.length ? ["Leans on:", ...s.leansOn.map((l) => `- ${l.fact} — ${l.url}`)] : ["Leans on: the partner's own experience (no source survived for this section)"]),
    ]),
    "",
    ...(o.opening ? ["### Suggested opening", o.opening, ""] : []),
    ...(o.closing ? ["### Suggested closing", o.closing, ""] : []),
    "### Research notes",
    ...(o.notes.length ? o.notes.map((n, i) => `${i + 1}. ${n.note} — ${n.url}`) : ["- none survived the live check and the judgement pass"]),
  ].join("\n");
}

export function renderDraftMd(d: DraftPiece): string {
  return [
    `## Draft — ${d.title}`,
    "",
    `_${d.words} words._`,
    "",
    d.bodyMarkdown.trim(),
    "",
    "### Sources",
    ...(d.sources.length ? d.sources.sort((a, b) => a.n - b.n).map((s) => `[${s.n}] ${s.url}${s.note ? ` — ${s.note}` : ""}`) : ["- none cited"]),
  ].join("\n");
}

export function renderPhraseMd(p: PhrasePiece): string {
  return [
    "## Signature phrases",
    "",
    ...p.candidates.flatMap((c, i) => [`### ${i + 1}. “${c.phrase}”`, `Why it builds authority: ${c.reasoning}`, `How it recurs: ${c.recursAs}`, ""]),
    `**Recommendation:** “${p.recommendation}”${p.why ? ` — ${p.why}` : ""}`,
  ].join("\n");
}

// ── The runner the sweep calls ───────────────────────────────────────────────

/**
 * What this runner can actually do, for the interpretation pass.
 *
 * The model is shown this list and asked which of her directives change one of these steps and
 * which ask for something none of them does. Without the list it has no way to know the runner
 * cannot publish the post, commission a photograph, or email anybody but the partner who asked —
 * so every instruction would come back honourable and "it can be steered" would be untested.
 */
export const BLOG_STEPS: readonly string[] = [
  "Research the topic through the search model, and check that every source URL is live.",
  "Judge what the search found and keep only what is worth using, dropping the rest with a reason.",
  "Write the outline, the draft or the repeatable phrase — whichever was asked for — in the partner's own voice, grounded in the kept sources.",
  "File the result as a deliverable on the partner's Home.",
  "Send the partner ONE email in the busy-executive format. Nobody outside the firm is contacted and nothing is published.",
];

export interface BlogHelpDeps {
  search?: BlogModelCall;
  judge?: BlogModelCall;
  write?: BlogModelCall;
  urlCheck?: UrlCheck;
  /** The pass that reads what she asked for. See services/instruction.ts and tests/helpers/interpret.ts. */
  interpret?: Interpreter;
}

async function partnerProfile(env: Env, firmUserId: string): Promise<{ sectors: string[]; themes: string[] } | null> {
  const row = await env.WP_OS_DB.prepare("SELECT sectors_json, themes_json FROM partner_intelligence_profile WHERE firm_user_id = ?1").bind(firmUserId).first<{ sectors_json: string; themes_json: string }>().catch(() => null);
  if (!row) return null;
  const arr = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  return { sectors: arr(row.sectors_json), themes: arr(row.themes_json) };
}

/**
 * Research the topic: search, keep the live URLs, judge what is left. Two tries, the second told
 * what was wrong with the first.
 */
export async function researchTopic(
  env: Env,
  actor: Actor,
  employee: { name: string; role: string },
  partnerName: string,
  ask: BlogAsk,
  deps: Required<Pick<BlogHelpDeps, "search" | "judge" | "urlCheck">>,
): Promise<{ notes: ResearchNote[]; dropped: string[]; rejected: Array<{ url: string; reason: string }>; why: string }> {
  let why = "";
  let dropped: string[] = [];
  let rejected: Array<{ url: string; reason: string }> = [];
  let nudge = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildResearchPrompt(employee, partnerName, ask) + (nudge ? `\n\n${nudge}` : "");
    const found = await deps.search(env, actor, prompt);
    if (!found.ok) { why = `the live search failed: ${found.detail}`; continue; }
    const parsed = parseResearch(found.text);
    const checks = await Promise.all(parsed.map(async (n) => ({ n, ok: await deps.urlCheck(n.url) })));
    const live = checks.filter((c) => c.ok).map((c) => c.n);
    dropped = checks.filter((c) => !c.ok).map((c) => c.n.url);
    if (live.length === 0) {
      why = parsed.length === 0 ? "the search answered with no usable entry (no url on any)" : `every cited page was dead: ${dropped.join(", ")}`;
      nudge = `Your previous answer was discarded: ${why}. Every entry MUST carry the url of a live page that states the fact.`;
      continue;
    }
    const judged = await deps.judge(env, actor, buildJudgePrompt(employee, ask, live));
    if (!judged.ok) return { notes: [], dropped, rejected, why: `the judgement pass failed: ${judged.detail}` };
    const verdicts = parseVerdicts(judged.text);
    if (verdicts.size === 0) return { notes: [], dropped, rejected, why: "the judge answered with no verdicts" };
    const notes: ResearchNote[] = [];
    rejected = [];
    for (const n of live) {
      const v = verdicts.get(n.url.toLowerCase());
      if (v?.keep) notes.push(n);
      else rejected.push({ url: n.url, reason: v?.reason ?? "the judge gave no verdict on it" });
    }
    if (notes.length > 0) return { notes, dropped, rejected, why: "" };
    why = `the judge rejected every note: ${rejected.map((r) => `${r.url} — ${r.reason}`).join("; ")}`;
    nudge = `Your previous answer was discarded. Rejected: ${rejected.map((r) => `${r.url} (${r.reason})`).join("; ")}. Find specific, dated facts on credible pages.`;
  }
  return { notes: [], dropped, rejected, why };
}

/**
 * Work one BLOG_HELP card to a conclusion: research, write each mode asked for, file the
 * deliverable, email the partner once, DONE — or BLOCKED with the reason when nothing usable
 * came back for a mode that needs sources.
 */
export async function runBlogHelpCard(
  env: Env,
  card: BlogCard,
  deps: BlogHelpDeps = {},
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const request = card.request_json ?? (await env.WP_OS_DB.prepare("SELECT request_json FROM work_card WHERE id = ?1").bind(card.id).first<{ request_json: string | null }>())?.request_json ?? null;
  const ask = readBlogAsk(request);
  if (!ask) {
    const why = await blockCard(env, card, {
      reason: "the_brief_is_missing",
      trying: card.title,
      employee: "Your chief of staff",
      detail: "Say what you wanted written, on what, and roughly how long.",
    });
    return { finished: false, blocked: true, detail: why };
  }
  const partner = await partnerFor(env, card);
  if (!partner) {
    const why = await blockCard(env, card, {
      reason: "the_brief_is_missing",
      trying: card.title,
      employee: "Your chief of staff",
      detail: "Say who this is for — whose voice it should be written in and who it goes to.",
    });
    return { finished: false, blocked: true, detail: why };
  }

  const employee = partner.employee;
  const actor: Actor = { type: "AI", aiEmployeeId: employee.id, roles: [], firmScopes: [card.firm_scope] };

  /*
   * ANYTHING SHE HAS TYPED ON THE CARD ITSELF, READ BY A MODEL BEFORE THE PIECE IS WRITTEN.
   *
   * The emailed request already reaches a model verbatim (`ask.ask` is carried into every prompt
   * below), which is why this path was less broken than the packet chain. What it could not see was
   * everything typed AFTERWARDS: a steering note left while the research was running, and the
   * answer she gave to clear a block — which on this chain is the whole of "write it again, but
   * shorter and without the second section". Rework after a rejection reached nothing.
   */
  const steer = await steerFor(env, actor, {
    cardId: card.id,
    cardKind: "BLOG_HELP",
    title: card.title,
    employee: employee.name,
    chain: `blog help for ${partner.fullName}: ${describeModes(ask.modes)}`,
    steps: [...BLOG_STEPS],
    firmScope: card.firm_scope,
    extra: [{ source: "BRIEF", text: ask.ask, who: partner.fullName }],
  }, deps.interpret);
  if (steer.cannot.length > 0) {
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: employee.name,
      detail: steer.failure ? undefined : cannotDetail(employee.name, steer.cannot),
    });
    return { finished: false, blocked: true, detail: why };
  }
  // Prefixed once, here, so every prompt this runner builds carries it — the search, the judgement
  // and the writing. A steer each step has to remember is a steer one step will forget.
  const steered = (call: BlogModelCall): BlogModelCall =>
    steer.text ? (e, a, prompt) => call(e, a, `${steer.text}\n\n${prompt}`) : call;
  const search = steered(deps.search ?? defaultSearch);
  const judge = steered(deps.judge ?? defaultJudge);
  const write = steered(deps.write ?? defaultWrite);
  const urlCheck = deps.urlCheck ?? ((u: string) => urlIsLive(u));

  // 1 · Research, judged.
  const research = await researchTopic(env, actor, employee, partner.fullName, ask, { search, judge, urlCheck });
  const needsSources = ask.modes.includes("OUTLINE") || ask.modes.includes("DRAFT");
  if (research.notes.length === 0 && needsSources) {
    const why = await blockCard(env, card, {
      reason: "nothing_good_enough_to_send",
      trying: card.title,
      employee: employee.name,
      detail: `Send a source or two to start from, or say what would count — nothing solid enough turned up to write ${describeModes(ask.modes)} on.`,
    });
    return { finished: false, blocked: true, detail: why };
  }
  const allowed = new Set(research.notes.map((n) => n.url.toLowerCase()));
  const profile = await partnerProfile(env, partner.firmUserId);
  const feedback = await recentFeedbackFor(env, employee.name);
  const voice = { employee, partner: { fullName: partner.fullName }, profile, feedback, ask, notes: research.notes };

  // 2 · Write each mode asked for.
  const parts: string[] = [];
  const failures: string[] = [];
  let strippedUrls = 0;
  let outline: OutlinePiece | null = null;
  let draft: DraftPiece | null = null;
  let phrases: PhrasePiece | null = null;

  for (const mode of ask.modes as BlogMode[]) {
    if (mode === "OUTLINE") {
      const out = await write(env, actor, buildOutlinePrompt(voice));
      const parsed = out.ok ? parseOutline(out.text, allowed) : { piece: null, strippedUrls: 0 };
      strippedUrls += parsed.strippedUrls;
      if (parsed.piece) { outline = parsed.piece; parts.push(renderOutlineMd(outline)); }
      else failures.push(`the outline did not come back usable (${out.ok ? "no title, thesis and sections in the answer" : out.detail})`);
    } else if (mode === "DRAFT") {
      const band = wordBand(ask.ask);
      let got: { piece: DraftPiece | null; strippedUrls: number } = { piece: null, strippedUrls: 0 };
      let detail = "";
      for (let attempt = 0; attempt < 2 && !(got.piece && got.piece.words >= band.min && got.piece.words <= band.max); attempt += 1) {
        const nudge = got.piece ? `Your previous draft was ${got.piece.words} words; it must be ${band.min}–${band.max}. Rewrite to length, keeping the argument.` : undefined;
        const out = await write(env, actor, buildDraftPrompt({ ...voice, band, outline, nudge }));
        detail = out.detail;
        const parsed = out.ok ? parseDraft(out.text, allowed) : { piece: null, strippedUrls: 0 };
        strippedUrls += parsed.strippedUrls;
        if (parsed.piece) got = parsed;
      }
      if (got.piece) { draft = got.piece; parts.push(renderDraftMd(draft)); }
      else failures.push(`the draft did not come back usable (${detail || "no title and body in the answer"})`);
    } else if (mode === "PHRASE") {
      const out = await write(env, actor, buildPhrasePrompt(voice));
      const parsed = out.ok ? parsePhrases(out.text) : null;
      if (parsed) { phrases = parsed; parts.push(renderPhraseMd(phrases)); }
      else failures.push(`the phrases did not come back usable (${out.ok ? "no candidates in the answer" : out.detail})`);
    }
  }

  if (parts.length === 0) {
    const why = `Nothing usable came back from the writer: ${failures.join("; ")}. Nothing was emailed. It will be tried again.`;
    return { finished: false, blocked: false, detail: why };
  }

  // 3 · The deliverable: filed, on Home, then one email.
  const modeWord = ask.modes.length === 1 ? { OUTLINE: "outline", DRAFT: "draft", PHRASE: "phrases" }[ask.modes[0]!] : "help";
  const title = `Blog ${modeWord}: ${(draft?.title ?? outline?.title ?? ask.topic).slice(0, 120)}`;
  const body = [
    `_${describeModes(ask.modes)} for ${partner.fullName.split(" ")[0]}'s blog, on: ${ask.topic}._`,
    "",
    ...parts.flatMap((p) => [p, ""]),
    research.notes.length ? `### Sources checked\n${research.notes.map((n) => `- ${n.source} — ${n.url}`).join("\n")}` : "",
    research.dropped.length ? `\n_Left out because the cited page did not answer: ${research.dropped.join(", ")}_` : "",
    research.rejected.length ? `\n_Left out on judgement: ${research.rejected.map((r) => `${r.url} — ${r.reason}`).join("; ")}_` : "",
    strippedUrls ? `\n_${strippedUrls} URL(s) the writer offered were not among the checked sources and were removed._` : "",
    failures.length ? `\n_Not delivered: ${failures.join("; ")}_` : "",
  ].filter((l) => l !== "").join("\n");

  const delivered = await deliver(env, actor, {
    kind: "blog_help",
    title,
    body,
    preparedBy: employee.name,
    preparedFor: partner.firmUserId,
    sourceType: "work_card",
    sourceId: card.id,
  });

  const email = blogHelpEmail({ employee: employee.name, ask, outline, draft, phrases, research, strippedUrls, failures, body, deliverableId: delivered.id });
  const mail = await sendPartnerEmail(env, {
    to: partner.email,
    email,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: employee.id,
  });

  await notifyQuietly(env, {
    firmUserId: partner.firmUserId,
    kind: "MEETING",
    severity: "INFO",
    title: `${employee.name} finished your blog ${modeWord} — on Home${mail.sent ? " and in your inbox" : ""}`,
    body: `${title}. ${research.notes.length} source(s) checked live and judged.`,
    objectType: "deliverable",
    objectId: delivered.id,
    dedupeKey: `blog_help:${card.id}:delivered`,
    firmScope: card.firm_scope,
  });

  const finding = [
    `• ${title} — ${describeModes(ask.modes)}; ${research.notes.length} source(s) survived the live check and the judgement pass.`,
    mail.sent ? `• Emailed to ${partner.email} ("${mail.subject}").` : `• NOT emailed to ${partner.email}: ${mail.reason}. The deliverable is on Home and in Documents.`,
    `• Deliverable ${delivered.id}${delivered.document_id ? `, filed as document ${delivered.document_id}` : " (not filed)"}.`,
  ].join("\n");
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(card.id, finding).run();
  await appendEvent(env, {
    eventType: "blog_help.delivered",
    actorType: "ai_employee",
    actorId: employee.id,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { modes: ask.modes, topic: ask.topic, sources: research.notes.length, emailed: mail.sent, deliverable_id: delivered.id, subject: mail.subject },
  });
  return {
    finished: true,
    blocked: false,
    detail: mail.sent ? `${title} — emailed to ${partner.email} and on Home` : `${title} — on Home; email not sent (${mail.reason})`,
  };
}

/** The busy-executive email for a finished piece of blog help. */
export function blogHelpEmail(input: {
  employee: string;
  ask: BlogAsk;
  outline: OutlinePiece | null;
  draft: DraftPiece | null;
  phrases: PhrasePiece | null;
  research: { notes: ResearchNote[]; dropped: string[]; rejected: Array<{ url: string; reason: string }> };
  strippedUrls: number;
  failures: string[];
  body: string;
  deliverableId: string;
}): ExecEmailInput {
  const { ask, outline, draft, phrases, research } = input;
  const modeWord = ask.modes.length === 1 ? { OUTLINE: "outline", DRAFT: "draft", PHRASE: "phrases" }[ask.modes[0]!] : "help";
  const found: string[] = [];
  if (outline) {
    found.push(`Title: **${outline.title}** (alternates: ${outline.alternates.map((a) => `“${a}”`).join(", ") || "none"}).`);
    found.push(`Thesis: ${outline.thesis}`);
    found.push(`Spine: ${outline.sections.length} sections — ${outline.sections.map((s) => s.heading).join(" → ")}.`);
  }
  if (draft) found.push(`Draft: **${draft.title}**, ${draft.words} words, ${draft.sources.length} source(s) footnoted.`);
  if (phrases) {
    found.push(`Recommended phrase: **“${phrases.recommendation}”**${phrases.why ? ` — ${phrases.why}` : ""}`);
    found.push(`Also: ${phrases.candidates.filter((c) => c.phrase !== phrases.recommendation).slice(0, 4).map((c) => `“${c.phrase}”`).join(", ")}.`);
  }
  const yourCall: string[] = [];
  if (outline && !draft) yourCall.push("Pick a title and reply \"draft it\" — I will write the full post from this spine.");
  if (draft) yourCall.push("Read the draft; reply with edits or \"publish as is\". Nothing is posted from here.");
  if (phrases) yourCall.push("Commit to one phrase, or tell me which two to combine.");
  yourCall.push(`It is on your Home page under my name and filed in Documents (deliverable ${input.deliverableId}).`);
  return {
    employee: input.employee,
    what: `blog ${modeWord} — ${ask.topic}`,
    tldr: `${describeModes(ask.modes).replace(/^./, (c) => c.toUpperCase())} for your post on ${ask.topic}, grounded in ${research.notes.length} checked source(s). ${
      draft ? "Read the draft and send edits." : outline ? "Pick a title and say whether to draft it." : "Commit to one phrase."
    }`,
    sections: [
      { label: "What you asked", bullets: [`${describeModes(ask.modes).replace(/^./, (c) => c.toUpperCase())} on: ${ask.topic}.`] },
      {
        label: "What I did",
        bullets: [
          `Searched live sources, checked every URL answers, and judged each fact against the brief: **${research.notes.length}** kept${research.dropped.length ? `, ${research.dropped.length} dropped as dead` : ""}${research.rejected.length ? `, ${research.rejected.length} rejected on judgement` : ""}.`,
          `Wrote ${describeModes(ask.modes)} in your voice, from West Peek's positioning; only checked sources are cited${input.strippedUrls ? ` (${input.strippedUrls} unchecked URL(s) removed)` : ""}.`,
          ...(input.failures.length ? [`Not delivered: ${input.failures.join("; ")}.`] : []),
        ],
      },
      { label: "What I found", bullets: found.length ? found : ["The piece is below."] },
      { label: "Your call", bullets: yourCall },
    ],
    details: input.body,
  };
}
