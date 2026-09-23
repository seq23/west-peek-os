import { PARTNERS, partnerByEmail, partnerByName, type Partner } from "../registry/partners";

/**
 * "CC SCOOTER" — A PARTNER COPIED ON THE FINISHED EMAIL (owner, 23 Sep 2026: "yes add cc support").
 *
 * The requesting partner writes "cc Scooter", "cc scooter@westpeek.ventures" or "cc Sequoia" in the
 * request, in a reply on the card's thread, or in a note on the card. That partner is then copied on
 * the finished (DONE) email and on a site change's PREVIEW email — nothing else.
 *
 * PARTNERS ONLY, BY THE REGISTRY. A name or address resolves through `partnerByName` /
 * `partnerByEmail`, the one list of the two Managing Partners; anything else is REFUSED and said so.
 * This is not a way to email anyone: an outside address, a colleague's name, "him" — all refused.
 * Only the partner who asked for the work may add a cc (the same rule as "only the partner who asked
 * steers this card"); that check is the caller's, in `services/ccPartners.ts`, because it needs the
 * card. `validate:cc-partners-only` holds both ends — the write and the send — to this file.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONNECTORS = new Set(["and", "&", "+"]);
/** Words that name the writer themselves: they are already on the email, so nothing to add. */
const SELF = new Set(["me", "myself"]);

/** Every token a "cc …" phrase in this text names, in order, lower-cased. Pure. */
export function ccAsksIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(/(?:^|[^A-Za-z0-9@])cc\b\s*:?\s*([^\n]*)/gi)) {
    const words = (m[1] ?? "").split(/\s+/).filter(Boolean);
    let expectName = true;
    for (const raw of words) {
      const w = raw.replace(/^[("'<]+|[)"'>.!?:,;]+$/g, "").toLowerCase();
      if (!w) break;
      if (CONNECTORS.has(w)) {
        expectName = true;
        continue;
      }
      if (!expectName) break;
      if (EMAIL.test(w) || /^[a-z][a-z'-]*$/.test(w)) {
        out.push(w);
        // A comma is a connector too: "cc Scooter, Sequoia".
        expectName = /[,;]$/.test(raw);
        continue;
      }
      break;
    }
  }
  return [...new Set(out)];
}

export interface CcResolution {
  /** Partners to copy, never the writer. */
  add: Partner[];
  /** What was named and is not a partner, verbatim. */
  refused: string[];
}

/** Each token to a partner, or refused. The writer naming themselves is neither. Pure. */
export function resolveCc(tokens: readonly string[], writerEmail: string | null | undefined): CcResolution {
  const writer = (writerEmail ?? "").trim().toLowerCase();
  const add: Partner[] = [];
  const refused: string[] = [];
  for (const t of tokens) {
    if (SELF.has(t)) continue;
    const p = t.includes("@") ? partnerByEmail(t) : partnerByName(t);
    if (!p) {
      refused.push(t);
      continue;
    }
    if (p.email === writer) continue;
    if (!add.some((a) => a.email === p.email)) add.push(p);
  }
  return { add, refused };
}

/** A card's stored list, read defensively and FILTERED TO PARTNERS — a bad row can widen nothing. */
export function ccList(json: string | null | undefined): string[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(json ?? "[]");
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed) ? [...new Set(parsed.map((x) => String(x).trim().toLowerCase()).filter((a) => partnerByEmail(a) !== null))] : [];
}

/** The cc for one send: the card's partners, minus anyone already the recipient. Pure. */
export function ccForSend(json: string | null | undefined, to: string | readonly string[]): string[] {
  const already = new Set([to].flat().map((a) => a.trim().toLowerCase()));
  return ccList(json).filter((a) => !already.has(a));
}

/** The one sentence the partner reads back. Null when the text asked for no cc. */
export function ccAck(res: CcResolution, allowed: boolean, requesterName: string | null): string | null {
  if (res.add.length === 0 && res.refused.length === 0) return null;
  if (!allowed) return `No cc added: only ${requesterName ?? "the partner who asked"} can add a cc to this card.`;
  const parts: string[] = [];
  if (res.add.length) parts.push(`Noted: ${res.add.map((p) => p.firstName).join(" and ")} will be cc'd on the finished email.`);
  if (res.refused.length) parts.push(`Not cc'd: ${res.refused.join(", ")} — a cc can only be one of the partners (${PARTNERS.map((p) => p.firstName).join(" or ")}), never anyone else.`);
  return parts.join(" ");
}

/** True when the text is a cc request and nothing else ("cc Scooter", "please cc scooter@… thanks"). Pure. */
export function isOnlyACc(text: string | null | undefined): boolean {
  const t = String(text ?? "");
  if (ccAsksIn(t).length === 0) return false;
  const rest = t
    .replace(/(?:^|[^A-Za-z0-9@])cc\b\s*:?\s*[^\n]*/gi, " ")
    .replace(/\b(please|pls|also|and|thanks|thank you|on this|on it|on the finished email)\b/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, "");
  return rest.length === 0;
}
