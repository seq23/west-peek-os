/**
 * A BRAND ANSWERED (owner, 26 Oct 2026). Wynn's duty: read the answer, and either
 *   - an out-of-office / auto-reply  → the drip resumes the day after they are back (no email to anybody),
 *   - a "no"                          → the deal is DECLINED and nothing more goes,
 *   - anything else (a real reply)    → Wynn drafts Sequoia's answer and it waits for her in ONE approval email
 *                                       a day, with their message and the draft word for word.
 * Pure: the worker stores, drafts and sends.
 */
import { TLC_SAMPLES_OFFER, TLC_TIERS, TLC_TIER_KEYS, replyLooksLikeNo } from "./learningClub";

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

/**
 * Where the deal moves when her answer goes. A call the BRAND asked for is a call. Nothing else moves it to CALL
 * (owner, 26 Oct 2026): Wynn never asks for one, so a yes or a question stays where it is until they propose one.
 */
export function stageAfterReply(intent: BrandReplyIntent, from: string): string | null {
  if (intent === "CALL" && (from === "PROSPECT" || from === "PITCHED")) return "CALL";
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

/**
 * WYNN'S STANDING RULES, AS THE DRAFT READS THEM (owner, 26 Oct 2026). Rows of `tlc_wynn_rule`; `code` marks the
 * ones the code enforces as well as the prompt.
 */
export interface WynnRule { code: string | null; rule: string }
export const NO_MONEY_EARLY = "NO_MONEY_EARLY";
/** The rule whose text IS the facts of who we are; the prompt and the fallback both read that one row. */
export const WHO_WE_ARE = "WHO_WE_ARE";
/** Wynn never suggests or asks for a call; the brand may propose one. Deals close over email. */
export const NO_CALL_ASK = "NO_CALL_ASK";
/** The default next step when Wynn may not ask for a call (her NO_CALL_ASK rule); one text with the drip's email 2. */
export const THREE_THINGS_OFFER = TLC_SAMPLES_OFFER;
/** We host every segment or bring in a host; a brand never has to send a rep or speaker unless it wants to. */
export const WE_HOST = "WE_HOST";
/** A draft that puts a brand's people on the hook for a segment ("your team leads X", "send a speaker"). */
export const BRAND_MUST_STAFF = /\byour (?:team|people|staff|experts?|reps?|founder)\s+(?:will\s+)?(?:leads?|runs?|hosts?|presents?|teach(?:es)?|demos?|walks?)\b|\b(?:send|bring|provide)\s+(?:a|an|your|one of your)\s+(?:rep|representative|speaker|presenter|host|expert)s?\b/i;
/** A draft asking for a call (or a time, or a calendar slot) the brand did not propose. */
export const CALL_ASK = /\b(?:(?:a |the )?(?:quick |short |brief )?(?:call|zoom|phone call|video call)\b(?! you (?:asked|proposed|suggested))|hop on|jump on|book a time|pick a time|times? that suits?|calendar link|calendly)\b/i;
/** Before a call has happened: the stages in which the no-money rule holds. */
export const BEFORE_A_CALL: readonly string[] = ["PROSPECT", "PITCHED", "CALL"];

export function noMoneyNow(rules: readonly WynnRule[], stage: string): boolean {
  return rules.some((r) => r.code === NO_MONEY_EARLY) && BEFORE_A_CALL.includes(stage);
}

/** Money words in a draft: a price, a dollar amount, a budget or a partnership tier. */
export const MONEY_WORDS = /\$\s?\d|\b\d[\d,.]*\s?(?:k|usd|dollars)\b|\b(?:price|prices|pricing|priced|cost|costs|budget|budgets|fee|fees|rate card|tier|tiers|title partner|presenting partner|lead partner|sponsorship levels?|partnership levels?)\b/i;

/**
 * HER WHOLE NOTE, AND ONLY HERS (owner, 26 Oct 2026). Her note on TLR-EL84CT was cut at 600 characters, which
 * dropped her last instructions (research, a report, a new draft). The quoted email is already gone (newTextOf);
 * this takes off her signature and phone footer, and nothing else. NOTE_MAX is a guard against a pasted thread,
 * not a limit on her: past it the note says where it was cut, never silently.
 */
export const NOTE_MAX = 8000;
export function herNoteOf(said: string, ownerName: string): string {
  const first = ownerName.split(/\s+/)[0] ?? ownerName;
  const lines = said.replace(/\r\n/g, "\n").split("\n");
  const sig = lines.findIndex((l) => /^\s*(?:--|—|__)\s*$/.test(l) || /^\s*Sent from my\b/i.test(l) || new RegExp(`^\\s*(?:${first}|${ownerName}|ST)\\s*$`, "i").test(l));
  const kept = (sig >= 0 ? lines.slice(0, sig) : lines).join("\n").trim()
    // A sign-off on its own last line ("Thanks," / "Best,") is not an instruction.
    .replace(/\n\s*(?:thanks|thank you|best|cheers|xx?o?|regards|warmly)[,!.]?\s*$/i, "")
    .trim();
  return kept.length <= NOTE_MAX ? kept : `${kept.slice(0, NOTE_MAX)}\n[… her note was cut here at ${NOTE_MAX.toLocaleString("en-US")} of ${kept.length.toLocaleString("en-US")} characters; the whole note is on the reply row]`;
}

/** She asked Wynn to find something out before he writes again. */
export function wantsResearch(note: string): boolean {
  return /\b(?:research|report|look into|look up|find out|dig into|figure out|investigate)\b/i.test(note);
}

/**
 * THE STANDING PARTS OF A NOTE. A sentence that tells Wynn how to behave in general (don't…, never…, always…,
 * no…, lead with…, from now on…) is kept as one of his rules for every later draft; a sentence about this brand
 * alone is followed in this draft and not kept.
 */
const STANDING_CUE = /\b(?:don'?t|do not|never|always|no more|stop|avoid|from now on|going forward|in future|every time|lead with|make sure|i prefer)\b/i;
export function standingRulesIn(note: string): string[] {
  const sentences = note.replace(/\s+/g, " ").split(/(?<=[.!?;])\s+|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  return [...new Set(sentences.filter((x) => STANDING_CUE.test(x) && x.length >= 12 && x.length <= 400).map((x) => x.replace(/[;]$/, "")))];
}

export interface ResearchReport { care: string[]; value: string[]; sources: Array<{ title: string; url: string }> }

/** Wynn's research answer, read strictly: at least one point in each part and one real source, or nothing. */
export function readResearch(raw: Record<string, unknown> | null): ResearchReport | null {
  if (!raw) return null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 6) : []);
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .map((x) => (x && typeof x === "object" ? { title: String((x as Record<string, unknown>).title ?? "").trim(), url: String((x as Record<string, unknown>).url ?? "").trim() } : { title: "", url: "" }))
    .filter((x) => /^https?:\/\/\S+$/.test(x.url))
    .slice(0, 8);
  const r = { care: list(raw.care), value: list(raw.value), sources };
  return r.care.length && r.value.length && r.sources.length ? r : null;
}

/** The short plain report that goes ABOVE the new draft in her approval email. */
export function reportText(brand: string, r: ResearchReport): string {
  return [
    `WYNN'S REPORT ON ${brand.toUpperCase()} (you asked for research)`,
    "",
    "What they care about now",
    ...r.care.map((x) => `- ${x}`),
    "",
    "The value we bring them",
    ...r.value.map((x) => `- ${x}`),
    "",
    "Sources",
    ...r.sources.map((x) => `- ${x.title || x.url}: ${x.url}`),
  ].join("\n");
}

/** The answer when the model is unavailable: plain, short, true, and in her voice. Signature added after. */
export function fallbackReplyBody(i: ReplyDraftInput, monthWords: (m: string) => string, opts: { noMoney?: boolean; whoWeAre?: string | null; noCallAsk?: boolean } = {}): string {
  const hi = i.contactName ? `Hi ${i.contactName.split(" ")[0]},` : "Hi,";
  // Her NO_CALL_ASK rule: the next step is the offer of three things, never a call Wynn asks for.
  const call = opts.noCallAsk
    ? THREE_THINGS_OFFER
    : i.callLink ? `If it is easier to talk it through, pick a time that suits you: ${i.callLink}` : "Would a short call next week be easiest? Send me two times that suit you and I will send an invitation.";
  // They proposed the call: she says yes to it (their proposal, not Wynn's ask).
  const theirCall = i.callLink ? `Happy to talk. Here is my calendar, pick whatever suits you: ${i.callLink}` : "Happy to talk. Send me the times that suit you and I will send an invitation.";
  if (i.intent === "CALL") return [hi, "", "Thank you for coming back to me.", "", opts.noCallAsk ? theirCall : call].join("\n");
  if (i.intent === "YES") {
    return [hi, "", `Thank you for coming back to me. Here is the one-page pitch for The Learning Club: ${i.topic}, in ${monthWords(i.month)}. The PDF is attached${i.pitchUrl ? `, and it is also here: ${i.pitchUrl}` : "."}`, "", call].join("\n");
  }
  if (opts.noMoney) {
    return [
      hi,
      "",
      "Thank you for coming back to me.",
      ...(opts.whoWeAre ? [`A little about us: ${opts.whoWeAre}`] : []),
      `In ${monthWords(i.month)} (the month may move, and the club may repeat) the club is ${i.topic}: a small, hands-on room where guests spend the evening making something with their own hands. We would love to partner with you to build something special around it.`,
      "",
      "Who are the people you most want to reach? I would love to explore together how we reach them.",
      "",
      call,
    ].join("\n");
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
