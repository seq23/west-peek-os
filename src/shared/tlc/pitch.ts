import { TLC_ABOUT_COMMUNITY, TLC_ABOUT_WEST_PEEK } from "./aboutWestPeek";
import {
  TLC_IDEA_ORIGIN_LABEL,
  TLC_NET_FLOOR_USD,
  TLC_NET_TARGET_USD,
  TLC_OWNER,
  TLC_SEATS,
  TLC_TARGET_PATH,
  TLC_TICKET_PRICE_USD,
  TLC_TIERS,
  TLC_TIER_KEYS,
  competingCategories,
  sponsorMixProblems,
  aiRuleProblems,
  seasonOption,
  seatsWords,
  type Seats,
  type TlcSponsorCategory,
  isIdeaOrigin,
  monthWords,
} from "./learningClub";

/**
 * TWO DOCUMENTS PER CLUB MONTH (owner, 22 Oct 2026, after a hostile review of the one-sheets).
 *
 *   THE BRAND PITCH — what a brand reads. In this order: a two-line hook; why now for the brand's
 *   category (the packet's OWN sourced why-now, never the generic quarterly trend story: review B3);
 *   who is in the room; what the brand gets; the price and the ask; the contact. No internal labels,
 *   no exclusivity (there is no such policy: review B4), the community-first About.
 *
 *   THE INTERNAL ONE-PAGER — what Sequoia reads. The topic and angle, the why-now with sources, the
 *   economics, the categories with example brands and reasons, where the idea came from, the risks,
 *   and what she must decide. The full About (the $100M line and the portfolio names) lives ONLY here.
 *
 * Both are self-contained HTML (light and dark, phone width) that print to one letter page; the
 * worker prints them through the browser (effects/htmlPdf.ts). PURE: no database, no network.
 */

export type TlcCategory = TlcSponsorCategory;
export interface TlcClubView {
  topic: string;
  angle: string | null;
  month: string;
  eventDate: string;
  slot: string;
  whyNow: string | null;
  sources: ReadonlyArray<{ title: string; url: string }>;
  categories: readonly TlcCategory[];
  handsOn: string | null;
  takeHome: string | null;
  recap: string | null;
  /** The AI segment in the run of show (every non-AI club has one). */
  aiSegment?: string | null;
  /** The club's own planned room size (the partners set it; 25–40 by default). */
  seats?: Seats;
}
export interface TlcInternalView extends TlcClubView {
  origin: string | null;
  status: string;
  vetoUntil: string | null;
  committedUsd: number;
  committedPartners: number;
  pitchUrl: string | null;
  /** This club's sponsor goal and cost budget ($25,000 and $15,000 unless the partners changed it). */
  goalUsd?: number;
  costBudgetUsd?: number;
  /** Product partners and other in-kind help: cost relief, never counted toward the goal. */
  inKind?: ReadonlyArray<{ brand: string; what: string | null }>;
  /** The month's backup club and its switch deadline (internal only; the brand pitch shows the primary alone). */
  backup?: { topic: string; angle: string | null; deadline: string } | null;
  /** Who chose this month's topic, when it was the owner's decision rather than Parker's pick. */
  decidedBy?: string | null;
}

/**
 * WHAT A BRAND IS TOLD ABOUT THE ROOM (owner, 26 Oct 2026): every brand email and pitch says 25–40 guests per
 * event, flexible to the brand's needs, whatever size the club is planned for. The planned size stays internal
 * (the one-pager and the economics read it).
 */
