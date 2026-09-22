import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import { assignCard, workCard } from "../src/worker/services/employeeWork";
import { sweepOnce } from "../src/worker/services/workSweep";
import { blockCard } from "../src/worker/services/blocks";
import { replyToRequester } from "../src/worker/services/requestReply";
import { employeeSenderHeader } from "../src/shared/registry/employeeMail";
import { buildStepPrompt, parseDecision } from "../src/shared/work/employeeLoop";
import type { Env } from "../src/worker/env";

/**
 * A PARTNER EMAILS A REQUEST; THE RIGHT EMPLOYEE DOES IT; THE PARTNER'S INBOX HEARS BACK.
 *
 * Operator, 14 Sep 2026: "make sure e2e that sequoia@ and scooter@ can email os@joinwestpeek.com for
 * requests and they will be routed to the right employee by porter and they will be completed e2e
 * and we will be notified when its done."
 *
 * What the review found before this file existed (CONFIRMED by reading, never exercised in
 * production — no partner had ever emailed the mailbox):
 *   1 · The chief of staff's card said "work out who should do this and assign them", and the
 *       employee loop had no `assign` action. The one move the brief asked for was not on the menu.
 *   2 · Completion was announced inside the OS only. A request that came from an inbox got no
 *       answer in that inbox.
 * This file drives the whole path through the real handler, the real sweep and the real reply.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-09-14T18:00:00.000Z");

const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=westpeek.ventures policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;

function deliver(headers: Record<string, string>, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  return handleInboundEmail(
    { from: headers.from ?? "someone@example.com", to: INTAKE_MAILBOX, headers: new Headers(headers), raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength },
    env,
  );
}

type Card = { id: string; title: string; owner_id: string; state: string; description: string; requested_by_email: string | null; assigned_from_card_id: string | null };
async function cardsOwnedBy(owner: string): Promise<Card[]> {
  return (await env.WP_OS_DB.prepare("SELECT id, title, owner_id, state, description, requested_by_email, assigned_from_card_id FROM work_card WHERE owner_id = ?1 ORDER BY created_at").bind(owner).all<Card>()).results ?? [];
}

const sent: Array<{ to: string; subject: string; text: string; from: string; html?: string; reply_to?: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; from: string; html?: string; reply_to?: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, from: body.from, html: body.html, reply_to: body.reply_to });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("Sequoia emails a request", () => {
  let chiefCard: Card;
  let analystCard: Card;

  it("lands on her chief of staff's desk, remembering that SHE asked, by email", async () => {
    await deliver(
      { from: '"Sequoia Taylor" <sequoia@westpeek.ventures>', subject: "Check whether Sensori is real and fits the thesis", "authentication-results": genuineFrom("sequoia@westpeek.ventures") },
      "Wren — can someone look at Sensori, the functional drinks company, and tell me if it is worth a call?",
    );
    const wren = await cardsOwnedBy("aie_wren");
    expect(wren).toHaveLength(1);
    chiefCard = wren[0]!;
    expect(chiefCard.title).toMatch(/^From sequoia@westpeek\.ventures: Check whether Sensori/);
    expect(chiefCard.requested_by_email).toBe("sequoia@westpeek.ventures");
  });

  it("the chief's brief offers `assign` with the roster, and a hand-off decision parses", async () => {
    const prompt = buildStepPrompt(
      { title: chiefCard.title, next_action: null, description: chiefCard.description, employee_name: "Wren", employee_role: "Sequoia's Chief of Staff", allows_browser: false, prompt: null, guidance: "", history: [], colleagues: [{ name: "Wyatt", role: "Analyst & Scout" }, { name: "Preston", role: "Finance & Fund Admin" }] },
      5,
    );
    expect(prompt).toMatch(/assign — hand this to the colleague whose job it is/);
    expect(prompt).toMatch(/Wyatt — Analyst & Scout/);
    expect(parseDecision('{"action":"assign","to":"Wyatt","brief":"Verify Sensori is real and on-thesis; say whether it is worth a call."}')).toEqual({
      action: "assign", to: "Wyatt", brief: "Verify Sensori is real and on-thesis; say whether it is worth a call.",
    });
    expect(parseDecision('{"action":"assign","to":"Wyatt"}'), "a hand-off with no brief is not a decision").toBeNull();
    // Without colleagues the action is not offered at all.
    expect(buildStepPrompt({ title: "x", next_action: null, description: null, employee_name: "Wyatt", employee_role: "Analyst", allows_browser: false, prompt: null, guidance: "", history: [] }, 3)).not.toMatch(/assign —/);
  });

  it("the sweep works the chief's card; handing it to Wyatt opens Wyatt's card carrying the brief, the request, and who asked", async () => {
    const out = await sweepOnce(env, NOW, {
      general: async (e, ctx, cardId) => {
        // Stand in for the model's single decision; everything after it is the real code path.
        const card = (await e.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(cardId).first())!;
        const handed = await assignCard(e, card as never, { id: "aie_wren", name: "Wren" }, "Wyatt", "Verify Sensori is real and on-thesis; say whether it is worth a call.");
        expect(handed.ok).toBe(true);
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        const line = `Handed to Wyatt as work card ${(handed as { cardId: string }).cardId}`;
        return { finished: true, blocked: false, detail: line, steps: [{ action: "assigned", detail: line }] };
      },
    });
    expect(out.card?.id).toBe(chiefCard.id);
    expect(out.outcome).toBe("HANDED_ON");
    expect(sent, "a hand-off is not the answer; no email yet").toHaveLength(0);

    const wyatt = await cardsOwnedBy("aie_wyatt");
    expect(wyatt).toHaveLength(1);
    analystCard = wyatt[0]!;
    expect(analystCard.title).toBe("Verify Sensori is real and on-thesis; say whether it is worth a call.");
    expect(analystCard.description).toMatch(/Wren handed this to you; it was asked for by sequoia@westpeek\.ventures by email/);
    expect(analystCard.description).toMatch(/worth a call\?/);
    expect(analystCard.requested_by_email).toBe("sequoia@westpeek.ventures");
    expect(analystCard.assigned_from_card_id).toBe(chiefCard.id);
    const notice = await env.WP_OS_DB.prepare("SELECT title FROM notification WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(chiefCard.id).first<{ title: string }>();
    expect(notice!.title).toMatch(/Wren handed .* to a colleague/);
  });

  it("when Wyatt finishes, Sequoia's inbox gets the answer — from WYATT, naming Wren who routed it, to the authenticated address only", async () => {
    const out = await sweepOnce(env, new Date(NOW.getTime() + 5 * 60_000), {
      general: async (e, _ctx, cardId) => {
        await e.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
        return { finished: true, blocked: false, detail: "Sensori is real: named angels, a live product, on-thesis CPG. Worth a call.", steps: [{ action: "done", detail: "Sensori is real: named angels, a live product, on-thesis CPG. Worth a call." }] };
      },
    });
    expect(out.card?.id).toBe(analystCard.id);
    expect(out.outcome).toBe("DONE");
    expect(out.summary).toMatch(/sequoia@westpeek\.ventures emailed/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("sequoia@westpeek.ventures");
    /*
     * THE DOER SIGNS IT — REWRITTEN STRICTER, 22 Sep 2026.
     *
     * This line used to pin `os@westpeek.ventures`, the FIRM's address, and the test's own name
     * said "from the firm". That was the defect written down as the expectation: `transport()`
     * never set a `from`, so every employee's mail fell through to `WP_OS_EMAIL_FROM` — which is
     * still set to exactly that value on this env, five lines up, so a regression lands here
     * rather than on a missing field. One card, one employee, ONE address.
     *
     * The address is RESOLVED from the registry rather than retyped, so a roster change cannot
     * leave this pin asserting an address nobody sends from.
     */
    expect(sent[0]!.from).toBe(employeeSenderHeader("Wyatt"));
    expect(sent[0]!.from).toBe("Wyatt · West Peek <wyatt@joinwestpeek.com>");
    expect(sent[0]!.from, "never the firm's LP-facing address, and never the fallback").not.toContain("@westpeek.ventures");
    // THE BUSY-EXECUTIVE FORMAT (16 Sep 2026): "<Employee>: <what>", TL;DR first, labelled
    // sections as bullets, the employee's full words under the rule, a footer that names them.
    expect(sent[0]!.subject).toMatch(/^Wyatt: done — Verify Sensori is real/);
    expect(sent[0]!.subject.length).toBeLessThanOrEqual(70);
    expect(sent[0]!.text.split("\n")[0]).toMatch(/^\*\*TL;DR:\*\* Finished what you asked for/);
    expect(sent[0]!.text).toMatch(/\*\*What you asked\*\*\n• Verify Sensori/);
    expect(sent[0]!.text).toMatch(/\*\*What I found\*\*\n• Sensori is real/);
    expect(sent[0]!.text).toMatch(/\*\*Your call\*\*/);
    expect(sent[0]!.text).toMatch(/Worth a call/);
    expect(sent[0]!.text).toMatch(/os\.joinwestpeek\.com\/#\/work/);
    expect(sent[0]!.text).toMatch(/— Details —/);
    // AND THE EMAIL NAMES WHO ROUTED THE WORK (her rule, 22 Sep 2026). Wren handed this card to
    // Wyatt above (`assigned_from_card_id`), so the footer carries the whole chain in one line:
    // who passed it on, and who actually did it.
    expect(sent[0]!.text.trim().split("\n").pop()).toMatch(
      /^— Wyatt, .* Wren routed this to me; the work is mine\. Replies go to os@joinwestpeek\.com — we don't check individual inboxes\./,
    );
    expect(sent[0]!.html, "an HTML part with the same content").toMatch(/<strong>TL;DR:<\/strong>/);
    expect(sent[0]!.reply_to, "the mail client's Reply button also lands on the intake mailbox, belt-and-braces with the footer wording").toBe("os@joinwestpeek.com");
    const ev = await env.WP_OS_DB.prepare("SELECT event_type FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.replied_by_email'").bind(analystCard.id).first();
    expect(ev).toBeTruthy();
  });

  it("a blocked request also reaches the inbox, as a question", async () => {
    const card = await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by) VALUES ('wc_t_blocked', 'Find the LP letter', 'x', 'AI', 'aie_wesley', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'scooter@westpeek.ventures', 'test')").run();
    expect(card.success).toBe(true);
    await sweepOnce(env, new Date(NOW.getTime() + 10 * 60_000), {
      general: async (e, _ctx, cardId) => {
        // 0173: blocks go through the catalogue, so the question reaches the inbox as "what would
        // clear it" rather than as whatever the loop was holding.
        await blockCard(e, { id: cardId, title: "Find the LP letter", firm_scope: "west-peek", owner_id: "aie_wesley" }, {
          reason: "a_question_for_you",
          trying: "Find the LP letter",
          employee: "Wesley",
          detail: "Which quarter do you mean?",
        });
        return { finished: false, blocked: true, detail: "Which quarter do you mean?", steps: [{ action: "blocked", detail: "Which quarter do you mean?" }] };
      },
    });
    const last = sent[sent.length - 1]!;
    expect(last.to).toBe("scooter@westpeek.ventures");
    expect(last.subject).toBe("Wesley: blocked — Find the LP letter");
    expect(last.text).toMatch(/^\*\*TL;DR:\*\* Blocked on what you asked for/);
    expect(last.text).toMatch(/\*\*Where I am stuck\*\*\n• Wesley needs something from you/);
    expect(last.text).toMatch(/Which quarter do you mean\?/);
  });

  /*
   * A BLOCK ADDRESSED TO A PARTNER REACHES THEM, EVEN WITH NO REQUESTER TO FALL BACK TO (22 Sep
   * 2026). Confirmed directly in production: a card blocked with `block_who = 'SCOOTER'` produced
   * no email at all — only an in-app notice — because `replyToRequester` has nothing to send to when
   * `requested_by_email` is empty, which is the ordinary shape for a card nobody emailed in for (a
   * weekly duty, something raised by hand). Given how he actually operates, that silence made the
   * block invisible to him. This is the case `announceOutcome`'s new redirect exists to close.
   */
  it("a block addressed to a partner reaches them by email even when nobody requested the card at all", async () => {
    const card = await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by) VALUES ('wc_t_blocked_no_requester', 'Approve the March newsletter subject line', 'x', 'AI', 'aie_wesley', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', NULL, 'test')",
    ).run();
    expect(card.success).toBe(true);
    const before = sent.length;
    await sweepOnce(env, new Date(NOW.getTime() + 20 * 60_000), {
      general: async (e, _ctx, cardId) => {
        // A REAL, EXPLICIT ADDRESSEE — not the catalogue's SEQUOIA default — so this proves the
        // redirect follows `block_who`, not merely "there was nobody to ask".
        await blockCard(e, { id: cardId, title: "Approve the March newsletter subject line", firm_scope: "west-peek", owner_id: "aie_wesley" }, {
          reason: "a_question_for_you",
          trying: "Approve the March newsletter subject line",
          employee: "Wesley",
          who: "SCOOTER",
          detail: "\"Spring is here\" or \"March in three deals\"?",
        });
        return { finished: false, blocked: true, detail: "which subject line", steps: [{ action: "blocked", detail: "which subject line" }] };
      },
    });
    expect(sent.length, "an email now goes out where none did before").toBe(before + 1);
    const last = sent[sent.length - 1]!;
    expect(last.to, "block_who names Scooter, and Scooter is who hears about it").toBe("scooter@westpeek.ventures");
    expect(last.subject).toBe("Wesley: blocked — Approve the March newsletter subject line");
    expect(last.text).toMatch(/Spring is here.*March in three deals/s);
  });

  /*
   * THE SAME REDIRECT REACHES A TECHNICAL BLOCK ON A GENERAL (NON-WEB_PROPERTY_CHANGE) CARD, EVEN
   * WITH A REQUESTER PRESENT (22 Sep 2026). The 21 Sep fix this generalises only ever fired for
   * `WEB_PROPERTY_CHANGE_KIND`; a lane fault on any OTHER kind is equally unanswerable by whoever
   * happened to request the work, and previously fell through to `replyToRequester`'s ordinary path
   * — mailing the requester a stop they have no way to act on.
   */
  it("a technical block (a lane refused the work) reaches the owner of the lane, not the requester, on a general card too", async () => {
    const card = await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by) VALUES ('wc_t_blocked_lane', 'Draft the investor update', 'x', 'AI', 'aie_wesley', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'scooter@westpeek.ventures', 'test')",
    ).run();
    expect(card.success).toBe(true);
    const before = sent.length;
    await sweepOnce(env, new Date(NOW.getTime() + 30 * 60_000), {
      general: async (e, _ctx, cardId) => {
        await blockCard(e, { id: cardId, title: "Draft the investor update", firm_scope: "west-peek", owner_id: "aie_wesley" }, {
          reason: "a_lane_refused_the_work",
          trying: "Draft the investor update",
          employee: "Wesley",
          who: "SEQUOIA",
          lane: "Claude Code (her Mac)",
          laneKey: "claude_code",
          laneKind: "LANE_DOWN",
          vendorWords: "the account is out of credit",
        });
        return { finished: false, blocked: true, detail: "the lane is out of credit", steps: [{ action: "blocked", detail: "the lane is out of credit" }] };
      },
    });
    expect(sent.length).toBe(before + 1);
    const last = sent[sent.length - 1]!;
    expect(last.to, "Scooter asked for this, but he cannot fix a dead lane — Sequoia can, so she is told").toBe("sequoia@westpeek.ventures");
  });
});

