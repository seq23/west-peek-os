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
  // Vendor-shaped API keys (e.g. sk-…, key-…).
  { name: "vendor_api_key", pattern: /\b(?:sk|pk|key|api)-(?:live|test|prod-)?[A-Za-z0-9_-]{12,}\b/ },
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
