/**
 * READING A FAILED RUN AS A THING SHE CAN FIX (17 Sep 2026).
 *
 * ─── What happened, in production ───────────────────────────────────────────────────────────
 *
 * Parker's card "Draft event kit: October workshop with Kirx Diaz" failed three times over fourteen
 * minutes. Two steps completed on OpenRouter each time; the third routed to the direct Anthropic
 * lane and came back refused — "your credit balance is too low to access the Anthropic API". The
 * step deferred, the card went back in the queue, and the sweep picked it up again minutes later.
 *
 * WHAT THE OWNER SAW WAS "Open · queued — picked up within 5 min". Nothing else. The reason existed
 * only as `failure_reason` on a row in D1, spelled `provider_failure:provider_http_400`, and the
 * actual fix was disabling one provider row. She could not have found either.
 *
 * ─── Why this file exists rather than a string match at one call site ───────────────────────
 *
 * The sweep already had the failure text and already knew how to block a card. What it could not do
 * was tell the DIFFERENCE between "the employee could not think of anything useful" and "a lane
 * refused us" — and those two want completely different blocks, different doors, and a different
 * answer to whether trying again is worth anything. Classification is that difference, kept in one
 * place because the next lane that breaks will break with a different number on it.
 *
 * TRANSIENT IS A DECISION ABOUT RETRYING, NOT A SEVERITY. A rate limit and a 502 clear themselves,
 * so those keep the full three attempts. An empty account and a rejected key do not clear
 * themselves, and burning three model calls and fourteen minutes to prove it is how the owner ended
 * up watching a card say "queued" for a quarter of an hour.
 */

export const LANE_FAILURE_KINDS = ["CREDIT", "CREDENTIAL", "RATE_LIMIT", "LANE_DOWN", "NO_LANE", "NONE"] as const;
export type LaneFailureKind = (typeof LANE_FAILURE_KINDS)[number];

export interface LaneFailure {
  kind: LaneFailureKind;
  /** The provider key where one is named in the failure itself (a missing credential names its vendor). */
  lane: string | null;
  /** The vendor's own sentence, where the adapter captured one. Never shown by default. */
  vendorWords: string;
  /** Whether trying the same lane again could plausibly work. */
  transient: boolean;
}

const NOT_A_LANE_FAILURE: LaneFailure = { kind: "NONE", lane: null, vendorWords: "", transient: true };

/** Words that mean "the account behind this lane has no money", whatever status they arrive with. */
const OUT_OF_CREDIT = /credit balance|insufficient (credit|funds|quota|balance)|payment required|billing|out of credit|quota exceeded|exceeded your current quota/i;
const NOT_SIGNED_IN = /invalid[_ -]?api[_ -]?key|authentication|unauthorized|unauthenticated|forbidden|permission denied/i;

/**
 * Read a run's failure text as a lane failure, or NONE when it is not one.
 *
 * Accepts what the sweep actually holds: `ai_run.failure_reason` (`provider_failure:…`,
 * `provider_disabled:…`, `provider_kill_switched:…`, `credential_missing:…`) or a raw thrown
 * message. Anything it does not recognise is NONE — guessing would put a lane block on a card whose
 * employee simply had nothing useful to say, which is the wrong block addressed to the wrong person.
 */
export function readLaneFailure(detail: string | null | undefined): LaneFailure {
  const text = (detail ?? "").trim();
  if (!text) return NOT_A_LANE_FAILURE;

  const missing = /credential_missing:([a-z0-9_]+)/i.exec(text);
  if (missing) return { kind: "CREDENTIAL", lane: missing[1]!.toLowerCase(), vendorWords: "", transient: false };

  if (/provider_disabled:|provider_kill_switched:|no_enabled_providers|no_capable_provider|no_priced_model/i.test(text)) {
    const named = /provider_(?:disabled|kill_switched):([a-z0-9_]+)/i.exec(text);
    const lane = named && named[1] !== "no" ? named[1]!.toLowerCase() : null;
    return { kind: "NO_LANE", lane: lane && lane !== "all_enabled_providers" ? lane : null, vendorWords: "", transient: false };
  }

  const http = /provider_http_(\d{3})(?::\s*([\s\S]*))?/i.exec(text);
  if (http) {
    const status = Number(http[1]);
    const vendorWords = (http[2] ?? "").trim();
    if (OUT_OF_CREDIT.test(vendorWords) || status === 402) return { kind: "CREDIT", lane: null, vendorWords, transient: false };
    if (status === 429) return { kind: "RATE_LIMIT", lane: null, vendorWords, transient: true };
    if (status === 401 || status === 403 || NOT_SIGNED_IN.test(vendorWords)) return { kind: "CREDENTIAL", lane: null, vendorWords, transient: false };
    if (status >= 500) return { kind: "LANE_DOWN", lane: null, vendorWords, transient: true };
    // Any other 4xx: the lane looked at this particular request and said no. Repeating it verbatim
    // is not a plan, so it does not get three goes.
    return { kind: "LANE_DOWN", lane: null, vendorWords, transient: false };
  }

  if (/provider_malformed_response|provider_timeout|timed out|aborted|network error|fetch failed/i.test(text)) {
    return { kind: "LANE_DOWN", lane: null, vendorWords: "", transient: true };
  }

  return NOT_A_LANE_FAILURE;
}

/** True when the failure is a lane's doing rather than the employee's. */
export function isLaneFailure(f: LaneFailure): boolean {
  return f.kind !== "NONE";
}

/**
 * HOW MANY GOES A LANE FAILURE GETS before the card stops and says so.
 *
 * Three for anything that clears itself; TWO for anything that does not — one retry is enough to
 * prove a dead lane is dead, and the fourteen minutes tonight bought nothing but three identical
 * refusals. Never one: a single failure is still, sometimes, a blip.
 */
export function attemptsAllowedFor(f: LaneFailure, cap: number): number {
  if (!isLaneFailure(f)) return cap;
  return f.transient ? cap : Math.min(2, cap);
}
