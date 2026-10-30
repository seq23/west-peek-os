/**
 * THE THREE SAMPLES, AS ONE 3-PAGE PDF (owner, 26 Oct 2026). When a brand says yes to Wynn's offer ("send it",
 * "sure"), Parker builds one PDF tailored to that brand from this template, and Wynn puts it, with the cover email
 * word for word, in ONE approval email to Sequoia; her "approved" sends both from her Gmail on the brand's thread.
 *
 *   Page 1  The evening: the full TLC evening (arrival, an opening talk, a panel, dinner, the build session, the
 *           brand's 15-minute segment led by the brand OR by our host, show and tell, close); guests bring their
 *           own laptops; 25–40 guests, flexible to the brand's goals.
 *   Page 2  A series of six: six evenings that build on each other, the brand's own evening marked.
 *   Page 3  Who's in the room: a wheel of our 5,000+ community from the editable mix (tlc_setting
 *           `community_mix_json`, labelled "approximate mix of our community"), roles under each slice, and what
 *           partnering gets the brand.
 *
 * Her design (pinecone.html, "The attachment: one 3-page PDF") is the source of the look: a navy band with a gold
 * rule. The baseline has no price, fee or tier; an explicit owner note can place an exact price in one deal's PDF.
 * `samplesProblems` also checks the remaining rules: no
 * guest names (roles and types only); no number we cannot stand behind (the guest range is the standard one, the
 * community is the confirmed 5,000+, the mix is labelled approximate); we host every segment ourselves or bring a
 * host, so the brand never has to send anyone. PURE: no database, no network.
 */
import { z } from "zod";
import { BRAND_MUST_STAFF, MONEY_WORDS } from "./brandReply";
import { fillTemplate, hiLine } from "./brandFlow";
import { TLC_OWNER, TLC_SEATS, monthWords, replyLooksLikeNo, type Seats } from "./learningClub";

export const COMMUNITY_MIX_SETTING = "community_mix_json";
export interface MixSlice { label: string; pct: number; roles: string[] }
/** Her approximate spread (26 Oct 2026, revised the same day). The live copy is the D1 setting; this is what the migration seeds. */
export const DEFAULT_COMMUNITY_MIX: readonly MixSlice[] = [
  { label: "Operators", pct: 35, roles: ["marketing", "finance", "product", "sales", "people teams"] },
  { label: "Creatives", pct: 35, roles: ["film", "music", "design", "writing"] },
  { label: "Founders", pct: 25, roles: ["AI and tech startups", "consumer brands", "agencies"] },
  { label: "Investors & legal", pct: 5, roles: ["angels", "VCs", "family offices", "lawyers"] },
];

/** The stored mix, read strictly: every slice named, positive, with roles, summing to 100; else the default. */
export function readMix(raw: string | null | undefined): MixSlice[] {
  try {
    const v = JSON.parse(raw ?? "") as unknown;
    if (!Array.isArray(v) || v.length === 0) return [...DEFAULT_COMMUNITY_MIX];
    const out = v.map((s) => ({
      label: String((s as MixSlice).label ?? "").trim(),
      pct: Number((s as MixSlice).pct),
      roles: Array.isArray((s as MixSlice).roles) ? (s as MixSlice).roles.map((r) => String(r).trim()).filter(Boolean) : [],
    }));
    const ok = out.every((s) => s.label && s.pct > 0 && s.roles.length > 0) && Math.round(out.reduce((a, s) => a + s.pct, 0)) === 100;
    return ok ? out : [...DEFAULT_COMMUNITY_MIX];
  } catch {
    return [...DEFAULT_COMMUNITY_MIX];
  }
}

/** Per-deal copy, never HTML. Missing fields keep the baseline; arrays replace whole sections. */
const copy = z.string().trim().min(1).max(2000);
export const samplesOverridesSchema = z.object({
  /** The big heading on page 1, the document's title and the PDF's file name (default: the club's topic). */
  title: z.string().trim().min(1).max(120).optional(),
  page1Rows: z.array(z.object({ label: copy, title: copy, line: copy, highlight: z.boolean().optional() }).strict()).min(1).max(20).optional(),
  series: z.array(z.object({ label: copy, title: copy, line: copy, highlight: z.boolean().optional() }).strict()).min(1).max(12).optional(),
  seriesHeading: copy.optional(), seriesSub: copy.optional(),
  whyItWorks: z.array(copy).min(1).max(12).optional(),
  partnerGets: z.array(copy).min(1).max(12).optional(), footer2: copy.optional(),
  bring: copy.optional(), leaveWith: copy.optional(), reach: copy.optional(),
}).strict();
export type SamplesOverrides = z.infer<typeof samplesOverridesSchema>;

