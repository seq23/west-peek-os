/**
 * HER EMAILED INSTRUCTION NAMES A BRAND CONTACT (owner, 29 Oct 2026). She replied to Wynn's brand-reply approval
 * email (TLR-…, about another brand) with "pitch this person at <Brand> - <address>" and a paragraph on how to
 * frame it. The reply door read that whole note as her change to the OTHER brand's answer, and learned a line of
 * it as a standing rule for every brand; the brand she named stayed at "Needs a way in" with no address. Nothing
 * in the OS read a contact out of her mail.
 *
 * This is the reader, pure. Any authenticated email from her, on any thread, is read for addresses she tells Wynn
 * to use, each tied to a brand: the brand named just before the address, else the brand whose name is the
 * address's domain, else a brand she names as "at <Brand>". The angle is her words after the address. The worker
 * (services/tlcOwnerInstruction.ts) applies it to that brand's deal through the must-pitch path.
 */
import { brandKey } from "./mustPitch";
import { withBrandFooter } from "./brandFooter";
import { BRAND_GUESTS, TLC_DRIP_ASK, TLC_PS_BY_STEP, TLC_SIGNATURE, monthWords } from "./learningClub";

export interface OwnerContactInstruction {
  /** The brand as she or the list writes it. */
  brand: string;
  brandKey: string;
  email: string;
  /** A first and last name she wrote whose first name is the address's first part, else null. */
  contactName: string | null;
  /** Her framing, word for word (whitespace collapsed), or null. */
  angle: string | null;
  /** Club months she named (by month or by club topic), or null: the caller decides. */
  months: string[] | null;
}

/** Our own mail never names a brand contact. */
const OWN_DOMAINS = /(^|\.)(joinwestpeek\.com|westpeek\.ventures|westpeek\.live|westpeek\.com)$/i;
/** The words that make an address an instruction rather than a mention. */
const CUE = /\b(?:pitch|reach out|reach|contact|e-?mail|write to|send (?:it |this |them )?to|intro(?:duce)?|connect (?:with|to)|use|try|the person|this person)\b/i;
/** Domain in lower case only, so "x@brand.com.When …" (no space after the stop) ends at ".com". */
const ADDRESS = /[A-Za-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/g;
export const ANGLE_MAX = 1500;

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/g;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** "brand.com" → "brand"; "mail.brand.co.uk" → "brand". */
function domainLabel(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  const tail = parts.length > 2 && /^(?:co|com|org|net|ac)$/.test(parts[parts.length - 2]!) ? 3 : 2;
  return parts[parts.length - tail] ?? "";
}
const slug = (s: string) => brandKey(s).replace(/[^a-z0-9]/g, "");

/** The months of the open clubs she named, by name or by the club's topic. */
export function monthsNamed(text: string, clubs: ReadonlyArray<{ month: string; topic: string | null }>): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const c of clubs) {
    const m = Number(c.month.slice(5, 7)) - 1;
    const full = MONTH_NAMES[m]!;
    if (new RegExp(`\\b${full}\\b`, "i").test(text) && full !== "may") out.add(c.month);
    if (c.topic && c.topic.length >= 6 && lower.includes(c.topic.toLowerCase())) out.add(c.month);
  }
  for (const hit of text.matchAll(MONTH_SHORT)) {
    const idx = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(hit[1]!.toLowerCase().slice(0, 3));
    for (const c of clubs) if (Number(c.month.slice(5, 7)) - 1 === idx) out.add(c.month);
  }
  return [...out].sort();
}

/**
 * Every brand contact her note tells Wynn to use. `knownBrands` is her must-pitch list and the brands already in the
 * pipeline; an address for a brand outside it still counts when she names the brand ("at Brand - x@brand.com").
 */
