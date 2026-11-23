import type { Env } from "../env";
import type { Actor } from "./authorize";
import { appendEvent } from "../events";
import { z } from "zod/v4";
import { runAi } from "../ai/runAi";
import { failedOnShape, readStructured, structuredOutput, type StructuredOutput } from "../ai/structuredOutput";
import { maskPrivateInputs } from "../ai/scrub";
import { committedLpNamedIn, committedLps } from "../ai/committedLps";
import { NO_MODEL_READER, central } from "../../shared/intake/inboundRead";
import { partnerByEmail } from "../../shared/registry/partners";
import { partnersOwnWords } from "../../shared/intake/replyBody";
import { centralDay } from "../../shared/work/partnerBackBy";
import { readMail } from "../effects/mail";
import { alreadyTold, recordNotice, threadRootFor } from "./requestReply";
import { sendOrPreview } from "./previewApproval";
import { FILES_NOT_OPENED } from "./voiceNotes";
import { TAKEN_OVER_PREFIX, isTakenOver } from "../../shared/work/takeover";
import { notifyQuietly } from "./notifications";
import { PREVIEW_PARTNER } from "../../shared/registry/partners";
import { SECTION_MAX_LINES } from "../../shared/email/execEmail";

/**
 * EMAILING THE OS FEELS LIKE TYPING TO CLAUDE — steps 1 and 7 (her ruling, 14 Nov 2026, west-peek-ventures brain).
 *
 * STEP 1 · "GOT IT", WITHIN FIVE MINUTES. Every partner email that opened or steered a card gets one reply on his
 * thread listing each thing he asked for, in his own words, and what happens next. The sweep runs every minute and
 * calls `sendUnderstoodReplies` before it works a card, so the wait is one tick plus one model call. The model call
 * is confidential (her Claude seat, then Codex; never a free lane, never paid). When no seat answers, the reply still
 * goes: his own sentences quoted, no model involved. The asks are stored in `partner_ask` (0306).
 *
 * STEP 7 · ONE COMPLETE FINAL REPLY. `asksAtDone` marks every stored ask DONE / IN_PROGRESS / NOT_DONE with a reason
 * (from the runner's own `{"asks":[…]}` report when it gave one, else one confidential read of what it finished
 * with). If any ask is still unmarked, the DONE is not sent and the card is put back to work with the missing asks
 * named. That is the tail's dropped-ask check, moved before the send.
 *
 * Only a partner address is ever written to: the authenticated sender recorded on the stored message, checked
 * against the registry again here, and `sendOrPreview` is the one lane.
 */

/** A message older than this when the sweep first sees it is history (a deploy, a re-read), never a fresh "Got it". */
export const UNDERSTOOD_WINDOW_MINUTES = 30;
/** Messages answered per tick: each may wait on a seat, and the sweep still has a card to work. */
export const UNDERSTOOD_PER_TICK = 2;
const MAX_ASKS = 12;

export type AskStatus = "DONE" | "IN_PROGRESS" | "NOT_DONE";
export type SeatRead = (env: Env, input: { prompt: string; firmScope: string; employeeId: string | null; purpose: string; output?: StructuredOutput }) => Promise<ReadOut>;
/**
 * What one reader gave back. `reader` names who answered (CLAUDE, CODEX, WORKERS_AI, GEMINI). `out` says the reader
 * was not there to ask (usage spent, Mac asleep, no binding, the privacy router refused it): not a failed read, so
 * nobody waits on it.
 */
export interface ReadOut { ok: boolean; text: string; detail: string; runId?: string | null; reader?: string | null; out?: boolean }
export interface Reader { name: string; read: SeatRead }

/** Her Claude seat, then Codex as its backup; never a free lane, never a paid one. */
export const confidentialSeatRead: SeatRead = async (env, input) => {
  try {
    const actor: Actor = { type: "AI", ...(input.employeeId ? { aiEmployeeId: input.employeeId } : {}), roles: [], firmScopes: [input.firmScope] } as Actor;
    const { run } = await runAi(env, {
      purpose: input.purpose,
      actor,
      inputs: [input.prompt],
      ...(input.output ? { output: input.output } : {}),
      sensitivity: "INTERNAL" as never,
      budgetContext: { judgement: true, confidential: true, seatFirst: true, neverPaid: true, expectedOutputTokens: 500 },
      routing: { category: "OPERATIONS" },
    });
    if (run.status === "COMPLETED" && run.output_text) return { ok: true, text: run.output_text, detail: "ok", runId: run.id };
    // Answered, but in no lane in the asked shape: a read with nothing readable in it (as an unparseable reply always was), never a seat outage.
    if (failedOnShape(run.failure_reason)) return { ok: true, text: "", detail: run.failure_reason ?? "unreadable", runId: run.id };
    return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}`, runId: run.id };
  } catch (err) {
    return { ok: false, text: "", detail: err instanceof Error ? err.message : String(err) };
  }
};

/** A run that was refused before any model saw it, or answered by the offline stand-in: that reader was not there. */
const OUT_REASON = /seat_wait|subscription_seat_unavailable|no_active_priced_model|provider_disabled|kill_switched|binding_absent|has_no_lane|free_only_|not configured|usage|quota|allocation|exhaust|rate.?limit|\b429\b/i;
const OUT_STATUSES = new Set(["PREFLIGHT_BLOCKED", "BUDGET_BLOCKED", "EGRESS_BLOCKED", "KILL_SWITCHED", "PROVIDER_DISABLED"]);
const READER_OF: Record<string, string> = { claude_code: "CLAUDE", codex: "CODEX", workers_ai: "WORKERS_AI", google_free: "GEMINI" };

/** One first-read call through the one AI boundary, reported as a reader's answer. Never throws. */
async function readThrough(env: Env, input: Parameters<SeatRead>[1], ask: { sensitivity: string; budgetContext: Record<string, unknown> }): Promise<ReadOut> {
  try {
    const actor: Actor = { type: "AI", ...(input.employeeId ? { aiEmployeeId: input.employeeId } : {}), roles: [], firmScopes: [input.firmScope] } as Actor;
    const { run } = await runAi(env, {
      purpose: input.purpose,
      actor,
      inputs: [input.prompt],
      ...(input.output ? { output: input.output } : {}),
      sensitivity: ask.sensitivity as never,
      budgetContext: { judgement: true, neverPaid: true, expectedOutputTokens: 700, ...ask.budgetContext },
      routing: { category: "OPERATIONS" },
    });
    // The lane that answered, read back from the run row (a chain that moved on rewrote it there).
    const key = (await env.WP_OS_DB.prepare("SELECT p.provider_key FROM ai_run r JOIN provider_registry p ON p.id = r.provider_id WHERE r.id = ?1").bind(run.id).first<{ provider_key: string }>().catch(() => null))?.provider_key ?? null;
    // The offline stand-in (a firm in LOCAL or LOCKDOWN privacy) is no reader at all.
    if (run.model === "mock-local") return { ok: false, text: "", detail: "no model reader in this privacy mode", runId: run.id, out: true };
    if (run.status === "COMPLETED" && run.output_text) return { ok: true, text: run.output_text, detail: "ok", runId: run.id, reader: key ? (READER_OF[key] ?? key.toUpperCase()) : null };
    const why = run.failure_reason ?? `run ${run.status}`;
    if (failedOnShape(why)) return { ok: true, text: "", detail: why, runId: run.id, reader: key ? (READER_OF[key] ?? key.toUpperCase()) : null };
    return { ok: false, text: "", detail: why, runId: run.id, out: OUT_STATUSES.has(run.status) || OUT_REASON.test(why) };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, text: "", detail: why, out: OUT_REASON.test(why) };
  }
}

/**
 * THE FIRST READ'S READERS, IN HER ORDER (15 Nov 2026, west-peek-ventures brain, "Out of Claude usage never stops
 * partner mail"): her Claude seat then Codex (one private call: the router's PRIVATE row, never a free lane); then
 * Cloudflare's own Workers AI (never trains on it, so private mail is fine, and it runs with the Mac asleep); then free
 * Gemini on every email, with committed LPs' names and deal terms masked (owner ruling, 19 Nov 2026,
 * `maskedGeminiRead`); then no first read at all.
 */
export const FIRST_READERS: readonly Reader[] = [
  { name: "SEAT", read: (env, input) => readThrough(env, input, { sensitivity: "INTERNAL", budgetContext: { confidential: true } }) },
  { name: "WORKERS_AI", read: (env, input) => readThrough(env, input, { sensitivity: "INTERNAL", budgetContext: { confidential: true, ownBinding: true, providerKey: "workers_ai" } }) },
  { name: "GEMINI", read: (env, input) => maskedGeminiRead(env, input) },
];

/**
 * GEMINI READS EVERY PARTNER EMAIL, MASKED (owner ruling, 19 Nov 2026). Before the call, committed LPs' names and deal
 * terms are replaced by stand-ins (`maskPrivateInputs`: "[Investor A]", "[amount 1]", "[deal term 1]"); the answer is
 * mapped back before it is parsed, so the brief carries his own words. FAILS CLOSED: if the commitment records cannot
 * be read, or the masked text still names a committed LP, Gemini is skipped (an `out` reader), never sent unmasked.
 * The router's own check stays behind it: a marker the mask missed is still refused before any request is formed.
 */
async function maskedGeminiRead(env: Env, input: Parameters<SeatRead>[1]): Promise<ReadOut> {
  let masked: ReturnType<typeof maskPrivateInputs>;
  try {
    const committed = await committedLps(env, input.firmScope);
    if (!committed.readable) return { ok: false, text: "", detail: "masking could not run (the committed-LP records are unreadable); Gemini skipped", out: true };
    masked = maskPrivateInputs([input.prompt], committed.names);
    if (committedLpNamedIn(masked.inputs, committed.names)) return { ok: false, text: "", detail: "masking left a committed LP's name; Gemini skipped", out: true };
  } catch {
    return { ok: false, text: "", detail: "masking could not run; Gemini skipped", out: true };
  }
  const out = await readThrough(env, { ...input, prompt: masked.inputs[0]! }, { sensitivity: "PUBLIC", budgetContext: { publicModelApproved: true, providerKey: "google_free" } });
  if (!out.ok) return out;
  // A shaped answer is put back value by value, so a restored name can never break the JSON around it.
  if (input.output) {
    try {
      return { ...out, text: JSON.stringify(restoreStrings(JSON.parse(out.text), masked.restore)) };
    } catch {
      return { ...out, text: masked.restore(out.text) };
    }
  }
  return { ...out, text: masked.restore(out.text) };
}

function restoreStrings(value: unknown, restore: (s: string) => string): unknown {
  if (typeof value === "string") return restore(value);
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, restore));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, restore)]));
  return value;
}

/** How long the employee waits for the first read before it starts from the OS's own read (her ruling: ten minutes). */
export const FIRST_READ_WAIT_MINUTES = 10;
/** The mark on a claimed row whose readers were there and failed: the next tick reads it again. */
const WAITING_FOR_READER = "WAITING_FOR_READER";

/** His holds, from his own sentences (the OS's read when no reader answered): "preview first", "nothing live", … Pure. */
const HOLD = /\b(?:preview (?:it )?first|nothing (?:goes )?live|not live|don'?t (?:go live|publish|push|ship|deploy|merge|send)|do not (?:go live|publish|push|ship|deploy|merge|send)|hold off|wait for (?:my|me)|no (?:client|customer) names?|without (?:my |a |his |her )?(?:written )?(?:ok|okay|approval|sign-?off|consent|permission)|until I (?:say|approve|ok)|before (?:it|anything) goes live)\b/i;
/**
 * HOLDS ARE CONSTRAINTS; QUESTIONS ARE QUESTIONS (15 Nov 2026). The word lists' read, used only when no model answered
 * (22 Nov 2026): a line that asks, wonders or leaves something open ("is still open", "let's clarify", a "?") is a
 * question, never a hold. Pure.
 */
const QUESTION_SHAPED = /\?\s*["”]?$|\b(?:still open|(?:is|are) open|questioning|wonder(?:ing)?|not sure|unsure|let'?s (?:clarify|confirm|discuss|talk)|clarify|whether)\b/i;
/** A "?" inside a quotation is the quoted thing's ("Keep "How did you hear about us?""), not his question. */
const unquoted = (line: string): string => line.replace(/"[^"]*"|“[^”]*”/g, "\"\"").trim();
const isQuestionShaped = (line: string): boolean => QUESTION_SHAPED.test(unquoted(line));
/**
 * NOTHING HE SAID IS DROPPED (Sequoia, 15 Nov 2026). Holds, questions and unclear items are kept whole; this bound is
 * only a safety net against a runaway reader, and the brief says "and N more" when it is ever reached.
 */
export const BRIEF_LIST_BOUND = 40;

/** His open questions, from his own sentences (the OS's read): what he asked to clarify or left open. Pure. */
export function questionsOf(words: string): string[] {
  // HIS TYPED EMAIL ONLY (15 Nov 2026): a voice note is him thinking out loud ("You know?"), and the email is the final
  // word; the reader still hears the recording and may add a real question from it.
  const typed = words.split(/\n\nVoice note \(/)[0] ?? words;
  return unwrapped(typed)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.replace(/^[\s\-–—•*]+|\s+$/g, "").replace(/^\d+[.)]\s+/, "").replace(/\s+/g, " "))
    .filter((s) => s.length > 8 && (isQuestionShaped(s) || CLARIFY_FIRST.test(unquoted(s))) && !REMARK.test(s));
}
export function holdsOf(words: string): string[] {
  return unwrapped(words)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.replace(/^[\s\-–—•*]+|\s+$/g, "").replace(/^\d+[.)]\s+/, "").replace(/\s+/g, " "))
    .filter((s) => HOLD.test(s) && !isQuestionShaped(s));
}

const norm = (s: string): string => s.toLowerCase().replace(/[“”"'‘’`]/g, "").replace(/\s+/g, " ").trim().replace(/^[\s\-–—•*:.,;!?]+|[\s\-–—•*:.,;!?]+$/g, "");

