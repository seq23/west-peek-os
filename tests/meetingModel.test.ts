import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { createMeeting, createCommitment, addNote } from "../src/worker/services/meetings";
import { createOpportunity, getOpportunity } from "../src/worker/services/investment";
import { seatEmployee } from "../src/worker/services/liveHelp";
import { runJob } from "../src/worker/services/jobs";
import {
  afterDraftPrompt,
  approveMeetingAfter,
  decideStageProposal,
  draftInputFor,
  draftMeetingAfter,
  parseAfterDraft,
  proposeStageChange,
  readMeetingAfter,
  recordAfterDraft,
  recordDecision,
  recordOpenQuestion,
  resolveOpenQuestion,
  honourCommitment,
  saveMeetingArtifact,
  askOfferLedger,
} from "../src/worker/services/meetingAfter";
import { assembleMeetingBrief, buildMeetingBrief, latestBrief, leadNameFor, runMeetingBriefs } from "../src/worker/services/meetingBrief";
import { MEETING_TYPES } from "../src/shared/meetings/meetingTypes";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";

/**
 * Phase B — a meeting is one object with three faces.
 *
 * The rules under test: the four After objects exist for every type and are written only through
 * their own authorize() keys; the AI draft is a proposal and NOTHING in it is a record until a
 * person approves it; a stage proposal never moves a deal by itself and accepting one runs the
 * ordinary transition; the brief builds for every type, carries what it examined, and rolls open
 * questions and both sides' commitments forward to the next meeting with the same company or LP;
 * the night-before job briefs what is in the window and says how many it looked at; any ACTIVE
 * employee can be seated on any type; and a card raised from a meeting returns to it.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_walter", roles: [], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

let seq = 0;
async function company(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", MP, "POST", { canonical_name: `Phase B Co ${seq} ${crypto.randomUUID().slice(0, 6)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name IN ('Walter','Willow','Wyatt','Wesley','Winter')").run();
  await t.db
    .prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lp_phase_b', 'A Family Office', 'FAMILY_OFFICE', 'ENGAGED', 'fu_scooter_taylor')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. The schema and the job are what the migration says ──────────────────────────────────────

describe("0. migrations 0199 and 0200 built what they describe", () => {
  it("created the four After tables, the artifact table, the draft table, and the columns", async () => {
    for (const table of ["meeting_decision", "meeting_open_question", "meeting_stage_proposal", "meeting_artifact", "meeting_after_draft"]) {
      const row = await t.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(table).first();
      expect(row, `${table} is missing`).toBeTruthy();
    }
    const cols = async (table: string) => ((await t.db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results ?? []).map((c) => c.name);
    expect(await cols("meeting")).toContain("lp_record_id");
    expect(await cols("work_card")).toContain("meeting_id");
    expect(await cols("meeting_commitment")).toEqual(expect.arrayContaining(["owed_by", "honoured_at", "after_draft_id"]));
    expect(await cols("meeting_prep_packet")).toEqual(expect.arrayContaining(["brief_json", "body_md", "coverage_json", "prepared_by"]));
  });

  it("seeded sjb_meeting_brief ENABLED, daily, as the owner asked", async () => {
    const job = await t.db.prepare("SELECT id, job_key, schedule_kind, daily_at_utc, status FROM scheduled_job WHERE id = 'sjb_meeting_brief'").first<{ id: string; job_key: string; schedule_kind: string; daily_at_utc: string; status: string }>();
    expect(job).toMatchObject({ job_key: "meeting_brief", schedule_kind: "DAILY_AT", status: "ACTIVE" });
    expect(job!.daily_at_utc).toMatch(/^\d\d:\d\d$/);
  });

  it("registered every Phase B action key, so authorize() knows the vocabulary", async () => {
    for (const key of ["meeting.decision.record", "meeting.open_question.record", "meeting.stage_change.propose", "meeting.brief.assemble", "meeting.after.approve"]) {
      const row = await t.db.prepare("SELECT key, is_reserved, is_external_effect FROM action_type WHERE key = ?1").bind(key).first<{ key: string; is_reserved: number; is_external_effect: number }>();
      expect(row, `${key} is not registered`).toBeTruthy();
      expect(row!.is_external_effect).toBe(0);
    }
  });
});

// ── 1. The draft's shape is checked in code ───────────────────────────────────────────────────

describe("1. the draft is parsed and checked in code, not trusted", () => {
  it("reads a fenced block and accepts empty lists as a real answer", () => {
    const d = parseAfterDraft('```json\n{"decisions":[],"commitments":[],"open_questions":[]}\n```');
    expect(d).toEqual({ decisions: [], commitments: [], open_questions: [], stage_proposal: undefined });
  });

  it("refuses a stage proposal to a stage that does not exist, and a question too short to mean anything", () => {
    expect(parseAfterDraft('{"stage_proposal":{"to_status":"WHATEVER","rationale":"because we like them a lot"}}')).toBeNull();
    expect(parseAfterDraft('{"open_questions":[{"question":"ARR?"}]}')).toBeNull();
    expect(parseAfterDraft("no json here")).toBeNull();
  });

  it("tells the model the only legal stages, and says stage_proposal must be null when no deal is linked", () => {
    const withDeal = afterDraftPrompt({
      leadName: "Walter", leadRole: "Meeting Buddy", meeting: { title: "Call", meeting_type: "FOUNDER" }, participants: "",
      text: "- we agreed to send the term sheet by Friday", deal: { opportunity_id: "opp_1", title: "Seed", status: "DILIGENCE", next: ["IC_READY", "PASS", "WITHDRAWN"] },
    });
    expect(withDeal).toContain("IC_READY, PASS, WITHDRAWN");
    expect(withDeal).toContain("Nothing you write is a record until they do");
    const noDeal = afterDraftPrompt({ leadName: "Wesley", leadRole: "LP", meeting: { title: "LP call", meeting_type: "LP" }, participants: "", text: "- hello", deal: null });
    expect(noDeal).toContain("stage_proposal must be null");
  });
});

// ── 2. Drafting: every outcome is a row, and nothing is a record ──────────────────────────────

describe("2. the draft is a proposal, stored whatever happens, and never a record by itself", () => {
  it("refuses to draft from nothing rather than asking a model to invent", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Empty room", meeting_type: "OTHER", occurred_at: "2026-09-01T10:00:00.000Z" });
    const { draft } = await draftMeetingAfter(env, MP_ACTOR, m.id);
    expect(draft.state).toBe("REFUSED");
    expect(draft.detail).toMatch(/Nothing on the record/);
    expect(draft.ai_run_id).toBeNull();
  });

  it("never reads an off-record note", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Off record probe", meeting_type: "FOUNDER", occurred_at: "2026-09-01T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "OFF_RECORD", body: "they will fire the CTO next week" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "we will send the diligence list" });
    const input = await draftInputFor(env, m.id);
    expect(input.notes).toBe(1);
    expect(input.text).toContain("diligence list");
    expect(input.text).not.toContain("fire the CTO");
  });

  it("records a FAILED draft with its reason when the model's reply cannot be read, and a record stays empty", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Unreadable reply", meeting_type: "FOUNDER", occurred_at: "2026-09-01T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "we agreed to move to diligence and they will send the deck" });
    const { draft } = await draftMeetingAfter(env, MP_ACTOR, m.id);
    // With no live provider the boundary either refuses or the mock answers prose; either way the
    // row says which, and nothing has been written to the four tables.
    expect(["FAILED", "REFUSED"]).toContain(draft.state);
    expect(draft.detail).toBeTruthy();
    expect(draft.drafted_by).toBe(leadNameFor("FOUNDER"));
    const after = await readMeetingAfter(env, m.id);
    expect(after.decisions).toHaveLength(0);
    expect(after.commitments).toHaveLength(0);
    expect(after.open_questions).toHaveLength(0);
  });

  it("is idempotent over its input: the same text returns the same draft rather than a second run", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Rolling", meeting_type: "PORTFOLIO", occurred_at: "2026-09-01T10:00:00.000Z" });
    const text = "- we agreed the hire; they will send the plan";
    const stored = await recordAfterDraft(env, MP_ACTOR, m.id, {
      draft: { decisions: [{ decision_text: "The hire goes ahead" }], commitments: [], open_questions: [], stage_proposal: null },
      source_hash: await sha256(text), notes_read: 0, drafted_by: "Winter",
    });
    const again = await draftMeetingAfter(env, MP_ACTOR, m.id, { text });
    expect(again.reused).toBe(true);
    expect(again.draft.id).toBe(stored.id);
    // A change in the text is a new draft, not the old one.
    const changed = await draftMeetingAfter(env, MP_ACTOR, m.id, { text: text + "\n- and the board seat" });
    expect(changed.reused).toBe(false);
    expect(changed.draft.id).not.toBe(stored.id);
  });

  it("refuses while AI access to the room is revoked (canon §9.6.2E)", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Revoked room", meeting_type: "FOUNDER", occurred_at: "2026-09-01T10:00:00.000Z" });
    await addNote(env, MP_ACTOR, m.id, { note_type: "MANUAL", body: "plenty was said" });
    await t.db.prepare("UPDATE meeting SET ai_access_state = 'REVOKED' WHERE id = ?1").bind(m.id).run();
    const { draft } = await draftMeetingAfter(env, MP_ACTOR, m.id);
    expect(draft.state).toBe("REFUSED");
    expect(draft.detail).toMatch(/revoked/i);
  });
});

// ── 3. Approval: the moment a draft becomes records ───────────────────────────────────────────

describe("3. a person approves; the four objects are written through their own keys", () => {
  let meetingId = "";
  let oppId = "";
  let draftId = "";

  beforeAll(async () => {
    const cid = await company();
    const opp = await createOpportunity(env, MP_ACTOR, { company_id: cid, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Seed round" });
    oppId = opp.id;
    expect(opp.status).toBe("NEW");
    const m = await createMeeting(env, MP_ACTOR, { title: "Founder call", meeting_type: "FOUNDER", company_id: cid, occurred_at: "2026-09-02T10:00:00.000Z" });
    meetingId = m.id;
    // A hand-typed commitment already on the meeting: the draft's duplicate must be skipped.
    await createCommitment(env, MP_ACTOR, meetingId, { commitment_text: "Send the diligence question list", owner_side: "FIRM" });
    const stored = await recordAfterDraft(env, MP_ACTOR, meetingId, {
      draft: {
        decisions: [{ decision_text: "We will take the deal to screening", decided_by: "both partners", source_quote: "let's screen it" }],
        commitments: [
          { commitment_text: "Send the diligence question list", owner_side: "FIRM" },
          { commitment_text: "Send the data room link", owner_side: "COUNTERPARTY", owed_by: "Deana Oliver", due_date: "2026-09-05" },
          { commitment_text: "Draft the reference call list", owner_side: "FIRM", suggested_employee_name: "Wyatt" },
        ],
        open_questions: [{ question: "What is the authoritative ARR figure?", owed_by_kind: "COUNTERPARTY", owed_by: "Deana Oliver" }],
        stage_proposal: { to_status: "SCREENING", rationale: "The founders answered the first-pass questions and want to proceed." },
      },
      source_hash: "fixture", notes_read: 3, drafted_by: "Walter",
    });
    draftId = stored.id;
  });

  it("an AI actor cannot approve, and cannot decide a stage proposal", async () => {
    await expect(approveMeetingAfter(env, AI_ACTOR, draftId)).rejects.toMatchObject({ status: 403 });
    const after = await readMeetingAfter(env, meetingId);
    expect(after.decisions).toHaveLength(0);
    expect(after.latest_draft?.state).toBe("DRAFTED");
  });

  it("a partner's approval writes the decision, both sides' commitments, the question and the PROPOSAL — and moves nothing", async () => {
    const out = await approveMeetingAfter(env, MP_ACTOR, draftId);
    expect(out.written).toEqual({ decisions: 1, commitments: 2, open_questions: 1, stage_proposal: true, skipped: 1 });
    expect(out.draft.state).toBe("APPROVED");
    expect(out.draft.approved_by).toBe("fu_scooter_taylor");

    const after = out.after;
    expect(after.decisions[0]).toMatchObject({ decision_text: "We will take the deal to screening", decided_by: "both partners", after_draft_id: draftId });
    const theirs = after.commitments.find((c) => c.owner_side === "COUNTERPARTY");
    expect(theirs).toMatchObject({ owed_by: "Deana Oliver", due_date: "2026-09-05", origin: "EXTRACTED", assignee_kind: "UNASSIGNED" });
    const refs = after.commitments.find((c) => c.commitment_text === "Draft the reference call list");
    // Firm work goes through the P33 policy: an employee by default, and a human touch where the
    // text says a person should be on the call.
    expect(refs?.ai_employee_id).toBe("aie_wyatt");
    expect(refs?.assignee_kind).toBe("AI_WITH_HUMAN_TOUCH");
    expect(after.open_questions[0]).toMatchObject({ question: "What is the authoritative ARR figure?", owed_by_kind: "COUNTERPARTY", state: "OPEN" });
    expect(after.stage_proposals[0]).toMatchObject({ from_status: "NEW", to_status: "SCREENING", state: "PROPOSED" });
    expect(after.counts).toMatchObject({ decisions: 1, commitments_counterparty_open: 1, open_questions: 1, stage_proposals_pending: 1 });

    // THE DEAL DID NOT MOVE.
    expect((await getOpportunity(env, oppId))!.status).toBe("NEW");
  });

  it("approving twice is refused: the draft is already the record", async () => {
    await expect(approveMeetingAfter(env, MP_ACTOR, draftId)).rejects.toMatchObject({ code: "illegal_state" });
  });

  it("each object left a typed event on the spine, and the trail names the draft", async () => {
    const rows = (await t.db.prepare("SELECT event_type FROM event_record WHERE object_type IN ('meeting_decision','meeting_open_question','meeting_stage_proposal','meeting_after_draft') ORDER BY created_at").all<{ event_type: string }>()).results ?? [];
    const types = new Set(rows.map((r) => r.event_type));
    for (const e of ["meeting.decision_recorded", "meeting.open_question_recorded", "meeting.stage_change_proposed", "meeting.after_drafted", "meeting.after_approved"]) {
      expect(types.has(e), `${e} missing from the spine`).toBe(true);
    }
  });

  it("ACCEPT runs the ordinary transition under authorize(); DECLINE needs a reason; AI cannot click either", async () => {
    const p = (await readMeetingAfter(env, meetingId)).stage_proposals[0]!;
    await expect(decideStageProposal(env, AI_ACTOR, p.id, { decision: "ACCEPT" })).rejects.toMatchObject({ status: 403 });
    await expect(decideStageProposal(env, MP_ACTOR, p.id, { decision: "DECLINE" })).rejects.toMatchObject({ code: "reason_required" });
    const accepted = await decideStageProposal(env, MP_ACTOR, p.id, { decision: "ACCEPT" });
    expect(accepted.state).toBe("ACCEPTED");
    expect(accepted.decided_by).toBe("fu_scooter_taylor");
    expect((await getOpportunity(env, oppId))!.status).toBe("SCREENING");
    const moved = await t.db.prepare("SELECT payload_json FROM event_record WHERE event_type = 'investment.opportunity_transitioned' AND object_id = ?1").bind(oppId).first<{ payload_json: string }>();
    expect(JSON.parse(moved!.payload_json)).toMatchObject({ from: "NEW", to: "SCREENING" });
  });

  it("a proposal to a stage the deal cannot reach is refused at proposal time", async () => {
    await expect(proposeStageChange(env, MP_ACTOR, meetingId, { to_status: "CLOSED", rationale: "we are very keen indeed" })).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("answering an open question and honouring a counterparty commitment close the chase", async () => {
    const after = await readMeetingAfter(env, meetingId);
    const q = after.open_questions[0]!;
    await expect(resolveOpenQuestion(env, MP_ACTOR, q.id, { state: "ANSWERED" })).rejects.toMatchObject({ code: "reason_required" });
    const answered = await resolveOpenQuestion(env, MP_ACTOR, q.id, { state: "ANSWERED", answer: "$1.2m, from the bank statements" });
    expect(answered.state).toBe("ANSWERED");
    const theirs = after.commitments.find((c) => c.owner_side === "COUNTERPARTY")!;
    const honoured = await honourCommitment(env, MP_ACTOR, theirs.id, "link arrived");
    expect(honoured.honoured_at).toBeTruthy();
    await expect(honourCommitment(env, MP_ACTOR, theirs.id)).rejects.toMatchObject({ code: "illegal_state" });
    const counts = (await readMeetingAfter(env, meetingId)).counts;
    expect(counts.open_questions).toBe(0);
    expect(counts.commitments_counterparty_open).toBe(0);
  });

  it("an AI actor recording a decision must carry its run trace; a person need not", async () => {
    await expect(recordDecision(env, AI_ACTOR, meetingId, { decision_text: "something settled" })).rejects.toMatchObject({ code: "invalid_input" });
    const d = await recordDecision(env, MP_ACTOR, meetingId, { decision_text: "We pass on the secondary block" });
    expect(d.recorded_by_type).toBe("HUMAN");
  });

  it("a decision can never cite an off-record note", async () => {
    const note = await addNote(env, MP_ACTOR, meetingId, { note_type: "OFF_RECORD", body: "not for the file" });
    await expect(recordDecision(env, MP_ACTOR, meetingId, { decision_text: "settled off record", source_note_id: note.id })).rejects.toMatchObject({ code: "off_record" });
  });

  it("artifacts are saved on the meeting and listed read-only", async () => {
    const art = await saveMeetingArtifact(env, MP_ACTOR, meetingId, { kind: "table", title: "Burn by quarter", body: { rows: [[1, 2]] } });
    expect(art.kind).toBe("table");
    await expect(saveMeetingArtifact(env, AI_ACTOR, meetingId, { kind: "answer", title: "x", body: {} })).rejects.toMatchObject({ code: "invalid_input" });
    const listed = await call<{ artifacts: Array<{ id: string }> }>(`/api/meetings/${meetingId}/artifacts`, MP);
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts.map((a) => a.id)).toContain(art.id);
  });
});

// ── 4. The brief ──────────────────────────────────────────────────────────────────────────────

describe("4. the brief builds for every type, says what it examined, and rolls the last meeting forward", () => {
  it("every type names a lead employee who exists on the roster", () => {
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    for (const type of MEETING_TYPES) expect(names.has(leadNameFor(type.key)), `${type.key}'s lead ${leadNameFor(type.key)} is not on the roster`).toBe(true);
  });

  it("builds for a meeting about nobody, with zeros and a coverage block, rather than failing", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Wednesday sync", meeting_type: "INTERNAL", scheduled_at: "2026-10-01T15:00:00.000Z" });
    const b = await buildMeetingBrief(env, m.id);
    expect(b.record.about).toBe("NOBODY");
    expect(b.find_out).toEqual([]);
    expect(b.diligence).toBeNull();
    expect(b.coverage.length).toBeGreaterThan(0);
    expect(b.body).toContain("## What was examined");
    expect(b.body).toContain("No open questions are carried forward");
    expect(b.prepared_by).toBe(leadNameFor("INTERNAL"));
  });

  it("carries open questions and BOTH sides' commitments from the last meeting with the same company", async () => {
    const cid = await company();
    const first = await createMeeting(env, MP_ACTOR, { title: "First call", meeting_type: "FOUNDER", company_id: cid, occurred_at: "2026-09-01T10:00:00.000Z" });
    await recordOpenQuestion(env, MP_ACTOR, first.id, { question: "Who owns the IP from the university?", owed_by_kind: "COUNTERPARTY", owed_by: "the CEO" });
    await createCommitment(env, MP_ACTOR, first.id, { commitment_text: "Send the term sheet draft", owner_side: "FIRM", due_date: "2026-08-30" });
    await createCommitment(env, MP_ACTOR, first.id, { commitment_text: "Share the customer list", owner_side: "COUNTERPARTY" });
    const second = await createMeeting(env, MP_ACTOR, { title: "Second call", meeting_type: "DILIGENCE", company_id: cid, scheduled_at: "2026-09-10T10:00:00.000Z" });

    const b = await buildMeetingBrief(env, second.id, new Date("2026-09-09T20:00:00.000Z"));
    expect(b.find_out.map((q) => q.text)).toEqual([expect.stringContaining("Who owns the IP from the university?")]);
    expect(b.last_time.firm[0]).toMatchObject({ text: "Send the term sheet draft", standing: "OVERDUE" });
    expect(b.last_time.counterparty[0]).toMatchObject({ text: "Share the customer list", standing: "OPEN" });
    expect(b.record.about).toBe("COMPANY");
    expect(b.record.stage).toBe("no deal on the board");
    // A diligence meeting with a company gets the framework, every section open, no packet yet.
    expect(b.diligence).not.toBeNull();
    expect(b.diligence!.packet_id).toBeNull();
    expect(b.diligence!.answered).toBe(0);
    expect(b.diligence!.unanswered).toBeGreaterThan(10);
    expect(b.body).toContain("## Diligence framework");

    // Resolved in the second meeting → gone from the third's brief. The chase ends when it ends.
    const q = (await readMeetingAfter(env, first.id)).open_questions[0]!;
    await resolveOpenQuestion(env, MP_ACTOR, q.id, { state: "ANSWERED", answer: "The university assigned it in 2024.", resolved_in_meeting_id: second.id });
    const third = await createMeeting(env, MP_ACTOR, { title: "Third call", meeting_type: "FOUNDER", company_id: cid, scheduled_at: "2026-09-20T10:00:00.000Z" });
    const b3 = await buildMeetingBrief(env, third.id);
    expect(b3.find_out).toEqual([]);
    expect(b3.last_time.counterparty).toHaveLength(1);
  });

  it("follows the LP, not only the company, and an LP conversation is prepared by Wesley", async () => {
    const first = await createMeeting(env, MP_ACTOR, { title: "LP catch-up", meeting_type: "LP", lp_record_id: "lp_phase_b", occurred_at: "2026-09-01T10:00:00.000Z" });
    await createCommitment(env, MP_ACTOR, first.id, { commitment_text: "Send the Q3 letter early", owner_side: "FIRM" });
    const next = await createMeeting(env, MP_ACTOR, { title: "LP follow-up", meeting_type: "LP", lp_record_id: "lp_phase_b", scheduled_at: "2026-09-15T10:00:00.000Z" });
    const b = await buildMeetingBrief(env, next.id);
    expect(b.record.about).toBe("LP");
    expect(b.record.name).toBe("A Family Office");
    expect(b.last_time.firm.map((c) => c.text)).toEqual(["Send the Q3 letter early"]);
    expect(b.prepared_by).toBe("Wesley");
    await expect(createMeeting(env, MP_ACTOR, { title: "x", meeting_type: "LP", lp_record_id: "lp_nope" })).rejects.toMatchObject({ code: "unknown_lp" });
  });

  it("stores the brief on the P7 packet row through the SAME prep route, with the why-slot filled or explained", async () => {
    const cid = await company();
    const m = await createMeeting(env, MP_ACTOR, { title: "Prep via route", meeting_type: "PORTFOLIO", company_id: cid, scheduled_at: "2026-09-12T10:00:00.000Z" });
    const res = await call<{ id: string; brief_json: string; body_md: string; prepared_by: string; evidence_summary_json: string }>(`/api/meetings/${m.id}/prep`, MP, "POST", { open_questions: ["Is the runway really 14 months?"] });
    expect(res.status).toBe(201);
    expect(res.body.prepared_by).toBe(leadNameFor("PORTFOLIO"));
    expect(res.body.evidence_summary_json).toBeTruthy();
    const stored = await latestBrief(env, m.id);
    expect(stored!.id).toBe(res.body.id);
    expect(stored!.brief.find_out.map((q) => q.text)).toContain("Is the runway really 14 months?");
    // The one model-written line: either written, or the slot says why not. Never blank.
    if (stored!.brief.why === null) expect(stored!.brief.why_unavailable).toBeTruthy();
    else expect(stored!.brief.why.length).toBeGreaterThan(0);
    const read = await call<{ ready: boolean; brief: { id: string } }>(`/api/meetings/${m.id}/brief`, MP);
    expect(read.body.ready).toBe(true);
    expect(read.body.brief.id).toBe(res.body.id);
  });

  it("an AI actor assembling a brief must carry its run trace", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "AI prep", meeting_type: "OTHER", scheduled_at: "2026-09-12T10:00:00.000Z" });
    await expect(assembleMeetingBrief(env, AI_ACTOR, m.id, {})).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ── 5. The job ────────────────────────────────────────────────────────────────────────────────

describe("5. the night-before job briefs what is in the window and says how many it examined", () => {
  const now = new Date("2027-03-01T22:00:00.000Z");
  let inWindow = "";

  beforeAll(async () => {
    inWindow = (await createMeeting(env, MP_ACTOR, { title: "Tomorrow morning", meeting_type: "BROKER", scheduled_at: "2027-03-02T09:00:00.000Z" })).id;
    await createMeeting(env, MP_ACTOR, { title: "Next week", meeting_type: "BROKER", scheduled_at: "2027-03-08T09:00:00.000Z" });
    const archived = await createMeeting(env, MP_ACTOR, { title: "Off the record", meeting_type: "BROKER", scheduled_at: "2027-03-02T11:00:00.000Z" });
    await t.db.prepare("UPDATE meeting SET archived_at = '2027-01-01T00:00:00.000Z' WHERE id = ?1").bind(archived.id).run();
  });

  it("builds one brief for the meeting in the next 36h, and skips the one next week and the archived one", async () => {
    const out = await runMeetingBriefs(env, MP_ACTOR, now);
    expect(out.examined).toBe(1);
    expect(out.built.map((b) => b.meetingId)).toEqual([inWindow]);
    expect(out.failures).toEqual([]);
    expect(await latestBrief(env, inWindow)).not.toBeNull();
    const told = await t.db.prepare("SELECT title, severity FROM notification WHERE object_type = 'meeting' AND object_id = ?1").bind(inWindow).first<{ title: string; severity: string }>();
    expect(told?.severity).toBe("INFO");
    expect(told?.title).toMatch(/has your brief/);
  });

  it("does not brief the same meeting twice, and still says it examined it", async () => {
    const again = await runMeetingBriefs(env, MP_ACTOR, now);
    expect(again).toMatchObject({ examined: 1, alreadyBriefed: 1, failures: [] });
    expect(again.built).toEqual([]);
  });

  it("is dispatched by jobs.ts under job_key meeting_brief and reports what it did", async () => {
    const { run } = await runJob(env, MP_ACTOR, "meeting_brief", { trigger: "MANUAL", now });
    expect(run.status).toBe("SUCCEEDED");
    expect(String(run.outcome_summary)).toMatch(/1 meeting\(s\) in the next 36h examined; 0 brief\(s\) built, 1 already had one/);
  });
});

// ── 6. The lists, the ledger, the card, the seat ──────────────────────────────────────────────

describe("6. the list carries readiness and outputs; a card returns to its meeting; anyone can be seated", () => {
  it("an upcoming meeting says whether its brief is ready and what rolls forward; a past one says what it produced", async () => {
    const cid = await company();
    const past = await createMeeting(env, MP_ACTOR, { title: "Past", meeting_type: "PORTFOLIO", company_id: cid, occurred_at: "2026-09-01T10:00:00.000Z" });
    await recordDecision(env, MP_ACTOR, past.id, { decision_text: "Bridge round is approved in principle" });
    await recordOpenQuestion(env, MP_ACTOR, past.id, { question: "What is the true monthly burn?", owed_by_kind: "COUNTERPARTY" });
    await createCommitment(env, MP_ACTOR, past.id, { commitment_text: "Intro to the two hires", owner_side: "FIRM", due_date: "2020-01-01" });
    const upcoming = await createMeeting(env, MP_ACTOR, { title: "Upcoming", meeting_type: "PORTFOLIO", company_id: cid, scheduled_at: "2099-01-01T10:00:00.000Z" });

    const list = await call<{ meetings: Array<Record<string, unknown>> }>("/api/meetings", MP);
    const up = list.body.meetings.find((m) => m.id === upcoming.id)!;
    expect(up).toMatchObject({ brief_ready: 0, carried_open_questions: 1, we_owe_them: 1, they_owe_us: 0 });
    const was = list.body.meetings.find((m) => m.id === past.id)!;
    expect(was).toMatchObject({ decision_count: 1, commitment_overdue_count: 1, open_question_count: 1 });

    await call(`/api/meetings/${upcoming.id}/prep`, MP, "POST", {});
    const after = await call<{ meetings: Array<Record<string, unknown>> }>("/api/meetings", MP);
    expect(after.body.meetings.find((m) => m.id === upcoming.id)!.brief_ready).toBe(1);

    // And the portfolio ask/offer ledger sees the overdue firm-side commitment against the company.
    const ledger = await askOfferLedger(env, "1=1");
    expect(ledger.meetings_examined).toBeGreaterThan(0);
    expect(ledger.rows.find((r) => r.meeting_id === past.id)).toMatchObject({ owner_side: "FIRM", overdue: true });
    const viaRoute = await call<{ rows: unknown[] }>("/api/meeting-ledger/ask-offer", MP);
    expect(viaRoute.status).toBe(200);
  });

  it("a work card raised from a commitment carries meeting_id back to the meeting", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Card origin", meeting_type: "OTHER", occurred_at: "2026-09-01T10:00:00.000Z" });
    const c = await createCommitment(env, MP_ACTOR, m.id, { commitment_text: "Write up the notes", owner_side: "FIRM" });
    const converted = await call<{ work_card_id: string }>(`/api/meeting-commitments/${c.id}/convert`, MP, "POST", {});
    expect(converted.status).toBe(200);
    const card = await t.db.prepare("SELECT meeting_id FROM work_card WHERE id = ?1").bind(converted.body.work_card_id).first<{ meeting_id: string | null }>();
    expect(card?.meeting_id).toBe(m.id);
  });

  it("an INTERNAL_ONLY employee can be seated on an external meeting — the server never blocked it, and now the list does not either", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "External with compliance", meeting_type: "FOUNDER", occurred_at: "2026-09-01T10:00:00.000Z" });
    const willow = await t.db.prepare("SELECT id FROM ai_employee WHERE name = 'Willow'").first<{ id: string }>();
    const seat = await seatEmployee(env, MP_ACTOR, m.id, willow!.id);
    expect(seat.name).toBe("Willow");
  });

  it("every Phase B route answers 401 to nobody", async () => {
    for (const [method, path] of [
      ["GET", "/api/meetings/x/brief"], ["GET", "/api/meetings/x/after"], ["POST", "/api/meetings/x/decisions"],
      ["POST", "/api/meetings/x/open-questions"], ["POST", "/api/meeting-open-questions/x/resolve"], ["POST", "/api/meeting-commitments/x/honour"],
      ["POST", "/api/meetings/x/stage-proposals"], ["POST", "/api/meeting-stage-proposals/x/decide"], ["GET", "/api/meetings/x/artifacts"],
      ["POST", "/api/meetings/x/artifacts"], ["POST", "/api/meetings/x/after-draft"], ["POST", "/api/meeting-after-drafts/x/approve"],
      ["POST", "/api/meeting-after-drafts/x/discard"], ["GET", "/api/meeting-ledger/ask-offer"],
    ] as const) {
      const res = await handleRequest(req(path, {}, method, method === "POST" ? {} : undefined), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 7. LP material is declared private AT THE ROUTER, in both model calls ─────────────────────

describe("7. an LP conversation is declared confidential where the router reads it", () => {
  it("both run_ai calls derive `confidential` from the meeting type, not from a prompt", () => {
    for (const file of ["meetingAfter.ts", "meetingBrief.ts"]) {
      const src = readFileSync(new URL(`../src/worker/services/${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, `${file} does not declare LP content confidential at the boundary`).toMatch(/confidential:\s*meeting\.meeting_type === "LP"/);
      // And the meeting's own label is never lowered on the way in.
      expect(src).toMatch(/sensitivity:\s*meeting\.privacy_label/);
    }
  });
});
