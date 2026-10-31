/**
 * THE THREE SAMPLES, AS ONE 3-PAGE PDF (owner, 26 Oct 2026; the standard template since 30 Oct 2026, "yes. make it a
 * real template"). When a brand says yes to Wynn's offer ("send it", "sure"), Parker builds one document for that
 * brand from this template; her "approved" makes the PDF and sends it with the cover email.
 *
 * THE TEMPLATE IS HER FINAL PINECONE DOCUMENT. Every brand gets the same standard text: "2027 (dates flexible)",
 * 25 to 100+ guests, 3½ hours (6:00–9:30pm), the evening's shape (arrival · the opening talk with a 2-minute brand
 * welcome · panel · dinner · build · the brand's 30-minute hands-on segment · show and tell · close), the laptop
 * box, the series intro, "Who's in the room" (~5,000, the wheel, the approximation note), the "A room your size"
 * perk, the team, the CONFIDENTIAL · PRELIMINARY footers and the legal block. Only `SamplesWords` change per brand:
 * the title, the opening theme, the panel angle, the brand's segment, what guests leave with, the six months, the
 * middle "why six months" point and the brand's perks. The model writes those and nothing else.
 *
 * `samplesProblems` checks the rules that remain: no price (bar one the owner explicitly put in), no segment the
 * brand must staff, a mix that adds to 100 and is labelled approximate, three pages. PURE: no database, no network.
 */
import { z } from "zod";
import { BRAND_MUST_STAFF, MONEY_WORDS } from "./brandReply";
import { fillTemplate, hiLine } from "./brandFlow";
import { BRAND_ROOM_WORDS, TLC_OWNER, replyLooksLikeNo } from "./learningClub";

export const COMMUNITY_MIX_SETTING = "community_mix_json";
/** A slice of the wheel: its roles, and an optional note after them ("; many are intrapreneurs…"). */
export interface MixSlice { label: string; pct: number; roles: string[]; note?: string }
/**
 * Her approximate spread (26 Oct 2026; words from her final Pinecone document, 30 Oct 2026). The live copy is the D1
 * setting (migration 0281 moved it here); this is also the fallback when the stored one is broken.
 */
