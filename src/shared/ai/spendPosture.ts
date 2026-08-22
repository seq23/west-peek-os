/**
 * How much the firm is willing to spend, as one control.
 *
 * OPERATOR DIRECTION: "is there still a lever for me to drag to get us the cheapest closest to $0
 * possible of all usage and i can adj higher if i dont mind spending more?"
 *
 * There was a lever — `cost_mode` — and it was useless for two reasons. It had nowhere cheap to go,
 * because the cheapest registered model was gemini-1.5-flash at $0.075 per million tokens. And it
 * did not apply to the only two things that actually run: the morning brief and employee work are
 * both PINNED by routing policy, and a pin beat cost mode outright. So dragging it changed nothing.
 *
 * Both are fixed. Workers AI gives the cheap end somewhere genuinely cheap — free, inside the daily
 * neuron allowance — and the postures below state what they do to a pin instead of ignoring it.
 *
 * WHY OVERRIDING A PIN IS STATED AND NOT HIDDEN. The brief is pinned to a frontier model because
 * the cheap tier once produced "the 30-year U.S. tax at 19 year high" and shipped it as fact. A
 * lever that quietly undid that would recreate exactly that failure, on the page the partners read
 * first, with nothing to explain it. So the cheapest posture says plainly that the brief gets worse,
 * and the one above it protects it.
 */

export type SpendPosture = "FREE" | "CHEAP" | "BALANCED" | "BEST";

export interface PostureDef {
  key: SpendPosture;
  label: string;
  /** What it does, in the operator's words. */
  what: string;
  /** What it costs — or does not. */
  cost: string;
  /** The honest downside. Every one of these has one. */
  tradeoff: string;
  /** The cost_mode this maps to in the existing policy. */
  costMode: "NORMAL" | "CHEAPO" | "CRITICAL_ONLY";
  /** Whether a routing pin still wins. This is the half that was missing. */
  honoursPins: boolean;
  /**
   * Which way to lean when NOTHING has been pinned. This is the half that was missing from the
   * expensive end, and its absence made two of the four postures the same policy — see below.
   */
  prefersFrontier: boolean;
}

export const SPEND_POSTURES: readonly PostureDef[] = [
  {
    key: "FREE",
    label: "Free only",
    what: "Everything runs on the open models included with Cloudflare — Llama, Qwen, Granite.",
    cost: "$0 inside the daily allowance of 10,000 neurons, which covers a lot of small work.",
    tradeoff:
      "The morning brief gets noticeably worse. It is pinned to a frontier model because the cheap " +
      "tier once invented a market figure and stated it as fact — this posture removes that protection.",
    costMode: "CHEAPO",
    honoursPins: false,
    prefersFrontier: false,
  },
  {
    key: "CHEAP",
    label: "As cheap as sensible",
    what: "Open models for everything routine. The morning brief keeps its frontier model.",
    cost: "Pennies a day. Routine work is roughly forty times cheaper than a frontier model, or free.",
    tradeoff: "Employees working cards will be less sharp than they are today.",
    costMode: "CHEAPO",
    honoursPins: true,
    prefersFrontier: false,
  },
  {
    key: "BALANCED",
    label: "Balanced",
    what: "Anything pinned for quality keeps its model; everything else takes the cheapest adequate one.",
    cost: "A few tens of cents a day at current volume.",
    tradeoff: "None worth naming. This is the setting to leave it on.",
    costMode: "NORMAL",
    honoursPins: true,
    prefersFrontier: false,
  },
  /*
   * KEPT, AND MADE TO MEAN SOMETHING. Reported by the operator: choosing this wrote a policy row
   * byte-identical to Balanced — same cost_mode, same pin behaviour — and the page then showed
   * "Balanced" as current, because nothing stored could tell them apart. Two choices, one policy.
   *
   * The argument for DELETING it was real: its own downside line admits you are paying frontier
   * rates to re-file an agenda item. The argument that won is the operator's original ask, which is
   * quoted at the top of this file — "i can adj higher if i dont mind spending more". Removing this
   * removes the half of the lever she asked for and leaves the top of the range at Balanced, so the
   * control would still be lying, just more quietly. So it stays and it now does the one thing its
   * label promises: where nothing has been pinned, take the best model instead of the cheapest.
   *
   * Pins are still honoured. A pin is already somebody's per-task quality decision; overriding one
   * from the expensive end would mean this posture could make the morning brief WORSE, which is
   * absurd for a setting called "best available".
   */
  {
    key: "BEST",
    label: "Best available",
    what: "Work nobody has pinned takes the strongest model instead of the cheapest. Pinned work keeps its model.",
    cost: "Several times Balanced. Routine work costs frontier rates instead of nearly nothing.",
    tradeoff: "You are paying frontier rates to route a capture and re-file an agenda item.",
    costMode: "NORMAL",
    honoursPins: true,
    prefersFrontier: true,
  },
];

export function postureDef(key: string): PostureDef {
  return SPEND_POSTURES.find((p) => p.key === key) ?? SPEND_POSTURES[2]!;
}

/**
 * Which posture a stored policy corresponds to.
 *
 * `cost_mode` alone cannot distinguish any of these. FREE and CHEAP share CHEAPO and differ only in
 * whether pins survive; BALANCED and BEST share NORMAL and differ only in which way unpinned work
 * leans. Both of those extra bits are stored beside the mode, so this is a lookup rather than a
 * guess. Older policies carrying neither read as BALANCED, which is what they behaved as.
 */
export function postureFor(costMode: string, honoursPins: boolean, prefersFrontier = false): SpendPosture {
  if (costMode === "CHEAPO") return honoursPins ? "CHEAP" : "FREE";
  return prefersFrontier ? "BEST" : "BALANCED";
}
