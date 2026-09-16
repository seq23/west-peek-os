import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { SEARCH_MODEL } from "./liveSearch";
import { pageTextOf, urlIsLive } from "../effects/urlLiveness";
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

export type ProductionsKind = "PRODUCTIONS_CUSTOMERS" | "PRODUCTIONS_PRESS" | "PRODUCTIONS_MONTHLY";

export const PRODUCTIONS_JOBS: Readonly<Record<string, { kind: ProductionsKind; title: (month: string) => string }>> = {
  // ONE EMAIL A MONTH. Operator, 15 Sep 2026: "why is scooter getting 2 emails?" — the customer
  // list and the press drafts were two jobs, two cards, two emails; a seam in the machinery
  // showing in his inbox. One card now does both and sends one note from his chief of staff.
  productions_monthly: {
    kind: "PRODUCTIONS_MONTHLY",
    title: (month) => `Walker: West Peek Productions this month (${month})`,
  },
  // The two earlier duties, kept so their past cards still read; their jobs are PAUSED (0166).
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
      job.kind === "PRODUCTIONS_MONTHLY"
        ? "This month's note to Scooter, in one email: (1) 10 organisations that plausibly need Community-as-a-Service right now — each with the trigger, the person or role to approach, a one-line angle, and the URL that shows the trigger; (2) pitches to 5 journalists or newsletter writers chosen with intent — why that writer, the hook, the address read off a live page and which page, a URL proving the beat — drafts for Scooter to send himself."
        : job.kind === "PRODUCTIONS_CUSTOMERS"
        ? "Find 10 organisations that plausibly need Community-as-a-Service right now — each with the trigger (a launch, a hire, a raise, a programme), the person or role to approach, a one-line angle, and the URL that shows the trigger."
        : "Draft pitches to 5 journalists or newsletter writers covering community, brand, the creator economy or go-to-market — each with why that writer, the hook, the writer's name and outlet, a public email address if a live page shows one (otherwise the contact page), and a URL proving the beat. Drafts for Scooter to send himself.",
    ].join("\n"),
    owner_type: "AI",
    owner_id: "aie_walker",
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: job.kind === "PRODUCTIONS_MONTHLY" ? "Search both, verify every URL, hunt the addresses, email Scooter once." : job.kind === "PRODUCTIONS_CUSTOMERS" ? "Search, verify every URL, email Scooter the ten." : "Search, verify every URL, email Scooter the five drafts.",
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
  /**
   * How the address was established: `personal` (the writer's own, read off a page), `outlet`
   * (a public inbox for the outlet — tips@, editors@ — read off a page), or null when none.
   */
  emailKind?: "personal" | "outlet" | null;
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
    // One entry per organisation, whatever the model did: the first run listed VK twice.
    if (out.some((o) => o.organisation.toLowerCase() === organisation.toLowerCase())) continue;
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
    "- Organisations in the United States, or serving a US audience, from English-language sources.",
    "  The first run of this duty (15 Sep 2026) returned Russian and French press pages; those are",
    "  not buyers of a New York agency. Each organisation ONCE — two triggers at one company is one entry.",
    "- Only organisations you can cite a live page for that SHOWS the trigger. No URL, no entry. The",
    "  url field is MANDATORY on every entry — an entry without it is discarded unread.",
    "- Organisations that actually HIRE agencies like this: brands, B2B software companies, creator",
    "  businesses, membership bodies and professional associations, conference producers, universities,",
    "  national nonprofits, high-growth startups. NOT government departments, militaries or programmes",
    "  that procure by tender — the 15 Sep 2026 run named the State Department and the Space Force.",
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
    `TASK — ${month}: choose 5 journalists or newsletter writers with INTENT, and draft a pitch to`,
    "each that Scooter can send himself. The story he can offer: what 'Community-as-a-Service' is, why",
    "community is an operating advantage rather than a channel, what 400+ virtual and hybrid productions",
    "taught about what makes people gather and stay, and published price bands in an industry that hides them.",
    "",
    "WHO TO CHOOSE — and why. The point of press is to be read by the people who BUY community work:",
    "heads of community, CMOs and brand leads, founders building a member base, event and experience",
    "leads. Pick the five as a deliberate mix, one from each:",
    "  1. TRADE PRESS those buyers read daily — marketing/brand trades (Digiday, Adweek, Marketing Brew,",
    "     Ad Age, Modern Retail, Fast Company's brand desk).",
    "  2. A CREATOR-ECONOMY or COMMUNITY NEWSLETTER with an operator audience (ICYMI, Lenny's, The",
    "     Publish Press, CreatorEconomy.so, Community Club / CMX writers).",
    "  3. A BUSINESS TITLE whose contributor or staff writer covers community, membership or the creator",
    "     economy (Forbes, Inc., Entrepreneur, Business Insider, Fortune).",
    "  4. AN EVENTS-INDUSTRY OUTLET (BizBash, Event Marketer, Skift Meetings, Eventbrite/Cvent blogs with",
    "     bylined reporting) — the people who book productions.",
    "  5. A WILDCARD earned by a specific recent piece: someone who just wrote about a company doing",
    "     community well, or about agencies/vendors in this space — the writer most likely to want a",
    "     follow-up now.",
    "Prefer writers whose recent piece QUOTES an operator, agency or community lead (they take vendor",
    "sources); avoid writers who only cover public companies or funding rounds. Each choice must name",
    "the recent piece it is earned by and the angle that piece makes natural — 'you wrote X; here is",
    "the number/operator view you did not have'. A writer chosen because their beat vaguely matches",
    "is not a choice.",
    "",
    "RULES:",
    "- Only writers you can cite a live, recent piece for on this beat (proof_url). No URL, no entry.",
    "- The writer's name and outlet as they appear on that page.",
    "- An email address ONLY if a live page shows it (a masthead, bio or contact page) — give that page",
    "  as contact_url. If no public address is shown, leave email null and give the outlet's contact or",
    "  tips page as contact_url. Never guess an address pattern. (The address is checked again afterwards",
    "  by reading the pages — see findWriterAddress — so cite where it is, not what it is.)",
    "- why_this_writer: which slot (1–5) they fill, the piece they are earned by, and the angle that",
    "  piece makes natural. hook: the one-line subject.",
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

