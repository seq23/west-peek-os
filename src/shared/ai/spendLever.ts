/**
 * ONE LEVER, AND A GRADIENT THAT RUNS INSIDE ONE OF ITS POSITIONS.
 *
 * WHY THIS FILE REPLACES THE `cost_mode` ENUM.
 *
 * `NORMAL | CHEAPO | CRITICAL_ONLY | STRATEGIC_SURGE` was four values answering three unrelated
 * questions — how much money, what work runs at all, and lift-the-caps-temporarily. Today's
 * near-miss came straight out of that: CHEAPO means "spend less", and because the same column also
 * answered "how good", it ignored `preferredModel` outright. All eight search call sites would have
 * gone to a model with no web access, which does not error — it answers from memory.
 *
 * Boss OS already separates these correctly, and its comment states the rule: "how good" and "how
 * much money" are different decisions, the lever never moves the mode and the mode never moves the
 * lever. That separation is adopted here. The code is written fresh rather than imported: boss-os
 * is a different product on a different chassis, and an import would couple two repos that must be
 * able to diverge.
 *
 * ── THE OWNER'S LADDER, 17 Sep 2026 ─────────────────────────────────────────────────────────
 *
 *   under $5    normal
 *   $5 – $10    starts making cheaper choices
 *   over $10    moves cautiously — free-first hard, paid only for protected work
 *   $50         notify her, with the bypass decision in front of her
 *   $75         hard stop, with bypass available
 *
 * ── THE GUARANTEE THAT MAKES ALL OF IT SAFE ─────────────────────────────────────────────────
 *
 * PROTECTED WORK IS NEVER DOWNGRADED AT ANY POSITION ON THE GRADIENT. Anything the call site marks
 * `judgement` or `interpretation` keeps its model or fails loudly. No threshold, no month-end
 * pressure and no lever position may create a back door into it — `protectedFromSpendPressure`
 * below is the single place that decides, and every consumer asks it rather than re-deriving.
 */

export type SpendLever = "FREE_ONLY" | "MODERATE" | "OPEN";

export interface LeverDef {
  key: SpendLever;
  label: string;
  /** What it does, in the owner's terms. */
  what: string;
  /** The honest downside. Every one of these has one. */
  tradeoff: string;
}

/**
 * THE THREE POSITIONS, NAMED IDENTICALLY TO BOSS OS so that a person moving between the two
 * systems is looking at the same control with the same name meaning the same thing.
 */
export const SPEND_LEVERS: readonly LeverDef[] = [
  {
    key: "FREE_ONLY",
    label: "Free only",
    what:
      "Nothing paid, at all. Her Claude Code and Codex seats first (already paid for), then the free lanes — " +
      "Workers AI and the free frontier tiers.",
    tradeoff:
      "Public work that would have been written by Claude runs on the best free lane instead, and says so; the brief is " +
      "marked as written by a weaker model. Private work (LP names, deal terms, fund figures) can never use a free lane, " +
      "so with both seats away or out of usage it STOPS and names this switch rather than spend money or send it somewhere that trains.",
  },
  {
    key: "MODERATE",
    label: "Moderate",
    what:
      "The default. Spends where it matters and tightens on its own as the month runs ahead of pace — " +
      "under $5 normal, $5–$10 cheaper choices, over $10 free-first. Measured against how much of the month has gone.",
    tradeoff: "Routine work gets gradually cheaper models late in an expensive month. Protected work never does.",
  },
  {
    key: "OPEN",
    label: "Open",
    what:
      "The switch for “I need good work right now.” Her seats still go first, then paid Claude — the free lanes are " +
      "skipped for judgement work. Spends what is needed, up to the $75 ceiling. The gradient stops tightening.",
    tradeoff: "A heavy week reaches the ceiling faster, and the ceiling is where work stops rather than slows.",
  },
];

export function leverDef(key: string): LeverDef {
  return SPEND_LEVERS.find((l) => l.key === key) ?? SPEND_LEVERS[1]!;
}

/** Fail-safe for an unreadable or absent value. MODERATE is the owner's stated default. */
export function asSpendLever(value: unknown): SpendLever {
  return value === "FREE_ONLY" || value === "OPEN" || value === "MODERATE" ? value : "MODERATE";
}

// ── The ladder ──────────────────────────────────────────────────────────────────────────────

