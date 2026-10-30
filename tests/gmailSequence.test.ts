import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { approvedFor, fileDraft } from "../src/worker/services/learningClub";
import { executeExternalEffect } from "../src/worker/effects/executor";
import type { Actor } from "../src/worker/services/authorize";
import type { Env } from "../src/worker/env";

let t: TestDb;
let env: Env;
const sent: Array<{ threadId?: string; raw: string }> = [];
let eventNumber = 0;
const actor: Actor = { type: "HUMAN", firmUserId: "fu_thread_fixture", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const serviceAccount = JSON.stringify({ client_email: "sender@fixture.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const header = (raw: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(raw)?.[1]?.trim();

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "fixture-key", WP_OS_EMAIL_FROM: "sender@example.test", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount });
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fixture-token" });
    if (String(url) === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string };
      sent.push({ ...body, raw: Buffer.from(body.raw, "base64url").toString() });
      return Response.json({ id: `gmail-${sent.length}`, threadId: body.threadId ?? `thread-${sent.length}` });
    }
    throw new Error("unexpected transport in threading test");
  });
  await t.db.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_thread_fixture', 'partner@example.test', 'Fixture Partner', 'ACTIVE')").run();
  await t.db.prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_thread_fixture', 'role_managing_partner')").run();
});
afterEach(() => { sent.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

async function deal(id: string, email = "hello@fixture.example") {
  const month = `2028-${String(++eventNumber).padStart(2, "0")}`;
  await t.db.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, status) VALUES (?1, ?2, ?3, 'EVENING', 'Fixture Workshop', 'TOPIC_READY')").bind(id, month, `${month}-12`).run();
  await t.db.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, firm_scope) VALUES (?1, ?1, 'Fixture Co', ?2, 'https://fixture.example/contact', 'west-peek')").bind(id, email).run();
  return { id, brand: "Fixture Co", contact_email: email, drip_step: 0 };
}

async function send(d: Awaited<ReturnType<typeof deal>>, subject: string) {
  const card = await fileDraft(env, d, { subject, text: "Fixture message." });
  // Local receipt fixture only. No approval API or live transport is called.
  await t.db.prepare("UPDATE approval_card SET state = 'approved', decided_by = 'fu_thread_fixture' WHERE id = ?1").bind(card).run();
  const request = (await t.db.prepare("SELECT object_id FROM approval_card WHERE id = ?1").bind(card).first<{ object_id: string }>())!;
  const result = await executeExternalEffect(approvedFor(env, card, d.contact_email), actor, request.object_id, card);
  await t.db.prepare("UPDATE tlc_drip_message SET state = 'SENT' WHERE effect_request_id = ?1").bind(request.object_id).run();
  return result;
}

describe("Gmail sequence threading", () => {
  it("stores Gmail ids and the exact RFC Message-ID of the first send", async () => {
    const result = await send(await deal("thread-first"), "Fixture invitation");
    const stored = await t.db.prepare("SELECT gmail_message_id, gmail_thread_id, rfc_message_id FROM external_effect_request WHERE id = ?1").bind(result.request.id).first();
    expect(header(sent[0]!.raw, "Message-ID")).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
    expect(stored).toEqual({ gmail_message_id: "gmail-1", gmail_thread_id: "thread-1", rfc_message_id: header(sent[0]!.raw, "Message-ID") });
    expect(sent[0]!.threadId).toBeUndefined();
    expect(header(sent[0]!.raw, "In-Reply-To")).toBeUndefined();
  });

  it("sends every follow-up in that thread, replying to the previous Message-ID with the original subject", async () => {
    const d = await deal("thread-follow");
    await send(d, "Fixture invitation");
    for (const step of [1, 2]) {
      await send({ ...d, drip_step: step }, "A different draft subject");
      expect(sent[step]!.threadId).toBe("thread-1");
      expect(header(sent[step]!.raw, "In-Reply-To")).toBe(header(sent[step - 1]!.raw, "Message-ID"));
      expect(header(sent[step]!.raw, "References")).toBe(header(sent[step - 1]!.raw, "Message-ID"));
      expect(header(sent[step]!.raw, "Subject")).toBe("Re: Fixture invitation");
      expect(header(sent[step]!.raw, "Message-ID")).not.toBe(header(sent[step - 1]!.raw, "Message-ID"));
      const draft = await t.db.prepare("SELECT subject FROM tlc_drip_message WHERE deal_id = ?1 AND step = ?2").bind(d.id, step).first<{ subject: string }>();
      expect(draft?.subject).toBe("Re: Fixture invitation");
    }
  });

  it("sends an older sequence without thread data and records why it fell back", async () => {
    const d = await deal("thread-legacy");
    await t.db.prepare("INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state) VALUES ('legacy-message', ?1, 0, 'Old invitation', 'Fixture', 'SENT')").bind(d.id).run();
    await send({ ...d, drip_step: 1 }, "Today's subject");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBeUndefined();
    expect(header(sent[0]!.raw, "In-Reply-To")).toBeUndefined();
    expect(header(sent[0]!.raw, "References")).toBeUndefined();
    expect(header(sent[0]!.raw, "Subject")).toBe("Today's subject");
    const event = await t.db.prepare("SELECT payload_json FROM event_record WHERE event_type = 'tlc.drip_thread_fallback' AND object_id = ?1").bind(d.id).first<{ payload_json: string }>();
    expect(JSON.parse(event?.payload_json ?? "{}")).toEqual({ step: 1, reason: "previous_send_missing_thread_metadata" });
  });

  it("never borrows a thread from another sequence or a different recipient", async () => {
    const d = await deal("thread-recipient");
    await send(d, "Fixture invitation");
    await send({ ...d, drip_step: 1, contact_email: "other@fixture.example" }, "Different recipient");
    await send({ ...await deal("thread-other-sequence"), drip_step: 1 }, "Different sequence");
    for (const message of sent.slice(1)) {
      expect(message.threadId).toBeUndefined();
      expect(header(message.raw, "In-Reply-To")).toBeUndefined();
    }
  });

  it.each(["gmail_thread_id", "rfc_message_id"])("falls back when the previous send is missing %s", async (column) => {
    const d = await deal(`thread-missing-${column}`);
    const first = await send(d, "Fixture invitation");
    // Only local fixture rows are changed. The column name is one of the two literals above.
    await t.db.prepare(`UPDATE external_effect_request SET ${column} = NULL WHERE id = ?1`).bind(first.request.id).run();
    await send({ ...d, drip_step: 1 }, "Fallback invitation");
    expect(sent[1]!.threadId).toBeUndefined();
    expect(header(sent[1]!.raw, "In-Reply-To")).toBeUndefined();
    expect(header(sent[1]!.raw, "Subject")).toBe("Fallback invitation");
    expect((await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'tlc.drip_thread_fallback' AND object_id = ?1").bind(d.id).first<{ n: number }>())?.n).toBe(1);
  });
});
