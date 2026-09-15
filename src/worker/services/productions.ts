import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { SEARCH_MODEL } from "./liveSearch";
import { urlIsLive } from "../effects/urlLiveness";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { emailPartnerDeliverable } from "./requestReply";
import { guidanceBlock } from "../../shared/skills/library";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";

/**
 * Walker helping West Peek Productions — Scooter's OWN agency, not part of the fund (15 Sep 2026).
 *
 * Operator: "Help him with west peek productions his agency… find customers for west peek
 * productions and find press opportunities to grow that business. westpeekproductions.com…
 * 'Community as a service' is big for them… his chief of staff should search for potential
 * customers who can benefit and send him an email 1x per month of potential customer ideas and…
 * pitch him to journalists to discuss what he is offering."
 *
 * ── THE BOUNDARY, FIRST ───────────────────────────────────────────────────────────────────────
 *
 * The agency is Scooter's personal business. This work is a chief-of-staff duty inside HIS office
 * (`mp_personal_office`), and it never touches a fund record: no company, deal, LP or portfolio
 * row is read or written here, the deliverable goes to scooter@westpeek.ventures ONLY, and nothing
 * is ever sent to a prospect or a journalist from this system — the outbound gate stays. Sequoia is
 * not told; a card for her partner's agency on her desk would be the wrong desk.
 *
 * ── HOW IT RUNS ───────────────────────────────────────────────────────────────────────────────
 *
 * Two monthly jobs open one work card each on Walker's desk; the employee sweep works the card
 * (one search, a liveness check on every URL, one email) and closes it DONE with the findings on
 * the card. A cron tick therefore does one bounded unit of work, which is what the Free plan's
 * CPU budget allows. No name leaves this file without a URL that answered a request.
 */

export const PRODUCTIONS_SITE = "https://westpeekproductions.com";
export const SCOOTER_EMAIL = "scooter@westpeek.ventures";
export const SCOOTER_FIRM_USER_ID = "fu_scooter_taylor";

/**
 * What West Peek Productions sells, read from westpeekproductions.com on 15 Sep 2026 (fetched,
 * not remembered). Re-read the site if this drifts; the method in the skill library repeats it in
 * shorter form so Walker carries it into every prompt.
 */
export const PRODUCTIONS_OFFER = [
  "West Peek Productions (westpeekproductions.com) is a Community-as-a-Service and creative agency.",
  "Positioning: 'Community is not a channel. It's an operating advantage.' One operating partner for",
  "community strategy, experiences, storytelling, brand, content and audience growth, so the work",
  "before, during and after any single moment compounds (Experience → Content → Audience → Community → Opportunity).",
  "Services: Community Strategy & Activation (programming, member engagement, partnerships, launches);",
  "Virtual & Hybrid Experiences (conferences, summits, galas, career fairs, internal events — 400+",
  "productions since 2020); Storytelling & Content (brand storytelling, podcasts, founder stories,",
  "event-to-content systems); Brand & Creative (positioning, messaging, creative direction); Audience",
  "Growth (distribution, community-led growth); Smarter Operations (workflow automation as infrastructure).",
  "Built for enterprise organisations, national nonprofits, high-growth companies and community ecosystems.",
  "Published price bands: $2,500–$7,500 for moderated webinars; $10,000–$50,000+ for summits, conferences and hybrid.",
  "Backed by the broader West Peek community of 5,000+ founders, operators, investors, creatives and builders.",
].join("\n");

export type ProductionsKind = "PRODUCTIONS_CUSTOMERS" | "PRODUCTIONS_PRESS";

export const PRODUCTIONS_JOBS: Readonly<Record<string, { kind: ProductionsKind; title: (month: string) => string }>> = {
  productions_customer_ideas: {
    kind: "PRODUCTIONS_CUSTOMERS",
    title: (month) => `Walker: 10 who could buy Community-as-a-Service this month (${month})`,
  },
  productions_press_pitches: {
    kind: "PRODUCTIONS_PRESS",
    title: (month) => `Walker: 5 press pitches for West Peek Productions (${month})`,
  },
};

export function isProductionsKind(kind: string | null | undefined): kind is ProductionsKind {
  return kind === "PRODUCTIONS_CUSTOMERS" || kind === "PRODUCTIONS_PRESS";
}

function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Open this month's card for Walker, or report the one already open. Idempotent by title, which
 * carries the month — the job fires daily and must not open thirty cards.
 */
