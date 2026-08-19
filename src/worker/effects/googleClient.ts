import type { Env } from "../env";

/**
 * Every outbound call to Google, in one file (P51).
 *
 * WHY IT IS ONE FILE. Egress is confined to allowlisted modules under effects/, so this is the only
 * place that may talk to Google at all. That is worth more than tidiness here: OAuth involves
 * handing a refresh token to a third party's token endpoint, and having exactly one place where
 * that happens is what makes the claim auditable rather than aspirational.
 *
 * WHAT IT DOES NOT DO. It stores nothing, decides nothing, and knows nothing about who is asking.
 * Callers hold the tokens and the policy; this module turns a request into an HTTP call and a
 * response into data. That separation is what lets the connection service be tested without a
 * network and this client be reasoned about without reading the connection service.
 *
 * SCOPES ARE READ-ONLY BY DESIGN. The system reads a diary to say what you are walking into; it has
 * never needed to write one. `calendar.readonly` is far easier to justify to a reviewer — and to
 * the partner clicking Allow — than `calendar.events`, and widening later is a smaller
 * conversation than explaining why a fund wanted write access on day one.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

const TIMEOUT_MS = 10_000;

/** Read the diary and know whose it is. Nothing here can change anything at Google. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

/**
 * The extra permission for sending as yourself, asked for SEPARATELY.
 *
 * gmail.send can only send. It cannot read the inbox, list messages, touch drafts or see anything
 * that already exists — Google's own description is "Send email on your behalf" and nothing more.
 * That narrowness is why it is acceptable at all.
 *
 * It is a second consent rather than part of the first because a partner who wants their diary read
 * should not be handed a mail permission to approve as the price. Google's incremental
 * authorisation adds it to the existing grant, so nothing already given is lost.
 */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const GOOGLE_SCOPES_WITH_SEND = [...GOOGLE_SCOPES, GMAIL_SEND_SCOPE] as const;

export interface GoogleTokens {
  access_token: string;
  /** Google returns this only on the FIRST consent unless prompt=consent is forced. */
  refresh_token: string | null;
  /** Absolute, not a duration — a duration is meaningless once it has been stored. */
  expires_at: string;
  scope: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  location: string | null;
  attendees: string[];
  organizer: string | null;
  /** Google's own link, so a partner can open the real thing rather than a copy of it. */
  html_link: string | null;
}

export function isGoogleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID) && Boolean(env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/** Where the partner is sent to say yes. Builds a URL; performs no request. */
export function buildAuthUrl(
  env: Env,
  redirectUri: string,
  state: string,
  scopes: readonly string[] = GOOGLE_SCOPES,
): string {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID!);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("state", state);
  // offline + consent together are what actually yield a refresh token. Without offline there is
  // no refresh token at all; without consent Google withholds it on every grant after the first,
  // which produces a connection that works for an hour and then dies for no visible reason.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  return u.toString();
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function tokensFrom(body: Record<string, unknown>, fallbackRefresh: string | null): GoogleTokens {
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    access_token: String(body.access_token ?? ""),
    refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : fallbackRefresh,
    // Sixty seconds of slack, so a token that expires mid-request is refreshed before it is used
    // rather than after it has already failed.
    expires_at: new Date(Date.now() + (expiresIn - 60) * 1000).toISOString(),
    scope: String(body.scope ?? ""),
  };
}

/**
 * Exchange the one-time code for tokens.
 *
 * Throws on anything other than success, and deliberately does NOT echo Google's body: it can
 * contain the code and the tokens, and this string reaches an error surface and an event payload.
 */
export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  const res = await postForm(
    TOKEN_ENDPOINT,
    {
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`google rejected the code exchange (HTTP ${res.status})`);
  const tokens = tokensFrom((await res.json()) as Record<string, unknown>, null);
  if (!tokens.access_token) throw new Error("google returned no access token");
  if (!tokens.refresh_token) {
    // Worth failing loudly. A connection with no refresh token works until the hour is up and then
    // stops, which is far more confusing than never having connected.
    throw new Error("google returned no refresh token — the connection would expire within the hour");
  }
  return tokens;
}

