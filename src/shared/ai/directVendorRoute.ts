/**
 * The same model, by a different road.
 *
 * THE PROBLEM THIS SOLVES. Every LLM call this firm makes goes through OpenRouter, and only
 * OpenRouter: it is the single enabled provider with ACTIVE models. One key expiring, one 429, one
 * bad hour at one company, and the whole firm's AI stops. The owner holds keys for OpenAI,
 * Anthropic and Gemini directly, so the capacity to survive that already exists and was simply not
 * wired to anything.
 *
 * WHY DERIVE THE FALLBACK RATHER THAN REGISTER IT. The obvious approach — add catalogue rows for
 * "the Anthropic model to use when OpenRouter is down" — requires somebody to write down a model
 * id, keep it current, and keep it as good as the primary. Every one of those is a chance to
 * silently downgrade quality: the registered peer ages, or is cheaper, or cannot reason, and
 * nobody notices until an outage serves a partner a worse answer with no sign that anything
 * happened.
 *
 * OpenRouter names models `vendor/model`. `anthropic/claude-sonnet-5` at OpenRouter IS
 * `claude-sonnet-5` at Anthropic — the same weights, the same capabilities, the same price class.
 * So the fallback is DERIVED from the id already chosen, and is by construction not a downgrade:
 * it is the identical model. Nothing to register, nothing to keep in sync, and no second opinion
 * about quality to get wrong.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make these vendors candidates for ordinary
 * routing. They hold no ACTIVE catalogue rows and cannot win a selection; they exist on this path
 * only, and only after the primary has actually failed. Setting a key buys resilience and changes
 * nothing about which model does the firm's work on a normal day.
 */

/** OpenRouter vendor prefixes that map onto a direct provider this system can call itself. */
const DIRECT_VENDOR_FOR_PREFIX: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  perplexity: "perplexity",
  "x-ai": "", // no direct lane; listed so the omission is visible rather than accidental
  meta: "",
  mistralai: "",
  qwen: "",
  deepseek: "",
});

export interface DirectVendorRoute {
  /** provider_key in provider_registry. */
  providerKey: string;
  /** The vendor's own id for the identical model. */
  model: string;
}

/**
 * Given an OpenRouter model id, the same model at its own vendor — or null when there is no direct
 * lane for it (an open-weight model served by OpenRouter has no single vendor to fall back to).
 *
 * A `:` suffix is an OpenRouter routing variant (`:floor`, `:nitro`, `:online`) and is stripped:
 * it describes how OpenRouter picks a host, which is meaningless when talking to the vendor.
 */
export function directVendorRouteFor(openRouterModel: string): DirectVendorRoute | null {
  const slash = openRouterModel.indexOf("/");
  if (slash <= 0) return null;
  const prefix = openRouterModel.slice(0, slash).toLowerCase();
  const rest = openRouterModel.slice(slash + 1).split(":")[0];
  if (!rest) return null;
  const providerKey = DIRECT_VENDOR_FOR_PREFIX[prefix];
  if (!providerKey) return null;
  return { providerKey, model: rest };
}
