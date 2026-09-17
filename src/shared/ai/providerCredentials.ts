/**
 * Which environment variable backs which model vendor — one name per vendor.
 *
 * WHY THIS FILE EXISTS. Until now `credentialNameFor()` returned the single generic name
 * `AI_PROVIDER_API_KEY` for every vendor except OpenRouter and Fireworks. One name shared by five
 * different companies cannot express the only question that matters during an outage: "is Anthropic
 * configured?" It can only answer "is SOMETHING configured?", and the Cockpit was reporting that
 * one boolean five times over — green beside OpenAI because a Perplexity key existed.
 *
 * A vendor with its own name can be configured, and seen to be configured, independently of every
 * other vendor. That is the whole of it.
 *
 * NO VALUE IS EVER READ HERE FOR DISPLAY. `credentialConfigured` returns a boolean; nothing in this
 * module returns, logs, or echoes a secret.
 *
 * BINDINGS ARE NOT CREDENTIALS. Workers AI and Browser Rendering are platform bindings: there is no
 * key, no hostname, and nothing to leak. They are listed in BINDING_BACKED so callers can ask the
 * right question about them (was the binding granted?) instead of the wrong one.
 */

/**
 * Vendor key → the environment variable that holds that vendor's own credential.
 *
 * THESE NAMES ARE NOT FREE CHOICES. They are the names the secrets are already stored under in
 * Cloudflare production (`wrangler secret list --env production`). Renaming one here does not
 * rename the secret; it unconfigures the vendor.
 */
export const PROVIDER_CREDENTIAL_NAME: Readonly<Record<string, string>> = Object.freeze({
  openrouter: "OPENROUTER_API_KEY",
  /*
   * THE FREE LANES SHARE A CREDENTIAL WITH THEIR PAID TWIN, and are separate providers anyway.
   * The thing that differs is the TERMS — a free route is generally free because the provider may
   * train on what it is sent — and terms are a property of the lane, not of the key. So the key is
   * the same one and `provider_data_policy` is what keeps them apart. See migration 0178.
   */
  openrouter_free: "OPENROUTER_API_KEY",
  google_free: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  /*
   * WP_-PREFIXED ON PURPOSE. DO NOT "TIDY" THIS TO `ANTHROPIC_API_KEY`.
   *
   * The owner's credential vault refuses to emit the bare name: `ANTHROPIC_API_KEY` sits on a
   * reserved list with `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
   * `PATH` and `LD_PRELOAD`, because injecting it into a process environment would hijack the
   * owner's own Claude tooling on her machine. The prefix is the fix, not a typo.
   */
  anthropic: "WP_ANTHROPIC_API_KEY",
  /** Not GOOGLE_OAUTH_* — that pair is the calendar client and has nothing to do with Gemini. */
  google: "GEMINI_API_KEY",
  /*
   * NO KEY EXISTS FOR EITHER OF THESE. Both names are declared so the mechanism is ready and the
   * Cockpit can say precisely what is missing; neither provider is enabled, because enabling
   * follows a key existing and never precedes it. See migration 0177.
   */
  perplexity: "PERPLEXITY_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  harvey: "HARVEY_API_KEY",
  norm: "NORM_API_KEY",
});

/**
 * The name every vendor used to share. KEPT WORKING on purpose: it is still read as a fallback for
 * any provider whose own name is unset, so an environment configured before this change keeps
 * behaving exactly as it did. It is no longer what any vendor is REPORTED as using.
 */
export const GENERIC_CREDENTIAL_NAME = "AI_PROVIDER_API_KEY";

/** Providers reached through a platform binding rather than a credential. */
export const BINDING_BACKED: Readonly<Record<string, string>> = Object.freeze({
  workers_ai: "AI",
  cloudflare_browser: "BROWSER",
});

/** The env var name this provider's own credential lives under. */
export function credentialNameFor(providerKey: string): string {
  return PROVIDER_CREDENTIAL_NAME[providerKey] ?? GENERIC_CREDENTIAL_NAME;
}

function readString(env: unknown, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * This provider's credential value, or undefined. Its own name first, the shared legacy name
 * second — so nothing that depended on `AI_PROVIDER_API_KEY` stops working, while anything
 * configured per-vendor wins.
 */
export function credentialValueFor(env: unknown, providerKey: string): string | undefined {
  if (providerKey in BINDING_BACKED) return undefined;
  return readString(env, credentialNameFor(providerKey)) ?? readString(env, GENERIC_CREDENTIAL_NAME);
}

/**
 * Is this provider callable in this environment? A boolean, never a value.
 *
 * For a binding-backed provider this asks whether the platform granted the binding, which is the
 * same question in a different shape.
 */
export function credentialConfigured(env: unknown, providerKey: string): boolean {
  const binding = BINDING_BACKED[providerKey];
  if (binding) return Boolean((env as Record<string, unknown>)[binding]);
  return credentialValueFor(env, providerKey) !== undefined;
}

/**
 * What the Cockpit should say a provider is configured BY. For a binding-backed provider the honest
 * answer is the binding name, not an API key name it does not have.
 */
export function credentialSourceName(providerKey: string): string {
  return BINDING_BACKED[providerKey] ?? credentialNameFor(providerKey);
}