/** Trade the refresh token for a new access token. Google does not reissue the refresh token. */
export async function refreshTokens(
  env: Env,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  const res = await postForm(
    TOKEN_ENDPOINT,
    {
      refresh_token: refreshToken,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`google refused the refresh (HTTP ${res.status})`);
  return tokensFrom((await res.json()) as Record<string, unknown>, refreshToken);
}

/**
 * Tell Google to forget us.
 *
 * Called on disconnect. Forgetting the token locally without revoking leaves a live grant sitting
 * in the partner's Google account that the OS can no longer see — which is exactly the state
 * somebody is trying to leave when they press Disconnect.
 */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await postForm(REVOKE_ENDPOINT, { token }, fetchImpl);
  // 400 means Google already considers it dead, which is the outcome we wanted.
  return res.ok || res.status === 400;
}

/** Which account this is, so the interface can say WHICH diary it is reading. */
export async function fetchAccountEmail(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { email?: string };
    return body.email ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Today's events on the primary calendar.
 *
 * `singleEvents` expands a recurring series into the instances that actually land today, which is
 * the only form that answers "what am I walking into". Without it a weekly stand-up arrives as one
 * recurrence rule the caller would have to interpret itself.
 */
export async function fetchEvents(
  accessToken: string,
  from: Date,
  to: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  const u = new URL(CALENDAR_ENDPOINT);
  u.searchParams.set("timeMin", from.toISOString());
  u.searchParams.set("timeMax", to.toISOString());
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "50");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(u.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error("google_unauthorised");
  if (!res.ok) throw new Error(`google calendar responded ${res.status}`);

  const body = (await res.json()) as { items?: Array<Record<string, any>> };
  return (body.items ?? []).map((e) => {
    const start = e.start ?? {};
    const end = e.end ?? {};
    return {
      id: String(e.id ?? ""),
      summary: String(e.summary ?? "(no title)"),
      start: start.dateTime ?? start.date ?? null,
      end: end.dateTime ?? end.date ?? null,
      // An all-day event carries `date` rather than `dateTime`. The distinction matters: an all-day
      // entry is not something you are "walking into" at a time.
      all_day: Boolean(start.date && !start.dateTime),
      location: e.location ? String(e.location) : null,
      attendees: Array.isArray(e.attendees)
        ? e.attendees.map((a: Record<string, unknown>) => String(a.email ?? "")).filter(Boolean)
        : [],
      organizer: e.organizer?.email ? String(e.organizer.email) : null,
      html_link: e.htmlLink ? String(e.htmlLink) : null,
    };
  });
}

/**
 * Send one message as the partner, through their own Gmail.
 *
 * WHY THIS EXISTS RATHER THAN ALWAYS USING RESEND. Mail sent through Resend under a partner's
 * address is legitimate and arrives, but Gmail has never heard of it — so it is absent from their
 * Sent folder and a reply does not thread against anything. Sent through Gmail it simply IS their
 * email: in Sent, threaded, and signed by Google.
 *
 * RFC 822 BY HAND, because that is what the endpoint takes. Header values are stripped of CR and LF
 * before they go in: a newline inside a subject or an address is header injection, and the subject
 * here comes from a payload that a person or a model wrote.
 */
export async function sendViaGmail(
  accessToken: string,
  message: { to: string; from: string; fromName?: string; subject: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  const from = message.fromName ? `${clean(message.fromName)} <${clean(message.from)}>` : clean(message.from);

  const raw = [
    `From: ${from}`,
    `To: ${clean(message.to)}`,
    `Subject: ${clean(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    message.text,
  ].join("\r\n");

  // base64url, which is what Gmail wants — not standard base64.
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(GMAIL_SEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: encoded }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new Error("google_unauthorised");
  // Never echoes Google's body: it can contain the message that was being sent, and this string
  // reaches an error surface and an event payload.
  if (!res.ok) throw new Error(`gmail refused the send (HTTP ${res.status})`);

  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return body.id ?? null;
}
