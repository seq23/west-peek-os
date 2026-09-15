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
 * IT NOW PROPOSES, AND THAT IS NOT THE SAME AS WRITING. This file was read-only by construction,
 * with the note that a pull client which could also push would be one bug away from mutating the
 * firm's system of record. That reasoning still holds and is why the one write here targets Network
 * OS's INTAKE QUEUE rather than its contact table: the far end still decides. Everything governing
 * it — the reserved `network_os.writeback` action, the MP approval receipt, single-use idempotency,
 * and a receipt on refusal and failure alike — was already built in `networkAdapter.ts` and is
 * unchanged. What was missing was only the last call.
 */

const SNAPSHOT_PATH = "/api/sheets/snapshot";

/**
 * Network OS's intake queue. Deliberately NOT `/api/contacts/create`.
 *
 * Operator direction, 21 Aug 2026: "the capture tab needs to integrate also with network OS and
 * allow new people to go the other way and go into the network OS database."
 *
 * They go in as a PROPOSAL. Network OS owns the contact record; this app proposing somebody must
 * not be the same act as this app writing them. `/api/intake/create` appends to the queue a human
 * reviews over there, which keeps exactly one system able to say who is a member — the thing the
 * whole boundary exists to protect. `/api/contacts/create` would have been one line shorter and
 * would have made West Peek OS a second writer of the firm's relationship record.
 */
const INTAKE_PATH = "/api/intake/create";
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

export interface NetworkProbe {
  reachable: boolean;
  /** One sentence an operator can act on, never a stack trace and never a secret. */
  detail: string;
}

/**
 * Ask Network OS whether it is there and whether it accepts us — and read NOTHING.
 *
 * WHY THIS IS NOT `pullSnapshot`. A pull is gated on `network_sync.pull` because it brings the
 * firm's relationship record across the boundary. A status page must not need that authority just
 * to answer "is it on?", and it must not quietly acquire the data as a side effect of asking. So
 * this mints the same session, makes the same request, reads the STATUS LINE, and cancels the body
 * before a single contact is parsed. No contact data enters this system on this path.
 *
 * The three answers are deliberately distinct because they have three different fixes: unreachable
 * is the far end or the network, 401 is the secret or the approved-user list, and any other HTTP
 * code is Network OS itself having a problem. "Not configured" collapsing all of those into one
 * sentence is exactly the thing that wasted a day.
 */
