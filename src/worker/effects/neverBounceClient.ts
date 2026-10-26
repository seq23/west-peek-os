import { ADDRESS_RESULTS, type AddressResult } from "../../shared/tlc/volume";

/**
 * NEVERBOUNCE: IS THIS ADDRESS REAL? (owner, 26 Oct 2026: "verify before first send; never follow up to a bounce").
 *
 * One read-only GET to NeverBounce's single-check endpoint per address, before Wynn's first email to it. The only
 * thing that leaves is the address itself (a public address printed on the brand's own page). The answer is stored
 * in `tlc_address_check` by services/tlcVolume.ts, so an address is checked once. Inert without the key.
 *
 * Uses prepaid credits already on the account; nothing here buys anything.
 */
export const NEVERBOUNCE_CHECK_URL = "https://api.neverbounce.com/v4.2/single/check";
export const NEVERBOUNCE_TIMEOUT_MS = 15_000;

export type NeverBounceAnswer = { ok: true; result: AddressResult } | { ok: false; detail: string };

export async function neverBounceCheck(apiKey: string | undefined, email: string, fetchImpl: typeof fetch = fetch): Promise<NeverBounceAnswer> {
  if (!apiKey) return { ok: false, detail: "the NeverBounce key is not set on the server" };
  const url = `${NEVERBOUNCE_CHECK_URL}?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email.trim().toLowerCase())}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEVERBOUNCE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return { ok: false, detail: `NeverBounce answered ${res.status}` };
    const body = (await res.json()) as { status?: string; result?: string; message?: string };
    if (body.status !== "success") return { ok: false, detail: `NeverBounce: ${String(body.message ?? body.status ?? "no answer").slice(0, 120)}` };
    const result = String(body.result ?? "").toLowerCase();
    // Anything NeverBounce says that is not one of its known answers is treated as unknown: never sent to.
    return { ok: true, result: (ADDRESS_RESULTS as readonly string[]).includes(result) && result !== "bounced" ? (result as AddressResult) : "unknown" };
  } catch (err) {
    return { ok: false, detail: `NeverBounce did not answer (${err instanceof Error ? err.name : "error"})` };
  } finally {
    clearTimeout(timer);
  }
}
