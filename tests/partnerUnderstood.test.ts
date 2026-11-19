import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import { sweepOnce } from "../src/worker/services/workSweep";
import { sendUnderstoodReplies, parseUnderstood, type SeatRead } from "../src/worker/services/partnerUnderstood";
import type { Env } from "../src/worker/env";

/**
 * EMAILING THE OS FEELS LIKE TYPING TO CLAUDE — steps 1 and 7 (14 Nov 2026).
 *
 * Step 1: a partner's email that opens a card gets ONE "Got it" on his thread listing each ask in his words; with no
 * seat it still goes, quoting his sentences, and nothing was sent to a free lane.
 * Step 7: the DONE reply marks every stored ask; a report that leaves one out sends no DONE and re-parks the card.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];

const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=westpeek.ventures policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;

function deliver(subject: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({ from: '"Sequoia Taylor" <sequoia@westpeek.ventures>', subject, "authentication-results": genuineFrom("sequoia@westpeek.ventures"), "message-id": `<${crypto.randomUUID()}@mail.test>` });
  return handleInboundEmail({ from: "sequoia@westpeek.ventures", to: INTAKE_MAILBOX, headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}

const ASK_1 = "look at Sensori and tell me if it is worth a call";
const ASK_2 = "pull their last two rounds";
const ASK_3 = "draft a two-line intro to Scooter";
const BODY = `Wren, can you ${ASK_1}? Also ${ASK_2}. And ${ASK_3}.`;

async function cardFor(subject: string): Promise<{ id: string; state: string; next_action: string | null }> {
  return (await env.WP_OS_DB.prepare("SELECT id, state, next_action FROM work_card WHERE title LIKE ?1 ORDER BY created_at DESC LIMIT 1").bind(`%${subject}%`).first<{ id: string; state: string; next_action: string | null }>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs, WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("step 1: Got it, in his words", () => {
  it("a 3-ask email gets exactly one Got it, to the partner only, with each ask quoted in his words", async () => {
    await deliver("Sensori", BODY);
    const card = await cardFor("Sensori");
    expect(sent).toHaveLength(0);
    const read: SeatRead = async () => ({ ok: true, detail: "ok", text: `ASK: ${ASK_1}\nASK: ${ASK_2}\nASK: ${ASK_3}\nASK: something he never wrote\nNEXT: Wren looks at Sensori first.` });
    expect(await sendUnderstoodReplies(env, new Date(), read)).toBe(1);
    expect(await sendUnderstoodReplies(env, new Date(), read), "a second tick sends nothing").toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("sequoia@westpeek.ventures");
    for (const ask of [ASK_1, ASK_2, ASK_3]) expect(sent[0]!.text).toContain(`"${ask}"`);
    expect(sent[0]!.text, "an ask that is not his words is dropped").not.toContain("something he never wrote");
    const asks = (await env.WP_OS_DB.prepare("SELECT words FROM partner_ask WHERE work_card_id = ?1 ORDER BY seq").bind(card.id).all<{ words: string }>()).results;
    expect(asks.map((a) => a.words)).toEqual([ASK_1, ASK_2, ASK_3]);
  });

  it("with no seat, the sweep still sends one Got it quoting his sentences, and no free lane was asked", async () => {
    const before = sent.length;
    await deliver("Northwind", "Please send me the Northwind deck summary. Then book a call with their CFO.");
    await sweepOnce(env, new Date(), { general: async () => ({ finished: false, blocked: false, detail: "", steps: [] }) });
    const mine = sent.slice(before).filter((m) => /got it/i.test(m.subject));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe("sequoia@westpeek.ventures");
    expect(mine[0]!.text).toContain('"Please send me the Northwind deck summary."');
    expect(mine[0]!.text).toContain('"Then book a call with their CFO."');
    const via = await env.WP_OS_DB.prepare("SELECT u.via FROM partner_understood u JOIN work_card c ON c.id = u.work_card_id WHERE c.title LIKE '%Northwind%'").first<{ via: string }>();
    expect(via!.via).toBe("FALLBACK");
    // The test firm has no seat and no provider: the only thing that may answer is the in-process local mock. A free
    // (or any outside) lane would show as a provider on the run.
    const runs = (await env.WP_OS_DB.prepare("SELECT provider_id, model FROM ai_run WHERE purpose LIKE 'the Got it%'").all<{ provider_id: string | null; model: string | null }>()).results;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.filter((r) => r.provider_id !== null || r.model !== "mock-local"), "no outside lane was asked").toEqual([]);
  });
});

describe("step 7: the DONE reply answers every ask", () => {
  it("a report missing an ask sends no DONE and re-parks the card; a full report sends one DONE marking all three", async () => {
    const card = await cardFor("Sensori");
    // Worked by the general loop here (an emailed card is a partner session now, whose own report carries the asks:
    // tests/partnerSession.test.ts); this proves the guard every finishing kind passes.
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = NULL, lease_until = NULL, waiting_until = NULL WHERE id = ?1").bind(card.id).run();
    // The earlier tick's session run for it is put away with it.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED' WHERE work_card_id = ?1 AND status IN ('QUEUED', 'CLAIMED')").bind(card.id).run();
    // The Northwind card is older and still waiting; park it so the sweep claims Sensori.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE title LIKE '%Northwind%'").run();
    // Every other card in the firm out of the way too, so the claim is this one.
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = '2999-01-01T00:00:00.000Z' WHERE id <> ?1").bind(card.id).run();
    const partial = JSON.stringify({ asks: [{ words: ASK_1, status: "DONE", why: "Real company, on thesis; worth a call." }, { words: ASK_2, status: "IN_PROGRESS", why: "Seed found; Series A still being checked." }] });
    const before = sent.length;
    const first = await sweepOnce(env, new Date(), {
      general: async (e, _ctx, cardId) => {
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: `Sensori is worth a call.\n${partial}`, steps: [{ action: "done", detail: `Sensori is worth a call.\n${partial}` }] };
      },
    });
    expect(first.card?.id, first.summary).toBe(card.id);
    expect(sent.slice(before).filter((m) => /^done|done —/i.test(m.subject)), "no DONE while an ask has no status").toHaveLength(0);
    const parked = await cardFor("Sensori");
    expect(parked.state).toBe("IN_PROGRESS");
    expect(parked.next_action).toContain(ASK_3);

    const full = JSON.stringify({ asks: [{ words: ASK_3, status: "NOT_DONE", why: "Scooter asked to hold intros this week." }] });
    const second = await sweepOnce(env, new Date(), {
      general: async (e, _ctx, cardId) => {
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: `Intro held.\n${full}`, steps: [{ action: "done", detail: `Intro held.\n${full}` }] };
      },
    });
    expect(second.outcome).toBe("DONE");
    const done = sent.slice(before).filter((m) => /done/i.test(m.subject));
    expect(done).toHaveLength(1);
    expect(done[0]!.to).toBe("sequoia@westpeek.ventures");
    expect(done[0]!.text).toContain(`Done: "${ASK_1}"`);
    expect(done[0]!.text).toContain(`In progress: "${ASK_2}"`);
    expect(done[0]!.text).toContain(`Not done: "${ASK_3}" — Scooter asked to hold intros this week.`);
  });
});


describe("first-read decision", () => {
  it("keeps a structured decision and treats old or malformed reads as absent", () => {
    const words = "Please confirm the plan";
    const decision = { kind: "question", property: null, handOffTo: null, planApproved: false, holds: [] };
    expect(parseUnderstood(`ASK: ${words}\nDECISION: ${JSON.stringify(decision)}`, words).decision).toEqual(decision);
    expect(parseUnderstood(`ASK: ${words}`, words).decision).toBeNull();
    expect(parseUnderstood(`ASK: ${words}\nDECISION: {"kind":"approve"}`, words).decision).toBeNull();
  });
});
