import type { Env } from "../env";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { SEARCH_MODEL } from "./liveSearch";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import { pageTextOf, urlIsLive } from "../effects/urlLiveness";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { sendPartnerEmail } from "./execEmail";
import type { ExecEmailInput } from "../../shared/email/execEmail";
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

/**
 * WHO ALREADY BUYS (16 Sep 2026, from the operator). Two uses, both mandatory: the customer search
 * is told to find organisations LIKE these, and a search result that names one of them is dropped
 * before it reaches Scooter — a lead list that pitches a current customer reads as not knowing the
 * business. One list, read by the prompt, the judge, the exclusion and the skill text.
 */
export interface ProductionsCustomer {
  name: string;
  /** Other names a search result might use for the same organisation. */
  aliases: readonly string[];
  what: string;
  bought: string;
  /** The look-alike this customer seeds: what to search for because of them. */
  lookAlike: string;
}

export const PRODUCTIONS_CUSTOMERS: readonly ProductionsCustomer[] = [
  {
    name: "Exec Leadership Council",
    aliases: ["Executive Leadership Council", "MLM Symposium"],
    what: "runs the MLM Symposium, a meeting and conference for mid-level managers, 29–30 October 2026",
    bought: "the event platform and virtual event production",
    lookAlike: "associations and councils running an annual symposium or managers' conference that need a virtual or hybrid platform and production",
  },
  {
    name: "TNTP",
    aliases: ["The New Teacher Project"],
    what: "a foundation with a small marketing team, not up to date on trends, social, virtual or AI",
    bought: "community, content and virtual work its own team is not staffed for",
    lookAlike: "foundations and nonprofits with small marketing teams who are behind on social, virtual and AI",
  },
];

/** The customer, when a search result names one; null when it does not. Case-insensitive, aliases included. */
export function currentCustomerNamed(text: string): ProductionsCustomer | null {
  const hay = text.toLowerCase();
  for (const c of PRODUCTIONS_CUSTOMERS) {
    if ([c.name, ...c.aliases].some((n) => hay.includes(n.toLowerCase()))) return c;
  }
  return null;
}

/** Leads that name a current customer are not leads. `excluded` carries the reason for the note. */
export function excludeCurrentCustomers(ideas: readonly CustomerIdea[]): { kept: CustomerIdea[]; excluded: { name: string; reason: string }[] } {
  const kept: CustomerIdea[] = [];
  const excluded: { name: string; reason: string }[] = [];
  for (const i of ideas) {
    const c = currentCustomerNamed(`${i.organisation} ${i.trigger} ${i.url}`);
    if (c) excluded.push({ name: i.organisation, reason: `a current customer (${c.name}) — never listed as a lead` });
    else kept.push(i);
  }
  return { kept, excluded };
}

/** The customer block the search prompt and the judge both carry. */
export function customersBlock(): string {
  return [
    "CURRENT CUSTOMERS — the look-alike seeds, and NEVER a lead:",
    ...PRODUCTIONS_CUSTOMERS.map((c) => `- ${c.name}: ${c.what}; bought ${c.bought}. Find more like this: ${c.lookAlike}.`),
    "Find organisations like these — associations and councils running annual symposia or manager",
    "conferences that need a virtual/hybrid platform; foundations and nonprofits with small marketing",
    "teams behind on social, virtual and AI — and never list a current customer.",
  ].join("\n");
}

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

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

