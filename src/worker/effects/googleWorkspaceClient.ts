import type { Env } from "../env";

/**
 * Every outbound call to Google Workspace AS THE FIRM, in one file (Phase Meet, 18 Sep 2026).
 *
 * `googleClient.ts` is a partner's own OAuth grant — each person connects their own diary, and the
 * tokens are theirs. This file is the other identity: the firm's service account, which Google
 * Workspace lets impersonate ONE partner mailbox (`shared/meetings/calendarSources.ts`) under
 * domain-wide delegation. It is what lets a scheduled job read the calendar and an ended Meet at
 * 03:00 with nobody signed in.
 *
 * WHAT IT DOES NOT DO. It stores nothing, decides nothing, and never sees a meeting row. Callers
 * hold the policy; this turns a request into an HTTP call and a response into data. Everything
 * here is a GET except three named writes, each of which is a write to GOOGLE'S bookkeeping and
 * not to a person's diary: minting a token, creating/renewing a Workspace Events subscription,
 * and acknowledging a Pub/Sub message. There is no calendar write, no Meet space write, and no
 * Drive write in this file — `validate:authority` reads it as an allowlisted egress module with
 * that reason attached.
 *
 * THE PRIVATE KEY NEVER LEAVES WEBCRYPTO. The service-account JSON is parsed, the PKCS#8 key is
 * imported non-extractable, the JWT is signed, and the parsed object is dropped. Nothing here
 * logs a token, a key, or a Google error body — the bodies can contain the assertion.
 *
 * FOUR HOSTS, ALL GOOGLE'S:
 *   oauth2.googleapis.com          — token minting
 *   www.googleapis.com             — Calendar v3 (read), JWKS
 *   meet.googleapis.com            — Meet REST v2 (read)
 *   workspaceevents.googleapis.com — Workspace Events v1 (subscription create/renew/list)
 *   pubsub.googleapis.com          — Pub/Sub v1 (pull/ack on the firm's own subscription)
 * plus whatever host the private iCal URL names (calendar.google.com), which is fetched read-only
 * as the fallback that survives a password change.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const MEET_BASE = "https://meet.googleapis.com/v2";
const EVENTS_BASE = "https://workspaceevents.googleapis.com/v1";
const PUBSUB_BASE = "https://pubsub.googleapis.com/v1";
const TIMEOUT_MS = 15_000;

export const SCOPE = {
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  meetRead: "https://www.googleapis.com/auth/meetings.space.readonly",
  meetCreated: "https://www.googleapis.com/auth/meetings.space.created",
  meetSettings: "https://www.googleapis.com/auth/meetings.space.settings",
  pubsub: "https://www.googleapis.com/auth/pubsub",
} as const;

/** The Meet event types the firm subscribes to. Named here so the subscription and the inbox agree. */
export const MEET_EVENT_TYPES = [
  "google.workspace.meet.conference.v2.ended",
  "google.workspace.meet.transcript.v2.fileGenerated",
  "google.workspace.meet.recording.v2.fileGenerated",
] as const;