/** Exact amounts only. The model cannot grant this permission; only an explicit owner instruction can. */
const PRICE_AMOUNT = /(?:[$£€]\s*\d[\d,]*(?:\.\d{1,2})?\s*[kKmM]?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:USD|dollars|GBP|EUR)\b)/g;
export function approvedSamplePrices(note: string): string[] {
  const cleanNote = note.replace(/’/g, "'");
  const refuses = /\b(?:not|never|without|unless|no|if|remove|exclude|omit|cannot)\b|\b\w+n't\b/i;
  return [...new Set(cleanNote.split(/[!?;\n]+|\.(?:\s|$)/)
    .filter((sentence) => !refuses.test(sentence))
    .flatMap((sentence) => sentence.split(/,(?!\d)|\b(?:and|but)\b/i)).flatMap((sentence) => {
    if (/\b(?:email|draft|invoice|agreement)\b/i.test(sentence)) return [];
    if (!/\b(?:put|include|add|show|insert|set|use)\b/i.test(sentence) || !/\b(?:pdf|samples|attachment)\b/i.test(sentence)) return [];
    return (sentence.match(PRICE_AMOUNT) ?? []).map((p) => p.trim());
  }))];
}

/**
 * THE WORDS THAT CHANGE PER BRAND (her <mark> spans; owner-approved template, artifact v7, 26 Oct 2026). Everything
 * else starts from the template; per-deal overrides carry the owner's edits.
 */
export interface SamplesInput {
  brand: string;
  topic: string;
  /** YYYY-MM. */
  month: string;
  tentative: boolean;
  /** The brand's 15-minute segment on page 1 ("Giving your agent a memory"). */
  segmentTitle: string;
  /** The brand's evening in the series of six, page 2, card 02 ("Give it a memory"). */
  seriesTitle: string;
  /** Who the room is weighted toward, page 3 ("founders and operators deciding what their teams build on"). */
  reach: string;
  mix: readonly MixSlice[];
  overrides?: SamplesOverrides;
}

/** The template text that belongs to the club's topic: the approved copy for its topic, or the generic evening. */
export interface TopicContent {
  leaveFact: string;
  opening: string;
  panel: string;
  dinner: string;
  build: string;
  showAndTell: string;
  bring: string;
  leaveWith: string;
  /** Six cards; card 02 (index 1) is the brand's and takes `seriesTitle`. */
  series: ReadonlyArray<{ title: string; line: string }>;
  guests: string;
  inHands: string;
  keepGoing: string;
}

/** Her approved words (pinecone.html, artifact v7) for the AI-agent club. */
const AI_AGENT_CONTENT: TopicContent = {
  leaveFact: "everyone leaves with a working agent",
  opening: "\"What AI agents can actually do right now\": real examples from founders and operators, no hype",
  panel: "three builders on what changed when they put agents to work (a founder, an operator, a creative), with audience Q&A",
  dinner: "facilitators help each table pick the agent they'll build",
  build: "step by step, in the browser, no code needed; facilitators at every table",
  showAndTell: "each table demos what it built",
  bring: "Their own laptop. Everything runs in the browser with free accounts set up on arrival. Anyone without a laptop is paired at their table.",
  leaveWith: "A working AI agent of their own, the step-by-step guide, and introductions to the people at their table.",
  series: [
    { title: "Build your first agent", line: "Talk + panel: where agents already save people hours" },
    { title: "", line: "" },
    { title: "Agents that use tools", line: "Calendars, inboxes, spreadsheets" },
    { title: "An agent for your own work", line: "Law, marketing, finance, creative" },
    { title: "Teams of agents", line: "Agents that hand work to each other" },
    { title: "Demo night", line: "The best builds from the series, on stage" },
  ],
  guests: "builders",
  inHands: "guests build on it, not just walk past a logo",
  keepGoing: "who want to keep building after the night",
};

