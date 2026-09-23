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

function cleanSubject(subject: string): string {
  let s = subject.trim();
  // "From seq@…: Community site redesign" — the intake card's own title shape.
  s = s.replace(/^From\s+\S+:\s*/i, "");
  for (;;) {
    const next = s.replace(/^(?:re|fwd?|fw)\s*:\s*/i, "");
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
  let t = (text ?? "").replace(/\r/g, "").trim();
  if (!t) return "";
  // The door's own brief wraps her words in `Change host: "…"` — unwrap it.
  const quoted = /^Change\s+[^:]+:\s*"([\s\S]*?)(?:"|$)/.exec(t);
  if (quoted) t = quoted[1]!;
  t = t.replace(GREETING, "");
  const firstLine = t.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 0 && !/^[A-Z][a-z]+,?$/.test(l)) ?? "";
  const stop = firstLine.search(/[.!?](\s|$)/);
  let s = stop >= 0 ? firstLine.slice(0, stop) : firstLine;
  for (const lead of LEADS) s = s.replace(lead, "");
  s = s.replace(/^the\s+/i, "");
  s = stripHost(s, host);
  return capital(atWord(s, max));
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

export function plainTitle(input: PlainTitleInput): string {
  if (input.kind !== "WEB_PROPERTY_CHANGE") return input.title;
  const host = input.host && input.host !== "unresolved" ? input.host : null;
  const fromSubject = input.subject ? atWord(stripHost(cleanSubject(input.subject), host), 56) : "";
  const short = fromSubject || shortAsk(input.ask, host) || shortAsk(input.title, host) || "Website change";
  const name = capital(short);
  if (!host || name.toLowerCase().includes(host.toLowerCase())) return name;
  return `${name} · ${host}`;
}