// ── Finding the address ──────────────────────────────────────────────────────

/**
 * THE ADDRESS HUNT. Operator, 15 Sep 2026, on the first press run: "why couldn't u find these
 * journalists' emails — this seems weak and like it should have been achievable." It was: the
 * first run kept an address only if the one page the search cited happened to show it. A
 * journalist's address is usually one hop away — the author page, the newsletter's about/contact
 * page, a personal site, the masthead, or the outlet's public tips inbox. So for every pitch
 * without an address: ask the search engine specifically for pages that show it, fetch up to
 * five candidate pages, read the addresses off them, and prefer the one that carries the writer's
 * name; failing that, an outlet inbox read off an outlet page, labelled as such. An address is
 * never derived from a pattern and never taken from the model's memory — every one names the page
 * it was read from.
 */
export type PageText = (url: string) => Promise<string | null>;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export const defaultPageText: PageText = (url) => pageTextOf(url);

function outletDomainOf(url: string | null): string | null {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : null; } catch { return null; }
}

function urlsIn(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, ""))));
}

/** Addresses on a page, decoded from mailto: and plain text, junk (images, example.com) removed. */
export function addressesIn(pageText: string): string[] {
  const text = pageText.replace(/&#64;|&commat;/g, "@").replace(/\s?\[at\]\s?|\s\(at\)\s/gi, "@").replace(/\s?\[dot\]\s?/gi, ".");
  const found = new Set<string>();
  for (const m of text.match(EMAIL_RE) ?? []) {
    const a = m.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/.test(a)) continue;
    if (/example\.|sentry|wixpress|@2x|no-?reply|donotreply|privacy@|legal@|abuse@|support@|unsubscribe/i.test(a)) continue;
    found.add(a);
  }
  return [...found];
}

/** Pick the writer's own address from a page's addresses, else an outlet inbox, else nothing. */
export function chooseAddress(addresses: readonly string[], writer: string, outletDomain: string | null): { email: string; kind: "personal" | "outlet" } | null {
  const parts = writer.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const last = parts[parts.length - 1] ?? "";
  const first = parts[0] ?? "";
  const local = (a: string) => a.split("@")[0]!.replace(/[._-]/g, "");
  // The writer's own address carries their surname, or their first name with their initial, or
  // is simply their first name (newsletter writers: lia@…). Checked in that order.
  const personal =
    addresses.find((a) => last.length > 2 && local(a).includes(last)) ??
    addresses.find((a) => first.length > 2 && last && local(a).startsWith(first[0]! + last)) ??
    addresses.find((a) => first.length > 2 && (local(a) === first || local(a).startsWith(first) && local(a).length <= first.length + 2));
  if (personal) return { email: personal, kind: "personal" };
  const outlet = addresses.find((a) => outletDomain && a.endsWith("@" + outletDomain) && /^(tips|editors?|editorial|newsdesk|news|press|pitches|hello|contact|info|submissions)@/.test(a));
  if (outlet) return { email: outlet, kind: "outlet" };
  return null;
}