/** The same evening for any other topic, until she approves words of its own. */
export function genericContent(topic: string): TopicContent {
  return {
    leaveFact: "everyone leaves with something they made",
    opening: `"${topic}, right now": real examples from founders and operators, no hype`,
    panel: "three people who do this for real (a founder, an operator, a creative), with audience Q&A",
    dinner: "facilitators help each table choose what it will make",
    build: "step by step, hands-on; facilitators at every table",
    showAndTell: "each table shows what it made",
    bring: "Their own laptop where the evening needs one. Everything is set up on arrival. Anyone without one is paired at their table.",
    leaveWith: "What they made, the step-by-step guide, and introductions to the people at their table.",
    series: [
      { title: `${topic}: the first evening`, line: "Talk + panel: where it already makes a difference" },
      { title: "", line: "" },
      { title: "Going deeper", line: "The next skill, hands-on" },
      { title: "For your own work", line: "Law, marketing, finance, creative" },
      { title: "Together", line: "Working on it as a team" },
      { title: "Show night", line: "The best work from the series, on stage" },
    ],
    guests: "guests",
    inHands: "guests use it, not just walk past a logo",
    keepGoing: "who want to keep going after the night",
  };
}

export const isAgentTopic = (topic: string): boolean => /\bagents?\b/i.test(topic);
export function topicContent(topic: string): TopicContent {
  return isAgentTopic(topic) ? AI_AGENT_CONTENT : genericContent(topic);
}

/** The standard room. Every brand email and pitch says 25–40 guests per event, flexible to the brand's needs. */
export const STANDARD_GUESTS: Seats = TLC_SEATS;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const C = 2 * Math.PI * 60;
const COLORS = ["#1f4e79", "#3f8f6f", "#c2783a", "#8a6db3", "#9a6a00", "#5d6475"];

