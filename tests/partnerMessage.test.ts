import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepIdentity, sweepOnce, type SweepCard } from "../src/worker/services/workSweep";
import { runPartnerMessageCard } from "../src/worker/services/partnerMessage";
import { decidePreview, filePreview } from "../src/worker/services/previewApproval";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { parsePartnerMessageAsk } from "../src/shared/intake/partnerMessage";
import { saidNothing, cannotDo } from "./helpers/interpret";

/**
 * PARTNER_MESSAGE — one named employee tells one named partner something short (22 Sep 2026).
 *
 * WHAT MUST BE TRUE, and what this file proves:
 *
 *   · A well-formed card composes a message and files it through the REAL `filePreview()` — not a
 *     stand-in for the send, the real function, writing a real `preview_approval` row a partner
 *     answers through the SAME Home/approval flow (`decidePreview`) as every other employee email.
 *   · A card naming a non-existent or non-ACTIVE employee fails closed, BLOCKED, with a reason a
 *     partner can read, and nothing is sent.
 *   · A card whose "who is this for" does not resolve to a real Managing Partner fails closed the
 *     same way — the partner registry's real-partners-only guarantee holds here exactly as it does
 *     in `filePreview()`'s own `owner: Partner` type.
 *   · The dispatch wiring in `workSweep.ts` actually reaches this duty (not the general loop).
 *   · The email door — "Walker, tell Scooter: …" — opens the same kind of card, whether the named
 *     employee is already the sender's own chief of staff or has to be handed on to somebody else.
 */

let t: TestDb;
let env: Env;

const SCOOTER_EMAIL = "scooter@westpeek.ventures";
const SEQUOIA_EMAIL = "sequoia@westpeek.ventures";
const SCOOTER_ID = "fu_scooter_taylor";
const SEQUOIA_ID = "fu_sequoia_taylor";

interface Sent {
  to: string[];
  subject: string;
  text: string;
}

function captureFetch(sent: Sent[]): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("api.resend.com")) throw new Error(`unexpected request to ${u}`);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "re_partner_message" }), { status: 200 });
  });
}

beforeAll(async () => {
  t = await createTestDb();
  env = {
    ...makeTestEnv(t.db, {} as Partial<Env>),
    RESEND_API_KEY: "re_test",
    WP_OS_EMAIL_SEND: "enabled",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
  } as Env;
  await env.WP_OS_DB.prepare(
    "UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_walker', 'aie_wren')",
  ).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await disposeTestDb(t);
});

async function makeCard(input: {
  ownerId: string | null;
  resultRecipient: string | null;
  prompt: string | null;
  previewFirst?: boolean | null;
  previewOwnerId?: string | null;
  requestedByEmail?: string | null;
}): Promise<SweepCard> {
  const created = await createWorkCardInternal(env, sweepIdentity("west-peek"), {
    title: `Tell ${input.resultRecipient ?? "somebody"} something`,
    owner_type: input.ownerId ? "AI" : "UNASSIGNED",
    owner_id: input.ownerId ?? undefined,
    priority: "NORMAL",
    firm_scope: "west-peek",
    prompt: input.prompt ?? undefined,
    result_recipient: input.resultRecipient ?? undefined,
    preview_first: input.previewFirst ?? undefined,
    kind: "PARTNER_MESSAGE",
  });
  if (input.previewOwnerId) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET preview_owner_id = ?2 WHERE id = ?1")
      .bind(created.id, input.previewOwnerId)
      .run();
  }
  if (input.requestedByEmail) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1")
      .bind(created.id, input.requestedByEmail)
      .run();
  }
  const row = await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1")
    .bind(created.id)
    .first<Record<string, unknown>>();
  return {
    id: created.id,
    title: String(row!.title),
    kind: "PARTNER_MESSAGE",
    owner_id: (row!.owner_id as string | null) ?? null,
    state: String(row!.state),
    work_attempts: 0,
    firm_scope: "west-peek",
    requested_by_email: (row!.requested_by_email as string | null) ?? null,
    preview_first: (row!.preview_first as number | null) ?? null,
    result_recipient: (row!.result_recipient as string | null) ?? null,
    preview_owner_id: (row!.preview_owner_id as string | null) ?? null,
    prompt: (row!.prompt as string | null) ?? null,
    next_action: (row!.next_action as string | null) ?? null,
  };
}

