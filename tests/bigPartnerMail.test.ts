import { firstRead } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleInboundEmail, INLINE_READ_ATTEMPTS, STALE_CLAIM_MINUTES } from "../src/worker/effects/inboundEmail";
import { mimeSplitCount } from "../src/worker/effects/mimeAttachments";
import { startThread } from "../src/worker/services/emailThread";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { systemIdentity } from "../src/worker/services/dealIntake";
import { raiseUnacknowledgedMail, sendUnderstoodReplies, type SeatRead } from "../src/worker/services/partnerUnderstood";
import { handleReingestStoredEmail } from "../src/worker/services/webPropertyChange";
import { threadReference } from "../src/shared/email/thread";
import { TAKEN_OVER_PREFIX } from "../src/shared/work/takeover";
import { TAKEN_OVER_NEXT } from "../src/worker/services/partnerUnderstood";

/**
 * A PARTNER'S BIG EMAIL IS READ, THEN ANSWERED (15 Nov 2026).
 *
 * Scooter's 6 MB and 11 MB replies (a voice note, a ZIP, photos) were killed by the email handler's CPU limit
 * (exceededCpu at 2,010 ms) mid-read, and the dedupe claim left behind swallowed the redelivery: no steer, no Got it,
 * nothing said. The single largest cost was the voice note handed to the AI binding as a byte array, which the binding
 * JSON-serialises; the rest was header reads walking every megabyte of base64. Pinned here, all synthetic:
 *   · an 11 MB and a 25 MB reply are read inline: split once, the recording handed over as a STREAM, his words and the
 *     transcript steer the card, every file is filed, and only then does the Got it go;
 *   · a Drive link (Gmail's own, for a file over 25 MB) to a recording is read as him and transcribed before the Got it;
 *   · a door that died lets the redelivery in; two that died hand the message to a Mac session, never a third read;
 *   · a body that cannot be read sends no Got it and is on Sequoia's desk;
 *   · a dry run reads everything and writes nothing.
 */

const SCOOTER = "scooter@westpeek.ventures";
const SCOOTER_FROM = `Scooter Taylor <${SCOOTER}>`;
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const DRIVE_AUDIO_ID = "1GmailBigRecordingAAAAAAAAAAAAAAAAA";

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const aiCalls: Array<{ model: string; streamed: boolean; bytes: number }> = [];
const store = new Map<string, Uint8Array>();

function bucket() {
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array | string | ReadableStream) => {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : new Uint8Array(body);
      store.set(key, bytes);
      return { key };
    },
    get: async (key: string, opts?: { range?: { offset: number; length: number } }) => {
      const full = store.get(key);
      if (!full) return null;
      const b = opts?.range ? full.slice(opts.range.offset, opts.range.offset + opts.range.length) : full;
      return { body: new Blob([b as BlobPart]).stream(), arrayBuffer: async () => b.slice().buffer, text: async () => new TextDecoder().decode(b) };
    },
  };
}

/** A phone's reply: his words, the quoted note, a voice note, a ZIP and a photo, padded to `totalBytes`. */
function bigReply(opts: { subject: string; token: string; words: string; totalBytes: number; messageId: string; extraBody?: string }) {
  const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const audioBytes = Math.floor(opts.totalBytes * 0.53);
  const zipBytes = Math.floor(opts.totalBytes * 0.15);
  const photoBytes = Math.floor(opts.totalBytes * 0.05);
  const boundary = "Apple-Mail=_BIG_TEST";
  const raw = [
    `From: ${SCOOTER_FROM}`,
    "To: os@joinwestpeek.com",
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}>`,
    `In-Reply-To: ${threadReference(opts.token)}`,
    `Authentication-Results: ${GOOD_AUTH}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `${opts.words}${opts.extraBody ? `\r\n\r\n${opts.extraBody}` : ""}`,
    "",
    "On Sat, Nov 15, 2026 at 11:40 AM Porter <os@westpeek.ventures> wrote:",
    "> New preview ready.",
    "",
    `--${boundary}`,
    'Content-Type: audio/mp4; name="New Recording 7.m4a"',
    'Content-Disposition: attachment; filename="New Recording 7.m4a"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(audioBytes, 3),
    `--${boundary}`,
    'Content-Type: application/zip; name="assets.zip"',
    'Content-Disposition: attachment; filename="assets.zip"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(zipBytes, 5),
    `--${boundary}`,
    'Content-Type: image/jpeg; name="IMG_0001.jpg"',
    'Content-Disposition: attachment; filename="IMG_0001.jpg"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(photoBytes, 7),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: SCOOTER_FROM, to: "os@joinwestpeek.com", subject: opts.subject, "message-id": `<${opts.messageId}>`, "authentication-results": GOOD_AUTH, "in-reply-to": threadReference(opts.token) });
  return { from: SCOOTER, to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength, bytes };
}