export async function probeNetworkOs(env: Env, fetchImpl: typeof fetch = fetch): Promise<NetworkProbe> {
  const blocked = networkOsBlockedReason(env);
  if (blocked) return { reachable: false, detail: blocked };

  const base = env.WP_OS_NETWORK_OS_BASE_URL!.replace(/\/+$/, "");
  const session = await mintSession(env.WP_OS_NETWORK_OS_SESSION_SECRET!, env.WP_OS_NETWORK_OS_USER_EMAIL!);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}${SNAPSHOT_PATH}`, {
      method: "GET",
      headers: { cookie: `wpn_session=${session}`, accept: "application/json" },
      signal: controller.signal,
    });
    // Cancelled, not read: this call is allowed to learn the status code and nothing else.
    await res.body?.cancel().catch(() => undefined);

    if (res.status === 401 || res.status === 403) {
      return {
        reachable: true,
        detail: `Network OS answered but rejected us (HTTP ${res.status}). Either the session secret does not match Network OS's APP_SESSION_SECRET, or ${env.WP_OS_NETWORK_OS_USER_EMAIL} is not on its approved-users list.`,
      };
    }
    if (!res.ok) return { reachable: true, detail: `Network OS answered with HTTP ${res.status}, which is a problem on its side.` };
    return { reachable: true, detail: `Network OS answered and accepted us as ${env.WP_OS_NETWORK_OS_USER_EMAIL}. Contacts, relationships and touches can be pulled.` };
  } catch (err) {
    const detail = err instanceof Error && err.name === "AbortError"
      ? `Network OS did not answer within ${TIMEOUT_MS / 1000}s.`
      : `Could not reach Network OS: ${err instanceof Error ? err.message : String(err)}`;
    return { reachable: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the current snapshot. Returns a result rather than throwing on an expected failure —
 * unconfigured and unreachable are both normal states the adapter records as a receipt, not
 * exceptions to bubble up.
 */
export async function pullSnapshot(env: Env, fetchImpl: typeof fetch = fetch, opts: { since?: string | null } = {}): Promise<NetworkPullResult> {
  const blocked = networkOsBlockedReason(env);
  if (blocked) return { ok: false, snapshot: null, detail: blocked, source: null };

  const base = env.WP_OS_NETWORK_OS_BASE_URL!.replace(/\/+$/, "");
  const session = await mintSession(env.WP_OS_NETWORK_OS_SESSION_SECRET!, env.WP_OS_NETWORK_OS_USER_EMAIL!);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // fresh=1 so a sync reads current state rather than Network OS's 45-second snapshot cache;
    // a sync receipt recording stale rows would be worse than a slower call.
    // ONLY THE TWO TABS THIS READS. The snapshot used to be asked for whole — eight tabs, every
    // row parsed and re-keyed in one Network OS invocation — and on 14 Sep 2026 that crossed the
    // Free plan's CPU limit: every pull for two hours answered 503 / Cloudflare error 1102.
    // ONLY WHAT CHANGED SINCE THE LAST COMPLETE PASS. 4,712 contacts is megabytes of JSON parsed
    // every fifteen minutes to learn nothing is new — 107 ms of CPU (15 Sep 2026). With `since`,
    // Network OS keeps the rows updated at or after it; a quiet quarter-hour is a few bytes.
    const since = opts.since ? `&since=${encodeURIComponent(opts.since)}` : "";
    const res = await fetchImpl(`${base}${SNAPSHOT_PATH}?fresh=1&tabs=contacts,relationship_touches${since}`, {
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
      // NETWORK OS SAYS WHY IN ITS BODY — "Google Sheets …", a quota, a token — and dropping it
      // left the Jobs page reading "HTTP 503" three times on 14 Sep while the actual reason was one
      // parse away. Carried through, bounded, never the whole body (it can be large).
      let why = "";
      const text = await res.text().catch(() => "");
      try {
        const err = JSON.parse(text) as { error?: string };
        if (typeof err.error === "string") why = err.error.slice(0, 300);
      } catch {
        // Not Network OS's JSON — then it is the platform's page (a Worker over its resource
        // limit answers 503 with HTML). The first words of it are the reason.
        why = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
        const code = res.headers.get("cf-error-code") ?? res.headers.get("cf-ray");
        if (code) why = `${why} [cf ${code}]`.trim();
      }
      return { ok: false, snapshot: null, source: null, detail: `Network OS returned HTTP ${res.status}${why ? `: ${why}` : "."}` };
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


/**
 * Propose a person to Network OS's intake queue, using the operator's own trigger.
 *
 * Network OS parses `key: value` lines out of free text and requires a recognised trigger word, so
 * the message is composed in exactly the shape a person would have typed into an email — which is
 * also why the same call will serve the `#wpnetwork` half of inbound mail to os@westpeek.ventures
 * without a second code path.
 */
export const NETWORK_TRIGGER = "#wpnetwork";

/** The field names Network OS's `parseFields` recognises. Anything else is carried as free text. */
export interface ProposedPerson {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  context?: string | null;
}

export function composeIntakeText(person: ProposedPerson, trigger: string = NETWORK_TRIGGER): string {
  const lines = [trigger, `Name: ${person.name}`];
  if (person.email) lines.push(`Email: ${person.email}`);
  if (person.phone) lines.push(`Phone: ${person.phone}`);
  if (person.company) lines.push(`Company: ${person.company}`);
  if (person.title) lines.push(`Title: ${person.title}`);
  if (person.context) lines.push(`Context: ${person.context}`);
  // Named so a reviewer in Network OS can see where it came from without asking.
  lines.push("Source: West Peek OS capture");
  return lines.join("\n");
}

export interface ProposeResult {
  ok: boolean;
  detail: string;
  response: unknown;
}

export async function proposePerson(
  env: Env,
  person: ProposedPerson,
  fetchImpl: typeof fetch = fetch,
): Promise<ProposeResult> {
  const blocked = networkOsBlockedReason(env);
  if (blocked) return { ok: false, detail: blocked, response: null };

  const base = env.WP_OS_NETWORK_OS_BASE_URL!.replace(/\/+$/, "");
  const session = await mintSession(env.WP_OS_NETWORK_OS_SESSION_SECRET!, env.WP_OS_NETWORK_OS_USER_EMAIL!);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base}${INTAKE_PATH}`, {
      method: "POST",
      headers: { cookie: `wpn_session=${session}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        raw_text: composeIntakeText(person),
        captured_by: env.WP_OS_NETWORK_OS_USER_EMAIL,
        source_user_email: env.WP_OS_NETWORK_OS_USER_EMAIL,
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;

    if (res.status === 401) {
      return { ok: false, detail: "Network OS rejected the session, so nothing was proposed.", response: body };
    }
    // 422 means the trigger was not recognised — a contract mismatch worth naming precisely rather
    // than reporting as a generic failure, because the fix is in this file and not over there.
    if (res.status === 422) {
      return {
        ok: false,
        detail: `Network OS did not recognise the ${NETWORK_TRIGGER} trigger in the message this app composed.`,
        response: body,
      };
    }
    if (!res.ok || body?.ok === false) {
      return { ok: false, detail: body?.error ?? `Network OS returned HTTP ${res.status}.`, response: body };
    }
    return { ok: true, detail: "Proposed to the Network OS intake queue for review.", response: body };
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "AbortError"
        ? `Network OS did not respond within ${TIMEOUT_MS / 1000}s.`
        : `Could not reach Network OS: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, detail, response: null };
  } finally {
    clearTimeout(timer);
  }
}
