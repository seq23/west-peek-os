import { describe, expect, it } from "vitest";
import {
  GOOGLE_SCOPES,
  buildAuthUrl,
  exchangeCode,
  fetchEvents,
  isGoogleConfigured,
  refreshTokens,
  revokeToken,
  sendViaGmail,
  GOOGLE_SCOPES_WITH_SEND,
} from "../src/worker/effects/googleClient";
import type { Env } from "../src/worker/env";
import { CONNECTION_FACTS } from "../src/shared/help/connectionFacts";

/**
 * Google OAuth + Calendar (P51).
 *
 * The tests that earn their place are about the things that fail silently and expensively: a
 * connection that works for an hour and then dies, a scope wider than anyone agreed to, and a
 * disconnect that forgets locally while leaving a live grant in somebody's Google account.
 */

const env = (over: Partial<Env> = {}): Env =>
  ({
    // Deliberately NOT shaped like a real client id. The artifact gate matches credential
    // fragments, and a convincing fake in a test is indistinguishable from a real one leaking.
    GOOGLE_OAUTH_CLIENT_ID: "test-client-id-not-a-real-google-client",
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

/**
 * What the interface promises about connecting.
 *
 * These are load-bearing claims about access to a partner's private data, so they are checked
 * against the scopes actually requested rather than trusted as prose. A "cannot" list that drifts
 * out of step with the scopes is worse than no list at all.
 */
describe("what the connect help promises", () => {
  const calendar = CONNECTION_FACTS.find((f) => f.key === "calendar")!;
  const mailbox = CONNECTION_FACTS.find((f) => f.key === "email")!;

  it("promises no write access, and the requested scopes make that true", () => {
    expect(calendar.cannot.join(" ")).toMatch(/create, move, cancel or edit/i);
    // The promise is only honest while the scope list stays read-only.
    expect(GOOGLE_SCOPES.every((s) => !s.endsWith("/calendar"))).toBe(true);
    expect(GOOGLE_SCOPES.some((s) => s.endsWith("calendar.readonly"))).toBe(true);
  });

  it("promises no mail access, and no mail scope is requested", () => {
    expect(calendar.cannot.join(" ")).toMatch(/see anything in your email/i);
    expect(GOOGLE_SCOPES.some((s) => s.includes("gmail") || s.includes("mail.google"))).toBe(false);
  });

  it("says the mailbox is not built rather than offering it", () => {
    // The defect this replaced: a Connect button that ran the calendar flow and left this row
    // untouched, so it appeared to do nothing.
    expect(mailbox.availability).toMatch(/not built/i);
    expect(mailbox.whenYouConnect.join(" ")).toMatch(/disabled deliberately/i);
  });

  it("tells the partner disconnection is withdrawn at Google, not just forgotten", () => {
    expect(calendar.toUndo).toMatch(/revoked at Google/i);
  });
});

/**
 * Sending as a partner through their own Gmail.
 *
 * The permission is the sensitive part, so the tests are about what is asked for and what the
 * message on the wire actually contains.
 */
describe("gmail.send", () => {
  it("is not part of the calendar consent", () => {
    // A partner who wants their diary read must not be handed a mail permission as the price.
    const u = new URL(buildAuthUrl(env(), REDIRECT, "n"));
    expect(u.searchParams.get("scope")).not.toContain("gmail.send");
  });

  it("is added by the second consent, alongside what was already granted", () => {
    const u = new URL(buildAuthUrl(env(), REDIRECT, "n", GOOGLE_SCOPES_WITH_SEND));
    const scope = u.searchParams.get("scope") ?? "";
    expect(scope).toContain("gmail.send");
    expect(scope).toContain("calendar.readonly");
    // Incremental: Google keeps the existing grant rather than replacing it.
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("never asks for a scope that could read mail", () => {
    const scope = new URL(buildAuthUrl(env(), REDIRECT, "n", GOOGLE_SCOPES_WITH_SEND)).searchParams.get("scope") ?? "";
    for (const forbidden of ["gmail.readonly", "gmail.modify", "mail.google.com", "gmail.metadata"]) {
      expect(scope).not.toContain(forbidden);
    }
  });

  it("builds a message Gmail accepts, base64url and not standard base64", async () => {
    let sentBody: any = null;
    const fetchImpl = (async (_u: unknown, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "gmail-msg-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await sendViaGmail(
      "at",
      { to: "lp@example.test", from: "scooter@westpeek.ventures", fromName: "Scooter Taylor", subject: "Hello", text: "Body." },
      fetchImpl,
    );
    expect(id).toBe("gmail-msg-1");
    // base64url uses - and _ and drops padding; standard base64 would break the API.
    expect(sentBody.raw).not.toMatch(/[+/=]/);

    const decoded = atob(sentBody.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).toContain("From: Scooter Taylor <scooter@westpeek.ventures>");
    expect(decoded).toContain("To: lp@example.test");
    expect(decoded).toContain("Subject: Hello");
  });

  it("strips newlines out of headers, because a subject is attacker-shaped input", async () => {
    // A newline in a subject is header injection, and this subject comes from a payload a person
    // or a model wrote.
    let sentBody: any = null;
    const fetchImpl = (async (_u: unknown, init: any) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendViaGmail(
      "at",
      { to: "a@b.test", from: "c@westpeek.ventures", subject: "Hi\r\nBcc: sneak@evil.test", text: "Body." },
      fetchImpl,
    );
    const decoded = atob(sentBody.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(decoded).not.toMatch(/^Bcc:/m);
    expect(decoded).toContain("Subject: Hi Bcc: sneak@evil.test");
  });

  it("names a refusal distinctly so the caller can fall back rather than drop the message", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(
      sendViaGmail("at", { to: "a@b.test", from: "c@westpeek.ventures", subject: "s", text: "t" }, fetchImpl),
    ).rejects.toThrow(/google_unauthorised/);
  });
});