export const DEFAULT_COMMUNITY_MIX: readonly MixSlice[] = [
  { label: "Operators", pct: 35, roles: ["marketing", "finance", "product", "sales and people teams"], note: "many are intrapreneurs building side businesses with AI tools like Claude and Codex outside work" },
  { label: "Creators", pct: 35, roles: ["film", "music", "design", "writing and content"] },
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
      ...(typeof (s as MixSlice).note === "string" && (s as MixSlice).note!.trim() ? { note: (s as MixSlice).note!.trim() } : {}),
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
  /** After "The Learning Club: " on page 1, in the document's title and the PDF's file name (default: the brand's title). */
  title: z.string().trim().min(1).max(120).optional(),
  page1Rows: z.array(z.object({ label: copy, title: copy, line: copy, highlight: z.boolean().optional() }).strict()).min(1).max(20).optional(),
  series: z.array(z.object({ label: copy, title: copy, line: copy, highlight: z.boolean().optional() }).strict()).min(1).max(12).optional(),
  seriesHeading: copy.optional(), seriesSub: copy.optional(),
  whyItWorks: z.array(copy).min(1).max(12).optional(),
  partnerGets: z.array(copy).min(1).max(12).optional(), footer2: copy.optional(),
  bring: copy.optional(), leaveWith: copy.optional(),
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
 * THE WORDS THAT CHANGE PER BRAND (owner, 30 Oct 2026: "yes. make it a real template"). Her final Pinecone document
 * is the standard for every brand; these are the ONLY parts written for each brand (her approved split, shown on a
 * made-up brand). Everything else on the three pages is fixed text in `renderSamplesPdf`, never given to a model.
 */
const word = (max: number) => z.string().trim().min(1).max(max);
export const samplesWordsSchema = z.object({
  /** After "The Learning Club: " on page 1, in the title and in the PDF's name ("Your AI Chief of Staff"). */
  title: word(70),
  /** The third pill on page 1, after "Hands-on · " ("everyone leaves with a working assistant"). */
  leaveFact: word(70),
  /** The opening talk's theme, shown in quotes ("What an AI chief of staff can take off your plate"). */
  openingTheme: word(90),
  /** The panel: "three builders on {panelAngle} (a founder, an operator, a creative)". */
  panelAngle: word(90),
  /** Dinner: "facilitators help each table {dinnerPick}" ("pick the assistant they'll build"). */
  dinnerPick: word(70),
  /** The brand's 30-minute hands-on segment ("Turning meeting notes into action"). */
  segmentTitle: word(60),
  /** "30 minutes, hands-on: {segmentDoes}, led by {brand} or by our host" ("every table connects Kestrel to its assistant"). */
  segmentDoes: word(110),
  /** "Guests leave with: {leaveWith}, the step-by-step guide, and introductions…" ("A working AI chief of staff of their own"). */
  leaveWith: word(80),
  /** Page 2 heading, after "A sample series: " ("six months of AI at work"). */
  seriesTitle: word(70),
  /** The end of page 2's intro, after "one build that grows every month, " ("with Kestrel built in from month 3 on."). */
  seriesTail: word(110),
  /** The six months, in order: each title follows "The Learning Club: "; `brand` marks the brand's month(s). */
  months: z.array(z.object({ title: word(60), line: word(130), brand: z.boolean() }).strict()).length(6)
    .refine((m) => m.some((x) => x.brand), "at least one month is the brand's"),
  /** The middle "why six months" point: a bold lead and its line. */
  whyLead: word(60), whyLine: word(130),
  /** What partnering gets the brand, before the standard "A room your size" point: a bold lead and its line each. */
  perks: z.array(z.object({ lead: word(70), line: word(140) }).strict()).min(1).max(4),
}).strict();
export type SamplesWords = z.infer<typeof samplesWordsSchema>;
/** The words as first stored (before 30 Oct 2026): three phrases. Read only to complete an older row. */
export interface LegacySamplesWords { segmentTitle?: string; seriesTitle?: string; reach?: string }

export interface SamplesInput {
  brand: string;
  topic: string;
  /** YYYY-MM: the year on page 1 ("2027 (dates flexible)"). */
  month: string;
  words: SamplesWords;
  mix: readonly MixSlice[];
  overrides?: SamplesOverrides;
}

/** "The Learning Club: Build Your First AI Agent" and "Build Your First AI Agent" name the same club. */
export const clubTitle = (topic: string): string => topic.replace(/^\s*the learning club\s*[:·-]\s*/i, "").trim() || topic.trim();

export const isAgentTopic = (topic: string): boolean => /\bagents?\b/i.test(topic);

/**
 * The brand's words when none were written (the model failed, or an older row kept only three phrases): plain and
 * true for any brand, never an exclusivity claim or a number. An older row's segment and evening names are kept.
 */
export function fallbackWords(brand: string, topic: string, legacy: LegacySamplesWords = {}): SamplesWords {
  const t = clubTitle(topic);
  const brandMonth = legacy.seriesTitle?.trim() || `${t}, With ${brand}`;
  return {
    title: t,
    leaveFact: "everyone leaves with something they built",
    openingTheme: `${t}, right now`,
    panelAngle: "what changed when they put it to work",
    dinnerPick: "choose what it will build",
    segmentTitle: legacy.segmentTitle?.trim() || `Where ${brand} comes in`,
    segmentDoes: `every table puts ${brand} to work in what it builds`,
    leaveWith: "Something they built themselves",
    seriesTitle: `six months of ${t}`,
    seriesTail: `with ${brand} built in from month two on.`,
    months: [
      { title: t, line: "Everyone leaves with a first working build.", brand: false },
      { title: brandMonth, line: `The build grows, with ${brand} at its centre.`, brand: true },
      { title: "Going Deeper", line: "The next skill, hands-on.", brand: false },
      { title: "For Your Own Work", line: "Law, marketing, finance, creative: the same build, for your job.", brand: false },
      { title: "Better Together", line: "Builds that work as a team.", brand: false },
      { title: "Demo Night", line: "Show what you built: demo night for the whole series.", brand: false },
    ],
    whyLead: "Real work, not a demo:",
    whyLine: "members keep using what they built after the series ends.",
    perks: [
      { lead: `The "${t}" partner`, line: "for the whole series." },
      { lead: "Built in from day one:", line: `${brand} is part of every build guests make.` },
    ],
  };
}

/** A stored row's words, complete: the full set when it parses, else the plain words around what the row kept. */
export function completeWords(raw: unknown, brand: string, topic: string): SamplesWords {
  const full = samplesWordsSchema.safeParse(raw);
  return full.success ? full.data : fallbackWords(brand, topic, (raw ?? {}) as LegacySamplesWords);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const C = 2 * Math.PI * 60;
const COLORS = ["#1f4e79", "#3f8f6f", "#c2783a", "#8a6db3", "#9a6a00", "#5d6475"];

/** The community, as every brand is told it (owner, 30 Oct 2026): about 5,000, never "5,000+". */
export const COMMUNITY_SIZE = "~5,000";

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
  return `<svg viewBox="0 0 160 160" width="200" height="200" role="img" aria-label="${esc(label)}"><g transform="rotate(-90 80 80)" fill="none" stroke-width="26">${rings.join("")}</g><text x="80" y="76" text-anchor="middle" class="wt1">${COMMUNITY_SIZE}</text><text x="80" y="94" text-anchor="middle" class="wt2">community</text></svg>`;
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
.ppl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:6px}.ppl div{border:1px solid #d9c27a;border-radius:6px;padding:8px}.ppl b{display:block;font-size:12px;margin-bottom:3px}.ppl span{font-size:9.5px;line-height:1.4;color:#444}
.legal{font-size:7.5px;line-height:1.45;color:#6b7080;border-top:1px solid #e1dfd7;padding-top:6px;margin-top:10px}.conf{font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:8.5px;color:#8a6d1f}
</style>`;

/**
 * THE TEAM BEHIND THE ROOM, word for word from her final Pinecone document (30 Oct 2026). Standard on every brand's
 * page 3. The figure in Sequoia's line is her track record, not a price: `samplesProblems` reads the page without it.
 */
export const TEAM_HTML = `<h5>The team behind the room</h5><div class="ppl">
<div><b>Scooter Taylor</b><span>Co-Managing Partner, West Peek Ventures. Founding GP. Went viral in 2020 creating Quarantine Con, the online gathering that grew into West Peek: a community of ${COMMUNITY_SIZE} founders, operators, creatives and investors across New York, San Francisco and Atlanta. Leads brand, community and culture partnerships, and hosts West Peek Rooms, our in-person event series.</span></div>
<div><b>Sequoia Taylor</b><span>Co-Managing Partner, West Peek Ventures. A decade in investment banking and capital markets at Raymond James; more than $100M in secondary transactions. Venture Partner to two early-stage funds. Leads West Peek’s investing and LP relationships, and builds the AI agents the firm runs on day to day. Wellesley College.</span></div>
<div><b>Carlos Barksdale</b><span>Events Consultant, West Peek. Led venture capital business development at Google in New York, building partnerships between Google, VCs and startups, with a deep network of venture investors, founders and developers. Founder of Glory By Us; earlier Lukka and Clearco. B.S. Operations Research, Columbia; founding board member, Columbia Engineering BAA.</span></div></div>`;

/** The legal block on page 3, with the brand's name in it and first in the trademark list. */
export const legalHtml = (b: string): string =>
  `<div class="legal"><b>Confidential · Preliminary draft · For discussion purposes only.</b> This document was prepared by West Peek Ventures for ${b} and is confidential. Please do not share it outside ${b} without our written consent. It is an illustrative proposal, not an offer, commitment or binding agreement. Dates, formats, guest numbers, programming, speakers, deliverables and partner benefits are examples only, may change, and become binding only in a definitive written agreement signed by both parties. Community size, audience mix and member titles are approximate estimates. ${b}, Claude, Google, Columbia and other names and trademarks belong to their owners, are used for identification only, and do not imply endorsement. © 2026 West Peek Ventures. All rights reserved.</div>`;

/** The note under the wheel. */
export const MIX_NOTE = "All numbers, the mix and titles are approximate, based on how members describe themselves. Creators and operators together are well over half the community.";

/** Page 1's date line: the year only, never a month and never "tentative" (owner, 30 Oct 2026). */
export const whenWords = (month: string): string => `${/^\d{4}/.exec(month)?.[0] ?? "2027"} (dates flexible)`;

/** THE PDF, as print-ready HTML (three US-letter pages). Only `i.words` (and her per-deal edits) change per brand. */
export function renderSamplesPdf(i: SamplesInput): string {
  const o = samplesOverridesSchema.parse(i.overrides ?? {});
  const w = samplesWordsSchema.parse(i.words);
  const b = esc(i.brand);
  const title = esc(o.title ?? w.title);
  const conf = (s: string) => `<span class="conf">Confidential · Preliminary</span> · ${s}`;
  const kick = '<div class="kick">WEST PEEK ROOMS · THE LEARNING CLUB</div>';
  const row = (t: string, what: string, hl = false) => `<div${hl ? ' class="hl"' : ""}><b>${t}</b><span>${what}</span></div>`;
  const rows = o.page1Rows
    ? o.page1Rows.map((r) => row(esc(r.label), `<strong>${esc(r.title)}</strong> · ${esc(r.line)}`, r.highlight)).join("\n")
    : [row("6:00", "<strong>Arrival</strong> · drinks, name cards, tables of five set by background"),
      row("6:20", `<strong>Opening talk, with a 2-minute welcome from ${b}</strong> · ${esc(`"${w.openingTheme}"`)}: real examples from founders and operators, no hype`),
      row("6:40", `<strong>Panel</strong> · three builders on ${esc(w.panelAngle)} (a founder, an operator, a creative), with audience Q&amp;A`),
      row("7:15", `<strong>Dinner at the tables</strong> · facilitators help each table ${esc(w.dinnerPick)}`),
      row("7:45", "<strong>Build session</strong> · step by step, in the browser, no code needed; facilitators at every table"),
      row("8:15", `<strong>${esc(w.segmentTitle)}</strong> · 30 minutes, hands-on: ${esc(w.segmentDoes)}, led by ${b} or by our host`, true),
      row("8:45", "<strong>Show and tell</strong> · each table demos what it built"),
      row("9:05", "<strong>Close</strong> · drinks, introductions, follow-up resources")].join("\n");
  const bring = o.bring ?? "Their own laptop. Everything runs in the browser with free accounts set up on arrival. Anyone without a laptop is paired at their table.";
  const leaveWith = o.leaveWith ?? `${w.leaveWith}, the step-by-step guide, and introductions to the people at their table.`;
  const page1 = `<section class="sheet"><div class="band">${kick}<div class="ttl">The Learning Club: ${title}</div>
<div class="sub">An evening in New York · ${esc(whenWords(i.month))} · in partnership with ${b}</div>
<div class="facts"><span><b>${BRAND_ROOM_WORDS}</b> guests, sized to your goals</span><span><b>3½ hours</b> · 6:00–9:30pm</span><span><b>Hands-on</b> · ${esc(w.leaveFact)}</span></div></div>
<div class="body"><h5>The evening</h5><div class="ros">
${rows}
</div><div class="two"><div class="box"><h6>Guests bring</h6><p>${esc(bring)}</p></div>
<div class="box"><h6>Guests leave with</h6><p>${esc(leaveWith)}</p></div></div>
<div class="foot"><span>${conf(`We host and facilitate the whole evening. ${b} sends a speaker or team only if it wants to.`)}</span><span>1 / 3</span></div></div></section>`;
  const cards = o.series
    ? o.series.map((s) => `<div${s.highlight ? ' class="hl"' : ""}><i>${esc(s.label)}</i><b>${esc(s.title)}</b><span>${esc(s.line)}</span></div>`).join("")
    : w.months.map((m, k) => `<div${m.brand ? ' class="hl"' : ""}><i>Month ${k + 1}</i><b>The Learning Club: ${esc(m.title)}</b><span>${esc(m.line)}</span></div>`).join("");
  const why = o.whyItWorks ? o.whyItWorks.map((l) => `<li>${esc(l)}</li>`).join(" ") : [
    `<li><b>Two full quarters of visibility:</b> the same people come back every month, and ${b} is part of what they learn, not a logo they pass.</li>`,
    `<li><b>${esc(w.whyLead)}</b> ${esc(w.whyLine)}</li>`,
    "<li><b>Builders and their teams:</b> independent builders plus people from companies joining with team seats.</li>"].join(" ");
  const page2 = `<section class="sheet"><div class="band">${kick}<div class="ttl sm">${o.seriesHeading ? esc(o.seriesHeading) : `A sample series: ${esc(w.seriesTitle)}`}</div><div class="sub">${o.seriesSub ? esc(o.seriesSub) : `Partner on a single evening, or on a series of 6 or more. Here is a sample series of six, to show what one could look like: one build that grows every month, ${esc(w.seriesTail)}`}</div></div>
<div class="body"><div class="six">${cards}</div><h5>Why six months works for a partner</h5><ul class="why"> ${why}</ul>
<div class="foot"><span>${conf(o.footer2 ? esc(o.footer2) : `Dates move with ${b}'s launch calendar. Any single month can be partnered on its own.`)}</span><span>2 / 3</span></div></div></section>`;
  const legend = i.mix.map((s, k) => `<div><i style="background:${COLORS[k % COLORS.length]}"></i><b>${esc(s.label)} · ~${s.pct}%</b><span>${esc(s.roles.join(", "))}${s.note ? `; ${esc(s.note)}` : ""}</span></div>`).join("");
  const perks = (o.partnerGets ? o.partnerGets.map((l) => `<li>${esc(l)}</li>`) : w.perks.map((p) => `<li><b>${esc(p.lead)}</b> ${esc(p.line)}</li>`)).join(" ");
  const page3 = `<section class="sheet"><div class="band">${kick}<div class="ttl sm">Who's in the room</div><div class="sub">Guests are invited from our community of ${COMMUNITY_SIZE}, shaped around who ${b} wants to reach.</div></div>
<div class="body"><div class="wheel">${donutSvg(i.mix)}<div class="legend">${legend}</div></div><p class="tiny">${MIX_NOTE}</p>
<h5>What partnering gets ${b}</h5><ul class="why"> ${perks} <li><b>A room your size:</b> from an intimate ${BRAND_ROOM_WORDS} guests, and the guest list you want: invitations and room in your name, warm introductions after, and content from every evening for your channels.</li></ul>${TEAM_HTML}
${legalHtml(b)}<div class="foot"><span>${conf(`West Peek Ventures · ${esc(TLC_OWNER.email)}`)}</span><span>3 / 3</span></div></div></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Learning Club: ${title} · ${b}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,600&family=IBM+Plex+Sans:wght@400;600&display=swap">${STYLE}${i.overrides ? "<style>.sheet{height:auto;min-height:11in;overflow:visible}</style>" : ""}</head><body>${page1}${page2}${page3}</body></html>`;
}

/** The PDF's file name, from the CURRENT title (her edited one, else the brand's) and the brand. */
export function samplesPdfName(i: Pick<SamplesInput, "brand" | "words" | "overrides">): string {
  const safe = (x: string) => x.replace(/[^\w &-]+/g, "").replace(/\s+/g, " ").trim();
  return `The Learning Club - ${safe(i.overrides?.title ?? i.words.title)} - ${safe(i.brand)}.pdf`;
}

/** Her edits in plain words, for the "what changed" line: the parts of the document a change touched. */
const PART_WORDS: Record<keyof SamplesOverrides, string> = {
  title: "the title", page1Rows: "the evening's running order (page 1)", bring: "what guests bring (page 1)", leaveWith: "what guests leave with (page 1)",
  series: "the six months (page 2)", seriesHeading: "the page 2 heading", seriesSub: "the line under the page 2 heading",
  whyItWorks: "why six months works (page 2)", footer2: "the page 2 footer", partnerGets: "what partnering gets them (page 3)",
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

/** Standard text no per-deal edit can remove (the parts of every brand's document her edits do not replace). */
export const STANDARD_TEXT: readonly string[] = [
  " (dates flexible)", `<b>${BRAND_ROOM_WORDS}</b> guests, sized to your goals`, "<b>3½ hours</b> · 6:00–9:30pm",
  `community of ${COMMUNITY_SIZE}`, `<text x="80" y="76" text-anchor="middle" class="wt1">${COMMUNITY_SIZE}</text>`, MIX_NOTE,
  `<li><b>A room your size:</b> from an intimate ${BRAND_ROOM_WORDS} guests`, TEAM_HTML, "<b>Confidential · Preliminary draft · For discussion purposes only.</b>",
];
/** What the template used to say and must never say again (owner, 30 Oct 2026). */
export const NEVER_TEXT: readonly string[] = ["5,000+", "25–40", "Quarantine Con (2020)", "tentative"];

/** What the template must never carry: a price, a brand put on the hook for a segment, a mix that is not 100. */
export function samplesProblems(html: string, mix: readonly MixSlice[], approvedPrices: readonly string[] = []): string[] {
  // The team's bios are fixed text (a track record, not a price), so the rules read the page without them.
  const text = html.split(TEAM_HTML).join(" ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&");
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
  if (!text.includes(MIX_NOTE)) out.push("the mix is not labelled approximate");
  if (!(text.match(/\b[123] \/ 3\b/g)?.length === 3)) out.push("not three pages");
  for (const p of STANDARD_TEXT) if (!html.includes(p)) out.push(`the standard text is missing: "${p}"`);
  if ((html.match(/<span class="conf">Confidential · Preliminary<\/span>/g) ?? []).length !== 3) out.push("a page without its Confidential · Preliminary footer");
  for (const p of NEVER_TEXT) if (text.includes(p)) out.push(`old text that the template no longer says: "${p}"`);
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
