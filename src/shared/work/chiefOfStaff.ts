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

export interface Deliverer {
  name: string;
  role: string;
}

/** The Chief of Staff for one partner. */
export function chiefOfStaffFor(fullName: string): string {
  const first = fullName.split(" ")[0]?.toLowerCase() ?? "";
  if (first === "scooter") return "Walker";
  return "Wren";
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