/**
 * The owner's own numbers, in dollars of month-to-date spend. The first two are PRO-RATED against
 * the elapsed month (see below); the last two are absolute, because "notify me at $50" and "stop at
 * $75" are statements about money, not about pace.
 */
export const LADDER = {
  /** Above this (pro-rated), start making cheaper choices. */
  tighteningUsd: 5,
  /** Above this (pro-rated), move cautiously: free-first hard, paid only for protected work. */
  cautiousUsd: 10,
  /** Absolute. Notify her, with the bypass decision in front of her. */
  notifyUsd: 50,
  /** Absolute. Hard stop, bypass available. Enforced as the firmwide monthly ceiling. */
  hardStopUsd: 75,
} as const;

/** Where a threshold becomes visible, before it bites. Approaching is information; crossing is not. */
export const APPROACH_FRACTION = 0.8;

export type GradientPosition = "NORMAL" | "TIGHTENING" | "CAUTIOUS";

/**
 * HOW MUCH OF THE MONTH HAS GONE, as a fraction, and why the gradient is measured against it.
 *
 * Her decision, in her words: "approaching $10 measured against the month elapsed."
 *
 * A raw month-to-date total answers the wrong question. $8 spent on the 3rd and $8 spent on the
 * 25th are the same number and opposite situations: the first is a month heading for $80, the
 * second is a month heading for $9.60. Comparing a raw total against a flat $10 would put one heavy
 * build day into austerity for the whole of the rest of the month — which is exactly the behaviour
 * she rejected, and exactly why she named the elapsed month.
 *
 * So the THRESHOLD is pro-rated rather than the spend:
 *
 *     allowance(threshold) = threshold x elapsedFraction
 *
 * On the 3rd of a 30-day month the $10 line sits at $1.00, so $8 is over pace and tightens. On the
 * 25th it sits at $8.33, so the same $8 is on pace and does not. Both are her stated examples and
 * both fall out of the one formula.
 *
 * IT IS ALSO SELF-HEALING, which is the property a raw total lacks. A day that spends $2.50 tightens
 * the gradient that day; if nothing further is spent, the allowance climbs past it within a few days
 * and the firm returns to normal on its own. Nobody has to remember to undo anything.
 *
 * THE FLOOR, AND WHY IT IS ONE DAY. At one minute past midnight on the 1st the raw fraction is
 * ~0.00002 and every threshold pro-rates to nothing, so the first cent spent would read as wildly
 * over pace. The fraction is therefore floored at one day's share of the month: the firm always has
 * at least a full day's allowance, and a day cannot spend more than the $2.50 daily cap anyway.
 * A $2.50 day-one spend does read as over pace, and that is correct — $2.50 a day is $75 a month.
 *
 * MONTH LENGTH IS REAL, not 30. September and February pro-rate against their own lengths, because
 * the day-of-month the firm is on is the thing being measured and a fixed divisor would make the
 * 30th of a 31-day month read as a completed month.
 */
export function monthElapsedFraction(now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const span = end - start;
  const daysInMonth = span / 86_400_000;
  const raw = (now.getTime() - start) / span;
  return Math.min(1, Math.max(1 / daysInMonth, raw));
}

/** The pro-rated allowance for a ladder threshold at this point in the month. */
export function paceAllowance(thresholdUsd: number, now: Date): number {
  return Math.round(thresholdUsd * monthElapsedFraction(now) * 1_000_000) / 1_000_000;
}

/**
 * Straight-line month-end projection from the elapsed fraction. Reported for the screen so she can
 * see WHERE the month is heading, never used to decide behaviour — a projection is not a fact, and
 * the thing that decides is the comparison against the pro-rated allowance.
 */
export function projectedMonthEnd(monthToDateUsd: number, now: Date): number {
  return Math.round((monthToDateUsd / monthElapsedFraction(now)) * 1_000_000) / 1_000_000;
}

/**
 * What the firm is actually doing right now: the lever she set, plus — inside MODERATE only — where
 * the month has put it on the gradient.
 */
