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
