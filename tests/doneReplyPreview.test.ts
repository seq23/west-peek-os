import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { announceOutcome, type SweepCard } from "../src/worker/services/workSweep";
import { replyToRequester, requesterNotesSection, routedByFor } from "../src/worker/services/requestReply";
import { doneReplyLaneFor, DONE_REPLY_PREVIEW_FIRST, rulesFor, isOn } from "../src/worker/services/kindRules";
import { WEB_PROPERTY_CHANGE_KIND, ON_OFF_RULE_KEYS } from "../src/shared/work/localJobs";
import { handleUpdateWorkCard } from "../src/worker/services/workCards";
import { execFooter, renderExecEmail } from "../src/shared/email/execEmail";
import { PREVIEW_PARTNER } from "../src/shared/registry/partners";

/**
 * HER FINISHED-WORK EMAIL IS SHOWN TO HER FIRST, AND CARRIES HER WORDS (0223 + 0224, 22 Sep 2026).
 *
 * What is proven, each traceable to what happened on Scooter's "westpeek.ventures forms are down":
 *
 *   · THE RULE IS READ IN ONE PLACE. `doneReplyLaneFor` is what both doors ask, it only ever ADDS a
 *     preview, and it says nothing about any notice kind but DONE.
 *   · RULE ON → THE DONE REPLY IS FILED, NOT SENT. A `preview_approval` row PENDING for the preview
 *     partner, lane reason ASKED_FOR, and nothing leaves — with the card's own tick never set.
 *   · RULE OFF → IT SENDS, exactly as before. The same card, the same call, one switch between them.
 *   · THE OTHER KINDS ARE UNTOUCHED. A BLOCKED reply to a partner still goes straight out with the
 *     rule on; holding a question would make the partner wait on a third person to be asked one.
 *   · HER WORDS RIDE ON THE DONE REPLY AND NOWHERE ELSE, as a section in her own first name, in the
 *     text AND the html, immediately before "Your call".
 *   · ONLY A MANAGING PARTNER MAY WRITE THEM. An analyst with `work_card.update` is refused.
 *   · WHO ROUTED IT IS NAMED, out of the hand-off trail (0160) rather than out of a sentence.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; html?: string }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const CARD = "wc_done_reply_test";

function sweepCard(over: Partial<SweepCard> = {}): SweepCard {
  return {
    id: CARD,
    title: `From ${SCOOTER}: the ventures forms are down`,
    kind: WEB_PROPERTY_CHANGE_KIND,
    owner_id: "aie_porter",
    state: "IN_PROGRESS",
    work_attempts: 1,
    firm_scope: "west-peek",
    requested_by_email: SCOOTER,
    preview_first: null,
    preview_owner_id: null,
    ...over,
  } as SweepCard;
}

async function setRule(value: "on" | "off"): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = ?3 WHERE kind = ?1 AND rule_key = ?2")
    .bind(WEB_PROPERTY_CHANGE_KIND, DONE_REPLY_PREVIEW_FIRST, value)
    .run();
}

async function previews(): Promise<Array<{ id: string; state: string; owner_firm_user_id: string; lane_reason: string; body_text: string; body_html: string | null }>> {
  return (
    (await env.WP_OS_DB.prepare("SELECT id, state, owner_firm_user_id, lane_reason, body_text, body_html FROM preview_approval WHERE work_card_id = ?1").bind(CARD).all<never>()).results ?? []
  ) as never;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html?: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, html: body.html });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_wren')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

beforeEach(async () => {
  sent.length = 0;
  await env.WP_OS_DB.prepare("DELETE FROM preview_approval WHERE work_card_id = ?1").bind(CARD).run();
  await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(CARD).run();
  await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id IN (?1, 'wc_routed_from')").bind(CARD).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, kind, state, owner_type, owner_id, priority, firm_scope, requested_by_email, created_by)
     VALUES (?1, ?2, ?3, 'IN_PROGRESS', 'AI', 'aie_porter', 'NORMAL', 'west-peek', ?4, 'fu_sequoia_taylor')`,
  )
    .bind(CARD, `From ${SCOOTER}: the ventures forms are down`, WEB_PROPERTY_CHANGE_KIND, SCOOTER)
    .run();
  await setRule("on");
});

describe("the rule is read in one place, and only ever adds a preview", () => {
  it("is seeded on, editable, and is a switch on both sides", async () => {
    const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
    expect(isOn(rules[DONE_REPLY_PREVIEW_FIRST]), "0223 seeds her rule ON").toBe(true);
    const row = await env.WP_OS_DB.prepare("SELECT editable, note FROM work_kind_rule WHERE kind = ?1 AND rule_key = ?2")
      .bind(WEB_PROPERTY_CHANGE_KIND, DONE_REPLY_PREVIEW_FIRST)
      .first<{ editable: number; note: string }>();
    expect(row?.editable, "she can change it on the Work page").toBe(1);
    expect(row?.note).toContain("shown to Sequoia first");
    expect(ON_OFF_RULE_KEYS, "so the page renders a switch and the route refuses anything else").toContain(DONE_REPLY_PREVIEW_FIRST);
  });

  it("takes the lane on DONE even with the card's tick unset, and leaves every other kind alone", async () => {
    const card = { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: null, preview_owner_id: null };
    const done = await doneReplyLaneFor(env, card, { kind: "DONE" });
    expect(done.cardAsked).toBe(true);
    expect(done.tickedByFirmUserId).toBe(PREVIEW_PARTNER.firmUserId);
    expect(done.becauseOfRule, "the rule put it there, not the card").toBe(true);

    for (const kind of ["RECEIVED", "PLAN", "PREVIEW", "QUESTION", "STUCK"] as const) {
      const other = await doneReplyLaneFor(env, card, { kind });
      expect(other.cardAsked, `${kind} is untouched by the rule`).toBeNull();
      expect(other.tickedByFirmUserId).toBeNull();
      expect(other.becauseOfRule).toBe(false);
    }
  });

  it("with the rule off, DONE carries the card's own tick and nothing else", async () => {
    await setRule("off");
    expect((await doneReplyLaneFor(env, { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: null }, { kind: "DONE" })).cardAsked).toBeNull();
    expect((await doneReplyLaneFor(env, { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: 1 }, { kind: "DONE" })).cardAsked).toBe(true);
    expect((await doneReplyLaneFor(env, { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: 0 }, { kind: "DONE" })).cardAsked).toBe(false);
  });

  it("keeps the partner who ticked the box as the owner of their own preview", async () => {
    const lane = await doneReplyLaneFor(env, { kind: WEB_PROPERTY_CHANGE_KIND, preview_first: 1, preview_owner_id: "fu_scooter_taylor" }, { kind: "DONE" });
    expect(lane.tickedByFirmUserId, "her rule does not take Scooter's preview off him").toBe("fu_scooter_taylor");
  });

  it("says nothing about a kind with no such rule", async () => {
    const lane = await doneReplyLaneFor(env, { kind: "BLOG_HELP", preview_first: null }, { kind: "DONE" });
    expect(lane.cardAsked).toBeNull();
  });
});

describe("the DONE reply", () => {
  it("rule on: it is filed for her and nothing is sent", async () => {
    const out = await replyToRequester(env, sweepCard(), "DONE", "Porter", "The forms send again; three pages curled 200.", { kind: "DONE", cause: "" });
    expect(out.sent, "a finished email does not leave on its own any more").toBe(false);
    // The preview itself IS emailed — to HER, with Send it / Send it back / Dismiss. What must not
    // happen is the finished work reaching the partner who asked for it before she has seen it.
    expect(sent.map((m) => m.to), "nothing reached Scooter").not.toContain(SCOOTER);
    expect(sent.every((m) => m.to === PREVIEW_PARTNER.email), "anything sent went to her, as the preview").toBe(true);

    const rows = await previews();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("PENDING");
    expect(rows[0]!.owner_firm_user_id).toBe(PREVIEW_PARTNER.firmUserId);
    expect(rows[0]!.lane_reason, "in the lane because she asked for it, not because the address is outside the firm").toBe("ASKED_FOR");
    expect(rows[0]!.body_text).toContain("The forms send again");
  });

  it("rule off: the same call sends, exactly as it did before", async () => {
    await setRule("off");
    const out = await replyToRequester(env, sweepCard(), "DONE", "Porter", "The forms send again; three pages curled 200.", { kind: "DONE", cause: "" });
    expect(out.sent).toBe(true);
    expect(out.to).toBe(SCOOTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(SCOOTER);
    expect(await previews(), "nothing was filed").toHaveLength(0);
  });

  it("a BLOCKED reply still reaches the partner with the rule on", async () => {
    const out = await replyToRequester(env, sweepCard(), "BLOCKED", "Porter", "Which orange is the approved one?", { kind: "QUESTION", cause: "which orange" });
    expect(out.sent, "a question is not finished work").toBe(true);
    expect(sent).toHaveLength(1);
    expect(await previews()).toHaveLength(0);
  });

  it("reaches the same decision through the sweep's own announcement", async () => {
    const out = await announceOutcome(env, sweepCard(), "DONE", "Landed and proven live.");
    expect(out.emailed, "the sweep did not send it to the requester either").toBeNull();
    expect(sent.map((m) => m.to)).not.toContain(SCOOTER);
    expect(await previews()).toHaveLength(1);
  });
});

describe("her words on the finished email", () => {
  it("splits on newlines, drops the bullets a person types, and is labelled in her first name", () => {
    const s = requesterNotesSection("Tell him it was the API key.\n- And that forms are back.\n\n", PREVIEW_PARTNER.firmUserId);
    expect(s?.label).toBe(`From ${PREVIEW_PARTNER.firstName}`);
    expect(s?.bullets).toEqual(["Tell him it was the API key.", "And that forms are back."]);
    expect(requesterNotesSection(null, PREVIEW_PARTNER.firmUserId), "no notes, no section").toBeNull();
    expect(requesterNotesSection("   \n  \n", PREVIEW_PARTNER.firmUserId), "whitespace is not a note").toBeNull();
  });

  it("appears in the rendered text and html, before Your call — and nowhere when there are none", async () => {
    await setRule("off");
    await env.WP_OS_DB.prepare("UPDATE work_card SET requester_notes = ?2, requester_notes_by = ?3 WHERE id = ?1")
      .bind(CARD, "It was the API key, not the form.", PREVIEW_PARTNER.firmUserId)
      .run();
    const card = sweepCard({ requester_notes: "It was the API key, not the form.", requester_notes_by: PREVIEW_PARTNER.firmUserId } as Partial<SweepCard>);
    await replyToRequester(env, card, "DONE", "Porter", "Three pages curled 200.", { kind: "DONE", cause: "" });
    expect(sent).toHaveLength(1);
    const { text, html } = sent[0]!;
    expect(text).toContain(`**From ${PREVIEW_PARTNER.firstName}**`);
    expect(text).toContain("It was the API key, not the form.");
    expect(html ?? "").toContain(`<strong>From ${PREVIEW_PARTNER.firstName}</strong>`);
    expect(text.indexOf(`From ${PREVIEW_PARTNER.firstName}`), "her words come before what she has to decide").toBeLessThan(text.indexOf("Your call"));

    sent.length = 0;
    await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(CARD).run();
    await replyToRequester(env, sweepCard(), "DONE", "Porter", "Three pages curled 200.", { kind: "DONE", cause: "second" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text, "a card with no words renders the email it always did").not.toContain("From ");
  });

  it("is a Managing Partner's to write, and nobody else's", async () => {
    const analyst = {
      id: "fu_analyst_test",
      email: "analyst@westpeek.ventures",
      fullName: "An Analyst",
      status: "ACTIVE",
      roles: ["ANALYST"],
      authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
    };
    const res = await handleUpdateWorkCard({
      env,
      identity: analyst as never,
      params: { id: CARD },
      request: new Request(`https://os.joinwestpeek.com/api/work-cards/${CARD}`, { method: "PATCH", body: JSON.stringify({ requester_notes: "send this" }) }),
    } as never);
    expect(res.status, "moving a card is not the same as speaking for the firm").toBe(403);
    const row = await env.WP_OS_DB.prepare("SELECT requester_notes FROM work_card WHERE id = ?1").bind(CARD).first<{ requester_notes: string | null }>();
    expect(row?.requester_notes).toBeNull();
  });
});

describe("who routed the work is named as well as who did it", () => {
  it("names the employee who handed it on, out of the hand-off trail", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_card (id, title, state, owner_type, owner_id, priority, firm_scope, created_by)
       VALUES ('wc_routed_from', 'the original request', 'DONE', 'AI', 'aie_wren', 'NORMAL', 'west-peek', 'fu_sequoia_taylor')`,
    ).run();
    expect(await routedByFor(env, "wc_routed_from", "Porter")).toBe("Wren");
    expect(await routedByFor(env, null, "Porter"), "a card nobody handed on says nothing").toBeNull();
    expect(await routedByFor(env, "wc_routed_from", "Wren"), "a hand-off to yourself is not a hand-off").toBeNull();
  });

  it("puts the chain on the footer, and leaves the footer untouched when there was no hand-off", () => {
    expect(execFooter("Porter", "Wren")).toContain("Wren routed this to me; the work is mine.");
    expect(execFooter("Porter", null), "no hand-off, no change to the house format").toBe(execFooter("Porter"));
    expect(execFooter("Porter", "Porter"), "and never a hand-off to yourself").toBe(execFooter("Porter"));
    const r = renderExecEmail({ employee: "Porter", what: "done — the forms", tldr: "Done.", sections: [{ label: "What I did", bullets: ["Fixed it."] }, { label: "Your call", bullets: ["Nothing."] }], routedBy: "Wren" });
    expect(r.text.trim().split("\n").pop()).toBe(execFooter("Porter", "Wren"));
  });

  it("carries it on the DONE reply", async () => {
    await setRule("off");
    await env.WP_OS_DB.prepare(
      `INSERT OR IGNORE INTO work_card (id, title, state, owner_type, owner_id, priority, firm_scope, created_by)
       VALUES ('wc_routed_from', 'the original request', 'DONE', 'AI', 'aie_wren', 'NORMAL', 'west-peek', 'fu_sequoia_taylor')`,
    ).run();
    await replyToRequester(env, sweepCard({ assigned_from_card_id: "wc_routed_from" } as Partial<SweepCard>), "DONE", "Porter", "Three pages curled 200.", { kind: "DONE", cause: "" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Wren routed this to me; the work is mine.");
  });
});