export interface SpendBehaviour {
  lever: SpendLever;
  position: GradientPosition;
  /** False at FREE_ONLY and OPEN: her hand is on the control and the gradient does not move it. */
  gradientApplies: boolean;
  /** No paid lane may be used at all. */
  freeOnly: boolean;
  /** Free lanes first, and unpinned paid work drops to the cheapest adequate model. */
  freeFirst: boolean;
  /** Among adequate candidates, take the cheaper. */
  cheaperChoices: boolean;
  /** Unpinned work takes the dearest capable model rather than the cheapest. */
  prefersFrontier: boolean;
  monthToDateUsd: number;
  elapsedFraction: number;
  /** The pro-rated $5 and $10 lines at this instant. */
  tighteningAllowanceUsd: number;
  cautiousAllowanceUsd: number;
  projectedMonthEndUsd: number;
  /** She is at or past $50: notify, with the bypass decision attached. */
  notify: boolean;
  /** Approaching a line that has not bitten yet. Visible before it changes anything. */
  approaching: null | "TIGHTENING" | "CAUTIOUS" | "NOTIFY" | "HARD_STOP";
  /** One sentence, for the screen and for the run record. Never reworded by a caller. */
  why: string;
  /** What this position is costing her in capability, stated plainly. */
  capabilityCost: string;
}

/**
 * THE WHOLE DECISION, in one pure function, so that the page and the router cannot disagree about
 * where the firm is.
 *
 * HER HAND ALWAYS WINS, and this is where that is enforced. FREE_ONLY and OPEN return their own
 * behaviour whatever the month has done; only MODERATE consults the gradient. Nothing here writes
 * anything — the lever is changed by a person and by nothing else.
 */
export function evaluateSpend(lever: SpendLever, monthToDateUsd: number, now: Date): SpendBehaviour {
  const elapsedFraction = monthElapsedFraction(now);
  const tighteningAllowanceUsd = paceAllowance(LADDER.tighteningUsd, now);
  const cautiousAllowanceUsd = paceAllowance(LADDER.cautiousUsd, now);
  const projectedMonthEndUsd = projectedMonthEnd(monthToDateUsd, now);
  const notify = monthToDateUsd >= LADDER.notifyUsd;

  const position: GradientPosition =
    monthToDateUsd > cautiousAllowanceUsd ? "CAUTIOUS" : monthToDateUsd > tighteningAllowanceUsd ? "TIGHTENING" : "NORMAL";

  // Visible BEFORE it bites. Named for whichever line is nearest ahead, so "approaching" is a fact
  // about one threshold rather than a mood.
  let approaching: SpendBehaviour["approaching"] = null;
  if (monthToDateUsd >= LADDER.hardStopUsd * APPROACH_FRACTION && monthToDateUsd < LADDER.hardStopUsd) {
    approaching = "HARD_STOP";
  } else if (monthToDateUsd >= LADDER.notifyUsd * APPROACH_FRACTION && monthToDateUsd < LADDER.notifyUsd) {
    approaching = "NOTIFY";
  } else if (position === "TIGHTENING" && monthToDateUsd >= cautiousAllowanceUsd * APPROACH_FRACTION) {
    approaching = "CAUTIOUS";
  } else if (position === "NORMAL" && monthToDateUsd >= tighteningAllowanceUsd * APPROACH_FRACTION) {
    approaching = "TIGHTENING";
  }

  const pace = `$${monthToDateUsd.toFixed(2)} spent with ${Math.round(elapsedFraction * 100)}% of the month gone`;

  if (lever === "FREE_ONLY") {
    return {
      lever,
      position,
      gradientApplies: false,
      freeOnly: true,
      freeFirst: true,
      cheaperChoices: true,
      prefersFrontier: false,
      monthToDateUsd,
      elapsedFraction,
      tighteningAllowanceUsd,
      cautiousAllowanceUsd,
      projectedMonthEndUsd,
      notify,
      approaching,
      why: `You set the lever to Free only, so nothing paid runs whatever the month has cost. ${pace}.`,
      capabilityCost:
        "Everything runs on her seats and the free lanes. Work Claude would have written runs on the best of those " +
        "and says so. Private work with both seats away or out of usage STOPS — it names itself and says the lever is set to Free only.",
    };
  }

  if (lever === "OPEN") {
    return {
      lever,
      position,
      gradientApplies: false,
      freeOnly: false,
      freeFirst: false,
      cheaperChoices: false,
      prefersFrontier: true,
      monthToDateUsd,
      elapsedFraction,
      tighteningAllowanceUsd,
      cautiousAllowanceUsd,
      projectedMonthEndUsd,
      notify,
      approaching,
      why: `You set the lever to Open, so the gradient does not tighten and unpinned work takes the strongest model. ${pace}.`,
      capabilityCost: `Nothing. This is the most capable setting, and it runs until the $${LADDER.hardStopUsd} ceiling stops it.`,
    };
  }

  // MODERATE — the only position the gradient runs inside.
  const base = {
    lever,
    position,
    gradientApplies: true,
    freeOnly: false,
    prefersFrontier: false,
    monthToDateUsd,
    elapsedFraction,
    tighteningAllowanceUsd,
    cautiousAllowanceUsd,
    projectedMonthEndUsd,
    notify,
    approaching,
  } as const;

  if (position === "CAUTIOUS") {
    return {
      ...base,
      freeFirst: true,
      cheaperChoices: true,
      why:
        `${pace}, against a pro-rated $${LADDER.cautiousUsd} line of $${cautiousAllowanceUsd.toFixed(2)}. ` +
        `The month is ahead of pace, so routine work goes free-first and paid models are kept for protected work. ` +
        `Left alone, this returns to normal on its own as the month catches up.`,
      capabilityCost:
        "Routine work — URL checks, format passes, dedupes, extractions — runs on free models and is less sharp. " +
        "Anything marked judgement or interpretation is untouched and keeps its model.",
    };
  }
  if (position === "TIGHTENING") {
    return {
      ...base,
      freeFirst: false,
      cheaperChoices: true,
      why:
        `${pace}, against a pro-rated $${LADDER.tighteningUsd} line of $${tighteningAllowanceUsd.toFixed(2)}. ` +
        `Slightly ahead of pace, so unpinned work takes the cheaper of the adequate models.`,
      capabilityCost:
        "Unpinned routine work takes a cheaper model than it otherwise would. Protected work is untouched.",
    };
  }
  return {
    ...base,
    freeFirst: false,
    cheaperChoices: false,
    why: `${pace}, inside the pro-rated $${LADDER.tighteningUsd} line of $${tighteningAllowanceUsd.toFixed(2)}. On pace, so nothing is being held back.`,
    capabilityCost: "Nothing. The month is on pace and every call gets the model it would normally get.",
  };
}