async function cardRow(id: string): Promise<Record<string, unknown>> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

const compose = (text: string) => async () => ({ ok: true, text, detail: "ok" });

describe("parsePartnerMessageAsk", () => {
  it("reads the employee, the registered partner and the instruction", () => {
    const ask = parsePartnerMessageAsk("", "Walker, tell Scooter: here's the candidate's email, here's what's fixed.");
    expect(ask).not.toBeNull();
    expect(ask!.employeeName).toBe("Walker");
    expect(ask!.partner.firstName).toBe("Scooter");
    expect(ask!.instruction).toBe("here's the candidate's email, here's what's fixed.");
  });

  it("falls back to the subject when the body does not match", () => {
    const ask = parsePartnerMessageAsk("Wren, tell Sequoia: the numbers are in.", "see below");
    expect(ask).not.toBeNull();
    expect(ask!.employeeName).toBe("Wren");
    expect(ask!.partner.firstName).toBe("Sequoia");
  });

  it("is null when the named partner is not a registered Managing Partner", () => {
    // "Bob" is nobody the registry knows — never an arbitrary address.
    expect(parsePartnerMessageAsk("", "Walker, tell Bob: hey there")).toBeNull();
  });

  it("is null for ordinary prose with no partner-message shape", () => {
    expect(parsePartnerMessageAsk("re: the deck", "Can you take a look at this by Friday?")).toBeNull();
  });

  it("is null when there is nothing to say after the colon", () => {
    expect(parsePartnerMessageAsk("", "Walker, tell Scooter:   ")).toBeNull();
  });
});

