import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { handleGetRequestMessage, handleGetRequestMessageRaw } from "../src/worker/services/requestMessage";
import { startThread } from "../src/worker/services/emailThread";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import { threadReference } from "../src/shared/email/thread";
import type { FirmUserIdentity } from "../src/worker/auth";
import type { Env } from "../src/worker/env";

/**
 * EVERY INBOUND MESSAGE IS KEPT, INDEXED, AND READABLE (0226, owner 22 Sep 2026).
 *
 * "the original emails received for the work card or replied should be kept … we need to overhaul
 * this."
 *
 * WHAT THIS FILE IS ABOUT. On 21 Sep Scooter replied to a hire-search email. The door read the
 * reply as a NEW request, wrote the first 4,000 characters of raw MIME — `Received:`, `ARC-Seal:`,
 * DKIM headers — into the card's description, and stored no `.eml`. His words were never written
 * anywhere. Exactly one door of five kept a copy, so unrouted mail, deal tags with no company,
 * `#wpupdate`, small founder decks and every steering reply kept nothing at all.
 *
 * The store is now hoisted to `handleInboundEmailOnce`, which is the one place every message
 * passes. These tests drive the WHOLE HANDLER rather than the doors, because a keeper wired to one
 * arm of a branch is this repo's "runs but inert" defect and only the whole path can disprove it.
 */

let t: TestDb;
let env: Env;

// ── the harness ───────────────────────────────────────────────────────────────────────────────

/**
 * `FixedLengthStream` is a workerd global the oversize path stores through and node has none; and
 * miniflare's R2 proxy only takes a body of known length, so a streamed put is buffered in front of
 * it. The handler's own code path is what runs — this is the shape `oversizeDeckGoesThrough` uses.
 */
function installStreamShim(): void {
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
}

