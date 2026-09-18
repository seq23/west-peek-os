import { PARTNERS } from "./partners";

/**
 * Managing Partner identity constants.
 * Used ONLY for authority/ownership metadata and guard tests (D10, ADR-003):
 * a Managing Partner name may never appear as an AI employee.
 *
 * DERIVED, NOT TYPED, SINCE 17 SEP 2026. This file used to hold its own copy of who the partners
 * are — names and ownership — while `ASSIGNING_PARTNERS` held their addresses and `productions.ts`
 * held Scooter's address and id again. Four statements of one fact, and a new feature could ask
 * none of them. `shared/registry/partners.ts` is now the single answer and this is a view of it,
 * kept because the shape is what the guard tests and the ownership readers already consume.
 */
/*
 * ORDERED BY OWNERSHIP, WHICH IS THE ORDER THIS LIST HAS ALWAYS BEEN IN — Scooter at 51, Sequoia at
 * 49. Stated as a sort rather than inherited from `PARTNERS`, whose own order is the one
 * `ASSIGNING_PARTNERS` published. Two views of one list may be ordered differently; neither may be
 * ordered by accident.
 */
export const MANAGING_PARTNERS = [...PARTNERS]
  .sort((a, b) => b.ownershipPct - a.ownershipPct)
  .map((p) => ({
  fullName: p.fullName,
  firstName: p.firstName,
  ownershipPct: p.ownershipPct,
  finalAuthority: p.finalAuthority,
}));

export const MANAGING_PARTNER_NAMES: readonly string[] = MANAGING_PARTNERS.flatMap((mp) => [
  mp.fullName,
  mp.firstName,
]);