export class GoogleWorkspaceError extends Error {
  constructor(
    public code: "not_configured" | "scope_missing" | "unauthorised" | "forbidden" | "not_found" | "http" | "timeout",
    public status: number,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export function isServiceAccountConfigured(env: Env): boolean {
  return typeof env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON === "string" && env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON.length > 0;
}

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const arr = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw new GoogleWorkspaceError("timeout", 0, `google did not answer within ${TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mint an access token for the service account, impersonating `subject` when given.
 *
 * A 401 `unauthorized_client` from the token endpoint means the DELEGATION GRANT is missing for one
 * of the scopes — not that the API is disabled, not that the key is bad. It is surfaced as
 * `scope_missing` so the caller can name the stop precisely (the admin console, the client id, the
 * scope string), which is the difference between a job that says why and one that says "401".
 */
export async function serviceAccountToken(
  env: Env,
  scopes: readonly string[],
  subject: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!isServiceAccountConfigured(env)) throw new GoogleWorkspaceError("not_configured", 0, "WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  let sa: { client_email?: string; private_key?: string };
  try {
    sa = JSON.parse(env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON!) as typeof sa;
  } catch {
    throw new GoogleWorkspaceError("not_configured", 0, "WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not JSON");
  }
  if (!sa.client_email || !sa.private_key) throw new GoogleWorkspaceError("not_configured", 0, "service account JSON lacks client_email or private_key");

  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: sa.client_email, scope: scopes.join(" "), aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 };
  if (subject) claims.sub = subject;
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64url(sig)}`;

  const res = await fetchWithTimeout(fetchImpl, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok) {
    if (body.error === "unauthorized_client") {
      throw new GoogleWorkspaceError("scope_missing", res.status, `the delegation grant does not cover ${scopes.join(" ")}${subject ? ` for ${subject}` : ""}`);
    }
    throw new GoogleWorkspaceError("unauthorised", res.status, `google refused the service-account token (HTTP ${res.status}${body.error ? ` ${body.error}` : ""})`);
  }
  if (!body.access_token) throw new GoogleWorkspaceError("unauthorised", res.status, "google returned no access token");
  return body.access_token;
}

async function getJson<T>(fetchImpl: typeof fetch, token: string, url: string): Promise<T> {
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { authorization: `Bearer ${token}` } });
  return await readJson<T>(res, url);
}

async function readJson<T>(res: Response, url: string): Promise<T> {
  if (res.status === 401) throw new GoogleWorkspaceError("unauthorised", 401, `google_unauthorised for ${new URL(url).pathname}`);
  if (res.status === 403) throw new GoogleWorkspaceError("forbidden", 403, `google_forbidden for ${new URL(url).pathname}`);
  if (res.status === 404) throw new GoogleWorkspaceError("not_found", 404, `google_not_found for ${new URL(url).pathname}`);
  // Never echoes the body: it can carry a resource the firm has not decided to keep.
  if (!res.ok) throw new GoogleWorkspaceError("http", res.status, `google responded ${res.status} for ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

// ── Calendar (read) ──────────────────────────────────────────────────────────

/**
 * Events on the impersonated user's primary calendar in a window, recurrences expanded, with
 * conference data. Raw items; `shared/meetings/calendarSync.ts` reduces them.
 */
export async function listCalendarEvents(
  token: string,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${CALENDAR_BASE}/calendars/primary/events`);
    u.searchParams.set("timeMin", from.toISOString());
    u.searchParams.set("timeMax", to.toISOString());
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("maxResults", "250");
    u.searchParams.set("conferenceDataVersion", "1");
    u.searchParams.set("showDeleted", "true");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const body = await getJson<{ items?: Array<Record<string, unknown>>; nextPageToken?: string }>(fetchImpl, token, u.toString());
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken && items.length < 2000);
  return items;
}