export async function openProductionsCard(
  env: Env,
  jobKey: string,
  now: Date,
  firmScope = "west-peek",
): Promise<{ opened: boolean; cardId: string; title: string }> {
  const job = PRODUCTIONS_JOBS[jobKey];
  if (!job) throw new Error(`no Productions duty is keyed ${jobKey}`);
  const title = job.title(monthOf(now));
  const existing = await env.WP_OS_DB.prepare(
    "SELECT id FROM work_card WHERE title = ?1 AND firm_scope = ?2 AND state != 'CANCELLED' LIMIT 1",
  ).bind(title, firmScope).first<{ id: string }>();
  if (existing) return { opened: false, cardId: existing.id, title };

  const card = await createWorkCardInternal(env, sweepIdentity(firmScope), {
    title,
    description: [
      "SCOOTER'S PERSONAL-AGENCY DUTY — West Peek Productions is Scooter's own business, not part of West Peek Ventures.",
      "This card touches no fund record and its result goes to scooter@westpeek.ventures only. Nothing is sent to anyone outside the firm.",
      "",
      job.kind === "PRODUCTIONS_CUSTOMERS"
        ? "Find 10 organisations that plausibly need Community-as-a-Service right now — each with the trigger (a launch, a hire, a raise, a programme), the person or role to approach, a one-line angle, and the URL that shows the trigger."
        : "Draft pitches to 5 journalists or newsletter writers covering community, brand, the creator economy or go-to-market — each with why that writer, the hook, the writer's name and outlet, a public email address if a live page shows one (otherwise the contact page), and a URL proving the beat. Drafts for Scooter to send himself.",
    ].join("\n"),
    owner_type: "AI",
    owner_id: "aie_walker",
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: job.kind === "PRODUCTIONS_CUSTOMERS" ? "Search, verify every URL, email Scooter the ten." : "Search, verify every URL, email Scooter the five drafts.",
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2 WHERE id = ?1").bind(card.id, job.kind).run();
  await appendEvent(env, {
    eventType: "productions.card_opened",
    actorType: "system",
    actorId: "scheduled_job",
    objectType: "work_card",
    objectId: card.id,
    firmScope,
    payload: { job_key: jobKey, kind: job.kind, month: monthOf(now) },
  });
  return { opened: true, cardId: card.id, title };
}

// ── The search and its verification ─────────────────────────────────────────

export interface CustomerIdea {
  organisation: string;
  trigger: string;
  approach: string;
  angle: string;
  url: string;
}

export interface PressPitch {
  writer: string;
  outlet: string;
  /** Only when a live page showed it; otherwise null and `contactUrl` says where to look. */
  email: string | null;
  contactUrl: string | null;
  whyThisWriter: string;
  hook: string;
  /** The URL proving the beat — a recent piece by this writer on this subject. */
  proofUrl: string;
  draft: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
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

export function parseCustomerIdeas(raw: string): CustomerIdea[] {
  const p = jsonBody(raw);
  const out: CustomerIdea[] = [];
  for (const r of Array.isArray(p?.results) ? (p!.results as Record<string, unknown>[]) : []) {
    const organisation = str(r.organisation) ?? str(r.organization) ?? str(r.name);
    const url = httpUrl(r.url);
    // No URL, no idea. The value of a search-grounded answer over a remembered one is the citation.
    if (!organisation || !url) continue;
    out.push({
      organisation,
      trigger: str(r.trigger) ?? "trigger not stated",
      approach: str(r.approach) ?? str(r.person_or_role) ?? "role not stated",
      angle: str(r.angle) ?? "",
      url,
    });
  }
  return out;
}

export function parsePressPitches(raw: string): PressPitch[] {
  const p = jsonBody(raw);
  const out: PressPitch[] = [];
  for (const r of Array.isArray(p?.results) ? (p!.results as Record<string, unknown>[]) : []) {
    const writer = str(r.writer) ?? str(r.name);
    const proofUrl = httpUrl(r.proof_url) ?? httpUrl(r.url);
    if (!writer || !proofUrl) continue;
    const email = str(r.email);
    out.push({
      writer,
      outlet: str(r.outlet) ?? "outlet not stated",
      // An address is kept only with the page it was read from; an address with no page is a guess.
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && httpUrl(r.contact_url) ? email : null,
      contactUrl: httpUrl(r.contact_url),
      whyThisWriter: str(r.why_this_writer) ?? "",
      hook: str(r.hook) ?? "",
      proofUrl,
      draft: str(r.draft) ?? "",
    });
  }
  return out;
}

/** True when the URL answers. Lives in effects/, where every outbound request in this system lives. */
export type UrlCheck = (url: string) => Promise<boolean>;
export const defaultUrlCheck: UrlCheck = (url) => urlIsLive(url);

/** Keep only entries whose cited URL is live. `dropped` names what went, for the card. */
export async function keepLive<T>(
  items: readonly T[],
  urlOf: (t: T) => string,
  check: UrlCheck,
): Promise<{ kept: T[]; dropped: string[] }> {
  const results = await Promise.all(items.map(async (t) => ({ t, ok: await check(urlOf(t)) })));
  return {
    kept: results.filter((r) => r.ok).map((r) => r.t),
    dropped: results.filter((r) => !r.ok).map((r) => urlOf(r.t)),
  };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function walkerIdentity(): string {
  return personaPrompt("Walker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Walker")?.role ?? "Scooter's Chief of Staff");
}

export function buildCustomerPrompt(month: string): string {
  return [
    walkerIdentity(),
    "",
    "You are working for Scooter's OWN agency, West Peek Productions — not for the fund. Nothing here",
    "concerns West Peek Ventures, its companies or its investors.",
    "",
    "WHAT THE AGENCY SELLS:",
    PRODUCTIONS_OFFER,
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    `TASK — ${month}: find 10 organisations that plausibly need Community-as-a-Service RIGHT NOW, using`,
    "current sources. A good prospect has a TRIGGER in the last ~60 days: a product or programme launch,",
    "a community or events hire, a funding round, a new membership or ambassador programme, a conference",
    "or summit announced, a rebrand, an expansion into a new audience. Enterprise, national nonprofit,",
    "high-growth company, or community ecosystem. Vary the sectors.",
    "",
    "RULES:",
    "- Only organisations you can cite a live page for that SHOWS the trigger. No URL, no entry.",
    "- The person or ROLE to approach (a title is fine — 'Head of Community', 'VP Marketing'). Do NOT",
    "  invent a person's name or email; if you name a person it must appear on the cited page.",
    "- One line on the angle: why Community-as-a-Service fits what they are doing now.",
    "- Fewer, all real, beats ten with guesses.",
    "",
    'Return ONLY JSON: {"results":[{"organisation":"…","trigger":"…","approach":"…","angle":"…","url":"https://…"}]}',
  ].join("\n");
}

export function buildPressPrompt(month: string): string {
  return [
    walkerIdentity(),
    "",
    "You are working for Scooter's OWN agency, West Peek Productions — not for the fund.",
    "",
    "WHAT THE AGENCY SELLS:",
    PRODUCTIONS_OFFER,
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    `TASK — ${month}: find 5 journalists or newsletter writers who cover community-building, brand,`,
    "the creator economy, events, or go-to-market, and draft a pitch to each that Scooter can send",
    "himself. The story he can offer: what 'Community-as-a-Service' is, why community is an operating",
    "advantage rather than a channel, what 400+ virtual and hybrid productions taught about what makes",
    "people gather and stay, and published price bands in an industry that hides them.",
    "",
    "RULES:",
    "- Only writers you can cite a live, recent piece for on this beat (proof_url). No URL, no entry.",
    "- The writer's name and outlet as they appear on that page.",
    "- An email address ONLY if a live page shows it (a masthead, bio or contact page) — give that page",
    "  as contact_url. If no public address is shown, leave email null and give the outlet's contact or",
    "  tips page as contact_url. Never guess an address pattern.",
    "- why_this_writer: two lines on what they cover and why this fits. hook: the one-line subject.",
    "- draft: 90–140 words, first person as Scooter, no flattery, one specific ask (a 20-minute",
    "  conversation), no attachments promised.",
    "",
    'Return ONLY JSON: {"results":[{"writer":"…","outlet":"…","email":null,"contact_url":"https://…","why_this_writer":"…","hook":"…","proof_url":"https://…","draft":"…"}]}',
  ].join("\n");
}

// ── Rendering the email ──────────────────────────────────────────────────────

export function renderCustomerEmail(month: string, ideas: readonly CustomerIdea[], dropped: readonly string[]): string {
  const lines = [
    `Scooter — ${ideas.length} organisation(s) that could buy Community-as-a-Service this month (${month}).`,
    "Each one has a trigger you can point at, a role to approach, and the page it came from. Nobody has been contacted.",
    "",
    ...ideas.flatMap((i, n) => [
      `${n + 1}. ${i.organisation}`,
      `   Trigger: ${i.trigger}`,
      `   Approach: ${i.approach}`,
      ...(i.angle ? [`   Angle: ${i.angle}`] : []),
      `   Source: ${i.url}`,
      "",
    ]),
    dropped.length ? `Left out because the cited page did not answer when checked: ${dropped.join(", ")}` : "",
    "",
    "— Walker. This is West Peek Productions work, on your desk only; nothing here touches the fund.",
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

export function renderPressEmail(month: string, pitches: readonly PressPitch[], dropped: readonly string[]): string {
  const lines = [
    `Scooter — ${pitches.length} press pitch draft(s) for West Peek Productions (${month}). Copy, paste, send — nothing has been sent from here.`,
    "",
    ...pitches.flatMap((p, n) => [
      `${n + 1}. ${p.writer} — ${p.outlet}`,
      `   To: ${p.email ?? `no public address found — contact page: ${p.contactUrl ?? "not found"}`}`,
      ...(p.email && p.contactUrl ? [`   (address read from ${p.contactUrl})`] : []),
      `   Why this writer: ${p.whyThisWriter}`,
      `   Proof of beat: ${p.proofUrl}`,
      `   Subject: ${p.hook}`,
      "",
      "   ---",
      ...p.draft.split("\n").map((l) => `   ${l}`),
      "   ---",
      "",
    ]),
    dropped.length ? `Left out because the cited page did not answer when checked: ${dropped.join(", ")}` : "",
    "",
    "— Walker. Drafts only. The outbound gate stays: nothing leaves this system for a journalist.",
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

// ── The runner the sweep calls ───────────────────────────────────────────────

export type ProductionsSearch = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;

const defaultSearch: ProductionsSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Walker: West Peek Productions research",
    actor,
    inputs: [prompt],
    // Public web research; the query leaves for a search engine. Never raised.
    sensitivity: "PUBLIC" as never,
    budgetContext: { expectedOutputTokens: 2500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model !== SEARCH_MODEL) {
    return { ok: false, text: "", detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  }
  return { ok: true, text: run.output_text, detail: "ok" };
};

/**
 * Work one Productions card to a conclusion: search, verify, email Scooter, DONE — or BLOCKED with
 * the reason on the card when the search returned nothing usable.
 */
export async function runProductionsCard(
  env: Env,
  card: SweepCard,
  deps: { search?: ProductionsSearch; urlCheck?: UrlCheck; now?: Date } = {},
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const now = deps.now ?? new Date();
  const month = monthOf(now);
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: [card.firm_scope] };
  const search = deps.search ?? defaultSearch;
  const check = deps.urlCheck ?? defaultUrlCheck;
  const kind = card.kind as ProductionsKind;

  const found = await search(env, actor, kind === "PRODUCTIONS_CUSTOMERS" ? buildCustomerPrompt(month) : buildPressPrompt(month));
  if (!found.ok) {
    return { finished: false, blocked: false, detail: `the live search failed: ${found.detail}` };
  }

  let subject: string;
  let text: string;
  let count: number;
  let dropped: string[];
  if (kind === "PRODUCTIONS_CUSTOMERS") {
    const parsed = parseCustomerIdeas(found.text);
    const live = await keepLive(parsed, (i) => i.url, check);
    count = live.kept.length;
    dropped = live.dropped;
    subject = `Walker: ${count} who could buy Community-as-a-Service this month`;
    text = renderCustomerEmail(month, live.kept, live.dropped);
  } else {
    const parsed = parsePressPitches(found.text);
    const live = await keepLive(parsed, (p) => p.proofUrl, check);
    count = live.kept.length;
    dropped = live.dropped;
    subject = `Walker: ${count} press pitch drafts for West Peek Productions — yours to send`;
    text = renderPressEmail(month, live.kept, live.dropped);
  }

  if (count === 0) {
    const why = `The search returned nothing with a live citation (${dropped.length} cited page(s) did not answer). Nothing was emailed. Run it again, or tell Walker where to look.`;
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1").bind(card.id, why).run();
    return { finished: false, blocked: true, detail: why };
  }

  const mail = await emailPartnerDeliverable(env, {
    to: SCOOTER_EMAIL,
    subject,
    text,
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: "aie_walker",
  });

  const finding = [
    `• ${subject}`,
    mail.sent ? `• Emailed to ${SCOOTER_EMAIL}.` : `• NOT emailed to ${SCOOTER_EMAIL}: ${mail.reason}. The deliverable is below.`,
    "",
    text,
  ].join("\n");
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(card.id, finding).run();
  await appendEvent(env, {
    eventType: "productions.delivered",
    actorType: "ai_employee",
    actorId: "aie_walker",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { kind, month, count, dropped: dropped.length, emailed: mail.sent, subject },
  });
  return {
    finished: true,
    blocked: false,
    detail: mail.sent ? `${subject} — emailed to ${SCOOTER_EMAIL}` : `${subject} — on the card; email not sent (${mail.reason})`,
  };
}
