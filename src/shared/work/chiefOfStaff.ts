/**
 * Who hands a delivery over.
 *
 * WHY ANYTHING IS SIGNED AT ALL. A briefing "from the system" is the anonymity the morning page
 * exists to fix. Somebody prepared it, and naming them is the difference between a report and a
 * dashboard.
 *
 * WHY THIS LIVES IN ONE FILE. The rule was written inline on Home, and the weekly review needed the
 * same answer. Two copies of "who is whose Chief of Staff" is the pair that drifts the first time
 * the roster changes.
 *
 * MATCHED ON FIRST NAME so a retitle in the roster still reaches the byline, and never left unsigned
 * — an unknown reader still gets a named deliverer rather than a blank.
 */

import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

export interface Deliverer {
  name: string;
  role: string;
}

/**
 * The Chief of Staff for one partner, READ FROM THE ROSTER.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The rule was `if (first === "scooter") return "Walker";
 * return "Wren";` — a second list of who is whose Chief of Staff, kept here, while the roster
 * itself already says it in the role string ("Scooter's Chief of Staff", "Sequoia's Chief of
 * Staff"). Two components each keeping their own list with nothing linking them: retitle a seat in
 * the roster and this file keeps returning the old name, and — worse — ANY partner who is not
 * Scooter silently gets Wren, including one who does not have a Chief of Staff at all.
 *
 * The role string is the link. `Wren` is the fallback for an unknown reader for the reason the
 * header gives: a delivery must never go out unsigned, and a named deliverer who is slightly wrong
 * is recoverable where a blank byline is not.
 */
export function chiefOfStaffFor(fullName: string): string {
  const first = fullName.split(" ")[0]?.toLowerCase() ?? "";
  const seat = AI_EMPLOYEE_ROSTER.find(
    (e) => e.role.toLowerCase().startsWith(`${first}'s chief of staff`),
  );
  return seat?.name ?? "Wren";
}

/**
 * Both, for anything the firm reads together.
 *
 * The weekly operating review is one document two partners work through, so it is prepared jointly
 * rather than signed by whichever of them happened to open it. That is not decoration: an agenda
 * that appears to belong to one partner is one the other stops treating as theirs.
 */
export const JOINT_CHIEFS: readonly string[] = ["Walker", "Wren"];

export function jointByline(): string {
  return `${JOINT_CHIEFS[0]} and ${JOINT_CHIEFS[1]}`;
}
