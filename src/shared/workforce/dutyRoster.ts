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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE OPERATOR CAN NOW CHANGE IT, and the way she changes it is the reason the paragraphs above
 * still hold.
 *
 * Operator, 22 Aug 2026: "what is dutyroster's flow? i want a default flow and one that i can
 * change in the admin section — i should be able to adj hours for an employee".
 *
 * THE TABLE BELOW STAYS AND STAYS THE FALLBACK. The database holds DIFFERENCES from it and nothing
 * else. That is not a storage preference, it is the docstring above being obeyed: "a second roster
 * is a second source of truth", and a copy of `SHIFT_PREFERENCE` in D1 would be exactly that — two
 * rotas that can disagree, with no way to tell which one is wrong. Storing only the differences
 * buys four things that a copied table would have cost:
 *
 *   - the default keeps working, with its hand-written `WHY_ON_SHIFT` reasons intact;
 *   - a newly seated employee inherits a sensible shift the moment they exist, with nobody
 *     remembering to add them anywhere;
 *   - the surface can say "this is the default" versus "you changed this, on this date, because";
 *   - reverting is DELETING A ROW rather than restoring a remembered value — so revert cannot
 *     restore the wrong thing, which is the failure mode of every "save the old value" design.
 *
 * STILL PURE. The overrides are passed IN. This module cannot read a database — `src/shared/`
 * cannot import from `src/worker/`, and more importantly the purity is WHY a partner can predict
 * the rota. `resolveDuty(hour, size, { overrides })` returns the same answer forever for the same
 * three arguments, exactly as it did when there were only two.
 */

/**
 * WHICH SOURCE WINS, stated once, in order, and read by the resolver rather than restated by it.
 *
 * Three sources silently competing is how a rota becomes unarguable — the one property the
 * docstring above says it must never have. So there is exactly one list, `decideFor` walks it in
 * order, and the first source with an opinion about a person is the source that governs them. The
 * same order also decides who is listed first, so what the operator reads on the page IS this rule.
 *
 *   PINNED         — "just for this look". Not stored; a query parameter the page sets and clears.
 *   CUSTOM_HOURS   — an explicit local from/to for one person. Supersedes the shift model for them
 *                    entirely: "Wyatt is available 6am to 8pm" is an answer about Wyatt, not about
 *                    how the firm happens to divide its day, so no shift may contradict it.
 *   SHIFT_OVERRIDE — on or off for one named shift. The common case.
 *   CODE_DEFAULT   — `SHIFT_PREFERENCE` in this file. Always has an opinion, so this list always
 *                    terminates and every person on screen has a stated reason for being there.
 */
export const DUTY_PRECEDENCE = ["PINNED", "CUSTOM_HOURS", "SHIFT_OVERRIDE", "CODE_DEFAULT"] as const;

export type DutySource = (typeof DUTY_PRECEDENCE)[number];

/** How each source is named to a person. No raw key ever reaches a screen. */
export const DUTY_SOURCE_LABEL: Readonly<Record<DutySource, string>> = {
  PINNED: "Pinned for this view",
  CUSTOM_HOURS: "Custom hours",
  SHIFT_OVERRIDE: "Changed for this shift",
  CODE_DEFAULT: "Default",
};

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

/**
 * One difference from the default, for one employee.
 *
 * Deliberately NOT a database row type: it carries no id, no firm scope and no table shape, because
 * this module must be readable and testable without one. The Worker maps its rows onto this.
 *
 * `setBy` / `setAt` / `reason` are required rather than optional, and that is the same rule every
 * other authority change in this system follows: a rota that changed for reasons nobody recorded
 * cannot be reviewed later, and "who moved Wyatt off overnight, and why" is exactly the question
 * somebody asks three weeks afterwards.
 */
export interface DutyOverride {
  /** Roster name. A name this module does not know is ignored, as everywhere else here. */
  name: string;
  kind: "SHIFT" | "HOURS";
  /** SHIFT only — which shift this says something about. */
  shift?: ShiftKey;
  /** SHIFT only — true puts them on it, false takes them off it. */
  onDuty?: boolean;
  /** HOURS only, local 24h. `toHour` below `fromHour` is a window that wraps midnight. */
  fromHour?: number;
  toHour?: number;
  reason: string;
  /** The person who set it, by name. Never an id — an id on screen is not a reader's answer. */
  setBy: string;
  setAt: string;
}

/** What the surface prints beside a changed entry. */
export interface DutyChange {
  reason: string;
  setBy: string;
  setAt: string;
  /** Custom hours only: the window, already in a form a person reads. */
  hours: string | null;
}

