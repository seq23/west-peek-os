import type { Env } from "../env";

/**
 * Live Network OS client (P35, V1 #12).
 *
 * WHAT THE 503 ACTUALLY WAS. The audit assumed the live pull failed for one of config, credentials,
 * or the far end being down. It was none of them: `configuredClient()` returned `null`
 * unconditionally, so every live call answered 503 "adapter_unconfigured" by construction. The
 * client had never been written. Worth recording, because "fails closed correctly" read like a
 * working integration waiting on a credential, and it was a stub.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Canon §12A.2 gives Network OS the person and organization
 * records, contact fields, touchpoints and community membership fields. Relationship OS (§12A.3)
 * and Community OS (§12A.4) are both INTERPRETATION over that population — they own judgement and
 * segmentation, never the contact. So until this pull works, both of those modules are lenses over
 * an empty table.
 *
 * HOW IT AUTHENTICATES, and why this shape. Network OS accepts a `wpn_session` cookie: a
 * base64url JSON payload plus an HMAC-SHA256 signature over it, keyed by its APP_SESSION_SECRET.
 * Its only other path is an `x-west-peek-user-email` header restricted to local operator requests,
 * which a Worker calling across the internet can never satisfy. So this client mints the same
 * signed session Network OS issues to a browser.
 *
 * That means West Peek OS holds Network OS's session secret. It is real coupling and worth naming:
 * the alternative was adding a service-token endpoint to the Network OS repo, which would have
 * meant changing a second, already-deployed system to make this one work. Minting the existing
 * token uses the auth path that is already live and proven, and needs no change over there at all.
 * If that trade stops being acceptable, the fix is a service token in Network OS, not a workaround
 * here.
 *
 * NEVER WRITES. Read-only by construction — there is no POST in this file. Canon §12A.5 puts
 * writeback behind its own law and approval path, and a pull client that could also push would be
 * one bug away from mutating the firm's system of record.
 */

const SNAPSHOT_PATH = "/api/sheets/snapshot";
const TIMEOUT_MS = 15_000;

/** Tabs Network OS returns. Only the ones West Peek OS has a use for are mapped. */
export interface NetworkSnapshot {
  contacts: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  event_attendees: Array<Record<string, unknown>>;
  relationship_touches: Array<Record<string, unknown>>;
}

export interface NetworkPullResult {
  ok: boolean;
  snapshot: NetworkSnapshot | null;
  /** Why it did not work, phrased for whoever has to fix it. */
  detail: string;
  /** Echoed from Network OS so a stale cached read is visible rather than silent. */
  source: string | null;
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint the session cookie value Network OS expects. Byte-compatible with its own
 * createSignedValue(): base64url(JSON payload) + "." + base64url(HMAC-SHA256 over that string).
 */
export async function mintSession(secret: string, email: string): Promise<string> {
  const payload = base64Url(JSON.stringify({ email: email.toLowerCase() }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlBytes(new Uint8Array(sig))}`;
}

/** Both the address and the secret are required; either alone cannot reach anything. */
export function networkOsConfigured(env: Env): boolean {
  return Boolean(env.WP_OS_NETWORK_OS_BASE_URL && env.WP_OS_NETWORK_OS_SESSION_SECRET && env.WP_OS_NETWORK_OS_USER_EMAIL);
}

/** Precisely which piece is missing — a generic "unconfigured" is what wasted time before. */
export function networkOsBlockedReason(env: Env): string | null {
  if (!env.WP_OS_NETWORK_OS_BASE_URL) return "WP_OS_NETWORK_OS_BASE_URL is not set (the Network OS origin).";
  if (!env.WP_OS_NETWORK_OS_SESSION_SECRET) return "WP_OS_NETWORK_OS_SESSION_SECRET is not set (Network OS APP_SESSION_SECRET).";
  if (!env.WP_OS_NETWORK_OS_USER_EMAIL) return "WP_OS_NETWORK_OS_USER_EMAIL is not set (must be an approved Network OS user).";
  return null;
}

/**
 * Read the current snapshot. Returns a result rather than throwing on an expected failure —
 * unconfigured and unreachable are both normal states the adapter records as a receipt, not
 * exceptions to bubble up.
 */
export async function pullSnapshot(env: Env, fetchImpl: typeof fetch = fetch): Promise<NetworkPullResult> {
  const blocked = networkOsBlockedReason(env);
  if (blocked) return { ok: false, snapshot: null, detail: blocked, source: null };

  const base = env.WP_OS_NETWORK_OS_BASE_URL!.replace(/\/+$/, "");
  const session = await mintSession(env.WP_OS_NETWORK_OS_SESSION_SECRET!, env.WP_OS_NETWORK_OS_USER_EMAIL!);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // fresh=1 so a sync reads current state rather than Network OS's 45-second snapshot cache;
    // a sync receipt recording stale rows would be worse than a slower call.
    const res = await fetchImpl(`${base}${SNAPSHOT_PATH}?fresh=1`, {
      method: "GET",
      headers: { cookie: `wpn_session=${session}`, accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 401) {
      return {
        ok: false, snapshot: null, source: null,
        detail: "Network OS rejected the session. The secret may be wrong, or the email is not on its approved-users list.",
      };
    }
    if (!res.ok) {
      return { ok: false, snapshot: null, source: null, detail: `Network OS returned HTTP ${res.status}.` };
    }

    const body = (await res.json()) as { ok?: boolean; error?: string; source?: string; data?: Record<string, unknown[]> };
    if (!body.ok || !body.data) {
      return { ok: false, snapshot: null, source: body.source ?? null, detail: body.error ?? "Network OS returned no data." };
    }

    const tab = (name: string) => (Array.isArray(body.data![name]) ? (body.data![name] as Array<Record<string, unknown>>) : []);
    return {
      ok: true,
      source: body.source ?? null,
      detail: "ok",
      snapshot: {
        contacts: tab("contacts"),
        events: tab("events"),
        event_attendees: tab("event_attendees"),
        relationship_touches: tab("relationship_touches"),
      },
    };
  } catch (err) {
    const detail = err instanceof Error && err.name === "AbortError"
      ? `Network OS did not respond within ${TIMEOUT_MS / 1000}s.`
      : `Could not reach Network OS: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, snapshot: null, source: null, detail };
  } finally {
    clearTimeout(timer);
  }
}
