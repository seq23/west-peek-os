import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";

/**
 * Who is on duty right now.
 *
 * THE PROBLEM THIS SOLVES. Every employee can now be ACTIVE — employed and available. That is the
 * right answer to "can I use my whole team", and on its own it produces a worse screen than the
 * cap did: thirty names, all equally present, none of them the one you need. Availability is not
 * attention. A partner helped by thirty people at once is helped by nobody.
 *
 * So the firm keeps a short duty roster and rotates the whole workforce through it. A morning
 * belongs to the people who prepare a day; the middle of a day belongs to the people who move
 * deals; an evening belongs to the people who close things out. Nobody is switched off — they are
 * simply not the ones being leaned on at 7am.
 *
 * PURE AND DETERMINISTIC. Given the same hour and the same focus, this returns the same roster,
 * forever. It reads the SAME registry everything else reads rather than holding its own list,
 * because a second roster is a second source of truth. It cannot activate anyone, cannot reach the
 * database, and cannot call a model — the machine decides the SHAPE of the day, and a human still
 * decides who is employed.
 *
 * WHY NOT ASK A MODEL. "Who should be on duty at 2pm" looks like a judgement call and is not: it is
 * a mapping from time of day to the work that happens then, and the operator should be able to
 * predict it, disagree with it, and change it. A model would make it unpredictable and unarguable,
 * which are the two properties a rota must not have.
 */

/** The shifts a working day divides into, with the hours each covers (local time, 24h). */
export const SHIFTS = [
  {
    key: "MORNING",
    label: "Morning",
    from: 5,
    to: 12,
    /** What the firm is doing in these hours, in the operator's language. */
    intent: "Arrive informed and know what today needs.",
  },
  {
    key: "MIDDAY",
    label: "Midday",
    from: 12,
    to: 17,
    intent: "Move deals — screening, diligence, and the conversations that decide them.",
  },
  {
    key: "EVENING",
    label: "Evening",
    from: 17,
    to: 22,
    intent: "Close the day out: follow-ups, the community, and what was promised to whom.",
  },
  {
    key: "OVERNIGHT",
    label: "Overnight",
    from: 22,
    to: 5,
    intent: "Nothing is expected of you. A skeleton roster keeps the lights on.",
  },
] as const;

export type ShiftKey = (typeof SHIFTS)[number]["key"];

/**
 * Which employees each shift leans on, strongest claim first.
 *
 * Names are roster names, and `resolveDuty` silently drops any that are not on the roster — so
 * consolidating the workforce cannot break the rota, it just shortens a shift's bench.
 */
/**
 * WHY EACH PERSON, at this hour.
 *
 * `because` was set to the shift's own intent, which is already printed as the heading above the
 * list — so the page showed the same sentence six times, once per person, saying nothing about any
 * of them. It read as a rendering fault because it was one.
 *
 * A reason has to be about THAT person on THAT shift, or it is decoration. Anyone without an entry
 * falls back to their role, which at least says something true.
 */
const WHY_ON_SHIFT: Record<ShiftKey, Record<string, string>> = {
  MORNING: {
    Walker: "signs Scooter's morning brief and sequences his day",
    Wren: "signs your morning brief and holds the Wednesday cadence",
    Wyatt: "the overnight sweep is his, so the brief has something in it",
    Wells: "surfaces what changed in the record since you last looked",
    Porter: "checks the overnight syncs landed before anyone acts on them",
  },
  MIDDAY: {
    Pierce: "deal hours — screening and diligence run through him",
    Wyatt: "runs the research behind whatever is being decided",
    Poppy: "assembles the packet while the committee is still reachable",
    Walter: "sits in the meetings and catches what was actually said",
    Waverly: "finds the warm path while people are at their desks",
  },
  EVENING: {
    // One LP line, not two: Piper merged into Wesley, so qualifying and following up are the same
    // person's evening. Leaving her here would have been silent — `resolveDuty` drops a name the
    // roster does not have, so the shift would simply have grown shorter with nothing saying why.
    Wesley: "the LP follow-ups and the qualifying calls, while the day is still fresh",
    Waverly: "the community is awake in the evening and the firm is not",
    Parker: "events and the guest list, which are an evening job",
    Winter: "checks the portfolio asks that came in today",
    Pippa: "reads anything due to go out before it does",
  },
  OVERNIGHT: {
    Willow: "the compliance check that should notice a problem at 3am",
    Porter: "keeps the syncs running while nobody is watching",
    Pax: "the scheduled work runs overnight and something has to watch it",
  },
};

