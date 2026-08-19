import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity } from "./authorize";
import {
  GMAIL_SEND_SCOPE,
  GOOGLE_SCOPES,
  GOOGLE_SCOPES_WITH_SEND,
  buildAuthUrl,
  exchangeCode,
  fetchAccountEmail,
  fetchEvents,
  isGoogleConfigured,
  refreshTokens,
  revokeToken,
  sendViaGmail,
  type CalendarEvent,
  type GoogleTokens,
} from "../effects/googleClient";

/**
 * Connecting a partner's Google account (P51).
 *
 * WHY THIS EXISTED AS A BUTTON WITH NOTHING BEHIND IT. The schema, the readiness check and the
 * Connect control were all built; the flow between them never was. So the surface reported
 * "connectable" the moment two credentials appeared, and clicking it did nothing. This module is
 * the part that was missing.
 *
 * TOKENS DO NOT GO IN THE DATABASE. partner_connection stores `credential_name` — a NAME — and says
 * so in its own schema comment. A refresh token is a standing credential to read someone's diary,
 * and the application database is read by reporting, exports and half the product. Tokens live in
 * KV under a key the connection row merely names, so a leak of the database is not a leak of the
 * partner's Google account.
 *
 * THE CONNECTION IS PER PERSON. Scooter connecting his calendar says nothing about Sequoia's, and
 * the unique constraint is on (firm_user_id, connector_key) precisely so a second connection
 * replaces a partner's own rather than accumulating.
 *
 * WHAT THIS CANNOT DO. Read-only scopes, so nothing here can create, move or cancel anything in a
 * partner's calendar. That is a deliberate ceiling, not an oversight.
 */

/** KV key for a partner's tokens. The connection row stores this name, never the values. */
const tokenKey = (firmUserId: string) => `google:tokens:${firmUserId}`;

/** KV key for one in-flight authorisation. Short-lived and single-use. */
const stateKey = (nonce: string) => `google:oauth-state:${nonce}`;

/** Ten minutes is long enough to read a consent screen and short enough to be useless if leaked. */
const STATE_TTL_SECONDS = 600;

function redirectUriFor(request: Request): string {
  const u = new URL(request.url);
  return `${u.origin}/api/connections/google/callback`;
}

/**
 * Begin the flow.
 *
 * THE STATE PARAMETER IS NOT DECORATION. It is stored server-side against the partner who started
 * the flow and consumed on return, so a callback cannot attach somebody else's Google account to
 * this partner's record. Cloudflare Access already authenticates the person coming back, which
 * makes this belt and braces — and the braces are cheap.
 */