// ── The guarantee ───────────────────────────────────────────────────────────────────────────

/**
 * IS THIS CALL PROTECTED FROM SPEND PRESSURE? The single place that answers, so that no threshold,
 * no lever position and no future posture can create a second answer.
 *
 * `interpretation` implies `judgement`, exactly as the call-site contract says. `requiresSearch` is
 * protected too and for a different reason: there is no honest cheap version of "what happened in
 * the market today", and a confident answer from memory is worse than no answer because it gets
 * believed. `mechanical` is not protected, which is the entire point of marking it.
 */
export function protectedFromSpendPressure(markers: {
  judgement?: boolean;
  interpretation?: boolean;
  requiresSearch?: boolean;
  /** Accepted and ignored: declaring a call mechanical is precisely declaring it unprotected. */
  mechanical?: boolean;
}): boolean {
  return markers.interpretation === true || markers.judgement === true || markers.requiresSearch === true;
}

/** The four task kinds, which are the classification markers. Used as the learning grid's rows. */
export type TaskKind = "interpretation" | "judgement" | "search" | "mechanical";

/** The kind of job this call is, from its marker. Exactly one kind per call, by construction. */
export function taskKindOf(markers: {
  judgement?: boolean;
  interpretation?: boolean;
  requiresSearch?: boolean;
  mechanical?: boolean;
}): TaskKind {
  if (markers.interpretation === true) return "interpretation";
  if (markers.requiresSearch === true) return "search";
  if (markers.judgement === true) return "judgement";
  return "mechanical";
}

// ── Legacy ──────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT HAPPENS TO ANYTHING STILL SETTING `cost_mode`.
 *
 * The column stays (it is NOT NULL, and older rows and readers still select it), but nothing about
 * routing reads it any more. A caller that still sends a `cost_mode` is TRANSLATED here rather than
 * ignored or refused, so an old client keeps working and gets the behaviour its value meant — and
 * `scripts/validate/one-lever-not-four.mjs` fails the build if any routing decision reads the column
 * again.
 *
 * The mapping is read off what runAi.ts actually did, not off the value names:
 *   CHEAPO + honours_pins=0 → FREE_ONLY      (the "free only" posture; the one that overrode a pin)
 *   CHEAPO                  → MODERATE
 *   NORMAL + prefers_frontier=1 → OPEN       (the "best available" posture)
 *   NORMAL                  → MODERATE
 *   CRITICAL_ONLY           → MODERATE, and it sets the SEPARATE defer_non_critical flag
 *   STRATEGIC_SURGE         → OPEN, and it wants a bypass rather than a lever position
 */