export function jsonBody(raw: string): Record<string, unknown> | null {
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

export function walkerIdentity(): string {
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
    customersBlock(),
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
    "- At least three of the ten should be look-alikes of the current customers above (a council or",
    "  association with an annual symposium; a foundation with a small marketing team). None may BE",
    "  a current customer.",
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
export function renderMonthlyEmail(month: string, ideas: readonly CustomerIdea[], pitches: readonly PressPitch[], dropped: readonly string[], rejected: readonly { name: string; reason: string }[] = []): string {
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
    rejected.length ? `Left out on judgement (searched, then held to the brief and failed it): ${rejected.map((r) => `${r.name} — ${r.reason}`).join("; ")}` : "",
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

// ── The executive summary above the note ────────────────────────────────────

/**
 * What a busy reader sees first (16 Sep 2026): counts, names, and what is theirs to do. The full
 * note — every trigger, every draft — is the details under it. Nobody is contacted from here.
 */
function names(list: readonly string[], max = 4): string {
  const shown = list.slice(0, max).map((n) => `**${n}**`);
  return list.length > max ? `${shown.join(", ")} and ${list.length - max} more` : shown.join(", ");
}

export function monthlySummary(
  month: string,
  ideas: readonly CustomerIdea[],
  pitches: readonly PressPitch[],
  dropped: readonly string[],
  rejected: readonly { name: string; reason: string }[],
): { what: string; tldr: string; sections: ExecEmailInput["sections"] } {
  const withAddress = pitches.filter((p) => p.email).length;
  return {
    what: `West Peek Productions this month — ${ideas.length} lead(s), ${pitches.length} pitch(es)`,
    tldr: `${ideas.length} organisation(s) that could buy Community-as-a-Service this month and ${pitches.length} press pitch draft(s) ready to send. Nobody has been contacted; you choose who to approach.`,
    sections: [
      { label: "What you asked", bullets: [`The monthly Productions note for ${month}: who could buy, and who to pitch.`] },
      {
        label: "What I did",
        bullets: [
          "Searched live sources for buyers with a trigger in the last ~60 days and writers earned by a recent piece.",
          "Checked every cited page is live, then held each entry to the brief in a second judgement pass.",
          `Hunted an address for every writer: **${withAddress}** of **${pitches.length}** read off a live page.`,
        ],
      },
      {
        label: "What I found",
        bullets: [
          ...(ideas.length ? [`Leads: ${names(ideas.map((i) => i.organisation))}.`] : ["No customer lead survived the checks this month."]),
          ...(pitches.length ? [`Writers: ${names(pitches.map((p) => `${p.writer} (${p.outlet})`))}.`] : ["No writer survived the checks this month."]),
          ...(dropped.length ? [`Dropped ${dropped.length} entry(ies) whose cited page did not answer.`] : []),
          ...(rejected.length ? [`Rejected ${rejected.length} on judgement; the reasons are in the details.`] : []),
        ],
      },
      { label: "Your call", bullets: ["Pick the leads to approach and the pitches to send — they are drafted in your voice below.", "Nothing goes to a prospect or a journalist from here."] },
    ],
  };
}

export function customerSummary(month: string, ideas: readonly CustomerIdea[], dropped: readonly string[]): { what: string; tldr: string; sections: ExecEmailInput["sections"] } {
  return {
    what: `${ideas.length} who could buy Community-as-a-Service this month`,
    tldr: `${ideas.length} organisation(s) with a live trigger that could buy Community-as-a-Service this month. Nobody has been contacted; you choose who to approach.`,
    sections: [
      { label: "What you asked", bullets: [`Customer ideas for West Peek Productions, ${month}.`] },
      { label: "What I found", bullets: [ideas.length ? `Leads: ${names(ideas.map((i) => i.organisation))}.` : "Nothing with a live citation this month.", ...(dropped.length ? [`Dropped ${dropped.length} whose cited page did not answer.`] : [])] },
      { label: "Your call", bullets: ["Pick who to approach; each entry below has the trigger, the role and the page."] },
    ],
  };
}

export function pressSummary(month: string, pitches: readonly PressPitch[], dropped: readonly string[]): { what: string; tldr: string; sections: ExecEmailInput["sections"] } {
  return {
    what: `${pitches.length} press pitch drafts — yours to send`,
    tldr: `${pitches.length} press pitch draft(s) for West Peek Productions, each earned by a recent piece. Yours to send; nothing has gone out.`,
    sections: [
      { label: "What you asked", bullets: [`Press pitches for West Peek Productions, ${month}.`] },
      { label: "What I found", bullets: [pitches.length ? `Writers: ${names(pitches.map((p) => `${p.writer} (${p.outlet})`))}.` : "No writer with a live citation this month.", ...(dropped.length ? [`Dropped ${dropped.length} whose cited page did not answer.`] : [])] },
      { label: "Your call", bullets: ["Copy, paste and send the ones you like; each draft below names the page its address came from."] },
    ],
  };
}

// ── The runner the sweep calls ───────────────────────────────────────────────

/**
 * THE JUDGEMENT PASS. The search model (perplexity/sonar) finds pages; it does not keep rules. The
 * 16 Sep 2026 run, on a prompt that said "United States" and "no government", sent Scooter VK
 * (Russian), a 2025 college-basketball schedule and the Space Force. So every lead and every pitch
 * that survives the live-URL check is put to a second, stronger model with the rules and a verdict
 * per entry; what fails is dropped and the reason kept for the card. The judge does not search —
 * it reads what the searcher wrote and holds it to the brief.
 */
export type ProductionsJudge = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;

export interface Verdict {
  keep: boolean;
  reason: string;
}

export function buildLeadJudgePrompt(month: string, ideas: readonly CustomerIdea[]): string {
  return [
    walkerIdentity(),
    "",
    "You are the JUDGE, not the researcher. A web-search model produced the customer leads below for",
    "West Peek Productions, Scooter's Community-as-a-Service agency in New York. Hold each one to the",
    "brief and return a verdict per lead. Be strict: fewer, all real, beats ten with a stretch.",
    "",
    "WHAT THE AGENCY SELLS:",
    PRODUCTIONS_OFFER,
    "",
    customersBlock(),
    "",
    `KEEP a lead only if ALL of these hold (this month is ${month}):`,
    "- It is an organisation that actually hires an agency like this: a brand, a B2B software",
    "  company, a creator business, a membership body or professional association, a conference",
    "  producer, a university, a national nonprofit, a high-growth startup.",
    "- It is in the United States or plainly serves a US audience. (VK is Russian. A .ru press page is",
    "  not a US buyer.)",
    "- The trigger is a real, recent event — within roughly the last 60 days of this month — and is",
    "  the KIND of thing that creates a need for community, experiences or content: a launch, a",
    "  community or events hire, a raise, a new programme, a summit announced, a rebrand, a new audience.",
    "  A schedule announcement from last year is not a trigger. A news release existing is not a trigger.",
    "- The cited URL plausibly belongs to that organisation or to a page about it (a source page for",
    "  a DIFFERENT organisation, or a generic listing, fails).",
    "DROP government departments, militaries, and anything that reads as a media outlet being",
    "counted as a buyer because it happened to publish the trigger. DROP a current customer.",
    "",
    "LEADS:",
    JSON.stringify(ideas.map((i) => ({ organisation: i.organisation, trigger: i.trigger, approach: i.approach, angle: i.angle, url: i.url })), null, 1),
    "",
    'Return ONLY JSON: {"verdicts":[{"organisation":"…","keep":true,"reason":"one line"}]} — one verdict per lead, in order, organisation copied exactly.',
  ].join("\n");
}

export function buildPitchJudgePrompt(month: string, pitches: readonly PressPitch[]): string {
  return [
    walkerIdentity(),
    "",
    "You are the JUDGE, not the researcher. A web-search model produced the press pitches below for",
    "Scooter to send about West Peek Productions. Hold each one to the brief and return a verdict per",
    "pitch. Be strict: a pitch Scooter would be embarrassed to send is worse than no pitch.",
    "",
    "WHAT THE AGENCY SELLS:",
    PRODUCTIONS_OFFER,
    "",
    `KEEP a pitch only if ALL of these hold (this month is ${month}):`,
    "- The writer is named and the 'why this writer' names a beat or a specific piece that a person",
    "  covering community, brand, events, the creator economy or go-to-market would recognise. A",
    "  pitch whose own reasoning admits it is 'an outlet contact, not a writer-earned pitch' or 'the",
    "  weakest of the five' fails.",
    "- The outlet is one that could plausibly cover a New York community-and-events agency for a US",
    "  business readership.",
    "- The hook is specific to that writer, not the agency's positioning restated.",
    "- The draft is short, sendable as-is by Scooter, and does not claim a fact the offer does not state.",
    "",
    "PITCHES:",
    JSON.stringify(pitches.map((p) => ({ writer: p.writer, outlet: p.outlet, why_this_writer: p.whyThisWriter, hook: p.hook, proof_url: p.proofUrl, draft: p.draft })), null, 1),
    "",
    'Return ONLY JSON: {"verdicts":[{"writer":"…","keep":true,"reason":"one line"}]} — one verdict per pitch, in order, writer copied exactly.',
  ].join("\n");
}

/** Verdicts keyed by the entry's name; an entry the judge did not mention is dropped, not waved through. */
export function parseVerdicts(raw: string, keyField: "organisation" | "writer"): Map<string, Verdict> {
  const p = jsonBody(raw);
  const out = new Map<string, Verdict>();
  for (const r of Array.isArray(p?.verdicts) ? (p!.verdicts as Record<string, unknown>[]) : []) {
    const key = str(r[keyField]);
    if (!key) continue;
    out.set(key.toLowerCase(), { keep: r.keep === true, reason: str(r.reason) ?? "no reason given" });
  }
  return out;
}

export async function judgeEntries<T>(
  env: Env,
  actor: Actor,
  entries: readonly T[],
  prompt: string,
  keyOf: (t: T) => string,
  keyField: "organisation" | "writer",
  judge: ProductionsJudge,
): Promise<{ kept: T[]; rejected: { name: string; reason: string }[]; failed: string | null }> {
  if (entries.length === 0) return { kept: [], rejected: [], failed: null };
  const found = await judge(env, actor, prompt);
  if (!found.ok) return { kept: [], rejected: [], failed: found.detail };
  const verdicts = parseVerdicts(found.text, keyField);
  if (verdicts.size === 0) return { kept: [], rejected: [], failed: "the judge answered with no verdicts" };
  const kept: T[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const e of entries) {
    const v = verdicts.get(keyOf(e).toLowerCase());
    if (v?.keep) kept.push(e);
    else rejected.push({ name: keyOf(e), reason: v?.reason ?? "the judge gave no verdict on it" });
  }
  return { kept, rejected, failed: null };
}

const defaultJudge: ProductionsJudge = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Walker: West Peek Productions judgement",
    actor,
    inputs: [prompt],
    // Judging public research; nothing of the firm's leaves.
    sensitivity: "PUBLIC" as never,
    // No preferred model: the router's default (a Claude model) reads and reasons; it must not search.
    budgetContext: { expectedOutputTokens: 1200, providerKey: "openrouter", judgement: true },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model === SEARCH_MODEL) return { ok: false, text: "", detail: "the judgement was routed to the search model" };
  return { ok: true, text: run.output_text, detail: "ok" };
};

export type ProductionsSearch = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;

const defaultSearch: ProductionsSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Walker: West Peek Productions research",
    actor,
    inputs: [prompt],
    // Public web research; the query leaves for a search engine. Never raised.
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: true, expectedOutputTokens: 2500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
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
/**
 * What this duty can actually do, for the interpretation pass. The model is shown this list and
 * asked which of his directives change one of these steps and which ask for something none of them
 * does — without it, "also pitch them a budget" would come back as an honourable steer.
 */
export const PRODUCTIONS_STEPS: readonly string[] = [
  "Run one live search for the month, against the agency's own customer list and exclusions.",
  "Check every cited page is live, and drop anything whose page is dead.",
  "Judge what came back and keep only what is genuinely usable, rejecting the rest with a reason.",
  "Send Scooter ONE email in the busy-executive format with what was found.",
  "Nobody outside the firm is contacted, nothing is pitched, nothing is booked and no money is committed.",
];

export async function runProductionsCard(
  env: Env,
  card: SweepCard,
  deps: { search?: ProductionsSearch; judge?: ProductionsJudge; urlCheck?: UrlCheck; pageText?: PageText; now?: Date; interpret?: Interpreter } = {},
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const now = deps.now ?? new Date();
  const month = monthOf(now);
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: [card.firm_scope] };
  const kind = card.kind as ProductionsKind;
  const check = deps.urlCheck ?? defaultUrlCheck;

  /*
   * WHAT SCOOTER HAS ASKED FOR ON THIS PARTICULAR MONTH, READ BY A MODEL FIRST.
   *
   * This is a SCHEDULED duty, so the usual card carries no human prose at all and `steerFor`
   * returns without calling a model — a monthly note costs nothing extra. What it could not see
   * before was the exceptional month: a steering note left while the search was running, an
   * instruction typed onto the card, or the answer given to clear a block. Those went into columns
   * this runner never read, so "try the UK this time" changed nothing and the same search ran again.
   *
   * The block is Scooter's to clear, not Sequoia's: this is his agency's work and a notice about it
   * on her desk would be the wrong desk (see announceOutcome in workSweep.ts).
   */
  const steer = await steerFor(env, actor, {
    cardId: card.id,
    cardKind: kind,
    title: card.title,
    employee: "Walker",
    chain: "a monthly duty for West Peek Productions",
    steps: [...PRODUCTIONS_STEPS],
    firmScope: card.firm_scope,
  }, deps.interpret);
  if (steer.cannot.length > 0) {
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: "Walker",
      who: "SCOOTER",
      detail: steer.failure ? undefined : cannotDetail("Walker", steer.cannot),
    });
    return { finished: false, blocked: true, detail: why };
  }
  const withSteer = (prompt: string): string => (steer.text ? `${steer.text}\n\n${prompt}` : prompt);
  const rawSearch = deps.search ?? defaultSearch;
  const search: ProductionsSearch = (e, a, prompt) => rawSearch(e, a, withSteer(prompt));
  const rawJudge = deps.judge ?? defaultJudge;
  const judge: ProductionsJudge = (e, a, prompt) => rawJudge(e, a, withSteer(prompt));

  /** One search, and one more with the miss named if nothing usable came back. `why` is for the card. */
  type Judged<T> = { kept: T[]; dropped: string[]; rejected: { name: string; reason: string }[]; failed: string | null };
  async function searchUntilSome<T>(
    prompt: string,
    parse: (text: string) => Promise<Judged<T>>,
    nudge: string,
  ): Promise<Judged<T> & { why: string }> {
    let why = "";
    let last: Judged<T> = { kept: [], dropped: [], rejected: [], failed: null };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const found = await search(env, actor, attempt === 0 ? prompt : `${prompt}\n\n${nudge}`);
      if (!found.ok) { why = `the live search failed: ${found.detail}`; continue; }
      const parsed = await parse(found.text);
      last = parsed;
      if (parsed.failed) return { ...parsed, why: `the judgement pass failed: ${parsed.failed}` };
      if (parsed.kept.length) return { ...parsed, why: "" };
      why = parsed.rejected.length
        ? `the judge rejected every entry: ${parsed.rejected.map((r) => `${r.name} — ${r.reason}`).join("; ")}`
        : parsed.dropped.length ? `every cited page was dead: ${parsed.dropped.join(", ")}` : "the search answered with no usable entry (no url on any)";
      // The second attempt is told what was wrong with the first, so it is not the same answer twice.
      nudge = `${nudge} Rejected last time: ${parsed.rejected.map((r) => `${r.name} (${r.reason})`).join("; ") || "nothing usable was returned"}.`;
    }
    return { ...last, kept: [], why };
  }

  let subject: string;
  let text: string;
  let count: number;
  let dropped: string[];
  /** The busy-executive summary; `text` (the full note) goes under its details. */
  let summary: { what: string; tldr: string; sections: ExecEmailInput["sections"] };
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
      async (text) => {
        // A current customer is not a lead, whatever the searcher and the judge think of it.
        const fresh = excludeCurrentCustomers(parseCustomerIdeas(text));
        const live = await keepLive(fresh.kept, (i) => i.url, check);
        const judged = await judgeEntries(env, actor, live.kept, buildLeadJudgePrompt(month, live.kept), (i) => i.organisation, "organisation", judge);
        return { ...judged, rejected: [...fresh.excluded, ...judged.rejected], dropped: live.dropped };
      },
      "Your previous answer was discarded. Every entry MUST have the url of the live page that shows the trigger, be a US organisation that hires agencies, and have a trigger from the last ~60 days.",
    );
    const pitchesLive = await searchUntilSome(
      buildPressPrompt(month),
      async (text) => {
        const live = await keepLive(parsePressPitches(text), (p) => p.proofUrl, check);
        const judged = await judgeEntries(env, actor, live.kept, buildPitchJudgePrompt(month, live.kept), (p) => p.writer, "writer", judge);
        return { ...judged, dropped: live.dropped };
      },
      "Your previous answer was discarded. Every entry MUST have a live proof_url, a named writer whose beat is shown, and a hook specific to that writer.",
    );
    const rejected = [...ideas.rejected, ...pitchesLive.rejected];
    const missing = [
      ideas.kept.length === 0 ? `no customer lead survived (${ideas.why})` : null,
      pitchesLive.kept.length === 0 ? `no press pitch survived (${pitchesLive.why})` : null,
    ].filter((m): m is string => m !== null);
    if (missing.length) {
      const why = await blockCard(env, card, {
        reason: "nothing_good_enough_to_send",
        trying: card.title,
        employee: "Walker",
        who: "SCOOTER",
        detail: `Tell Walker where to look, or leave it this month — ${missing.join("; ")}, and he will not send half a note.`,
      });
      return { finished: false, blocked: true, detail: why };
    }
    const hunted: PressPitch[] = [];
    for (const p of pitchesLive.kept) hunted.push(await findWriterAddress(env, actor, { ...p, email: null }, { search, pageText }));
    count = ideas.kept.length + hunted.length;
    dropped = [...ideas.dropped, ...pitchesLive.dropped];
    subject = `Walker: West Peek Productions this month — ${ideas.kept.length} customer lead(s) and ${hunted.length} press pitch(es)`;
    text = renderMonthlyEmail(month, ideas.kept, hunted, dropped, rejected);
    summary = monthlySummary(month, ideas.kept, hunted, dropped, rejected);
  } else {
  const found = await search(env, actor, kind === "PRODUCTIONS_CUSTOMERS" ? buildCustomerPrompt(month) : buildPressPrompt(month));
  if (!found.ok) {
    return { finished: false, blocked: false, detail: `the live search failed: ${found.detail}` };
  }
  if (kind === "PRODUCTIONS_CUSTOMERS") {
    const parsed = excludeCurrentCustomers(parseCustomerIdeas(found.text)).kept;
    const live = await keepLive(parsed, (i) => i.url, check);
    count = live.kept.length;
    dropped = live.dropped;
    subject = `Walker: ${count} who could buy Community-as-a-Service this month`;
    text = renderCustomerEmail(month, live.kept, live.dropped);
    summary = customerSummary(month, live.kept, live.dropped);
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
    summary = pressSummary(month, live.kept, live.dropped);
  }
  }

  if (count === 0) {
    const why = await blockCard(env, card, {
      reason: "nothing_good_enough_to_send",
      trying: card.title,
      employee: "Walker",
      who: "SCOOTER",
      detail: `Tell Walker where to look, or leave it this round — every page he found led nowhere (${dropped.length} checked) and nothing was emailed.`,
    });
    return { finished: false, blocked: true, detail: why };
  }

  const mail = await sendPartnerEmail(env, {
    to: SCOOTER_EMAIL,
    email: { employee: "Walker", what: summary.what, tldr: summary.tldr, sections: summary.sections, details: text },
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    actorId: "aie_walker",
  });
  subject = mail.subject;

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
    "SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'deliverable.emailed_to_partner' AND object_type = 'scheduled_job' AND object_id = 'sjb_productions_intro_note'",
  ).first<{ n: number }>();
  if ((already?.n ?? 0) > 0) {
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'Sent once on its first run; a second introduction would be noise.' WHERE job_key = 'productions_intro_note' AND status = 'ACTIVE'").run();
    return { status: "SUCCEEDED", summary: "already sent; the job paused itself" };
  }
  const note = renderIntroNote();
  const mail = await sendPartnerEmail(env, {
    to: SCOOTER_EMAIL,
    email: {
      employee: "Walker",
      what: "your chief of staff — about that first email, and how to reach me",
      tldr: "I'm Walker, your chief of staff. The first Productions email was below standard; the search and the address hunt are fixed. Reply here or write to os@joinwestpeek.com for anything.",
      sections: [
        { label: "What was wrong", bullets: ["The customer list wandered outside the US market and repeated an entry.", "The press drafts came with almost no addresses."] },
        { label: "What changed", bullets: ["Customer search is US-only, one entry per organisation.", "Every writer's address is hunted across live pages and the page is named.", "Five writers chosen with intent: trade press, a newsletter, a business title, an events outlet, one earned by a recent piece."] },
        { label: "Your call", bullets: ["Nothing now. One note from me on the first of each month; nothing goes to a prospect or a journalist from here."] },
      ],
      details: note.text,
    },
    objectType: "scheduled_job",
    objectId: "sjb_productions_intro_note",
    firmScope: "west-peek",
    actorId: "aie_walker",
  });
  if (!mail.sent) return { status: "FAILED", summary: `not sent: ${mail.reason}` };
  await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'Sent once (Walker introduced himself). Kept as the record of it.' WHERE job_key = 'productions_intro_note' AND status = 'ACTIVE'").run();
  return { status: "SUCCEEDED", summary: `sent to ${SCOOTER_EMAIL}: "${note.subject}"; the job paused itself` };
}
