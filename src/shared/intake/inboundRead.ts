/**
 * EVERY EMAIL INTO THE OS IS READ FOR MEANING (owner, 17 Nov 2026, west-peek-ventures brain: "maybe every email incoming
 * to the OS should be read that way"). Word lists missed each new phrasing: Therabody's assistant ("please continue by
 * emailing partnerships@…") was closed as "no reply needed", Retool's ticket desk as "they are reviewing it", and
 * Pydantic's "now is not the right time for a partnership" as "they asked for nothing". A model reads each one with the
 * same fixed questions; the word lists are only the fallback when no model answers.
 *
 * Pure: the prompt and the strict parse. The worker asks the readers (services/inboundRead.ts); the CODE still checks
 * the hard parts (a redirect address is on the sender's own domain and in their words, NeverBounce clears it, a stop
 * from either reader is a stop, and nothing sends without her approval).
 */
import { z } from "zod/v4";

export const SENDER_KINDS = ["person", "helpdesk", "ai_assistant", "auto_reply", "system"] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

/**
 * THE ONE READ OF A REPLY, AS FIELDS (22 Nov 2026, engineering sweep row 5). Every reply the OS acts on is read by a
 * model into this shape: a brand's answer, her "approve" on a pause or draft email, a partner's "yes" to Porter's
 * hand-off question, a deadline in a partner's words. Code acts only on the fields, and only where the code's own hard
 * checks agree (her authenticated address, a redirect on the brand's own domain, the deadline's words really in the
 * email). An answer the model is not sure of is "unsure", and unsure never approves, sends or hands over: the email
 * that asked is asked again. The word lists read the words only when no model answered, and say so (NAMED STOP
 * INBOUND_NO_MODEL_READER).
 */
export const ANSWERS = ["yes", "no", "unsure", "not_an_answer"] as const;
export type ReplyAnswer = (typeof ANSWERS)[number];
export const INBOUND_READ_SHAPE = z.object({
  sender_kind: z.enum(SENDER_KINDS),
  asks: z.array(z.string()).describe("what they ask us for, each in their own words"),
  redirect_to: z.string().nullable().describe("the email address they tell us to write to instead, copied exactly from the email, or null"),
  wants_stop: z.boolean().describe("true if they ask us to stop emailing them, unsubscribe or remove them"),
  declines: z.boolean().describe("true if they say no to what we offered (not now, not a fit, pass)"),
  we_owe: z.string().describe('one line saying the reply or action we owe them, or "none"'),
  summary: z.string().describe("one line saying what the email says"),
  nothing_owed: z.enum(["passed_on", "reviewing", "no_ask", "owed"]).describe("why we owe nothing: they passed it on to someone, they are reviewing it, or they ask nothing; owed when we owe a reply"),
  intent: z.enum(["call", "yes", "question", "none"]).describe("what their reply wants from us: a call or meeting, a yes (send it, count us in, interested), a question, or none"),
  answer: z.enum(ANSWERS).describe("their answer to the question our email asked them (see What this email answers)"),
  items: z
    .array(z.object({ n: z.number().int(), action: z.enum(["approve", "skip", "change", "unsure"]), note: z.string().nullable() }))
    .describe("when our email listed numbered drafts: what they say for each number they mention (note: their change, in their words)"),
  all_items: z.enum(["approve", "skip", "none"]).describe("when they answer every listed draft at once (approve all, skip all), else none"),
  deadline: z
    .object({ words: z.string(), local: z.string().describe("YYYY-MM-DDTHH:MM, Central time") })
    .nullable()
    .describe("the deadline they set for the work, in their exact words, and when that is; null when they set none"),
});

export interface InboundRead {
  senderKind: SenderKind;
  /** What they ask us for, in their words. */
  asks: string[];
  /** An address they tell us to write to instead, as written in their message; null when none. */
  redirectTo: string | null;
  /** They ask us to stop emailing them (unsubscribe, remove me, do not contact). */
  wantsStop: boolean;
  /** They say no to what we offered. */
  declines: boolean;
  /** The reply or action we owe them, in one line; null when we owe nothing. */
  weOwe: string | null;
  summary: string;
  /** Why we owe nothing (brand replies), or null when we owe a reply. */
  nothingOwed: "PASSED_ON" | "REVIEWING" | "NO_ASK" | null;
  /** What a reply wants from us (brand replies). */
  intent: "CALL" | "YES" | "QUESTION" | null;
  /** Their answer to the question our email asked. */
  answer: ReplyAnswer;
  /** Per numbered draft, what they said. */
  items: Array<{ n: number; action: "approve" | "skip" | "change" | "unsure"; note: string | null }>;
  allItems: "approve" | "skip" | null;
  /** The deadline they set, as they wrote it, and that time as Central wall-clock (`YYYY-MM-DDTHH:MM`). */
  deadline: { words: string; local: string } | null;
  /** Who read it: CLAUDE, CODEX, WORKERS_AI, GEMINI, or WORD_LISTS when no model answered. */
  reader: string;
}