export interface LegacyCostModeTranslation {
  lever: SpendLever;
  deferNonCritical: boolean;
  /** True when the old value meant "lift the caps", which is now a bypass event and not a lever. */
  wantsBypass: boolean;
  note: string;
}

export function translateLegacyCostMode(
  costMode: string,
  honoursPins = true,
  prefersFrontier = false,
): LegacyCostModeTranslation {
  switch (costMode) {
    case "CHEAPO":
      return honoursPins
        ? { lever: "MODERATE", deferNonCritical: false, wantsBypass: false, note: "CHEAPO honouring pins was the 'as cheap as sensible' posture; that is MODERATE." }
        : { lever: "FREE_ONLY", deferNonCritical: false, wantsBypass: false, note: "CHEAPO overriding pins was the 'free only' posture; that is FREE_ONLY." };
    case "CRITICAL_ONLY":
      return {
        lever: "MODERATE",
        deferNonCritical: true,
        wantsBypass: false,
        note: "CRITICAL_ONLY answered 'what work runs at all', which is not a spend level. It is now defer_non_critical, and the lever is MODERATE.",
      };
    case "STRATEGIC_SURGE":
      return {
        lever: "OPEN",
        deferNonCritical: false,
        wantsBypass: true,
        note: "STRATEGIC_SURGE meant 'lift the caps for a while'. That is a bypass with an expiry and a name, not a lever position; the lever is OPEN.",
      };
    default:
      return prefersFrontier
        ? { lever: "OPEN", deferNonCritical: false, wantsBypass: false, note: "NORMAL preferring frontier was the 'best available' posture; that is OPEN." }
        : { lever: "MODERATE", deferNonCritical: false, wantsBypass: false, note: "NORMAL is MODERATE." };
  }
}

/**
 * The `cost_mode` value to write for a lever, so the NOT NULL column stays truthful for any reader
 * that has not been migrated. DERIVED FROM the lever, never consulted by it — the direction of that
 * arrow is the whole separation.
 */
export function legacyCostModeFor(lever: SpendLever): "NORMAL" | "CHEAPO" {
  return lever === "FREE_ONLY" ? "CHEAPO" : "NORMAL";
}

/**
 * THE LEVER A STORED POLICY ROW MEANS — including a row written before the lever existed.
 *
 * `budget_policy` is immutable by trigger, and rightly so: a versioned policy table whose history
 * can be rewritten is not a history. So migration 0179 could not backfill `spend_lever` into older
 * rows, and did not try. They carry NULL, and NULL means "this row predates the lever, read it the
 * old way" — which is exactly what this does, through the same `translateLegacyCostMode` the API
 * uses for a caller still sending `cost_mode`.
 *
 * ONE MAPPING, ONE PLACE. The alternative was a CASE expression in SQL backfilling the column and a
 * copy of the same rules in TypeScript for old API callers — two copies of a mapping, which is the
 * shape of every drift bug in this system.
 */
export function leverFromPolicy(policy: {
  spend_lever?: string | null;
  cost_mode?: string | null;
  honours_pins?: number | null;
  prefers_frontier?: number | null;
}): SpendLever {
  if (policy.spend_lever) return asSpendLever(policy.spend_lever);
  return translateLegacyCostMode(
    policy.cost_mode ?? "NORMAL",
    Number(policy.honours_pins ?? 1) === 1,
    Number(policy.prefers_frontier ?? 0) === 1,
  ).lever;
}

/** Whether a stored policy defers non-critical work, reading a pre-0179 row the old way. */
export function deferNonCriticalFromPolicy(policy: {
  defer_non_critical?: number | null;
  cost_mode?: string | null;
}): boolean {
  if (policy.defer_non_critical !== null && policy.defer_non_critical !== undefined) {
    return Number(policy.defer_non_critical) === 1;
  }
  return policy.cost_mode === "CRITICAL_ONLY";
}
