/**
 * Is this failure the PROVIDER's, or the REQUEST's?
 *
 * The distinction decides whether failing over to another vendor is honest. An outage — the vendor
 * is down, the key is dead, we were rate-limited, nobody answered — says nothing about the work, so
 * asking a different vendor the same question is the right move. A refusal about the request itself
 * — "I cannot read a PDF", "that data class may not leave" — is a fact about the question, and
 * retrying it elsewhere just finds a second vendor to get it wrong, or worse, one that silently
 * drops the attachment and answers anyway.
 *
 * DEFAULT IS NO. An unrecognised error does not fail over. A failover nobody intended is how a
 * governed call quietly reaches a vendor nobody chose for it, so this list is opt-in and each
 * entry is a named, reproduced failure mode.
 *
 * The five modes the owner asked to see proven, and where each comes from:
 *   · dead key / auth      → `provider_http_401`, `provider_http_403` (two dead keys are in the
 *                            vault right now; a 401 from a configured vendor is not hypothetical)
 *   · no key at all        → `credential_missing:<vendor>` thrown before any network call
 *   · vendor 5xx           → `provider_http_500`…`provider_http_599`
 *   · rate limited         → `provider_http_429`
 *   · timeout / network    → an aborted or failed fetch, in any of the several spellings the
 *                            platform, miniflare and undici each use for it
 */

/** HTTP statuses that mean "this vendor could not serve it", not "this request was wrong". */
export function isOutageStatus(status: number): boolean {
  // 401 is a dead or wrong key. 403 is NOT the same thing and must not be reported as one: a
  // vendor can authenticate you perfectly and still refuse the call. Perplexity answers 403
  // "Sonar is now the Agent API" to a chat-completions request made with a VALID key. Both fail
  // over; they are labelled differently so the Cockpit does not accuse a working key of being bad.
  if (status === 401 || status === 403) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true; // timeout, conflict, retry
  /*
   * 404 IS AN OUTAGE, and this is the one that is not obvious.
   *
   * A vendor answers 404 when it does not serve the model id it was asked for — a retired
   * snapshot, a renamed alias. That is a fact about THAT VENDOR's catalogue, not about the work,
   * so the honest response is to ask the next vendor rather than to fail a partner's request
   * because a model id aged. 400 is deliberately NOT here: a malformed request is malformed
   * everywhere, and spraying it across four vendors finds four ways to be wrong.
   */
  if (status === 404) return true;
  /*
   * 402 PAYMENT REQUIRED IS AN OUTAGE BY DEFINITION. It is the one status whose entire meaning is
   * "this account cannot be served right now", which says nothing whatever about the request.
   */
  if (status === 402) return true;
  return status >= 500 && status <= 599;
}

/**
 * ── A 400 THAT IS NOT OUR FAULT ───────────────────────────────────────────────────────────────
 *
 * CONFIRMED in production on 17 Sep 2026. A partner's work card deferred three times in fourteen
 * minutes on this, and the vendor's own words were:
 *
 *     HTTP 400  "Your credit balance is too low to access the Anthropic API."
 *
 * The key authenticates. The request is perfectly well formed. The account is unfunded — which is
 * an OUTAGE of that lane and tells us nothing at all about the work — and it arrived wearing the
 * status code that means "you sent rubbish".
 *
 * THE RULE, AND WHY IT IS NARROW ON PURPOSE. A 400 still defaults to NOT an outage, because a
 * malformed request is malformed at every vendor and spraying it across four of them finds four
 * ways to be wrong. What changes is that the DECISION IS MADE ON WHAT THE VENDOR SAID, not on the
 * number: a 4xx whose message is a billing, credit, quota or account-status sentence is
 * outage-class and chains to the next lane inside the same run.
 *
 * WHY THIS IS NOT BRITTLE, stated as four properties rather than as a hope:
 *
 *   1. FAILING TO MATCH IS THE SAFE DIRECTION. An unrecognised 400 behaves exactly as it does
 *      today — defer, with the vendor's sentence now visible in `failure_reason` so the next
 *      phrase can be added deliberately. A missed match costs one deferral, which is the status
 *      quo; it never turns a real malformed-request bug into a silent four-vendor retry.
 *   2. THE FRAGMENTS ARE NOUNS, NOT SENTENCES. `credit balance`, `insufficient_quota`,
 *      `billing`, `payment required`, `suspended`. Vendors rewrite the prose around these words
 *      constantly and essentially never rewrite the words themselves, because they are also the
 *      machine-readable `error.code` / `error.type` values their own SDKs switch on.
 *   3. MATCHING IS ON A NORMALISED STRING — lowercased, punctuation and underscores flattened to
 *      spaces — so `insufficient_quota`, `Insufficient Quota` and `insufficient quota` are one
 *      pattern rather than three, and a vendor changing snake_case to Title Case changes nothing.
 *   4. A WRONG MATCH IS CHEAP. The worst case is a genuinely malformed request that happens to
 *      mention billing, which gets tried at a second vendor, fails there identically, and defers
 *      with the same reason a few seconds later. Compare the cost of the miss it replaces: a
 *      partner's card stops for minutes while a funded, working lane sits unused.
 *
 * WHAT IS DELIBERATELY ABSENT. `rate limit` — that is 429's job and a 429 is already an outage;
 * `invalid_request_error` — Anthropic's type for the unfunded case AND for a genuinely malformed
 * body, so it separates nothing; `model` — a 400 naming a model id is usually a real catalogue
 * mistake we want to see, and 404 already covers the vendor-does-not-serve-it case.
 */
