import { TLC_ABOUT_COMMUNITY, TLC_ABOUT_WEST_PEEK } from "./aboutWestPeek";
import {
  TLC_COST_CAP_USD,
  TLC_IDEA_ORIGIN_LABEL,
  TLC_NET_FLOOR_USD,
  TLC_NET_TARGET_USD,
  TLC_OWNER,
  TLC_PARTNERS_TO_TARGET,
  TLC_PRE_LAUNCH_PROOF,
  TLC_SEATS,
  TLC_SPONSOR_CASH_TARGET_USD,
  TLC_TARGET_PATH,
  TLC_TICKET_PRICE_USD,
  TLC_TIERS,
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

export interface TlcCategory {
  category: string;
  why: string;
  example_brands: readonly string[];
}
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
}
export interface TlcInternalView extends TlcClubView {
  origin: string | null;
  status: string;
  vetoUntil: string | null;
  committedUsd: number;
  committedPartners: number;
  pitchUrl: string | null;
}

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
 * Copy a brand may read. "Dry January" is a trademark risk (review), so it is never our words; a
 * stale proposed date, a promised outcome and an exclusivity claim are dropped; internal labels
 * like "(lead)" or "(donated)" are removed.
 */
export function brandSafe(text: string | null | undefined): string {
  const t = String(text ?? "")
    .replace(/\bdo Dry January\b/gi, "skip alcohol in January")
    .replace(/\bDry January\b/g, "An alcohol-free January")
    .replace(/\bdry january\b/gi, "an alcohol-free January")
    .replace(/\s*\((?:lead|supporting|donated|in[- ]kind)[^)]*\)/gi, "")
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
  if (/zero[- ]proof|non[- ]alcoholic|cocktail|mocktail|\bbar\b|spirits|aperitif|\bbeer\b|\bwine\b/i.test(all)) {
    out.push("21+ only, with ID checked at the door. Every drink served is non-alcoholic (0.5% ABV or less).");
  }
  if (/\bAI\b|automation|assistant|chatbot|\bLLM\b|prompt/i.test(all)) {
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
  const safety = safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""}`);
  const cats = [...new Set(v.categories.map((c) => categoryName(c.category)))];
  return page(
    `The Learning Club: ${v.topic}`,
    `<div class="eyebrow">West Peek Rooms · The Learning Club</div>
<h1>${esc(v.topic)}</h1>
<p class="lede">${esc(hook)}</p>
<p class="when">${esc(clubWhen(v.eventDate, v.slot))} · New York City · ${TLC_SEATS.min}–${TLC_SEATS.max} people</p>
<h2>Why now for your category</h2>
<p>${esc(why)}</p>
${sourcesList(v.sources)}
<h2>Who is in the room</h2>
<ul><li>${TLC_SEATS.min}–${TLC_SEATS.max} New Yorkers who chose this topic. Every seat is a paid ticket ($${TLC_TICKET_PRICE_USD}), so everyone in the room chose to come.</li>
<li>Founders, operators, creatives and builders from a community of more than 5,000.</li>
<li>Taught by someone who does this for a living. The session: arrive, learn, an hour hands-on, a real meal, go deeper, share, close.</li>
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
<div class="tiers"><div class="tier"><b>${TLC_TIERS.PARTNER.label}: ${usd(TLC_TIERS.PARTNER.priceUsd)}</b><span>The standard partnership, for most brands.</span></div>
<div class="tier"><b>${TLC_TIERS.PRESENTING.label}: ${usd(TLC_TIERS.PRESENTING.priceUsd)}</b><span>For one larger brand: "Presented by" billing and top placement on the invitation and on the day.</span></div></div>
<p>Several brands partner on each club, each in its own way. Partnering on more than one club? Ask us about a series.</p>
<p><strong>Would you be open to exploring a partnership?</strong> Reply to the email this came with, or write to ${esc(TLC_OWNER.name)} directly.</p>
${cats.length ? `<h2>Partner categories for this club</h2><ul class="cats">${cats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
<section class="box"><h2>About West Peek</h2><p>${esc(TLC_ABOUT_COMMUNITY)}</p></section>
<footer><strong>${esc(TLC_OWNER.name)}</strong> · ${esc(TLC_OWNER.firm)} · <a href="mailto:${TLC_OWNER.email}">${TLC_OWNER.email}</a></footer>`,
  );
}

