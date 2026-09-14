import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { DEAL_INTAKE_EMPLOYEE, INTAKE_MAILBOX, ROUTING_EMPLOYEE, seatId } from "../src/shared/intake/emailTriggers";
import { sweepOnce } from "../src/worker/services/workSweep";
import { companyKnowledge } from "../src/worker/services/employeeWork";
import type { Env } from "../src/worker/env";

/**
 * A DECK OF ANY SIZE GOES THROUGH.
 *
 * Operator, 14 Sep 2026: "i want to not have a problem with oversized decks at all... all sizes
 * should go thru." A message over the size cap used to open a card headed "Too big to read" for the
 * routing seat while a small deck opened the analyst's own card; Sensori (7.1MB) and Vynlo (2.5MB)
 * sat BLOCKED on that difference for three weeks. Now the analyst's card is opened at the door
 * exactly as for a small deck, the stored message is queued against it, the sweep waits for the
 * reading, and the analyst starts with the deck's contents in hand. Size is never a fact the
 * analyst is told.
 */

let t: TestDb;
let env: Env;
const ANALYST = seatId(DEAL_INTAKE_EMPLOYEE);
const ROUTER = seatId(ROUTING_EMPLOYEE);
const NOW = new Date("2026-09-14T16:00:00.000Z");

function deliver(subject: string, sizeBytes: number): Promise<void> {
  // A real body of the stated size: R2 stores through a FixedLengthStream and refuses a mismatch.
  const head = `Subject: ${subject}\r\nFrom: scooter@westpeek.ventures\r\n\r\nDeck attached.\r\n`;
  const bytes = new Uint8Array(sizeBytes);
  bytes.set(new TextEncoder().encode(head));
  bytes.fill(0x41, head.length);
  return handleInboundEmail(
    {
      from: "scooter@westpeek.ventures",
      to: INTAKE_MAILBOX,
      headers: new Headers({ subject, from: "scooter@westpeek.ventures" }),
      raw: new Blob([bytes]).stream(),
      rawSize: sizeBytes,
    },
    env,
  );
}

async function cards(owner: string): Promise<Array<{ id: string; title: string; state: string; description: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT id, title, state, description FROM work_card WHERE owner_id = ?1 ORDER BY created_at")
      .bind(owner)
      .all<{ id: string; title: string; state: string; description: string }>()
  ).results ?? [];
}

beforeAll(async () => {
  // `FixedLengthStream` is a workerd global the handler stores the message through; node has none.
  // The test gives it a plain TransformStream, and stands a bucket in front of miniflare's R2 that
  // buffers a streamed body (miniflare's proxy only takes streams of known length). The handler's
  // own code path — pipe through the sized stream, put the readable half — is what runs.
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
  const bucket = new Proxy(t.docs, {
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
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: bucket });
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a 7MB deck for a company named in the subject", () => {
  it("opens the analyst's own card — the same card a small deck opens — and queues the deck against it", async () => {
    await deliver("#wpdealflow Sensori", 7 * 1024 * 1024);
    const routing = await cards(ROUTER);
    expect(routing.filter((c) => /Too big to read|Deck arriving/.test(c.title)), "no human-shaped card about a machine limit").toHaveLength(0);
    const mine = await cards(ANALYST);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe("Deck: Sensori");
    expect(mine[0]!.description).not.toMatch(/Too big/);
    const deck = await env.WP_OS_DB.prepare("SELECT company_id, work_card_id, state, bytes FROM pending_deck ORDER BY created_at DESC LIMIT 1")
      .first<{ company_id: string | null; work_card_id: string | null; state: string; bytes: number }>();
    expect(deck!.work_card_id).toBe(mine[0]!.id);
    expect(deck!.company_id, "the company was registered at the door, not left for later").not.toBeNull();
    expect(deck!.state).toBe("PENDING");
    expect(deck!.bytes).toBe(7 * 1024 * 1024);
    expect(MAX_BODY_BYTES).toBeLessThan(7 * 1024 * 1024);
  });

  it("the sweep waits for the reading, then the analyst starts with the deck's contents in hand", async () => {
    const [card] = await cards(ANALYST);
    let handed: string[] = [];
    const waited = await sweepOnce(env, NOW, { general: async () => { throw new Error("must not be worked before the deck is read"); } });
    expect(waited.outcome).toBe("WAITING_ON_DECK");
    await env.WP_OS_DB.prepare("UPDATE pending_deck SET state = 'READ', applied_json = ?1, read_at = ?2 WHERE work_card_id = ?3")
      .bind(JSON.stringify({ claims: ["$4.2M ARR run-rate", "61% of U.S. adults plan to drink less"], missing: ["Team bios"] }), NOW.toISOString(), card!.id)
      .run();
    const worked = await sweepOnce(env, new Date(NOW.getTime() + 20 * 60_000), {
      general: async (e, _ctx, cardId) => {
        handed = await companyKnowledge(e, "Deck: Sensori", cardId);
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: "opened at the top of the funnel", steps: [{ action: "done", detail: "opened at the top of the funnel" }] };
      },
    });
    expect(worked.card?.id).toBe(card!.id);
    expect(worked.outcome).toBe("DONE");
    expect(handed.join("\n")).toMatch(/claims: \$4\.2M ARR run-rate/);
  });
});

describe("a 3MB deck with no subject at all", () => {
  it("opens a routing card that says it is being read, and the reader's hand-off closes it in favour of the analyst's card", async () => {
    await deliver("", 3 * 1024 * 1024);
    const routing = (await cards(ROUTER)).filter((c) => c.title.startsWith("Deck arriving"));
    expect(routing).toHaveLength(1);
    expect(routing[0]!.state).toBe("OPEN");
    expect(routing[0]!.description).toMatch(/being read from the stored copy/);
    const deck = await env.WP_OS_DB.prepare("SELECT id, work_card_id FROM pending_deck WHERE work_card_id = ?1").bind(routing[0]!.id).first<{ id: string; work_card_id: string }>();
    expect(deck).toBeTruthy();
    // The reader, having found the company inside the deck, hands it to the analyst.
    const { intakeDealFromEmail } = await import("../src/worker/services/dealIntake");
    const opened = await intakeDealFromEmail(env, { company: "Vynlo", from: "scooter@westpeek.ventures", isDeck: true, raw: "" });
    const { __handOffToAnalystForTests } = await import("../src/worker/services/deckQueue");
    await __handOffToAnalystForTests(env, { id: deck!.id, work_card_id: deck!.work_card_id }, opened.work_card_id);
    const closed = await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(routing[0]!.id).first<{ state: string; description: string }>();
    expect(closed!.state).toBe("DONE");
    expect(closed!.description).toMatch(/went to the analyst as work card/);
    const repointed = await env.WP_OS_DB.prepare("SELECT work_card_id FROM pending_deck WHERE id = ?1").bind(deck!.id).first<{ work_card_id: string }>();
    expect(repointed!.work_card_id).toBe(opened.work_card_id);
  });
});