async function cardWithThread(label: string): Promise<{ cardId: string; token: string; kind: string }> {
  const kind = `BIG_MAIL_${label}`;
  const card = await createWorkCardInternal(env, systemIdentity(), { title: `Porter: West Peek site ${label}`, description: "the site", owner_type: "AI", owner_id: "aie_porter", priority: "NORMAL", firm_scope: "west-peek", next_action: "build it" });
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1").bind(card.id, SCOOTER).run();
  const { token } = await startThread(env, { objectType: "work_card", objectId: card.id, cardKind: kind, employee: "Porter", to: SCOOTER, subject: `Porter: West Peek site ${label}: New preview ready`, firmScope: "west-peek" });
  return { cardId: card.id, token, kind };
}

// The seat read is injected: the asks are his exact words, as the real reader is told to return them.
const seat: SeatRead = async (_env, input) => {
  const email = input.prompt.split("Email:\n")[1] ?? "";
  const first = email.split(/\n+/).find((l) => l.trim().length > 3) ?? "";
  return { ok: true, text: firstRead({ asks: [first.trim()], next: `I'm on it.` }), detail: "ok" };
};

const one = <T>(sql: string, ...b: unknown[]) => env.WP_OS_DB.prepare(sql).bind(...b).first<T>();
const count = async (sql: string, ...b: unknown[]) => Number((await one<{ n: number }>(sql, ...b))?.n ?? 0);