/** The risks Sequoia should see before saying yes to a month. */
export function clubRisks(v: TlcInternalView): string[] {
  const out = [...safetyLines(v.topic, `${v.angle ?? ""} ${v.handsOn ?? ""}`)];
  const raw = `${v.angle ?? ""} ${v.whyNow ?? ""}`;
  if (/dry january/i.test(raw)) out.push('"Dry January" is a possible trademark: the brand pitch never uses it as our words.');
  if (/proposed date/i.test(v.angle ?? "")) out.push(`The packet proposed a different date; the club is set for ${clubWhen(v.eventDate, v.slot)}.`);
  if (/running on their own|working automations|guarantee/i.test(`${v.angle ?? ""} ${v.takeHome ?? ""}`)) out.push("The packet promised a set result; the brand pitch leaves that out.");
  if (v.committedPartners === 0) out.push("No brand has agreed yet.");
  return out;
}

/** THE INTERNAL ONE-PAGER, for Sequoia. Never sent to a brand. */
export function renderInternalOnePager(v: TlcInternalView): string {
  const origin = v.origin && isIdeaOrigin(v.origin) ? TLC_IDEA_ORIGIN_LABEL[v.origin] : v.origin ?? "not recorded";
  const pct = Math.min(100, Math.round((v.committedUsd / TLC_SPONSOR_CASH_TARGET_USD) * 100));
  const rows = v.categories
    .map((c) => `<tr><td><strong>${esc(internalSafe(c.category) || c.category)}</strong></td><td>${esc(internalSafe(c.why))}</td><td>${esc(c.example_brands.join(", "))}</td></tr>`)
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
<p class="when">${esc(clubWhen(v.eventDate, v.slot))} · New York City · where the idea came from: ${esc(origin)}</p>
<p class="lede">${esc(internalSafe(v.angle))}</p>
<h2>Why now</h2>
<p>${esc(internalSafe(v.whyNow))}</p>
${sourcesList(v.sources)}
<h2>The economics</h2>
<ul><li>Target: ${usd(TLC_NET_TARGET_USD)} net from sponsors (floor ${usd(TLC_NET_FLOOR_USD)}), costs held under ${usd(TLC_COST_CAP_USD)}. ${esc(TLC_TARGET_PATH)}</li>
<li>Prices: ${TLC_TIERS.PARTNER.label} ${usd(TLC_TIERS.PARTNER.priceUsd)}; ${TLC_TIERS.PRESENTING.label} ${usd(TLC_TIERS.PRESENTING.priceUsd)} ("Presented by" billing and top placement). Several partners per club; no category exclusivity.</li>
<li>Agreed so far: ${usd(v.committedUsd)} of ${usd(TLC_SPONSOR_CASH_TARGET_USD)} (${pct}%) · ${v.committedPartners} of ~${TLC_PARTNERS_TO_TARGET} partners.</li>
<li>Tickets: $${TLC_TICKET_PRICE_USD} each, ${TLC_SEATS.min}–${TLC_SEATS.max} seats. They add to the net; the target never depends on them.</li></ul>
<h2>Sponsor categories</h2>
<table><thead><tr><th>Category</th><th>Why it fits</th><th>Example brands</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Risks</h2>
<ul>${clubRisks(v).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
<h2>What you decide</h2>
<ol>${decide.map((d) => `<li>${esc(d)}</li>`).join("")}</ol>
<section class="box"><h2>About West Peek Ventures</h2><p>${esc(TLC_ABOUT_WEST_PEEK)}</p></section>
<footer>${v.pitchUrl ? `The brand pitch for this month: <a href="${esc(v.pitchUrl)}">${esc(v.pitchUrl)}</a>` : "The brand pitch is attached beside this page."}<br><span class="muted">${esc(TLC_PRE_LAUNCH_PROOF.join(" "))}</span></footer>`,
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
  ];
  for (const [r, what] of checks) if (r.test(body)) out.push(what);
  if (!/\$5,000/.test(body) || !/\$15,000/.test(body)) out.push("no price");
  if (!body.includes(TLC_OWNER.email)) out.push("no contact");
  return [...new Set(out)];
}