export async function handleGoogleConnectStart(ctx: RouteContext): Promise<Response> {
  const { env, request, identity } = ctx;
  if (!isGoogleConfigured(env)) {
    return json(
      {
        error: "not_configured",
        detail:
          "Google OAuth is not configured for this firm — GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set.",
      },
      { status: 409 },
    );
  }
  if (!env.WP_OS_KV) {
    return json({ error: "no_store", detail: "No KV binding, so a connection could not be held." }, { status: 500 });
  }

  // WHICH PERMISSIONS THIS PARTICULAR TRIP IS ASKING FOR. Connecting a calendar asks for the diary
  // alone; turning on "send as me through Gmail" is a second, separate trip that also asks for
  // gmail.send. Keeping them apart is what lets the calendar screen keep promising it cannot touch
  // your email — a promise that would be false if every connect asked for both.
  const wantsSend = new URL(request.url).pathname.includes("gmail-send");
  const scopes = wantsSend ? GOOGLE_SCOPES_WITH_SEND : GOOGLE_SCOPES;

  const nonce = crypto.randomUUID();
  await env.WP_OS_KV.put(stateKey(nonce), JSON.stringify({ user: identity!.id, scopes }), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const url = buildAuthUrl(env, redirectUriFor(request), nonce, scopes);
  // A redirect rather than JSON: the browser has to leave, and the client never touches a token.
  return new Response(null, { status: 302, headers: { location: url } });
}

/**
 * Come back from Google.
 *
 * Returns a small HTML page rather than JSON because a person is looking at it — this is a browser
 * navigation, not an API call — and then sends them back to Home.
 */
export async function handleGoogleCallback(ctx: RouteContext): Promise<Response> {
  const { env, request, identity } = ctx;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  const done = (heading: string, detail: string, ok: boolean) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>${heading}</title>` +
        `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6">` +
        `<h1 style="font-size:1.4rem">${heading}</h1><p>${detail}</p>` +
        `<p><a href="/">Back to West Peek OS</a></p></body>`,
      { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );

  if (denied) {
    // The partner pressed Cancel. Not an error worth recording as a failure.
    return done("Not connected", "You cancelled at Google, so nothing was connected and nothing changed.", false);
  }
  if (!code || !state) return done("Something is missing", "Google did not return an authorisation code.", false);
  if (!env.WP_OS_KV) return done("Could not finish", "No store is available to hold the connection.", false);

  // Consume the state: single use, and it must belong to the person standing here.
  const stored = await env.WP_OS_KV.get(stateKey(state));
  await env.WP_OS_KV.delete(stateKey(state));
  if (!stored) return done("That link has expired", "Start the connection again from Home.", false);
  // Tolerates the older bare-id form, so a flow already in flight when this shipped still lands.
  let owner = stored;
  try {
    const parsed = JSON.parse(stored) as { user?: string };
    if (parsed?.user) owner = parsed.user;
  } catch {
    /* a bare id is the old shape and is still valid */
  }
  if (owner !== identity!.id) {
    return done("That did not match", "This authorisation was started by a different person.", false);
  }

  const actor = actorFromIdentity(identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  let tokens: GoogleTokens;
  try {
    tokens = await exchangeCode(env, code, redirectUriFor(request));
  } catch (err) {
    await recordFailure(env, identity!.id, err instanceof Error ? err.message : String(err));
    return done("Google refused the connection", "Nothing was saved. You can try again from Home.", false);
  }

  const accountEmail = await fetchAccountEmail(tokens.access_token);

  await env.WP_OS_KV.put(tokenKey(identity!.id), JSON.stringify(tokens));

  for (const connectorKey of ["calendar"]) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO partner_connection (id, firm_user_id, connector_key, account_label, provider, status, scopes_json, credential_name, connected_at, last_checked_at, last_error, firm_scope)
       VALUES (?1, ?2, ?3, ?4, 'GOOGLE', 'CONNECTED', ?5, ?6, ?7, ?7, NULL, ?8)
       ON CONFLICT (firm_user_id, connector_key) DO UPDATE SET
         account_label = excluded.account_label,
         status = 'CONNECTED',
         scopes_json = excluded.scopes_json,
         credential_name = excluded.credential_name,
         connected_at = excluded.connected_at,
         last_checked_at = excluded.last_checked_at,
         last_error = NULL,
         updated_at = excluded.connected_at`,
    )
      .bind(
        `pcn_${crypto.randomUUID()}`,
        identity!.id,
        connectorKey,
        accountEmail,
        JSON.stringify(tokens.scope.split(" ").filter(Boolean)),
        // A NAME, not a value. The value is in KV under this key.
        tokenKey(identity!.id),
        new Date().toISOString(),
        firmScope,
      )
      .run();
  }

  await appendEvent(env, {
    eventType: "partner_connection.connected",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "partner_connection",
    objectId: identity!.id,
    firmScope,
    // Which account, never the tokens. Scope names are not secrets and are worth having on the record.
    payload: { provider: "GOOGLE", account: accountEmail, scopes: tokens.scope },
  });

  const gotSend = tokens.scope.split(" ").includes(GMAIL_SEND_SCOPE);
  return done(
    gotSend ? "Connected, and you can send as yourself" : "Calendar connected",
    gotSend
      ? `West Peek OS can read ${accountEmail ?? "your"} calendar and send as you through Gmail. It still cannot read a single message in your inbox, and every send still needs your approval.`
      : `West Peek OS can now read ${accountEmail ?? "your"} calendar, and only read it. Your brief will open with what you are walking into.`,
    true,
  );
}

async function recordFailure(env: Env, firmUserId: string, detail: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `UPDATE partner_connection SET status = 'FAILED', last_error = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE firm_user_id = ?1 AND connector_key = 'calendar'`,
  )
    .bind(firmUserId, detail.slice(0, 300))
    .run();
}

/**
 * A usable access token for this partner, refreshing when it has aged out.
 *
 * Returns null rather than throwing when there is no connection: a partner who has not connected is
 * an ordinary state, not a failure, and every caller has to handle it anyway.
 */
export async function accessTokenFor(env: Env, firmUserId: string): Promise<string | null> {
  if (!env.WP_OS_KV) return null;
  const raw = await env.WP_OS_KV.get(tokenKey(firmUserId));
  if (!raw) return null;

  let tokens: GoogleTokens;
  try {
    tokens = JSON.parse(raw) as GoogleTokens;
  } catch {
    return null;
  }

  if (new Date(tokens.expires_at).getTime() > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) return null;

  try {
    const next = await refreshTokens(env, tokens.refresh_token);
    await env.WP_OS_KV.put(tokenKey(firmUserId), JSON.stringify(next));
    await env.WP_OS_DB.prepare(
      "UPDATE partner_connection SET last_checked_at = ?2, status = 'CONNECTED', last_error = NULL WHERE firm_user_id = ?1 AND connector_key = 'calendar'",
    )
      .bind(firmUserId, new Date().toISOString())
      .run();
    return next.access_token;
  } catch (err) {
    // A refusal here usually means the partner revoked access at Google's end. Saying EXPIRED
    // rather than FAILED is the difference between "reconnect" and "something is broken".
    await env.WP_OS_DB.prepare(
      "UPDATE partner_connection SET status = 'EXPIRED', last_error = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE firm_user_id = ?1 AND connector_key = 'calendar'",
    )
      .bind(firmUserId, `refresh refused: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
      .run();
    return null;
  }
}

/** Today's events for a partner, or null when they have not connected. Never throws at the caller. */
export async function todaysEvents(env: Env, firmUserId: string, now = new Date()): Promise<CalendarEvent[] | null> {
  const token = await accessTokenFor(env, firmUserId);
  if (!token) return null;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  try {
    return await fetchEvents(token, start, end);
  } catch {
    // A brief is not worth failing over a diary. The caller renders without it.
    return null;
  }
}

export async function handleTodaysCalendar(ctx: RouteContext): Promise<Response> {
  const events = await todaysEvents(ctx.env, ctx.identity!.id);
  if (events === null) {
    return json({
      connected: false,
      events: [],
      note: "No calendar is connected for you, so this is empty rather than quiet. Connect one from Home.",
    });
  }
  return json({ connected: true, events, note: events.length === 0 ? "Nothing in the diary today." : "" });
}

/**
 * Disconnect, and mean it.
 *
 * Revokes at Google before forgetting locally. Forgetting without revoking leaves a live grant in
 * the partner's Google account that the OS can no longer see or withdraw — the opposite of what
 * somebody pressing Disconnect is asking for.
 */
export async function handleGoogleDisconnect(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const actor = actorFromIdentity(identity!);

  let revoked = false;
  if (env.WP_OS_KV) {
    const raw = await env.WP_OS_KV.get(tokenKey(identity!.id));
    if (raw) {
      try {
        const tokens = JSON.parse(raw) as GoogleTokens;
        revoked = await revokeToken(tokens.refresh_token ?? tokens.access_token);
      } catch {
        revoked = false;
      }
      await env.WP_OS_KV.delete(tokenKey(identity!.id));
    }
  }

  await env.WP_OS_DB.prepare(
    `UPDATE partner_connection
        SET status = 'REVOKED', credential_name = NULL, account_label = NULL,
            last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE firm_user_id = ?1 AND connector_key = 'calendar'`,
  )
    .bind(identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "partner_connection.disconnected",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "partner_connection",
    objectId: identity!.id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { provider: "GOOGLE", revoked_at_provider: revoked },
  });

  return json({
    status: "REVOKED",
    revoked_at_provider: revoked,
    note: revoked
      ? "Disconnected, and the grant was withdrawn at Google."
      : "Disconnected here. Google did not confirm the revocation — check your Google account permissions if you want to be certain.",
  });
}