/** The reader name used when no model answered and the word lists decided. */
export const WORD_LISTS = "WORD_LISTS";
/** The named stop on every decision the word lists made because no model answered. */
export const NO_MODEL_READER = "INBOUND_NO_MODEL_READER";

const central = (now: Date): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);

export function inboundReadPrompt(input: { context: string; from: string; subject: string; words: string; now?: Date }): string {
  return [
    "You read one email that arrived at West Peek and answer in the JSON shape given below.",
    "sender_kind: person = a person wrote it; helpdesk = a person's answer sent through a ticket desk; ai_assistant = a",
    "company's AI assistant answered; auto_reply = an out-of-office or a machine acknowledgement (ticket received, we will",
    "get back to you) with no person's answer in it; system = a mail server, a notification or a form notice.",
    "we_owe is \"none\" when they only acknowledge, pass it on, say they will review it, or decline. An instruction to",
    "write to another address IS something we owe (redirect_to says where). Read only their words, never our own quoted email.",
    "answer: \"yes\" ONLY when they plainly say yes to the question our email asked (approve, yes, go ahead). A refusal, a",
    "negated or doubtful yes (\"I can't say yes to this\", \"not sure\", \"yes but wait\"), or a yes with a condition is",
    "\"no\" or \"unsure\"; when you cannot tell, \"unsure\". \"not_an_answer\" when they do not answer it at all.",
    "items: only for numbers they actually mention; \"unsure\" when you cannot tell what they want for that number.",
    "deadline: only a deadline for the work (\"by Monday morning\", \"today\", \"asap\"); words are copied exactly from",
    `their email; local is that time in Central (a day with no hour is 17:00; asap is two hours from now). Now is ${central(input.now ?? new Date())} Central.`,
    "",
    `What this email answers: ${input.context}`,
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    "Their words:",
    input.words.slice(0, 6000),
  ].join("\n");
}

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const INTENT = { call: "CALL", yes: "YES", question: "QUESTION", none: null } as const;

/** The model's answer, read strictly against the shape, or null (that reader failed). */
export function parseInboundRead(text: string, reader: string): InboundRead | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ""));
  if (!m) return null;
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return null; }
  const checked = INBOUND_READ_SHAPE.safeParse(raw);
  if (!checked.success) return null;
  const o = checked.data;
  const owe = o.we_owe.trim();
  const to = (o.redirect_to ?? "").trim().toLowerCase().replace(/^mailto:/, "").replace(/[.>]+$/, "");
  return {
    senderKind: o.sender_kind,
    asks: o.asks.map((a) => a.trim()).filter(Boolean).slice(0, 10),
    redirectTo: ADDRESS.test(to) ? to : null,
    wantsStop: o.wants_stop,
    declines: o.declines,
    weOwe: owe && !/^(?:none|nothing|n\/a|null|no)\.?$/i.test(owe) ? owe.slice(0, 300) : null,
    summary: o.summary.replace(/\s+/g, " ").trim().slice(0, 200),
    nothingOwed: o.nothing_owed === "owed" ? null : (o.nothing_owed.toUpperCase() as "PASSED_ON" | "REVIEWING" | "NO_ASK"),
    intent: INTENT[o.intent],
    answer: o.answer,
    items: o.items.filter((i) => i.n > 0 && i.n < 100).map((i) => ({ n: i.n, action: i.action, note: i.note?.trim() || null })),
    allItems: o.all_items === "none" ? null : o.all_items,
    deadline: o.deadline && o.deadline.words.trim() && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.deadline.local.trim()) ? { words: o.deadline.words.trim(), local: o.deadline.local.trim() } : null,
    reader,
  };
}

/** Who read it, in her words, for the line she sees. */
export function readerWords(reader: string): string {
  const named: Record<string, string> = { CLAUDE: "Claude", CODEX: "Codex", WORKERS_AI: "Workers AI", GEMINI: "Gemini", SEAT: "Claude or Codex" };
  return reader === WORD_LISTS ? `word lists (NAMED STOP ${NO_MODEL_READER}: no model answered)` : (named[reader] ?? reader);
}