beforeAll(async () => {
  if (!("FixedLengthStream" in globalThis)) {
    (globalThis as unknown as { FixedLengthStream: unknown }).FixedLengthStream = class {
      readable: ReadableStream;
      writable: WritableStream;
      constructor(_n: number) {
        const ts = new TransformStream();
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    };
  }
  t = await createTestDb();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const AI = {
    run: async (model: string, input: Record<string, unknown>) => {
      const audio = input.audio as { body: unknown } | undefined;
      const streamed = audio?.body instanceof ReadableStream;
      const bytes = streamed ? (await new Response(audio!.body as ReadableStream).arrayBuffer()).byteLength : (audio?.body as Uint8Array | undefined)?.byteLength ?? 0;
      aiCalls.push({ model, streamed, bytes });
      return { results: { channels: [{ alternatives: [{ transcript: `Move the pricing below the case studies, recording of ${bytes} bytes.` }] }] } };
    },
  };
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: bucket() as never,
    AI: AI as never,
    WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "gsc-bot@test.iam.gserviceaccount.com", private_key: privateKey }),
  } as Partial<Env>);
  const recording = new Uint8Array(3 * 1024 * 1024).fill(9);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.as-scooter" }), { status: 200 });
    if (u.includes(`/drive/v3/files/${DRIVE_AUDIO_ID}?fields=`)) {
      // Gmail's big-file link: owned by him, never shared with os@ — readable only as him, through the delegation.
      return new Response(JSON.stringify({ id: DRIVE_AUDIO_ID, name: "Long voice memo.m4a", mimeType: "audio/x-m4a", size: String(recording.byteLength), owners: [{ emailAddress: SCOOTER }] }), { status: 200 });
    }
    if (u.includes(`/drive/v3/files/${DRIVE_AUDIO_ID}?alt=media`)) return new Response(recording, { status: 200, headers: { "content-length": String(recording.byteLength) } });
    throw new Error(`unexpected fetch in test: ${u}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("a partner's big reply is read inline, then answered", () => {
  for (const mb of [11, 25]) {
    it(`a ${mb} MB reply (voice note, ZIP, photo) steers its card with his words and the transcript, files every file, and the Got it follows the read`, async () => {
      const { cardId, token, kind } = await cardWithThread(`${mb}MB`);
      const msg = bigReply({ subject: `Re: Porter: West Peek site ${mb}MB: New preview ready`, token, words: "Recording attached. Also swap the hero photo.", totalBytes: mb * 1024 * 1024, messageId: `big-${mb}@mail.gmail.com` });
      expect(msg.rawSize, "the fixture is genuinely that size").toBeGreaterThan(mb * 0.98 * 1024 * 1024);
      const splitsBefore = mimeSplitCount.n;
      const callsBefore = aiCalls.length;
      await handleInboundEmail(msg, env);

      // LINEAR, NOT REPEATED: every reader of this one message shares a single split of it.
      expect(mimeSplitCount.n - splitsBefore, "the message is split once, whatever reads it").toBe(1);
      const call = aiCalls.slice(callsBefore);
      expect(call, "one recording, one transcription").toHaveLength(1);
      expect(call[0]!.streamed, "the recording reaches the binding as a stream, never a byte array it would JSON-encode").toBe(true);

      const steer = await one<{ body: string }>("SELECT body FROM work_steer WHERE card_kind = ?1", kind);
      expect(steer?.body, "his typed words").toContain("Also swap the hero photo.");
      expect(steer?.body, "and his spoken ones").toContain("Move the pricing below the case studies");
      const files = (await env.WP_OS_DB.prepare("SELECT filename FROM request_attachment WHERE work_card_id = ?1 ORDER BY filename").bind(cardId).all<{ filename: string }>()).results!.map((r) => r.filename);
      expect(files).toEqual(["IMG_0001.jpg", "New Recording 7.m4a", "assets.zip"]);
      expect(await count("SELECT COUNT(*) AS n FROM inbound_message WHERE message_id = ?1 AND work_card_id = ?2", `big-${mb}@mail.gmail.com`, cardId), "placed on the card it answers").toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM inbound_email_seen WHERE message_id = ?1 AND handled = 1", `big-${mb}@mail.gmail.com`), "the claim is marked finished").toBe(1);

      const before = sent.length;
      await sendUnderstoodReplies(env, new Date(), seat);
      const gotIt = sent.slice(before).filter((m) => m.to === SCOOTER);
      expect(gotIt, "one Got it, after the read").toHaveLength(1);
      expect(gotIt[0]!.text).toContain("Recording attached.");
    });
  }

  it("a Drive link Gmail wrote for a file over 25 MB is read as him: the recording is transcribed onto the card before the Got it", async () => {
    const { cardId, token, kind } = await cardWithThread("DRIVE");
    const link = `https://drive.google.com/file/d/${DRIVE_AUDIO_ID}/view?usp=drive_web`;
    const msg = bigReply({ subject: "Re: Porter: West Peek site DRIVE: New preview ready", token, words: "Listen to the long memo.", extraBody: `Long voice memo.m4a\r\n<${link}>`, totalBytes: 400 * 1024, messageId: "drive-link@mail.gmail.com" });
    await handleInboundEmail(msg, env);
    const onCard = await one<{ text: string | null }>("SELECT text FROM card_drive_file WHERE work_card_id = ?1 AND file_id = ?2", cardId, DRIVE_AUDIO_ID);
    expect(onCard?.text, "the linked recording's words are on the card").toContain(`recording of ${3 * 1024 * 1024} bytes`);
    const kept = await count("SELECT COUNT(*) AS n FROM request_attachment WHERE work_card_id = ?1 AND filename = 'Long voice memo.m4a' AND eml_key LIKE 'drive-file/%'", cardId);
    expect(kept, "and the file itself is filed like an attachment").toBe(1);
    expect((await one<{ body: string }>("SELECT body FROM work_steer WHERE card_kind = ?1", kind))?.body, "the steer carries the transcript").toContain(`recording of ${3 * 1024 * 1024} bytes`);
    const before = sent.length;
    await sendUnderstoodReplies(env, new Date(), seat);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER), "the Got it goes only now, after everything was read").toHaveLength(1);
  });
});

