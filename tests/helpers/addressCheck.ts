import type { Env } from "../../src/worker/env";

/**
 * EVERY ADDRESS NOW PASSES NEVERBOUNCE BEFORE ITS FIRST EMAIL (owner, 26 Oct 2026; services/tlcVolume.ts). A test that
 * is about something else (the weekly email, the gate, the transport) records NeverBounce's "valid" for the fake
 * addresses it queued, exactly as the production check would store it; tests/tlcVolume.test.ts proves the check itself.
 */
export async function addressesPassed(env: Env, at = "2026-10-26T00:00:00.000Z"): Promise<void> {
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_address_check (email, result, source, checked_at) SELECT DISTINCT lower(contact_email), 'valid', 'neverbounce', ?1 FROM tlc_deal",
  ).bind(at).run();
}
