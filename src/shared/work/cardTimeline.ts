/**
 * "WHAT HAS HAPPENED" ON A CARD, AS SENTENCES (23 Sep 2026, the work-card redesign).
 *
 * The facts already exist — what arrived (`inbound_message`), what was sent back
 * (`work_card_notice`), the run her Mac holds, the last failure, the block — and the card page
 * printed them as `told seq@…: RECEIVED` beside raw notice kinds. This turns the same facts into a
 * dated list she can read top to bottom. Pure, so the desk's expanded card and the card's own page
 * say the same thing.
 */

import { plainFailure } from "./liveStatus";
import { readLaneFailure } from "../ai/laneFailure";
import { partnerByEmail } from "../registry/partners";

export interface TrailFact {
  at: string;
  /**
   * RECEIVED_EMAIL for an inbound message; a notice kind (RECEIVED, PLAN, PREVIEW, QUESTION, STUCK,
   * DONE); a change of hands (HAND_OFF, TAKE_BACK, CLAIM — 0241) or the one email it sent
   * (HAND_OFF_EMAIL).
   */
  kind: string;
  /**
   * "someone@…" for an inbound message or a change of hands (the partner who acted); "told someone@…"
   * / "tried to tell someone@…" for a notice or the hand-off email.
   */
  who: string;
  /** A change of hands: the new primary's address. The hand-off email: what it carried. */
  what: string;
  /** A change of hands: the door (REPLY, NOTE, API, NOTIFICATION). */
  via?: string;
  /** The hand-off email: who was copied, or null. */
  cc?: string | null;
}

const HAND_KINDS = new Set(["HAND_OFF", "TAKE_BACK", "CLAIM"]);
const VIA_WORDS: Record<string, string> = { REPLY: "by reply", NOTE: "from a note on the card", API: "from the card", NOTIFICATION: "from the notification" };

/** "You" for her own address, the partner's first name for the other, the address for anyone else. */
function personWord(email: string, mine: ReadonlySet<string>, subject: boolean): string {
  if (mine.has(email.toLowerCase())) return subject ? "You" : "you";
  return partnerByEmail(email)?.firstName ?? email;
}

export interface TimelineInput {
  created_at: string;
  owner_name: string | null;
  /** Who asked, already worded for her ("You, by email", "Scooter Taylor"). */
  asked_by: string;
  trail: readonly TrailFact[];
  run?: { status: string; created_at?: string | null; claimed_at?: string | null; progress_note?: string | null } | null;
  work_attempts?: number | null;
  last_failure?: string | null;
  last_failure_at?: string | null;
  blocked_at?: string | null;
  block_stopped?: string | null;
  /** Lowercased addresses that are "you" — so an email she sent reads "You emailed". */
  my_emails?: readonly string[];
  /**
   * 0241: the partner a block waits on (`work_card.block_who`, a first name in capitals), when it is
   * not her — after a hand-off the card stops and asks the NEW primary, and the line says so.
   */
  block_who_name?: string | null;
  /** The card's own step record (`/api/work-cards/:id/steps`). */
  steps?: TimelineSteps | null;
}
/**
 * WHAT THE CARD DID, TRY BY TRY (1 Oct 2026) — the sweep's own record of each tick, every model call attributed to the card,
 * and the card being re-queued or waiting for a plan. From `GET /api/work-cards/:id/steps`; absent on a card whose page has not
 * loaded them yet, in which case the timeline reads exactly as it did.
 */
export interface TimelineSteps {
  ticks: ReadonlyArray<{ at: string; outcome: string; attempt: number | null; detail: string | null }>;
  runs: ReadonlyArray<{ at: string; purpose: string; model: string | null; provider: string | null; provider_name: string | null; status: string; failure: string | null; degraded: boolean }>;
  events: ReadonlyArray<{ at: string; kind: string; detail: string | null }>;
}

export interface TimelineEntry {
  at: string;
  text: string;
  /** The entry describing what is happening right now — drawn a little stronger. */
  now?: boolean;
}

const NOTICE_WORDS: Record<string, string> = {
  RECEIVED: 'replied "got it" and started',
  PLAN: "sent the plan and any questions",
  PREVIEW: "sent the preview link",
  QUESTION: "asked a question",
  STUCK: "said the work is stuck",
  DONE: "sent the finished email",
};

/** A notice `cause` is sometimes a sentence and sometimes an internal key ("unclaimed:ccr_…"). */
function readableCause(cause: string): string | null {
  const c = cause.trim();
  if (!c || c.length < 12 || !/\s/.test(c) || /^[a-z_]+:[\w-]+/i.test(c)) return null;
  return c.length > 140 ? `${c.slice(0, 140).replace(/\s+\S*$/, "")}…` : c;
}

/** One message on the trail, as a sentence: "You emailed Porter: …", "Porter sent the preview link." */
export function trailSentence(t: TrailFact, ownerName: string | null, myEmails: readonly string[] = []): string {
  const mine = new Set(myEmails.map((e) => e.toLowerCase()));
  if (t.kind === "RECEIVED_EMAIL") {
    const from = mine.has(t.who.toLowerCase()) ? "You" : t.who;
    return `${from} emailed ${ownerName ?? "the firm"}${t.what.startsWith("emailed: ") ? `: ${t.what.slice(9)}` : ""}.`;
  }
  if (HAND_KINDS.has(t.kind)) {
    const by = personWord(t.who, mine, true);
    const via = t.via && VIA_WORDS[t.via] ? ` (${VIA_WORDS[t.via]})` : "";
    if (t.kind === "TAKE_BACK") return `${by} took this back${via}.`;
    if (t.kind === "CLAIM") return `${by} took responsibility for this${via}.`;
    return `${by} handed this to ${personWord(t.what, mine, false)}${via}.`;
  }
  const failed = t.who.startsWith("tried to tell");
  const to = t.who.replace(/^(tried to tell|told)\s+/, "");
  if (t.kind === "HAND_OFF_EMAIL") {
    const cc = t.cc ? `, ${personWord(t.cc, mine, false)} in Cc` : "";
    return `${ownerName ?? "They"} emailed ${personWord(to, mine, false)} where it stands${cc}.${failed ? " The email did not send." : ""}`;
  }
  const words = NOTICE_WORDS[t.kind] ?? "sent an update";
  const cause = t.kind === "STUCK" || t.kind === "QUESTION" ? readableCause(t.what) : null;
  const toOther = to && !mine.has(to.toLowerCase()) ? ` (to ${to})` : "";
  return `${ownerName ?? "They"} ${words}${cause ? `: ${cause}` : ""}${toOther}.${failed ? " The email did not send." : ""}`;
}