/*
 * ONE HOLD, ONE LINE (15 Nov 2026). His brain's standing holds are added to the email's own, but a standing hold the
 * email already says in its own words ("Nothing goes live until I see the preview" against the brain's "nothing goes
 * live until he reviews the preview") was listed twice. Two holds are the same when they share the same key words: at
 * least three content words in common, covering at least half of the shorter one's. The email's wording is kept.
 */
const HOLD_FILLER = new Set(["the", "and", "for", "with", "without", "until", "unless", "before", "after", "his", "her", "him", "she", "you", "your", "our", "any", "anything", "this", "that", "these", "those", "from", "into", "onto", "each", "every", "all", "are", "was", "were", "been", "being", "has", "have", "had", "will", "would", "should", "can", "could", "may", "must", "not", "don", "dont", "never", "yet", "just", "please", "also", "there", "here", "what", "who", "when", "where", "which", "about", "over", "under", "per"]);
const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? "" : m));
export function holdKeyWords(s: string): Set<string> {
  return new Set(norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !HOLD_FILLER.has(w)).map(stem));
}
export function sameHold(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const ka = holdKeyWords(a), kb = holdKeyWords(b);
  const shared = [...ka].filter((w) => kb.has(w)).length;
  return shared >= 3 && shared * 2 >= Math.min(ka.size, kb.size);
}
/** The email's holds in its own words, then each standing hold the email does not already say. */
/*
 * ONE "NOTHING GOES LIVE" (15 Nov 2026). The brain says it twice in different words ("Do not publish or go live with
 * anything - I approve each step" and "nothing goes live until he reviews the preview"), sharing one key word, and the
 * email often says it a third way. A standing hold that is a general go-live hold is dropped when a hold already kept
 * (the email's first, then the brain's in order) is one too. Only standing holds are ever dropped; his email's stay.
 */
const GO_LIVE = /\b(?:nothing (?:goes|is going|will go|can go) live|(?:do not|don'?t|never) (?:publish|go live|push live)|not live|before (?:it|anything) goes live)\b/i;
const sameConcept = (a: string, b: string): boolean => GO_LIVE.test(a) && GO_LIVE.test(b);
export function mergeHolds(emailHolds: readonly string[], standing: readonly string[]): string[] {
  const kept = [...emailHolds];
  for (const h of standing) if (!kept.some((k) => sameHold(k, h) || sameConcept(k, h))) kept.push(h);
  return kept;
}
/** His words, quoted once: plain quotes outside, any quotes inside his words turned to single ones (never ""x""). */
export function quoteHis(s: string): string {
  const inner = s.trim().replace(/^["“]([^"“”]*)["”]$/, "$1").replace(/"([^"]*)"/g, "‘$1’").replace(/“([^”]*)”/g, "‘$1’");
  return `"${inner}"`;
}
/*
 * IN HIS VOICE, OR NOT AT ALL (15 Nov 2026). A hold shown back to him in a Got it is his own words, quoted, or the
 * brain's note about him turned to "you" ("money figures are for him only" → "Money figures are for you only"), with
 * the brain's bookkeeping ("(13 Nov)", "(every build since 9 Oct)") cut. A note that cannot be turned cleanly (a "her"
 * that may be "you" or "your") is left out of his email; the employee still has it on the brief.
 */
const BRAIN_DATE = /\s*\([^()]*\b(?:\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|since)\b[^()]*\)/gi;
const THIRD = /\b(?:he|him|his|she|her|hers)\b/i;
/** "he reviews" → "you review", "he goes" → "you go", "he approves" → "you approve". */
const IRREGULAR: Record<string, string> = { is: "are", has: "have", was: "were", does: "do", goes: "go" };
const youVerb = (verb: string): string => IRREGULAR[verb.toLowerCase()] ?? (/(?:ss|sh|ch|x|z|o)es$/i.test(verb) ? verb.slice(0, -2) : /ies$/i.test(verb) ? `${verb.slice(0, -3)}y` : /[^s]s$/i.test(verb) ? verb.slice(0, -1) : verb);
export function holdForHim(h: string): string | null {
  const t = h.replace(BRAIN_DATE, "").trim();
  if (!THIRD.test(t)) return quoteHis(t);
  if (/\b(?:her|hers)\b/i.test(t)) return null;
  const you = t
    .replace(/\b(?:he|she)\s+(\w+)/gi, (_m, verb: string) => `you ${youVerb(verb)}`)
    .replace(/\bhim\b/gi, "you")
    .replace(/\bhis\b/gi, "your");
  // Brain notes may quote his words inside ("thinking out loud"): single quotes, so nothing reads as doubled.
  const tidy = you.replace(/"([^"]*)"/g, "‘$1’");
  return tidy.charAt(0).toUpperCase() + tidy.slice(1);
}

/** A line a mail client wrapped mid-sentence is joined back, so "Attached is" never stands alone. Pure. */
function unwrapped(words: string): string {
  return words
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").reduce((acc, line) => {
      if (!acc) return line;
      // A new line starts a new item when it is a list item, or when it follows a list item and starts a new sentence;
      // otherwise a mail client wrapped it and it continues the sentence.
      const prev = acc.slice(acc.lastIndexOf("\n") + 1);
      const newItem = /^\s*(?:\d+[.)]|[-*•])\s+/.test(line) || (/^\s*(?:\d+[.)]|[-*•])\s+/.test(prev) && /^\s*[A-Z"“(]/.test(line) && /[.!?:)"”]\s*$|^\s*[-*•]/.test(prev));
      return newItem ? `${acc}\n${line}` : `${acc} ${line.trim()}`;
    }, ""))
    .join("\n\n");
}

/** A remark on how something IS (praise, status, a greeting), not something he asked for. */
const REMARK = /^(?:hi|hey|hello|thanks|thank you|cheers|best|regards|changes)\b[^a-z]*\w*[,!.:]?$|\b(?:in (?:good|great) shape|looks? (?:good|great)|love (?:it|this|the)|nice work|great work|well done|thank you|thanks)\b/i;
/** Too short to be a thing he asked for on its own: a fragment of a sentence. */
const isFragment = (s: string): boolean => s.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length < 3 || /[:,;–—-]$/.test(s.trim());

/** His sentences, as written: the no-model "Got it" when the email has no list. Whole sentences, never fragments. */
export function sentencesOf(words: string): string[] {
  return unwrapped(words)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.replace(/^[\s\-–—•*]+|\s+$/g, "").replace(/\s+/g, " "))
    .filter((s) => /[a-z]{2}/i.test(s) && !isFragment(s) && !REMARK.test(s))
    .slice(0, MAX_ASKS);
}

