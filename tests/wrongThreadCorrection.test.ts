import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleReingestStoredEmail } from "../src/worker/services/webPropertyChange";
import { apologyLine, correctPartnerMail, withWrongThreadCorrection } from "../src/worker/services/mailCorrection";
import { ASSIGNING_PARTNERS } from "../src/shared/intake/partnerAuthority";

/**
 * AN EMPLOYEE WHO ANSWERED IN THE WRONG THREAD ANSWERS AGAIN, UNDER THE PARTNER'S EMAIL, TO BOTH, WITH A SORRY (24 Nov 2026).
 *
 * The incident: Scooter emailed "Fund I deck" on 23 Nov; Preston answered in the old 26 Oct thread, so Scooter's own
 * email looked unanswered in both inboxes. Her ruling: the employee sends a duplicate to both partners ("scooter gets it
 * 2x thats fine") with an apology about the wrong thread, and the code does it for any employee's mistake.
 * Proven here through the real re-read route and the real door; every person and site here is made up.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string[]; subject: string; text: string; html: string; headers: Record<string, string> }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const ME = { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] };

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array | string) => {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer, text: async () => new TextDecoder().decode(b) } : null;
    },
  };
}

/** Scooter's stored email, as the door kept it. */
async function stored(subject: string, body: string, from = `Scooter Taylor <${SCOOTER}>`): Promise<{ key: string; messageId: string }> {
  const key = `inbound-email/2026-11-23/${crypto.randomUUID()}.eml`;
  const messageId = `<${crypto.randomUUID()}@mail.gmail.com>`;
  const raw = [`From: ${from}`, "To: os@joinwestpeek.com", `Subject: ${subject}`, `Message-ID: ${messageId}`, "References: <older-1@mail.gmail.com>", `Authentication-Results: ${GOOD_AUTH}`, "", body].join("\r\n");
  await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
  return { key, messageId };
}

const reread = (key: string, extra: Record<string, unknown> = {}) =>
  handleReingestStoredEmail({
    request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key, ...extra }) }),
    env,
    identity: ME,
    params: {},
  } as never);

