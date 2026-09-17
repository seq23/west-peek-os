import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { SEARCH_MODEL } from "./liveSearch";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import { urlStatus } from "../effects/urlLiveness";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { sendPartnerEmail } from "./execEmail";
import { deliver } from "./deliverables";
import { notifyQuietly } from "./notifications";
import { isoWeekOf } from "./jobs";
import { standingSteer } from "./emailThread";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { guidanceBlock } from "../../shared/skills/library";
import {
  PRODUCTIONS_OFFER,
  SCOOTER_EMAIL,
  SCOOTER_FIRM_USER_ID,
  httpUrl,
  jsonBody,
  str,
  walkerIdentity,
  type ProductionsJudge,
  type ProductionsSearch,
} from "./productions";

/**
 * WALKER'S WEEKLY HIRE SEARCH for West Peek Productions — Scooter's own agency, not the fund
 * (16 Sep 2026).
 *
 * Operator: the agency wants to hire someone to bring in more brand deals — a senior experiential
 * producer, freelance. Every week Walker searches live public sources, keeps only candidates whose
 * profile page answers and whose page supports the fit, judges each against the archetype, and
 * emails Scooter ONE note. The OS never contacts a candidate; the only recipient is scooter@.
 *
 * ── THE BOUNDARY, SAME AS productions.ts ─────────────────────────────────────────────────────
 *
 * A chief-of-staff duty inside Scooter's office. No fund record is read or written; the deliverable
 * is on his Home and in his inbox only; Sequoia is not told. No invented people, no guessed URLs,
 * no scraping behind a login: the search model returns what public pages say, every URL is asked
 * for its status, and a person is named only with the page that names them.
 *
 * ── LINKEDIN ANSWERS 999 TO ANY AUTOMATED READ ───────────────────────────────────────────────
 *
 * Confirmed 16 Sep 2026 against the archetype's own profile URL: LinkedIn returns HTTP 999 to a
 * request that is not a signed-in browser, whether or not the profile exists. So "the profile URL
 * is live" cannot be established for a LinkedIn URL by fetching it, and pretending otherwise would
 * be a liveness check that passes nothing or everything. The rule here: a profile that answers
 * 2xx/3xx is LIVE; one that answers 401/403/405/429/999 EXISTS BUT REFUSED an automated read (the
 * roomPacket convention) and is kept only when a second, checkable page — a team page, a speaker
 * listing, a portfolio, an award list — answers 2xx and names them; anything else is dropped. The
 * note says which of the two each candidate is, so Scooter knows what was verified and what he is
 * opening to confirm.
 *
 * ── THE ARCHETYPE ────────────────────────────────────────────────────────────────────────────
 *
 * The operator pointed at one LinkedIn profile (a member-id URL) as the archetype. It does not
 * render publicly — HTTP 999 to WebFetch and to a plain GET — and reading it through a signed-in
 * session would be scraping behind a login, which this duty forbids. So the archetype below is
 * written from the title the operator gave ("senior experiential producer, freelance") and what
 * that title means in the US experiential industry, and it says so. Replace it with the profile's
 * own words when the operator pastes them.
 */

export const HIRE_ROLE = "senior experiential producer, freelance";

export const HIRE_ARCHETYPE = [
  "THE ARCHETYPE — a senior experiential producer, freelance (written from the title; the reference",
  "profile did not render publicly):",
  "- Title: Senior Producer / Executive Producer / Producer, Experiential — or Head of Production at a",
  "  small experiential shop — currently freelance, independent, or plainly open to freelance projects",
  "  ('freelance', 'independent', 'available for projects', 'open to contract' in the headline or about).",
  "- Seniority: 8+ years producing brand activations, launches, pop-ups, sponsor showcases, festival and",
  "  conference experiences, live and hybrid — end to end: concept, budget, vendors, build, run of show,",
  "  on-site. Has owned programmes in the $250k–$5M range and led a crew.",
  "- Where they have worked: inside or for experiential and brand-activation agencies (Momentum,",
  "  Jack Morton, George P. Johnson, Giant Spoon, MKG, BMF, NVE, Invisible North, Set Creative, Wasserman,",
  "  MAS, and the like) or an in-house brand-experience team at a consumer, tech, sports or media brand.",
  "- The part that matters most here: BRINGS IN BRAND DEALS. Carries brand and sponsor relationships,",
  "  has sold, scoped or closed sponsorships and brand partnerships, has written proposals and decks",
  "  that won work, and can talk to a CMO or a head of brand partnerships as a peer — not only deliver",
  "  what somebody else sold.",
  "- Skills to look for: experiential production, brand partnerships, sponsorship sales, integrated",
  "  campaigns, event production, budget ownership, vendor and venue management, client leadership,",
  "  creative development, community and live-audience programming.",
  "- Signals: a portfolio of named brand activations; agency team-page bios; speaking at Event Marketer's",
  "  Experiential Marketing Summit, BizBash, C2, or Cannes/Clio-recognised work; Ex Awards or Event",
  "  Marketer 'It List' credits.",
  "- In the United States (New York, Los Angeles, Chicago, Miami, Austin, Atlanta, San Francisco are",
  "  where the work is); remote is fine.",
].join("\n");

export const HIRE_SOURCES = [
  "search-engine results for public LinkedIn profiles (linkedin.com/in/…) matching the title and 'freelance'",
  "agency team pages and 'our people' pages at experiential and brand-activation agencies",
  "speaker lists of Experiential Marketing Summit, BizBash Live, Event Marketer, C2 and the like",
  "Behance, Squarespace and personal portfolio sites of experiential producers",
  "industry award lists (Ex Awards, Event Marketer It List, Clio, Cannes Brand Experience) naming producers",
];