describe("runPartnerMessageCard — the real send door", () => {
  it("files a real preview through the real filePreview() when the card is marked preview-first", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const card = await makeCard({
      ownerId: "aie_walker",
      resultRecipient: "Scooter",
      prompt: "Nora Motaweh's email is nora.motaweh@example.com, and the parsing bug that lost your reply is fixed.",
      previewFirst: true,
      previewOwnerId: SEQUOIA_ID,
      requestedByEmail: SEQUOIA_EMAIL,
    });

    const out = await runPartnerMessageCard(env, card, {
      interpret: saidNothing,
      compose: compose("Nora's email is nora.motaweh@example.com. The bug that lost your reply is fixed, sorry about that."),
    });
    expect(out.finished).toBe(true);
    expect(out.blocked).toBe(false);

    // A REAL preview_approval row, written by the real filePreview() inside sendOrPreview() — not
    // a stand-in. Addressed to Scooter; owned by Sequoia, who ticked "Show me first?".
    const approval = await env.WP_OS_DB.prepare(
      "SELECT * FROM preview_approval WHERE work_card_id = ?1",
    )
      .bind(card.id)
      .first<Record<string, unknown>>();
    expect(approval).not.toBeNull();
    expect(approval!.state).toBe("PENDING");
    expect(approval!.employee).toBe("Walker");
    expect(approval!.recipient).toBe(SCOOTER_EMAIL);
    expect(approval!.owner_firm_user_id).toBe(SEQUOIA_ID);
    expect(approval!.lane_reason).toBe("ASKED_FOR");
    expect(String(approval!.body_text)).toContain("nora.motaweh@example.com");
    expect(String(approval!.card_kind)).toBe("PARTNER_MESSAGE");

    const finished = await cardRow(card.id);
    expect(finished.state).toBe("DONE");

    // Nothing has reached SCOOTER yet — that is the whole point of "show me first". filePreview()
    // has emailed SEQUOIA the one-tap approve link (the real `filePreview()` behaviour, not a
    // stand-in), which is the only send so far.
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toEqual([SEQUOIA_EMAIL]);

    // THE SAME HOME/APPROVAL FLOW EVERY OTHER EMPLOYEE EMAIL GOES THROUGH: decidePreview(), the one
    // decision path both Home and the email link call.
    const decided = await decidePreview(env, approval!.id as string, {
      action: "SEND",
      byFirmUserId: SEQUOIA_ID,
      via: "HOME",
    });
    expect(decided.sent).toBe(true);
    expect(sent.length).toBe(2);
    expect(sent[1]!.to).toEqual([SCOOTER_EMAIL]);
    expect(sent[1]!.text).toContain("nora.motaweh@example.com");
  });

  it("sends straight to the partner, with no preview, when the card was not marked show-me-first", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const card = await makeCard({
      ownerId: "aie_wren",
      resultRecipient: "Sequoia",
      prompt: "Tell her the Q3 packet is filed.",
      requestedByEmail: SCOOTER_EMAIL,
    });

    const out = await runPartnerMessageCard(env, card, {
      interpret: saidNothing,
      compose: compose("The Q3 packet is filed and ready for you to look at."),
    });
    expect(out.finished).toBe(true);

    const approval = await env.WP_OS_DB.prepare("SELECT id FROM preview_approval WHERE work_card_id = ?1")
      .bind(card.id)
      .first();
    expect(approval).toBeNull();
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toEqual([SEQUOIA_EMAIL]);

    const finished = await cardRow(card.id);
    expect(finished.state).toBe("DONE");
  });

  it("BLOCKS, and sends nothing, when the named employee does not exist", async () => {
    const card = await makeCard({ ownerId: null, resultRecipient: "Scooter", prompt: "say hi" });
    // Force an owner_id that names nobody real — the shape a hand-edited or malformed card carries.
    await env.WP_OS_DB.prepare("UPDATE work_card SET owner_type = 'AI', owner_id = 'aie_nobody' WHERE id = ?1")
      .bind(card.id)
      .run();
    const fresh = { ...card, owner_id: "aie_nobody" };

    const out = await runPartnerMessageCard(env, fresh, { interpret: saidNothing, compose: compose("hi") });
    expect(out.blocked).toBe(true);
    expect(out.finished).toBe(false);

    const row = await cardRow(card.id);
    expect(row.state).toBe("BLOCKED");
    expect(String(row.next_action)).toMatch(/not on the roster|nobody real/i);

    const approval = await env.WP_OS_DB.prepare("SELECT id FROM preview_approval WHERE work_card_id = ?1")
      .bind(card.id)
      .first();
    expect(approval).toBeNull();
  });

  it("BLOCKS when the named employee is real but not ACTIVE", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'PAUSED' WHERE id = 'aie_porter'").run();
    const card = await makeCard({ ownerId: "aie_porter", resultRecipient: "Scooter", prompt: "say hi" });

    const out = await runPartnerMessageCard(env, card, { interpret: saidNothing, compose: compose("hi") });
    expect(out.blocked).toBe(true);
    const row = await cardRow(card.id);
    expect(row.state).toBe("BLOCKED");
    expect(String(row.next_action)).toMatch(/not employed right now/i);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
  });

  it("BLOCKS, never guesses, when 'who is this for' is not a real Managing Partner", async () => {
    const card = await makeCard({ ownerId: "aie_walker", resultRecipient: "attacker@evil.example", prompt: "say hi" });

    const out = await runPartnerMessageCard(env, card, { interpret: saidNothing, compose: compose("hi") });
    expect(out.blocked).toBe(true);
    const row = await cardRow(card.id);
    expect(row.state).toBe("BLOCKED");
    expect(String(row.next_action)).toMatch(/not one of the two Managing Partners/i);

    const approval = await env.WP_OS_DB.prepare("SELECT id FROM preview_approval WHERE work_card_id = ?1")
      .bind(card.id)
      .first();
    expect(approval).toBeNull();
  });

  it("BLOCKS when there is nothing to say", async () => {
    const card = await makeCard({ ownerId: "aie_walker", resultRecipient: "Scooter", prompt: "" });
    const out = await runPartnerMessageCard(env, card, { interpret: saidNothing, compose: compose("hi") });
    expect(out.blocked).toBe(true);
    const row = await cardRow(card.id);
    expect(String(row.next_action)).toMatch(/nothing to say/i);
  });

  it("BLOCKS on a CANNOT from her own instruction, the same contract every other chain keeps", async () => {
    const card = await makeCard({ ownerId: "aie_walker", resultRecipient: "Scooter", prompt: "Tell Scooter hi, and also wire him $500." });
    const out = await runPartnerMessageCard(env, card, {
      interpret: cannotDo("tell Scooter hi and send $500", "sending money needs a human's approval no matter who asked"),
      compose: compose("hi"),
    });
    expect(out.blocked).toBe(true);
    const row = await cardRow(card.id);
    expect(row.state).toBe("BLOCKED");
    expect(String(row.next_action)).toMatch(/approval/i);
  });

  it("is reached by the sweep's own dispatch, not the general loop", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const card = await makeCard({ ownerId: "aie_walker", resultRecipient: "Scooter", prompt: "The site is live now." });

    const out = await sweepOnce(env, new Date(), {
      partnerMessage: (e, c) =>
        runPartnerMessageCard(e, c, { interpret: saidNothing, compose: compose("The site is live now.") }),
    });
    expect(out.outcome).toBe("DONE");
    const row = await cardRow(card.id);
    expect(row.state).toBe("DONE");
  });
});