const SHIFT_PREFERENCE: Record<ShiftKey, readonly string[]> = {
  // The brief lands at breakfast, and the day gets sequenced before it starts.
  MORNING: ["Walker", "Wren", "Wyatt", "Wells", "Porter"],
  // Deal hours: sourcing, screening, the analyst, and the people who prepare a decision.
  MIDDAY: ["Pierce", "Wyatt", "Poppy", "Walter", "Waverly"],
  // What got promised, to whom, and the relationships that carry the firm.
  EVENING: ["Wesley", "Waverly", "Parker", "Winter", "Pippa"],
  // Deliberately thin. Compliance and systems, because those are the two things
  // that should notice a problem at 3am; everyone else is off.
  OVERNIGHT: ["Willow", "Porter", "Pax"],
};

export interface DutyAssignment {
  name: string;
  role: string;
  /** Why this person, at this hour. Shown verbatim — never a model's words. */
  because: string;
}

export interface DutyRoster {
  shift: ShiftKey;
  label: string;
  intent: string;
  onDuty: DutyAssignment[];
  /** Named so the operator can see who was considered and passed over. */
  benched: string[];
}

/** Which shift an hour belongs to. OVERNIGHT wraps midnight, hence the special case. */
export function shiftForHour(hour: number): ShiftKey {
  const h = ((hour % 24) + 24) % 24;
  for (const s of SHIFTS) {
    if (s.key === "OVERNIGHT") continue;
    if (h >= s.from && h < s.to) return s.key;
  }
  return "OVERNIGHT";
}

/**
 * The roster for a given hour.
 *
 * `available` is the set of employees who are actually ACTIVE — passing it means the rota can
 * never put someone on duty who is switched off, which would be a promise the system cannot keep.
 * Omit it and every rostered employee is treated as available, which is what the pure tests do.
 *
 * `pinned` is the operator overriding the machine: anyone named here takes a slot first, whatever
 * the hour says. The rota fills what is left. A rota you cannot overrule is a rota you end up
 * working around.
 */
export function resolveDuty(
  hour: number,
  size: number,
  options: { available?: readonly string[]; pinned?: readonly string[] } = {},
): DutyRoster {
  const shift = shiftForHour(hour);
  const meta = SHIFTS.find((s) => s.key === shift)!;
  const byName = new Map(AI_EMPLOYEE_ROSTER.map((e) => [e.name, e]));
  const available = options.available ? new Set(options.available) : null;
  const isAvailable = (n: string) => byName.has(n) && (available === null || available.has(n));

  const picked: DutyAssignment[] = [];
  const seen = new Set<string>();

  const take = (name: string, because: string) => {
    if (picked.length >= size || seen.has(name) || !isAvailable(name)) return;
    seen.add(name);
    picked.push({ name, role: byName.get(name)!.role, because });
  };

  for (const name of options.pinned ?? []) take(name, "you asked for them specifically");
  for (const name of SHIFT_PREFERENCE[shift]) {
    take(name, WHY_ON_SHIFT[shift][name] ?? byName.get(name)?.role ?? "rostered for this shift");
  }

  // A thin shift is left thin rather than padded with whoever is left. An employee on duty with no
  // reason to be is noise, and the operator can always pin someone.
  const benched = SHIFT_PREFERENCE[shift].filter((n) => !seen.has(n) && isAvailable(n));

  return { shift, label: meta.label, intent: meta.intent, onDuty: picked, benched };
}
