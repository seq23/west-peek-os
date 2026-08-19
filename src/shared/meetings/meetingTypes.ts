import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

/**
 * What kind of meeting this is, and who is worth having in the room.
 *
 * WHY THE TYPE MATTERS AT ALL. Meetings had a type column with seven values and a UI that
 * hardcoded FOUNDER on every one, so every meeting the firm recorded claimed to be a founder
 * meeting. That is not a cosmetic problem: close-out delegation reads the type to decide who
 * follows up, so an LP call filed as a founder meeting routes its commitments to the wrong person.
 *
 * WHY EACH TYPE SUGGESTS EMPLOYEES. Seating is the good idea nobody uses, because "add an employee"
 * on an empty meeting is a question with no obvious answer — you have to already know the roster to
 * use it. A diligence call suggesting the analyst and a founder meeting suggesting the meeting
 * buddy turns that into a choice you can make in a second.
 *
 * SUGGESTIONS ARE NOT SEATING. Nothing here seats anybody: only an ACTIVE employee can be seated,
 * only a human can do it, and the server enforces both. This shortens the list you pick from and
 * nothing else — which is why an employee who is switched off simply will not appear.
 */

export interface MeetingType {
  key: string;
  /** What a partner calls it. */
  label: string;
  /** One line on when to use it, so the dropdown is not seven nouns. */
  when: string;
  /** Roster names worth having in this room, best first. */
  suggests: readonly string[];
  /** True when the counterparty is outside the firm — an internal-only employee must not be seated. */
  external: boolean;
}

export const MEETING_TYPES: readonly MeetingType[] = [
  {
    key: "FOUNDER",
    label: "Founder meeting",
    when: "You are meeting the people building the company.",
    suggests: ["Walter", "Pierce", "Wyatt"],
    external: true,
  },
  {
    key: "DILIGENCE",
    label: "Diligence",
    when: "Working out what would have to be true — references, customers, technical claims.",
    suggests: ["Wyatt", "Pierce", "Walter"],
    external: true,
  },
  {
    key: "PORTFOLIO",
    label: "Portfolio check-in",
    when: "A company you already own — how it is going and what it needs.",
    suggests: ["Winter", "Walter"],
    external: true,
  },
  {
    key: "LP",
    label: "LP conversation",
    when: "An existing or prospective limited partner.",
    suggests: ["Wesley", "Piper"],
    external: true,
  },
  {
    key: "INTERNAL",
    label: "Internal",
    when: "Just the firm — the Wednesday cadence, an IC discussion, a decision between partners.",
    // The only type where the compliance and finance seats belong, because nobody outside is present.
    suggests: ["Walker", "Wren", "Poppy", "Willow", "Preston"],
    external: false,
  },
  {
    key: "BROKER",
    label: "Broker or secondary",
    when: "A block, a seller, or an intermediary on the secondaries side.",
    suggests: ["Pierce", "Preston"],
    external: true,
  },
  {
    key: "OTHER",
    label: "Something else",
    when: "Anything that does not fit the rest.",
    suggests: ["Walter"],
    external: true,
  },
] as const;

const BY_KEY = new Map(MEETING_TYPES.map((t) => [t.key, t]));

export function meetingType(key: string): MeetingType | null {
  return BY_KEY.get(key) ?? null;
}

export interface Seatable {
  name: string;
  role: string;
  /** Why this employee is being suggested for this room. */
  because: string;
  suggested: boolean;
}

/**
 * Who can sit in this meeting, suggestions first.
 *
 * `available` is the set of employees who are actually ACTIVE. Passing it matters: offering to seat
 * somebody who is switched off produces a refusal from the server and looks like a bug.
 *
 * AN INTERNAL-ONLY EMPLOYEE IS NEVER OFFERED FOR AN EXTERNAL MEETING. That is the whole point of
 * the `face` field: compliance and fund finance exist to check the firm, and putting them in front
 * of a founder is a category error. The server does not enforce this — seating is governed by
 * ACTIVE status and human-only action, not by face — so this is guidance rather than a gate, and
 * the wording says so rather than implying a lock that is not there.
 */
export function seatableFor(typeKey: string, available: readonly string[]): Seatable[] {
  const type = meetingType(typeKey);
  const availableSet = new Set(available);

  return AI_EMPLOYEE_ROSTER.filter((e) => availableSet.has(e.name))
    .filter((e) => !(type?.external && e.face === "INTERNAL_ONLY"))
    .map((e) => {
      const suggested = Boolean(type?.suggests.includes(e.name));
      return {
        name: e.name,
        role: e.role,
        suggested,
        because: suggested
          ? `Usually worth having in a ${type!.label.toLowerCase()}.`
          : e.bio.split(".")[0] + ".",
      };
    })
    .sort((a, b) => {
      if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
      const order = type?.suggests ?? [];
      return order.indexOf(a.name) - order.indexOf(b.name) || a.name.localeCompare(b.name);
    });
}