describe("the reply cannot be steered", () => {
  it("refuses any destination that is not one of the two partners, whatever the column holds", async () => {
    const before = sent.length;
    const out = await replyToRequester(env, { id: "wc_x", title: "x", requested_by_email: "founder@sensori.example", firm_scope: "west-peek" }, "DONE", "Wyatt", "d");
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/not one of the two partner addresses/);
    expect(sent).toHaveLength(before);
  });

  it("does nothing for a card nobody asked for by email, and nothing when the deployment switch is off", async () => {
    const before = sent.length;
    expect((await replyToRequester(env, { id: "wc_x", title: "x", requested_by_email: null, firm_scope: "west-peek" }, "DONE", "Wyatt", "d")).sent).toBe(false);
    const off = { ...env, WP_OS_AI_EMAIL_PARTNERS: "off" } as Env;
    const out = await replyToRequester(off, { id: "wc_x", title: "x", requested_by_email: "sequoia@westpeek.ventures", firm_scope: "west-peek" }, "DONE", "Wyatt", "d");
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/WP_OS_AI_EMAIL_PARTNERS is off/);
    expect(sent).toHaveLength(before);
  });

  it("the trigger words are defused on the way out, so a finding cannot re-enter the mailbox as an instruction", async () => {
    await replyToRequester(env, { id: "wc_x", title: "x", requested_by_email: "sequoia@westpeek.ventures", firm_scope: "west-peek" }, "DONE", "Wyatt", "They wrote #wpdealflow in their deck.");
    expect(sent[sent.length - 1]!.text).not.toContain("#wpdealflow");
  });
});

describe("assignCard refuses what it should", () => {
  it("nobody by that name, self-assignment, and a switched-off employee", async () => {
    const card = { id: "wc_t_blocked", title: "x", description: "", next_action: null, state: "OPEN", owner_type: "AI", owner_id: "aie_wesley", allows_browser: 0, prompt: null, firm_scope: "west-peek", requested_by_email: null };
    expect((await assignCard(env, card as never, { id: "aie_wesley", name: "Wesley" }, "Zebedee", "b")).ok).toBe(false);
    expect((await assignCard(env, card as never, { id: "aie_wesley", name: "Wesley" }, "Wesley", "b")).ok).toBe(false);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'PAUSED' WHERE id = 'aie_percy'").run();
    const off = await assignCard(env, card as never, { id: "aie_wesley", name: "Wesley" }, "Percy", "b");
    expect(off.ok).toBe(false);
    expect((off as { reason: string }).reason).toMatch(/not employed right now/);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_percy'").run();
    void workCard;
  });
});
