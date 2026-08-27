import { describe, expect, it } from "vitest";
import {
  composeIntakeText,
  mintSession,
  networkOsBlockedReason,
  networkOsConfigured,
  probeNetworkOs,
  proposePerson,
  pullSnapshot,
} from "../src/worker/effects/networkOsClient";
import type { Env } from "../src/worker/env";

/**
 * The live Network OS client (P35).
 *
 * The session-minting test matters most: it asserts byte-compatibility with the scheme Network OS
 * already uses (base64url payload + "." + base64url HMAC-SHA256). If that drifts, every pull gets
 * a 401 and the failure looks like a wrong secret rather than a wrong format.
 */

const CONFIGURED = {
  WP_OS_NETWORK_OS_BASE_URL: "https://network.example.test",
  WP_OS_NETWORK_OS_SESSION_SECRET: "test-secret",
  WP_OS_NETWORK_OS_USER_EMAIL: "sequoia@westpeek.ventures",
} as unknown as Env;

function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("configuration", () => {
  it("is unconfigured when nothing is set", () => {
    expect(networkOsConfigured({} as Env)).toBe(false);
  });

  it("names the specific missing setting rather than saying 'unconfigured'", () => {
    // The vague version of this message cost real time: a 503 reading "adapter_unconfigured" was
    // assumed to be a credential gate when the client had never been written at all.
    expect(networkOsBlockedReason({} as Env)).toMatch(/BASE_URL/);
    expect(networkOsBlockedReason({ WP_OS_NETWORK_OS_BASE_URL: "x" } as unknown as Env)).toMatch(/SESSION_SECRET/);
    expect(
      networkOsBlockedReason({ WP_OS_NETWORK_OS_BASE_URL: "x", WP_OS_NETWORK_OS_SESSION_SECRET: "y" } as unknown as Env),
    ).toMatch(/USER_EMAIL/);
    expect(networkOsBlockedReason(CONFIGURED)).toBeNull();
  });

  it("refuses to call out when unconfigured", async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    const r = await pullSnapshot({} as Env, spy);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("session minting", () => {
  it("produces payload.signature in base64url with no padding", async () => {
    const s = await mintSession("test-secret", "sequoia@westpeek.ventures");
    const [payload, sig] = s.split(".");
    expect(payload).toBeTruthy();
    expect(sig).toBeTruthy();
    expect(s).not.toContain("=");
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
  });

  it("round-trips the email Network OS will read back", async () => {
    const [payload] = (await mintSession("k", "Sequoia@WestPeek.Ventures")).split(".");
    const json = JSON.parse(Buffer.from(payload!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    // Lower-cased on the way in: Network OS compares against a lower-cased approved list.
    expect(json.email).toBe("sequoia@westpeek.ventures");
  });

  it("changes the signature when the secret changes", async () => {
    const a = await mintSession("secret-a", "x@y.z");
    const b = await mintSession("secret-b", "x@y.z");
    expect(a.split(".")[0]).toBe(b.split(".")[0]);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });
});

describe("pulling a snapshot", () => {
  it("maps the tabs it uses", async () => {
    const r = await pullSnapshot(CONFIGURED, respond({
      ok: true, source: "google_sheets_batch",
      data: { contacts: [{ contact_id: "c1", email: "a@b.c" }], events: [], event_attendees: [], relationship_touches: [{ touch_id: "t1" }] },
    }));
    expect(r.ok).toBe(true);
    expect(r.snapshot?.contacts).toHaveLength(1);
    expect(r.snapshot?.relationship_touches).toHaveLength(1);
    expect(r.source).toBe("google_sheets_batch");
  });

  it("explains a 401 as a secret or approved-list problem", async () => {
    const r = await pullSnapshot(CONFIGURED, respond({}, 401));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/approved-users|secret/i);
  });

  it("reports a non-ok body without inventing data", async () => {
    const r = await pullSnapshot(CONFIGURED, respond({ ok: false, error: "Google Sheets unavailable." }));
    expect(r.ok).toBe(false);
    expect(r.snapshot).toBeNull();
    expect(r.detail).toMatch(/Google Sheets/);
  });

  it("survives a tab the snapshot did not return", async () => {
    const r = await pullSnapshot(CONFIGURED, respond({ ok: true, data: { contacts: [{ contact_id: "c1" }] } }));
    expect(r.ok).toBe(true);
    expect(r.snapshot?.events).toEqual([]);
  });

  it("sends the session as a cookie and asks for fresh data", async () => {
    let seenUrl = ""; let seenCookie = "";
    const spy = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenCookie = String((init?.headers as Record<string, string>)?.cookie ?? "");
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await pullSnapshot(CONFIGURED, spy);
    expect(seenUrl).toContain("/api/sheets/snapshot");
    // fresh=1 bypasses Network OS's 45s cache: a sync receipt recording stale rows is worse than
    // a slower call.
    expect(seenUrl).toContain("fresh=1");
    expect(seenCookie).toMatch(/^wpn_session=/);
  });

  it("turns an unreachable host into a stated reason, not a throw", async () => {
    const boom = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const r = await pullSnapshot(CONFIGURED, boom);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/could not reach/i);
  });
});

// ── Proposing a person outward ──

describe("capture proposes a person to Network OS rather than writing one", () => {
  /**
   * Operator direction, 21 Aug 2026: "the capture tab needs to integrate also with network OS and
   * allow new people to go the other way and go into the network OS database."
   *
   * The governance question is whether "go into" means write. It does not: Network OS owns the
   * contact record, so this app proposes and the far end decides. These assert on the ENDPOINT and
   * the composed message, because both are where that distinction actually lives.
   */
  const PERSON = { name: "Dana Reyes", email: "dana@example.com", company: "Northwind", title: "Founder" };

  it("composes the message in the shape Network OS parses, carrying the operator's own trigger", () => {
    const text = composeIntakeText(PERSON);
    expect(text.startsWith("#wpnetwork")).toBe(true);
    expect(text).toContain("Name: Dana Reyes");
    expect(text).toContain("Email: dana@example.com");
    expect(text).toContain("Company: Northwind");
    // A reviewer over there should not have to ask where a queued person came from.
    expect(text).toContain("Source: West Peek OS capture");
  });

  it("posts to the intake queue, never to the contact table", async () => {
    let seenUrl = "";
    let seenBody: any = null;
    const fake = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const res = await proposePerson(CONFIGURED, PERSON, fake);
    expect(res.ok).toBe(true);
    expect(seenUrl).toContain("/api/intake/create");
    // The distinction the whole boundary rests on.
    expect(seenUrl).not.toContain("/api/contacts/create");
    expect(seenBody.raw_text).toContain("#wpnetwork");
  });

  it("names a rejected session as a rejected session, and proposes nothing", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ ok: false, error: "Authentication required." }), { status: 401 })) as unknown as typeof fetch;
    const res = await proposePerson(CONFIGURED, PERSON, fake);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("rejected the session");
  });

  it("says so precisely when Network OS does not recognise the trigger, because that fix is on this side", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ ok: false, error: "No accepted West Peek Network trigger found." }), {
        status: 422,
      })) as unknown as typeof fetch;
    const res = await proposePerson(CONFIGURED, PERSON, fake);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("#wpnetwork");
  });
});

