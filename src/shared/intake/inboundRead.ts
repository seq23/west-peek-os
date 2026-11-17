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
export const SENDER_KINDS = ["person", "helpdesk", "ai_assistant", "auto_reply", "system"] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];

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
  /** Who read it: CLAUDE, CODEX, WORKERS_AI, GEMINI, or WORD_LISTS when no model answered. */
  reader: string;
}

/** The reader name used when no model answered and the word lists decided. */
export const WORD_LISTS = "WORD_LISTS";
/** The named stop on every decision the word lists made because no model answered. */
export const NO_MODEL_READER = "INBOUND_NO_MODEL_READER";

export function inboundReadPrompt(input: { context: string; from: string; subject: string; words: string }): string {
  return [
    "You read one email that arrived at West Peek. Answer ONLY with one JSON object, no prose, with exactly these keys:",
    '{"sender_kind": "person" | "helpdesk" | "ai_assistant" | "auto_reply" | "system",',
    ' "asks": [what they ask us for, each in their own words],',
    ' "redirect_to": the email address they tell us to write to instead, copied exactly from the email, or null,',
    ' "wants_stop": true if they ask us to stop emailing them, unsubscribe or remove them, else false,',
    ' "declines": true if they say no to what we offered (not now, not a fit, pass), else false,',
    ' "we_owe": one line saying the reply or action we owe them, or "none",',
    ' "summary": one line saying what the email says}',
    "",
    "sender_kind: person = a person wrote it; helpdesk = a person's answer sent through a ticket desk; ai_assistant = a",
    "company's AI assistant answered; auto_reply = an out-of-office or a machine acknowledgement (ticket received, we will",
    "get back to you) with no person's answer in it; system = a mail server, a notification or a form notice.",
    "we_owe is \"none\" when they only acknowledge, pass it on, say they will review it, or decline. An instruction to",
    "write to another address IS something we owe (redirect_to says where). Read only their words, never our own quoted email.",
    "",
    `What this email answers: ${input.context}`,
    `From: ${input.from}`,
    `Subject: ${input.subject}`,
    "Their words:",
    input.words.slice(0, 6000),
  ].join("\n");
}

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/** The model's answer, read strictly: a JSON object with a known sender_kind, or null (that reader failed). */
export function parseInboundRead(text: string, reader: string): InboundRead | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ""));
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const kind = String(o.sender_kind ?? "").trim().toLowerCase();
  if (!(SENDER_KINDS as readonly string[]).includes(kind)) return null;
  const bool = (v: unknown) => v === true || String(v).toLowerCase() === "true";
  const owe = typeof o.we_owe === "string" ? o.we_owe.trim() : "";
  const to = typeof o.redirect_to === "string" ? o.redirect_to.trim().toLowerCase().replace(/^mailto:/, "").replace(/[.>]+$/, "") : "";
  return {
    senderKind: kind as SenderKind,
    asks: Array.isArray(o.asks) ? o.asks.map((a) => String(a ?? "").trim()).filter(Boolean).slice(0, 10) : [],
    redirectTo: ADDRESS.test(to) ? to : null,
    wantsStop: bool(o.wants_stop),
    declines: bool(o.declines),
    weOwe: owe && !/^(?:none|nothing|n\/a|null|no)\.?$/i.test(owe) ? owe.slice(0, 300) : null,
    summary: String(o.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    reader,
  };
}

/** Who read it, in her words, for the line she sees. */
export function readerWords(reader: string): string {
  const named: Record<string, string> = { CLAUDE: "Claude", CODEX: "Codex", WORKERS_AI: "Workers AI", GEMINI: "Gemini", SEAT: "Claude or Codex" };
  return reader === WORD_LISTS ? `word lists (NAMED STOP ${NO_MODEL_READER}: no model answered)` : (named[reader] ?? reader);
}
