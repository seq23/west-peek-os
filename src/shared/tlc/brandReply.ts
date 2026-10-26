/**
 * A BRAND ANSWERED (owner, 26 Oct 2026). Wynn's duty: read the answer, and either
 *   - an out-of-office / auto-reply  → the drip resumes the day after they are back (no email to anybody),
 *   - a "no"                          → the deal is DECLINED and nothing more goes,
 *   - anything else (a real reply)    → Wynn drafts Sequoia's answer and it waits for her in ONE approval email
 *                                       a day, with their message and the draft word for word.
 * Pure: the worker stores, drafts and sends.
 */
import { TLC_TIERS, TLC_TIER_KEYS, replyLooksLikeNo } from "./learningClub";

export const BRAND_REPLY_REF_RE = /\bTLR-[A-Z0-9]{6}\b/;
export const BRAND_REPLY_ASK = "Reply approved to send, or reply with changes";

export type BrandReplyIntent = "QUESTION" | "CALL" | "YES";
export type BrandReplyClass =
  | { kind: "AUTO_REPLY"; resumeAt: string }
  | { kind: "NO" }
  | { kind: "REPLY"; intent: BrandReplyIntent };

const AUTO_SUBJECT = /\b(out of (?:the )?office|automatic reply|auto[- ]?reply|autoreply|away from (?:the |my )?(?:office|desk)|on (?:annual |parental |maternity |paternity )?leave|on vacation|on holiday|ooo)\b/i;
const AUTO_BODY = /\b(i am|i'm|i will be|i'll be) (?:currently )?(?:out of (?:the )?office|away|on (?:annual |parental |maternity |paternity )?leave|on vacation|on holiday|travelling|traveling)\b|\b(?:limited|no) access to (?:my )?e-?mail\b|\bthis is an automatic reply\b|\bauto(?:matic|mated)? (?:reply|response)\b|\b(?:i will|i'll) (?:respond|reply|get back to you) (?:when|once|upon) (?:i return|my return|i'm back|i am back)\b/i;

/** Their words, and only theirs: a quoted original under "On … wrote:" is cut off. */
export function theirNewText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const next = (lines[i + 1] ?? "").trim();
    if (/^>/.test(line)) break;
    // Gmail's "On Sun, Oct 25, 2026 at 5:14 PM Name <address>" wraps "wrote:" onto the next line.
    if (/^On .+wrote:?$/i.test(line) || (/^On .+\d{4}/.test(line) && /^(.*\s)?wrote:?$/i.test(next))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^From: .+/.test(line)) break;
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "back on Monday, 2 November", "returning Nov 2", "until 11/02": the first date after `now`, at 14:00 UTC. */
export function returnDateIn(text: string, now: Date): Date | null {
  const t = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const cue = /(?:back|return(?:ing)?|returns|until|through|till|resume|in the office)\b[^.\n]{0,60}/g;
  for (const m of t.matchAll(cue)) {
    const s = m[0];
    let month = -1;
    let day = -1;
    const md = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(s);
    const dm = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(s);
    const num = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(s);
    if (md) { month = MONTHS.indexOf(md[1]!); day = Number(md[2]); }
    else if (dm) { month = MONTHS.indexOf(dm[2]!); day = Number(dm[1]); }
    else if (num) { month = Number(num[1]) - 1; day = Number(num[2]); }
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const d = new Date(Date.UTC(year, month, day, 14, 0, 0));
      if (d.getTime() > now.getTime() - 86_400_000) return d;
    }
  }
  return null;
}

export function classifyBrandReply(input: { subject: string; text: string }, now: Date): BrandReplyClass {
  const words = theirNewText(input.text);
  if (AUTO_SUBJECT.test(input.subject) || AUTO_BODY.test(words)) {
    const back = returnDateIn(words, now);
    // Resume the day after they are back; with no date in the message, a week from now.
    const resume = back ? new Date(back.getTime() + 86_400_000) : new Date(now.getTime() + 7 * 86_400_000);
    return { kind: "AUTO_REPLY", resumeAt: resume.toISOString() };
  }
  if (replyLooksLikeNo(input.subject) || replyLooksLikeNo(words)) return { kind: "NO" };
  if (/\b(call|chat|meet|meeting|zoom|calendly|hop on|talk|speak|connect live|time next week|availability|available)\b/i.test(words)) return { kind: "REPLY", intent: "CALL" };
  if (/\b(send (?:it|me|over|more|the deck|the pitch|details)|deck|one[- ]?pager|pdf|deal sheet|pricing sheet|sponsorship (?:deck|packet|kit)|we(?:'re| are) interested|sounds (?:great|interesting|good)|count us in|we(?:'d| would) love to|let'?s do it|yes)\b/i.test(words)) return { kind: "REPLY", intent: "YES" };
  return { kind: "REPLY", intent: "QUESTION" };
}

/** Where the deal moves when her answer goes: a call is a call; a yes is on its way to one; a question stays pitched. */
export function stageAfterReply(intent: BrandReplyIntent, from: string): string | null {
  if ((intent === "CALL" || intent === "YES") && (from === "PROSPECT" || from === "PITCHED")) return "CALL";
  return null;
}

/** The tiers and prices, from the one table, as a brand reads them. */
export function tierLines(): string[] {
  return TLC_TIER_KEYS.map((k) => {
    const t = TLC_TIERS[k];
    return `${t.label}${t.priceUsd ? `, $${t.priceUsd.toLocaleString("en-US")}` : ""}: ${t.gets}`;
  });
}

export interface ReplyDraftInput {
  intent: BrandReplyIntent;
  brand: string;
  contactName: string | null;
  topic: string;
  month: string;
  why: string | null;
  theirText: string;
  pitchUrl: string | null;
  callLink: string | null;
}

/** The answer when the model is unavailable: plain, short, true, and in her voice. Signature added after. */
export function fallbackReplyBody(i: ReplyDraftInput, monthWords: (m: string) => string): string {
  const hi = i.contactName ? `Hi ${i.contactName.split(" ")[0]},` : "Hi,";
  const call = i.callLink ? `If it is easier to talk it through, pick a time that suits you: ${i.callLink}` : "Would a short call next week be easiest? Send me two times that suit you and I will send an invitation.";
  if (i.intent === "CALL") return [hi, "", "Thank you for coming back to me. I would love to talk it through.", "", call].join("\n");
  if (i.intent === "YES") {
    return [hi, "", `Thank you for coming back to me. Here is the one-page pitch for The Learning Club: ${i.topic}, in ${monthWords(i.month)}. The PDF is attached${i.pitchUrl ? `, and it is also here: ${i.pitchUrl}` : "."}`, "", call].join("\n");
  }
  return [
    hi,
    "",
    `Thank you for coming back to me. The Learning Club is a small, hands-on room in New York: in ${monthWords(i.month)} the club is ${i.topic}, and guests spend the evening making something with their own hands.`,
    "",
    "What I have in mind is a partnership at one of these levels, shaped around what your team wants from the room:",
    ...tierLines().map((l) => `- ${l}`),
    "",
    call,
  ].join("\n");
}