/** The lane that answered, in the words a partner uses: her own plan by name, otherwise the provider or model. */
export function laneWords(model: string | null, provider: string | null, providerName: string | null): string {
  const m = (model ?? "").toLowerCase();
  if (m === "codex-local" || provider === "codex") return "Codex on your plan";
  if (m === "claude-code-local" || provider === "claude_code") return "Claude Code on your plan";
  return providerName || model || "a model";
}

/** Why a call or a try ended, in a sentence — the lane's own kind of refusal named, never a code. */
export function whyItEnded(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "it did not say why";
  const f = readLaneFailure(text);
  if (f.kind === "LEVER") return "the spend setting is on Free only and nothing at $0 could take it";
  if (f.kind === "CREDIT") return "the account behind the model is out of credit";
  if (f.kind === "CREDENTIAL") return "the firm is not signed in to that model";
  if (f.kind === "RATE_LIMIT") return "it was turned away for sending too much at once";
  if (f.kind === "NO_LANE") return "no model was available";
  if (/subscription_seat_unavailable|seat.*(asleep|out of usage|usage)/i.test(text)) return "the Claude or Codex seat on your plan was asleep or out of usage";
  if (/timed out|timeout|aborted|did not finish within/i.test(text)) return "the model did not answer in time";
  const sentence = text.length > 160 ? `${text.slice(0, 160).replace(/\s+\S*$/, "")}…` : text;
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

function stepEntries(steps: TimelineSteps): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const t of steps.ticks) {
    if (t.outcome === "PROGRESSED") {
      const said = (t.detail ?? "").replace(/\s+/g, " ").trim();
      out.push({ at: t.at, text: `Finished a step${said ? `: ${said.length > 180 ? `${said.slice(0, 180).replace(/\s+\S*$/, "")}…` : said}` : ""}${/[.!?…]$/.test(said) ? "" : "."}` });
    } else if (t.outcome === "FAILED") {
      out.push({ at: t.at, text: `Try ${t.attempt ?? 1} did not finish — ${whyItEnded(t.detail)}. It tries again on its own.` });
    }
  }
  for (const r of steps.runs) {
    const lane = laneWords(r.model, r.provider, r.provider_name);
    const what = r.purpose.replace(/\s+/g, " ").trim();
    if (r.status === "COMPLETED") out.push({ at: r.at, text: `${lane} answered: ${what}.${r.degraded ? " A free model that may be weaker than your seats wrote it." : ""}` });
    else out.push({ at: r.at, text: `${what} was not answered — ${whyItEnded(r.failure ?? r.status)}.` });
  }
  for (const e of steps.events) {
    if (e.kind === "auto_released") out.push({ at: e.at, text: "Put back in the queue automatically, because what stopped it changed." });
    else if (e.kind === "waiting_for_reset") out.push({ at: e.at, text: "Both AI plans were out of usage, so it is waiting for one to reset and starts again by itself." });
  }
  return out;
}

export function cardTimeline(input: TimelineInput): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const emailed = input.trail.some((t) => t.kind === "RECEIVED_EMAIL");
  if (!emailed) {
    out.push({ at: input.created_at, text: `${input.asked_by === "You" ? "You asked" : `${input.asked_by} asked`}${input.owner_name ? ` ${input.owner_name}` : ""}.` });
  }
  for (const t of input.trail) out.push({ at: t.at, text: trailSentence(t, input.owner_name, input.my_emails) });
  // With the card's own step record, every try is listed with its reason, so the single "last failure" line would repeat the newest.
  if (input.steps) out.push(...stepEntries(input.steps));
  if (!input.steps && input.last_failure && input.last_failure_at) {
    const said = plainFailure(input.last_failure);
    const text = /retried automatically\.$/.test(said) ? said : `A try failed: ${said.length > 160 ? `${said.slice(0, 160).replace(/\s+\S*$/, "")}…` : said} Retried automatically.`;
    out.push({ at: input.last_failure_at, text });
  }
  if (input.blocked_at) {
    const asked = input.block_who_name ? `Stopped and asked ${input.block_who_name}` : "Stopped and asked you";
    out.push({ at: input.blocked_at, text: `${asked}${input.block_stopped ? `: ${input.block_stopped}` : "."}`, now: true });
  }
  const run = input.run;
  if (run && run.status === "CLAIMED" && run.claimed_at) {
    const n = Math.max(1, input.work_attempts ?? 1);
    out.push({ at: run.claimed_at, text: `${n > 1 ? `Try ${n}` : "The work"} started on your Mac${run.progress_note ? `: ${run.progress_note}` : ""}.`, now: true });
  } else if (run && run.status === "QUEUED" && run.created_at) {
    out.push({ at: run.created_at, text: "Queued for your Mac.", now: true });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** "11:55" today, "22 Sep 11:55" otherwise — how a timeline is read. */
export function timelineWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}
