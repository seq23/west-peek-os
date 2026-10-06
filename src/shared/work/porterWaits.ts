/**
 * EVERY WAIT PORTER MAY PUT IN FRONT OF A PARTNER, IN ONE PLACE (0253; owner, 6 Oct 2026: "we need
 * to reduce fails and blocks as much as possible and if there is a block it needs to come with a
 * plain english explanation of the block and what the partner can do the unbloock it. and it should
 * be able to be handled all over email").
 *
 * A wait has THREE PARTS and this file is the only way to write one, so none can be left out:
 *
 *   waiting  — what Porter is waiting on, in plain words;
 *   why      — why, in one sentence with no machinery in it;
 *   clear    — the exact REPLY or EMAIL that clears it. Never a link into the OS, never "on the
 *              card", never "ask Sequoia": everything is handled over email.
 *
 * THE LIST IS THE ALLOW-LIST. `validate:open-repo-door` reads every `blockCard(` in the Porter
 * runner and every partner-facing stop in the duty script and prompt, and fails the build on one
 * whose text is not composed from a kind here — "not a registered property", "no RUNBOOK", "ask
 * without a recommended default" and their siblings cannot come back. Two of these are the owner's
 * standing waits (the preview before landing, 27 Sep; a key the vault does not hold, 6 Oct); the
 * rest are a partner's own stop, a genuine ambiguity only they can settle, or an infrastructure
 * wait that clears itself and says so. `tests/porterWaits.test.ts` asserts the three parts on every
 * kind.
 */

export type PorterWaitKind =
  | "PREVIEW_APPROVAL"
  | "PLAN_APPROVAL"
  | "LAND_WORD"
  | "WHICH_SITE"
  | "HELD_BY_YOU"
  | "QUESTION_NOT_A_JOB"
  | "MISSING_SECRET"
  | "MAC_ASLEEP"
  | "SEAT_RESET"
  | "TRIED_AND_STOPPED"
  | "DNS_RECORD";

export interface PorterWait {
  waiting: string;
  why: string;
  clear: string;
  /** True when nothing is asked of the partner: it clears itself, and the email says so. */
  selfClearing?: boolean;
}

export interface PorterWaitFill {
  /** The preview URL, the key's name, the partner's own words, what was tried — whatever the kind names. */
  what?: string | null;
  why?: string | null;
  /** The site list for WHICH_SITE. */
  hosts?: string | null;
  /** Where the vault looked, for MISSING_SECRET. */
  searched?: string | null;
  /** When an infrastructure wait clears, for SEAT_RESET. */
  at?: string | null;
  /** DNS_RECORD: the exact record Cloudflare asked for, read from its API — type, name, target, and any TXT. */
  record?: { host: string; type: string; name: string; target: string; txtName?: string | null; txtValue?: string | null; liveAt: string } | null;
}

export const INTAKE_ADDRESS = "os@joinwestpeek.com";

const q = (s: string) => `"${s}"`;

