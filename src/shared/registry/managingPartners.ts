/**
 * Managing Partner identity constants.
 * Used ONLY for authority/ownership metadata and guard tests (D10, ADR-003):
 * a Managing Partner name may never appear as an AI employee.
 */
export const MANAGING_PARTNERS = [
  { fullName: "Scooter Taylor", firstName: "Scooter", ownershipPct: 51, finalAuthority: true },
  { fullName: "Sequoia Taylor", firstName: "Sequoia", ownershipPct: 49, finalAuthority: false },
] as const;

export const MANAGING_PARTNER_NAMES: readonly string[] = MANAGING_PARTNERS.flatMap((mp) => [
  mp.fullName,
  mp.firstName,
]);