/** The private iCal feed, as text. https only; the URL is a secret and is never logged. */
export async function fetchIcs(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new GoogleWorkspaceError("not_configured", 0, "the iCal URL must be https");
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { accept: "text/calendar" } });
  if (!res.ok) throw new GoogleWorkspaceError("http", res.status, `the iCal feed responded ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new GoogleWorkspaceError("http", res.status, "the iCal feed did not return a calendar");
  return text.slice(0, 4_000_000);
}

// ── Meet REST v2 (read) ──────────────────────────────────────────────────────

export interface ConferenceRecordRaw {
  name: string;
  space?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

/** Conference records visible to the impersonated user, optionally filtered by meeting code. */
export async function listConferenceRecords(
  token: string,
  opts: { meetingCode?: string; startedAfter?: Date; pageSize?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<ConferenceRecordRaw[]> {
  const u = new URL(`${MEET_BASE}/conferenceRecords`);
  const filters: string[] = [];
  if (opts.meetingCode) filters.push(`space.meeting_code = "${opts.meetingCode.replace(/[^a-z-]/gi, "")}"`);
  if (opts.startedAfter) filters.push(`start_time >= "${opts.startedAfter.toISOString()}"`);
  if (filters.length) u.searchParams.set("filter", filters.join(" AND "));
  u.searchParams.set("pageSize", String(opts.pageSize ?? 25));
  const body = await getJson<{ conferenceRecords?: ConferenceRecordRaw[] }>(fetchImpl, token, u.toString());
  return body.conferenceRecords ?? [];
}

export async function getConferenceRecord(token: string, name: string, fetchImpl: typeof fetch = fetch): Promise<ConferenceRecordRaw> {
  return getJson<ConferenceRecordRaw>(fetchImpl, token, `${MEET_BASE}/${name}`);
}

export async function getSpace(token: string, spaceName: string, fetchImpl: typeof fetch = fetch): Promise<{ name: string; meetingCode?: string; meetingUri?: string; config?: Record<string, unknown> }> {
  return getJson(fetchImpl, token, `${MEET_BASE}/${spaceName}`);
}

async function listAll<T>(fetchImpl: typeof fetch, token: string, url: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(url);
    u.searchParams.set("pageSize", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const body = await getJson<Record<string, unknown>>(fetchImpl, token, u.toString());
    out.push(...((body[field] as T[] | undefined) ?? []));
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken && out.length < 20_000);
  return out;
}

export async function listParticipants(token: string, record: string, fetchImpl: typeof fetch = fetch): Promise<Array<Record<string, unknown>>> {
  return listAll(fetchImpl, token, `${MEET_BASE}/${record}/participants`, "participants");
}

export interface TranscriptRaw {
  name: string;
  state?: "STARTED" | "ENDED" | "FILE_GENERATED";
  docsDestination?: { document?: string; exportUri?: string };
  startTime?: string;
  endTime?: string;
}

export async function listTranscripts(token: string, record: string, fetchImpl: typeof fetch = fetch): Promise<TranscriptRaw[]> {
  return listAll(fetchImpl, token, `${MEET_BASE}/${record}/transcripts`, "transcripts");
}

export async function listTranscriptEntries(token: string, transcript: string, fetchImpl: typeof fetch = fetch): Promise<Array<Record<string, unknown>>> {
  return listAll(fetchImpl, token, `${MEET_BASE}/${transcript}/entries`, "transcriptEntries");
}

export interface RecordingRaw {
  name: string;
  state?: "STARTED" | "ENDED" | "FILE_GENERATED";
  driveDestination?: { file?: string; exportUri?: string };
  startTime?: string;
  endTime?: string;
}

export async function listRecordings(token: string, record: string, fetchImpl: typeof fetch = fetch): Promise<RecordingRaw[]> {
  return listAll(fetchImpl, token, `${MEET_BASE}/${record}/recordings`, "recordings");
}

// ── Workspace Events (subscription bookkeeping) ─────────────────────────────

export interface SubscriptionRaw {
  name: string;
  targetResource?: string;
  eventTypes?: string[];
  expireTime?: string;
  state?: string;
  notificationEndpoint?: { pubsubTopic?: string };
}

export async function listMeetSubscriptions(token: string, fetchImpl: typeof fetch = fetch): Promise<SubscriptionRaw[]> {
  const u = new URL(`${EVENTS_BASE}/subscriptions`);
  u.searchParams.set("filter", `event_types:"${MEET_EVENT_TYPES[0]}"`);
  const body = await getJson<{ subscriptions?: SubscriptionRaw[] }>(fetchImpl, token, u.toString());
  return body.subscriptions ?? [];
}

/**
 * Subscribe to Meet events for every space the impersonated user hosts, delivered to the firm's
 * Pub/Sub topic. The target is the USER, not a space, so one subscription covers every call.
 * Returns the created subscription (the API answers with a long-running operation whose
 * `response` is the subscription; `done` is true synchronously for this resource).
 */
export async function createMeetSubscription(
  token: string,
  userEmail: string,
  pubsubTopic: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionRaw> {
  const res = await fetchWithTimeout(fetchImpl, `${EVENTS_BASE}/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      targetResource: `//cloudidentity.googleapis.com/users/${encodeURIComponent(userEmail)}`,
      eventTypes: MEET_EVENT_TYPES,
      notificationEndpoint: { pubsubTopic },
      payloadOptions: { includeResource: false },
    }),
  });
  const op = await readJson<{ done?: boolean; response?: SubscriptionRaw; name?: string }>(res, `${EVENTS_BASE}/subscriptions`);
  if (op.response) return op.response;
  return { name: op.name ?? "" };
}

