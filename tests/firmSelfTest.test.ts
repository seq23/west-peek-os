import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { isFirmSelfTest } from "../src/shared/intake/firmSelfTest";

/**
 * 6 Nov 2026: "Form key check (ignore)" from hello@joinwestpeek.com opened an "Unclear email" card for Porter
 * (wc_aa2d2450…) that spent three attempts and four Mac seat runs. The firm's own signed "(ignore)" send opens
 * nothing; a stranger's, an unsigned one, or one without the mark still goes through the door as before.
 */
let t: TestDb;
let env: Env;
const FIRM_AUTH = "mx.cloudflare.net; spf=pass smtp.mailfrom=bounce.joinwestpeek.com; dkim=pass header.d=joinwestpeek.com; dmarc=pass header.from=joinwestpeek.com";

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

let seq = 0;
async function send(from: string, subject: string, auth: string, body = "New West Peek forms key works. Ignore."): Promise<void> {
  const messageId = `<selftest-${Date.now()}-${++seq}@email.amazonses.com>`;
  const raw = [`From: West Peek <${from}>`, "To: os@joinwestpeek.com", `Subject: ${subject}`, `Message-ID: ${messageId}`, `Authentication-Results: ${auth}`, "", body].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: `West Peek <${from}>`, to: "os@joinwestpeek.com", subject, "message-id": messageId, "authentication-results": auth });
  await handleInboundEmail({ from: "0100-bounce@amazonses.com", to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}
async function cardsTitled(subject: string): Promise<number> {
  const r = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE title LIKE ?1").bind(`%${subject}%`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: fakeBucket() as never } as Partial<Env>);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the firm's own (ignore) test send", () => {
  it("opens no card, and the arrival is kept and recorded", async () => {
    await send("hello@joinwestpeek.com", "Form key check (ignore)", FIRM_AUTH);
    expect(await cardsTitled("Form key check")).toBe(0);
    const ev = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'inbound_email.self_test'").first<{ n: number }>();
    expect(Number(ev?.n)).toBe(1);
    const kept = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM inbound_message WHERE subject = 'Form key check (ignore)'").first<{ n: number }>();
    expect(Number(kept?.n)).toBe(1);
  });

  it("the same subject from a stranger still reaches Porter", async () => {
    await send("someone@example.com", "Key check (ignore)", "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass");
    expect(await cardsTitled("Key check (ignore)")).toBeGreaterThan(0);
  });

  it("a forged firm address that fails DMARC still reaches Porter", async () => {
    await send("hello@joinwestpeek.com", "Forged check (ignore)", "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail");
    expect(await cardsTitled("Forged check (ignore)")).toBeGreaterThan(0);
  });

  it("the firm's own address WITHOUT the mark still reaches Porter", async () => {
    await send("hello@joinwestpeek.com", "A real question about the site", FIRM_AUTH, "Can someone look at the join page?");
    expect(await cardsTitled("A real question about the site")).toBeGreaterThan(0);
  });

  it("the mark is read only at the start or end of the subject", () => {
    const v = { passed: true, signing_domain: "joinwestpeek.com" };
    expect(isFirmSelfTest({ from: "hello@joinwestpeek.com", subject: "[test] resend key", verdict: v, isPartner: false })).toBe(true);
    expect(isFirmSelfTest({ from: "hello@joinwestpeek.com", subject: "Please don't (ignore) this", verdict: v, isPartner: false })).toBe(false);
    expect(isFirmSelfTest({ from: "hello@joinwestpeek.com", subject: "check (ignore)", verdict: { passed: true, signing_domain: "evil.com" }, isPartner: false })).toBe(false);
    expect(isFirmSelfTest({ from: "hello@joinwestpeek.com", subject: "check (ignore)", verdict: v, isPartner: true })).toBe(false);
  });
});