/** The one item his clarify-first questions become: it says so, and carries his words. */
export const QUESTIONS_LEAD = "Your questions to settle before I build: ";
/** The same item when his questions are not about what to settle first ("What can you get done today?"). */
export const QUESTIONS_PLAIN = "Your questions: ";
const BEFORE_BUILDING = /^(?:before (?:building|you build|you start|starting|we build|going)|let'?s (?:clarify|confirm))/i;
/** A paragraph that asks to clarify or answer something before the work goes on. */
const CLARIFY_FIRST = /\?|^(?:before (?:building|you build|you start|starting|we build|going)|let'?s (?:clarify|confirm|talk)|can you (?:confirm|clarify|tell)|please (?:confirm|clarify)|what (?:can|is|are|do)|which\b|how (?:do|does|should|will))/i;

/**
 * HIS ASKS, FROM THE EMAIL'S OWN STRUCTURE (15 Nov 2026). When he numbered his changes, each numbered item is one ask
 * (its sub-bullets with it), his clarify-first paragraphs together are ONE item that says so, and everything else (a
 * greeting, "X is in good shape", a "Changes:" heading, an idea for later) is not an ask: it is listed as noted, never
 * dropped in silence. No model is involved, so the count cannot drift. Null when the email has no numbered list. Pure.
 */
export function structuredAsks(words: string): { asks: string[]; noted: string[] } | null {
  const paras = unwrapped(words).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const asks: string[] = [];
  const questions: string[] = [];
  const noted: string[] = [];
  for (const para of paras) {
    const lines = para.split("\n");
    if (/^\s*\d+[.)]\s+/.test(lines[0]!)) {
      let head = "";
      let bullets: string[] = [];
      let tail: string[] = [];
      const flush = () => {
        if (!head) return;
        let item = head.trim();
        if (bullets.length) item = `${item}${/:$/.test(item) ? " " : "; "}${bullets.join("; ")}`;
        if (tail.length) item = `${item}${/[.!?]$/.test(item) ? " " : ". "}${tail.join(" ")}`;
        asks.push(item.replace(/\s+/g, " ").trim());
        head = ""; bullets = []; tail = [];
      };
      for (const line of lines) {
        if (/^\s*\d+[.)]\s+/.test(line)) { flush(); head = line.replace(/^\s*\d+[.)]\s+/, ""); }
        else if (/^\s*[-*•]\s+/.test(line)) bullets.push(line.replace(/^\s*[-*•]\s+/, "").trim());
        else if (bullets.length) tail.push(line.trim());
        else head = `${head} ${line.trim()}`;
      }
      flush();
    } else {
      const flat = para.replace(/\s+/g, " ").trim();
      if (CLARIFY_FIRST.test(unquoted(flat))) questions.push(flat);
      else if (!REMARK.test(flat) && !isFragment(flat)) noted.push(flat);
    }
  }
  if (asks.length === 0) return null;
  const items = asks.slice(0, MAX_ASKS);
  if (questions.length) {
    const first = questions.join(" ");
    items.push(`${BEFORE_BUILDING.test(first) ? QUESTIONS_LEAD : QUESTIONS_PLAIN}${first}`);
  }
  return { asks: items, noted: noted.slice(0, 4) };
}

/**
 * WHAT HE ASKED, the one reader both the live "Got it" and the dry run use. A numbered email is read from its structure
 * (no model); anything else is read by her seat (`read`) and kept only in his words, else his whole sentences.
 */
export interface FirstReadDecision {
  kind: "approve" | "change" | "question" | "stop" | "nothing";
  property: string | null;
  handOffTo: string | null;
  planApproved: boolean | null;
  holds: string[];
  /*
   * WHAT HIS REPLY SAYS ABOUT THE CARD ITSELF (20 Nov 2026, additive: a decision read before these existed has none of
   * them, and each missing one falls back to the keywords on its own). `firstReadDecides.ts#decideReplyWords` acts on
   * them, with `handOffTo` above.
   */
  /** He takes the card back himself ("I'll take it back"). */
  takeBack?: boolean | null;
  /** The people he asks to copy on the finished email, as he named them ("Scooter", an address). */
  cc?: string[];
  /** The last day of the window he said he will come back by (YYYY-MM-DD, Central), or null. */
  backBy?: string | null;
  /*
   * ONE READ PER EMAIL (22 Nov 2026, review of #574): the deadline he sets and his answer to Porter's pending hand-off
   * question come from this read, never from a second model call. Additive like the three above.
   */
  /** The deadline he sets for the work, in his exact words, and that time as Central wall-clock (`YYYY-MM-DDTHH:MM`). */
  deadline?: { words: string; local: string } | null;
  /** His answer to Porter's pending "Did you mean hand this card to …?" (null when none was pending or he did not answer it). */
  handOffAnswer?: "yes" | "no" | "unsure" | null;
}

function parseDecision(value: unknown): FirstReadDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (!(typeof d.kind === "string" && ["approve", "change", "question", "stop", "nothing"].includes(d.kind)) ||
      !(d.property === null || typeof d.property === "string") ||
      !(d.handOffTo === null || typeof d.handOffTo === "string") ||
      !(d.planApproved === null || typeof d.planApproved === "boolean") ||
      !Array.isArray(d.holds) || !d.holds.every((h: unknown) => typeof h === "string") ||
      !(d.takeBack === undefined || d.takeBack === null || typeof d.takeBack === "boolean") ||
      !(d.cc === undefined || (Array.isArray(d.cc) && d.cc.every((c: unknown) => typeof c === "string"))) ||
      !(d.backBy === undefined || d.backBy === null || (typeof d.backBy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.backBy))) ||
      !(d.handOffAnswer === undefined || d.handOffAnswer === null || (typeof d.handOffAnswer === "string" && ["yes", "no", "unsure"].includes(d.handOffAnswer)))) return null;
  // A deadline that is not a deadline is dropped, never the whole decision.
  const dl = d.deadline as { words?: unknown; local?: unknown } | null | undefined;
  const deadline = dl && typeof dl.words === "string" && dl.words.trim() && typeof dl.local === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dl.local.trim()) ? { words: dl.words.trim(), local: dl.local.trim() } : dl === undefined ? undefined : null;
  return { ...(d as unknown as FirstReadDecision), ...(deadline === undefined ? {} : { deadline }) };
}

/** Old briefs, failed reads and malformed decisions have no decision. */
export async function firstReadDecision(env: Env, inboundMessageId: string): Promise<FirstReadDecision | null> {
  const row = await env.WP_OS_DB.prepare("SELECT brief_json FROM partner_understood WHERE inbound_message_id = ?1")
    .bind(inboundMessageId).first<{ brief_json: string | null }>();
  try {
    return row?.brief_json ? parseDecision((JSON.parse(row.brief_json) as { decision?: unknown }).decision) : null;
  } catch {
    return null;
  }
}

export interface Brief {
  decision: FirstReadDecision | null;
  /** Every separate ask, in his words. */
  asks: string[];
  /** What he said must not happen yet, in his words ("preview first", "no client names without written OK"). */
  holds: string[];
  /** What he asked to clarify or left open, in his words: answered or asked about, never assumed and never a hold. */
  questions: string[];
  /**
   * What the reader could not pin down (a missing fact, a voice note that disagrees with the email, two readings), each
   * with his exact words and what is missing. The employee asks every one, numbered, in one email, and builds the rest.
   */
  unclear: Array<{ words: string; missing: string }>;
  /** Every file on the card from this email, and what it is for (null when no reader could say). */
  files: Array<{ filename: string; purpose: string | null }>;
  /** Who read it: CLAUDE, CODEX, WORKERS_AI, GEMINI, or null for the OS's own read. */
  reader: string | null;
}