describe("never silent, and never the same wall twice", () => {
  const aged = () => new Date(Date.now() - (STALE_CLAIM_MINUTES + 2) * 60_000).toISOString();

  it("a claim a killed door left behind lets the redelivery read the message", async () => {
    const { kind } = await cardWithThread("RETAKE");
    const token = (await one<{ token: string }>("SELECT token FROM email_thread WHERE card_kind = ?1", kind))!.token;
    await env.WP_OS_DB.prepare("INSERT INTO inbound_email_seen (message_id, firm_scope, handled, attempts, seen_at) VALUES ('retake@mail.gmail.com', 'west-peek', 0, 1, ?1)").bind(aged()).run();
    await handleInboundEmail(bigReply({ subject: "Re: Porter: West Peek site RETAKE: New preview ready", token, words: "Second try.", totalBytes: 300 * 1024, messageId: "retake@mail.gmail.com" }), env);
    expect((await one<{ body: string }>("SELECT body FROM work_steer WHERE card_kind = ?1", kind))?.body).toContain("Second try.");
    expect(await count("SELECT COUNT(*) AS n FROM inbound_email_seen WHERE message_id = 'retake@mail.gmail.com' AND handled = 1 AND attempts = 2")).toBe(1);
  });

  it(`after ${INLINE_READ_ATTEMPTS} failed inline reads the message goes to a Mac session carrying the stored key and the original card, and is not read a third time`, async () => {
    const { cardId, kind } = await cardWithThread("HANDOFF");
    const token = (await one<{ token: string }>("SELECT token FROM email_thread WHERE card_kind = ?1", kind))!.token;
    const msg = bigReply({ subject: "Re: Porter: West Peek site HANDOFF: New preview ready", token, words: "Third time.", totalBytes: 300 * 1024, messageId: "handoff@mail.gmail.com" });
    const key = "inbound-email/2026-11-15/handoff.eml";
    store.set(key, msg.bytes);
    await env.WP_OS_DB.prepare(
      `INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope)
       VALUES ('inm_handoff', 'handoff@mail.gmail.com', ?1, ?2, 'os@joinwestpeek.com', 'Re: Porter: West Peek site HANDOFF: New preview ready', ?3, ?4, ?5, 'west-peek')`,
    ).bind(key, SCOOTER_FROM, aged(), msg.rawSize, JSON.stringify({ passed: true, partner: SCOOTER })).run();
    await env.WP_OS_DB.prepare("INSERT INTO inbound_email_seen (message_id, firm_scope, handled, attempts, seen_at) VALUES ('handoff@mail.gmail.com', 'west-peek', 0, ?2, ?1)").bind(aged(), INLINE_READ_ATTEMPTS).run();
    const splitsBefore = mimeSplitCount.n;

    await handleInboundEmail(msg, env);

    expect(mimeSplitCount.n - splitsBefore, "no third inline read").toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM work_steer WHERE card_kind = ?1", kind), "nothing steered from here").toBe(0);
    const session = await one<{ id: string; kind: string; description: string }>("SELECT id, kind, description FROM work_card WHERE kind = 'PARTNER_SESSION' AND title LIKE '%HANDOFF%'");
    expect(session?.kind, "an existing Mac lane, not a new one").toBe("PARTNER_SESSION");
    expect(session!.description, "it carries the stored message").toContain(key);
    expect(session!.description, "and the card to steer, never a new one").toContain(cardId);
    expect(session!.description).toMatch(/Read EVERYTHING first[\s\S]*ONE "Got it"[\s\S]*Never open a new card/);
    const desk = await one<{ title: string; body: string }>("SELECT title, body FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND dedupe_key = 'inbound_email_handed_off:handoff@mail.gmail.com'");
    expect(desk?.title).toMatch(/A Mac session has taken over/);
    expect(desk?.body).toMatch(/Nobody needs to act unless the Mac is asleep/);
    expect(await count("SELECT COUNT(*) AS n FROM inbound_email_seen WHERE message_id = 'handoff@mail.gmail.com' AND handled = 2")).toBe(1);
  });

  it("a body that cannot be read sends no Got it and is raised on Sequoia's desk; a door that died is raised by the sweep", async () => {
    const { kind } = await cardWithThread("BROKEN");
    const token = (await one<{ token: string }>("SELECT token FROM email_thread WHERE card_kind = ?1", kind))!.token;
    const msg = bigReply({ subject: "Re: Porter: West Peek site BROKEN: New preview ready", token, words: "Never read.", totalBytes: 300 * 1024, messageId: "broken@mail.gmail.com" });
    const broken = new ReadableStream({ pull(c) { c.error(new Error("the body could not be read")); } });
    await sendUnderstoodReplies(env, new Date(), seat); // earlier messages' Got its go first, so only this one is measured
    const before = sent.length;
    await expect(handleInboundEmail({ ...msg, raw: broken }, env)).rejects.toThrow();
    await sendUnderstoodReplies(env, new Date(), seat);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER), "no Got it for what was not read").toHaveLength(0);
    expect(await count("SELECT COUNT(*) AS n FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND dedupe_key = 'inbound_email_failed:broken@mail.gmail.com'"), "on her desk now").toBe(1);

    // KILLED, NOT THROWN: no catch runs, the claim stays unfinished; the sweep raises it past five minutes.
    await env.WP_OS_DB.prepare("INSERT INTO inbound_email_seen (message_id, firm_scope, handled, attempts, seen_at) VALUES ('killed@mail.gmail.com', 'west-peek', 0, 1, ?1)").bind(new Date(Date.now() - 6 * 60_000).toISOString()).run();
    expect(await raiseUnacknowledgedMail(env, new Date())).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT COUNT(*) AS n FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND dedupe_key = 'inbound_email_door_died:killed@mail.gmail.com'")).toBe(1);
  });
});