export interface DutyAssignment {
  name: string;
  role: string;
  /** Why this person, at this hour. Shown verbatim — never a model's words. */
  because: string;
  /** Which source in `DUTY_PRECEDENCE` put them here. */
  source: DutySource;
  /** How the source is named to a reader. */
  sourceLabel: string;
  /** Null when this entry is the default. Set when a person changed it, and says who and why. */
  change: DutyChange | null;
}

export interface DutyRoster {
  shift: ShiftKey;
  label: string;
  intent: string;
  /** The shift's own hours, in a form a person reads. */
  hours: string;
  onDuty: DutyAssignment[];
  /** Named so the operator can see who was considered and passed over. */
  benched: string[];
  /** True when anything on this shift is not the code default. Lets a page say so without scanning. */
  changed: boolean;
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

const norm = (hour: number) => ((Math.trunc(hour) % 24) + 24) % 24;

/**
 * An hour as a person says it. 21 is not a time anybody reads out loud.
 *
 * Lives here rather than on the page because the Worker prints these too, and two formatters is the
 * same defect as two rosters on a smaller scale.
 */
export function readableHour(hour: number): string {
  const h = norm(hour);
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${suffix}`;
}

/** A window as a person says it. */
export function readableWindow(from: number, to: number): string {
  return `${readableHour(from)} to ${readableHour(to)}`;
}

/** Does a window that may wrap midnight contain this hour? */
function windowCovers(from: number, to: number, hour: number): boolean {
  const f = norm(from);
  const t = norm(to);
  const h = norm(hour);
  if (f === t) return false;
  return f < t ? h >= f && h < t : h >= f || h < t;
}

/**
 * Does a window that may wrap midnight touch any hour this shift covers?
 *
 * Used for the WHOLE-DAY view, where the question is "does this person cover this shift" rather
 * than "are they on right now". Walked hour by hour rather than reasoned about with arithmetic:
 * two wrapping intervals is where an off-by-one lives, and 24 comparisons is not a cost.
 */
function windowTouchesShift(from: number, to: number, shift: ShiftKey): boolean {
  const meta = SHIFTS.find((s) => s.key === shift)!;
  for (let h = 0; h < 24; h += 1) {
    if (windowCovers(meta.from, meta.to, h) && windowCovers(from, to, h)) return true;
  }
  return false;
}

const changeOf = (o: DutyOverride): DutyChange => ({
  reason: o.reason,
  setBy: o.setBy,
  setAt: o.setAt,
  hours:
    o.kind === "HOURS" && o.fromHour !== undefined && o.toHour !== undefined
      ? readableWindow(o.fromHour, o.toHour)
      : null,
});

/** What one source has to say about one person. Null means "no opinion — ask the next source". */
interface Opinion {
  on: boolean;
  because: string;
  change: DutyChange | null;
  /** Position within this source's own group, so ordering is deterministic too. */
  rank: number;
}

interface DecisionContext {
  name: string;
  shift: ShiftKey;
  /** The exact hour, or null when asking about a whole shift rather than a moment. */
  hour: number | null;
  role: string;
  pinned: readonly string[];
  overrides: readonly DutyOverride[];
  rosterRank: number;
}

/**
 * One function per source, keyed by the precedence list above.
 *
 * Kept as a record rather than an if-chain so that adding a source without adding it to
 * `DUTY_PRECEDENCE` does not compile — the ordering and the implementations cannot drift apart.
 */
const OPINION_OF: Readonly<Record<DutySource, (c: DecisionContext) => Opinion | null>> = {
  PINNED: (c) => {
    const at = c.pinned.indexOf(c.name);
    return at === -1
      ? null
      : { on: true, because: "you asked for them specifically", change: null, rank: at };
  },

  CUSTOM_HOURS: (c) => {
    const o = c.overrides.find(
      (x) => x.name === c.name && x.kind === "HOURS" && x.fromHour !== undefined && x.toHour !== undefined,
    );
    if (!o) return null;
    const on =
      c.hour === null
        ? windowTouchesShift(o.fromHour!, o.toHour!, c.shift)
        : windowCovers(o.fromHour!, o.toHour!, c.hour);
    return { on, because: o.reason, change: changeOf(o), rank: c.rosterRank };
  },

  SHIFT_OVERRIDE: (c) => {
    const o = c.overrides.find((x) => x.name === c.name && x.kind === "SHIFT" && x.shift === c.shift);
    if (!o) return null;
    return { on: o.onDuty === true, because: o.reason, change: changeOf(o), rank: c.rosterRank };
  },

  // Always answers, so the walk below always terminates.
  CODE_DEFAULT: (c) => {
    const at = SHIFT_PREFERENCE[c.shift].indexOf(c.name);
    if (at === -1) return { on: false, because: "not on this shift by default", change: null, rank: c.rosterRank };
    return {
      on: true,
      because: WHY_ON_SHIFT[c.shift][c.name] ?? c.role ?? "rostered for this shift",
      change: null,
      rank: at,
    };
  },
};

/** Walks `DUTY_PRECEDENCE` once. The first source with an opinion is the one that governs. */
function decideFor(c: DecisionContext): Opinion & { source: DutySource; sourceIndex: number } {
  for (let i = 0; i < DUTY_PRECEDENCE.length; i += 1) {
    const source = DUTY_PRECEDENCE[i]!;
    const opinion = OPINION_OF[source](c);
    if (opinion) return { ...opinion, source, sourceIndex: i };
  }
  /* istanbul ignore next — CODE_DEFAULT always answers. */
  throw new Error("duty precedence exhausted");
}

export interface DutyOptions {
  available?: readonly string[];
  pinned?: readonly string[];
  /** The stored differences from this file's default. Passed in; never read from anywhere. */
  overrides?: readonly DutyOverride[];
}

/**
 * The roster for one shift, at one moment or across the whole shift.
 *
 * `available` is the set of employees who are actually ACTIVE — passing it means the rota can
 * never put someone on duty who is switched off, which would be a promise the system cannot keep.
 * Omit it and every rostered employee is treated as available, which is what the pure tests do.
 *
 * `hour` is the moment being asked about, or null to ask about the shift as a whole. The difference
 * only shows for custom hours: 6am–8pm covers the midday shift but is off at 10pm, and the day view
 * asks "do they cover this shift" while the now view asks "are they on this minute".
 */
function rosterFor(shift: ShiftKey, hour: number | null, size: number, options: DutyOptions): DutyRoster {
  const meta = SHIFTS.find((s) => s.key === shift)!;
  const byName = new Map(AI_EMPLOYEE_ROSTER.map((e) => [e.name, e]));
  const rosterRank = new Map(AI_EMPLOYEE_ROSTER.map((e, i) => [e.name, i]));
  const available = options.available ? new Set(options.available) : null;
  const isAvailable = (n: string) => byName.has(n) && (available === null || available.has(n));

  const pinned = options.pinned ?? [];
  const overrides = options.overrides ?? [];

  // Everyone this shift could possibly be about: the default bench, anyone pinned, and anyone the
  // operator has said something about. A name nobody has an opinion on is not a candidate.
  const candidates = [...new Set([...pinned, ...SHIFT_PREFERENCE[shift], ...overrides.map((o) => o.name)])]
    .filter(isAvailable);

  const decided = candidates
    .map((name) => ({
      name,
      ...decideFor({
        name,
        shift,
        hour,
        role: byName.get(name)!.role,
        pinned,
        overrides,
        rosterRank: rosterRank.get(name) ?? 999,
      }),
    }))
    .filter((d) => d.on)
    // Precedence orders the page as well as the outcome, so what a reader sees IS the rule.
    .sort((a, b) => a.sourceIndex - b.sourceIndex || a.rank - b.rank);

  const onDuty: DutyAssignment[] = decided.slice(0, Math.max(0, size)).map((d) => ({
    name: d.name,
    role: byName.get(d.name)!.role,
    because: d.because,
    source: d.source,
    sourceLabel: DUTY_SOURCE_LABEL[d.source],
    change: d.change,
  }));

  // A thin shift is left thin rather than padded with whoever is left. An employee on duty with no
  // reason to be is noise, and the operator can always pin someone.
  const benched = decided.slice(Math.max(0, size)).map((d) => d.name);

  return {
    shift,
    label: meta.label,
    intent: meta.intent,
    hours: readableWindow(meta.from, meta.to),
    onDuty,
    benched,
    changed: onDuty.some((a) => a.change !== null),
  };
}

/**
 * The roster for a given hour.
 *
 * `pinned` is the operator overriding the machine for one look: anyone named here takes a slot
 * first, whatever the hour says, and it is gone as soon as she clears it. A rota you cannot
 * overrule is a rota you end up working around. `overrides` is the durable version of the same
 * instinct — see `DUTY_PRECEDENCE`.
 */
export function resolveDuty(hour: number, size: number, options: DutyOptions = {}): DutyRoster {
  return rosterFor(shiftForHour(hour), hour, size, options);
}

/** The whole day, one entry per shift, in the order a day happens. */
export function resolveDay(size: number, options: DutyOptions = {}): DutyRoster[] {
  return SHIFTS.map((s) => rosterFor(s.key, null, size, options));
}