/** Push a subscription's expiry out. Meet subscriptions expire; renewal is a PATCH of expireTime. */
export async function renewMeetSubscription(token: string, name: string, ttlHours: number, fetchImpl: typeof fetch = fetch): Promise<SubscriptionRaw> {
  const u = new URL(`${EVENTS_BASE}/${name}`);
  u.searchParams.set("updateMask", "ttl");
  const res = await fetchWithTimeout(fetchImpl, u.toString(), {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: `${ttlHours * 3600}s` }),
  });
  const op = await readJson<{ done?: boolean; response?: SubscriptionRaw; name?: string }>(res, u.toString());
  return op.response ?? { name };
}

// ── Pub/Sub (the firm's own subscription; pulled, never pushed) ─────────────

export interface PubsubMessage {
  ackId: string;
  messageId: string;
  publishTime: string | null;
  /** Message attributes, where Workspace Events puts `ce-type` and `ce-subject`. */
  attributes: Record<string, string>;
  /** The JSON body, decoded. Empty object when there is none or it is not JSON. */
  data: Record<string, unknown>;
}

/**
 * PULL, NOT PUSH — and this is the reason. The Worker sits behind Cloudflare Access, which answers
 * every unauthenticated request with a 302 to a login page (confirmed 18 Sep 2026 against
 * /api/health on both the custom host and workers.dev). A Pub/Sub push subscription cannot carry
 * an Access service token, so a push endpoint here would receive nothing and report nothing —
 * a webhook that never arrives is silence, and silence looks like success. Pulling from inside the
 * scheduled tick needs no inbound door at all, and the same tick already polls conference records
 * as the fallback, so the two paths share one code path and one audit row per conference.
 */
export async function pullPubsub(
  token: string,
  subscription: string,
  maxMessages: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PubsubMessage[]> {
  const url = `${PUBSUB_BASE}/${subscription}:pull`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // returnImmediately: without it Pub/Sub holds an empty pull open for up to a minute and a half,
    // which is a 15s timeout on every quiet tick. Google marks the flag deprecated; it still works,
    // and a quiet tick that answers in 200ms is worth more than a full page of messages.
    body: JSON.stringify({ maxMessages, returnImmediately: true }),
  });
  const body = await readJson<{ receivedMessages?: Array<{ ackId: string; message: { data?: string; attributes?: Record<string, string>; messageId: string; publishTime?: string } }> }>(res, url);
  return (body.receivedMessages ?? []).map((m) => {
    let data: Record<string, unknown> = {};
    if (m.message.data) {
      try {
        data = JSON.parse(atob(m.message.data.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return { ackId: m.ackId, messageId: m.message.messageId, publishTime: m.message.publishTime ?? null, attributes: m.message.attributes ?? {}, data };
  });
}

export async function ackPubsub(token: string, subscription: string, ackIds: readonly string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (ackIds.length === 0) return;
  const url = `${PUBSUB_BASE}/${subscription}:acknowledge`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ackIds }),
  });
  await readJson(res, url);
}