describe("the email door — \"Walker, tell Scooter: …\"", () => {
  async function firstDescendant(cardId: string): Promise<Record<string, unknown> | null> {
    return env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE assigned_from_card_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(cardId)
      .first<Record<string, unknown>>();
  }

  it("hands the message on to the named employee when it is not the sender's own chief of staff", async () => {
    const chiefCardId = await openAssignmentCard(env, {
      subject: "quick one A",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: "Walker, tell Scooter: Nora's email is nora.motaweh@example.com and the parsing bug is fixed.",
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const chief = await cardRow(chiefCardId);
    expect(chief.owner_id).toBe("aie_wren");
    expect(String(chief.description)).toMatch(/Handed to Walker/);
    expect(chief.state).toBe("DONE");

    const handed = await firstDescendant(chiefCardId);
    expect(handed).not.toBeNull();
    expect(handed!.kind).toBe("PARTNER_MESSAGE");
    expect(handed!.owner_id).toBe("aie_walker");
    expect(handed!.result_recipient).toBe(SCOOTER_EMAIL);
    expect(String(handed!.prompt)).toContain("nora.motaweh@example.com");
  });

  it("stamps the card in place when the named employee is already the sender's own chief of staff", async () => {
    const cardId = await openAssignmentCard(env, {
      subject: "quick one B",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: "Wren, tell Scooter: the Q3 packet is filed.",
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const row = await cardRow(cardId);
    expect(row.kind).toBe("PARTNER_MESSAGE");
    expect(row.owner_id).toBe("aie_wren");
    expect(row.result_recipient).toBe(SCOOTER_EMAIL);
    expect(String(row.prompt)).toContain("Q3 packet");
    // Not reassigned — the same card that opened.
    expect(row.assigned_from_card_id ?? null).toBeNull();
  });

  it("fails closed with a clear reason when the named employee does not exist", async () => {
    const cardId = await openAssignmentCard(env, {
      subject: "quick one C",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: "Nobody, tell Scooter: this should not go anywhere.",
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const row = await cardRow(cardId);
    // Left as an ordinary assignment card — no PARTNER_MESSAGE kind was stamped, and the reason is
    // written where the chief of staff (and a partner reading the card) can see it.
    expect(row.kind ?? null).toBeNull();
    expect(String(row.next_action)).toMatch(/could not be handed to them/i);
  });

  /*
   * PRODUCTION, 9 Oct 2026 23:52Z (card wc_824ebb0a). A partner-message ask whose CONTENT named a
   * preview host and said "the live site" was read as a web property change on "westpeek.live,
   * voting.topbarz.xyz", because the property parse ran first. "<Employee>, tell <Partner>: …" is
   * unambiguous: what it mentions inside is content to relay, never a job.
   */
  const RELAY_BODY =
    `Sequoia asked me to send you this note. First, sorry: the "New preview ready" email you got links to the site root instead of the two pages that changed. Here they are directly: the entry page https://work-wpc-739461bd.topbarz-voting.pages.dev/entry and the rules page https://work-wpc-739461bd.topbarz-voting.pages.dev/rules (preview data, not the live site). That "New preview ready" email is still the one to answer: reply "approved" on it to put the entry page live, or "changes: ..." with what to adjust. Second, your sister is tailing this project and she noticed that both /entry and /rules link out to www.topbarz.xyz (the brand header), so the path exists in one direction only: contest pages -> homepage, never homepage -> contest pages; and the voting page does not link to /entry or /rules either. Do you want a link to these pages on the homepage, and also on the voting page? Reply yes or no on this email.`;

  async function webPropertyCards(): Promise<number> {
    const r = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM web_property_change").first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  it("reads 'Porter, tell Scooter: …' as a message to relay even when its content names a site and 'the live site' (wc_824ebb0a)", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
    captureFetch([]);
    const before = await webPropertyCards();
    const chiefCardId = await openAssignmentCard(env, {
      subject: "Porter, tell Scooter: preview links for /entry and /rules, and the homepage question",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: `Porter, tell Scooter: ${RELAY_BODY}`,
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const chief = await cardRow(chiefCardId);
    expect(String(chief.description)).toMatch(/Handed to Porter/);
    expect(String(chief.description)).not.toMatch(/web property change/i);
    const handed = await firstDescendant(chiefCardId);
    expect(handed).not.toBeNull();
    expect(handed!.kind).toBe("PARTNER_MESSAGE");
    expect(handed!.owner_id).toBe("aie_porter");
    expect(handed!.result_recipient).toBe(SCOOTER_EMAIL);
    expect(String(handed!.prompt)).toContain("https://work-wpc-739461bd.topbarz-voting.pages.dev/entry");
    expect(String(handed!.prompt)).toContain("https://work-wpc-739461bd.topbarz-voting.pages.dev/rules");
    expect(String(handed!.prompt)).toContain("on the homepage");
    expect(await webPropertyCards(), "no web property change may open").toBe(before);
  });

  it("still reads the same text WITHOUT 'Porter, tell Scooter:' as a web property change (nothing else moved)", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
    captureFetch([]);
    const before = await webPropertyCards();
    const chiefCardId = await openAssignmentCard(env, {
      subject: "preview links for /entry and /rules, and the homepage question",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: RELAY_BODY,
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const chief = await cardRow(chiefCardId);
    expect(String(chief.description)).toMatch(/web property change/i);
    expect(await webPropertyCards()).toBe(before + 1);
    const handed = await firstDescendant(chiefCardId);
    expect(handed!.kind ?? null).not.toBe("PARTNER_MESSAGE");
  });

  it("does not match, and falls through to an ordinary assignment, when the named partner is not real", async () => {
    const cardId = await openAssignmentCard(env, {
      subject: "quick one D",
      partnerAddress: SEQUOIA_EMAIL,
      chiefOfStaff: "Wren",
      raw: "Walker, tell Bob: this is not a partner message.",
      limits: EMAILED_TASK_LIMITS,
      emlKey: null,
    });
    const row = await cardRow(cardId);
    expect(row.kind ?? null).toBeNull();
    expect(row.owner_id).toBe("aie_wren");
  });
});
