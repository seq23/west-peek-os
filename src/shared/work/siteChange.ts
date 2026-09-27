/**
 * A WEBSITE JOB, SAID PLAINLY (23 Sep 2026, the work-card redesign).
 *
 * Two readers the desk row, the expanded card and the card's own page all share, so none of them
 * words a site change its own way:
 *
 *   · `plainTitle` — "Community site redesign · joinwestpeek.com". Porter's card used to be titled
 *     with the first 90 characters of the brief the door wrote for him, which is the partner's email
 *     cut off mid-word: `Change joinwestpeek.com: "Porter, We need to get started on the communi`.
 *     The subject she typed is the name she gave the job; failing that, the first thing her email
 *     asks for; and the site it touches after a middle dot.
 *
 *   · `siteStage` — where the job is on Plan → Build → Preview → Live, from the facts on the
 *     `web_property_change` row (never a sentence a model wrote about itself).
 */

import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

export const SITE_STAGES = [
  { key: "PLAN", label: "Plan" },
  { key: "BUILD", label: "Build" },
  { key: "PREVIEW", label: "Preview" },
  { key: "LIVE", label: "Live" },
] as const;

export type SiteStageKey = (typeof SITE_STAGES)[number]["key"];

export interface SiteStageInput {
  phase: string | null | undefined;
  preview_url?: string | null;
  land_approved_at?: string | null;
  merge_sha?: string | null;
  preview_only?: number | null;
  publish_ready?: number | null;
}

/**
 * Which stage is current, and whether the whole job is finished. A LAND that still needs the
 * preview approved is Preview, not Live — "Nothing goes live until you reply approved" has to be
 * true of the track as well as the email.
 */
export function siteStage(row: SiteStageInput): { index: number; key: SiteStageKey; finished: boolean } {
  const phase = (row.phase ?? "PLAN").toUpperCase();
  const gated = row.preview_only === 1 || row.publish_ready === 0;
  let index = 0;
  if (phase === "DONE" || row.merge_sha) index = 3;
  else if (phase === "LAND") index = gated && !row.land_approved_at ? 2 : 3;
  else if (phase === "BUILD") index = row.preview_url ? 2 : 1;
  const finished = phase === "DONE";
  return { index, key: SITE_STAGES[index]!.key, finished };
}

