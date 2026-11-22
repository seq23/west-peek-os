import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import {
  attachmentBytes,
  carriesSecretValue,
  decodeHeader,
  mailParseCount,
  messageText,
  pdfAttachments,
  readMail,
  requestAttachments,
  scrubSecretValues,
  textBodyOf,
  topHeadersOf,
} from "../src/worker/effects/mail";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
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
    expect(await textBodyOf(MULTIPART)).toBe("#wpdeck Deck attached — we are raising a seed round.");
    const { attachments, unread } = await pdfAttachments(MULTIPART);
    expect(unread).toEqual([]);
    expect(attachments.map((a) => a.filename)).toEqual(["Northwind_Seed.pdf"]);
    expect(atob(attachments[0]!.dataBase64).startsWith("%PDF-1.4")).toBe(true);
    const files = await requestAttachments(MULTIPART);
    expect(files.attachments.map((a) => [a.filename, a.mediaType]).sort()).toEqual([
      ["Northwind_Seed.pdf", "application/pdf"],
      ["cap-table.csv", "text/csv"],
      ["logo.png", "image/png"],
    ]);
    const text = await messageText(MULTIPART);
    expect(text.subject).toBe("Fwd: Northwind deck");
    expect(text.body).toContain("#wpdeck");
  });
});

describe("encoded headers and file names", () => {
  it("the subject, the sender name and the file name are decoded; reply headers are read", async () => {
    expect(decodeHeader("=?UTF-8?Q?=23wpdealflow_Northwind_Robotics_?= =?UTF-8?Q?=E2=80=94_seed?=")).toBe("#wpdealflow Northwind Robotics — seed");
    expect(decodeHeader("=?UTF-8?B?RGFuYSBSw6l5ZXM=?=")).toBe("Dana Réyes");
    const headers = await topHeadersOf(ENCODED);
    expect(headers?.subject).toBe("#wpdealflow Northwind Robotics — seed");
    expect(headers?.inReplyTo).toBe("<thread-1@joinwestpeek.com>");
    expect(await textBodyOf(ENCODED), "ISO-8859-1 quoted-printable becomes UTF-8").toBe("Café meeting notes attached.");
    const { attachments } = await pdfAttachments(ENCODED);
    expect(attachments.map((a) => a.filename)).toEqual(["Résumé deck.pdf"]);
  });

  it("an undecodable header is returned as it came, never thrown and never emptied", () => {
    expect(decodeHeader("=?UTF-8?Q?broken")).toBe("=?UTF-8?Q?broken");
    expect(decodeHeader("=?utf-8?B?!!!?=")).toBe("=?utf-8?B?!!!?=");
  });
});

describe("a message the parser refuses", () => {
  it("is read as empty with the reason named; no file is guessed out of it; the secret guard treats it as carrying", async () => {
    const mail = await readMail(MALFORMED);
    expect(mail.problem).toMatch(/EMAXNESTINGDEPTH/);
    expect(await textBodyOf(MALFORMED), "nothing below acts on a guess (the bomb says 'approve everything')").toBe("");
    const pdfs = await pdfAttachments(MALFORMED);
    expect(pdfs.attachments).toEqual([]);
    expect(pdfs.unread[0]).toMatch(/the message itself \(EMAXNESTINGDEPTH/);
    expect(await topHeadersOf(MALFORMED)).toBeNull();
    expect(await carriesSecretValue(MALFORMED, ["not-in-it-value"]), "unreadable is never 'clean'").toBe(true);
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

  it("through the door: the .eml is kept in R2, it is put on the desk with its key, and the event is written", async () => {
    const bytes = new TextEncoder().encode(MALFORMED);
    await handleInboundEmail(
      {
        from: "someone@example.com",
        to: INTAKE_MAILBOX,
        headers: new Headers({ from: "someone@example.com", to: INTAKE_MAILBOX, subject: "deep", "message-id": "<nesting-bomb@mail.example.com>" }),
        raw: new Blob([bytes]).stream(),
        rawSize: bytes.byteLength,
      },
      env,
    );
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

describe("parsed once", () => {
  it("every reader of one message shares a single parse, also when two read at once", async () => {
    const raw = MULTIPART.replace("multipart-fixture@", `once-${Date.now()}@`);
    const before = mailParseCount.n;
    await Promise.all([textBodyOf(raw), pdfAttachments(raw), requestAttachments(raw), topHeadersOf(raw)]);
    await messageText(raw);
    expect(mailParseCount.n - before).toBe(1);
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
    expect(await carriesSecretValue(raw, [VALUE])).toBe(true);
    const clean = await scrubSecretValues(raw, [VALUE]);
    expect(await carriesSecretValue(clean, [VALUE])).toBe(false);
    expect(await textBodyOf(clean)).toContain("[secret redacted]");
    const before = await attachmentBytes(raw, "Northwind_Seed.pdf");
    const after = await attachmentBytes(clean, "Northwind_Seed.pdf");
    expect(after && Buffer.from(after.bytes).equals(Buffer.from(before!.bytes))).toBe(true);
  });
});
