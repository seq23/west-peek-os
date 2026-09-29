/**
 * WHICH VENDOR'S MODEL IS THIS, FOR THE ORDER OF LAST RESORT? (29 Sep 2026)
 *
 * The owner's ladder for work that needs a strong model ends "… paid Sonnet, Anthropic direct, then
 * OpenAI". The chain already puts the head (Sonnet) and its direct peer first; what came after was
 * "any other adequate lane, working lanes first, cheapest first" — which, with `gpt-5-mini` at
 * $0.25 in and Gemini flash-lite at $0.10, meant the cheap lanes of three vendors in whatever order
 * their price happened to fall, with OpenAI neither second nor guaranteed.
 *
 * So the leftover lanes are ranked by FAMILY first: Claude, then OpenAI, then everything else,
 * keeping the order they already had inside each family (health and price still decide there). It
 * is a stable sort of a list that has already passed every capability, reasoning, search and privacy
 * filter, so it can only re-order lanes that were all going to be tried, never add one.
 *
 * ONLY FOR JUDGEMENT WORK. Mechanical work at its last resort should still take the cheapest lane;
 * making a URL check fall back to Haiku ahead of a $0.10 model would spend money on the kind of
 * call the owner wants cheap. The caller applies this only when the call is protected.
 */

export type VendorFamily = "CLAUDE" | "OPENAI" | "OTHER";

const RANK: Readonly<Record<VendorFamily, number>> = { CLAUDE: 0, OPENAI: 1, OTHER: 2 };

/** Family from the lane's provider key and model id (OpenRouter names models `vendor/model`). */
export function vendorFamilyOf(providerKey: string | undefined, model: string): VendorFamily {
  const prefix = model.includes("/") ? model.slice(0, model.indexOf("/")).toLowerCase() : "";
  if (providerKey === "anthropic" || prefix === "anthropic" || /^claude[-.]/i.test(model)) return "CLAUDE";
  if (providerKey === "openai" || prefix === "openai") return "OPENAI";
  return "OTHER";
}

/** Stable: within a family the incoming order (lane health, then price) is untouched. */
export function orderByVendorFamily<T extends { providerKey?: string; model: string }>(lanes: readonly T[]): T[] {
  return [...lanes].sort((a, b) => RANK[vendorFamilyOf(a.providerKey, a.model)] - RANK[vendorFamilyOf(b.providerKey, b.model)]);
}