async function closeOpenCards(): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE lower(requested_by_email) = ?1 AND state NOT IN ('DONE','CANCELLED')").bind(SCOOTER).run();
  await env.WP_OS_DB.prepare("DELETE FROM inbound_reingest_claim").run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: fakeBucket() as never,
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; html: string; headers?: Record<string, string> };
      sent.push({ to: Array.isArray(b.to) ? b.to : [b.to], subject: b.subject, text: b.text, html: b.html, headers: b.headers ?? {} });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("a wrong-thread correction for any employee", () => {
  it("any employee's email inside a correction goes to BOTH partners, under the partner's email, with the sorry first", async () => {
    const { sendPartnerEmail } = await import("../src/worker/services/execEmail");
    const email = { employee: "Wren", what: "done — the thing", tldr: "Finished.", sections: [{ label: "What you asked", bullets: ["the thing"] }, { label: "Your call", bullets: ["nothing"] }], details: "all of it" };
    const c = { messageId: "<CAscooter-any@mail.gmail.com>", references: "<older-1@mail.gmail.com>", subject: "The thing", partnerFirstName: "Scooter" };
    const before = sent.length;
    const out = await withWrongThreadCorrection(c, () => sendPartnerEmail(env, { to: SCOOTER, email, objectType: "work_card", objectId: "wc_any_1", firmScope: "west-peek", actorId: "aie_wren" }));
    expect(out.sent, out.reason).toBe(true);
    expect(sent.length, "one email, not one per partner").toBe(before + 1);
    const m = sent[sent.length - 1]!;
    expect([...m.to].sort(), "to both partners, the writer included").toEqual([...ASSIGNING_PARTNERS].map((a) => a.toLowerCase()).sort());
    expect(m.headers["In-Reply-To"], "under Scooter's own email").toBe(c.messageId);
    expect(m.headers.References!.split(" ")[0], "his earlier chain kept first").toBe("<older-1@mail.gmail.com>");
    expect(m.headers.References, "our own thread token kept, so his reply still reaches the work").toMatch(/wpt_/);
    expect(m.subject).toBe("Re: The thing");
    expect(m.text.startsWith(apologyLine("Scooter")), "the first words are the sorry").toBe(true);
    expect(m.html).toContain("wrong email thread");
    // The same send outside a correction: one partner, its own subject, no sorry.
    await sendPartnerEmail(env, { to: SCOOTER, email, objectType: "work_card", objectId: "wc_any_2", firmScope: "west-peek", actorId: "aie_wren" });
    const plain = sent[sent.length - 1]!;
    expect(plain.to).toEqual([SCOOTER]);
    expect(plain.text).not.toContain("wrong email thread");
    expect(plain.headers["In-Reply-To"]).not.toBe(c.messageId);
  });

  it("refuses, sending nothing, when the email is not a partner's or has no Message-ID, or the correction is unknown", async () => {
    await closeOpenCards();
    const stranger = await stored("Hello", "Hi there", "Somebody <somebody@example.com>");
    const before = sent.length;
    const a = await reread(stranger.key, { correction: "wrong_thread" });
    expect(a.status).toBe(400);
    const noId = `inbound-email/2026-11-23/${crypto.randomUUID()}.eml`;
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(noId, [`From: Scooter Taylor <${SCOOTER}>`, "To: os@joinwestpeek.com", "Subject: Fund I deck", `Authentication-Results: ${GOOD_AUTH}`, "", "Ready"].join("\r\n"));
    expect((await reread(noId, { correction: "wrong_thread" })).status).toBe(400);
    const ok = await stored("Fund I deck", "Ready");
    expect((await reread(ok.key, { correction: "sorry" })).status).toBe(400);
    expect(sent.length, "nothing went out").toBe(before);
    // A refusal holds no claim: the right request runs at once.
    expect((await reread(ok.key, { correction: "wrong_thread" })).status).not.toBe(409);
  });
});

describe("the correction itself", () => {
  const c = { messageId: "<a1@mail.gmail.com>", references: "<a0@mail.gmail.com>", subject: "Fund I deck", partnerFirstName: "Scooter" };
  const base = { to: SCOOTER, subject: "Our Fund I deck", text: "Hi Scooter,\n\nHere it is.", html: "<html><body><p>Hi</p></body></html>", headers: { References: "<wpt_x@os.joinwestpeek.com>", "In-Reply-To": "<wpt_x@os.joinwestpeek.com>" } };

  it("outside a correction an email is untouched", () => {
    expect(correctPartnerMail(null, base)).toBe(base);
  });

  it("never invents a thread: no Message-ID or no subject leaves the email as it was", () => {
    expect(correctPartnerMail({ ...c, messageId: "not an id" }, base)).toBe(base);
    expect(correctPartnerMail({ ...c, subject: "  " }, base)).toBe(base);
  });

  it("drops a copy to a partner who is now addressed directly, and keeps the sorry inside the body", () => {
    const m = correctPartnerMail(c, { ...base, cc: ["sequoia@westpeek.ventures"] });
    expect(m.cc).toEqual([]);
    expect(m.html).toMatch(/<body><p>Sorry, my answer to Scooter's email/);
    expect(m.headers!.References).toBe("<a0@mail.gmail.com> <a1@mail.gmail.com> <wpt_x@os.joinwestpeek.com>");
    expect(m.subject).toBe("Re: Fund I deck");
  });

  it("the scope ends with the re-read", async () => {
    const { activeCorrection } = await import("../src/worker/services/mailCorrection");
    await withWrongThreadCorrection(c, async () => expect(activeCorrection()).toEqual(c));
    expect(activeCorrection()).toBeNull();
  });
});
