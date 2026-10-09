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