export async function findWriterAddress(
  env: Env,
  actor: Actor,
  pitch: PressPitch,
  deps: { search: ProductionsSearch; pageText: PageText },
): Promise<PressPitch> {
  const outletDomain = outletDomainOf(pitch.proofUrl);
  const candidates: string[] = [];
  const push = (u: string | null) => { if (u && !candidates.includes(u)) candidates.push(u); };
  push(pitch.contactUrl);
  push(pitch.proofUrl);
  const ask = await deps.search(
    env,
    actor,
    [
      `Find the public email address of ${pitch.writer}, who writes for ${pitch.outlet}. Look for: their author/bio page on ${outletDomain ?? "the outlet"},`,
      "the outlet's masthead or contact page, the writer's newsletter about/contact page (Substack, beehiiv), the writer's personal site, a Muck Rack or press-list profile that shows the address, and the outlet's public tips/pitches inbox.",
      "Return ONLY the URLs of pages that actually display an email address, one per line, most specific first. No addresses from memory.",
    ].join(" "),
  );
  if (ask.ok) for (const u of urlsIn(ask.text).slice(0, 6)) push(u);
  for (const url of candidates.slice(0, 6)) {
    const text = await deps.pageText(url);
    if (!text) continue;
    const pick = chooseAddress(addressesIn(text), pitch.writer, outletDomain);
    if (pick) return { ...pitch, email: pick.email, emailKind: pick.kind, contactUrl: url };
  }
  return { ...pitch, email: null, emailKind: null, contactUrl: pitch.contactUrl ?? candidates.find((u) => u !== pitch.proofUrl) ?? null };
}

