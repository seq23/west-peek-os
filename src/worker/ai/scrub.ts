/**
 * Credential scrub (P4): no credentials in LLM context, ever.
 *
 * Inputs are scanned for secret-shaped patterns BEFORE any provider call — local
 * or external. A match blocks the run (EGRESS_BLOCKED); the block reason names
 * the pattern class only, never the matched text (a scrub that logs the secret
 * would leak the secret).
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Vendor-shaped API keys (e.g. sk-live-4eC39HqLyjWDarjtT1zdp7dc, sk-proj-…).
  //
  // THE SUFFIX MUST BE ONE UNBROKEN RUN, which is the whole difference between a key and a
  // sentence. The previous form allowed hyphens inside the run, so it matched any hyphenated
  // English beginning with one of these words — `key-for-stock-boost` and `key-spread-flares-out`,
  // both ordinary news-article URL slugs, blocked an entire morning briefing as credential-like
  // content. A scrub that fires on prose does not make the system safer; it trains everyone to
  // route around it.
  //
  // Real vendor keys are a long unbroken alphanumeric run, optionally after one short environment
  // segment (live/test/proj/prod). English words separated by hyphens never reach sixteen
  // unbroken characters, so the two are cleanly separable without weakening detection.
  { name: "vendor_api_key", pattern: /\b(?:sk|pk|key|api)[-_](?:[A-Za-z0-9]{2,8}[-_])?[A-Za-z0-9]{16,}\b/ },
  // Vault-style environment key names (e.g. ANTHROPIC_API_KEY, VAULT_SECRET).
  { name: "vault_key_name", pattern: /\b[A-Z][A-Z0-9_]*(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY)\b/ },
  // Bearer tokens inline.
  { name: "bearer_token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i },
  // Generic secret assignments (api_key = …, token: …, password = …).
  { name: "secret_assignment", pattern: /\b(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i },
  // Wire / banking instruction text.
  { name: "wire_instructions", pattern: /\bwire\s+(?:instructions?|transfer)\b|\brouting\s+number\b|\bswift\s+code\b|\biban\b/i },
];

export interface ScrubResult {
  blocked: boolean;
  /** Pattern class names only — never the matched content. */
  matches: string[];
}

export function scrubInputs(inputs: string[]): ScrubResult {
  const matches = new Set<string>();
  for (const input of inputs) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(input)) matches.add(name);
    }
  }
  return { blocked: matches.size > 0, matches: [...matches] };
}