export const BRAND_GUESTS_WORDS = `${TLC_SEATS.min}–${TLC_SEATS.max} guests per event, flexible to your goals`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday 11 February 2027, 6–10 pm". The weekday is read off the date, never assumed. */
export function clubWhen(eventDate: string, slot: string): string {
  const d = new Date(`${eventDate}T12:00:00Z`);
  const day = Number.isNaN(d.getTime()) ? "" : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${monthWords(eventDate.slice(0, 7))}`;
  return `${day || monthWords(eventDate.slice(0, 7))}, ${slot === "AFTERNOON" ? "1–5 pm" : "6–10 pm"}`;
}

const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** Sentences no brand-facing copy may carry: a stale date, a promised result, an exclusivity claim, an internal name. */
const BRAND_DROP = [/proposed date/i, /running on their own|working automations|drafts itself|guarantee/i, /exclusiv/i, /\b(Parker|Wynn)\b/];

/**
 * Copy a brand may read. "Dry January" is a trademark risk (review), so it is never our words (owner:
 * "Zero-Proof January" or "January reset" instead); a
 * stale proposed date, a promised outcome and an exclusivity claim are dropped; internal labels
 * like "(lead)" or "(donated)" are removed.
 */
export function brandSafe(text: string | null | undefined): string {
  const t = String(text ?? "")
    .replace(/\bdo Dry January\b/gi, "do a Zero-Proof January")
    .replace(/\bDry January\b/gi, "Zero-Proof January")
    .replace(/\s*\((?:lead|supporting|donated|in[- ]kind|frontier model)[^)]*\)/gi, "")
    .replace(/\s*—\s*/g, ", ");
  return sentences(t).filter((x) => !BRAND_DROP.some((r) => r.test(x))).join(" ");
}

/** Internal copy keeps everything except what is simply untrue: no exclusivity, no stale proposed date. */
function internalSafe(text: string | null | undefined): string {
  const t = String(text ?? "").replace(/,?\s*category-exclusive/gi, "");
  return sentences(t).filter((x) => !/proposed date/i.test(x) && !/exclusiv/i.test(x)).join(" ");
}

/** The safety lines a topic needs (review: January 21+ and ABV; March confidential data and no overpromise). */
export function safetyLines(topic: string, text = ""): string[] {
  const all = `${topic} ${text}`;
  const out: string[] = [];
  if (/peptide/i.test(all)) {
    out.push("The peptides segment is evidence and regulatory status only, led by an independent doctor West Peek pays: no dosing, no sources, no sellers, and nothing handed out.");
  }
  if (/health data|wearable|\blab (results|tests|numbers|reports?)\b|sleep data/i.test(all)) {
    out.push("Guests choose what to share; sample data is there for anyone who would rather not use their own; nothing is uploaded on their behalf. AI is not medical advice.");
  }
  if (/\binvest|\bmoney\b|budget|retirement/i.test(all)) {
    out.push("Nothing here is investment advice: no stock picks and no recommendations.");
  }
  if (/zero[- ]proof|non[- ]alcoholic|cocktail|mocktail|\bbar\b|spirits|aperitif|\bbeer\b|\bwine\b/i.test(all)) {
    out.push("21+ only, with ID checked at the door. Every drink served is non-alcoholic (0.5% ABV or less).");
  }
  // Work with AI on real tasks: AI tools, agents, assistants, automations. Not a fragrance night that uses AI-designed accords.
  if (/\bAI (tools?|agents?|assistants?)\b|automation|chatbot|\bLLM\b|\bprompt/i.test(all)) {
    out.push("Attendees work only on sample or non-confidential material, never their employer's confidential data.");
    out.push("We teach how the tools work and where they help; we do not promise any particular result.");
  }
  return out;
}

const STYLE = `<style>
:root{--bg:#FFFFFF;--ink:#050505;--muted:#5F5B55;--line:#D9D2C6;--accent:#F05A1A;--card:#F7F2EA}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A;--line:#2A2A2A;--card:#171717}}
:root[data-theme="dark"]{--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A;--line:#2A2A2A;--card:#171717}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
.eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--accent);font-weight:700}
h1{font-size:clamp(34px,6vw,56px);line-height:1.05;margin:10px 0 8px;letter-spacing:-.02em}
h2{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px;font-weight:700}
.lede{font-size:19px;max-width:680px;margin:6px 0}.when{color:var(--muted);margin:4px 0 0}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:8px 0}
.tier,.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.tier b{display:block;font-size:22px;letter-spacing:-.01em}.tier span{color:var(--muted);font-size:14px}
ul,ol{padding-left:20px}li{margin:4px 0}.cats{columns:2;column-gap:28px}@media (max-width:560px){.cats{columns:1}}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 14px}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-top:1px solid var(--line);padding:6px 8px 6px 0;text-align:left;vertical-align:top}
a{color:inherit}.muted{color:var(--muted)}footer{margin-top:28px;border-top:1px solid var(--line);padding-top:14px;font-size:14px}
.box h2{margin:0 0 6px}.box p{margin:0}.box{margin-top:22px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 24px}.two h2{margin-top:16px}
@page{size:letter;margin:.45in}
@media print{:root,:root:not([data-theme="light"]),:root[data-theme="dark"]{--bg:#FFFFFF;--ink:#050505;--muted:#5F5B55;--line:#D9D2C6;--card:#F7F2EA}
body{font-size:13px;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}main{max-width:none;padding:0}
h1{font-size:40px}h2{margin:16px 0 6px;font-size:12px}.lede{font-size:15px}.src{font-size:11px;columns:2;column-gap:28px}
li{margin:2px 0}.tier,.box,.note,li,tr{break-inside:avoid}.box{margin-top:16px}footer{margin-top:16px}}
</style>`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${STYLE}</head><body><main>
${body}
</main></body></html>`;

const sourcesList = (sources: TlcClubView["sources"]): string =>
  sources.length ? `<ol class="src">${sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a></li>`).join("")}</ol>` : "";

/** The brand-facing category name: no "(lead)", no "(supporting)", no exclusivity. */
export function categoryName(c: string): string {
  return brandSafe(c).replace(/[.\s]+$/, "") || c.replace(/\s*\(.*?\)/g, "");
}

/** THE BRAND PITCH. The title names the topic, so the PDF check can confirm what it is. */
export function renderBrandPitch(v: TlcClubView): string {
  const hook = sentences(brandSafe(v.angle)).slice(0, 2).join(" ") || `One ${v.slot === "AFTERNOON" ? "afternoon" : "evening"}, one topic, taught properly.`;
  const why = brandSafe(v.whyNow);
  const takeHome = brandSafe(v.takeHome);
  const safety = safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""} ${v.aiSegment ?? ""}`);
  // Open slots only: not the bench, not a slot a featured partner already fills.
  const cats = [...new Set(v.categories.filter((c) => !c.bench && !c.featured).map((c) => categoryName(c.category)))];
  return page(
    `The Learning Club: ${v.topic}`,
    `<div class="eyebrow">West Peek Rooms · The Learning Club</div>
<h1>${esc(v.topic)}</h1>
<p class="lede">${esc(hook)}</p>
<p class="when">${esc(clubWhen(v.eventDate, v.slot))} · New York City · An intimate room: ${BRAND_GUESTS_WORDS}</p>
<h2>Why now for your category</h2>
<p>${esc(why)}</p>
${sourcesList(v.sources)}
<h2>Who is in the room</h2>
<ul><li>${TLC_SEATS.min}–${TLC_SEATS.max} New Yorkers per event, a number we flex to your goals, who chose this topic. Every seat is a paid ticket ($${TLC_TICKET_PRICE_USD}), so everyone in the room chose to come.</li>
<li>Founders, operators, creatives and builders from a community of more than 5,000.</li>
<li>Taught by someone who does this for a living. The session: arrive, learn, an hour hands-on, a real meal, go deeper, share, close.</li>
${v.aiSegment ? `<li>The AI segment: ${esc(brandSafe(v.aiSegment))}</li>` : ""}
${takeHome ? `<li>They leave with: ${esc(takeHome)}</li>` : ""}</ul>
${v.recap ? `<p>${esc(v.recap)}</p>` : ""}
<h2>What you get</h2>
<ul><li>Your product in attendees' hands during the hands-on hour, where it fits the topic</li>
<li>Five minutes to the room during the meal</li>
<li>Photo and content rights: photographs from the day for your own channels</li>
<li>Opt-in lead capture: attendees who choose to can share their details with you. We never share attendee names, emails or lists otherwise.</li>
<li>Named in the invitation and on the day</li>
<li>A recap within a week, with the numbers: seats sold, attendance and photographs</li></ul>
${safety.length ? `<p class="note">${safety.map(esc).join(" ")}</p>` : ""}
<h2>Price and the ask</h2>
<div class="tiers">${TLC_TIER_KEYS.map((t) => `<div class="tier"><b>${esc(TLC_TIERS[t].label)}${TLC_TIERS[t].priceUsd ? `: ${usd(TLC_TIERS[t].priceUsd!)}` : ""}</b><span>${esc(TLC_TIERS[t].gets)}</span></div>`).join("")}</div>
<p>Several brands partner on each club, each in its own way.</p>
<p><strong>Would you be open to exploring a partnership?</strong> Reply to the email this came with, or write to ${esc(TLC_OWNER.name)} directly.</p>
${cats.length ? `<h2>Partner categories for this club</h2><ul class="cats">${cats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
<section class="box"><h2>About West Peek</h2><p>${esc(TLC_ABOUT_COMMUNITY)}</p></section>
<footer><strong>${esc(TLC_OWNER.name)}</strong> · ${esc(TLC_OWNER.firm)} · <a href="mailto:${TLC_OWNER.email}">${TLC_OWNER.email}</a></footer>`,
  );
}

/** The risks Sequoia should see before saying yes to a month. */
export function clubRisks(v: TlcInternalView): string[] {
  const out = [...safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""} ${v.aiSegment ?? ""}`)];
  const raw = `${v.angle ?? ""} ${v.whyNow ?? ""}`;
  if (/dry january/i.test(raw)) out.push('"Dry January" is a possible trademark: the brand pitch never uses it as our words.');
  if (/proposed date/i.test(v.angle ?? "")) out.push(`The packet proposed a different date; the club is set for ${clubWhen(v.eventDate, v.slot)}.`);
  if (/running on their own|working automations|guarantee/i.test(`${v.angle ?? ""} ${v.takeHome ?? ""}`)) out.push("The packet promised a set result; the brand pitch leaves that out.");
  for (const c of competingCategories(v.categories)) out.push(`Sponsors must not compete: ${c}.`);
  for (const p of sponsorMixProblems(v.month, v.categories)) out.push(`Sponsor rule: ${p}.`);
  for (const p of aiRuleProblems(v.topic, { ai_segment: v.aiSegment }, v.categories)) out.push(`AI rule: ${p}.`);
  if (v.committedPartners === 0) out.push("No brand has agreed yet.");
  return out;
}