export const HIRE_CARD_KIND = "PRODUCTIONS_HIRE_SEARCH";

export function hireCardTitle(week: string): string {
  return `Walker: West Peek Productions hire search (${week})`;
}

/** Open this week's card on Walker's desk, or report the one already open. Idempotent by title (the week). */
export async function openHireSearchCard(
  env: Env,
  now: Date,
  firmScope = "west-peek",
): Promise<{ opened: boolean; cardId: string; title: string; week: string }> {
  const week = isoWeekOf(now);
  const title = hireCardTitle(week);
  const existing = await env.WP_OS_DB.prepare(
    "SELECT id FROM work_card WHERE title = ?1 AND firm_scope = ?2 AND state != 'CANCELLED' LIMIT 1",
  ).bind(title, firmScope).first<{ id: string }>();
  if (existing) return { opened: false, cardId: existing.id, title, week };

  const card = await createWorkCardInternal(env, sweepIdentity(firmScope), {
    title,
    description: [
      "SCOOTER'S PERSONAL-AGENCY DUTY — West Peek Productions is Scooter's own business, not part of West Peek Ventures.",
      "This card touches no fund record and its result goes to scooter@westpeek.ventures only. Nothing is sent to a candidate, ever.",
      "",
      `This week's hire search for a ${HIRE_ROLE}: search live public sources (${HIRE_SOURCES.join("; ")}), keep only candidates whose profile URL answers and whose page supports the fit, judge each against the archetype, remember them so a name never repeats once Scooter has acted on it, and send Scooter one note: who, where, why they fit (with the page), an opening line for him to send himself, a fit score.`,
    ].join("\n"),
    owner_type: "AI",
    owner_id: "aie_walker",
    priority: "NORMAL",
    firm_scope: firmScope,
    next_action: "Search, check every profile URL, judge against the archetype, dedupe against past weeks, email Scooter once.",
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2 WHERE id = ?1").bind(card.id, HIRE_CARD_KIND).run();
  await appendEvent(env, {
    eventType: "productions.hire_card_opened",
    actorType: "system",
    actorId: "scheduled_job",
    objectType: "work_card",
    objectId: card.id,
    firmScope,
    payload: { job_key: "productions_hire_search", kind: HIRE_CARD_KIND, week },
  });
  return { opened: true, cardId: card.id, title, week };
}

// ── The search and its parsing ───────────────────────────────────────────────

export interface HireCandidate {
  name: string;
  title: string;
  company: string;
  city: string;
  /** The profile: LinkedIn, or a portfolio/personal site when that is what the search found. */
  profileUrl: string;
  /** A second page that supports the fit, when the searcher gave one. */
  evidenceUrl: string | null;
  why: string;
  openingLine: string;
  /** 1–10, the searcher's; the judge's overrides it. */
  fit: number;
  /** How the profile answered: live (2xx/3xx), or exists-but-refused an automated read. Set by the check. */
  profileCheck?: "live" | "refused";
}

/** One row per URL. A URL is the identity, so it is normalised: https, no query, no trailing slash, lower-case host. */
export function canonicalProfileUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.protocol = "https:";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url.trim();
  }
}

function fitOf(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(10, Math.max(0, Math.round(n))) : 0;
}

export function parseHireCandidates(raw: string): HireCandidate[] {
  const p = jsonBody(raw);
  const out: HireCandidate[] = [];
  for (const r of Array.isArray(p?.results) ? (p!.results as Record<string, unknown>[]) : []) {
    const name = str(r.name);
    const profileUrl = httpUrl(r.profile_url) ?? httpUrl(r.url) ?? httpUrl(r.linkedin_url);
    // No profile URL, no candidate: the whole value of a search-grounded answer is the page.
    if (!name || !profileUrl) continue;
    const url = canonicalProfileUrl(profileUrl);
    if (out.some((c) => c.profileUrl === url)) continue;
    const evidence = httpUrl(r.evidence_url);
    out.push({
      name,
      title: str(r.title) ?? str(r.current_title) ?? "title not stated",
      company: str(r.company) ?? str(r.current_company) ?? "",
      city: str(r.city) ?? str(r.location) ?? "",
      profileUrl: url,
      evidenceUrl: evidence && canonicalProfileUrl(evidence) !== url ? evidence : null,
      why: str(r.why) ?? str(r.why_they_fit) ?? "",
      openingLine: str(r.opening_line) ?? "",
      fit: fitOf(r.fit ?? r.fit_score),
    });
  }
  return out;
}

// ── Checking the pages ───────────────────────────────────────────────────────

/** The status a URL answers with; null when nothing answered. Lives in effects/, like every outbound request. */
export type UrlStatusCheck = (url: string) => Promise<number | null>;
export const defaultUrlStatus: UrlStatusCheck = (url) => urlStatus(url);

/** 401/403/405/429 are "exists, refused a bot"; 999 is LinkedIn's spelling of the same thing. */
export const REFUSED_STATUSES = new Set([401, 403, 405, 429, 999]);

/**
 * Keep a candidate only when their page can be shown to exist: the profile answered, or the profile
 * refused an automated read AND a second page answered. `dropped` names what went and why.
 */
