import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import type { Actor } from "../src/worker/services/authorize";
import { createMeeting, addNote } from "../src/worker/services/meetings";
import { createOpportunity } from "../src/worker/services/investment";
import { recordDecision, readMeetingAfter, recordAfterDraft } from "../src/worker/services/meetingAfter";
import { seatedEmployees } from "../src/worker/services/liveHelp";
import { blockCard } from "../src/worker/services/blocks";
import {
  addressee,
  askRoom,
  buildRoomContext,
  isConfidentialMeeting,
  parseRoomReply,
  returnCardToRoom,
  rollSummary,
  roomState,
  type RoomAnswerer,
} from "../src/worker/services/meetingRoom";
import { compileRecordQuery, RecordQueryRefused, ALLOWLIST } from "../src/shared/meetings/roomQuery";
import { foldTurns, diarisedLine, looksLikeModelMissing } from "../src/worker/ai/providers/workersAiNova3";
import { transcribeWithSpeakers } from "../src/worker/services/liveTranscription";

/**
 * Phase C — the meeting is a live room.
 *
 * The rules under test: a question, typed or spoken, ALWAYS ends in a saved block and NEVER in a
 * decision, commitment, open question, stage proposal or deal move; a report is a plan against an
 * allowlist and a table outside it is refused by name, with the rows cited; an employee addressed
 * by name answers in their own seat and a task opens a preview-first card with her words on it
 * that returns to the meeting when it finishes; the rolling summary is Phase B's drafter and stays
 * a draft; Nova-3 turns fold by speaker and an unattributed word stays unattributed; LP meetings
 * are confidential at the router.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MP_IDENTITY: FirmUserIdentity = {
  id: "fu_scooter_taylor",
  email: "scooter@westpeek.ventures",
  fullName: "Scooter Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

const answers = (reply: unknown): RoomAnswerer => async () => ({ ok: true, text: JSON.stringify(reply), aiRunId: null, detail: "COMPLETED" });
const unreachable: RoomAnswerer = async () => ({ ok: false, text: "", aiRunId: null, detail: "BUDGET_BLOCKED" });

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, { method, headers: body === undefined ? MP : { ...MP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
async function company(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", "POST", { canonical_name: `Room Co ${seq} ${crypto.randomUUID().slice(0, 6)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function afterCounts(meetingId: string) {
  const a = await readMeetingAfter(env, meetingId);
  const opp = await t.db.prepare("SELECT COUNT(*) AS n FROM meeting_stage_proposal WHERE meeting_id = ?1").bind(meetingId).first<{ n: number }>();
  return { decisions: a.decisions.length, commitments: a.commitments.length, open_questions: a.open_questions.length, proposals: Number(opp?.n ?? 0) };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name IN ('Walter','Wyatt','Wesley','Winter')").run();
  await t.db.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE name = 'Pierce'").run();
  await t.db.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lp_room', 'A Family Office', 'FAMILY_OFFICE', 'ENGAGED', 'fu_scooter_taylor')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("0. migration 0204 built what it describes", () => {
  it("added the provenance columns on the block, one block per card, and the ask key", async () => {
    const cols = ((await t.db.prepare("PRAGMA table_info(meeting_artifact)").all<{ name: string }>()).results ?? []).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["asked_text", "asked_via", "work_card_id"]));
    const idx = await t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_meeting_artifact_card'").first();
    expect(idx).toBeTruthy();
    const key = await t.db.prepare("SELECT key, is_external_effect FROM action_type WHERE key = 'meeting.room.ask'").first<{ key: string; is_external_effect: number }>();
    expect(key?.is_external_effect).toBe(0);
  });
});

describe("1. the reply is parsed and checked in code; the addressee is read from the roster", () => {
  it("reads a fenced reply and refuses one that is not one of the four modes", () => {
    expect(parseRoomReply('```json\n{"mode":"answer","answer":"They said fourteen months of runway."}\n```')?.mode).toBe("answer");
    expect(parseRoomReply('{"mode":"approve","answer":"x"}')).toBeNull();
    expect(parseRoomReply("Sure! Happy to help.")).toBeNull();
  });

  it("\"Wyatt, pull the comparables\" is addressed to Wyatt; \"Bob, …\" is addressed to nobody", () => {
    expect(addressee("Wyatt, pull the last three rounds' comparables")).toEqual({ name: "Wyatt", rest: "pull the last three rounds' comparables" });
    expect(addressee("wyatt: what did they say about churn")).toEqual({ name: "Wyatt", rest: "what did they say about churn" });
    expect(addressee("Bob, what is the runway")).toEqual({ name: null, rest: "Bob, what is the runway" });
    expect(addressee("what did we promise")).toEqual({ name: null, rest: "what did we promise" });
  });

  it("an LP meeting is confidential, exactly as Phase B derives it", () => {
    expect(isConfidentialMeeting({ meeting_type: "LP", lp_record_id: null })).toBe(true);
    expect(isConfidentialMeeting({ meeting_type: "FOUNDER", lp_record_id: "lp_room" })).toBe(true);
    expect(isConfidentialMeeting({ meeting_type: "FOUNDER", lp_record_id: null })).toBe(false);
  });
});

describe("2. the record query is a plan against an allowlist, never SQL", () => {
  const ctx = { firmScope: "west-peek", visibility: "1=1" };

  it("compiles a plan into one parameterised SELECT with the scope, the privacy clause and a cap", () => {
    const q = compileRecordQuery({ table: "investment_opportunity", select: ["title", "status"], where: [{ column: "status", op: "in", value: ["SCREENING", "DILIGENCE"] }], limit: 10 }, { firmScope: "west-peek", visibility: "privacy_label IN ('PUBLIC')" });
    expect(q.sql).toBe("SELECT id, title, status FROM investment_opportunity WHERE firm_scope = ?1 AND (privacy_label IN ('PUBLIC')) AND archived_at IS NULL AND status IN (?2, ?3) LIMIT 10");
    expect(q.params).toEqual(["west-peek", "SCREENING", "DILIGENCE"]);
    expect(q.confidential).toBe(true);
  });

  it("a grouped metric becomes GROUP BY with the aggregate aliased metric", () => {
    const q = compileRecordQuery({ table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, chart: "bar" }, ctx);
    expect(q.sql).toContain("SELECT status, COUNT(*) AS metric FROM investment_opportunity");
    expect(q.sql).toContain("GROUP BY status ORDER BY metric DESC LIMIT 25");
  });

  it("refuses a table outside the allowlist BY NAME, a column outside the table, and a cap above 50", () => {
    expect(() => compileRecordQuery({ table: "firm_user", select: ["email"] }, ctx)).toThrow(/"firm_user" is not a table the room may read/);
    expect(() => compileRecordQuery({ table: "canonical_company", select: ["mp_notes"] }, ctx)).toThrow(/"canonical_company.mp_notes" is not a column/);
    expect(() => compileRecordQuery({ table: "canonical_company", limit: 500 }, ctx)).toThrow(RecordQueryRefused);
    expect(() => compileRecordQuery({ table: "canonical_company; DROP TABLE meeting", select: ["id"] }, ctx)).toThrow(RecordQueryRefused);
    // A prototype key is not an allowlist entry: refused by name, never a TypeError.
    for (const t of ["constructor", "__proto__", "valueof"]) {
      expect(() => compileRecordQuery({ table: t, select: ["id"] }, ctx), t).toThrow(new RegExp(`"${t}" is not a table the room may read`));
    }
    // Mixed-case prototype keys fail the identifier shape first — still a RecordQueryRefused, never a TypeError.
    for (const t of ["hasOwnProperty", "toString"]) expect(() => compileRecordQuery({ table: t, select: ["id"] }, ctx), t).toThrow(RecordQueryRefused);
    expect(() => compileRecordQuery({ table: "canonical_company", select: ["constructor"] }, ctx)).toThrow(/"canonical_company.constructor" is not a column/);
  });

  it("every allowlisted table and column exists in the schema the migrations built", async () => {
    for (const [table, def] of Object.entries(ALLOWLIST)) {
      const cols = ((await t.db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results ?? []).map((c) => c.name);
      expect(cols.length, `${table} is not a table`).toBeGreaterThan(0);
      for (const c of Object.keys(def.columns)) expect(cols, `${table}.${c}`).toContain(c);
      if (def.privacy) expect(cols).toContain("privacy_label");
      if (def.archivable) expect(cols).toContain("archived_at");
      expect(cols).toContain("firm_scope");
    }
  });
});

describe("3. asking the room always ends in a saved block and never in a record", () => {
  it("a typed question is answered by the page's host, saved as an answer block, and the After face is untouched", async () => {
    const cid = await company();
    const m = await createMeeting(env, MP_ACTOR, { title: "Founder call", meeting_type: "FOUNDER", company_id: cid, occurred_at: "2026-09-18T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "Speaker 1: our runway is fourteen months" });
    const before = await afterCounts(m.id);
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "what did they say about runway?" }, answers({ mode: "answer", answer: "Fourteen months, from their own line: \"our runway is fourteen months\"." }));
    expect(out.via).toBe("TEXT");
    expect(out.answered_by).toBe("Walter");
    expect(out.artifact.kind).toBe("answer");
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "OK", answered_by: "Walter" });
    expect((out.artifact as unknown as { asked_text: string; asked_via: string })).toMatchObject({ asked_text: "what did they say about runway?", asked_via: "TEXT" });
    expect(await afterCounts(m.id)).toEqual(before);
  });

  it("a reply that proposes a record is not one of the four modes and is stored as a failure — nothing written", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Tempting reply", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    const before = await afterCounts(m.id);
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "record that we decided to pass" }, answers({ mode: "decision", decision_text: "pass" }));
    expect(JSON.parse(out.artifact.body_json).state).toBe("FAILED");
    expect(await afterCounts(m.id)).toEqual(before);
  });

  it("a refusal and an unreachable model are both saved blocks with their reason", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Refusals", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    const refused = await askRoom(env, MP_IDENTITY, m.id, { question: "move the deal to diligence" }, answers({ mode: "refuse", reason: "A partner moves a deal from the After draft, not from the room." }));
    expect(JSON.parse(refused.artifact.body_json)).toMatchObject({ state: "REFUSED", detail: expect.stringMatching(/After draft/) });
    const down = await askRoom(env, MP_IDENTITY, m.id, { question: "anything" }, unreachable);
    expect(JSON.parse(down.artifact.body_json)).toMatchObject({ state: "FAILED", detail: expect.stringMatching(/BUDGET_BLOCKED/) });
    expect(await afterCounts(m.id)).toEqual({ decisions: 0, commitments: 0, open_questions: 0, proposals: 0 });
  });

  it("a question addressed to Wyatt seats him and is answered in his name", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Addressed", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    expect(await seatedEmployees(env, m.id)).toHaveLength(0);
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "Wyatt, what does the mandate say about this sector?" }, answers({ mode: "answer", answer: "Nothing on the record names the sector; I am answering generally." }));
    expect(out.answered_by).toBe("Wyatt");
    expect((await seatedEmployees(env, m.id)).map((s) => s.name)).toEqual(["Wyatt"]);
  });

  it("an employee who is not employed cannot answer, and says so as a block", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Nobody home", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "Pierce, what stage is this?" }, answers({ mode: "answer", answer: "x" }));
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "REFUSED", detail: expect.stringMatching(/Pierce is/) });
  });

  it("refuses while AI access is revoked, and refuses an empty question", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Revoked", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    await t.db.prepare("UPDATE meeting SET ai_access_state = 'REVOKED' WHERE id = ?1").bind(m.id).run();
    await expect(askRoom(env, MP_IDENTITY, m.id, { question: "hello?" }, answers({ mode: "answer", answer: "x" }))).rejects.toMatchObject({ code: "ai_access_revoked" });
    const m2 = await createMeeting(env, MP_ACTOR, { title: "Empty", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    await expect(askRoom(env, MP_IDENTITY, m2.id, { question: " " }, answers({ mode: "answer", answer: "x" }))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("4. a report or chart on the spot — from the record, cited, or refused by name", () => {
  it("a query plan produces a table block that cites the rows it read, with the SQL that ran", async () => {
    const cid = await company();
    const opp = await createOpportunity(env, MP_ACTOR, { company_id: cid, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Room Seed round" });
    const m = await createMeeting(env, MP_ACTOR, { title: "Report", meeting_type: "INTERNAL", company_id: cid, occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "show me the deals for this company" }, answers({
      mode: "query", answer: "Deals for this company",
      query: { table: "investment_opportunity", select: ["title", "status"], where: [{ column: "company_id", op: "eq", value: cid }] },
    }));
    expect(out.artifact.kind).toBe("table");
    const body = JSON.parse(out.artifact.body_json);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: opp.id, title: "Room Seed round" });
    expect(body.cites).toEqual([`investment_opportunity:${opp.id}`]);
    expect(body.sql).toMatch(/^SELECT id, title, status FROM investment_opportunity WHERE firm_scope = \?1/);
    expect(body.confidential).toBe(true);
  });

  it("a grouped plan with a chart type becomes a chart block; a chart without a grouping is a table", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Chart", meeting_type: "INTERNAL", occurred_at: "2026-09-18T10:00:00.000Z" });
    const chart = await askRoom(env, MP_IDENTITY, m.id, { question: "chart the pipeline by stage" }, answers({ mode: "query", answer: "Pipeline by stage", query: { table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, chart: "bar" } }));
    expect(chart.artifact.kind).toBe("chart");
    expect(JSON.parse(chart.artifact.body_json).chart).toBe("bar");
    const table = await askRoom(env, MP_IDENTITY, m.id, { question: "list them" }, answers({ mode: "query", answer: "Listed", query: { table: "investment_opportunity", select: ["title"], chart: "pie" } }));
    expect(table.artifact.kind).toBe("table");
  });

  it("a plan naming a table outside the allowlist is refused BY NAME as a saved block", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Forbidden", meeting_type: "INTERNAL", occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "list every user's email" }, answers({ mode: "query", answer: "Users", query: { table: "firm_user", select: ["email"] } }));
    expect(out.artifact.kind).toBe("answer");
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "REFUSED", detail: expect.stringMatching(/"firm_user" is not a table the room may read/) });
  });

  it("a plan naming a nonsense column is refused BY NAME too", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Forbidden col", meeting_type: "INTERNAL", occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "show mp notes" }, answers({ mode: "query", answer: "x", query: { table: "canonical_company", select: ["mp_notes"] } }));
    expect(JSON.parse(out.artifact.body_json).detail).toMatch(/"canonical_company.mp_notes" is not a column/);
  });
});

describe("5. pulling an employee in for a task, live", () => {
  it("opens a preview-first card with meeting_id and her words on prompt, seats the employee, and saves a WORKING receipt", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Pull in", meeting_type: "DILIGENCE", occurred_at: "2026-09-18T10:00:00.000Z" });
    const question = "Wyatt, pull the last three rounds' comparables";
    const out = await askRoom(env, MP_IDENTITY, m.id, { question }, answers({ mode: "task", task: { employee: "Wyatt", brief: "Pull comparables for the last three rounds in this sector and stage." } }));
    expect(out.work_card_id).toBeTruthy();
    const card = await t.db.prepare("SELECT title, owner_type, owner_id, meeting_id, prompt, preview_first, state FROM work_card WHERE id = ?1").bind(out.work_card_id).first<any>();
    expect(card).toMatchObject({ owner_type: "AI", owner_id: "aie_wyatt", meeting_id: m.id, prompt: question, preview_first: 1, state: "OPEN" });
    expect(out.artifact.kind).toBe("packet");
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "WORKING", work_card_id: out.work_card_id, employee: "Wyatt" });
    expect((await seatedEmployees(env, m.id)).map((s) => s.name)).toContain("Wyatt");
    const state = await roomState(env, MP_IDENTITY, m.id);
    expect(state.tasks[0]).toMatchObject({ work_card_id: out.work_card_id, chip: "working", owner_name: "Wyatt" });
  });

  it("the card's result returns to the room as the SAME block, now done; a blocked card reads 'needs you'", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Return address", meeting_type: "DILIGENCE", occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "Wyatt, check the cap table" }, answers({ mode: "task", task: { employee: "Wyatt", brief: "Check the cap table for the round." } }));
    const cardId = out.work_card_id!;
    const returned = await returnCardToRoom(env, cardId, { employee: "Wyatt", finding: "Fully diluted 12.4% post; option pool 10%.", deliverableId: null });
    expect(returned!.id).toBe(out.artifact.id);
    expect(JSON.parse(returned!.body_json)).toMatchObject({ state: "DONE", finding: expect.stringMatching(/12\.4%/), work_card_id: cardId });
    const blocks = await t.db.prepare("SELECT COUNT(*) AS n FROM meeting_artifact WHERE work_card_id = ?1").bind(cardId).first<{ n: number }>();
    expect(Number(blocks?.n)).toBe(1);
    await blockCard(env, { id: cardId, title: "Check the cap table", firm_scope: "west-peek", owner_id: "aie_wyatt" }, { reason: "a_question_for_you", trying: "Check the cap table", employee: "Wyatt", detail: "Which round do you mean?" });
    const state = await roomState(env, MP_IDENTITY, m.id);
    expect(state.tasks.find((x) => x.work_card_id === cardId)).toMatchObject({ chip: "needs you", block_needed: expect.stringMatching(/Which round/) });
    // A card raised from no meeting returns nowhere.
    expect(await returnCardToRoom(env, "wc_nowhere", { employee: "Wyatt", finding: "x", deliverableId: null })).toBeNull();
  });

  it("a card raised from a meeting some other way (no receipt block) still returns, written by the system under meeting.note.add", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Converted", meeting_type: "DILIGENCE", occurred_at: "2026-09-18T10:00:00.000Z" });
    const { createWorkCardInternal } = await import("../src/worker/services/workCards");
    const card = await createWorkCardInternal(env, MP_IDENTITY, { title: "Follow-up from a commitment", owner_type: "AI", owner_id: "aie_wyatt", meeting_id: m.id });
    const returned = await returnCardToRoom(env, card.id, { employee: "Wyatt", finding: "Sent.", deliverableId: "dlv_x" });
    expect(returned).toMatchObject({ kind: "packet", produced_by_type: "SYSTEM", work_card_id: card.id, asked_via: "SYSTEM" });
    expect(JSON.parse(returned!.body_json)).toMatchObject({ state: "DONE", deliverable_id: "dlv_x" });
  });

  it("a task for somebody not employed is not opened, and the block says why", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Not employed", meeting_type: "DILIGENCE", occurred_at: "2026-09-18T10:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "get Pierce to run the model" }, answers({ mode: "task", task: { employee: "Pierce", brief: "Run the model for this round." } }));
    expect(out.work_card_id).toBeNull();
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "REFUSED", detail: expect.stringMatching(/Pierce is/) });
  });
});

describe("6. the rolling summary is Phase B's draft, and stays a draft", () => {
  it("rolls the After draft from the transcript so far, reuses it when nothing changed, and never approves", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Rolling", meeting_type: "PORTFOLIO", occurred_at: "2026-09-18T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "Speaker 1: we agreed the hire" });
    const first = await rollSummary(env, MP_ACTOR, m.id);
    expect(first.notes_read).toBe(1);
    expect(["FAILED", "REFUSED", "DRAFTED"]).toContain(first.draft.state);
    expect(first.draft.state).not.toBe("APPROVED");
    // Plant a drafted row over the same fingerprint, as a live run would have, and roll again.
    const input = (await import("../src/worker/services/meetingAfter")).draftInputFor;
    const text = (await input(env, m.id)).text;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const planted = await recordAfterDraft(env, MP_ACTOR, m.id, { draft: { decisions: [{ decision_text: "The hire goes ahead" }], commitments: [], open_questions: [], stage_proposal: null }, source_hash: hash, notes_read: 1, drafted_by: "Winter" });
    const again = await rollSummary(env, MP_ACTOR, m.id);
    expect(again.reused).toBe(true);
    expect(again.draft.id).toBe(planted.id);
    const state = await roomState(env, MP_IDENTITY, m.id);
    expect(state.summary?.id).toBe(planted.id);
    expect(state.summary?.state).toBe("DRAFTED");
    expect(await afterCounts(m.id)).toEqual({ decisions: 0, commitments: 0, open_questions: 0, proposals: 0 });
  });
});

describe("7. the context pack is this meeting's objects, never the firm", () => {
  it("carries the record, the notes, prior meetings' After objects with the same company, and what was already asked", async () => {
    const cid = await company();
    const earlier = await createMeeting(env, MP_ACTOR, { title: "First call", meeting_type: "FOUNDER", company_id: cid, occurred_at: "2026-09-01T10:00:00.000Z" });
    await recordDecision(env, MP_ACTOR, earlier.id, { decision_text: "We take a second meeting" });
    const other = await createMeeting(env, MP_ACTOR, { title: "Unrelated", meeting_type: "FOUNDER", company_id: await company(), occurred_at: "2026-09-02T10:00:00.000Z" });
    await recordDecision(env, MP_ACTOR, other.id, { decision_text: "Secret unrelated decision" });
    const m = await createMeeting(env, MP_ACTOR, { title: "Second call", meeting_type: "FOUNDER", company_id: cid, occurred_at: "2026-09-18T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "churn is eight percent" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "OFF_RECORD", body: "the CFO is leaving" });
    await askRoom(env, MP_IDENTITY, m.id, { question: "what about churn?" }, answers({ mode: "answer", answer: "Eight percent." }));
    const row = await t.db.prepare("SELECT id, title, meeting_type, status, company_id, lp_record_id, privacy_label, firm_scope, ai_access_state FROM meeting WHERE id = ?1").bind(m.id).first<any>();
    const ctx = await buildRoomContext(env, row);
    expect(ctx).toContain("COMPANY: Room Co");
    expect(ctx).toContain("churn is eight percent");
    expect(ctx).not.toContain("the CFO is leaving");
    expect(ctx).toContain("decided: We take a second meeting");
    expect(ctx).not.toContain("Secret unrelated decision");
    expect(ctx).toContain("ALREADY ASKED IN THIS ROOM");
    expect(ctx).toContain("what about churn?");
  });
});

describe("8. speaker turns: Nova-3 folds by speaker, an unattributed word stays unattributed, Whisper is the named fallback", () => {
  it("folds consecutive words by speaker and labels an unattributed run as not identified", () => {
    const turns = foldTurns([
      { punctuated_word: "We", speaker: 0 }, { punctuated_word: "agreed.", speaker: 0 },
      { punctuated_word: "Fourteen", speaker: 1 }, { punctuated_word: "months.", speaker: 1 },
      { punctuated_word: "Noted." },
    ]);
    expect(turns.map(diarisedLine)).toEqual(["Speaker 1: We agreed.", "Speaker 2: Fourteen months.", "Speaker not identified: Noted."]);
  });

  it("uses Nova-3 turns when the model answers, and Whisper with a stated reason when the model is missing", async () => {
    const nova = { run: async (model: string) => (model.includes("nova-3") ? { results: { channels: [{ alternatives: [{ transcript: "hello there", words: [{ punctuated_word: "hello", speaker: 0 }, { punctuated_word: "there", speaker: 1 }] }] }] } } : { text: "hello there" }) };
    const a = await transcribeWithSpeakers({ ...env, AI: nova } as Env, "AAAA", "audio/webm");
    expect(a).toMatchObject({ engine: "NOVA3", speakers: [0, 1], text: "Speaker 1: hello\nSpeaker 2: there", fallback_reason: null });
    const missing = { run: async (model: string) => { if (model.includes("nova-3")) throw new Error("No such model @cf/deepgram/nova-3"); return { text: "hello there", word_count: 2 }; } };
    const b = await transcribeWithSpeakers({ ...env, AI: missing } as Env, "AAAA", "audio/webm");
    expect(b).toMatchObject({ engine: "WHISPER", speakers: [], text: "hello there", fallback_reason: expect.stringMatching(/No such model/) });
    expect(looksLikeModelMissing("5007: No such model")).toBe(true);
    expect(looksLikeModelMissing("audio too short")).toBe(false);
  });

  it("a spoken question is transcribed, the speaker labels are stripped, and it is saved as VOICE", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Spoken", meeting_type: "FOUNDER", occurred_at: "2026-09-18T10:00:00.000Z" });
    const nova = { run: async () => ({ results: { channels: [{ alternatives: [{ transcript: "what did we promise", words: [{ punctuated_word: "what", speaker: 0 }, { punctuated_word: "did", speaker: 0 }, { punctuated_word: "we", speaker: 0 }, { punctuated_word: "promise", speaker: 0 }] }] }] } }) };
    const out = await askRoom({ ...env, AI: nova } as Env, MP_IDENTITY, m.id, { audio_base64: "AAAA", content_type: "audio/webm" }, answers({ mode: "answer", answer: "Nothing yet." }));
    expect(out).toMatchObject({ via: "VOICE", asked: "what did we promise" });
    expect((out.artifact as unknown as { asked_via: string }).asked_via).toBe("VOICE");
    await expect(askRoom(env, MP_IDENTITY, m.id, { audio_base64: "AAAA" }, answers({ mode: "answer", answer: "x" }))).rejects.toMatchObject({ code: "transcription_unavailable" });
  });
});

describe("9. the routes", () => {
  it("GET room, POST roll and POST ask answer through the router; every one answers 401 to nobody", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Routes", meeting_type: "INTERNAL", occurred_at: "2026-09-18T10:00:00.000Z" });
    const state = await call(`/api/meetings/${m.id}/room`);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ host: { name: "Walter" }, roll_every_ms: 300_000, capture: { meeting_id: m.id } });
    const roll = await call(`/api/meetings/${m.id}/room/roll`, "POST", {});
    expect(roll.status).toBe(201);
    expect(roll.body.draft.state).toBe("REFUSED");
    const bad = await call(`/api/meetings/${m.id}/room/ask`, "POST", {});
    expect(bad.status).toBe(400);
    // Audio must be base64 and an audio content type; anything else is a 400 before any adapter runs.
    expect((await call(`/api/meetings/${m.id}/room/ask`, "POST", { audio_base64: "not base64!!", content_type: "audio/webm" })).status).toBe(400);
    expect((await call(`/api/meetings/${m.id}/room/ask`, "POST", { audio_base64: "AAAA", content_type: "text/html" })).status).toBe(400);
    expect((await call(`/api/meetings/${m.id}/room/ask`, "POST", { audio_base64: "AAAA", content_type: "audio/webm;codecs=opus" })).status).toBe(503);
    expect((await call(`/api/meetings/${m.id}/capture/chunk`, "POST", { audio_base64: "AAAA", sequence: 0, content_type: "application/octet-stream" })).status).toBe(400);
    const asked = await call(`/api/meetings/${m.id}/room/ask`, "POST", { question: "what is on the record?" });
    expect(asked.status).toBe(201);
    expect(["FAILED", "REFUSED", "OK"]).toContain(JSON.parse(asked.body.artifact.body_json).state);
    for (const [path, method] of [[`/api/meetings/${m.id}/room`, "GET"], [`/api/meetings/${m.id}/room/roll`, "POST"], [`/api/meetings/${m.id}/room/ask`, "POST"]] as const) {
      const res = await handleRequest(new Request(`https://test.local${path}`, { method }), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
