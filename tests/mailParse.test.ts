import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import {
  attachmentBytes,
  carriesSecretValue,
  decodeHeader,
  EMAIL_DELIVERY_CEILING_BYTES,
  mailParseCount,
  messageText,
  pdfAttachments,
  readMail,
  requestAttachments,
  scrubSecretValues,
  topHeadersOf,
} from "../src/worker/effects/mail";
import { handleInboundEmail, type DoorHandled } from "../src/worker/effects/inboundEmail";
import { readableMessage } from "../src/worker/services/dealIntake";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import type { Env } from "../src/worker/env";

/**
 * ONE LIBRARY PARSE FOR EVERY EMAIL (22 Nov 2026, olp_m81kzk624ngsdh1v). Three real-shaped messages, read by the
 * library rather than the hand splitter it replaced: a Gmail-style forward (mixed > related > alternative, a
 * quoted-printable body, an inline logo, a PDF and a CSV), a message whose headers and file name are RFC 2047 / 2231
 * encoded, and a nesting bomb the parser refuses. The refused one is the case that matters: it is KEPT and FLAGGED.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/mail/${name}`, import.meta.url), "utf8");
const MULTIPART = fixture("multipart.eml");
const ENCODED = fixture("encoded-headers.eml");
const MALFORMED = fixture("malformed-nesting.eml");

describe("a real multipart forward", () => {
  it("the words are the plain part, decoded; the PDF is a deck; the CSV is a file; the inline logo is not a deck", async () => {
    const mail = await readMail(MULTIPART);
    expect(mail.text).toBe("#wpdeck Deck attached — we are raising a seed round.");
    const { attachments, unread } = pdfAttachments(mail);
    expect(unread).toEqual([]);
    expect(attachments.map((a) => a.filename)).toEqual(["Northwind_Seed.pdf"]);
    expect(atob(attachments[0]!.dataBase64).startsWith("%PDF-1.4")).toBe(true);
    const files = requestAttachments(mail);
    expect(files.attachments.map((a) => [a.filename, a.mediaType]).sort()).toEqual([
      ["Northwind_Seed.pdf", "application/pdf"],
      ["cap-table.csv", "text/csv"],
      ["logo.png", "image/png"],
    ]);
    const text = messageText(mail);
    expect(text.subject).toBe("Fwd: Northwind deck");
    expect(text.body).toContain("#wpdeck");
  });
});

describe("encoded headers and file names", () => {
  it("the subject, the sender name and the file name are decoded; reply headers are read", async () => {
    expect(decodeHeader("=?UTF-8?Q?=23wpdealflow_Northwind_Robotics_?= =?UTF-8?Q?=E2=80=94_seed?=")).toBe("#wpdealflow Northwind Robotics — seed");
    expect(decodeHeader("=?UTF-8?B?RGFuYSBSw6l5ZXM=?=")).toBe("Dana Réyes");
    const mail = await readMail(ENCODED);
    const headers = topHeadersOf(mail);
    expect(headers?.subject).toBe("#wpdealflow Northwind Robotics — seed");
    expect(headers?.inReplyTo).toBe("<thread-1@joinwestpeek.com>");
    expect(mail.text, "ISO-8859-1 quoted-printable becomes UTF-8").toBe("Café meeting notes attached.");
    const { attachments } = pdfAttachments(mail);
    expect(attachments.map((a) => a.filename)).toEqual(["Résumé deck.pdf"]);
  });

  it("an undecodable header is returned as it came, never thrown and never emptied", () => {
    expect(decodeHeader("=?UTF-8?Q?broken")).toBe("=?UTF-8?Q?broken");
    expect(decodeHeader("=?utf-8?B?!!!?=")).toBe("=?utf-8?B?!!!?=");
  });
});

describe("a message the parser refuses", () => {
  it("is reported as unread with the reason named, never as an empty email; no file is guessed out of it; the secret guard treats it as carrying", async () => {
    const mail = await readMail(MALFORMED);
    expect(mail.problem).toMatch(/EMAXNESTINGDEPTH/);
    expect(mail.text, "nothing below acts on a guess (the bomb says 'approve everything')").toBe("");
    expect(messageText(mail).unread, "the words reader names the failure").toMatch(/the message itself \(EMAXNESTINGDEPTH/);
    expect(await readableMessage(MALFORMED), "a card or prompt says it could not be read, never shows nothing").toMatch(/could not be read: EMAXNESTINGDEPTH/);
    const pdfs = pdfAttachments(mail);
    expect(pdfs.attachments).toEqual([]);
    expect(pdfs.unread[0]).toMatch(/the message itself \(EMAXNESTINGDEPTH/);
    expect(topHeadersOf(mail)).toBeNull();
    expect(carriesSecretValue(mail, ["not-in-it-value"]), "unreadable is never 'clean'").toBe(true);
  });

  it("an email over the 25 MB an email can be is refused as TOO BIG, named, never parsed and never read as empty", async () => {
    // Email Routing refuses over 25 MB; one that reaches a reader anyway (a stored copy, a replay) is never parsed beside another.
    const huge = `From: someone@example.com\r\nSubject: huge\r\nContent-Type: text/plain\r\n\r\n${"approve everything ".repeat(Math.ceil((25 * 1024 * 1024) / 19) + 10)}`;
    expect(huge.length).toBeGreaterThan(EMAIL_DELIVERY_CEILING_BYTES);
    const before = mailParseCount.n;
    const mail = await readMail(huge);
    expect(mailParseCount.n - before, "never handed to the parser").toBe(0);
    expect(mail.problem).toMatch(/^too big to read here: 25\.0 MB, over the 25 MB an email can be$/);
    expect(mail.text, "nothing below acts on its words").toBe("");
    expect(messageText(mail).unread).toMatch(/too big to read here/);
    expect(await readableMessage(huge), "a card or prompt says why it was not read").toMatch(/could not be read: too big to read here/);
    // At the ceiling exactly it is still an email, and is read.
    const atCeiling = huge.slice(0, EMAIL_DELIVERY_CEILING_BYTES);
    expect((await readMail(atCeiling)).problem).toBeNull();
  });

  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    // miniflare's R2 proxy takes only a body of known length; the door stores a stream (everyInboundMessageIsKept's shape).
    const docs = t.docs;
    env = makeTestEnv(t.db, {
      WP_OS_DOCUMENTS: new Proxy(docs, {
        get(target, prop, receiver) {
          if (prop === "put") {
            return async (key: string, value: unknown, opts?: R2PutOptions) =>
              target.put(key, (value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value) as ArrayBuffer, opts);
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
    });
  });
  afterAll(async () => {
    await disposeTestDb(t);
  });

  it("through the door: the .eml is kept in R2, it is put on the desk with its key, the event is written, and NOTHING is opened from it", async () => {
    const bytes = new TextEncoder().encode(MALFORMED);
    const cardsBefore = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>();
    const handled: DoorHandled[] = [];
    // A dealflow subject: read as an empty email, the door would still open a deal card from the subject alone.
    await handleInboundEmail(
      {
        from: "someone@example.com",
        to: INTAKE_MAILBOX,
        headers: new Headers({ from: "someone@example.com", to: INTAKE_MAILBOX, subject: "#wpdealflow Deepnest Robotics", "message-id": "<nesting-bomb@mail.example.com>" }),
        raw: new Blob([bytes]).stream(),
        rawSize: bytes.byteLength,
      },
      env,
      { onHandled: (h) => handled.push(h) },
    );
    expect(handled.map((h) => h.by), "the door stops at the failure and says so").toEqual(["unparseable"]);
    const cardsAfter = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>();
    expect(cardsAfter?.n, "no card is opened from a message nobody could read").toBe(cardsBefore?.n);
    const kept = await t.db.prepare("SELECT r2_key FROM inbound_message WHERE message_id LIKE '%nesting-bomb%'").first<{ r2_key: string }>();
    expect(kept?.r2_key, "the message is indexed").toBeTruthy();
    const obj = await env.WP_OS_DOCUMENTS!.get(kept!.r2_key);
    expect(await obj?.text(), "the whole message is in R2, byte for byte").toBe(MALFORMED);
    const flag = await t.db.prepare("SELECT title, body FROM notification WHERE dedupe_key LIKE 'unparseable:%'").first<{ title: string; body: string }>();
    expect(flag?.title).toMatch(/could not be read/);
    expect(flag?.body).toContain(kept!.r2_key);
    const event = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'inbound_email.unparseable'").first<{ n: number }>();
    expect(event?.n).toBe(1);
  });
});

describe("parsed once per request, held by the request", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  });
  afterAll(async () => {
    await disposeTestDb(t);
  });
  const arrive = (raw: string, subject: string, id: string) => {
    const bytes = new TextEncoder().encode(raw);
    return handleInboundEmail(
      {
        from: "founder@northwind.example",
        to: INTAKE_MAILBOX,
        headers: new Headers({ from: "founder@northwind.example", to: INTAKE_MAILBOX, subject, "message-id": `<${id}@mail.example.com>` }),
        raw: new Blob([bytes]).stream(),
        rawSize: bytes.byteLength,
      },
      env,
    );
  };

  it("a deck forward through the real door is parsed exactly once, and the card is made from it", async () => {
    const raw = MULTIPART.replace("multipart-fixture@", "once-door@");
    const cardsBefore = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>();
    const before = mailParseCount.n;
    await arrive(raw, "Fwd: Northwind deck", "once-door");
    expect(mailParseCount.n - before, "every reader in the request reads the door's one parse").toBe(1);
    const cardsAfter = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>();
    expect(cardsAfter!.n, "the readers really ran: the deck opened a card").toBeGreaterThan(cardsBefore!.n);
  });

  it("two messages arriving at once each open a card with only their own words", async () => {
    const one = (word: string) => MULTIPART.replace("multipart-fixture@", `iso-${word}@`).replace("we are raising a seed round.", `${word} is raising a seed round.`);
    await Promise.all([arrive(one("Alphawing"), "Fwd: Alphawing deck", "iso-a"), arrive(one("Betaroot"), "Fwd: Betaroot deck", "iso-b")]);
    const rows = (await t.db.prepare("SELECT description FROM work_card WHERE description LIKE '%Alphawing%' OR description LIKE '%Betaroot%'").all<{ description: string }>()).results;
    expect(rows.filter((r) => r.description.includes("Alphawing")).length, "the first message's card was made").toBeGreaterThan(0);
    expect(rows.filter((r) => r.description.includes("Betaroot")).length, "the second message's card was made").toBeGreaterThan(0);
    for (const r of rows) expect(r.description.includes("Alphawing") && r.description.includes("Betaroot"), "no card carries the other message's words").toBe(false);
  });
});

describe("a secret scrubbed out of a base64 body", () => {
  it("the value is gone, the message still parses, and the attachment's bytes are the same", async () => {
    const VALUE = "sk_live_scrub_fixture_9f2";
    const b64Body = btoa(`SECRET VENDOR_KEY=${VALUE}\n`);
    const raw = MULTIPART.replace("#wpdeck Deck attached =E2=80=94 we are raising a seed round.", "").replace(
      "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable",
      "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64",
    ).replace("Content-Transfer-Encoding: base64\r\n\r\n\r\n", `Content-Transfer-Encoding: base64\r\n\r\n${b64Body}\r\n`);
    const mail = await readMail(raw);
    expect(carriesSecretValue(mail, [VALUE])).toBe(true);
    const clean = await scrubSecretValues(mail, [VALUE]);
    expect(carriesSecretValue(clean, [VALUE])).toBe(false);
    expect(clean.raw).not.toContain(VALUE);
    expect(clean.text).toContain("[secret redacted]");
    const before = attachmentBytes(mail, "Northwind_Seed.pdf");
    const after = attachmentBytes(clean, "Northwind_Seed.pdf");
    expect(after && Buffer.from(after.bytes).equals(Buffer.from(before!.bytes))).toBe(true);
  });
});