/** The template per kind. A function, so the specifics ride in; the SHAPE is fixed here. */
export const PORTER_WAITS: Record<PorterWaitKind, (f: PorterWaitFill) => PorterWait> = {
  PREVIEW_APPROVAL: (f) => ({
    waiting: `your word on the preview${f.what ? ` at ${f.what}` : ""}`,
    why: "every site change previews before it goes live — your rule, 23 Sep 2026 — so nothing lands until you have seen it",
    clear: `reply ${q("approved")} to publish it, ${q("changes: <what to change>")} to adjust it and get a new preview, or ${q("stop")} to hold it`,
  }),
  PLAN_APPROVAL: (f) => ({
    waiting: "your word on the plan",
    why: f.why?.trim() || "this kind is set to wait for a plan approval (the standing rule is that plans never wait; a partner turned it on)",
    clear: `reply ${q("approved")} to take every recommendation, or ${q("changes: <what to change>")}; one word is enough`,
  }),
  LAND_WORD: (f) => ({
    waiting: `your word to land ${f.what ?? "the PR"}`,
    why: "land-on-green is switched off for this kind, so a green PR waits for you instead of merging by itself",
    clear: `reply ${q("land it")} to merge and deploy, or ${q("changes: <what to change>")}`,
  }),
  WHICH_SITE: (f) => ({
    waiting: "the name of the site or repo this is for",
    why: "the email named no site I know and there was no recent job of yours to infer it from",
    clear: `reply with the site (${f.hosts ?? "one of the registered hosts"}) or the GitHub repo as owner/name — a new repo is registered on the spot and the job starts`,
  }),
  HELD_BY_YOU: (f) => ({
    waiting: "your word to carry on",
    why: `you said ${q((f.what ?? "stop").slice(0, 200))}, so nothing is built or landed until you say otherwise`,
    clear: `reply ${q("approved")} to carry on, ${q("changes: <what to change>")} to re-plan, or ${q("drop it")} to close it`,
  }),
  QUESTION_NOT_A_JOB: (f) => ({
    waiting: "what you would like done",
    why: `this reads like a question rather than something to build${f.why ? ` (${f.why.slice(0, 200)})` : ""}, and nobody had a confident answer`,
    clear: "reply with what you would like built, or with the answer, and it starts from there",
  }),
  MISSING_SECRET: (f) => ({
    waiting: `the key ${f.what ?? "named above"}`,
    why: `the vault has no entry for it${f.searched ? ` (looked for: ${f.searched})` : ""}; everything that does not need it is going ahead meanwhile`,
    clear: `email ${q(`SECRET ${f.what ?? "<NAME>"}=<value>`)} to ${INTAKE_ADDRESS} on its own line — it is stored encrypted, moved into the vault, never shown again, and the feature that needs it ships on arrival`,
  }),
  MAC_ASLEEP: (f) => ({
    waiting: "the Mac",
    why: `no machine picked the job up before its queue ceiling — the Mac is asleep, its lid is closed, or it is off power${f.why ? `; this job is ${f.why}` : ""}`,
    clear: `nothing — it resumes by itself when the Mac is open and on power; if it stays stuck, reply ${q("try again")}`,
    selfClearing: true,
  }),
  SEAT_RESET: (f) => ({
    waiting: "the subscription plan to reset",
    why: "both Claude Code and Codex reported their plan is out of usage for now",
    clear: `nothing — it resumes by itself${f.at ? ` at ${f.at}` : " when the plan resets"}; no attempt is charged and nothing is lost`,
    selfClearing: true,
  }),
  DNS_RECORD: (f) => {
    const r = f.record;
    const txt = r?.txtName && r?.txtValue ? `, and TXT ${r.txtName} → ${r.txtValue}` : "";
    return {
      waiting: `a DNS record at your registrar for ${r?.host ?? "the host"}`,
      why: `${r ? r.host.split(".").slice(-2).join(".") : "the domain"} is not a Cloudflare zone in the firm's account, so Cloudflare cannot add the record itself; until it exists the site is live at ${r?.liveAt ?? "its pages.dev address"}`,
      clear: `nothing to email — at your DNS provider add ${r?.type ?? "CNAME"} ${r?.name ?? "<name>"} → ${r?.target ?? "<target>"}${txt}; I check every 15 minutes for 7 days and email you the moment it is live, or reply ${q("check now")} to make me look sooner`,
      selfClearing: true,
    };
  },
  TRIED_AND_STOPPED: (f) => ({
    waiting: "a word from you",
    why: `I tried this ${f.what ?? "three times"} and could not finish: ${(f.why ?? "the run stopped on our side").slice(0, 300)}`,
    clear: `reply ${q("try again")} to run it once more, ${q("changes: <what to change>")} to change the ask, or ${q("drop it")} to close it`,
  }),
};

export const PORTER_WAIT_KINDS = Object.keys(PORTER_WAITS) as PorterWaitKind[];

/** The three parts, filled. */
export function porterWait(kind: PorterWaitKind, fill: PorterWaitFill = {}): PorterWait {
  return PORTER_WAITS[kind](fill);
}

/**
 * THE ONE PARAGRAPH a block, a notice and an email all carry for a wait. "Waiting on … Why … To
 * clear it by email: …" — three labelled parts, always in this order, never one missing.
 */
export function waitDetail(kind: PorterWaitKind, fill: PorterWaitFill = {}): string {
  const w = porterWait(kind, fill);
  return `Waiting on: ${w.waiting}. Why: ${w.why}. To clear it by email: ${w.clear}.`;
}

/** The three parts as three bullets, for a labelled section in an email. */
export function waitBullets(kind: PorterWaitKind, fill: PorterWaitFill = {}): string[] {
  const w = porterWait(kind, fill);
  return [`Waiting on: ${w.waiting}`, `Why: ${w.why}`, `To clear it by email: ${w.clear}`];
}

/** The standing line for every email about a card that still lacks a key: the name, where to get one, how to send it. */
export function missingSecretLine(name: string, vendorUrl?: string | null, searched?: string | null): string {
  const w = porterWait("MISSING_SECRET", { what: name, searched: searched ?? null });
  return `Still missing: ${name}${vendorUrl ? ` — create one at ${vendorUrl}` : ""}, then ${w.clear}.`;
}

/**
 * What a wait text must NOT contain — the words that send a partner somewhere other than their
 * inbox. Read by the test and by the validator against every rendered kind.
 */
export const WAIT_TEXT_FORBIDDEN: readonly RegExp[] = [/\bon the card\b/i, /\bopen (the|your) card\b/i, /\bask sequoia\b/i, /\bask scooter\b/i, /https?:\/\/[^\s]*joinwestpeek\.com\/(work|home)/i, /\bon Home\b/];