/** THE INTERNAL ONE-PAGER, for Sequoia. Never sent to a brand. */
export function renderInternalOnePager(v: TlcInternalView): string {
  const origin = v.origin && isIdeaOrigin(v.origin) ? TLC_IDEA_ORIGIN_LABEL[v.origin] : v.origin ?? "not recorded";
  const goal = v.goalUsd ?? 25_000;
  const budget = v.costBudgetUsd ?? goal - TLC_NET_TARGET_USD;
  const pct = Math.min(100, Math.round((v.committedUsd / goal) * 100));
  const seats = v.seats ?? TLC_SEATS;
  const rows = v.categories
    .map((c) => `<tr><td><strong>${esc(internalSafe(c.category) || c.category)}</strong>${c.tier ? `<br><span class="muted">${esc(TLC_TIERS[c.tier].label)}</span>` : ""}${c.bench ? `<br><span class="muted">Bench: only if the lead agrees</span>` : ""}</td><td>${esc(internalSafe(c.why))}${c.featured ? ` Featured: ${esc(c.featured)}.` : ""}${c.excluded_brands?.length ? ` Never approach: ${esc(c.excluded_brands.join(", "))}.` : ""}</td><td>${esc(c.example_brands.join(", "))}</td></tr>`)
    .join("");
  const decide = [
    v.vetoUntil ? `Keep or swap this topic. It goes ahead on ${v.vetoUntil.slice(0, 10)} unless you say no.` : "Keep or swap this topic.",
    "Approve the brand pitch (on the Rooms page). Brands see nothing until you do.",
    "Approve the playbook and turn brand sending on, when you are ready.",
    "Say yes, no or counter to each brand that comes back.",
  ];
  return page(
    `Internal: ${v.topic}`,
    `<div class="eyebrow">Internal one-pager · for Sequoia · not for brands</div>
<h1>${esc(v.topic)}</h1>
<p class="when">${esc(clubWhen(v.eventDate, v.slot))} · New York City · where the idea came from: ${esc(origin)}${v.decidedBy ? ` · ${esc(v.decidedBy)}` : ""}</p>
<p class="lede">${esc(internalSafe(v.angle))}</p>
<h2>Why now</h2>
<p>${esc(internalSafe(v.whyNow))}</p>
${sourcesList(v.sources)}
${v.aiSegment ? `<p><strong>AI segment:</strong> ${esc(v.aiSegment)}</p>` : ""}
${v.categories.some((c) => c.ai_partner) ? `<p><strong>AI partner:</strong> ${v.categories.filter((c) => c.ai_partner).map((c) => `${esc(c.category)}${c.example_brands.length ? ` (targets: ${esc(c.example_brands.join(", then "))})` : ""}`).join("; ")}. Cash at any tier, or in kind (credits, an expert); in kind never counts toward the goal. One frontier-model company per club: first yes is seated.</p>` : ""}
<h2>The economics</h2>
<ul><li>Goal: ${usd(goal)} raised from sponsors; costs up to ${usd(budget)} (venue, food, decor, materials); ${usd(TLC_NET_TARGET_USD)} net. Under ${usd(TLC_NET_FLOOR_USD)} net at a go-check escalates to you.${goal === 25_000 ? ` ${esc(TLC_TARGET_PATH)}` : ""}</li>
<li>Tiers: ${TLC_TIER_KEYS.map((t) => `${esc(TLC_TIERS[t].label)}${TLC_TIERS[t].priceUsd ? ` ${usd(TLC_TIERS[t].priceUsd!)}` : ""}`).join("; ")}. Custom amounts are fine; neither size nor count is capped. No category exclusivity.</li>
<li>Agreed so far: ${usd(v.committedUsd)} of ${usd(goal)} (${pct}%) · ${v.committedPartners} partner${v.committedPartners === 1 ? "" : "s"}.</li>
${v.inKind?.length ? `<li>In kind (cost relief, not counted toward the goal): ${v.inKind.map((x) => `${esc(x.brand)}${x.what ? ` (${esc(x.what)})` : ""}`).join("; ")}.</li>` : ""}
<li>Room: planned for ${seatsWords(seats)} people. Tickets $${TLC_TICKET_PRICE_USD} each; they add to the net, the goal never depends on them.</li>
<li>${esc(seasonOption())}</li></ul>
<h2>Sponsor categories</h2>
<table><thead><tr><th>Category</th><th>Why it fits</th><th>Example brands</th></tr></thead><tbody>${rows}</tbody></table>
<div class="two"><div><h2>Risks</h2>
<ul>${clubRisks(v).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
<div><h2>What you decide</h2>
<ol>${decide.map((d) => `<li>${esc(d)}</li>`).join("")}</ol></div></div>
${v.backup ? `<section class="box" data-backup><h2>Backup topic, switch on ${esc(v.backup.deadline.slice(0, 10))}</h2><p><strong>${esc(v.backup.topic)}.</strong> ${esc(internalSafe(v.backup.angle))} If fewer than 2 cash sponsors and no Title partner have said yes by ${esc(v.backup.deadline.slice(0, 10))}, the month switches to it automatically and you are told. Wynn sells ${esc(v.topic)} first.</p></section>` : ""}
<section class="box"><h2>About West Peek Ventures</h2><p>${esc(TLC_ABOUT_WEST_PEEK)}</p></section>
<footer>${v.pitchUrl ? `The brand pitch for this month: <a href="${esc(v.pitchUrl)}">${esc(v.pitchUrl)}</a>` : "The brand pitch is attached beside this page."}</footer>`,
  );
}

