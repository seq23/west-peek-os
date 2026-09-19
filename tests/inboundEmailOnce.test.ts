import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleInboundEmail, inboundMessageKey } from "../src/worker/effects/inboundEmail";

let t: TestDb;
let env: Env;
beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

function message(messageId: string | null, subject = "Hello from a founder") {
  const headers = new Headers({ from: "Founder <founder@example.com>", to: "os@joinwestpeek.com", subject });
  if (messageId) headers.set("message-id", messageId);
  const body = `From: founder@example.com\r\nTo: os@joinwestpeek.com\r\nSubject: ${subject}\r\n\r\nWe are raising.\r\n`;
  return {
    from: "founder@example.com",
    to: "os@joinwestpeek.com",
    headers,
    raw: new Blob([body]).stream(),
    rawSize: body.length,
  };
}

async function inboundEvents(): Promise<number> {
  const row = await t.db
    .prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type IN ('inbound_email.received', 'inbound_email.unrouted')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("a message is handled once, however many times it is delivered", () => {
  it("reads the Message-ID without its angle brackets, and has nothing to say without one", () => {
    expect(inboundMessageKey(new Headers({ "message-id": "<abc@example.com>" }))).toBe("abc@example.com");
    expect(inboundMessageKey(new Headers({ "message-id": "  abc@example.com " }))).toBe("abc@example.com");
    expect(inboundMessageKey(new Headers())).toBeNull();
    expect(inboundMessageKey(new Headers({ "message-id": "<>" }))).toBeNull();
  });

  it("a re-delivery of a handled message writes nothing and is recorded as seen", async () => {
    const before = await inboundEvents();
    await handleInboundEmail(message("<once-1@example.com>"), env);
    expect(await inboundEvents()).toBe(before + 1);
    const seen = await t.db.prepare("SELECT message_id FROM inbound_email_seen WHERE message_id = 'once-1@example.com'").first();
    expect(seen).not.toBeNull();

    // Cloudflare re-delivers; the dev harness drops the stream after the handler finished. Same message.
    await handleInboundEmail(message("<once-1@example.com>"), env);
    expect(await inboundEvents()).toBe(before + 1);
  });

  it("a different message with a different Message-ID is handled on its own", async () => {
    const before = await inboundEvents();
    await handleInboundEmail(message("<once-2@example.com>", "Another founder"), env);
    expect(await inboundEvents()).toBe(before + 1);
  });

  it("a message with no Message-ID cannot be recognised, so it is handled every time — honestly", async () => {
    const before = await inboundEvents();
    await handleInboundEmail(message(null, "No identity"), env);
    await handleInboundEmail(message(null, "No identity"), env);
    expect(await inboundEvents()).toBe(before + 2);
    const rows = await t.db.prepare("SELECT COUNT(*) AS n FROM inbound_email_seen").first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});