export async function checkCandidatePages(
  candidates: readonly HireCandidate[],
  check: UrlStatusCheck,
): Promise<{ kept: HireCandidate[]; dropped: { name: string; reason: string }[] }> {
  const kept: HireCandidate[] = [];
  const dropped: { name: string; reason: string }[] = [];
  await Promise.all(
    candidates.map(async (c) => {
      const profile = await check(c.profileUrl);
      const profileLive = profile !== null && profile < 400;
      const profileRefused = profile !== null && REFUSED_STATUSES.has(profile);
      if (profileLive) { kept.push({ ...c, profileCheck: "live" }); return; }
      if (!profileRefused) { dropped.push({ name: c.name, reason: `the profile page did not answer (${profile ?? "no response"}): ${c.profileUrl}` }); return; }
      if (!c.evidenceUrl) { dropped.push({ name: c.name, reason: `the profile refused an automated read (${profile}) and no second page was given to check` }); return; }
      const evidence = await check(c.evidenceUrl);
      if (evidence !== null && evidence < 400) { kept.push({ ...c, profileCheck: "refused" }); return; }
      dropped.push({ name: c.name, reason: `the profile refused an automated read (${profile}) and the evidence page did not answer (${evidence ?? "no response"}): ${c.evidenceUrl}` });
    }),
  );
  // Promise.all resolves in input order but pushes happen as checks return; restore the searcher's order.
  const order = new Map(candidates.map((c, i) => [c.profileUrl, i] as const));
  kept.sort((a, b) => (order.get(a.profileUrl) ?? 0) - (order.get(b.profileUrl) ?? 0));
  return { kept, dropped };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export function buildHireSearchPrompt(week: string): string {
  return [
    walkerIdentity(),
    "",
    "You are working for Scooter's OWN agency, West Peek Productions — not for the fund. Nothing here",
    "concerns West Peek Ventures, its companies or its investors.",
    "",
    "WHAT THE AGENCY IS:",
    PRODUCTIONS_OFFER,
    "",
    guidanceBlock(["mp_personal_office"]),
    "",
    `TASK — week ${week}: the agency wants to hire a ${HIRE_ROLE} to bring in more brand deals. Find`,
    "up to 8 candidates, using CURRENT public sources only:",
    ...HIRE_SOURCES.map((s) => `- ${s}`),
    "",
    HIRE_ARCHETYPE,
    "",
    "RULES:",
    "- Only people you can cite a live public page for. profile_url is MANDATORY — the LinkedIn",
    "  profile (linkedin.com/in/…) or, failing that, the person's portfolio or personal site. An entry",
    "  without it is discarded unread. Never construct or guess a URL; use one a search result showed.",
    "- evidence_url: a SECOND page that supports the fit and can be read without a login — an agency",
    "  team page, a conference speaker page, a portfolio, an award list. Give it whenever one exists;",
    "  LinkedIn refuses automated reads, so a candidate with only a LinkedIn URL may be dropped.",
    "- Freelance or open to freelance, senior (8+ years), in the United States, with brand-deal or",
    "  sponsorship-sales experience visible on the page. A producer who only delivers what others sold",
    "  is not the archetype. Say in `why` (2–3 lines) which page shows which claim.",
    "- Never read behind a login. Never invent a person, a title or an employer. Each person ONCE.",
    "- opening_line: one sentence Scooter can send himself, specific to that person's work, no flattery.",
    "- fit: 1–10 against the archetype, honestly. Fewer, all real, beats eight with guesses.",
    "",
    'Return ONLY JSON: {"results":[{"name":"…","title":"…","company":"…","city":"…","profile_url":"https://…","evidence_url":"https://…","why":"…","opening_line":"…","fit":7}]}',
  ].join("\n");
}

export function buildHireJudgePrompt(week: string, candidates: readonly HireCandidate[]): string {
  return [
    walkerIdentity(),
    "",
    "You are the JUDGE, not the researcher. A web-search model produced the candidates below for a",
    `${HIRE_ROLE} role at West Peek Productions, Scooter's experiential and community agency in New York.`,
    "Hold each one to the archetype and return a verdict per candidate with your own fit score. Be",
    "strict: a name Scooter would be embarrassed to have emailed is worse than no name.",
    "",
    HIRE_ARCHETYPE,
    "",
    `KEEP a candidate only if ALL of these hold (this is week ${week}):`,
    "- The `why` names a page-backed claim of senior experiential PRODUCTION work (not event planning,",
    "  not marketing coordination, not a venue or catering role).",
    "- Freelance, independent, or plainly open to freelance/contract — a full-time employee with no such",
    "  signal fails.",
    "- Brand-deal, sponsorship or partnership SALES experience is claimed from a page, not inferred from",
    "  the title alone.",
    "- In the United States. A candidate whose city or employer is plainly outside the US fails.",
    "- The profile_url is that person's own profile or site, not a company page or a listing.",
    "DROP anyone whose `why` is the archetype restated, anyone whose evidence is a job posting, and",
    "anyone who reads as a recruiter, agency owner selling services, or a speaker bureau listing.",
    "",
    "CANDIDATES:",
    JSON.stringify(candidates.map((c) => ({ name: c.name, title: c.title, company: c.company, city: c.city, profile_url: c.profileUrl, evidence_url: c.evidenceUrl, why: c.why, opening_line: c.openingLine, fit: c.fit })), null, 1),
    "",
    'Return ONLY JSON: {"verdicts":[{"name":"…","keep":true,"fit":7,"reason":"one line"}]} — one verdict per candidate, in order, name copied exactly.',
  ].join("\n");
}

export interface HireVerdict {
  keep: boolean;
  fit: number;
  reason: string;
}

export function parseHireVerdicts(raw: string): Map<string, HireVerdict> {
  const p = jsonBody(raw);
  const out = new Map<string, HireVerdict>();
  for (const r of Array.isArray(p?.verdicts) ? (p!.verdicts as Record<string, unknown>[]) : []) {
    const key = str(r.name);
    if (!key) continue;
    out.set(key.toLowerCase(), { keep: r.keep === true, fit: fitOf(r.fit ?? r.fit_score), reason: str(r.reason) ?? "no reason given" });
  }
  return out;
}

/** Every candidate is judged; one the judge did not mention is dropped, not waved through. */
export async function judgeCandidates(
  env: Env,
  actor: Actor,
  week: string,
  candidates: readonly HireCandidate[],
  judge: ProductionsJudge,
): Promise<{ kept: HireCandidate[]; rejected: { name: string; reason: string }[]; failed: string | null }> {
  if (candidates.length === 0) return { kept: [], rejected: [], failed: null };
  const found = await judge(env, actor, buildHireJudgePrompt(week, candidates));
  if (!found.ok) return { kept: [], rejected: [], failed: found.detail };
  const verdicts = parseHireVerdicts(found.text);
  if (verdicts.size === 0) return { kept: [], rejected: [], failed: "the judge answered with no verdicts" };
  const kept: HireCandidate[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const c of candidates) {
    const v = verdicts.get(c.name.toLowerCase());
    if (v?.keep) kept.push({ ...c, fit: v.fit || c.fit });
    else rejected.push({ name: c.name, reason: v?.reason ?? "the judge gave no verdict on them" });
  }
  kept.sort((a, b) => b.fit - a.fit);
  return { kept, rejected, failed: null };
}

// ── Remembering candidates across weeks ──────────────────────────────────────

/**
 * NEW (never reported) or SEEN (reported in an earlier week and still on the table).
 *
 * `CONTACTED` and `PASSED` ARE GONE, 17 Sep 2026. Operator: "i really dont think we should give him
 * extra work if he likes one he will reach out with the sample draft intro language walker creates."
 * She is right, and the deeper problem was not the two buttons: it was that the note's usefulness
 * DEPENDED on him pressing them. A weekly note that degrades every week the recipient does not
 * maintain a list is a note that has quietly assigned the work back to him.
 *
 * Nothing degrades now. A name he has acted on leaves the list because he says so in a reply, in his
 * own words, and that reply reaches a reasoning model before the next search runs (see `steerFor`
 * and `HIRE_SEARCH_STEPS`). If he never replies at all, the note keeps working: fresh candidates
 * every week, and the ones still on the table listed once each as information.
 *
 * The column still allows the two retired values because historical rows may carry them, and a row
 * that does is still left out — see `rememberCandidates`. Nothing in the product writes them.
 */
export type CandidateStatus = "NEW" | "SEEN" | "CONTACTED" | "PASSED";

export interface CandidateRow {
  id: string;
  url: string;
  name: string;
  title: string;
  company: string;
  city: string;
  evidence_url: string | null;
  why: string;
  opening_line: string;
  fit_score: number;
  first_seen: string;
  last_seen: string;
  week: string;
  last_card_id: string | null;
  status: CandidateStatus;
  status_changed_at: string | null;
  status_changed_by: string | null;
  firm_scope: string;
}

/**
 * Sort this week's survivors into what the note says — FRESH (never shown before), SEEN BEFORE
 * (shown in an earlier week and not yet acted on — one line, not a full entry), and ACTED ON
 * (a historical row carrying one of the two retired statuses — never shown again, and no longer
 * reported, because nothing in the product sets one any more) — and write them to
 * the table ONLY when there is a note to send. A week with nothing fresh is BLOCKED and must not
 * move the rows' week and card pointer onto a card that has no deliverable behind it: the Home
 * panel finds a note's candidates by that pointer.
 */
export async function rememberCandidates(
  env: Env,
  candidates: readonly HireCandidate[],
  week: string,
  cardId: string,
  now: Date,
  firmScope = "west-peek",
): Promise<{ fresh: HireCandidate[]; seenBefore: Array<HireCandidate & { firstSeen: string }>; retired: string[] }> {
  type Known = { id: string; status: CandidateStatus; first_seen: string; week: string };
  const fresh: HireCandidate[] = [];
  const seenBefore: Array<HireCandidate & { firstSeen: string }> = [];
  /*
   * Rows written before 17 Sep 2026 may still carry CONTACTED or PASSED. They stay left out — a name
   * Scooter already dealt with must not come back — but they are no longer counted in the note,
   * because "acted on" was a fact only the retired buttons could produce and reporting it now would
   * describe a mechanism that no longer exists.
   */
  const retired: string[] = [];
  const known = new Map<string, Known | null>();
  for (const c of candidates) {
    const row = await env.WP_OS_DB.prepare("SELECT id, status, first_seen, week FROM productions_candidate WHERE url = ?1").bind(c.profileUrl).first<Known>();
    known.set(c.profileUrl, row);
    if (!row) fresh.push(c);
    else if (row.status === "CONTACTED" || row.status === "PASSED") retired.push(c.name);
    // Found again in a LATER week: seen before. Found again in the same week (a re-run): still fresh.
    else if (row.week !== week || row.status === "SEEN") seenBefore.push({ ...c, firstSeen: row.first_seen });
    else fresh.push(c);
  }
  if (fresh.length === 0) return { fresh, seenBefore, retired };

  const at = now.toISOString();
  for (const c of candidates) {
    const row = known.get(c.profileUrl) ?? null;
    if (!row) {
      await env.WP_OS_DB.prepare(
        `INSERT INTO productions_candidate (id, url, name, title, company, city, evidence_url, why, opening_line, fit_score, first_seen, last_seen, week, last_card_id, status, firm_scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, 'NEW', ?14)`,
      )
        .bind(`pcd_${crypto.randomUUID()}`, c.profileUrl, c.name, c.title, c.company, c.city, c.evidenceUrl, c.why, c.openingLine, c.fit, at, week, cardId, firmScope)
        .run();
    } else if (row.status === "CONTACTED" || row.status === "PASSED") {
      // Acted on: last_seen moves so the record says the search still finds them; nothing else does.
      await env.WP_OS_DB.prepare("UPDATE productions_candidate SET last_seen = ?2 WHERE id = ?1").bind(row.id, at).run();
    } else {
      await env.WP_OS_DB.prepare(
        "UPDATE productions_candidate SET last_seen = ?2, week = ?3, last_card_id = ?4, fit_score = ?5, why = ?6, opening_line = ?7, title = ?8, company = ?9, city = ?10, status = CASE WHEN ?11 = 1 THEN 'SEEN' ELSE status END WHERE id = ?1",
      )
        .bind(row.id, at, week, cardId, c.fit, c.why, c.openingLine, c.title, c.company, c.city, row.week !== week ? 1 : 0)
        .run();
    }
  }
  return { fresh, seenBefore, retired };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function checkLine(c: HireCandidate): string {
  return c.profileCheck === "refused"
    ? `Profile: ${c.profileUrl} (refused an automated read — LinkedIn's standard answer; open it to confirm. The page that answered: ${c.evidenceUrl})`
    : `Profile: ${c.profileUrl} (answered when checked)${c.evidenceUrl ? `; also ${c.evidenceUrl}` : ""}`;
}

/**
 * The full note: every candidate, the page behind each, what was left out and why — and no task.
 *
 * ─── WHAT CHANGED ON 17 SEP 2026, AND WHY ──────────────────────────────────────────────────────
 *
 * The note used to end with "HOW TO MARK THEM: … press Contacted or Passed beside each name", and
 * section 2 was headed "SEEN BEFORE, STILL OPEN — shown in an earlier note and not yet marked". Both
 * were asking Scooter to maintain a list so that the machine's next run would be correct.
 *
 * Operator: "i really dont think we should give him extra work if he likes one he will reach out
 * with the sample draft intro language walker creates."
 *
 * So the ask is gone and the information is not. Section 2 still says who is on the table, because
 * that is worth knowing — it is Walker telling him what he already has, not a queue awaiting his
 * verdict. The closing paragraph is an invitation to reply in prose, in Walker's voice, because a
 * reply is the one thing Scooter was always going to do anyway and it now steers the search: his
 * words are read by a reasoning model before the next week's search runs.
 *
 * THE "LEFT OUT BECAUSE" LINES STAY, and they are the opposite of a task. Walker showing his work —
 * whose page did not answer, who failed the archetype and why — is what makes the shortlist
 * trustworthy without Scooter checking it.
 */
export function renderHireNote(
  week: string,
  fresh: readonly HireCandidate[],
  seenBefore: readonly (HireCandidate & { firstSeen: string })[],
  dropped: readonly { name: string; reason: string }[],
  rejected: readonly { name: string; reason: string }[],
  /**
   * What the interpreter understood his last reply to mean, when he has sent one.
   *
   * THE PROMISE THE NOTE MAKES, KEPT. The closing paragraph says "I read it before I search again,
   * and I will say back what I understood it to mean." A promise a partner cannot see kept is a
   * promise he stops believing — and this is the one line that tells him his words landed, in the
   * model's own words, without him having to open the card.
   */
  understood: string | null = null,
): string {
  const lines = [
    `Scooter — Walker, your chief of staff. The week's hire search for a ${HIRE_ROLE} at West Peek Productions (${week}): ${fresh.length} new candidate(s). Nobody has been contacted from here; that stays yours.`,
    "",
    ...(understood ? [`You told me: ${understood.trim()}`, "That is what I searched on this week.", ""] : []),
    `═══ 1 · NEW THIS WEEK ═══`,
    "Each one is on a live page; the fit is judged against the archetype, not the title alone.",
    "",
    ...fresh.flatMap((c, n) => [
      `${n + 1}. ${c.name} — ${c.title}${c.company ? `, ${c.company}` : ""}${c.city ? ` · ${c.city}` : ""} · fit ${c.fit}/10`,
      `   ${checkLine(c)}`,
      ...c.why.split("\n").filter(Boolean).map((l) => `   Why: ${l}`),
      ...(c.openingLine ? [`   Opening line for you: "${c.openingLine}"`] : []),
      "",
    ]),
    fresh.length === 0 ? "Nothing new this week that survived the checks — say where to look and I will." : "",
    "",
    seenBefore.length ? `═══ 2 · STILL ON THE TABLE ═══` : "",
    seenBefore.length ? "From earlier weeks, so you have them in one place. Nothing to do with these — I list each one once and then keep going." : "",
    ...seenBefore.slice(0, 8).map((c) => `- ${c.name} — ${c.title} · first seen ${c.firstSeen.slice(0, 10)} · fit ${c.fit}/10 · ${c.profileUrl}`),
    seenBefore.length > 8 ? `- …and ${seenBefore.length - 8} more on your Home page.` : "",
    "",
    dropped.length ? `Left out because the page did not answer when checked: ${dropped.map((d) => `${d.name} — ${d.reason}`).join("; ")}` : "",
    rejected.length ? `Left out on judgement (searched, then held to the archetype and failed it): ${rejected.map((r) => `${r.name} — ${r.reason}`).join("; ")}` : "",
    "",
    /*
     * THE INVITATION, IN WALKER'S VOICE, AND IT REPLACES A CHORE RATHER THAN ADDING ONE.
     *
     * Nothing here asks for a format, a code or a keyword, and nothing breaks if he ignores it. A
     * reply lands on this thread, is matched to this search automatically (`shared/email/thread.ts`),
     * and what he wrote — not what his mail client quoted back — is read by a reasoning model before
     * next week's search runs.
     */
    "Just hit reply if you want to steer me. Plain sentences are fine — \"not this one\", \"more like",
    "#2\", \"stop showing me agency people, I want independents\", \"I reached out to Dana\". I read it",
    "before I search again, and I will say back what I understood it to mean. If you would rather not",
    "reply at all, do nothing: next week's note arrives either way.",
    "",
    "— Walker. This is West Peek Productions work, on your desk only; nothing here touches the fund and nothing is sent to a candidate from here.",
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

function names(list: readonly string[], max = 4): string {
  const shown = list.slice(0, max).map((n) => `**${n}**`);
  return list.length > max ? `${shown.join(", ")} and ${list.length - max} more` : shown.join(", ");
}

/** The busy-executive summary above the note. */
export function hireSummary(
  week: string,
  fresh: readonly HireCandidate[],
  seenBefore: readonly HireCandidate[],
  dropped: readonly { name: string; reason: string }[],
  rejected: readonly { name: string; reason: string }[],
): { what: string; tldr: string; sections: ExecEmailInput["sections"] } {
  const top = fresh[0];
  return {
    what: `hire search — ${fresh.length} candidate(s) this week`,
    tldr: `${fresh.length} new candidate(s) for the ${HIRE_ROLE} role this week${top ? `; top pick **${top.name}** (${top.title}${top.company ? `, ${top.company}` : ""}, fit **${top.fit}/10**)` : ""}. Nobody has been contacted; you choose who to write to.`,
    sections: [
      { label: "What you asked", bullets: [`The weekly hire search for a ${HIRE_ROLE} who can bring in brand deals (${week}).`] },
      {
        label: "What I did",
        bullets: [
          "Searched live public sources: LinkedIn results, agency team pages, speaker lists, portfolios, award lists.",
          "Asked every profile page for its status, then held each survivor to the archetype in a second judgement pass.",
          `Checked them against past weeks: **${seenBefore.length}** were in an earlier note and are still on the table.`,
        ],
      },
      {
        label: "What I found",
        bullets: [
          ...(fresh.length ? [`New: ${names(fresh.map((c) => `${c.name} (${c.fit}/10)`))}.`] : ["No new candidate survived the checks this week."]),
          ...(top ? [`Top pick: **${top.name}** — ${top.why.split("\n")[0] ?? ""}`] : []),
          ...(dropped.length ? [`Dropped **${dropped.length}** whose page did not answer.`] : []),
          ...(rejected.length ? [`Rejected **${rejected.length}** on judgement; the reasons are in the details.`] : []),
        ],
      },
      {
        /*
         * NOT "YOUR CALL — GO AND MARK THEM". The label and the bullets used to end with a chore:
         * mark each one Contacted or Passed on Home so next week's note leaves them out. That is the
         * extra work the operator asked to remove, and it was the thing the whole feature quietly
         * depended on. What is left is the one thing he was always going to do — write to somebody —
         * plus an offer to be steered, which costs him nothing if he ignores it.
         */
        label: "Yours to do with as you like",
        bullets: [
          "Pick who to write to; each entry below has the page and an opening line in your voice.",
          "If you want to steer me — not this one, more like #2, only independents — just reply to this email in plain words. I read it before I search again.",
          "Nothing goes to a candidate from here, and nothing here needs you to keep a list.",
        ],
      },
    ],
  };
}

// ── The runner the sweep calls ───────────────────────────────────────────────

const defaultSearch: ProductionsSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Walker: West Peek Productions hire search",
    actor,
    inputs: [prompt],
    // Public web research; the query leaves for a search engine. Never raised.
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: true, expectedOutputTokens: 3000, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (run.model !== SEARCH_MODEL) return { ok: false, text: "", detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  return { ok: true, text: run.output_text, detail: "ok" };
};

const defaultJudge: ProductionsJudge = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "Walker: West Peek Productions hire judgement",
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

export interface HireSearchDeps {
  search?: ProductionsSearch;
  judge?: ProductionsJudge;
  urlStatus?: UrlStatusCheck;
  now?: Date;
  /** The pass that reads what he asked for. See services/instruction.ts, tests/helpers/interpret.ts. */
  interpret?: Interpreter;
}

/**
 * Work one hire-search card to a conclusion: search (twice if the first answer gives nothing
 * usable), check every page, judge, remember, file the deliverable, email Scooter once, DONE — or
 * BLOCKED with the reason on the card and nothing emailed.
 */
/**
 * What this search can actually do, for the interpretation pass. Shown to the model so it can tell
 * a directive that changes one of these steps from one that asks for something none of them does —
 * "set up interviews with the best two" is a CANNOT, and saying so is the correct answer.
 */
export const HIRE_SEARCH_STEPS: readonly string[] = [
  "Run one live search for a senior experiential producer, freelance, who can bring in brand deals.",
  "Check every profile and evidence page is live and readable without a login, dropping the rest.",
  "Judge each candidate against what the agency needs and reject the rest with a reason.",
  "Remember who has already been sent, across weeks, so nobody is sent twice.",
  "File one deliverable on Scooter's Home and send him ONE email.",
  "Nobody is contacted, no interview is arranged and no offer is made — the result is a shortlist he decides on.",
];

export async function runHireSearchCard(
  env: Env,
  card: SweepCard,
  deps: HireSearchDeps = {},
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const now = deps.now ?? new Date();
  const week = isoWeekOf(now);
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: [card.firm_scope] };
  const status = deps.urlStatus ?? defaultUrlStatus;

  /*
   * WHAT SCOOTER HAS ASKED FOR ON THIS PARTICULAR WEEK, READ BY A MODEL FIRST.
   *
   * A weekly scheduled card carries no human prose, so `steerFor` returns without calling a model
   * and the ordinary week costs nothing extra. The week he types "stop sending me people in LA" is
   * the week this matters: before this, that note went into a column this runner never read, the
   * same search ran again, and he got the same people.
   */
  /*
   * AND WHAT HE SAID BY REPLYING TO AN EARLIER NOTE, which is now the only way he steers this at all.
   *
   * WITHOUT THIS THE WHOLE REPLY PATH IS INERT, and it would have looked like it worked. `steerFor`
   * reads notes on the card it is given; this duty opens a NEW card every week and closes it the
   * same day, so a reply arriving on Thursday answers a card that is already DONE. The note would be
   * stored, acknowledged, and read by nothing — next Monday's card is a different row with no notes
   * on it. `standingSteer` reads what the partners have said about this KIND of work, so "stop
   * showing me agency people" applies next week and the week after.
   *
   * It is passed as `extra`, which is exactly what that parameter is for: prose the chain holds
   * outside the card's own columns. One model call reads all of it, as before.
   */
  const replies = await standingSteer(env, HIRE_CARD_KIND, card.firm_scope);
  const steer = await steerFor(env, actor, {
    cardId: card.id,
    cardKind: HIRE_CARD_KIND,
    title: card.title,
    employee: "Walker",
    chain: "the weekly hire search for West Peek Productions",
    steps: [...HIRE_SEARCH_STEPS],
    firmScope: card.firm_scope,
    extra: replies,
  }, deps.interpret);
  if (steer.cannot.length > 0) {
    const why2 = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: "Walker",
      who: "SCOOTER",
      detail: steer.failure ? undefined : cannotDetail("Walker", steer.cannot),
    });
    return { finished: false, blocked: true, detail: why2 };
  }
  const withSteer = (p: string): string => (steer.text ? `${steer.text}\n\n${p}` : p);
  const rawSearch = deps.search ?? defaultSearch;
  const search: ProductionsSearch = (e, a, p) => rawSearch(e, a, withSteer(p));
  const rawJudge = deps.judge ?? defaultJudge;
  const judge: ProductionsJudge = (e, a, p) => rawJudge(e, a, withSteer(p));

  let kept: HireCandidate[] = [];
  let dropped: { name: string; reason: string }[] = [];
  let rejected: { name: string; reason: string }[] = [];
  let why = "";
  const prompt = buildHireSearchPrompt(week);
  for (let attempt = 0; attempt < 2 && kept.length === 0; attempt += 1) {
    const nudge = attempt === 0 ? "" : `\n\nYour previous answer was discarded: ${why}. Every entry MUST have a profile_url a search result showed, an evidence_url that can be read without a login, and page-backed freelance, seniority and brand-deal claims.`;
    const found = await search(env, actor, `${prompt}${nudge}`);
    if (!found.ok) { why = `the live search failed: ${found.detail}`; continue; }
    const parsed = parseHireCandidates(found.text);
    if (parsed.length === 0) { why = "the search answered with no usable entry (no profile_url on any)"; continue; }
    const checked = await checkCandidatePages(parsed, status);
    dropped = checked.dropped;
    if (checked.kept.length === 0) { why = `every page was dead or unreadable: ${checked.dropped.map((d) => d.name).join(", ")}`; continue; }
    const judged = await judgeCandidates(env, actor, week, checked.kept, judge);
    if (judged.failed) { why = `the judgement pass failed: ${judged.failed}`; break; }
    rejected = judged.rejected;
    kept = judged.kept;
    if (kept.length === 0) why = `the judge rejected every candidate: ${rejected.map((r) => `${r.name} — ${r.reason}`).join("; ")}`;
  }

  if (kept.length === 0) {
    const blocked = await blockCard(env, card, {
      reason: "nothing_good_enough_to_send",
      trying: card.title,
      employee: "Walker",
      who: "SCOOTER",
      detail: "Tell Walker where to look or what would count, or leave it until next week — nobody he found this week stood up to the checks.",
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  const remembered = await rememberCandidates(env, kept, week, card.id, now, card.firm_scope);
  if (remembered.fresh.length === 0) {
    // Everything found this week was already shown or acted on. A note that repeats last week's
    // names is noise; the card says why and the quiet notice reaches Scooter.
    const blocked = await blockCard(env, card, {
      reason: "nothing_new_since_last_time",
      trying: card.title,
      employee: "Walker",
      who: "SCOOTER",
      detail: `Say whether to widen the search — every name this week was already in an earlier note (${remembered.seenBefore.length} of them). Reply to last week's note in plain words if you want me to look somewhere else.`,
    });
    return { finished: false, blocked: true, detail: blocked };
  }

  const text = renderHireNote(week, remembered.fresh, remembered.seenBefore, dropped, rejected, steer.interpretation?.understood ?? null);
  const summary = hireSummary(week, remembered.fresh, remembered.seenBefore, dropped, rejected);
  const title = `Hire search ${week}: ${remembered.fresh.length} candidate(s) for ${HIRE_ROLE}`;

  const delivered = await deliver(env, actor, {
    kind: "productions_hire_search",
    title,
    body: text,
    preparedBy: "Walker",
    preparedFor: SCOOTER_FIRM_USER_ID,
    sourceType: "work_card",
    sourceId: card.id,
  });

  const mail = await sendPartnerEmail(env, {
    to: SCOOTER_EMAIL,
    email: { employee: "Walker", what: summary.what, tldr: summary.tldr, sections: summary.sections, details: text },
    objectType: "work_card",
    objectId: card.id,
    // The KIND goes with it, so a reply steers the SEARCH rather than a card that will be DONE
    // before he opens his inbox. See services/emailThread.ts and migration 0180.
    cardKind: HIRE_CARD_KIND,
    firmScope: card.firm_scope,
    actorId: "aie_walker",
  });

  await notifyQuietly(env, {
    firmUserId: SCOOTER_FIRM_USER_ID,
    kind: "MEETING",
    severity: "INFO",
    title: `Walker: ${remembered.fresh.length} hire candidate(s) this week — on Home${mail.sent ? " and in your inbox" : ""}`,
    body: `${title}. Nothing for you to mark — reply to the email in plain words if you want to steer next week's search.`,
    objectType: "deliverable",
    objectId: delivered.id,
    dedupeKey: `productions_hire:${card.id}:delivered`,
    firmScope: card.firm_scope,
  });

  const finding = [
    `• ${mail.subject}`,
    mail.sent ? `• Emailed to ${SCOOTER_EMAIL}.` : `• NOT emailed to ${SCOOTER_EMAIL}: ${mail.reason}. The deliverable is on Home and in Documents.`,
    `• Deliverable ${delivered.id}${delivered.document_id ? `, filed as document ${delivered.document_id}` : " (not filed)"}.`,
    "",
    text,
  ].join("\n");
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(card.id, finding).run();
  await appendEvent(env, {
    eventType: "productions.hire_delivered",
    actorType: "ai_employee",
    actorId: "aie_walker",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { week, fresh: remembered.fresh.length, seen_before: remembered.seenBefore.length, dropped: dropped.length, rejected: rejected.length, emailed: mail.sent, deliverable_id: delivered.id, subject: mail.subject },
  });
  return {
    finished: true,
    blocked: false,
    detail: mail.sent ? `${mail.subject} — emailed to ${SCOOTER_EMAIL} and on Home` : `${mail.subject} — on Home; email not sent (${mail.reason})`,
  };
}

// ── Scooter marks a candidate from Home ──────────────────────────────────────

/**
 * ONLY THE PARTNER THE NOTE WAS FOR. The duty lives in Scooter's office; the list and the status
 * change answer to him and to nobody else — not the other partner, not an employee. A 404 rather
 * than a 403 for anyone else: the rows are not a thing that exists for them.
 */
function isScooter(ctx: RouteContext): boolean {
  return ctx.identity?.id === SCOOTER_FIRM_USER_ID;
}

/** GET /api/productions/candidates?deliverable=dlv_… — the candidates behind one week's note, or all open ones. */
export async function handleListHireCandidates(ctx: RouteContext): Promise<Response> {
  if (!isScooter(ctx)) return json({ error: "not_found" }, { status: 404 });
  const deliverableId = new URL(ctx.request.url).searchParams.get("deliverable");
  let rows: CandidateRow[];
  if (deliverableId) {
    const d = await ctx.env.WP_OS_DB.prepare("SELECT source_id FROM deliverable WHERE id = ?1 AND kind = 'productions_hire_search' AND prepared_for = ?2")
      .bind(deliverableId, SCOOTER_FIRM_USER_ID)
      .first<{ source_id: string | null }>();
    if (!d?.source_id) return json({ error: "not_found" }, { status: 404 });
    rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM productions_candidate WHERE last_card_id = ?1 ORDER BY fit_score DESC, name").bind(d.source_id).all<CandidateRow>()).results ?? [];
  } else {
    rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM productions_candidate WHERE status IN ('NEW','SEEN') ORDER BY last_seen DESC, fit_score DESC LIMIT 100").all<CandidateRow>()).results ?? [];
  }
  return json({ candidates: rows });
}

/*
 * THE `POST /api/productions/candidates/:id/status` ROUTE IS GONE (17 Sep 2026).
 *
 * It let Scooter mark a candidate CONTACTED or PASSED from Home, and next week's note left them
 * out. Operator: "i really dont think we should give him extra work if he likes one he will reach
 * out with the sample draft intro language walker creates."
 *
 * REMOVED RATHER THAN HIDDEN. A route nothing calls is the "exists but nothing invokes it" defect
 * this repo names, and an endpoint that can still write a status no reader reports would be worse:
 * a partner pressing a button through the API would silently change what the search returns, with
 * no surface saying so. The GET above stays — the list behind a note is information, and it is
 * still Scooter's alone.
 *
 * What replaced it: he replies to the email in his own words, the reply is matched to the search by
 * its `References` header (`shared/email/thread.ts`), and what he wrote reaches a reasoning model
 * before the next search runs (`services/instruction.ts`). No state he maintains, and nothing
 * degrades if he never touches it.
 */
