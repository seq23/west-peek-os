import { describe, expect, it } from "vitest";
import {
  GOOGLE_SCOPES,
  buildAuthUrl,
  exchangeCode,
  fetchEvents,
  isGoogleConfigured,
  refreshTokens,
  revokeToken,
} from "../src/worker/effects/googleClient";
import type { Env } from "../src/worker/env";

/**
 * Google OAuth + Calendar (P51).
 *
 * The tests that earn their place are about the things that fail silently and expensively: a
 * connection that works for an hour and then dies, a scope wider than anyone agreed to, and a
 * disconnect that forgets locally while leaving a live grant in somebody's Google account.
 */

const env = (over: Partial<Env> = {}): Env =>
  ({
    GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    ...over,
  }) as unknown as Env;

const REDIRECT = "https://os.joinwestpeek.com/api/connections/google/callback";

function stubJson(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string | null }> = [];
  const fetchImpl = (async (url: unknown, init: any) => {
    calls.push({ url: String(url), body: (init?.body as string) ?? null });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("configuration", () => {
  it("is not configured until BOTH halves are present", () => {
    expect(isGoogleConfigured(env())).toBe(true);
    expect(isGoogleConfigured(env({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }))).toBe(false);
    expect(isGoogleConfigured(env({ GOOGLE_OAUTH_CLIENT_ID: undefined }))).toBe(false);
  });
});

describe("the authorisation URL", () => {
  it("asks for read-only calendar access and nothing more", () => {
    const u = new URL(buildAuthUrl(env(), REDIRECT, "nonce-1"));
    const scopes = (u.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    // The ceiling. Widening this is a decision somebody should have to make deliberately.
    expect(scopes.some((s) => s.endsWith("/calendar"))).toBe(false);
    expect(scopes.some((s) => s.endsWith("/calendar.events"))).toBe(false);
    expect(GOOGLE_SCOPES.some((s) => s.includes("readonly"))).toBe(true);
  });

  it("asks offline and forces consent, which is what yields a refresh token", () => {
    // Without both, the grant works for an hour and then stops for no visible reason — the single
    // most confusing way this integration can fail.
    const u = new URL(buildAuthUrl(env(), REDIRECT, "nonce-1"));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("carries the state through, so the callback can prove who started it", () => {
    const u = new URL(buildAuthUrl(env(), REDIRECT, "nonce-abc"));
    expect(u.searchParams.get("state")).toBe("nonce-abc");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });
});

describe("exchanging the code", () => {
  it("refuses a grant with no refresh token rather than storing one that will die", () => {
    // A connection that expires within the hour is worse than one that never happened, because
    // nobody knows to reconnect it.
    const { fetchImpl } = stubJson({ access_token: "at", expires_in: 3600, scope: "s" });
    return expect(exchangeCode(env(), "code", REDIRECT, fetchImpl)).rejects.toThrow(/refresh token/);
  });

  it("stores expiry as an absolute time, with slack", async () => {
    const { fetchImpl } = stubJson({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s" });
    const t = await exchangeCode(env(), "code", REDIRECT, fetchImpl);
    const ms = new Date(t.expires_at).getTime() - Date.now();
    // Just under an hour: a duration is meaningless once stored, and the slack means a token is
    // refreshed before it is used rather than after it has already failed.
    expect(ms).toBeGreaterThan(3_000_000);
    expect(ms).toBeLessThan(3_600_000);
  });

  it("does not echo Google's body into the error", async () => {
    // That body contains the code and the tokens, and this string reaches an event payload.
    const { fetchImpl } = stubJson({ error: "invalid_grant", secret_ish: "re_do_not_leak" }, 400);
    await expect(exchangeCode(env(), "code", REDIRECT, fetchImpl)).rejects.toThrow(/HTTP 400/);
    await expect(exchangeCode(env(), "code", REDIRECT, fetchImpl)).rejects.not.toThrow(/do_not_leak/);
  });
});

describe("refreshing", () => {
  it("keeps the existing refresh token, because Google does not reissue it", async () => {
    const { fetchImpl } = stubJson({ access_token: "new-at", expires_in: 3600, scope: "s" });
    const t = await refreshTokens(env(), "original-rt", fetchImpl);
    expect(t.access_token).toBe("new-at");
    expect(t.refresh_token).toBe("original-rt");
  });
});

describe("revoking", () => {
  it("treats Google's 400 as success, because it means already revoked", async () => {
    const { fetchImpl } = stubJson({ error: "invalid_token" }, 400);
    expect(await revokeToken("token", fetchImpl)).toBe(true);
  });

  it("reports a real failure as a failure", async () => {
    const { fetchImpl } = stubJson({}, 500);
    expect(await revokeToken("token", fetchImpl)).toBe(false);
  });
});

describe("reading the diary", () => {
  it("expands recurring events and separates all-day from timed", async () => {
    const { calls, fetchImpl } = stubJson({
      items: [
        { id: "1", summary: "Partner sync", start: { dateTime: "2026-08-19T15:00:00Z" }, end: { dateTime: "2026-08-19T15:30:00Z" }, attendees: [{ email: "a@b.test" }], organizer: { email: "o@b.test" }, htmlLink: "https://cal" },
        { id: "2", summary: "Offsite", start: { date: "2026-08-19" }, end: { date: "2026-08-20" } },
      ],
    });
    const events = await fetchEvents("at", new Date("2026-08-19T00:00:00Z"), new Date("2026-08-20T00:00:00Z"), fetchImpl);

    // Without singleEvents a weekly stand-up arrives as a recurrence rule the caller must interpret.
    expect(calls[0]!.url).toContain("singleEvents=true");
    expect(events[0]!.all_day).toBe(false);
    expect(events[0]!.attendees).toEqual(["a@b.test"]);
    // An all-day entry is not something you are "walking into" at a time.
    expect(events[1]!.all_day).toBe(true);
  });

  it("names an expired token distinctly, so the caller can refresh rather than give up", async () => {
    const { fetchImpl } = stubJson({}, 401);
    await expect(
      fetchEvents("stale", new Date(), new Date(), fetchImpl),
    ).rejects.toThrow(/google_unauthorised/);
  });
});
