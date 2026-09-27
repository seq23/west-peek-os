import type { RingSlice } from "@shared/fund/allocation";
import { typeWord } from "./typeWords";

/**
 * The community's shape as RING SLICES — the pure half of the Community chart pass (27 Sep 2026,
 * "hero row + two rings").
 *
 * WHY THIS IS A MODULE AND NOT PAGE CODE. The page hosts AllocationRing twice and must not draw
 * anything itself; what it passes in decides whether a person is counted, folded or left out. That
 * decision is testable only if it lives apart from JSX, and it needs to be tested: on 27 Sep 2026
 * the page showed seven tiles and the biggest of them, 4,571 people, was a category Network OS
 * had not yet placed. Read as "the community", that number says the firm knows 4,712 people.
 * Read honestly, it says the firm can name a role for 141 of them and the survey fills in the rest.
 *
 * THE ONE RULE OF COLOUR: four validated slots in fixed order (`--viz-1..4`), assigned by rank of
 * count and never cycled; whatever ranks fifth or lower folds into ONE "Other" slice that says
 * what it holds. A fifth hue would be a hue nobody validated.
 */

export interface PopulationSlice {
  key: string;
  count: number;
  /** Share of the WHOLE community, one decimal, as the endpoint computed it. */
  pct: number;
}

/** The categories that mean "Network OS has not placed this person" — never in the placed ring. */
export const UNPLACED_KEYS = ["general_tech_adjacent", "unknown"] as const;

/** The four validated categorical slots, in the order they are assigned. Never a fifth. */
export const VIZ_SLOTS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)"] as const;

/** The neutral the fold wears: it is "everyone else", not a fifth series. */
export const OTHER_COLOR = "var(--wp-line-strong)";

/** Plain words for the touch-recency buckets communityOs.ts computes in SQL. */
export const RECENCY_WORDS: Record<string, string> = {
  recent: "heard from us in the last 90 days",
  fading: "not in 3–12 months",
  cold: "not in over a year",
  never: "never recorded a touch",
};

/** Short labels for the same buckets — the legend row; the sentence above is its note. */
export const RECENCY_LABELS: Record<string, string> = {
  recent: "Recent",
  fading: "Fading",
  cold: "Cold",
  never: "Never",
};

/** The warmth ring's fixed order and colours: warm in the accent and gold, the rest in neutrals. */
export const WARMTH_ORDER: ReadonlyArray<{ key: string; color: string }> = [
  { key: "recent", color: "var(--viz-1)" },
  { key: "fading", color: "var(--viz-3)" },
  { key: "cold", color: "var(--wp-line-strong)" },
  { key: "never", color: "var(--wp-line)" },
];

/** The two buckets that count as warm. */
export const WARM_KEYS = ["recent", "fading"] as const;

const isUnplaced = (key: string): boolean => (UNPLACED_KEYS as readonly string[]).includes(key.toLowerCase());

const share = (pct: number): string => `${pct}% of everyone`;

export interface PlacedShape {
  /** What the ring draws: up to four ranked slices, then one fold. */
  slices: RingSlice[];
  /** People with a role the firm can name — the ring's total. */
  placed: number;
  /** The categories left out of the ring, reported beside it rather than hidden. */
  unplaced: Array<{ key: string; count: number; pct: number }>;
}

/**
 * "Who the firm can place": every category except the unplaced ones, ranked by count, the top four
 * in the fixed slots and the rest folded into "Other" whose note lists what it holds.
 */
export function placedSlices(byType: PopulationSlice[]): PlacedShape {
  const ranked = byType
    .filter((s) => s.count > 0 && !isUnplaced(s.key))
    .slice()
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const unplaced = byType.filter((s) => isUnplaced(s.key)).map((s) => ({ key: s.key, count: s.count, pct: s.pct }));

  const head = ranked.slice(0, VIZ_SLOTS.length);
  const tail = ranked.slice(VIZ_SLOTS.length);

  const slices: RingSlice[] = head.map((s, i) => ({
    key: s.key,
    label: typeWord(s.key),
    usd: s.count,
    color: VIZ_SLOTS[i]!,
    note: share(s.pct),
  }));

  if (tail.length > 0) {
    const count = tail.reduce((n, s) => n + s.count, 0);
    const pct = Math.round(tail.reduce((n, s) => n + s.pct, 0) * 10) / 10;
    const holds = tail.map((s) => `${typeWord(s.key).toLowerCase()} ${s.count.toLocaleString()}`).join(" · ");
    slices.push({ key: "other", label: "Other", usd: count, color: OTHER_COLOR, note: `${holds} — ${share(pct)}` });
  }

  return { slices, placed: ranked.reduce((n, s) => n + s.count, 0), unplaced };
}

export interface WarmthShape {
  /** All four buckets in fixed order, zeros included — an empty bucket is a fact, not a gap. */
  slices: RingSlice[];
  /** recent + fading. */
  warm: number;
  /** Everyone: the ring's geometry needs the sum of its slices. */
  total: number;
}

/** "How warm it is": the four recency buckets in fixed order with the warm count beside them. */
export function warmthSlices(touchRecency: PopulationSlice[]): WarmthShape {
  const byKey = new Map(touchRecency.map((s) => [s.key.toLowerCase(), s] as const));
  const slices: RingSlice[] = WARMTH_ORDER.map(({ key, color }) => {
    const s = byKey.get(key);
    return {
      key,
      label: RECENCY_LABELS[key] ?? key,
      usd: s?.count ?? 0,
      color,
      note: RECENCY_WORDS[key] ?? key,
    };
  });
  const total = slices.reduce((n, s) => n + s.usd, 0);
  const warm = slices.filter((s) => (WARM_KEYS as readonly string[]).includes(s.key)).reduce((n, s) => n + s.usd, 0);
  return { slices, warm, total };
}

export interface HeroCounts {
  people: number;
  /** Sum of by_type minus the unplaced categories. */
  placeable: number;
  /** recent + fading. */
  warm: number;
  /** deal_flow = yes. */
  prospects: number;
  /** deal_flow = unknown — nobody has asked them yet. */
  notAsked: number;
}

/** The four numbers on the hero row, each derived once so the tiles and the rings cannot disagree. */
export function heroCounts(pop: {
  total: number;
  by_type: PopulationSlice[];
  deal_flow: PopulationSlice[];
  touch_recency: PopulationSlice[];
}): HeroCounts {
  const count = (rows: PopulationSlice[], key: string): number =>
    rows.filter((s) => s.key.toLowerCase() === key).reduce((n, s) => n + s.count, 0);
  return {
    people: pop.total,
    placeable: placedSlices(pop.by_type).placed,
    warm: warmthSlices(pop.touch_recency).warm,
    prospects: count(pop.deal_flow, "yes"),
    notAsked: count(pop.deal_flow, "unknown"),
  };
}