/**
 * Has this partner granted the send permission?
 *
 * Read from what Google actually returned rather than from what was requested. A partner can
 * un-tick a permission on the consent screen, and treating the ask as the grant is how a system
 * ends up confidently calling an endpoint it was refused.
 */
export async function hasGmailSend(env: Env, firmUserId: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT scopes_json FROM partner_connection WHERE firm_user_id = ?1 AND connector_key = 'calendar' AND status = 'CONNECTED'",
  )
    .bind(firmUserId)
    .first<{ scopes_json: string }>();
  if (!row) return false;
  try {
    return (JSON.parse(row.scopes_json) as string[]).includes(GMAIL_SEND_SCOPE);
  } catch {
    return false;
  }
}

/**
 * Send one message as this partner, through their own Gmail.
 *
 * Returns null when they have not granted the permission, which is the ordinary case and not a
 * failure — the caller falls back to the firm transport. Throws only when Gmail was asked and said
 * no, because silently posting a message somewhere else under a partner's name would be worse than
 * an error.
 */
export async function trySendAsPartner(
  env: Env,
  firmUserId: string,
  message: { to: string; from: string; fromName?: string; subject: string; text: string },
): Promise<string | null> {
  if (!(await hasGmailSend(env, firmUserId))) return null;
  const token = await accessTokenFor(env, firmUserId);
  if (!token) return null;
  return await sendViaGmail(token, message, fetch);
}