function bufferingBucket(docs: R2Bucket): R2Bucket {
  return new Proxy(docs, {
    get(target, prop, receiver) {
      if (prop === "put") {
        return async (key: string, value: unknown, opts?: R2PutOptions) => {
          const body = value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value;
          return target.put(key, body as ArrayBuffer, opts);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

const GENUINE_SCOOTER =
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=westpeek.ventures policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of scooter@westpeek.ventures designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=scooter@westpeek.ventures; ` +
  `arc=none`;
const FORGED = `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`;

let messageSeq = 0;

/**
 * A real multipart message, so the decode is exercised rather than assumed: a `text/plain` leaf
 * under a genuine header block, with the `Received:` and DKIM lines that used to fill the card.
 */
function mime(input: { from: string; subject: string; body: string; quote?: string }): string {
  return [
    "Received: from mail-yw1-x112b.google.com (mail-yw1-x112b.google.com [2607:f8b0:4864:20::112b])",
    "\tby mx.cloudflare.net with ESMTPS id 4a1c2f9e0b",
    "ARC-Seal: i=1; a=rsa-sha256; t=1758400000; cv=none; d=google.com; s=arc-20240605;",
    "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=westpeek.ventures; s=20251104;",
    `From: ${input.from}`,
    `To: ${INTAKE_MAILBOX}`,
    `Subject: ${input.subject}`,
    'Content-Type: multipart/alternative; boundary="b_0226"',
    "MIME-Version: 1.0",
    "",
    "--b_0226",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body,
    ...(input.quote
      ? ["", "On Mon, 21 Sep 2026 at 10:02, Walker <walker@joinwestpeek.com> wrote:", ...input.quote.split("\n").map((l) => `> ${l}`)]
      : []),
    "",
    "--b_0226--",
    "",
  ].join("\r\n");
}

interface Delivery {
  raw?: string;
  from: string;
  subject: string;
  auth?: string | null;
  inReplyTo?: string | null;
  messageId?: string | null;
  sizeOverride?: number;
  into?: Env;
}

function deliver(d: Delivery): Promise<void> {
  const raw = d.raw ?? mime({ from: d.from, subject: d.subject, body: "We are raising." });
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: d.from, to: INTAKE_MAILBOX, subject: d.subject });
  if (d.auth) headers.set("authentication-results", d.auth);
  if (d.inReplyTo) headers.set("in-reply-to", d.inReplyTo);
  headers.set("message-id", d.messageId ?? `<kept-${(messageSeq += 1)}@example.com>`);
  return handleInboundEmail(
    {
      from: d.from.includes("<") ? d.from.slice(d.from.indexOf("<") + 1, -1) : d.from,
      to: INTAKE_MAILBOX,
      headers,
      raw: new Blob([bytes]).stream(),
      rawSize: d.sizeOverride ?? bytes.byteLength,
    },
    d.into ?? env,
  );
}

async function stored(): Promise<Array<{ id: string; message_id: string; r2_key: string; from_address: string; subject: string; bytes: number; work_card_id: string | null }>> {
  return (
    await t.db
      .prepare("SELECT id, message_id, r2_key, from_address, subject, bytes, work_card_id FROM inbound_message ORDER BY created_at, rowid")
      .all<{ id: string; message_id: string; r2_key: string; from_address: string; subject: string; bytes: number; work_card_id: string | null }>()
  ).results ?? [];
}

async function cardCount(): Promise<number> {
  return (await t.db.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
}

const MP: FirmUserIdentity = {
  id: "fu_sequoia_taylor",
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

/** An ordinary employee-facing identity: may see the card, may not read the envelope. */
const ANALYST: FirmUserIdentity = {
  id: "fu_analyst",
  email: "analyst@joinwestpeek.com",
  fullName: "An Analyst",
  status: "ACTIVE",
  roles: ["INVESTMENT_TEAM"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

/** Somebody whose whole firm is a different one. The card must not exist for them at all. */
const OTHER_FIRM: FirmUserIdentity = {
  ...MP,
  id: "fu_other_firm",
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "other-firm" }],
};

function ask(handler: (ctx: never) => Promise<Response>, cardId: string, identity: FirmUserIdentity, suffix = ""): Promise<Response> {
  return (handler as unknown as (ctx: unknown) => Promise<Response>)({
    request: new Request(`https://os.joinwestpeek.com/api/work-cards/${cardId}/request-message${suffix}`),
    env,
    identity,
    params: { id: cardId },
  });
}

beforeAll(async () => {
  installStreamShim();
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: bufferingBucket(t.docs) });
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1 · every door keeps exactly one message, and indexes it ─────────────────────────────────

/**
 * PARAMETRISED OVER THE PATHS THAT KEPT NOTHING. Each of these took a different arm of
 * `handleInboundEmailOnce` and, before 0226, only the partner assignment stored anything. The
 * assertion is deliberately "exactly one" in both places: a message kept twice is two copies of a
 * partner's mail with nothing saying which is authoritative, and a row with no object (or an object
 * with no row) is the index and the bucket disagreeing, which is the defect the row exists to
 * remove.
 */
describe("every door keeps exactly one message and one index row", () => {
  const paths: Array<{ name: string; d: Delivery }> = [
    {
      name: "mail nobody could route",
      d: { from: "stranger@example.com", subject: "hello there" },
    },
    {
      name: "a deal tag with a company (the small founder deck)",
      d: { from: "ada@sensori.example", subject: "#wpdealflow Sensori", raw: mime({ from: "ada@sensori.example", subject: "#wpdealflow Sensori", body: "We are raising a pre-seed." }) },
    },
    {
      name: "a deal tag with no company anybody could read",
      d: { from: "ada@sensori.example", subject: "#wpdealflow", raw: mime({ from: "ada@sensori.example", subject: "#wpdealflow", body: "check this out" }) },
    },
    {
      name: "a portfolio update (#wpupdate)",
      d: { from: "ada@sensori.example", subject: "#wpupdate Sensori", raw: mime({ from: "ada@sensori.example", subject: "#wpupdate Sensori", body: "Revenue 120k, burn 40k." }) },
    },
    {
      name: "a #wpnetwork message whose person could not be read",
      d: { from: "ada@sensori.example", subject: "#wpnetwork", raw: mime({ from: "ada@sensori.example", subject: "#wpnetwork", body: "meet this person" }) },
    },
    {
      name: "an authenticated partner's assignment",
      d: { from: "Scooter Taylor <scooter@westpeek.ventures>", subject: "Find me two candidates", auth: GENUINE_SCOOTER, raw: mime({ from: "Scooter Taylor <scooter@westpeek.ventures>", subject: "Find me two candidates", body: "Find me two candidates for the ops role this week." }) },
    },
  ];

  for (const { name, d } of paths) {
    it(`keeps ${name}`, async () => {
      const before = (await stored()).length;
      await deliver(d);
      const rows = await stored();
      expect(rows.length, "exactly one index row per message, never two and never none").toBe(before + 1);

      const row = rows[rows.length - 1]!;
      expect(row.r2_key).toMatch(/^inbound-email\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.eml$/);
      expect(row.from_address).toContain("@");
      expect(row.bytes, "the size is recorded, so a truncated store is visible").toBeGreaterThan(0);

      const obj = await t.docs.get(row.r2_key);
      expect(obj, "the row names an object that is actually there").not.toBeNull();
      expect(await obj!.text(), "the WHOLE message, headers and all").toContain("DKIM-Signature:");
    });
  }

  it("a re-delivery of the same Message-ID keeps nothing new — one message, one copy", async () => {
    const id = "<redelivered@example.com>";
    await deliver({ from: "twice@example.com", subject: "sent twice", messageId: id });
    const after = (await stored()).length;
    await deliver({ from: "twice@example.com", subject: "sent twice", messageId: id });
    expect((await stored()).length, "the dedupe holds and so does the store").toBe(after);
  });
});

// ── 2 · the card carries words, not headers ──────────────────────────────────────────────────

describe("a routing card carries the sender's words, never the MIME", () => {
  it("has the founder's sentence and no Received: header, and names the key it was kept under", async () => {
    await deliver({
      from: "ada@sensori.example",
      subject: "a question about the fund",
      raw: mime({ from: "ada@sensori.example", subject: "a question about the fund", body: "Do you lead pre-seed rounds in climate hardware?" }),
    });
    const rows = await stored();
    const row = rows[rows.length - 1]!;
    expect(row.work_card_id, "the card this message produced is on the index row").not.toBeNull();

    const card = await t.db.prepare("SELECT description FROM work_card WHERE id = ?1").bind(row.work_card_id).first<{ description: string }>();
    const description = String(card!.description);
    expect(description, "the words the founder typed").toContain("Do you lead pre-seed rounds in climate hardware?");
    // THE 21 SEP FAILURE, pinned directly. The card used to open with the transport's own headers.
    expect(description, "never the envelope").not.toMatch(/Received: from/);
    expect(description).not.toMatch(/DKIM-Signature:/);
    expect(description).not.toMatch(/ARC-Seal:/);
    expect(description, "and it says where the whole message is").toContain(`Stored message: ${row.r2_key}`);
  });
});

// ── 3 · a steering reply is kept and linked to the work it steered ───────────────────────────

describe("a steering reply", () => {
  it("is indexed and linked to the card it steered — the 21 Sep failure, closed", async () => {
    const card = await createWorkCardInternal(
      env,
      { ...MP, authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }] },
      { title: "Walker: hire search", description: "two candidates", owner_type: "AI", owner_id: "Walker", firm_scope: "west-peek", kind: "HIRE_SEARCH" },
    );
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: card.id,
      cardKind: "HIRE_SEARCH",
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search - 2 candidate(s) this week",
      firmScope: "west-peek",
    });

    await deliver({
      from: "Scooter Taylor <scooter@westpeek.ventures>",
      subject: "Re: Walker: hire search - 2 candidate(s) this week",
      auth: GENUINE_SCOOTER,
      inReplyTo: threadReference(token),
      raw: mime({
        from: "Scooter Taylor <scooter@westpeek.ventures>",
        subject: "Re: Walker: hire search - 2 candidate(s) this week",
        body: "Yes to the second one. Drop the first.",
        quote: "Two candidates this week:\n1. …\n2. …",
      }),
    });

    const rows = await stored();
    const row = rows[rows.length - 1]!;
    expect(row.work_card_id, "the reply points at the work it steered").toBe(card.id);

    // THE QUOTED HALF IS NOT LOST — which is the half a steer deliberately does not act on and used
    // to throw away entirely. It is in the stored message even though it is not in the steer.
    const obj = await t.docs.get(row.r2_key);
    const raw = await obj!.text();
    expect(raw).toContain("Yes to the second one.");
    expect(raw, "his client's quote, still recoverable").toContain("Two candidates this week:");

    const steer = await t.db.prepare("SELECT body FROM work_steer ORDER BY created_at DESC LIMIT 1").first<{ body: string }>();
    expect(steer!.body, "the steer itself is still the written half only").toContain("Yes to the second one.");
    expect(steer!.body).not.toContain("Two candidates this week:");
  });
});

