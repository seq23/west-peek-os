import { partnerByName, type Partner } from "../registry/partners";

/**
 * Reading "tell a partner something" at the door (22 Sep 2026).
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * Today Sequoia needed Walker to send Scooter a short follow-up — "here's the candidate's email,
 * here's what's fixed" — and there was no card kind whose entire job was that. Every existing
 * partner-email path only fires as a side effect of an employee finishing a specific TYPED card
 * with its own declared step list (WEB_PROPERTY_CHANGE, PRODUCTIONS_HIRE_SEARCH, BLOG_HELP…). The
 * engineer ended up hand-writing a one-off script that replicated `filePreview()`'s token-minting
 * and DB-insert logic outside the app entirely — real, but exactly the kind of thing that should
 * never be necessary twice. `PARTNER_MESSAGE` is the card kind whose whole job is this: an employee,
 * named, tells a partner, named, something short — composed by the employee, filed through the
 * SAME `filePreview()`/`sendOrPreview()` door every other partner email already uses.
 *
 * ─── THE SHAPE OF THE ASK, AND WHY IT IS PURE AND DETERMINISTIC ───────────────────────────────────
 *
 * "Walker, tell Scooter: here's the candidate's email, here's what's fixed." — the employee first,
 * a comma, "tell", the partner, a colon, then whatever she wants said. Read like `parseBlogAsk` and
 * `parseWebPropertyAsk`: a word-shape a partner can learn and repeat, not a model asked to guess
 * what an email means differently on different days.
 *
 * THE PARTNER MUST RESOLVE AGAINST THE REGISTRY, OR THIS IS NOT A MATCH AT ALL. `partnerByName`
 * only ever returns one of the two Managing Partners or null — never an arbitrary address. A
 * sentence naming somebody who is not Scooter or Sequoia is not a partner-message ask; it falls
 * through to the ordinary assignment card, same as any other prose the door cannot place.
 *
 * THE EMPLOYEE NAME IS RETURNED RAW. Whether it names a real, ACTIVE employee is a database
 * question the door (`dealIntake.ts`) and the duty executor (`services/partnerMessage.ts`) answer,
 * never this file — a card naming a non-existent or inactive employee still opens (or the
 * assignment card it came from stays exactly where it was), so a typo fails closed with a clear
 * reason on the card rather than vanishing at the parser.
 */

export interface PartnerMessageAsk {
  /** As typed — "Walker", "walker", "aie_walker" all pass through unresolved. */
  employeeName: string;
  /** Resolved from the registry. Never an arbitrary address. */
  partner: Partner;
  /** Everything after the colon, trimmed. What the employee is being asked to say. */
  instruction: string;
}

const MAX_INSTRUCTION_CHARS = 4000;

const PATTERN = /^\s*([A-Za-z][A-Za-z'.-]*)\s*,\s*tell\s+([A-Za-z][A-Za-z'.\- ]*?)\s*:\s*([\s\S]+?)\s*$/i;

function matchOne(text: string): PartnerMessageAsk | null {
  const m = PATTERN.exec((text ?? "").trim());
  if (!m) return null;
  const employeeName = m[1]!.trim();
  const partner = partnerByName(m[2]!.trim());
  const instruction = m[3]!.trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!partner || !instruction) return null;
  return { employeeName, partner, instruction };
}

/**
 * Null when this is not a partner-message ask. Otherwise the employee (raw), the partner (resolved
 * from the registry) and the instruction.
 *
 * TRIES THE BODY FIRST, THEN THE SUBJECT — the ordinary shape is a partner typing the whole thing
 * as the body of a short email; a partner who instead puts it in the subject line is still read.
 * The two are tried separately, never concatenated: a subject like "Fwd: Q3 numbers" ahead of a
 * body that happens to start "Walker, tell Scooter: …" must not have the unrelated subject text
 * swallowed into the instruction, and a `^`-anchored pattern over a concatenated string would do
 * exactly that.
 */
export function parsePartnerMessageAsk(subject: string, body: string): PartnerMessageAsk | null {
  return matchOne(body) ?? matchOne(subject);
}

/**
 * THE CARD TITLE — AND SO THE EMAIL SUBJECT — FOR A PARTNER MESSAGE (9 Oct 2026, card wc_222a10a1).
 *
 * The title used to be the first LINE of "Tell Scooter: <instruction>", cut at 90 characters. A
 * plain-text email body is hard-wrapped at ~70 columns, so the first line ended wherever the mail
 * client wrapped it, and the subject went out as "Porter: Tell Scooter: Sequoia asked me to pass
 * along a note — nothing" — cut mid-sentence, with no sign it had been cut.
 *
 * CHOSEN: the first clause of her own message, not a fixed "a note from Sequoia for Scooter". The
 * fixed form reads politely but tells the reader nothing, and every message would share one
 * subject; her first clause says what the note is about. The wrap is undone first (all whitespace
 * collapsed), then the first sentence is kept; when that is too long it is cut at the last clause
 * boundary (" — ", "; ", ", ", ": ") that fits, else the last whole word, and "…" marks the cut.
 * Never mid-word, never a silent cut.
 *
 * `max` defaults to 60 so "<Employee>: " plus the title stays inside the 70-character subject
 * (`SUBJECT_MAX`) for any employee name up to eight letters, and `execSubject` never cuts again.
 */
export const PARTNER_MESSAGE_TITLE_MAX = 60;

export function partnerMessageTitle(partnerFirstName: string, instruction: string, max = PARTNER_MESSAGE_TITLE_MAX): string {
  const head = `Tell ${partnerFirstName}: `;
  const text = (instruction ?? "").replace(/\s+/g, " ").trim();
  if (!text) return head.trim().replace(/:$/, "");
  const firstSentence = (/^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).replace(/[.]$/, "");
  const room = max - head.length;
  if (firstSentence.length <= room) return head + firstSentence;
  return head + cutReadably(firstSentence, room);
}

/** Cut `s` to at most `room` characters INCLUDING a trailing "…": at a clause boundary, else a word. */
function cutReadably(s: string, room: number): string {
  const limit = Math.max(1, room - 1);
  const window = s.slice(0, limit + 1);
  let best = -1;
  for (const sep of [" — ", " – ", " - ", "; ", ", ", ": "]) {
    const at = window.lastIndexOf(sep);
    if (at > best && at <= limit) best = at;
  }
  // A clause boundary that keeps at least a third of the room is a better cut than a word boundary.
  if (best >= Math.floor(room / 3)) return `${s.slice(0, best).replace(/[\s,;:—–-]+$/, "")}…`;
  const space = window.lastIndexOf(" ");
  const cut = space > 0 && space <= limit ? s.slice(0, space) : s.slice(0, limit);
  return `${cut.replace(/[\s,;:—–-]+$/, "")}…`;
}