/** The one monthly note: who Walker is, the leads, the pitches. */
export function renderMonthlyEmail(month: string, ideas: readonly CustomerIdea[], pitches: readonly PressPitch[], dropped: readonly string[]): string {
  const lines = [
    `Scooter — Walker, your chief of staff. This is West Peek Productions' month in one note: ${ideas.length} organisation(s) that could buy Community-as-a-Service, and ${pitches.length} press pitch draft(s) for you to send. Nobody has been contacted from here; that stays yours.`,
    "",
    `═══ 1 · WHO COULD BUY THIS MONTH (${month}) ═══`,
    "Each one has a trigger you can point at, a role to approach, and the page it came from.",
    "",
    ...ideas.flatMap((i, n) => [
      `${n + 1}. ${i.organisation}`,
      `   Trigger: ${i.trigger}`,
      `   Approach: ${i.approach}`,
      ...(i.angle ? [`   Angle: ${i.angle}`] : []),
      `   Source: ${i.url}`,
      "",
    ]),
    ideas.length === 0 ? "Nothing with a live citation this month — say where to look and I will." : "",
    "",
    `═══ 2 · PRESS PITCHES — YOURS TO SEND ═══`,
    "Copy, paste, send. Each address was read off the page named under it.",
    "",
    ...pitches.flatMap((p, n) => [
      `${n + 1}. ${p.writer} — ${p.outlet}`,
      `   To: ${p.email ?? `no public address on any page checked — write via ${p.contactUrl ?? "the outlet's contact page"}`}`,
      ...(p.email && p.contactUrl ? [`   (${p.emailKind === "outlet" ? "the outlet's public inbox, not the writer's own" : "the writer's own address"} — read from ${p.contactUrl})`] : []),
      `   Why this writer: ${p.whyThisWriter}`,
      `   Proof of beat: ${p.proofUrl}`,
      `   Subject: ${p.hook}`,
      "",
      "   ---",
      ...p.draft.split("\n").map((l) => `   ${l}`),
      "   ---",
      "",
    ]),
    pitches.length === 0 ? "No writer with a live citation this month — say where to look and I will." : "",
    dropped.length ? `Left out because the cited page did not answer when checked: ${dropped.join(", ")}` : "",
    "",
    "— Walker. Anything you want from me or the team: email os@joinwestpeek.com from this address and Porter routes it. This is Productions work, on your desk only; nothing here touches the fund.",
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

export function renderPressEmail(month: string, pitches: readonly PressPitch[], dropped: readonly string[]): string {
  const lines = [
    `Scooter — ${pitches.length} press pitch draft(s) for West Peek Productions (${month}). Copy, paste, send — nothing has been sent from here.`,
    "",
    ...pitches.flatMap((p, n) => [
      `${n + 1}. ${p.writer} — ${p.outlet}`,
      `   To: ${p.email ?? `no public address on any page checked — write via ${p.contactUrl ?? "the outlet's contact page"}`}`,
      ...(p.email && p.contactUrl ? [`   (${p.emailKind === "outlet" ? "the outlet's public inbox, not the writer's own" : "the writer's own address"} — read from ${p.contactUrl})`] : []),
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
  deps: { search?: ProductionsSearch; urlCheck?: UrlCheck; pageText?: PageText; now?: Date } = {},
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const now = deps.now ?? new Date();
  const month = monthOf(now);
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: [card.firm_scope] };
  const search = deps.search ?? defaultSearch;
  const check = deps.urlCheck ?? defaultUrlCheck;
  const kind = card.kind as ProductionsKind;

  /** One search, and one more with the miss named if nothing usable came back. `why` is for the card. */
  async function searchUntilSome<T>(
    prompt: string,
    parse: (text: string) => Promise<{ kept: T[]; dropped: string[] }>,
    nudge: string,
  ): Promise<{ kept: T[]; dropped: string[]; why: string }> {
    let why = "";
    for (const attempt of [prompt, `${prompt}\n\n${nudge}`]) {
      const found = await search(env, actor, attempt);
      if (!found.ok) { why = `the live search failed: ${found.detail}`; continue; }
      const parsed = await parse(found.text);
      if (parsed.kept.length) return { ...parsed, why: "" };
      why = parsed.dropped.length ? `every cited page was dead: ${parsed.dropped.join(", ")}` : "the search answered with no usable entry (no url on any)";
    }
    return { kept: [], dropped: [], why };
  }

  let subject: string;
  let text: string;
  let count: number;
  let dropped: string[];
  if (kind === "PRODUCTIONS_MONTHLY") {
    const pageText = deps.pageText ?? defaultPageText;
    // BOTH HALVES OR NOTHING. The first monthly note (16 Sep 2026, 00:02Z) went to Scooter reading
    // "0 customer lead(s) and 4 press pitch(es)": the customer search had answered without a url on
    // any entry, the parser rightly dropped them all, and the card still emailed and went DONE. A
    // half note is worse than none — it reads as the work having been done. So a half that comes
    // back empty is searched once more with the miss named, and if either half is still empty the
    // card is BLOCKED with the reason on it and no email goes out.
    const ideas = await searchUntilSome(
      buildCustomerPrompt(month),
      (text) => keepLive(parseCustomerIdeas(text), (i) => i.url, check),
      "Your previous answer was discarded: no entry carried a url. Every entry MUST have the url of the live page that shows the trigger.",
    );
    const pitchesLive = await searchUntilSome(
      buildPressPrompt(month),
      (text) => keepLive(parsePressPitches(text), (p) => p.proofUrl, check),
      "Your previous answer was discarded: no entry carried a live proof_url. Every entry MUST have the url of a live page proving the beat.",
    );
    const missing = [
      ideas.kept.length === 0 ? `no customer lead survived (${ideas.why})` : null,
      pitchesLive.kept.length === 0 ? `no press pitch survived (${pitchesLive.why})` : null,
    ].filter((m): m is string => m !== null);
    if (missing.length) {
      const why = `Not sending a half note — ${missing.join("; ")}. Nothing was emailed. Run it again, or tell Walker where to look.`;
      await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1").bind(card.id, why).run();
      return { finished: false, blocked: true, detail: why };
    }
    const hunted: PressPitch[] = [];
    for (const p of pitchesLive.kept) hunted.push(await findWriterAddress(env, actor, { ...p, email: null }, { search, pageText }));
    count = ideas.kept.length + hunted.length;
    dropped = [...ideas.dropped, ...pitchesLive.dropped];
    subject = `Walker: West Peek Productions this month — ${ideas.kept.length} customer lead(s) and ${hunted.length} press pitch(es)`;
    text = renderMonthlyEmail(month, ideas.kept, hunted, dropped);
  } else {
  const found = await search(env, actor, kind === "PRODUCTIONS_CUSTOMERS" ? buildCustomerPrompt(month) : buildPressPrompt(month));
  if (!found.ok) {
    return { finished: false, blocked: false, detail: `the live search failed: ${found.detail}` };
  }
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
    // EVERY ADDRESS IS READ OFF A PAGE, including one the model offered: the hunt re-reads it.
    const pageText = deps.pageText ?? defaultPageText;
    const hunted: PressPitch[] = [];
    for (const p of live.kept) hunted.push(await findWriterAddress(env, actor, { ...p, email: null }, { search, pageText }));
    live.kept = hunted;
    count = live.kept.length;
    dropped = live.dropped;
    subject = `Walker: ${count} press pitch drafts for West Peek Productions — yours to send`;
    text = renderPressEmail(month, live.kept, live.dropped);
  }
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

// ── One note, once ───────────────────────────────────────────────────────────

/**
 * WALKER INTRODUCES HIMSELF AND OWNS THE FIRST RUN. Operator, 15 Sep 2026: "send scooter another
 * email acknowledging the first one was bad and maybe walker should introduce himself in that
 * email too … and a reminder that any emails scooter wants to send should be to
 * os@joinwestpeek.com and those get routed via Porter." Sent through the partner-email path so it
 * is on the record like everything else an employee sends; the job pauses itself after one send.
 */
export function renderIntroNote(): { subject: string; text: string } {
  return {
    subject: "Walker, your chief of staff — about that first Productions email, and how to reach me",
    text: [
      "Scooter —",
      "",
      "I'm Walker, your chief of staff in West Peek OS. I should have introduced myself before the first two emails landed in your inbox, so: that is who was writing.",
      "",
      "The first customer list was below the standard you should expect from me. The search wandered — a couple of the ten were not US-market companies, one appeared twice — and the press drafts came with almost no addresses because I only kept an address if the single page I cited happened to show one. Both are fixed: the customer search is now restricted to the US market with one entry per organisation, and for every writer I now go and find the page that shows their address (author page, masthead, newsletter contact page, personal site, or the outlet's tips inbox) and tell you which page it came from. The five writers are chosen with intent — a mix of the trade press your buyers read, a creator/community newsletter, a business title, an events-industry outlet, and one earned by a specific recent piece — not by beat alone.",
      "",
      "You will get two emails from me on the first of each month: ten organisations that could buy Community-as-a-Service, and five press pitches drafted for you to send. Nothing goes to a prospect or a journalist from here; that stays yours.",
      "",
      "If you want anything from me or the team, email os@joinwestpeek.com from this address. Porter routes it to whoever's job it is — usually me — and the finished work comes back to your inbox.",
      "",
      "— Walker",
    ].join("\n"),
  };
}

/** The scheduled branch: send once, record it, pause the job. Rule 0: a second run says why it did nothing. */
export async function runIntroNote(env: Env): Promise<{ status: "SUCCEEDED" | "FAILED"; summary: string }> {
  const already = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'deliverable.emailed_to_partner' AND payload_json LIKE '%Walker, your chief of staff%'",
  ).first<{ n: number }>();
  if ((already?.n ?? 0) > 0) {
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'Sent once on its first run; a second introduction would be noise.' WHERE job_key = 'productions_intro_note'").run();
    return { status: "SUCCEEDED", summary: "already sent; the job paused itself" };
  }
  const note = renderIntroNote();
  const mail = await emailPartnerDeliverable(env, { to: SCOOTER_EMAIL, subject: note.subject, text: note.text, objectType: "scheduled_job", objectId: "sjb_productions_intro_note", firmScope: "west-peek", actorId: "aie_walker" });
  if (!mail.sent) return { status: "FAILED", summary: `not sent: ${mail.reason}` };
  await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'Sent once (Walker introduced himself). Kept as the record of it.' WHERE job_key = 'productions_intro_note'").run();
  return { status: "SUCCEEDED", summary: `sent to ${SCOOTER_EMAIL}: "${note.subject}"; the job paused itself` };
}