const PROVIDER_CANNOT_SERVE_PHRASES: readonly string[] = [
  // Anthropic, verbatim, probed against the live key on 17 Sep 2026:
  // "Your credit balance is too low to access the Anthropic API."
  "credit balance",
  "credits are too low",
  "insufficient credit",
  "insufficient credits",
  "out of credit",
  "no credit remaining",
  // OpenAI / Azure OpenAI: error.type "insufficient_quota", message "You exceeded your current
  // quota, please check your plan and billing details."
  "insufficient quota",
  "exceeded your current quota",
  "quota exceeded",
  "quota exhausted",
  "out of quota",
  // OpenRouter: {"error":{"code":402,"message":"Insufficient credits..."}} and, for a key whose
  // account has lapsed, a 400 carrying "billing".
  "billing",
  "payment required",
  "payment method",
  "add funds",
  "top up",
  // Account state. A suspended or deactivated account cannot serve anyone; it is not our request.
  "account is suspended",
  "account suspended",
  "account deactivated",
  "account is inactive",
  "subscription has expired",
  "plan has expired",
  "spending limit",
  "hard limit",
];

/**
 * Lowercase, and flatten every separator a vendor might use between the same two words. Applied to
 * both sides of the comparison so `insufficient_quota` and `Insufficient Quota` are one string.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does this vendor detail say the PROVIDER cannot serve, rather than that the REQUEST was wrong?
 *
 * Exported so the fixture-free unit tests can enumerate every phrase, and so
 * `scripts/validate/a-lane-that-cannot-serve-must-chain.mjs` can assert the list is actually
 * consulted rather than merely present.
 */
export function vendorCannotServe(detail: string): boolean {
  if (!detail) return false;
  const haystack = normalise(detail);
  if (!haystack) return false;
  return PROVIDER_CANNOT_SERVE_PHRASES.some((phrase) => haystack.includes(normalise(phrase)));
}

/** The phrases, for tests and for the validator. Frozen so nothing can edit the rule at runtime. */
export const providerCannotServePhrases: readonly string[] = Object.freeze([...PROVIDER_CANNOT_SERVE_PHRASES]);

/**
 * Split `provider_http_429:Rate limited by upstream` into its parts. The detail suffix is optional
 * so every reason string written before this change still classifies identically.
 */
export function parseProviderHttpReason(reason: string): { status: number; detail: string } | null {
  const m = /^provider_http_(\d{3})(?::([\s\S]*))?$/.exec(reason);
  if (!m) return null;
  return { status: Number(m[1]), detail: (m[2] ?? "").trim() };
}

const TIMEOUT_OR_NETWORK =
  /(aborted|abort ?error|timed? ?out|timeout|etimedout|econnreset|econnrefused|enotfound|fetch failed|network (?:error|connection lost)|failed to fetch|socket hang up)/i;

/**
 * True when the router may try the next vendor. `reason` is the message `executeAttempt` caught.
 */
export function isProviderOutage(reason: string): boolean {
  if (!reason) return false;
  // A capability refusal is ABOUT THE REQUEST. Listed first so nothing below can overturn it.
  if (/^provider_cannot_/.test(reason)) return false;
  if (/^credential_missing:/.test(reason)) return true;
  if (/^workers_ai_binding_absent/.test(reason)) return true;
  // A vendor that answered with something we cannot parse has not served the call either. This is
  // how the Workers AI lane failed for weeks — malformed every time, on every run.
  if (reason === "provider_malformed_response") return true;
  const http = parseProviderHttpReason(reason);
  if (http) {
    if (isOutageStatus(http.status)) return true;
    /*
     * The narrow case this whole module was revised for: a 4xx the vendor used to say IT cannot
     * serve. 5xx is already an outage above, and a 3xx is not a failure, so the widening is
     * confined to the statuses that otherwise mean "your request was wrong".
     */
    if (http.status >= 400 && http.status < 500) return vendorCannotServe(http.detail);
    return false;
  }
  return TIMEOUT_OR_NETWORK.test(reason);
}

/** A short, stable label for the routing record, so "why did we fail over?" reads at a glance. */
export function outageKind(reason: string): string {
  if (/^credential_missing:/.test(reason)) return "NO_CREDENTIAL";
  if (/^workers_ai_binding_absent/.test(reason)) return "BINDING_ABSENT";
  if (reason === "provider_malformed_response") return "MALFORMED_RESPONSE";
  const http = parseProviderHttpReason(reason);
  if (http) {
    const status = http.status;
    /*
     * NAMED SEPARATELY FROM EVERY OTHER OUTAGE, and the name is the point. "Anthropic 400" on the
     * Cockpit sends somebody to read our request; PROVIDER_OUT_OF_CREDIT sends them to the billing
     * page, which is where the fix actually is.
     */
    if (status === 402 || (status >= 400 && status < 500 && !isOutageStatus(status) && vendorCannotServe(http.detail))) {
      return "PROVIDER_OUT_OF_CREDIT";
    }
    if (status === 401) return "AUTH_REJECTED";
    if (status === 403) return "REFUSED_BY_VENDOR";
    if (status === 429) return "RATE_LIMITED";
    if (status === 404) return "MODEL_NOT_SERVED";
    if (status >= 500) return "VENDOR_ERROR";
    return `HTTP_${status}`;
  }
  if (TIMEOUT_OR_NETWORK.test(reason)) return "TIMEOUT_OR_NETWORK";
  return "NOT_AN_OUTAGE";
}
