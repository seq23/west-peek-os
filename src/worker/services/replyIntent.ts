import type { Env } from "../env";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { INTAKE_JUDGMENT_STANDARD } from "../../shared/registry/aiEmployeePersonas";
import { changesTextOf, readApprovalReply, type ApprovalReading } from "../../shared/work/approvalReply";
import { MATERIALS_ADDED_PHRASE } from "../../shared/work/porterNotices";
import { PARTNER_ANSWER_MAX } from "../../shared/work/blocks";

/**
 * A PARTNER'S REPLY IS PERMISSION TO CONTINUE (owner, 27 Sep 2026).
 *
 * Her words, on the card that sat BLOCKED the night before the Sensori announcement: "why does it
 * even say it needs anyone? why is it blocked? … make sure it doesn't get blocked next time someone
 * replies to an email, it's basically permission. scooter also didn't use one of the 4 responses set
 * by porter, we need to figure out what to do in those cases."
 *
 * `readApprovalReply` reads the FIRST WORD: exact keywords ("approved", "publish", "changes: …") and
 * an explicit stop. Everything else used to fall to ANSWERS, and "No problem, looks great" started
 * with "no" and read as a REFUSAL. This module reads the WHOLE written half for its intent, in one
 * of three shapes, and the runner acts on the shape:
 *
 *   CONTINUE   go ahead — optionally with changes or answers to apply. Never blocks.
 *   STOP       an explicit stop/hold/"don't". The only intent that holds a card.
 *   QUESTION   the partner asks Porter something. Porter answers it in his next email; the work
 *              continues on the recommendations.
 *
 * THE KEYWORDS STAY A FAST PATH — no model call for "approved", "publish", "changes: …", "stop":
 * `keywordIntent` is pure and decides them the same way on Tuesday as on Monday. Only free text
 * reaches the model, through `runAi` (the repo's router and cost caps), mechanical and cheap.
 *
 * INJECTABLE, like `ActionabilityClassifier` and `QuestionAnswerer`: a test proves the ROUTING
 * (three intents → three outcomes) without a live call. FAILS OPEN TO CONTINUE: a model that cannot
 * be reached never blocks the card — the partner's words are carried into the build as instructions
 * and the card says so. Blocking on a model outage would recreate the defect this exists to close.
 */

export type ReplyIntentKind = "CONTINUE" | "STOP" | "QUESTION";

export interface ReplyIntent {
  kind: ReplyIntentKind;
  /** Instructions or answers to carry into the work, or null when the reply asks for nothing to change. */
  changes: string | null;
  /** The question the partner asked, when the reply is (or contains) one. */
  question: string | null;
  /** The keyword reading when the fast path decided it; null when the model did. */
  keyword: ApprovalReading["kind"] | null;
  /** KEYWORD: the pure fast path. MODEL: the read of the whole text. FALLBACK: the model was unavailable or unreadable. */
  source: "KEYWORD" | "MODEL" | "FALLBACK";
  reason: string;
  aiRunId: string | null;
}

export type ReplyIntentReader = (env: Env, input: { cardId: string; firmScope: string; text: string }) => Promise<ReplyIntent>;

/** The keyword fast path. Null when the words are free text and the whole reply must be read. Pure. */
export function keywordIntent(text: string): ReplyIntent | null {
  const trimmed = (text ?? "").trim();
  const reading = readApprovalReply(trimmed);
  const base = { question: null, aiRunId: null, source: "KEYWORD" as const, keyword: reading.kind };
  switch (reading.kind) {
    case "APPROVED":
    case "PREVIEW":
    case "FORCED":
    case "PUBLISH":
      return { ...base, kind: "CONTINUE", changes: null, reason: `the keyword "${reading.kind.toLowerCase()}"` };
    case "CHANGES":
      return { ...base, kind: "CONTINUE", changes: changesTextOf(reading.text) || reading.text, reason: "\"changes: …\" — instructions to apply" };
    case "REFUSED":
      return { ...base, kind: "STOP", changes: null, reason: trimmed ? `an explicit stop: "${trimmed.slice(0, 60)}"` : "an empty reply" };
    case "ANSWERS":
      break;
  }
  // Two phrases the doors write themselves, never a partner's free text.
  if (/^Attached: [^\n]+$/.test(trimmed)) return { ...base, kind: "CONTINUE", changes: null, reason: "files arrived with the reply" };
  if (trimmed.replace(/[.!]+$/, "").toLowerCase() === MATERIALS_ADDED_PHRASE.toLowerCase()) return { ...base, kind: "CONTINUE", changes: null, reason: "the materials-added phrase" };
  if (reportsAFault(trimmed)) {
    return { ...base, kind: "CONTINUE", changes: `${FAULT_PREFIX}${trimmed.slice(0, PARTNER_ANSWER_MAX - FAULT_PREFIX.length)}`, reason: "the partner reports that something Porter built does not work" };
  }
  return null;
}