export async function understand(
  env: Env,
  input: { subject: string; written: string; read: SeatRead | readonly Reader[]; employeeId: string | null; firmScope: string; files?: readonly string[]; known?: string; standingHolds?: readonly string[]; today?: string; wrote?: Date },
): Promise<{ none: boolean; asks: string[]; noted: string[]; next: string; via: "STRUCTURE" | "MODEL" | "FALLBACK"; runId: string | null; runIds: string[]; brief: Brief; readerFailed: boolean; readersTried: string[] }> {
  const { written } = input;
  const fileNames = [...(input.files ?? [])];
  const ladder: readonly Reader[] = typeof input.read === "function" ? [{ name: "SEAT", read: input.read }] : input.read;
  const ON_IT = "I'm starting on it now. The next email from me is the result, or one question if something is unclear.";
  // A voice note's transcript (withVoiceNotes) is his words but not his list: the list is read from what he typed, and
  // each recording is named as heard and on the card, so a long transcript never swells the questions item.
  const blocks = written.split(/\n\s*\n(?=Voice note \()/);
  const typed = blocks[0]!.startsWith("Voice note (") ? "" : blocks[0]!;
  const heard = blocks.filter((b) => b.startsWith("Voice note (")).map((b) => {
    const m = /^Voice note \((.+?)\), his words transcribed:\s*([\s\S]*)$/.exec(b);
    return m ? `${m[1]}: heard and transcribed (${m[2]!.split(/\s+/).filter(Boolean).length} words)` : null;
  }).filter((x): x is string => Boolean(x));
  const structured = typed ? structuredAsks(typed) : null;
  /*
   * THE FIRST READ (15 Nov 2026). Every reader in her order is asked until one gives a usable read: his asks (a
   * numbered email keeps the asks its structure gives; the reader fills the gaps), his holds and what each file is for.
   * A reader that was not there (`out`) is passed over; one that was there and failed is remembered, so the caller
   * can wait for it instead of answering from the OS's own read.
   */
  const runIds: string[] = [];
  const readersTried: string[] = [];
  let readerFailed = false;
  let parsed: ReturnType<typeof parseUnderstood> | null = null;
  let reader: string | null = null;
  if (written) {
    for (const r of ladder) {
      const out = await r.read(env, { prompt: understoodPrompt(input.subject, written, fileNames, input.known ?? "", input.today, input.wrote), firmScope: input.firmScope, employeeId: input.employeeId, purpose: "the Got it reply to a partner's email: his asks in his words", output: UNDERSTOOD_OUTPUT });
      if (out.runId) runIds.push(out.runId);
      readersTried.push(`${r.name}: ${out.ok ? "read it" : out.out ? `out (${out.detail.slice(0, 120)})` : `failed (${out.detail.slice(0, 120)})`}`);
      if (!out.ok) {
        if (!out.out) readerFailed = true;
        // A firm in LOCAL or LOCKDOWN privacy has no model reader at all: asking the next one would only say so again.
        if (out.out && /no model reader in this privacy mode/.test(out.detail)) break;
        continue;
      }
      const p = parseUnderstood(out.text, written, fileNames);
      if (p.none || p.asks.length || structured) {
        parsed = p;
        reader = out.reader ?? r.name;
        break;
      }
      readerFailed = true;
    }
  }
  const runId = runIds[runIds.length - 1] ?? null;
  /*
   * HIS HOLDS AND QUESTIONS ARE THE READER'S (22 Nov 2026, engineering sweep row 5): a model that answered decides what
   * is a hold and what is a question, kept only where they are his words (`parseUnderstood`). His own sentences are read
   * by the word lists (HOLD, QUESTION_SHAPED, LATER) ONLY when no model answered, and the log says so. His brain's
   * standing holds are added either way: they are records, not a read.
   */
  if (!parsed && written) console.warn(`${NO_MODEL_READER}: no model read his email "${input.subject.slice(0, 80)}"; his holds and questions are the word lists' (${readersTried.join("; ").slice(0, 300)})`);
  // An idea for later ("… is an idea for later, not part of this round") is kept as noted, never also as a hold.
  const notedLines = structured?.noted ?? [];
  const LATER = /\b(?:ideas? for later|for later|not (?:part of )?this round|parking lot|someday)\b/i;
  const emailHolds = parsed ? parsed.holds : holdsOf(written).filter((h) => !(LATER.test(h) && notedLines.some((n) => norm(n) === norm(h))));
  const holds = mergeHolds(emailHolds, input.standingHolds ?? []);
  /*
   * A HOLD HE TYPED IS NEVER LOST (review of #574). A line of his that reads like a hold ("nothing goes live") which the
   * reader neither kept as a hold nor placed as a question or an ask is not dropped on the reader's word (a note is not
   * a hold; only an idea for later is): it
   * goes to his questions as "Did you mean this as a hold?", so it is asked, never silently absent.
   */
  const placed = (l: string) => [...emailHolds, ...(parsed?.questions ?? []), ...(parsed?.asks ?? [])].map(norm).filter(Boolean).some((x) => x === norm(l) || x.includes(norm(l)) || norm(l).includes(x));
  const askedHolds = parsed ? holdsOf(written).filter((h) => !LATER.test(h) && !placed(h)).map((h) => `Did you mean this as a hold? "${h}"`) : [];
  const questions = parsed ? [...parsed.questions, ...askedHolds] : questionsOf(written);
  const unclear = parsed ? parsed.unclear : [];
  const files = fileNames.map((filename) => ({ filename, purpose: parsed?.files.find((f) => f.filename === filename)?.purpose ?? null }));
  const brief = (asks: string[]): Brief => ({ asks, holds, questions, unclear, files, reader, decision: parsed?.decision ?? null });
  const common = { runId, runIds, readerFailed: parsed ? false : readerFailed, readersTried };
  // A line is shown to him once: one the reader kept as a hold is not listed again as noted.
  const notHold = (n: string) => !holds.some((h) => norm(h) === norm(n));
  if (structured) return { ...common, none: false, asks: structured.asks, noted: [...structured.noted.filter(notHold), ...heard], next: ON_IT, via: parsed ? "MODEL" : "STRUCTURE", brief: brief(structured.asks) };
  if (parsed?.none) return { ...common, none: true, asks: ["nothing asked"], noted: [], next: ON_IT, via: "MODEL", brief: brief([]) };
  if (parsed && parsed.asks.length) {
    const asks = parsed.asks.filter((a) => !isFragment(a));
    return { ...common, none: false, asks, noted: [], next: parsed.next ?? ON_IT, via: "MODEL", brief: brief(asks) };
  }
  const asks = sentencesOf(written);
  return {
    ...common,
    none: asks.length === 0,
    asks,
    noted: [],
    next: "No reader was free just now, so these are your sentences as you wrote them, and the work starts from them. The next email from me is the result, or one question.",
    via: "FALLBACK",
    brief: brief(asks),
  };
}

/**
 * THE FIRST READ, AS FIELDS (22 Nov 2026, engineering sweep row 6). The reader answers in this JSON shape at the AI
 * boundary (a reply in any other shape walks to the next lane); `parseUnderstood` then keeps only what is really his.
 */
const FIRST_READ_DECISION = z.object({
  kind: z.enum(["approve", "change", "question", "stop", "nothing"]),
  property: z.string().nullable(),
  handOffTo: z.string().nullable(),
  planApproved: z.boolean().nullable(),
  holds: z.array(z.string()),
  takeBack: z.boolean().nullable(),
  cc: z.array(z.string()),
  backBy: z.string().nullable().describe("YYYY-MM-DD, Central, or null"),
  deadline: z.object({ words: z.string(), local: z.string() }).nullable().describe("the deadline he sets for the work: his exact words, and that time as Central YYYY-MM-DDTHH:MM; null when none"),
  handOffAnswer: z.enum(["yes", "no", "unsure"]).nullable().describe("his answer to Porter's pending hand-off question; null when none is pending"),
});
export const UNDERSTOOD_OUTPUT = structuredOutput(
  "first_read",
  z.object({
    none: z.boolean().describe("true when he asks for nothing (a thank-you, an FYI)"),
    asks: z.array(z.string()).describe("each separate ask, in his exact words"),
    holds: z.array(z.string()).describe("each constraint on the work (what must not happen, or must happen first), in his exact words; never a question or something he leaves open"),
    questions: z.array(z.string()).describe("each open question or thing he leaves undecided, in his exact words, including lines with no question mark (\"whether to … is still open\", \"I'm questioning whether …\"); every one, none dropped"),
    unclear: z.array(z.object({ words: z.string(), missing: z.string() })).describe("each ask you cannot pin down: his exact words and what is missing"),
    files: z.array(z.object({ filename: z.string(), purpose: z.string() })).describe("what each attached file is for"),
    next: z.string().nullable().describe("what happens next, one plain sentence"),
    decision: FIRST_READ_DECISION.nullable(),
  }),
);

const unquote = (s: string) => s.trim().replace(/^["“]|["”]$/g, "").trim();

/** The checked first read, kept only where it is his: asks, holds, questions and unclear words must be found in what he wrote; a file must really be on the card. */
export function parseUnderstood(text: string, written: string, files: readonly string[] = []): { asks: string[]; next: string | null; none: boolean; holds: string[]; questions: string[]; unclear: Array<{ words: string; missing: string }>; files: Array<{ filename: string; purpose: string }>; decision: FirstReadDecision | null } {
  const read = readStructured(UNDERSTOOD_OUTPUT, text);
  if (!read) return { decision: null, asks: [], next: null, none: false, holds: [], questions: [], unclear: [], files: [] };
  const body = norm(written);
  const his = (w: string) => w.length >= 3 && body.includes(norm(w));
  const asks: string[] = [];
  for (const raw of read.asks) {
    const ask = unquote(raw);
    if (his(ask) && !asks.some((a) => norm(a) === norm(ask))) asks.push(ask);
  }
  const none = read.none && read.asks.length === 0;
  const next = read.next?.trim() || null;
  // Holds and questions only when they are his words too; which is which is the reader's call.
  const holds: string[] = [];
  const questions: string[] = [];
  const place = (raw: string, list: string[]) => {
    const words = unquote(raw);
    if (his(words) && !list.some((h) => norm(h) === norm(words))) list.push(words);
  };
  for (const q of read.questions) place(q, questions);
  // A line the reader gave as both is a question (a question is never a hold).
  for (const h of read.holds) if (!questions.some((q) => norm(q) === norm(unquote(h)))) place(h, holds);
  const unclear: Array<{ words: string; missing: string }> = [];
  for (const u of read.unclear) {
    const words = unquote(u.words);
    if (his(words) && u.missing.trim() && !unclear.some((x) => norm(x.words) === norm(words))) unclear.push({ words, missing: u.missing.trim().slice(0, 240) });
  }
  const purposes: Array<{ filename: string; purpose: string }> = [];
  for (const f of read.files) {
    const name = files.find((x) => x.toLowerCase() === unquote(f.filename).toLowerCase());
    if (name && f.purpose.trim() && !purposes.some((p) => p.filename === name)) purposes.push({ filename: name, purpose: f.purpose.trim().slice(0, 200) });
  }
  return { decision: parseDecision(read.decision), asks: asks.slice(0, MAX_ASKS), next: next ? next.slice(0, 280) : null, none, holds, questions, unclear, files: purposes };
}

/** How much of the OS's OTHER context (profile, practices, the card) rides beside the brain's sections, which are never cut. */
export const KNOWN_OTHER_MAX = 4000;

function understoodPrompt(subject: string, written: string, files: readonly string[] = [], known = "", today = centralDay(new Date()), wrote: Date = new Date()): string {
  return [
    "A Managing Partner of the firm just emailed the work below. List each separate thing he is asking for.",
    "Rules: copy his EXACT words for each ask (a phrase or sentence from his email, unchanged, no rewording, no summary): asks.",
    "holds: ONLY a constraint, something he says must not happen, must wait for him, or must always or never be done (don't, must, never, not yet, nothing live, no client names without his written OK), in his exact words.",
    "questions: anything he asks, wonders about, wants clarified or says is still open, in his exact words. A question is never a hold.",
    "unclear: each ask you cannot pin down (a fact that is missing, a voice note that disagrees with the email, two different readings): his exact words, and what is missing in one plain line.",
    ...(files.length ? [`files: for each attached file, what it is for, from his email (under 15 words).`, `Files: ${files.join(", ")}`] : ["files: empty (nothing is attached)."]),
    "next: what happens next, one plain sentence, no promises of dates, nothing about models or systems.",
    "A remark on how something is (praise, status, \"X is in good shape\") is NOT an ask. Each numbered item is one ask. Never a fragment of a sentence.",
    "decision: always give it. Choose the actual kind (approve, change, question, stop or nothing). A site mentioned only as separate from the work is not the property. A project or dashboard is not a person. Asking to confirm a plan is not approving it. Use null when unspecified.",
    `In decision: handOffTo is the person he hands this work to, only when he actually hands it over now (never when he doubts it, negates it, makes it conditional, quotes someone or asks). takeBack is true only when he takes the work back himself now. cc lists the people he asks to copy on the finished email (empty when none). backBy is the last day (YYYY-MM-DD) of the window he says he will come back to this by ("this weekend" is that Sunday), counting from today, ${today}; null when he names none. deadline is a deadline he sets for the work ("by Monday noon", "today", "asap"): his exact words, and that time as Central YYYY-MM-DDTHH:MM (a day with no hour is 17:00 that day; "asap" is two hours after he wrote; he wrote at ${central(wrote)} Central); null when he sets none. handOffAnswer is his answer to the hand-off question Porter asked him, when one is shown below: yes only when he plainly confirms it, no when he declines it, unsure otherwise; null when no question is shown.`,
    "none: true only if he asks for nothing (a thank-you, an FYI); decision is still given.",
    ...(known.trim()
      ? [
          "",
          "WHAT THE FIRM ALREADY KNOWS (settled facts about him, his businesses and this card). Never list as unclear anything these answer (for example which of his businesses a word refers to):",
          known.trim(),
        ]
      : []),
    "",
    `Subject: ${subject}`,
    "Email:",
    written.slice(0, 6000),
  ].join("\n");
}

interface Candidate {
  id: string;
  message_id: string | null;
  r2_key: string | null;
  subject: string | null;
  received_at: string;
  firm_scope: string;
  partner: string | null;
  card_id: string;
  title: string;
  owner_id: string | null;
  prompt: string | null;
  state: string;
  kind: string | null;
  held_reason: string | null;
}

async function wordsOf(env: Env, row: Candidate): Promise<string> {
  // WHAT THE DOOR ACTUALLY READ (15 Nov 2026): a reply's steer carries his typed words AND each voice note's and linked
  // recording's transcript, so the Got it answers what was heard, never only what was typed.
  if (row.message_id) {
    const steer = await env.WP_OS_DB.prepare("SELECT body FROM work_steer WHERE message_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(row.message_id).first<{ body: string }>().catch(() => null);
    if (steer?.body?.trim()) return steer.body.trim();
  }
  let raw = "";
  try {
    raw = row.r2_key && env.WP_OS_DOCUMENTS ? ((await (await env.WP_OS_DOCUMENTS.get(row.r2_key))?.text()) ?? "") : "";
  } catch {
    raw = "";
  }
  const own = raw ? partnersOwnWords((await readMail(raw)).text).trim() : "";
  return own || (row.prompt ?? "").trim() || (row.subject ?? "").trim();
}

async function employeeName(env: Env, id: string | null): Promise<string> {
  if (!id) return "West Peek";
  const row = await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(id).first<{ name: string }>();
  return row?.name ?? "West Peek";
}

async function settle(env: Env, messageId: string, state: string, viaRead: string | null, asks: number, detail: string): Promise<void> {
  // 0306's CHECK allows MODEL or FALLBACK: an email read from its own numbered structure with no reader is the OS's
  // own read (FALLBACK). Writing "STRUCTURE" failed the CHECK after the Got it had gone, and left the row NOT_SENT.
  const via = viaRead === "STRUCTURE" ? "FALLBACK" : viaRead;
  await env.WP_OS_DB.prepare(
    "UPDATE partner_understood SET state = ?2, via = ?3, asks = ?4, detail = ?5, sent_at = CASE WHEN ?2 = 'SENT' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_at END WHERE inbound_message_id = ?1",
  )
    .bind(messageId, state, via, asks, detail.slice(0, 400))
    .run();
}

/**
 * WHAT THE FIRM ALREADY KNOWS, for the reader (15 Nov 2026: "west Peek productions and top barz are diff entities why
 * would anything re top barz be unclear?"). His standing practices and living profile (who he is, his businesses and
 * their sites, what he is working on) and the card itself, so the reader never flags what is settled. Never throws.
 */
/**
 * THE BRAIN'S SECTIONS FOR ONE READ (15 Nov 2026): the sender's own `### <partner>` section, the `###` section of each
 * business the card and the email are about, and the "which business is this word?" lookup, each whole, from the
 * brain facts the Mac wrote onto the profile (0310). A missing heading is logged once and left out; no brain facts at
 * all is today's behaviour. Never throws.
 */
const brainNoticed = new Set<string>();
async function brainSectionsFor(env: Env, input: { partnerName: string | null; cardText: string; words: string }): Promise<string> {
  const { brainFactsOf } = await import("./partnerProfile");
  const { businessesFor, subsection, wordLookup } = await import("../../shared/brain/brainSections");
  const md = await brainFactsOf(env).catch(() => "");
  const missing = (what: string) => {
    if (brainNoticed.has(what)) return;
    brainNoticed.add(what);
    console.warn(`first read: the brain facts have no ${what}; the read goes on without it`);
  };
  if (!md) {
    missing("sections at all (the Mac has not written them yet)");
    return "";
  }
  const parts: string[] = [];
  if (input.partnerName) {
    const p = subsection(md, input.partnerName);
    if (p) parts.push(p);
    else missing(`"### ${input.partnerName}" section`);
  }
  for (const h of businessesFor(input.cardText, input.words)) {
    const b = subsection(md, h);
    if (b) parts.push(b);
    else missing(`"### ${h}" section`);
  }
  const lookup = wordLookup(md);
  if (lookup && !parts.some((p) => p.includes(lookup))) parts.push(lookup);
  else if (!lookup) missing(`"which business is this word?" lookup`);
  return parts.join("\n\n");
}

export async function knownFor(
  env: Env,
  cardId: string | null,
  firmScope = "west-peek",
  partnerEmail?: string | null,
  words = "",
): Promise<{ text: string; standingHolds: string[] }> {
  try {
    const { practicesForCard } = await import("./partnerConstraints");
    const card = cardId ? await env.WP_OS_DB.prepare("SELECT title, description, kind, request_json FROM work_card WHERE id = ?1").bind(cardId).first<{ title: string; description: string | null; kind: string | null; request_json: string | null }>() : null;
    const email = partnerEmail ?? (cardId ? (await env.WP_OS_DB.prepare("SELECT requested_by_email FROM work_card WHERE id = ?1").bind(cardId).first<{ requested_by_email: string | null }>())?.requested_by_email : null) ?? null;
    const partner = partnerByEmail(email);
    // The brain's sections first and whole: his own section, each business the card and the email are about, the lookup.
    const brain = await brainSectionsFor(env, { partnerName: partner?.fullName ?? null, cardText: card ? `${card.title}\n${card.kind ?? ""}\n${card.request_json ?? ""}` : "", words });
    const practices = cardId ? await practicesForCard(env, cardId, firmScope) : email ? await (await import("./partnerProfile")).profileBlockFor(env, email) : "";
    const other = [practices, card ? `The card: ${card.title}${card.description ? `\n${card.description.slice(-1500)}` : ""}` : ""].filter(Boolean).join("\n\n").slice(0, KNOWN_OTHER_MAX);
    // STANDING HOLDS (her ruling): a constraint line in his own brain section is a hold whether or not this email repeats it.
    const mine = partner ? brain.split(/\n(?=### )/).find((sec) => sec.startsWith(`### ${partner.fullName}`)) ?? "" : "";
    // Only the "Standing holds" line of his section, one hold per "·" item; his roles, habits and update preferences
    // are context for the reader, never holds.
    const holdsLine = mine.split("\n").find((l) => /^\s*[-*•]\s+\**Standing holds/i.test(l)) ?? "";
    const standingHolds = holdsLine
      .replace(/^\s*[-*•]\s+\**Standing holds[^:]*:\**\s*/i, "")
      .split(/\s+·\s+/)
      // His own quoted words are stored in quotes in the brain; the Got it quotes each hold itself, so they are unwrapped here.
      .map((h) => h.replace(/\*\*/g, "").trim().replace(/[.;]$/, "").replace(/^["“]([^"“”]*)["”]$/, "$1"))
      .filter((h) => h.length > 8);
    return { text: [brain ? `FROM THE BRAIN:\n${brain}` : "", other].filter(Boolean).join("\n\n"), standingHolds };
  } catch {
    return { text: "", standingHolds: [] };
  }
}

/** The brief beside the asks it lists (0309): holds, files and who read it. The asks themselves are partner_ask rows. */
async function saveBrief(env: Env, messageId: string, brief: Brief): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE partner_understood SET brief_json = ?2, reader = ?3 WHERE inbound_message_id = ?1")
    .bind(messageId, JSON.stringify({
      decision: brief.decision,
      holds: brief.holds.slice(0, BRIEF_LIST_BOUND),
      questions: brief.questions.slice(0, BRIEF_LIST_BOUND),
      unclear: brief.unclear.slice(0, BRIEF_LIST_BOUND),
      files: brief.files,
      more: { holds: Math.max(0, brief.holds.length - BRIEF_LIST_BOUND), questions: Math.max(0, brief.questions.length - BRIEF_LIST_BOUND), unclear: Math.max(0, brief.unclear.length - BRIEF_LIST_BOUND) },
    }), brief.reader ?? "OS")
    .run();
}

/**
 * THE BRIEF, AS EVERY EMPLOYEE READS IT (15 Nov 2026). The same asks the Got it listed (partner_ask), his holds and his
 * files with what each is for, for this card's latest partner emails. `practicesForCard` puts it in every employee's
 * input (Porter's Mac job, a partner session, the general step loop), so the Got it and the work start from one read.
 */
export async function briefBlockFor(env: Env, cardId: string): Promise<string> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT u.inbound_message_id AS id, u.brief_json, u.reader, m.received_at FROM partner_understood u JOIN inbound_message m ON m.id = u.inbound_message_id
        WHERE u.work_card_id = ?1 AND u.brief_json IS NOT NULL ORDER BY m.received_at DESC LIMIT 3`,
    )
      .bind(cardId)
      .all<{ id: string; brief_json: string; reader: string | null; received_at: string }>()
      .catch(() => ({ results: [] as Array<{ id: string; brief_json: string; reader: string | null; received_at: string }> }))
  ).results ?? [];
  const blocks: string[] = [];
  for (const r of rows.reverse()) {
    const asks = ((await env.WP_OS_DB.prepare("SELECT words FROM partner_ask WHERE inbound_message_id = ?1 ORDER BY seq").bind(r.id).all<{ words: string }>()).results ?? []).map((a) => a.words);
    let brief: { holds?: string[]; questions?: string[]; unclear?: Array<{ words: string; missing: string }>; more?: { holds?: number; questions?: number; unclear?: number }; files?: Array<{ filename: string; purpose: string | null }> } = {};
    try {
      brief = JSON.parse(r.brief_json) as typeof brief;
    } catch {
      brief = {};
    }
    const holds = brief.holds ?? [];
    const questions = brief.questions ?? [];
    const unclear = brief.unclear ?? [];
    const more = (n: number | undefined): string[] => (n && n > 0 ? [`  - and ${n} more in his email: read it whole before you start`] : []);
    const files = brief.files ?? [];
    blocks.push(
      [
        `THE FIRST READ of his email of ${r.received_at} (${r.reader && r.reader !== "OS" ? `read by ${r.reader}` : "the OS's own read: no reader was free"}). Work from this list; the Got it told him exactly these.`,
        ...(asks.length ? ["His asks, in his words:", ...asks.map((a, i) => `  ${i + 1}. ${a}`)] : ["He asked for nothing (a thank-you or an FYI)."]),
        ...(holds.length ? ["His holds (keep to every one):", ...holds.map((h) => `  - ${h}`), ...more(brief.more?.holds)] : []),
        ...(questions.length ? ["His questions (answer each in your result):", ...questions.map((q) => `  - ${q}`), ...more(brief.more?.questions)] : []),
        ...(unclear.length ? ["Unclear. Before asking, try to resolve each one from the brain (on the Mac: ~/Brains/<the business's slug>.md, Settled decisions), this card, the repo and the data (for example a tracker column that tells Productions from Top Barz). Ask him only what is still open: every such item, numbered, in one email; never merge, drop or guess. Build everything else meanwhile, and say in your result how each one was resolved:", ...unclear.map((u) => `  - "${u.words}": ${u.missing}`), ...more(brief.more?.unclear)] : []),
        ...(files.length ? ["His files:", ...files.map((f) => `  - ${f.filename}: ${f.purpose ?? "what it is for was not said"}`)] : []),
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

/**
 * STEP 1. Every authenticated partner email linked to a card in the last half hour, not yet answered, gets its one
 * "Got it". Returns how many were sent. Never throws into the sweep.
 */
export async function sendUnderstoodReplies(env: Env, now: Date, read: SeatRead | readonly Reader[] = FIRST_READERS): Promise<number> {
  const since = new Date(now.getTime() - UNDERSTOOD_WINDOW_MINUTES * 60_000).toISOString();
  const until = new Date(now.getTime() + 60_000).toISOString();
  let rows: Candidate[] = [];
  try {
    rows = (
      await env.WP_OS_DB.prepare(
        `SELECT m.id, m.message_id, m.r2_key, m.subject, m.received_at, m.firm_scope, lower(json_extract(m.mail_authority_json, '$.partner')) AS partner,
                c.id AS card_id, c.title, c.owner_id, c.prompt, c.state, c.kind, c.held_reason
           FROM inbound_message m JOIN work_card c ON c.id = m.work_card_id
          WHERE m.received_at >= ?1 AND m.received_at <= ?2
            AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
            -- Not answered yet, or claimed and waiting for a reader that was there and failed (read again).
            AND NOT EXISTS (SELECT 1 FROM partner_understood u WHERE u.inbound_message_id = m.id AND NOT (u.state = 'CLAIMED' AND u.detail LIKE '${WAITING_FOR_READER}%'))
          ORDER BY m.received_at ASC
          LIMIT ?3`,
      )
        .bind(since, until, UNDERSTOOD_PER_TICK)
        .all<Candidate>()
    ).results ?? [];
  } catch (err) {
    console.error("reading partner emails to answer failed", err);
    return 0;
  }
  let sent = 0;
  for (const row of rows) {
    try {
      if (await answerOne(env, row, read, now)) sent += 1;
    } catch (err) {
      console.error("a partner's Got it failed", err);
      await settle(env, row.id, "NOT_SENT", null, 0, `failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
  return sent;
}

/**
 * THE DEADLINE IS THE FIRST READ'S (22 Nov 2026, review of #574: one model read per email). Its words must be in his
 * email and its time real and ahead (`deadlineOf`); then the card, and the card it was handed on as (Porter's web job,
 * its request and a job still queued for the Mac), carry its priority and `due`. A read from before the field existed
 * (`deadline` absent) falls back to the logged word list; no reader at all → the word list, logged.
 */
export async function applyFirstReadDeadline(env: Env, input: { cardId: string; decision: FirstReadDecision | null; written: string; now: Date }): Promise<void> {
  const { deadlineOf } = await import("../../shared/intake/replyMeaning");
  const fromRead = input.decision && input.decision.deadline !== undefined ? { deadline: input.decision.deadline, reader: "FIRST_READ" } : null;
  const deadline = deadlineOf(fromRead, input.written, input.now);
  if (deadline.why) console.warn(`deadline not kept for card ${input.cardId}: ${deadline.why}`);
  const due = deadline.due;
  if (!due) return;
  const db = env.WP_OS_DB;
  const cards = [input.cardId, ...((await db.prepare("SELECT id FROM work_card WHERE assigned_from_card_id = ?1").bind(input.cardId).all<{ id: string }>()).results ?? []).map((r) => r.id)];
  const dueJson = JSON.stringify(due);
  for (const id of cards) {
    // A deadline only ever raises the priority (a later "by Friday" never lowers an URGENT card).
    await db.prepare("UPDATE work_card SET priority = ?2 WHERE id = ?1 AND (CASE COALESCE(priority, 'NORMAL') WHEN 'URGENT' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 1 ELSE 0 END) < (CASE ?2 WHEN 'URGENT' THEN 3 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 1 ELSE 0 END)").bind(id, due.priority).run();
    await db.prepare("UPDATE work_card SET request_json = json_set(request_json, '$.due', json(?2)) WHERE id = ?1 AND request_json IS NOT NULL AND json_valid(request_json) AND json_extract(request_json, '$.due') IS NULL").bind(id, dueJson).run();
    await db.prepare("UPDATE subscription_seat_run SET job_json = json_set(job_json, '$.due', json(?2)) WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED' AND json_valid(job_json) AND json_extract(job_json, '$.due') IS NULL").bind(id, dueJson).run();
  }
}

async function answerOne(env: Env, row: Candidate, read: SeatRead | readonly Reader[], now: Date = new Date()): Promise<boolean> {
  const partner = partnerByEmail(row.partner);
  // The claim: a second tick (or a racing one) finds the row and does nothing. A row waiting for a reader is re-taken
  // by one tick only (the conditional update).
  const claimed = await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO partner_understood (inbound_message_id, work_card_id, partner_email, firm_scope) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(row.id, row.card_id, partner?.email ?? String(row.partner ?? ""), row.firm_scope)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) {
    const retaken = await env.WP_OS_DB.prepare(`UPDATE partner_understood SET detail = 'reading again' WHERE inbound_message_id = ?1 AND state = 'CLAIMED' AND detail LIKE '${WAITING_FOR_READER}%'`).bind(row.id).run();
    if ((retaken.meta?.changes ?? 0) !== 1) return false;
  }
  if (!partner) {
    await settle(env, row.id, "NOT_SENT", null, 0, "the sender is not on the partner registry; a Got it goes to partners only");
    return false;
  }

  const written = await wordsOf(env, row);
  const subject = (row.subject ?? "").trim() || row.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || row.title;
  const filed = ((await env.WP_OS_DB.prepare("SELECT filename FROM request_attachment WHERE work_card_id = ?1 AND created_at >= ?2 ORDER BY created_at, filename").bind(row.card_id, row.received_at).all<{ filename: string }>().catch(() => ({ results: [] as Array<{ filename: string }> }))).results ?? []).map((r) => r.filename);
  const known = await knownFor(env, row.card_id, row.firm_scope, partner.email, written);
  // Porter's pending hand-off question rides in the same read, so his answer to it needs no second model call.
  const asked = row.card_id ? await (await import("./handOff")).pendingHandOffQuestion(env, row.card_id) : null;
  if (asked) known.text = [known.text, `THE HAND-OFF QUESTION PORTER ASKED HIM (give handOffAnswer): "${asked}"`].filter(Boolean).join("\n\n");
  const understood = await understand(env, { subject, written, read, employeeId: row.owner_id, firmScope: row.firm_scope, files: filed, known: known.text, standingHolds: known.standingHolds, today: centralDay(new Date(row.received_at)), wrote: new Date(row.received_at) });
  /*
   * A READER WAS THERE AND FAILED: WAIT FOR IT (15 Nov 2026). Up to FIRST_READ_WAIT_MINUTES from his email the row stays
   * claimed and the next tick reads it again; the employee waits too (`claimNextCard`). Past that, or when no reader
   * was there at all, the Got it and the brief come from the OS's own read, now.
   */
  const ageMinutes = (now.getTime() - Date.parse(row.received_at)) / 60_000;
  if (!understood.brief.reader && understood.readerFailed && ageMinutes < FIRST_READ_WAIT_MINUTES) {
    await env.WP_OS_DB.prepare("UPDATE partner_understood SET detail = ?2 WHERE inbound_message_id = ?1")
      .bind(row.id, `${WAITING_FOR_READER}: ${understood.readersTried.join("; ")}`.slice(0, 400))
      .run();
    return false;
  }
  await saveBrief(env, row.id, understood.brief);
  // ALL KINDS (owner, 6 Oct 2026): a deadline in his words sets the work's priority, from this one read (review of #574).
  if (row.card_id) await applyFirstReadDeadline(env, { cardId: row.card_id, decision: understood.brief.decision, written: `${subject}\n${written}`, now: new Date(row.received_at) }).catch((err) => console.error("applying a deadline failed", err));
  /*
   * WHAT HIS REPLY SAYS ABOUT THE CARD ITSELF IS THE FIRST READ'S (20 Nov 2026): hand-off, take-back, a second
   * partner's "approved", cc and "back on <day>" are decided here, from the decision just saved, and no longer by
   * keywords at the reply door. With no decision (no reader answered within the ten minutes), the keywords act, logged.
   * Before the Got it, so an email that only handed the card on gets the hand-off email, not a Got it as well.
   */
  await (await import("./firstReadDecides")).decideReplyWords(env, { inboundId: row.id, messageId: row.message_id, receivedAt: row.received_at, decision: understood.brief.decision }).catch((err) => console.error("deciding a reply's words failed", err));
  if (understood.none) {
    await settle(env, row.id, "NOTHING_ASKED", understood.via, 0, understood.asks.length ? "he asked for nothing (a thank-you or an FYI)" : "no words to quote");
    return false;
  }
  const { asks, via } = understood;
  const seqBase = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM partner_ask WHERE work_card_id = ?1").bind(row.card_id).first<{ n: number }>())?.n ?? 0;
  for (let i = 0; i < asks.length; i += 1) {
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO partner_ask (id, work_card_id, inbound_message_id, seq, words, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(`pask_${crypto.randomUUID()}`, row.card_id, row.id, seqBase + i + 1, asks[i]!.slice(0, 1000), row.firm_scope)
      .run();
  }

  // A noise card the runner already dropped, or a door that already answered him since he wrote: no second email.
  if (row.state === "CANCELLED") {
    await settle(env, row.id, "NOT_SENT", via, asks.length, "the card was closed as needing no action");
    return false;
  }
  const answered = await env.WP_OS_DB.prepare("SELECT 1 AS x FROM work_card_notice WHERE work_card_id = ?1 AND sent = 1 AND sent_at >= ?2 LIMIT 1").bind(row.card_id, row.received_at).first<{ x: number }>();
  if (answered) {
    await settle(env, row.id, "NOT_SENT", via, asks.length, "the door already answered him on this card");
    return false;
  }
  const cause = `understood:${row.id}`;
  if (await alreadyTold(env, row.card_id, "RECEIVED", cause)) {
    await settle(env, row.id, "SENT", via, asks.length, "already sent");
    return false;
  }

  /*
   * A CARD A DEVELOPER HAS TAKEN OVER (15 Nov 2026): his reply is filed and nothing starts, so the Got it says so —
   * never "I'm starting on it now". Sequoia's desk hears that he replied, once per reply, with the card.
   */
  const takenOver = isTakenOver(row.held_reason);
  const next = gotItNext(row.held_reason, understood.next);
  if (takenOver) {
    await notifyQuietly(env, {
      firmUserId: PREVIEW_PARTNER.firmUserId,
      kind: "EMPLOYEE_EXCEPTION",
      severity: "INFO",
      title: `${partner.firstName} replied on a card a developer has taken over`,
      body: `Card ${row.card_id} ("${row.title.slice(0, 120)}"): his reply is filed on the card and nothing was started. He was told it starts once the current round is wrapped up.`,
      objectType: "work_card",
      objectId: row.card_id,
      dedupeKey: `reply_during_takeover:${row.id}`,
      firmScope: row.firm_scope,
    });
  }
  const unopened = await filesNotOpened(env, row.card_id, row.received_at);
  const who = await employeeName(env, row.owner_id);
  const email = gotItEmail({ employee: who, subject, asks, next, unopened, noted: understood.noted, filed, holds: understood.brief.holds });
  const replyOnThread = await threadRootFor(env, row.card_id);
  const result = await sendOrPreview(env, {
    to: partner.email,
    email,
    objectType: "work_card",
    objectId: row.card_id,
    workCardId: row.card_id,
    cardKind: row.kind ?? null,
    // A receipt is not finished work: it never waits in a preview lane and copies nobody.
    cardAsked: false,
    requestedByEmail: partner.email,
    firmScope: row.firm_scope,
    actorId: "partner_understood",
    replyOnThread,
    events: { sent: "partner_understood.sent", notSent: "partner_understood.not_sent" },
  });
  await recordNotice(env, { cardId: row.card_id, kind: "RECEIVED", cause, to: partner.email, messageId: result.threadToken ?? null, sent: result.sent, detail: result.reason, firmScope: row.firm_scope });
  await settle(env, row.id, result.sent ? "SENT" : "NOT_SENT", via, asks.length, result.reason);
  await appendEvent(env, {
    eventType: "partner_understood.answered",
    actorType: "system",
    actorId: "partner_understood",
    objectType: "work_card",
    objectId: row.card_id,
    firmScope: row.firm_scope,
    payload: { inbound_message_id: row.id, sent: result.sent, via, asks: asks.length, holds: understood.brief.holds.length, questions: understood.brief.questions.length, unclear: understood.brief.unclear.length, files: understood.brief.files.length, received_at: row.received_at, reader: understood.brief.reader ?? "OS" },
  }).catch(() => undefined);
  return result.sent;
}

/** What a Got it on a taken-over card says happens next: the truth, nothing started. */
export const TAKEN_OVER_NEXT = "I'll start on these as soon as the current round is wrapped up; nothing is lost.";

/** The Got it's "what happens next", the one rule both the live send and the dry run use. Pure. */
export function gotItNext(heldReason: string | null | undefined, next: string): string {
  return isTakenOver(heldReason) ? TAKEN_OVER_NEXT : next;
}

/** The "Got it" itself: his asks in his words, every file that could not be opened, what happens next. Pure. */
export function gotItEmail(input: { employee: string; subject: string; asks: readonly string[]; next: string; unopened: ReadonlyArray<{ filename: string; reason: string }>; noted?: readonly string[]; filed?: readonly string[]; holds?: readonly string[] }) {
  const { asks, next, unopened } = input;
  const holds = input.holds ?? [];
  const filed = input.filed ?? [];
  // A voice note is named once, by what was heard ("<file>: heard and transcribed (N words)"), never also as a plain file.
  const HEARD = /^(.+): heard and transcribed \(/;
  const heard = (input.noted ?? []).filter((n) => HEARD.test(n));
  const noted = (input.noted ?? []).filter((n) => !HEARD.test(n));
  const heardName = new Map(heard.map((h) => [HEARD.exec(h)![1]!, h]));
  // A ZIP is one line ("x.zip (20 files inside)"); its files are named under Details. Loose files come first.
  const zips = filed.filter((f) => /\.zip$/i.test(f));
  const inside = (z: string) => filed.filter((f) => f.startsWith(`${z}/`)).map((f) => f.slice(z.length + 1));
  const loose = filed.filter((f) => !zips.includes(f) && !zips.some((z) => f.startsWith(`${z}/`)));
  const fileLines = [
    ...loose.map((f) => heardName.get(f) ?? f),
    ...heard.filter((h) => !loose.includes(HEARD.exec(h)![1]!)),
    ...zips.map((z) => { const n = inside(z).length; return n ? `${z} (${n} file${n === 1 ? "" : "s"} inside)` : z; }),
  ];
  const quoted = (a: string) => {
    for (const lead of [QUESTIONS_LEAD, QUESTIONS_PLAIN]) if (a.startsWith(lead)) return `${lead}${quoteHis(a.slice(lead.length))}`;
    return quoteHis(a);
  };
  const heldForHim = holds.map(holdForHim).filter((h): h is string => h !== null);
  const sections = [
    { label: "What you asked", bullets: asks.map(quoted) },
    // Every file of his now on the card, by name (a ZIP's files each named), so he can see nothing was lost.
    ...(fileLines.length ? [{ label: "Files on the card", bullets: fileLines }] : []),
    // Read first, then answered: every file of his that could not be opened is named, never skipped in silence.
    ...(unopened.length ? [{ label: "What I could not open", bullets: unopened.map((f) => `${f.filename}: ${f.reason}`) }] : []),
    // What he said that is not an ask (an idea for later, a process note) is shown as kept, never dropped.
    ...(noted.length ? [{ label: "Also noted", bullets: noted.map(quoteHis) }] : []),
    // His holds, in his words, so he can see they were heard before anything is built.
    ...(heldForHim.length ? [{ label: "What I'll hold to", bullets: heldForHim }] : []),
    { label: "What happens next", bullets: [next, "Reply to this email to change anything; I read it before I go on."] },
  ];
  // The renderer shows SECTION_MAX_LINES - 1 lines of a longer section and points at "Details below": the rest of every
  // such section is written there, so no ask and no file is cut from the email (15 Nov 2026: 5 of 10 asks vanished).
  const rest = sections
    .filter((s) => s.bullets.length > SECTION_MAX_LINES)
    .map((s) => [`**${s.label}, continued**`, ...s.bullets.slice(SECTION_MAX_LINES - 1).map((b) => `• ${b}`)].join("\n"));
  for (const z of zips) if (inside(z).length) rest.push([`**Inside ${z}**`, ...inside(z).map((f) => `• ${f}`)].join("\n"));
  return {
    employee: input.employee,
    what: `got it — ${input.subject.slice(0, 80)}`,
    tldr: `Got it. ${asks.length === 1 ? "One thing" : `${asks.length} things`} you asked, in your words, below. ${next}`,
    tldrBullets: [] as string[],
    sections,
    details: rest.length ? rest.join("\n\n") : null,
  };
}

/** Every file of this message the door could not open (files, voice notes, Drive links), from the card's record. */
async function filesNotOpened(env: Env, cardId: string, receivedAt: string): Promise<Array<{ filename: string; reason: string }>> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type = ?2 AND created_at >= ?3 ORDER BY created_at")
      .bind(cardId, FILES_NOT_OPENED, receivedAt)
      .all<{ payload_json: string }>()
      .catch(() => ({ results: [] as Array<{ payload_json: string }> }))
  ).results ?? [];
  const out: Array<{ filename: string; reason: string }> = [];
  for (const r of rows) {
    try {
      for (const f of (JSON.parse(r.payload_json) as { files?: Array<{ filename: string; reason: string }> }).files ?? []) {
        if (!out.some((o) => o.filename === f.filename)) out.push(f);
      }
    } catch {
      /* a payload that is not JSON names nothing */
    }
  }
  return out.slice(0, 12);
}

/** Past this, a partner email with no acknowledgement is raised on Sequoia's desk (her rule: never silent). */
export const UNACKNOWLEDGED_MINUTES = 5;

/**
 * NEVER SILENT (15 Nov 2026). On the sweep, after the Got it lane. Three shapes, each raised once on Sequoia's desk:
 *   1 · a door that started and never finished (its claim still unfinished past the window): killed. Two of those on one
 *       message and it is handed to a Mac session instead of being read inline a third time.
 *   2 · a partner email placed on a card with no Got it past the window.
 *   3 · a message handed to a Mac session that has not finished it past the window (the Mac is asleep).
 * Returns how many were raised. Never throws into the sweep.
 */
export async function raiseUnacknowledgedMail(env: Env, now: Date = new Date()): Promise<number> {
  const { raiseUnreadMail, handOffUnreadableMail, headersOfRaw, INLINE_READ_ATTEMPTS } = await import("../effects/inboundEmail");
  const late = new Date(now.getTime() - UNACKNOWLEDGED_MINUTES * 60_000).toISOString();
  const day = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const hour = new Date(now.getTime() - 60 * 60_000).toISOString();
  let raised = 0;
  try {
    const died = (await env.WP_OS_DB.prepare(
      `SELECT s.message_id, s.attempts, m.r2_key, m.from_address, m.subject FROM inbound_email_seen s LEFT JOIN inbound_message m ON m.message_id = s.message_id
        WHERE s.handled = 0 AND s.seen_at < ?1 AND s.seen_at >= ?2 LIMIT 10`,
    ).bind(late, day).all<{ message_id: string; attempts: number; r2_key: string | null; from_address: string | null; subject: string | null }>()).results ?? [];
    for (const d of died) {
      if (d.attempts >= INLINE_READ_ATTEMPTS) {
        const claimed = await env.WP_OS_DB.prepare("UPDATE inbound_email_seen SET handled = 2 WHERE message_id = ?1 AND handled = 0").bind(d.message_id).run();
        if ((claimed.meta?.changes ?? 0) !== 1) continue;
        // Only the header block is read back (a ranged get): never the body.
        const head = d.r2_key && env.WP_OS_DOCUMENTS ? await (await env.WP_OS_DOCUMENTS.get(d.r2_key, { range: { offset: 0, length: 64 * 1024 } }))?.text() : null;
        await handOffUnreadableMail(env, { messageId: d.message_id, sender: d.from_address ?? "unknown", subject: d.subject ?? "", headers: headersOfRaw(head ?? "") });
      } else {
        await raiseUnreadMail(env, {
          dedupeKey: `inbound_email_door_died:${d.message_id}`,
          title: "An email's read was stopped before it finished",
          body: `From ${(d.from_address ?? "unknown").slice(0, 120)}, subject "${(d.subject ?? "").slice(0, 120)}". The Worker began reading it and was stopped; no "Got it" was sent. A redelivery reads it again${d.r2_key ? `; it is stored at ${d.r2_key}` : ""}.`,
          objectId: d.message_id,
        });
      }
      raised += 1;
    }
    const noGotIt = (await env.WP_OS_DB.prepare(
      `SELECT m.id, m.work_card_id, m.from_address, m.subject FROM inbound_message m
        WHERE m.work_card_id IS NOT NULL AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
          AND m.received_at < ?1 AND m.received_at >= ?2
          AND NOT EXISTS (SELECT 1 FROM partner_understood u WHERE u.inbound_message_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM work_card c WHERE c.id = m.work_card_id AND c.held_reason LIKE ?3 || '%') LIMIT 10`,
    ).bind(late, hour, TAKEN_OVER_PREFIX).all<{ id: string; work_card_id: string; from_address: string; subject: string }>()).results ?? [];
    for (const m of noGotIt) {
      await raiseUnreadMail(env, {
        dedupeKey: `partner_email_no_got_it:${m.id}`,
        title: `No "Got it" went to a partner within ${UNACKNOWLEDGED_MINUTES} minutes`,
        body: `From ${m.from_address.slice(0, 120)}, subject "${m.subject.slice(0, 120)}", on card ${m.work_card_id}. It was read and placed on the card, but no Got it has gone.`,
        objectId: m.id,
      });
      raised += 1;
    }
    const macSlow = (await env.WP_OS_DB.prepare(
      `SELECT e.object_id AS message_id, json_extract(e.payload_json, '$.session_card') AS card FROM event_record e JOIN work_card c ON c.id = json_extract(e.payload_json, '$.session_card')
        WHERE e.event_type = 'inbound_email.handed_off' AND e.created_at < ?1 AND e.created_at >= ?2 AND c.state NOT IN ('DONE', 'CANCELLED') LIMIT 10`,
    ).bind(late, day).all<{ message_id: string; card: string }>()).results ?? [];
    for (const m of macSlow) {
      await raiseUnreadMail(env, {
        dedupeKey: `inbound_email_mac_slow:${m.message_id}`,
        title: "The Mac has not read an email it took over",
        body: `Session card ${m.card} was handed an email the Worker could not read, and it has not finished after ${UNACKNOWLEDGED_MINUTES} minutes. The Mac may be asleep; no "Got it" has gone.`,
        objectId: m.message_id,
      });
      raised += 1;
    }
  } catch (err) {
    console.error("raising unacknowledged mail failed", err);
  }
  return raised;
}

// ── STEP 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface AskRow { id: string; seq: number; words: string; status: AskStatus | null; why: string | null }

const STATUS_WORDS: Record<AskStatus, string> = { DONE: "Done", IN_PROGRESS: "In progress", NOT_DONE: "Not done" };

function statusOf(s: unknown): AskStatus | null {
  const v = String(s ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "DONE") return "DONE";
  if (v === "IN_PROGRESS" || v === "INPROGRESS" || v === "STARTED") return "IN_PROGRESS";
  if (v === "NOT_DONE" || v === "NOTDONE" || v === "NOT") return "NOT_DONE";
  return null;
}

/** The runner's own report, when it gave one: `{"asks":[{"words","status","why"}]}` anywhere in what it finished with. */
export function reportedAsks(detail: string): Array<{ words: string; status: AskStatus; why: string }> {
  const at = detail.indexOf('{"asks"');
  const start = at >= 0 ? at : detail.search(/\{\s*"asks"\s*:/);
  if (start < 0) return [];
  for (let end = detail.lastIndexOf("}"); end > start; end = detail.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(detail.slice(start, end + 1)) as { asks?: Array<{ words?: string; status?: string; why?: string }> };
      return (parsed.asks ?? []).flatMap((a) => {
        const status = statusOf(a.status);
        return status && a.words && String(a.why ?? "").trim() ? [{ words: String(a.words), status, why: String(a.why).trim() }] : [];
      });
    } catch {
      // keep shortening until it parses
    }
  }
  return [];
}

/** The marking read, as fields checked at the AI boundary (22 Nov 2026, engineering sweep row 6). */
export const ASK_MARKS_OUTPUT = structuredOutput(
  "ask_marks",
  z.object({
    marks: z.array(z.object({ number: z.number().int().min(1), status: z.enum(["DONE", "IN_PROGRESS", "NOT_DONE"]), why: z.string() })),
  }),
);

function markPrompt(asks: AskRow[], detail: string): string {
  return [
    "A Managing Partner asked for the numbered things below. The work is finished; its report follows.",
    "For EACH number, say what happened, judged only from the report: DONE, IN_PROGRESS or NOT_DONE, and why (under 25 words, concrete). Every number.",
    "",
    ...asks.map((a, i) => `${i + 1}. ${a.words}`),
    "",
    "Report:",
    detail.slice(0, 15000),
  ].join("\n");
}

async function mark(env: Env, id: string, status: AskStatus, why: string): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE partner_ask SET status = ?2, why = ?3, marked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(id, status, why.slice(0, 400)).run();
}

export type AsksAtDone =
  | { ok: true; section: { label: string; bullets: string[] } | null; counts: Record<AskStatus, number> }
  | { ok: false; missing: string[]; seatWait?: boolean };

/** How a card waiting for a seat to mark its asks before the DONE says so (`waiting_for`); the session runner reads it. */
export const MARKING_SEAT_WAIT = "Waiting for a seat to mark each ask before the final reply";

/**
 * STEP 7's GUARD. Null asks = nothing to do (`section: null`). Otherwise every ask is marked from the report, then
 * by one confidential read; any still unmarked → the DONE is refused and the card is put back to work.
 */
export async function asksAtDone(
  env: Env,
  card: { id: string; title: string; owner_id: string | null; firm_scope: string; requested_by_email?: string | null },
  detail: string,
  read: SeatRead = confidentialSeatRead,
): Promise<AsksAtDone> {
  const empty = { DONE: 0, IN_PROGRESS: 0, NOT_DONE: 0 };
  // The DONE that reaches a partner is the one that must be complete; a duty card nobody emailed has no reply to guard.
  if (!partnerByEmail(card.requested_by_email)) return { ok: true, section: null, counts: empty };
  const load = async (): Promise<AskRow[]> =>
    (await env.WP_OS_DB.prepare("SELECT id, seq, words, status, why FROM partner_ask WHERE work_card_id = ?1 ORDER BY seq").bind(card.id).all<AskRow>()).results ?? [];
  let asks = await load();
  if (!asks.length) return { ok: true, section: null, counts: empty };

  for (const r of reportedAsks(detail)) {
    const hit = asks.find((a) => !a.status && (norm(a.words) === norm(r.words) || norm(a.words).includes(norm(r.words)) || norm(r.words).includes(norm(a.words))));
    if (hit) {
      await mark(env, hit.id, r.status, r.why);
      hit.status = r.status;
      hit.why = r.why;
    }
  }
  let open = asks.filter((a) => !a.status);
  let seatDown: string | null = null;
  if (open.length) {
    const out = await read(env, { prompt: markPrompt(open, detail), firmScope: card.firm_scope, employeeId: card.owner_id, purpose: "marking each of a partner's asks before the final reply", output: ASK_MARKS_OUTPUT });
    if (!out.ok) seatDown = out.detail || "no seat answered";
    if (out.ok) {
      for (const m of readStructured(ASK_MARKS_OUTPUT, out.text)?.marks ?? []) {
        const ask = open[m.number - 1];
        if (ask && !ask.status && m.why.trim()) await mark(env, ask.id, m.status, m.why.trim());
      }
    }
    asks = await load();
    open = asks.filter((a) => !a.status);
  }
  if (open.length && seatDown) {
    /*
     * NO SEAT ANSWERED THE MARKING READ (15 Nov 2026). That is seat trouble, not unfinished work: the same wait #442 gives
     * every card whose seat is busy or asleep. The claim's attempt is handed back and the card tries the DONE again by
     * itself in SEAT_WAIT_MINUTES, so a seat outage can never spend the three attempts and end in a Blocked card or a
     * Blocked note to the partner. Nothing is emailed.
     */
    const missing = open.map((a) => a.words);
    const { SEAT_WAIT_MINUTES } = await import("./blocks");
    const until = new Date(Date.now() + SEAT_WAIT_MINUTES * 60_000).toISOString();
    const line = `${MARKING_SEAT_WAIT} (${seatDown.slice(0, 160)}), so the final reply tries again by itself in about ${SEAT_WAIT_MINUTES} minutes.`;
    await env.WP_OS_DB.prepare(
      `UPDATE work_card SET state = 'IN_PROGRESS', lease_until = ?2, waiting_until = ?2, waiting_for = ?3, next_action = ?3,
              work_attempts = MAX(COALESCE(work_attempts, 1) - 1, 0), work_last_failure = ?3, work_last_failure_at = ?4
        WHERE id = ?1`,
    )
      .bind(card.id, until, line.slice(0, 400), new Date().toISOString())
      .run();
    await appendEvent(env, {
      eventType: "work_card.waiting_for_seat",
      actorType: "system",
      actorId: "partner_understood",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { at: new Date().toISOString(), until, marking_asks: missing.length, detail: seatDown.slice(0, 240) },
    }).catch(() => undefined);
    return { ok: false, missing, seatWait: true };
  }
  if (open.length) {
    const missing = open.map((a) => a.words);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', lease_until = NULL, next_action = ?2 WHERE id = ?1")
      .bind(card.id, `Before this is finished, say for each of these whether it is done, in progress or not done, and why: ${missing.map((w) => `"${w}"`).join("; ")}`.slice(0, 1500))
      .run();
    await appendEvent(env, {
      eventType: "partner_asks.done_refused",
      actorType: "system",
      actorId: "partner_understood",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { missing, asks: asks.length },
    }).catch(() => undefined);
    return { ok: false, missing };
  }
  const counts = { ...empty };
  for (const a of asks) counts[a.status!] += 1;
  return {
    ok: true,
    counts,
    section: { label: "Each thing you asked", bullets: asks.map((a) => `${STATUS_WORDS[a.status!]}: "${a.words}" — ${a.why ?? ""}`.trim()) },
  };
}

/** The DONE email when the card has asks and no composed email of its own. */
export function doneEmailWithAsks(
  asked: string,
  detail: string,
  asks: { section: { label: string; bullets: string[] }; counts: Record<AskStatus, number> },
  cardId: string,
): { what: string; tldr: string; tldrBullets: string[]; sections: Array<{ label: string; bullets: string[] }>; details: string | null } {
  const c = asks.counts;
  const parts = [c.DONE ? `${c.DONE} done` : null, c.IN_PROGRESS ? `${c.IN_PROGRESS} in progress` : null, c.NOT_DONE ? `${c.NOT_DONE} not done` : null].filter(Boolean).join(", ");
  const found = detail.split(/\r?\n/).map((l) => l.replace(/^[\s•\-*]+/, "").trim()).filter((l) => l && !l.startsWith('{"asks"')).slice(0, 8);
  return {
    what: `done — ${asked}`,
    tldr: `Finished: ${parts}. Each thing you asked is marked below.`,
    tldrBullets: [],
    sections: [
      asks.section,
      { label: "What I found", bullets: found.length ? found : ["The findings are on the card."] },
      { label: "Your call", bullets: ["Nothing, unless you want it taken further — reply and say how.", `Everything done on it is on the card: https://os.joinwestpeek.com/#/work (card ${cardId})`] },
    ],
    details: detail,
  };
}
