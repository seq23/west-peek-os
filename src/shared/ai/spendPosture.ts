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
  },
  {
    key: "CHEAP",
    label: "As cheap as sensible",
    what: "Open models for everything routine. The morning brief keeps its frontier model.",
    cost: "Pennies a day. Routine work is roughly forty times cheaper than a frontier model, or free.",
    tradeoff: "Employees working cards will be less sharp than they are today.",
    costMode: "CHEAPO",
    honoursPins: true,
  },
  {
    key: "BALANCED",
    label: "Balanced",
    what: "Anything pinned for quality keeps its model; everything else takes the cheapest adequate one.",
    cost: "A few tens of cents a day at current volume.",
    tradeoff: "None worth naming. This is the setting to leave it on.",
    costMode: "NORMAL",
    honoursPins: true,
  },
  {
    key: "BEST",
    label: "Best available",
    what: "Frontier models everywhere, including work that does not really need one.",
    cost: "Several times Balanced, for a difference you will mostly not notice.",
    tradeoff: "You are paying frontier rates to route a capture and re-file an agenda item.",
    costMode: "NORMAL",
    honoursPins: true,
  },
];

export function postureDef(key: string): PostureDef {
  return SPEND_POSTURES.find((p) => p.key === key) ?? SPEND_POSTURES[2]!;
}

/**
 * Which posture a stored policy corresponds to.
 *
 * `cost_mode` alone cannot distinguish FREE from CHEAP — they share CHEAPO and differ only in
 * whether pins survive — so the pin behaviour is stored beside it. Older policies with nothing
 * stored read as BALANCED, which is what they behaved as.
 */
export function postureFor(costMode: string, honoursPins: boolean): SpendPosture {
  if (costMode === "CHEAPO") return honoursPins ? "CHEAP" : "FREE";
  return "BALANCED";
}