// ── 4 · a spoof is not archived under a partner's name ───────────────────────────────────────

describe("a message claiming a partner that did not authenticate", () => {
  it("stores nothing at all, and still opens a card with its words and the reason", async () => {
    const before = await stored();
    const cardsBefore = await cardCount();
    await deliver({
      from: "Scooter Taylor <scooter@westpeek.ventures>",
      subject: "wire the money to this account",
      auth: FORGED,
      raw: mime({ from: "Scooter Taylor <scooter@westpeek.ventures>", subject: "wire the money to this account", body: "Please wire $50,000 to the account below." }),
    });

    expect((await stored()).length, "a forgery is never archived under a partner's name").toBe(before.length);
    const keys = (await t.docs.list()).objects.map((o) => o.key);
    expect(keys.filter((k) => !before.some((r) => r.r2_key === k) && k.startsWith("inbound-email/")), "and no orphan object either").toHaveLength(0);

    // NOTHING IS DROPPED. The message still becomes a card carrying its words and the verdict.
    expect(await cardCount(), "the message is still on the record").toBe(cardsBefore + 1);
    const card = await t.db.prepare("SELECT description FROM work_card ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ description: string }>();
    expect(String(card!.description)).toContain("Please wire $50,000");
    expect(String(card!.description), "the card says why it was not kept").toMatch(/did not authenticate/);

    const event = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'inbound_email.not_stored_spoof' ORDER BY rowid DESC LIMIT 1")
      .first<{ payload_json: string }>();
    expect(event, "the refusal is on the spine — a check that records nothing when it refuses is indistinguishable from one that never ran").not.toBeNull();
  });

  it("does not touch ordinary mail: a founder is neither a partner nor a spoof", async () => {
    const before = (await stored()).length;
    await deliver({ from: "ada@sensori.example", subject: "no auth header at all" });
    expect((await stored()).length, "an unauthenticated founder's mail is kept exactly as before").toBe(before + 1);
  });
});

// ── 5 · a failed store is never silent, and never loses the message ──────────────────────────

describe("when R2 refuses the put", () => {
  it("appends inbound_email.store_failed and still opens the card with the text", async () => {
    const broken = makeTestEnv(t.db, {
      WP_OS_DOCUMENTS: new Proxy(t.docs, {
        get(target, prop, receiver) {
          if (prop === "put") return async () => { throw new Error("R2 said no"); };
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as R2Bucket,
    });

    const before = (await stored()).length;
    const cardsBefore = await cardCount();
    await deliver({
      from: "ada@sensori.example",
      subject: "the store is broken today",
      raw: mime({ from: "ada@sensori.example", subject: "the store is broken today", body: "This still has to reach somebody." }),
      into: broken,
    });

    const event = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'inbound_email.store_failed' ORDER BY rowid DESC LIMIT 1")
      .first<{ payload_json: string }>();
    expect(event, "the failure is on the spine — `catch { emlKey = null }` said nothing for a month").not.toBeNull();
    expect(String(event!.payload_json), "and it says why").toContain("R2 said no");

    expect((await stored()).length, "no index row for an object that was never written").toBe(before);
    // THE MESSAGE IS NOT DROPPED BECAUSE STORAGE FAILED. Both halves matter.
    expect(await cardCount()).toBe(cardsBefore + 1);
    const card = await t.db.prepare("SELECT description FROM work_card ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ description: string }>();
    expect(String(card!.description)).toContain("This still has to reach somebody.");
    expect(String(card!.description), "and the card says the original is not kept, rather than implying it is").toMatch(/could NOT be kept/);
  });
});

// ── 6 · reading it back ──────────────────────────────────────────────────────────────────────

describe("the request-message routes", () => {
  let cardId = "";

  beforeAll(async () => {
    await deliver({
      from: "ada@sensori.example",
      subject: "reading it back",
      raw: mime({ from: "ada@sensori.example", subject: "reading it back", body: "The tagline should read 'built for founders'." }),
    });
    const rows = await stored();
    cardId = rows[rows.length - 1]!.work_card_id!;
  });

  it("serves the decoded body, and says the raw is there", async () => {
    const res = await ask(handleGetRequestMessage, cardId, ANALYST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: string; subject: string; text: string; has_raw: boolean; r2_key: string; message_id: string };
    expect(body.from).toBe("ada@sensori.example");
    expect(body.text).toContain("built for founders");
    expect(body.text, "decoded, never the envelope").not.toMatch(/Received: from/);
    expect(body.has_raw).toBe(true);
    expect(body.r2_key).toMatch(/^inbound-email\//);
    expect(body.message_id).toMatch(/@example\.com$/);
  });

  it("serves the raw message to a Managing Partner, and records the read", async () => {
    const res = await ask(handleGetRequestMessageRaw, cardId, MP, "/raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text(), "exactly as it arrived").toContain("ARC-Seal:");
    const event = await t.db
      .prepare("SELECT actor_id FROM event_record WHERE event_type = 'inbound_message.read_raw' ORDER BY rowid DESC LIMIT 1")
      .first<{ actor_id: string }>();
    expect(event!.actor_id).toBe(MP.id);
  });

  it("refuses the raw message to anyone who is not a Managing Partner", async () => {
    const res = await ask(handleGetRequestMessageRaw, cardId, ANALYST, "/raw");
    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { detail: string }).detail)).toMatch(/Managing Partner/);
  });

  /*
   * 404 AND NOT 403, on both routes. The caller is in a different firm scope, so the card's very
   * existence is the fact being withheld — a 403 would confirm it. This is the guard the notes
   * routes on the same resource do not have: they read `SELECT id FROM work_card WHERE id = ?1`
   * with no scope and no privacy clause, which is why these routes import `getVisibleWorkCard`
   * rather than copying that shape.
   */
  it("404s outside the caller's firm scope, on both routes", async () => {
    expect((await ask(handleGetRequestMessage, cardId, OTHER_FIRM)).status).toBe(404);
    expect((await ask(handleGetRequestMessageRaw, cardId, OTHER_FIRM, "/raw")).status).toBe(404);
  });

  it("404s for a card that has no inbound message indexed against it", async () => {
    const card = await createWorkCardInternal(env, MP, {
      title: "Raised by hand",
      description: "nobody emailed this in",
      owner_type: "AI",
      owner_id: "Walker",
      firm_scope: "west-peek",
    });
    const res = await ask(handleGetRequestMessage, card.id, MP);
    expect(res.status).toBe(404);
    expect(String(((await res.json()) as { detail?: string }).detail)).toMatch(/no inbound message/);
  });
});
