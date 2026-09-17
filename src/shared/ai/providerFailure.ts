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
  if (status === 401 || status === 403) return true; // dead or wrong key
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
  return status >= 500 && status <= 599;
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
  const http = /^provider_http_(\d{3})$/.exec(reason);
  if (http) return isOutageStatus(Number(http[1]));
  return TIMEOUT_OR_NETWORK.test(reason);
}

/** A short, stable label for the routing record, so "why did we fail over?" reads at a glance. */
export function outageKind(reason: string): string {
  if (/^credential_missing:/.test(reason)) return "NO_CREDENTIAL";
  if (/^workers_ai_binding_absent/.test(reason)) return "BINDING_ABSENT";
  if (reason === "provider_malformed_response") return "MALFORMED_RESPONSE";
  const http = /^provider_http_(\d{3})$/.exec(reason);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return "AUTH_REJECTED";
    if (status === 429) return "RATE_LIMITED";
    if (status === 404) return "MODEL_NOT_SERVED";
    if (status >= 500) return "VENDOR_ERROR";
    return `HTTP_${status}`;
  }
  if (TIMEOUT_OR_NETWORK.test(reason)) return "TIMEOUT_OR_NETWORK";
  return "NOT_AN_OUTAGE";
}