const GREETING = /^(?:(?:[Hh]i|[Hh]ey|[Hh]ello|[Dd]ear)\s+)?[A-Z][a-z]+\s*[,—–-]\s*/;
const LEADS = [
  /^(?:we|i)\s+(?:need|want|would like|'d like)\s+(?:you\s+)?to\s+(?:get started on|start on|start|begin|do|make|build|work on|have)\s+/i,
  /^(?:please|can you|could you|would you|let'?s)\s+(?:get started on|start on|start|begin|do|make|build|work on)?\s*/i,
];

/** "Porter: ", "Walker: " … — the subject prefix every employee email carries (`execSubject`), for any name on the roster. */
const EMPLOYEE_PREFIX_RE = new RegExp(`^(?:${AI_EMPLOYEE_ROSTER.map((e) => e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}):\\s+`, "i");

function cleanSubject(subject: string): string {
  let s = subject.trim();
  // "From seq@…: Community site redesign" — the intake card's own title shape.
  s = s.replace(/^From\s+\S+:\s*/i, "");
  for (;;) {
    // "Re:", "Fwd:" — and OUR OWN EMPLOYEE'S PREFIX (27 Sep 2026): a request that arrived as a reply
    // to "Porter: Community site redesign — now yours" is named "Community site redesign", never
    // "Porter" (which then read "Porter: Porter: Got it" in the subject line).
    const next = s.replace(/^(?:re|fwd?|fw)\s*:\s*/i, "").replace(EMPLOYEE_PREFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  if (/^\(no subject\)$/i.test(s)) return "";
  return s;
}

function stripHost(text: string, host: string | null): string {
  if (!host) return text;
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`\\s*\\((?:https?://)?(?:www\\.)?${esc}/?\\)`, "gi"), "")
    .replace(new RegExp(`\\s+(?:on|for|at|to)\\s+(?:the\\s+)?(?:https?://)?(?:www\\.)?${esc}/?`, "gi"), "")
    .trim();
}

/** Cut at a word, never mid-word; no trailing punctuation. */
function atWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.4 ? cut.slice(0, lastSpace) : cut).replace(/[,;:·—-]+$/, "")}…`;
}

function capital(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** The first thing the request asks for, as a short noun phrase where one can be found. */
export function shortAsk(text: string | null | undefined, host: string | null = null, max = 56): string {
  return readAsk(text, host, max).name;
}

function readAsk(text: string | null | undefined, host: string | null, max: number): { name: string; led: boolean } {
  let t = (text ?? "").replace(/\r/g, "").trim();
  if (!t) return { name: "", led: false };
  // The door's own brief wraps her words in `Change host: "…"` — unwrap it.
  const quoted = /^Change\s+[^:]+:\s*"([\s\S]*?)(?:"|$)/.exec(t);
  if (quoted) t = quoted[1]!;
  t = t.replace(GREETING, "");
  const firstLine = t.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 0 && !/^[A-Z][a-z]+,?$/.test(l)) ?? "";
  const stop = firstLine.search(/[.!?](\s|$)/);
  let s = stop >= 0 ? firstLine.slice(0, stop) : firstLine;
  let led = false;
  for (const lead of LEADS) {
    const next = s.replace(lead, "");
    if (next !== s) led = true;
    s = next;
  }
  s = s.replace(/^the\s+/i, "");
  s = stripHost(s, host);
  // A parenthesis the cut left open ("(j") is a fragment, not a word.
  s = s.replace(/\s*\([^)]*$/, "");
  return { name: capital(atWord(s, max)), led };
}

/**
 * The job's name from her request, but ONLY when the request names it in the shape a request does —
 * "we need to get started on the community site redesign", "can you fix the footer links". Anything
 * else ("we need the redesign") is not a name, and the subject's first clause is better.
 */
function askName(text: string | null | undefined, host: string | null): string {
  const out = readAsk(text, host, 56);
  return out.led ? out.name : "";
}

export interface PlainTitleInput {
  title: string;
  kind?: string | null;
  /** The site's host, from the web_property_change row or the card's own request. */
  host?: string | null;
  /** The subject she typed, or the title of the card it was handed off from ("From x: subject"). */
  subject?: string | null;
  /** The request as she wrote it. */
  ask?: string | null;
}

/**
 * The subject's own name for the job: its first clause. "Community site redesign — everything is in
 * the Drive folder" is a name followed by a sentence; the name is the part before the dash (live on
 * wc_c9e36e8b, 23 Sep 2026, where the whole subject became the title).
 */
function subjectName(subject: string, host: string | null): string {
  const clean = stripHost(cleanSubject(subject), host);
  const first = clean.split(/\s+[—–-]\s+|:\s+|;\s+|\.\s+/)[0] ?? "";
  return first.trim();
}

export function plainTitle(input: PlainTitleInput): string {
  if (input.kind !== "WEB_PROPERTY_CHANGE") return input.title;
  const host = input.host && input.host !== "unresolved" ? input.host : null;
  // THE NAME SHE GAVE IT, NOT THE SENTENCE AFTER IT (owner review, 23 Sep 2026). On wc_c9e36e8b the
  // whole subject became the title: "Community site redesign — everything is in the Drive folder".
  // The subject's FIRST CLAUSE is the name when it is short (Porter's emails use the same title, so a
  // "ventures site update" subject stays "Ventures site update"); otherwise the ask, when it names
  // the job the way a request does ("we need to get started on …"); then the card's own title.
  const subjectShort = input.subject ? subjectName(input.subject, host) : "";
  const fromSubject = subjectShort && subjectShort.split(/\s+/).length <= 8 ? subjectShort : "";
  const fromAsk = askName(input.ask, host);
  const short = fromSubject || fromAsk || (subjectShort ? atWord(subjectShort, 56) : "") || shortAsk(input.ask, host) || shortAsk(input.title, host) || "Website change";
  const name = capital(short);
  if (!host || name.toLowerCase().includes(host.toLowerCase())) return name;
  return `${name} · ${host}`;
}

/**
 * HOW MANY TRIES EACH STAGE TOOK, from the row's run history (23 Sep 2026). A website job's tries
 * are its runs on the Mac, not the sweep's `work_attempts` counter — on wc_c9e36e8b the counter read
 * 1 while the plan had taken two runs (the first stalled). A live run not yet in the history counts
 * as a try of its phase. Pure.
 */
export function siteTries(runHistoryJson: string | null | undefined, live: { phase: string | null | undefined; status: string | null | undefined } | null = null): Array<{ phase: string; tries: number }> {
  let hist: Array<{ phase?: unknown; run_id?: unknown }> = [];
  try {
    const v = JSON.parse(runHistoryJson ?? "[]") as unknown;
    hist = Array.isArray(v) ? (v as Array<{ phase?: unknown; run_id?: unknown }>) : [];
  } catch {
    hist = [];
  }
  const order: string[] = [];
  const count = new Map<string, number>();
  const add = (phase: string) => {
    if (!count.has(phase)) order.push(phase);
    count.set(phase, (count.get(phase) ?? 0) + 1);
  };
  for (const h of hist) if (typeof h.phase === "string" && h.phase) add(h.phase.toUpperCase());
  if (live && live.phase && (live.status === "QUEUED" || live.status === "CLAIMED")) add(String(live.phase).toUpperCase());
  return order.map((phase) => ({ phase, tries: count.get(phase)! }));
}