/** What a brand must never read in the pitch (outside the cited source titles). [] when clean. */
export function brandPitchProblems(html: string): string[] {
  const body = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<ol class="src">[\s\S]*?<\/ol>/g, "");
  const out: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/dry january/i, '"Dry January"'],
    [/exclusiv/i, "an exclusivity claim"],
    [/to itself/i, "an exclusivity claim"],
    [/\$100M|secondary transactions|Higgsfield|Databricks|\bStripe\b|Fund I\b/i, "an internal-only fact"],
    [/\b(Parker|Wynn)\b|\bwc_[0-9a-z]|\bwork card\b|\bon the card\b/i, "an internal name"],
    [/\((?:lead|supporting|donated)/i, "an internal label"],
    [/proposed date/i, "a stale proposed date"],
    [/running on their own|working automations/i, "a promised result"],
    [/—/, "an em dash"],
    // Owner, 22 Oct 2026: playful and honest about other brands' customers, never mocking; never "cult".
    [/\bcult\b/i, "\"cult\" language"],
  ];
  for (const [r, what] of checks) if (r.test(body)) out.push(what);
  if (!/\$5,000/.test(body) || !/\$10,000/.test(body) || !/\$15,000/.test(body)) out.push("no price");
  // The $25,000 the brand reads is the Title partner's price, never our goal; our costs never show.
  if (/\bgoal\b|to raise|our costs|cost budget|\bnet\b|\$15,000 (in )?costs/i.test(body)) out.push("our goal or costs");
  if (/\bseason\b/i.test(body)) out.push("a season offer (internal only)");
  if (!body.includes(TLC_OWNER.email)) out.push("no contact");
  return [...new Set(out)];
}