export function ownerContactInstructions(note: string, knownBrands: readonly string[], clubs: ReadonlyArray<{ month: string; topic: string | null }> = []): OwnerContactInstruction[] {
  const text = String(note ?? "").replace(/\r\n/g, "\n");
  const hits = [...text.matchAll(ADDRESS)].map((m) => ({ email: m[0], at: m.index ?? 0 }));
  const out: OwnerContactInstruction[] = [];
  const brands = [...new Set(knownBrands.map((b) => b.trim()).filter(Boolean))];
  for (const [i, h] of hits.entries()) {
    const email = h.email.toLowerCase().replace(/^[._%+-]+/, "");
    const domain = email.split("@")[1] ?? "";
    if (!domain || OWN_DOMAINS.test(domain)) continue;
    // The words before the address, back to the start of its paragraph (at most 240 characters).
    const before = text.slice(Math.max(0, h.at - 240), h.at);
    const para = before.slice(before.lastIndexOf("\n\n") + 1);
    if (!CUE.test(para)) continue;
    let brand: string | null = null;
    let bestAt = -1;
    for (const b of brands) {
      const re = new RegExp(`\\b${escape(b)}\\b`, "gi");
      for (const m of para.matchAll(re)) if ((m.index ?? -1) > bestAt) { bestAt = m.index ?? -1; brand = b; }
    }
    if (!brand) brand = brands.find((b) => slug(b) && slug(b) === domainLabel(domain)) ?? null;
    if (!brand) {
      const named = /\bat\s+([A-Z][\w&.'’-]*(?:\s+[A-Z][\w&.'’-]*){0,3})\s*[-–—:,(]?\s*<?$/.exec(para.trimEnd());
      brand = named?.[1]?.replace(/[.,]$/, "") ?? null;
    }
    if (!brand) continue;
    // Her angle: what follows the address, up to the next address or the end of her note, minus a closing question to Wynn.
    const end = hits[i + 1]?.at ?? text.length;
    let after = text.slice(h.at + h.email.length, end).replace(/^[\s.,;:)>\]-]+/, "");
    const paras = after.split(/\n\s*\n/);
    while (paras.length > 1 && /\?\s*$/.test(paras[paras.length - 1]!.trim())) paras.pop();
    after = squash(paras.join("\n\n"));
    const angle = after.length >= 12 ? (after.length > ANGLE_MAX ? `${after.slice(0, ANGLE_MAX - 1)}…` : after) : null;
    // A name she wrote whose first name is the address's first part ("Pat Example" for pat@…).
    const first = email.split("@")[0]!.split(/[._+-]/)[0] ?? "";
    let contactName: string | null = null;
    if (/^[a-z]{2,}$/.test(first)) {
      const nm = new RegExp(`\\b(${first.charAt(0).toUpperCase()}${escape(first.slice(1))})\\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?)\\b`).exec(text);
      if (nm) contactName = `${nm[1]} ${nm[2]}`;
    }
    const months = monthsNamed(`${para} ${angle ?? ""}`, clubs);
    if (!out.some((o) => o.email === email && o.brandKey === brandKey(brand!))) {
      out.push({ brand, brandKey: brandKey(brand), email, contactName, angle, months: months.length ? months : null });
    }
  }
  return out;
}

/** True when a sentence of her note hands Wynn a brand contact: it is that brand's, never a rule for every brand. */
export function namesAnAddress(sentence: string): boolean {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(sentence);
}

/**
 * WHAT NEVER GOES IN A FIRST EMAIL (her brand rules): no money, no call ask, no promise of usage. Her own notes say
 * "guaranteed consumption" and "forcing the cohort"; the brand reads "builds on" instead. Returns what is wrong, or [].
 */
export function angleLineProblems(line: string): string[] {
  const problems: string[] = [];
  if (/\$|\b\d[\d,.]*\s*(?:k|K|m|M|usd|dollars?)\b|\bbudget|\bprice|\bpric(?:ing|ed)\b|\bsponsorship fee|\bper month\b|\/mo\b/i.test(line)) problems.push("money");
  if (/\bguarantee|\bforc(?:e|es|ed|ing)\b|\bmandatory\b|\brequired to\b|\bexclusive\b/i.test(line)) problems.push("guarantee language");
  if (/\b(?:call|zoom|meeting|hop on|chat live|calendar)\b/i.test(line)) problems.push("a call ask");
  if (/\blogo\b/i.test(line)) problems.push("logo placement");
  if (line.length > 420) problems.push("too long");
  return problems;
}

/**
 * EMAIL 1 FOR A BRAND SHE GAVE AN ANGLE FOR. Her brand rules, in order: open with West Peek (about 5,000 people,
 * Scooter and Quarantine Con, Rooms, The Learning Club), the club and the room, her angle in one or two brand-facing
 * sentences (null → left out, never invented), the standard ask (no call), the signature and the email-1 P.S.
 * No money anywhere.
 */
export function ownerAngleFirstEmail(input: { brand: string; contactName: string | null; topic: string; month: string; angleLine: string | null }): { subject: string; text: string } {
  const hi = input.contactName ? `Hi ${input.contactName.trim().split(/\s+/)[0]},` : "Hi,";
  const angle = input.angleLine && angleLineProblems(input.angleLine).length === 0 ? squash(input.angleLine) : null;
  const text = [
    hi,
    "",
    "I'm Sequoia Taylor of West Peek. We are a community of about 5,000 founders, operators, investors, creatives and builders, started by our founding GP Scooter Taylor, who went viral in 2020 with Quarantine Con. We meet in person through West Peek Rooms, our event series in New York, and The Learning Club is a series within Rooms: small, hands-on deep dives, one topic at a time.",
    "",
    `In ${monthWords(input.month)} the club is ${input.topic}: ${BRAND_GUESTS}, building hands-on. We host every segment, and it can run as a single evening or a series of six.${angle ? ` ${angle}` : ""}`,
    "",
    TLC_DRIP_ASK,
    "",
    ...TLC_SIGNATURE,
    "",
    TLC_PS_BY_STEP[0]!,
  ].join("\n");
  return { subject: `${input.brand} + a small room in New York`, text: withBrandFooter(text) };
}
