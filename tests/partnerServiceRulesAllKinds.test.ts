import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { steerFor } from "../src/worker/services/instruction";
import { recordPartnerConstraints, practicesForCard } from "../src/worker/services/partnerConstraints";
import { deferDatedItems } from "../src/worker/services/workSweep";
import { blockCard, resurfaceStaleBlocks } from "../src/worker/services/blocks";
import { BLOCK_REASONS, BLOCK_WAIT_SHAPE, blockReplyDoor, blockSentence, describeBlock } from "../src/shared/work/blocks";
import { WAIT_TEXT_FORBIDDEN } from "../src/shared/work/porterWaits";
import { PARTNER_PRACTICES, PARTNER_PRACTICES_HEADING, deferredItemsIn, doneLines, driveFoldersIn, partnerPracticesBlock } from "../src/shared/work/partnerPractices";
import { buildStepPrompt } from "../src/shared/work/employeeLoop";

/**
 * THE ELEVEN PORTER-ONLY RULES, FOR EVERY KIND (0254; owner, 6 Oct 2026: "make sure all ai agents who
 * do work on work cards couldn't benefit from some of them (even if they do no repo work)").
 *
 * Each describe pins one lift: the shared prompt fragment reaches a non-Porter chain and the general
 * loop with the partner's constraints register; every block reason is three parts and cleared by
 * email; the reply words the block email offers take their door; a dated deferred line in any
 * employee's result becomes a dated card; and a Drive folder an ask names is watched — loaded on
 * arrival with no new email, "still empty" said once.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const CLAIMER = { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com", "content-type": "application/json" };
const FOLDER = "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: t.docs,
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren', 'aie_parker')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

const card = (subject: string, raw: string) => openAssignmentCard(env, { subject, partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw, limits: EMAILED_TASK_LIMITS, emlKey: null });

describe("the shared prompt fragment (R13, R15–R17, R19, R22, R23) reaches every duty", () => {
  it("carries one line per rule, and the partner's own constraints", () => {
    expect(PARTNER_PRACTICES.map((p) => p.rule)).toEqual(["R7", "R8", "R13", "R14", "R15", "R16", "R17", "R19", "R21", "R22", "R23"]);
    const block = partnerPracticesBlock(["Voter emails are private, always.", "Voter emails are private, always."]);
    expect(block.startsWith(PARTNER_PRACTICES_HEADING)).toBe(true);
    expect(block).toContain("PARTNER_CONSTRAINTS (standing; obey without restating): · Voter emails are private, always.");
    expect(block.match(/Voter emails/g), "a constraint is listed once").toHaveLength(1);
    expect(partnerPracticesBlock([])).toContain("PARTNER_CONSTRAINTS: none on record for this partner.");
  });

  it("a non-Porter chain's steer carries the block with the requesting partner's register — learned on another job", async () => {
    const id = await card("Room packet", "Parker, the room packet for October.");
    await recordPartnerConstraints(env, SEQUOIA, ["Never name an LP in anything that leaves the firm."], "repo seq23/topbarz-voting");
    await recordPartnerConstraints(env, "someone@gmail.com", ["Not a partner — never recorded."], "x");
    const actor = { type: "AI" as const, aiEmployeeId: "aie_parker", roles: [], firmScopes: ["west-peek"] };
    const steer = await steerFor(env, actor as never, { cardId: id, cardKind: "ROOM_PACKET", title: "Room packet", employee: "Parker", chain: "Parker's Room packet", steps: ["brief"], firmScope: "west-peek" }, async () => ({ ok: true, text: JSON.stringify({ understood: "the October packet", steer: [], cannot: [], handoff: [] }), aiRunId: null, model: null, detail: "" }));
    expect(steer.text).toContain(PARTNER_PRACTICES_HEADING);
    expect(steer.text).toContain("Never name an LP in anything that leaves the firm.");
    expect(steer.text).not.toContain("Not a partner");
    expect(await practicesForCard(env, id)).toContain("Never name an LP");
  });

  it("the general employee loop prints the block in every step prompt", () => {
    const prompt = buildStepPrompt({ title: "x", next_action: null, description: null, employee_name: "Walker", employee_role: "Researcher", allows_browser: false, prompt: null, guidance: "", history: [], steering: [], practices: partnerPracticesBlock(["Brand word: West Peek, never Westpeek."]) } as never, 3);
    expect(prompt).toContain(PARTNER_PRACTICES_HEADING);
    expect(prompt).toContain("Brand word: West Peek, never Westpeek.");
  });

  it("R15 / R17: one done-line per ask, and a partial item always states its limit", () => {
    expect(doneLines([{ item: "Vote page", state: "done" }, { item: "Export", state: "partial", note: "CSV only; Sheets needs a key" }, { item: "Redirect", state: "not_done" }])).toEqual([
      "Vote page — done",
      "Export — partial (CSV only; Sheets needs a key)",
      'Redirect — not done (the limit was not stated — ask for it by replying "what was missing?")',
    ]);
  });
});

describe("R7 / R8: every kind's block is three parts and cleared by email", () => {
  it("every reason in the catalogue reads Waiting on / Why / To clear it by email, and never points into the OS", () => {
    for (const reason of BLOCK_REASONS) {
      const s = blockSentence(describeBlock(reason, { trying: "Find a speaker for the November Room", employee: "Walker", url: "https://example.com" }));
      expect(s, reason).toMatch(BLOCK_WAIT_SHAPE);
      expect(s, `${reason}: no doubled punctuation`).not.toMatch(/[?!.]\./);
      for (const re of WAIT_TEXT_FORBIDDEN) expect(s, `${reason} must not say ${re}`).not.toMatch(re);
    }
  });

  it("the reply words the email offers take their door on any kind; anything else is the answer", () => {
    const offered = [{ key: "ANSWER" }, { key: "DROP" }, { key: "RETRY" }, { key: "ESCALATE" }];
    expect(blockReplyDoor("Drop it — not needed now", offered)).toBe("DROP");
    expect(blockReplyDoor("try again", offered)).toBe("RETRY");
    expect(blockReplyDoor("Send it to an engineer please", offered)).toBe("ESCALATE");
    expect(blockReplyDoor("try again", [{ key: "ANSWER" }]), "a door the block did not offer is not taken").toBe("ANSWER");
    expect(blockReplyDoor("Use the Kirx Diaz deck instead", offered)).toBe("ANSWER");
  });

  it("an email reply 'drop it' to Walker's blocked card drops it — the clearing action really is the email", async () => {
    const id = await card("Speaker search", "Walker, find three speakers for November.");
    await env.WP_OS_DB.prepare("UPDATE work_card SET owner_id = 'aie_walker' WHERE id = ?1").bind(id).run();
    await blockCard(env, { id, title: "Speaker search", firm_scope: "west-peek" }, { reason: "a_question_for_you", trying: "Find three speakers for November", employee: "Walker", detail: "Which city — Memphis or Atlanta?" });
    const row = await env.WP_OS_DB.prepare("SELECT next_action, block_actions_json FROM work_card WHERE id = ?1").bind(id).first<{ next_action: string; block_actions_json: string }>();
    expect(row!.next_action).toMatch(/^Waiting on: Which city — Memphis or Atlanta\? Why: .+ To clear it by email: reply to this email with your answer/s);
    const { answerBlock } = await import("../src/worker/services/blocks");
    const door = blockReplyDoor("drop it, we found them", JSON.parse(row!.block_actions_json));
    expect(door).toBe("DROP");
    const out = await answerBlock(env, id, "fu_sequoia", { action: door, text: "drop it, we found them" });
    expect(out.state).toBe("CANCELLED");
  });

  it("the reminder for a block nobody answered is the same three parts, with no Work page in it", async () => {
    const id = await card("Venue list", "Percy, a venue list for the December Room.");
    await blockCard(env, { id, title: "Venue list", firm_scope: "west-peek" }, { reason: "a_question_for_you", trying: "A venue list for the December Room", employee: "Percy", detail: "Is the budget per head or total?" });
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_nag_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    await resurfaceStaleBlocks(env, new Date());
    const n = await env.WP_OS_DB.prepare("SELECT body FROM notification WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ body: string }>();
    expect(n!.body).toMatch(/^Waiting on: Is the budget per head or total\? Why: .+ To clear it by email: /s);
    expect(n!.body).not.toMatch(/Work page/);
  });
});

describe("R14 / R23: a dated deferred line in any employee's result becomes its own dated card", () => {
  it("reads the lines, opens one card per item for the same employee and partner, leased to its date, once", async () => {
    expect(deferredItemsIn("Done.\n- Deferred to 2026-10-13: move the DB to Scooter's account\nDeferred to 2026-13-40: nonsense")).toEqual([{ ask: "move the DB to Scooter's account", due_at: "2026-10-13T14:00:00.000Z" }]);
    const id = await card("Workshop kit", "Walker, the workshop kit; the sponsor deck can wait for next week.");
    await env.WP_OS_DB.prepare("UPDATE work_card SET owner_id = 'aie_walker' WHERE id = ?1").bind(id).run();
    const src = { id, title: "Workshop kit", owner_id: "aie_walker", requested_by_email: SEQUOIA, firm_scope: "west-peek" };
    const made = await deferDatedItems(env, src, "Kit done.\nDeferred to 2026-10-13: the sponsor deck");
    expect(made).toHaveLength(1);
    const row = await env.WP_OS_DB.prepare("SELECT owner_id, requested_by_email, lease_until, waiting_for, assigned_from_card_id, title FROM work_card WHERE id = ?1").bind(made[0]).first<Record<string, string>>();
    expect(row).toMatchObject({ owner_id: "aie_walker", requested_by_email: SEQUOIA, lease_until: "2026-10-13T14:00:00.000Z", assigned_from_card_id: id });
    expect(row!.title).toContain("(deferred to 2026-10-13)");
    expect(await deferDatedItems(env, src, "Deferred to 2026-10-13: the sponsor deck"), "never twice").toEqual([]);
  });
});

describe("R21 (addendum item 10): a Drive folder the ask names is watched, loaded on arrival, 'still empty' said once", () => {
  it("records the folder at the door, tells the partner once while it is empty, then loads the files with no new email", async () => {
    expect(driveFoldersIn(`the files are in ${FOLDER} and https://drive.google.com/file/d/1ZZZZZZZZZZZZ/view`)).toEqual([{ id: "1AbCdEfGhIjKlMnOpQrStUv", url: FOLDER }]);
    const id = await card("Speaker bios", `Walker, write the speaker bios from the notes in ${FOLDER}`);
    const watch = await env.WP_OS_DB.prepare("SELECT id, status FROM drive_watch WHERE work_card_id = ?1").bind(id).first<{ id: string; status: string }>();
    expect(watch!.status).toBe("WATCHING");

    const pending = async () => ((await (await handleRequest(new Request("https://test.local/api/drive-watches/pending", { method: "POST", headers: CLAIMER, body: "{}" }), env)).json()) as { watches: Array<{ id: string }> }).watches.map((w) => w.id);
    const status = async (body: object) => ((await (await handleRequest(new Request("https://test.local/api/drive-watches/status", { method: "POST", headers: CLAIMER, body: JSON.stringify({ id: watch!.id, ...body }) }), env)).json()) as { did: string }).did;
    const forbidden = await handleRequest(new Request("https://test.local/api/drive-watches/pending", { method: "POST", headers: { "x-wpos-dev-user": SEQUOIA, "content-type": "application/json" }, body: "{}" }), env);
    expect(forbidden.status, "only the Mac's claimer").toBe(403);

    expect(await pending()).toContain(watch!.id);
    const before = sent.length;
    expect(await status({ files: 0 })).toBe("told_empty");
    expect(sent.length - before, "one email").toBe(1);
    expect(sent.at(-1)!.text).toMatch(/still empty/);
    expect(sent.at(-1)!.text).toMatch(/no new email needed/);
    expect(await pending(), "not due again for 15 minutes").not.toContain(watch!.id);
    await env.WP_OS_DB.prepare("UPDATE drive_watch SET last_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(watch!.id).run();
    expect(await status({ files: 0 })).toBe("still_empty");
    expect(sent.length - before, "'still empty' is said ONCE").toBe(1);

    expect(await status({ files: 2, names: ["bios.txt", "headshot.png"], documents: [{ name: "bios.txt", text: "Kirx Diaz runs a studio in Memphis." }] })).toBe("loaded");
    expect(sent.length - before, "loading needs no email").toBe(1);
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ body: string }>();
    expect(note!.body).toContain("bios.txt, headshot.png");
    expect(note!.body).toContain("Kirx Diaz runs a studio in Memphis.");
    expect((await env.WP_OS_DB.prepare("SELECT status FROM drive_watch WHERE id = ?1").bind(watch!.id).first<{ status: string }>())!.status).toBe("ARRIVED");
    expect(await pending()).not.toContain(watch!.id);
  });

  it("a blocked card is picked back up when the files land", async () => {
    const id = await card("Deck notes", `Parker, use the notes in ${FOLDER.replace("1AbCdEfGhIjKlMnOpQrStUv", "1QwErTyUiOpAsDfGhJkL")}`);
    await blockCard(env, { id, title: "Deck notes", firm_scope: "west-peek" }, { reason: "a_question_for_you", trying: "Use the notes", employee: "Parker", detail: "The folder is empty." });
    const w = await env.WP_OS_DB.prepare("SELECT id FROM drive_watch WHERE work_card_id = ?1").bind(id).first<{ id: string }>();
    const res = await handleRequest(new Request("https://test.local/api/drive-watches/status", { method: "POST", headers: CLAIMER, body: JSON.stringify({ id: w!.id, files: 1, names: ["notes.txt"] }) }), env);
    expect(((await res.json()) as { did: string }).did).toBe("loaded");
    const c = await env.WP_OS_DB.prepare("SELECT state, block_answer FROM work_card WHERE id = ?1").bind(id).first<{ state: string; block_answer: string }>();
    expect(c!.state).toBe("OPEN");
    expect(c!.block_answer).toContain("notes.txt");
  });
});