/**
 * A REPORT THAT SOMETHING DOES NOT WORK IS A FIX, NEVER A QUESTION (13 Nov 2026). Scooter forwarded a
 * screenshot of the preview's dashboard refusing his sign-in: "i tried accessing the dashboard and got
 * the screenshot below. can you resend the link with the password". The reader called it a QUESTION
 * and Porter answered "Here is where it stands. The preview is at …" — the link that had just failed
 * him. A partner telling Porter that what he built errors, refuses him or will not open is
 * instructions to fix it: carried as CHANGES, so at the preview it rebuilds. Pure; no model call.
 */
export const FAULT_PREFIX = "Fix what the partner reports does not work, in his words: ";
const FAULT_WORDS = [
  /\b(?:does ?n[o']t|does not|is ?n[o']t|is not|not|never|wo ?n[o']t|will not|ca ?n[o']t|cannot|could ?n[o']t|could not|did ?n[o']t|did not) (?:work|working|load|loading|open|opening|let me|show|showing)\b/i,
  /\b(?:ca ?n[o']t|cannot|could ?n[o']t|could not|unable to) (?:access|get in|get into|sign in|log ?in|open|see|reach)\b/i,
  /\b(?:i|we) (?:keep|kept) (?:getting|seeing|hitting)\b/i,
  /\b(?:got|get|getting|see|seeing|shows?|showing|hit|hitting) (?:this|that|an|the|a) (?:error|screenshot|screen|message)\b/i,
  /\b(?:an? |this |that |the )?error (?:message|page|screen|says|saying)\b/i,
  /\b(?:was|were|got|keeps? being|is being) (?:refused|rejected|blocked|denied)\b/i,
  /\b(?:it'?s|is|looks|seems) broken\b/i,
];
export function reportsAFault(text: string | null | undefined): boolean {
  const t = (text ?? "").replace(/\s+/g, " ");
  return FAULT_WORDS.some((re) => re.test(t));
}

/** What the model must answer with, read strictly. Anything unreadable is a CONTINUE with the words carried. */
export function parseReplyIntent(outputText: string | null | undefined, text: string): Omit<ReplyIntent, "aiRunId" | "keyword"> {
  const out = (outputText ?? "").trim();
  const intent = /INTENT:\s*(CONTINUE|STOP|QUESTION)/i.exec(out);
  const field = (name: string): string | null => {
    const m = new RegExp(`${name}:\\s*([^\\n]*(?:\\n(?!(?:INTENT|CHANGES|QUESTION|REASON):)[^\\n]*)*)`, "i").exec(out);
    const v = (m?.[1] ?? "").trim();
    return !v || /^(none|n\/a|-|null|no)\.?$/i.test(v) ? null : v.slice(0, PARTNER_ANSWER_MAX);
  };
  if (!intent) {
    return { kind: "CONTINUE", changes: text.trim().slice(0, PARTNER_ANSWER_MAX) || null, question: null, source: "FALLBACK", reason: out ? `could not read the intent — carried on with the words as instructions. Raw: "${out.slice(0, 120)}"` : "the reader returned nothing — carried on with the words as instructions" };
  }
  const kind = intent[1]!.toUpperCase() as ReplyIntentKind;
  const changes = field("CHANGES");
  const question = field("QUESTION");
  const reason = field("REASON") ?? "(no reason given)";
  if (kind === "QUESTION" && !question) return { kind, changes, question: text.trim().slice(0, PARTNER_ANSWER_MAX), source: "MODEL", reason };
  return { kind, changes, question, source: "MODEL", reason: reason.slice(0, 400) };
}

/** THE DEFAULT READER — one fast, cheap, mechanical model call through the firm's router. */
export const defaultReadReplyIntent: ReplyIntentReader = async (env, input) => {
  const actor: Actor = { type: "AI", aiEmployeeId: "aie_porter", roles: [], firmScopes: [input.firmScope] };
  let run: Awaited<ReturnType<typeof runAi>>["run"];
  try {
    run = (
      await runAi(env, {
        purpose: "reading whether a partner's reply to Porter means go ahead, stop, or a question",
        actor,
        inputs: [
          `${INTAKE_JUDGMENT_STANDARD}\n\n` +
            "A Managing Partner replied to an email from Porter about a website change Porter is building for them. " +
            "Porter had proposed a plan (or sent a preview) with his recommendations. Decide what the reply MEANS:\n\n" +
            "CONTINUE — go ahead. Includes agreement in any words (\"No problem, looks great\", \"all good\", \"fine by me\"), " +
            "and go-ahead WITH instructions, corrections or answers to apply (\"looks good but make the hero the group shot\"). " +
            "A long email full of instructions is CONTINUE with those instructions as CHANGES.\n" +
            "STOP — an explicit stop, hold, or \"don't\": the partner does not want anything built or landed right now.\n" +
            "QUESTION — the partner is asking Porter something and wants an answer (may also carry instructions; put those in CHANGES).\n\n" +
            "A report that something Porter built does not work (an error, a refused sign-in, a page that will not open, a screenshot of a problem), " +
            "or a request to fix or resend it, is CONTINUE with CHANGES = fix what they reported, in their words — never a QUESTION.\n" +
            "BIAS HARD TOWARD CONTINUE. A reply is permission unless it plainly says to stop. Only answer STOP when the words " +
            "clearly say to hold or not proceed. Only answer QUESTION when there is a real question addressed to Porter that " +
            "needs an answer — a rhetorical or answered-in-the-same-breath question is not one.\n\n" +
            `THE REPLY, what the partner wrote above the quote:\n"""\n${input.text.slice(0, PARTNER_ANSWER_MAX)}\n"""\n\n` +
            "Answer in exactly this format and nothing else:\n" +
            "INTENT: CONTINUE|STOP|QUESTION\n" +
            "CHANGES: <the instructions, corrections or answers to apply, in the partner's own words, or none>\n" +
            "QUESTION: <the question asked, or none>\n" +
            "REASON: <one short sentence>",
        ],
        sensitivity: "INTERNAL" as never,
        // Mechanical and cheap on purpose: a few labelled lines back.
        budgetContext: { mechanical: true, expectedOutputTokens: 300 },
        routing: { category: "OPERATIONS", taskClass: "reply-intent", workCardId: input.cardId },
      })
    ).run;
  } catch (err) {
    return { kind: "CONTINUE", changes: input.text.trim().slice(0, PARTNER_ANSWER_MAX) || null, question: null, keyword: null, source: "FALLBACK", reason: `the reader could not run (${err instanceof Error ? err.message : String(err)}) — carried on with the words as instructions`, aiRunId: null };
  }
  if (run.status !== "COMPLETED" || !run.output_text) {
    return { kind: "CONTINUE", changes: input.text.trim().slice(0, PARTNER_ANSWER_MAX) || null, question: null, keyword: null, source: "FALLBACK", reason: `the reader was unavailable (${run.failure_reason ?? run.status}) — carried on with the words as instructions`, aiRunId: run.id };
  }
  return { ...parseReplyIntent(run.output_text, input.text), keyword: null, aiRunId: run.id };
};

/** Keyword first (pure, free), then the reader for free text. */
export async function readReplyIntent(env: Env, input: { cardId: string; firmScope: string; text: string }, reader: ReplyIntentReader = defaultReadReplyIntent): Promise<ReplyIntent> {
  return keywordIntent(input.text) ?? (await reader(env, input));
}
