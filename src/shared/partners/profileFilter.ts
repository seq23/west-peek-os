/**
 * WHAT A PARTNER PROFILE MAY HOLD (0255; owner, 9 Oct 2026).
 *
 * A partner profile is the partner's OWN projects and requests: the sites he runs, what he is building,
 * how he writes, what he usually asks Porter for. It is read into routing, into the one clarifying
 * email, and into every job prompt for that partner — so it travels further than any card. LP names,
 * deal terms and fund details never go in, whatever the source: an email, a finished card's title, a
 * "Porter, note: …", or a seed. Fail closed: a line that trips any rule is refused whole, never trimmed.
 *
 * Pure. `services/partnerProfile.ts` calls it on every write AND on every render, and adds the LP
 * names on record (`lp_record.legal_name`) as extra forbidden terms.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bLPs?\b/, "names an LP"],
  [/\blimited partners?\b/i, "names a limited partner"],
  [/\bcapital (?:call|commitment|account)s?\b/i, "carries a fund term"],
  [/\bcommit(?:ment|ted|s)?\b/i, "carries a commitment"],
  [/\bcarr(?:y|ied interest)\b/i, "carries a fund term"],
  [/\bmanagement fees?\b/i, "carries a fund term"],
  [/\bterm ?sheets?\b/i, "carries deal terms"],
  [/\b(?:pre|post)[- ]money\b/i, "carries deal terms"],
  [/\bvaluations?\b/i, "carries deal terms"],
  [/\bcap ?tables?\b/i, "carries deal terms"],
  [/\b(?:SAFE|IRR|MOIC|TVPI|DPI|NAV)\b/, "carries a fund metric"],
  [/\bside letters?\b/i, "carries a fund term"],
  [/\bsubscription (?:doc|agreement)s?\b/i, "carries a fund term"],
  [/\bsecondar(?:y|ies)\b/i, "names fund strategy"],
  [/\ballocations?\b/i, "carries fund detail"],
  [/\bdistributions?\b/i, "carries fund detail"],
  [/\bfund(?:raise|raising|s)?\b/i, "carries fund detail"],
  [/\binvest(?:or|ors|ment|ments|ing)\b/i, "carries fund detail"],
  [/#wp(?:dealflow|deck|update)\b/i, "is deal flow"],
  [/\bdeal ?flow\b|\bdeals?\b/i, "is deal flow"],
  [/[$€£]\s?\d/, "carries an amount"],
  [/\b\d+(?:\.\d+)?\s?(?:k|m|mm|bn|million|billion)\b/i, "carries an amount"],
];

/** Why this line may not be kept in a partner profile, or null when it may. */
export function profileLineProblem(text: string, forbiddenNames: readonly string[] = []): string | null {
  const t = String(text ?? "");
  for (const [re, why] of RULES) if (re.test(t)) return why;
  const lower = t.toLowerCase();
  for (const name of forbiddenNames) {
    const n = String(name ?? "").trim().toLowerCase();
    if (n.length >= 4 && lower.includes(n)) return "names an LP on record";
  }
  return null;
}

/** The lines that may be kept, in order. */
export function keepableProfileLines(lines: readonly string[], forbiddenNames: readonly string[] = []): string[] {
  return lines.filter((l) => profileLineProblem(l, forbiddenNames) === null);
}

/**
 * A THIRD PARTY'S PERSONAL DETAILS ARE STRIPPED, NOT THE LINE (owner, 9 Oct 2026).
 *
 * Production held "finished: Walker: follow up on Scooter's W39 hire-search reply — <a candidate's
 * full name>'s email, music-affinity criterion". The owner's ruling: what he last worked on is
 * legitimate context — the hire search stays — but a third party's name-with-contact, email address
 * or phone number never sits in a profile. So unlike the fund rules above (refused whole), these are
 * cut out and the rest of the line is kept:
 *   • an email address that is not one the caller keeps (the partner's own), with a name written
 *     right before it ("Jane Doe <jane@x.com>", "Jane Doe (jane@x.com)", "Jane Doe jane@x.com");
 *   • a phone number;
 *   • "<Name>'s email / phone / number / mobile / cell / LinkedIn / address / contact" — unless the
 *     name is one the caller keeps (the partners, the AI employees).
 * Pure. `services/partnerProfile.ts` runs it before the fund rules on every write, every render and
 * every refresh (the door's and the hourly sweep's), so a stored line is rewritten clean.
 */
export interface StripOptions {
  /** Email addresses that may stay (the partner's own). Compared lower-case. */
  keepEmails?: readonly string[];
  /** First or full names whose "<name>'s email" may stay (partners, AI employees). Compared lower-case. */
  keepNames?: readonly string[];
}

const NAME = String.raw`[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2}`;
const EMAIL = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const CONTACT_WORD = String.raw`(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|number|mobile|cell|linkedin|address|contact(?:\s+details)?)`;

export function stripPersonalDetails(text: string, opts: StripOptions = {}): string {
  const keepEmails = new Set((opts.keepEmails ?? []).map((e) => e.toLowerCase()));
  const keepNames = new Set((opts.keepNames ?? []).map((n) => n.toLowerCase()));
  let t = String(text ?? "");
  // Name + email (bracketed or bare), then any email left on its own.
  t = t.replace(new RegExp(String.raw`(?:${NAME}\s*)?[<(\[]?\s*(${EMAIL})\s*[>)\]]?`, "gu"), (whole, email: string) => (keepEmails.has(email.toLowerCase()) ? whole : " "));
  // Phone numbers: +1 (555) 123-4567, 555.123.4567, 555 123 4567, +44 20 7946 0958.
  t = t.replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, " ");
  // "<Name>'s email…" — the name and the contact word go; a kept name stays.
  t = t.replace(new RegExp(String.raw`\b(${NAME})['’]s\s+${CONTACT_WORD}\b`, "giu"), (whole, name: string) => {
    const n = name.toLowerCase();
    const first = n.split(/\s+/)[0]!;
    return keepNames.has(n) || keepNames.has(first) ? whole : " ";
  });
  // Tidy what the cuts leave: doubled spaces, a comma or separator with nothing after it.
  t = t
    .replace(/\s+([,;])/g, "$1")
    .replace(/([—–:-])\s*[,;]\s*/g, "$1 ")
    .replace(/[,;]\s*(?=[,;]|$)/g, "")
    .replace(/\s+/g, " ")
    // A separator left dangling, with or without the "…" a shortened title ends on.
    .replace(/\s*[—–:,;-]\s*(?:…|\.\.\.)?\s*$/, "")
    .trim();
  return t;
}