describe("a dry run reads everything and writes nothing", () => {
  it("returns the card it would steer, the files, the transcript and the Got it — and no row, object or email changes", async () => {
    const { cardId, token } = await cardWithThread("DRY");
    const msg = bigReply({ subject: "Re: Porter: West Peek site DRY: New preview ready", token, words: "1. Swap the hero photo for the new one.\n2. Make the header a little taller.", totalBytes: 2 * 1024 * 1024, messageId: "dry@mail.gmail.com" });
    const key = "inbound-email/2026-11-15/dry.eml";
    store.set(key, msg.bytes);
    await env.WP_OS_DB.prepare(
      `INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope)
       VALUES ('inm_dry', 'dry@mail.gmail.com', ?1, ?2, 'os@joinwestpeek.com', 'Re: dry', ?3, ?4, ?5, 'west-peek')`,
    ).bind(key, SCOOTER_FROM, new Date().toISOString(), msg.rawSize, JSON.stringify({ passed: true, partner: SCOOTER })).run();
    // The card is taken over, like wc_c548d043: the dry run's Got it must say what the live one would.
    await env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), held_reason = ?2 WHERE id = ?1").bind(cardId, `${TAKEN_OVER_PREFIX} (test).`).run();
    // The event spine is append-only and keeps the first read's own ai_run events (dryReadMessage says so); every
    // other table, the ai_run table included, is exactly as it was.
    const tables = ["work_steer", "request_attachment", "card_drive_file", "inbound_email_seen", "inbound_message", "notification", "partner_understood", "inbound_reingest_claim", "work_card", "work_card_note", "ai_run"];
    const snapshot = async () => Promise.all(tables.map((tb) => count(`SELECT COUNT(*) AS n FROM ${tb}`)));
    const cardBefore = await one<{ description: string; updated_at: string }>("SELECT description, updated_at FROM work_card WHERE id = ?1", cardId);
    const rowsBefore = await snapshot();
    const startedAt = new Date(Date.now() - 1).toISOString();
    const objectsBefore = store.size;
    const sentBefore = sent.length;

    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ inbound_message_id: "inm_dry", dry_run: true }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures", fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { would: { would_steer: { object_id: string } | null; filed: string[]; voice_notes: Array<{ text: string }>; got_it: { tldr: string; sections: Array<{ bullets: string[] }> } } };
    expect(body.would.would_steer?.object_id).toBe(cardId);
    expect([...body.would.filed].sort()).toEqual(["IMG_0001.jpg", "New Recording 7.m4a", "assets.zip"]);
    expect(body.would.voice_notes[0]?.text).toContain("Move the pricing below the case studies");
    expect(body.would.got_it.tldr).toMatch(/^Got it\./);
    expect(body.would.got_it.tldr, "the honest next line on a taken-over card, as the live Got it says it").toContain(TAKEN_OVER_NEXT);

    expect(await snapshot(), "no row anywhere").toEqual(rowsBefore);
    const newEvents = (await env.WP_OS_DB.prepare("SELECT event_type FROM event_record WHERE created_at >= ?1").bind(startedAt).all<{ event_type: string }>()).results!.map((e) => e.event_type);
    expect(newEvents.filter((e) => !e.startsWith("ai_run.") && !e.startsWith("ai.")), "no business event, only the read's own run record").toEqual([]);
    expect(store.size, "no stored object").toBe(objectsBefore);
    expect(sent.length, "no email").toBe(sentBefore);
    expect(await one<{ description: string; updated_at: string }>("SELECT description, updated_at FROM work_card WHERE id = ?1", cardId)).toEqual(cardBefore);
  });
});