/** The community wheel: one ring segment per slice, in order, and the size in the middle. */
export function donutSvg(mix: readonly MixSlice[]): string {
  let offset = 0;
  const rings = mix.map((s, i) => {
    const len = (C * s.pct) / 100;
    const ring = `<circle cx="80" cy="80" r="60" stroke="${COLORS[i % COLORS.length]}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
    offset += len;
    return ring;
  });
  const label = `Approximate community mix: ${mix.map((s) => `${s.label.toLowerCase()} ${s.pct}%`).join(", ")}`;
  return `<svg viewBox="0 0 160 160" width="200" height="200" role="img" aria-label="${esc(label)}"><g transform="rotate(-90 80 80)" fill="none" stroke-width="26">${rings.join("")}</g><text x="80" y="76" text-anchor="middle" class="wt1">5,000+</text><text x="80" y="94" text-anchor="middle" class="wt2">community</text></svg>`;
}

const STYLE = `<style>
@page{size:letter;margin:0}
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#1d2230;font:13px/1.45 "IBM Plex Sans",-apple-system,"Helvetica Neue",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:8.5in;height:11in;overflow:hidden;display:flex;flex-direction:column;page-break-after:always;break-after:page}
.sheet:last-child{page-break-after:auto;break-after:auto}
.band{background:#14233a;color:#f4efe4;padding:34px 40px 28px;display:grid;gap:8px;border-bottom:5px solid #c9a24a}
.kick{font-size:10px;letter-spacing:.18em;color:#c9a24a}
.ttl{font:600 34px/1.05 Newsreader,Georgia,serif}.ttl.sm{font-size:28px}
.sub{font-size:13px;color:#d9d3c4}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.facts span{border:1px solid rgba(201,162,74,.55);border-radius:99px;padding:4px 10px;font-size:11.5px}
.body{padding:24px 40px 22px;display:flex;flex-direction:column;gap:14px;flex:1}
h5{font:600 18px Newsreader,Georgia,serif;margin:0;color:#1f4e79}h6{margin:0 0 4px;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#5d6475}
.ros div{display:grid;grid-template-columns:52px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid #e1dfd7}
.ros b{color:#c9a24a;font-variant-numeric:tabular-nums}.ros .hl{background:#faf3e1}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.box{border:1px solid #e1dfd7;border-radius:8px;padding:12px}
.six{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.six div{border:1px solid #e1dfd7;border-radius:8px;padding:12px;display:grid;gap:3px}
.six .hl{border:2px solid #c9a24a}.six i{font-style:normal;font:600 20px Newsreader,Georgia,serif;color:#c9a24a}.six span{font-size:11.5px;color:#5d6475}
.why{margin:0;padding-left:18px}.why li{margin:4px 0}
.wheel{display:flex;gap:22px;align-items:center}.wt1{font:600 20px Newsreader,Georgia,serif;fill:#1d2230}.wt2{font:11px "IBM Plex Sans",sans-serif;fill:#5d6475}
.legend{display:grid;gap:10px;flex:1}.legend div{display:grid;grid-template-columns:14px 1fr;column-gap:8px}
.legend i{width:12px;height:12px;border-radius:3px;margin-top:4px;grid-row:span 2}.legend span{font-size:12px;color:#5d6475}
.tiny{font-size:11px;color:#5d6475;margin-top:-6px}
.foot{margin-top:auto;display:flex;justify-content:space-between;gap:10px;font-size:10.5px;color:#5d6475;border-top:1px solid #e1dfd7;padding-top:10px}
</style>`;

/** "March 2027 (tentative)". */
export const whenWords = (month: string, tentative: boolean): string => `${monthWords(month)}${tentative ? " (tentative)" : ""}`;

/** THE PDF, as print-ready HTML (three US-letter pages). The title names the topic so the PDF check can confirm it. */
export function renderSamplesPdf(i: SamplesInput): string {
  const o = samplesOverridesSchema.parse(i.overrides ?? {});
  const c = { ...topicContent(i.topic), ...(o.bring ? { bring: o.bring } : {}), ...(o.leaveWith ? { leaveWith: o.leaveWith } : {}) };
  const b = esc(i.brand);
  const g = STANDARD_GUESTS;
  const series = o.series ? o.series.map((s) => `<div${s.highlight ? ' class="hl"' : ""}><i>${esc(s.label)}</i><b>${esc(s.title)}</b><span>${esc(s.line)}</span></div>`).join("") : c.series.map((s, k) =>
    k === 1
      ? `<div class="hl"><i>02</i><b>${esc(i.seriesTitle)}</b><span>${b}'s signature evening</span></div>`
      : `<div><i>0${k + 1}</i><b>${esc(s.title)}</b><span>${esc(s.line)}</span></div>`).join("");
  const kick = '<div class="kick">WEST PEEK ROOMS · THE LEARNING CLUB</div>';
  const row = (t: string, what: string, hl = false) => `<div${hl ? ' class="hl"' : ""}><b>${t}</b><span>${what}</span></div>`;
  const page1 = `<section class="sheet"><div class="band">${kick}<div class="ttl">${esc(o.title ?? i.topic)}</div>
<div class="sub">An evening in New York · ${esc(whenWords(i.month, i.tentative))} · in partnership with ${b}</div>
<div class="facts"><span><b>${g.min}–${g.max}</b> guests, flexible to your goals</span><span><b>3½ hours</b> · 6:00–9:30pm</span><span><b>Hands-on</b> · ${esc(c.leaveFact)}</span></div></div>
<div class="body"><h5>The evening</h5><div class="ros">
${o.page1Rows ? o.page1Rows.map((r) => row(esc(r.label), `<strong>${esc(r.title)}</strong> · ${esc(r.line)}`, r.highlight)).join("\n") : [row("6:00", "<strong>Arrival</strong> · drinks, name cards, tables of five set by background"),
row("6:20", `<strong>Opening talk</strong> · ${esc(c.opening)}`),
row("6:40", `<strong>Panel</strong> · ${esc(c.panel)}`),
row("7:15", `<strong>Dinner at the tables</strong> · ${esc(c.dinner)}`),
row("7:45", `<strong>Build session</strong> · ${esc(c.build)}`),
row("8:15", `<strong>${esc(i.segmentTitle)}</strong> · a 15-minute segment led by ${b} or by our host`, true),
row("8:45", `<strong>Show and tell</strong> · ${esc(c.showAndTell)}`),
row("9:05", "<strong>Close</strong> · drinks, introductions, follow-up resources")].join("\n")}
</div><div class="two"><div class="box"><h6>Guests bring</h6><p>${esc(c.bring)}</p></div>
<div class="box"><h6>Guests leave with</h6><p>${esc(c.leaveWith)}</p></div></div>
<div class="foot"><span>We host and facilitate the whole evening. ${b} sends a speaker or team only if it wants to.</span><span>1 / 3</span></div></div></section>`;
  const page2 = `<section class="sheet"><div class="band">${kick}<div class="ttl sm">${esc(o.seriesHeading ?? "A series of six")}</div><div class="sub">${o.seriesSub ? esc(o.seriesSub) : `Each club builds on the last. Dates move with ${b}'s launch calendar.`}</div></div>
<div class="body"><div class="six">${series}</div><h5>Why a series works for a partner</h5><ul class="why">
${o.whyItWorks ? o.whyItWorks.map((l) => `<li>${esc(l)}</li>`).join("\n") : `<li><b>Six evenings, one community:</b> the same ${esc(c.guests)} come back, so your name is part of what they learn.</li>
<li><b>${g.min * 6}–${g.max * 6} ${esc(c.guests)}</b> across the series at the standard size, all hands-on.</li>
<li><b>A story to tell:</b> content from every evening (photos, short clips, the guide) you can use in your own channels.</li>`}</ul>
<div class="foot"><span>${esc(o.footer2 ?? "Founding partners carry the series. Any single evening can be partnered on its own.")}</span><span>2 / 3</span></div></div></section>`;
  const legend = i.mix.map((s, k) => `<div><i style="background:${COLORS[k % COLORS.length]}"></i><b>${esc(s.label)} · ${s.pct}%</b><span>${esc(s.roles.join(", "))}</span></div>`).join("");
  const page3 = `<section class="sheet"><div class="band">${kick}<div class="ttl sm">Who's in the room</div><div class="sub">Guests are invited from our community of 5,000+, shaped around who ${b} wants to reach.</div></div>
<div class="body"><div class="wheel">${donutSvg(i.mix)}<div class="legend">${legend}</div></div><p class="tiny">Approximate mix of our community.</p>
<h5>What partnering gets ${b}</h5><ul class="why">
${o.partnerGets ? o.partnerGets.map((l) => `<li>${esc(l)}</li>`).join("\n") : `<li><b>Your product in their hands:</b> ${esc(c.inHands)}.</li>
<li><b>The guest list you want:</b> we weight the room toward ${esc(o.reach ?? i.reach)}.</li>
<li><b>Your name on the evening:</b> invitations, the guide, the room and the follow-up.</li>
<li><b>Warm introductions</b> to guests ${esc(c.keepGoing)}.</li>
<li><b>Content from the evening</b> for your own channels.</li>`}</ul>
<div class="foot"><span>West Peek Ventures · founding GP Scooter Taylor, creator of Quarantine Con (2020) · ${esc(TLC_OWNER.email)}</span><span>3 / 3</span></div></div></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Learning Club: ${esc(o.title ?? i.topic)} · ${b}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,600&family=IBM+Plex+Sans:wght@400;600&display=swap">${STYLE}${i.overrides ? "<style>.sheet{height:auto;min-height:11in;overflow:visible}</style>" : ""}</head><body>${page1}${page2}${page3}</body></html>`;
}

/** The PDF's file name, from the CURRENT title (her edited one, else the topic) and the brand. */
export function samplesPdfName(i: Pick<SamplesInput, "topic" | "brand" | "overrides">): string {
  const safe = (x: string) => x.replace(/[^\w &-]+/g, "").replace(/\s+/g, " ").trim();
  return `The Learning Club - ${safe(i.overrides?.title ?? i.topic)} - ${safe(i.brand)}.pdf`;
}

/** Her edits in plain words, for the "what changed" line: the parts of the document a change touched. */
const PART_WORDS: Record<keyof SamplesOverrides, string> = {
  title: "the title", page1Rows: "the evening's running order (page 1)", bring: "what guests bring (page 1)", leaveWith: "what guests leave with (page 1)",
  series: "the six evenings (page 2)", seriesHeading: "the page 2 heading", seriesSub: "the line under the page 2 heading",
  whyItWorks: "why a series works (page 2)", footer2: "the page 2 footer", partnerGets: "what partnering gets them (page 3)", reach: "who the room is weighted toward (page 3)",
};
/** One line: what changed, in her words. Built from the fields that changed, never from a model's claim about them. */
export function whatChangedLine(patch: SamplesOverrides, note: string): string {
  const parts = (Object.keys(patch) as Array<keyof SamplesOverrides>).map((k) => PART_WORDS[k]).filter(Boolean);
  const said = note.replace(/\s+/g, " ").trim();
  const quote = said ? ` (your note: "${said.length > 90 ? `${said.slice(0, 89).trimEnd()}…` : said}")` : "";
  if (parts.length === 0) return `Looked at your note; nothing needed to change${quote}`;
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
  return `Changed ${list}${quote}`;
}

export interface SamplesPreviewView {
  brand: string;
  /** DRAFT: being shaped with her; WORKING: her latest note is still being applied; SENT: gone to the brand. */
  status: "DRAFT" | "WORKING" | "SENT";
  sentAt?: string | null;
  /** Newest first. */
  history: ReadonlyArray<{ at: string; line: string }>;
}

const PREVIEW_STYLE = `<style id="wp-preview-style">
@media screen{html,body{background:#eceae4}body{padding:0 0 32px}.sheet{margin:16px auto;box-shadow:0 1px 6px rgba(0,0,0,.18);background:#fff}}
@media print{.wp-preview{display:none!important}}
.wp-preview{max-width:8.5in;margin:0 auto;padding:16px 16px 4px;font:16px/1.5 -apple-system,"Helvetica Neue",Arial,sans-serif;color:#1d2230}
.wp-preview h1{font:600 22px/1.25 Georgia,serif;margin:0 0 6px}.wp-preview p{margin:6px 0}
.wp-preview .tag{display:inline-block;border-radius:99px;padding:2px 10px;font-size:14px;font-weight:600;margin-bottom:8px}
.wp-preview .draft{background:#f6ecd0;color:#5b4300}.wp-preview .sent{background:#dcefe3;color:#1e5a36}
.wp-preview .note{background:#fff;border:1px solid #d9d5ca;border-radius:10px;padding:12px 14px;margin:10px 0}
.wp-preview .warn{background:#fdf3d6;border-color:#e3c46d}
.wp-preview details{background:#fff;border:1px solid #d9d5ca;border-radius:10px;padding:10px 14px;margin:10px 0}
.wp-preview summary{cursor:pointer;font-weight:600;min-height:32px;display:flex;align-items:center}
.wp-preview ol{margin:8px 0 4px;padding-left:20px}.wp-preview li{margin:6px 0}.wp-preview time{color:#5d6475;font-size:14px;display:block}
</style>`;

const dayWords = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
};

/**
 * THE PRIVATE PREVIEW PAGE (owner, 30 Oct 2026). The document part is `pdfHtml` byte for byte (the same string the
 * PDF is made from at her "approved"), so what she sees is what the brand gets. Above it, for her alone and never
 * printed: where it stands, how to change it, and what changed so far (collapsed; the latest change shows without
 * opening). A page that would print longer than one sheet is named, in yellow, with what to do.
 */
export function renderSamplesPreview(pdfHtml: string, v: SamplesPreviewView): string {
  const latest = v.history[0];
  const head = v.status === "SENT"
    ? `<span class="tag sent">Sent${v.sentAt ? ` · ${esc(dayWords(v.sentAt))}` : ""}</span><h1>The samples ${esc(v.brand)} received</h1><p>This went with your answer. Nothing here can change it now.</p>`
    : `<span class="tag draft">Draft · not sent yet</span><h1>Samples for ${esc(v.brand)}</h1>
<p>This is exactly what the PDF will look like. On a phone, pinch to zoom in on the pages.</p>
<div class="note"><p><b>To change something:</b> reply to Wynn's email and say what to change. This page updates; no new PDF is made.</p>
<p><b>When it looks right:</b> reply <b>approved</b>. The PDF is made from this page then, and goes with your answer.</p></div>`;
  const working = v.status === "WORKING" ? `<div class="note warn"><p><b>Your latest change is still being made.</b> This page shows the version before it. Nothing for you to do; it updates on its own.</p></div>` : "";
  const history = v.history.length
    ? `<details><summary>What changed (${v.history.length}): tap to show ▾</summary><ol>${v.history.map((h) => `<li>${esc(h.line)}<time>${esc(dayWords(h.at))}</time></li>`).join("")}</ol></details>
${latest ? `<p><b>Latest:</b> ${esc(latest.line)}</p>` : ""}`
    : "";
  const longCheck = v.status === "SENT" ? "" : `<div class="note warn" id="wp-long" hidden><p><b>A page runs longer than one printed sheet.</b> Reply to Wynn with what to shorten, so the PDF stays 3 pages.</p></div>
<script>(function(){var s=document.querySelectorAll(".sheet"),w=document.documentElement.clientWidth,z=Math.min(1,(w-16)/816),long=false;for(var i=0;i<s.length;i++){if(s[i].scrollHeight>1060)long=true;if(z<1)s[i].style.zoom=String(z);}if(long)document.getElementById("wp-long").hidden=false;})();</script>`;
  const chrome = `<div class="wp-preview" role="region" aria-label="About this draft">${head}${working}${history}</div>`;
  return pdfHtml
    .replace("<head>", '<head><meta name="robots" content="noindex, nofollow">')
    .replace("</head>", `${PREVIEW_STYLE}</head>`)
    .replace("<body>", `<body>${chrome}`)
    .replace("</body>", `${longCheck}</body>`);
}

/** What the template must never carry: a price, a brand put on the hook for a segment, a mix that is not 100. */
export function samplesProblems(html: string, mix: readonly MixSlice[], approvedPrices: readonly string[] = []): string[] {
  const text = html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
  const out: string[] = [];
  let priceText = text;
  let usedApproval = false;
  priceText = priceText.replace(PRICE_AMOUNT, (amount) => {
    if (!approvedPrices.includes(amount.trim())) return amount;
    usedApproval = true;
    return " ";
  });
  if (usedApproval) priceText = priceText.replace(/\b(?:price|prices|pricing|priced|cost|costs|fee|fees)\b/gi, " ");
  if (MONEY_WORDS.test(priceText) || /[$£€]\s*\d/.test(priceText)) out.push("a price, fee or tier");
  if (BRAND_MUST_STAFF.test(text)) out.push("a segment the brand must staff");
  if (Math.round(mix.reduce((a, s) => a + s.pct, 0)) !== 100) out.push("a community mix that does not add up to 100");
  if (!/Approximate mix of our community/.test(text)) out.push("the mix is not labelled approximate");
  if (!(text.match(/\b[123] \/ 3\b/g)?.length === 3)) out.push("not three pages");
  return out;
}

/**
 * The cover email, word for word (her design, "a short 3-page PDF"). Her design said "where your team leads the
 * memory segment"; her later rule (we host every segment, "led by <brand> or by our host") wins. Signature after.
 */
export function samplesCoverEmail(i: { brand: string; contactName: string | null; topic: string; segmentTitle: string }): string {
  return fillTemplate("cover", {
    hi: hiLine(i.contactName), brand: i.brand, segment: i.segmentTitle,
    arc: isAgentTopic(i.topic) ? "a run that follows the arc of building an agent" : `a run of evenings on ${i.topic}`,
  });
}

/**
 * A YES TO THE SAMPLES. Read only on a deal whose last email from us offered them, so "sure" means "send it".
 * A no, or a "not now", is never a yes.
 */
export function isYesToSamples(text: string): boolean {
  const t = text.replace(/[’]/g, "'").toLowerCase();
  if (replyLooksLikeNo(t) || /\b(?:not (?:right )?now|not at this time|no need|maybe later|hold off)\b/.test(t)) return false;
  return /\b(?:sure|yes|yeah|yep|absolutely|definitely|please do|please send|send (?:it|them|those|that|it over|them over|over|along)|would love (?:to see|that|them|it)|love to see|happy to (?:see|take a look|look)|sounds (?:good|great)|go ahead|that would be (?:great|helpful|lovely)|share (?:them|it)|take a look)\b/.test(t);
}

/** A direct request names the materials, so it does not require a previous offer. */
export function requestsSamples(text: string): boolean {
  if (replyLooksLikeNo(text) || /\b(?:not now|not right now|no need|hold off|don't send|do not send)\b/i.test(text)) return false;
  return /\b(?:send|share|see|receive|look at)\b[^.!?\n]{0,100}\b(?:samples|materials|pdf|run of show|series of six)\b/i.test(text);
}