/**
 * The reachability probe behind the Integrations page. Its whole reason for existing is that the
 * page spent a month reporting a live integration as "not set up" because it was looking for a
 * credential name that had never existed. A status surface has to ask the far end.
 */
describe("probing whether Network OS is there", () => {
  it("refuses without contacting anything, and says which setting is missing", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const probe = await probeNetworkOs({} as Env, fetchImpl);
    expect(called).toBe(false);
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toMatch(/BASE_URL/);
  });

  it("separates 'answered and accepted us' from 'answered and rejected us'", async () => {
    const ok = await probeNetworkOs(CONFIGURED, respond({ ok: true, data: {} }));
    expect(ok.reachable).toBe(true);
    expect(ok.detail).toContain("accepted us");
    expect(ok.detail).toContain("sequoia@westpeek.ventures");

    const rejected = await probeNetworkOs(CONFIGURED, respond({ error: "unauthorized" }, 401));
    // Reachable is still TRUE: the far end is up, and conflating that with "down" sends whoever
    // reads it to check the wrong thing.
    expect(rejected.reachable).toBe(true);
    expect(rejected.detail).toContain("approved-users list");

    const broken = await probeNetworkOs(CONFIGURED, respond({}, 500));
    expect(broken.reachable).toBe(true);
    expect(broken.detail).toContain("its side");
  });

  it("reads the status line and never the body", async () => {
    let bodyRead = false;
    const fetchImpl = (async () => {
      const res = new Response(JSON.stringify({ ok: true, data: { contacts: [{ email: "someone@example.test" }] } }));
      const original = res.json.bind(res);
      Object.defineProperty(res, "json", {
        value: async () => {
          bodyRead = true;
          return original();
        },
      });
      return res;
    }) as unknown as typeof fetch;

    const probe = await probeNetworkOs(CONFIGURED, fetchImpl);
    expect(probe.reachable).toBe(true);
    // No contact crosses the boundary on this path, which is why it does not need pull authority.
    expect(bodyRead).toBe(false);
  });

  it("reports a far end that never answers as unreachable", async () => {
    const fetchImpl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const probe = await probeNetworkOs(CONFIGURED, fetchImpl);
    expect(probe.reachable).toBe(false);
    expect(probe.detail).toContain("did not answer");
  });
});
