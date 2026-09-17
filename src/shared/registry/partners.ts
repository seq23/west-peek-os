/**
 * THE ONE ANSWER TO "IS THIS ONE OF THE TWO PARTNERS?" (17 Sep 2026).
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 *
 * The firm has exactly two humans with authority, and until now the system held that fact in four
 * unconnected places:
 *
 *   · `firm_user` rows `fu_scooter_taylor` / `fu_sequoia_taylor` in migration 0001 — the identity,
 *   · `ASSIGNING_PARTNERS` in `shared/intake/partnerAuthority.ts` — the two addresses that may
 *     assign work by email, and the only destinations an employee's mail may reach,
 *   · `MANAGING_PARTNERS` in `shared/registry/managingPartners.ts` — the ownership split and the
 *     names an AI employee may never be given,
 *   · `SCOOTER_EMAIL` and `SCOOTER_FIRM_USER_ID`, typed again as constants in
 *     `worker/services/productions.ts`.
 *
 * Four statements of one fact, none of which knows about the others. That is the defect class this
 * repo already names — "two components each keeping their own list with no link" — and the cost is
 * not theoretical: a NEW feature that has to ask "is this address a partner?" or "which firm_user
 * is this address?" could ask none of them and had to type a fifth copy. Preview mode was that
 * feature. It needs the answer twice (who may ask for a preview, and who every preview is
 * addressed to), and neither of the two existing lists could answer both halves, because one holds
 * addresses without ids and the other holds names without addresses.
 *
 * ─── WHAT IS HERE AND WHAT IS NOT ──────────────────────────────────────────────────────────────
 *
 * The JOIN between the three ways a partner is named — firm_user id, email address, first name —
 * plus the ownership facts `MANAGING_PARTNERS` already carried. Every other module derives its own
 * view from this one, so adding or changing a partner is one edit in one file.
 *
 * It is NOT configuration and NOT a database read. `ASSIGNING_PARTNERS` said why and the reason
 * carries: this list is a security boundary — being on it means being able to direct the firm's
 * employees by writing an email, and being the only address an employee's mail can reach — so it is
 * a decision a human makes in a commit, never an environment variable and never a row an admin path
 * could touch. A `firm_user` row can be added by an operator; membership of THIS list cannot.
 *
 * ─── THE DATABASE STILL HAS TO AGREE ───────────────────────────────────────────────────────────
 *
 * These ids and addresses must match the `firm_user` rows migration 0001 seeded, or the system
 * would hold a partner who does not exist. `tests/partnerRegistry.test.ts` reads the migrated
 * database and asserts the two agree in both directions, so a divergence fails the build rather
 * than producing a feature that quietly answers for nobody.
 */

export interface Partner {
  /** The `firm_user.id`. What every foreign key, event actor and deliverable recipient uses. */
  firmUserId: string;
  /** The `firm_user.email`, lower-case. The only thing that carries authority over inbound mail. */
  email: string;
  /** The local part, which is also how the roster names a chief of staff's principal. */
  firstName: string;
  fullName: string;
  /** Kept from `MANAGING_PARTNERS`, which is now derived from this. */
  ownershipPct: number;
  finalAuthority: boolean;
}

/**
 * ON `westpeek.ventures` BECAUSE THAT IS WHERE THE PARTNERS ACTUALLY ARE. It is the LP-facing
 * identity and these are the two humans it belongs to — the same reason `employeeMail.ts` refuses
 * that domain to an EMPLOYEE, and the reason the machine inbox lives on `joinwestpeek.com`.
 */
export const PARTNERS: readonly Partner[] = [
  {
    firmUserId: "fu_sequoia_taylor",
    email: "sequoia@westpeek.ventures",
    firstName: "Sequoia",
    fullName: "Sequoia Taylor",
    ownershipPct: 49,
    finalAuthority: false,
  },
  {
    firmUserId: "fu_scooter_taylor",
    email: "scooter@westpeek.ventures",
    firstName: "Scooter",
    fullName: "Scooter Taylor",
    ownershipPct: 51,
    finalAuthority: true,
  },
] as const;

/** Addresses only, lower-case. The shape `ASSIGNING_PARTNERS` has always published. */
export const PARTNER_EMAILS: readonly string[] = PARTNERS.map((p) => p.email);

/** `firm_user` ids only. */
export const PARTNER_FIRM_USER_IDS: readonly string[] = PARTNERS.map((p) => p.firmUserId);

/** Lower-cased and trimmed, because an address arrives from a header as often as from a column. */
function normaliseEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** The partner at this address, or null. Case and surrounding space are not part of an address. */
export function partnerByEmail(email: string | null | undefined): Partner | null {
  const wanted = normaliseEmail(email);
  return PARTNERS.find((p) => p.email === wanted) ?? null;
}

/** The partner with this `firm_user.id`, or null. */
export function partnerByFirmUserId(id: string | null | undefined): Partner | null {
  const wanted = (id ?? "").trim();
  return PARTNERS.find((p) => p.firmUserId === wanted) ?? null;
}

/**
 * The partner called this, or null. Matches the first name or the full name, case-insensitively,
 * because the roster says "Scooter" and an event trail says "Scooter Taylor".
 *
 * THROWS NOTHING AND GUESSES NOTHING. A name that is not a partner's returns null; callers that
 * need one (`productions.ts` needs Scooter) assert it at module load, so a typo is a build failure
 * rather than a feature that quietly addresses nobody.
 */
export function partnerByName(name: string | null | undefined): Partner | null {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return (
    PARTNERS.find((p) => p.firstName.toLowerCase() === wanted || p.fullName.toLowerCase() === wanted) ?? null
  );
}

/**
 * The question the whole system asks. True only for one of the two addresses.
 *
 * DELIBERATELY NOT "does the address end in @westpeek.ventures". `info@westpeek.ventures` is on
 * that domain and is not a partner; a domain test would hand the firm's authority to whoever
 * controls a shared mailbox.
 */
export function isPartnerEmail(email: string | null | undefined): boolean {
  return partnerByEmail(email) !== null;
}

/** The same question asked of an identity rather than an address. */
export function isPartnerFirmUserId(id: string | null | undefined): boolean {
  return partnerByFirmUserId(id) !== null;
}

/**
 * The partner a name, an address or an id refers to — whichever of the three a caller happens to
 * hold. Used where the input is genuinely one of several (a `From` header, a roster string, an
 * `actor_id`), so no caller has to branch on which.
 */
export function partnerFor(value: string | null | undefined): Partner | null {
  return partnerByEmail(value) ?? partnerByFirmUserId(value) ?? partnerByName(value);
}

/**
 * The partner who receives every preview, and who owns the firm's operating surface.
 *
 * Named here rather than in `preview.ts` so the preview boundary can never be pointed at an
 * address the registry does not know. Operator, 17 Sep 2026: "the recipient becomes
 * sequoia@westpeek.ventures, whatever the job was addressed to."
 */
export const PREVIEW_PARTNER: Partner = partnerByFirmUserId("fu_sequoia_taylor")!;

/** Scooter, whose own agency West Peek Productions is. Asserted at load; see `partnerByName`. */
export const PRODUCTIONS_PARTNER: Partner = partnerByFirmUserId("fu_scooter_taylor")!;
