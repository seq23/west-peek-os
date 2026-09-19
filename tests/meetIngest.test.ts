import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { calendarItem, makeFakeGoogle, type FakeConference, type FakeGoogle } from "./helpers/fakeGoogle";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runCalendarSync } from "../src/worker/services/calendarSync";
import { runMeetIngest, PLATFORM_CONSENT_BASIS } from "../src/worker/services/meetIngest";
import { turnsFromMeet, meetTranscriptText } from "../src/shared/meetings/meetTranscript";
import { classifyContent } from "../src/shared/ai/contentClass";

/**
 * Phase Meet, tier 2 — a Meet call that ended is read exactly once.
 *
 * Rules under test: the firm-level recording default is a reserved, receipt-gated decision and
 * without it the ingest is REFUSED as a row; with it, an ended conference becomes one ingest —
 * participants, speaker-attributed turns, unattributed turns kept as such, consent recorded on the
 * platform's announcement, pointers to Drive, meeting HELD; an LP meeting's notes carry LP_PRIVATE
 * and are refused a training lane; running again reads nothing twice; a conference heard about by
 * Pub/Sub and by polling is one inbox row; a missing delegation grant is a named ledger state.
 */

let t: TestDb;
let env: Env;
let g: FakeGoogle;
const NOW = new Date("2026-09-18T12:00:00.000Z");
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: { ...MP, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: (await res.json()) as T };
}

async function approvedReceipt(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", "POST", { action_key: actionKey, object_type: objectType, object_id: objectId, title: `meet: ${actionKey}`, submit: true });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

const LP_CONF: FakeConference = {
  name: "conferenceRecords/lp1", space: "spaces/sp_lp", meetingCode: "ddd-eeee-fff",
  startTime: "2026-09-17T16:00:00.000Z", endTime: "2026-09-17T16:40:00.000Z",
  participants: [
    { name: "conferenceRecords/lp1/participants/p1", displayName: "Sequoia Taylor", kind: "SIGNED_IN" },
    { name: "conferenceRecords/lp1/participants/p2", displayName: "Olive Oak", kind: "SIGNED_IN" },
  ],
  transcript: {
    name: "conferenceRecords/lp1/transcripts/t1", state: "FILE_GENERATED", document: "doc_lp1",
    entries: [
      { participant: "conferenceRecords/lp1/participants/p1", text: "Thanks for making time.", startTime: "2026-09-17T16:00:05.000Z" },
      { participant: "conferenceRecords/lp1/participants/p1", text: "We wanted to walk you through the fund.", startTime: "2026-09-17T16:00:09.000Z" },
      { participant: "conferenceRecords/lp1/participants/p2", text: "Happy to. What is the commitment amount you are asking for?", startTime: "2026-09-17T16:00:20.000Z" },
      { participant: null, text: "Can everyone hear me?", startTime: "2026-09-17T16:00:30.000Z" },
      { participant: "conferenceRecords/lp1/participants/p9", text: "I think so.", startTime: "2026-09-17T16:00:33.000Z" },
    ],
  },
  recording: { state: "FILE_GENERATED", file: "drive_file_lp1" },
};

const INTERNAL_CONF: FakeConference = {
  name: "conferenceRecords/int1", space: "spaces/sp_int", meetingCode: "aaa-bbbb-ccc",
  startTime: "2026-09-17T15:00:00.000Z", endTime: "2026-09-17T15:25:00.000Z",
  participants: [{ name: "conferenceRecords/int1/participants/p1", displayName: "Sequoia Taylor", kind: "SIGNED_IN" }, { name: "conferenceRecords/int1/participants/p2", displayName: "Scooter Taylor", kind: "SIGNED_IN" }],
  transcript: { name: "conferenceRecords/int1/transcripts/t1", state: "FILE_GENERATED", document: "doc_int1", entries: [{ participant: "conferenceRecords/int1/participants/p2", text: "Let's go through the week.", startTime: "2026-09-17T15:00:02.000Z" }] },
  recording: null,
};

beforeAll(async () => {
  t = await createTestDb();
  g = makeFakeGoogle();
  env = makeTestEnv(t.db, {
    WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: g.serviceAccountJson,
    WP_OS_MEET_PUBSUB_TOPIC: "projects/p/topics/meet-events",
    WP_OS_MEET_PUBSUB_SUBSCRIPTION: "projects/p/subscriptions/meet-events-wpos",
  });
  await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, created_by) VALUES ('lp_oak','Oak Family Office','FAMILY_OFFICE','fu_scooter_taylor')").run();
  await env.WP_OS_DB.prepare("INSERT INTO person (id, full_name, email, organization) VALUES ('per_oak','Olive Oak','olive@oakfo.com','Oak Family Office')").run();
  g.calendarItems = [
    calendarItem({ id: "ev_internal", summary: "Partners sync", start: "2026-09-17T15:00:00.000Z", code: "aaa-bbbb-ccc", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "scooter@westpeek.ventures" }] }),
    calendarItem({ id: "ev_lp", summary: "Oak catch-up", start: "2026-09-17T16:00:00.000Z", code: "ddd-eeee-fff", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "olive@oakfo.com", displayName: "Olive Oak" }] }),
  ];
  await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW });
  g.conferences = [LP_CONF, INTERNAL_CONF];
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("turns from Meet", () => {
  it("attributes by participant resource, merges consecutive entries, and keeps the unattributable unattributed", () => {
    const out = turnsFromMeet(
      LP_CONF.transcript!.entries.map((e, i) => ({ name: `e${i}`, participant: e.participant, text: e.text, languageCode: "en", startTime: e.startTime, endTime: null })),
      LP_CONF.participants.map((p) => ({ name: p.name, displayName: p.displayName, kind: p.kind, userResource: null, earliestStartTime: null, latestEndTime: null })),
    );
    expect(out.turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Sequoia Taylor", "Thanks for making time. We wanted to walk you through the fund."],
      ["Olive Oak", "Happy to. What is the commitment amount you are asking for?"],
      [null, "Can everyone hear me?"],
      [null, "I think so."],
    ]);
    expect(out.unattributed).toBe(2);
    expect(out.speakers).toEqual(["Sequoia Taylor", "Olive Oak"]);
    expect(meetTranscriptText(out.turns)).toContain("Speaker not named in the export [16:00:30]: Can everyone hear me?");
  });
});

describe("the firm recording default", () => {
  it("refuses the ingest, as a REFUSED row, while the firm default is off — and says which door opens it", async () => {
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(out.heard.subscription).toEqual({ state: "ACTIVE", detail: "2/2 space(s) subscribed" });
    const spaces = (await env.WP_OS_DB.prepare("SELECT meeting_code, space_name, state, detail FROM meet_space_subscription ORDER BY meeting_code").all<any>()).results;
    expect(spaces).toEqual([
      { meeting_code: "aaa-bbbb-ccc", space_name: "spaces/sp_int", state: "ACTIVE", detail: "created" },
      { meeting_code: "ddd-eeee-fff", space_name: "spaces/sp_lp", state: "ACTIVE", detail: "created" },
    ]);
    expect(g.subscriptions.map((s) => s.targetResource).sort()).toEqual(["//meet.googleapis.com/spaces/sp_int", "//meet.googleapis.com/spaces/sp_lp"]);
    expect(out.heard.poll.inserted).toBe(2);
    expect(out.read.map((r) => r.state)).toEqual(["REFUSED", "REFUSED"]);
    expect(out.read[0]!.detail).toContain("POST /api/meet/recording-policy");
    const refused = (await env.WP_OS_DB.prepare("SELECT status, refusal_reason, provider_name, source FROM transcript_import ORDER BY created_at").all<any>()).results;
    expect(refused).toHaveLength(2);
    expect(refused[0]).toEqual({ status: "REFUSED", refusal_reason: "recording_policy_not_activated", provider_name: "GOOGLE_MEET", source: "PROVIDER" });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting_note").first<any>())!.n).toBe(0);
    // No consent was recorded either: the policy gate comes first, and consent is not written for a call nothing may read.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record").first<any>())!.n).toBe(0);
  });

  it("is reserved: no receipt is approval_required, and a receipt for the wrong object is refused", async () => {
    const bare = await call("/api/meet/recording-policy", "POST", { action: "activate" });
    expect(bare.status).toBe(409);
    expect(bare.body.error).toBe("approval_required");
    const wrong = await approvedReceipt("meet.recording_policy.firm_default", "meet_recording_policy", "some-other-firm");
    const refused = await call("/api/meet/recording-policy", "POST", { action: "activate", approval_receipt_id: wrong });
    expect(refused.status).toBe(409);
    expect((await env.WP_OS_DB.prepare("SELECT active FROM meet_recording_policy WHERE firm_scope = 'west-peek'").first<any>())).toBeNull();
  });

  it("turns on with an approved receipt, once, and the receipt cannot be replayed", async () => {
    const receipt = await approvedReceipt("meet.recording_policy.firm_default", "meet_recording_policy", "west-peek");
    const on = await call("/api/meet/recording-policy", "POST", { action: "activate", approval_receipt_id: receipt, note: "owner approved 18 Sep 2026" });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ firm_scope: "west-peek", active: 1, receipt_id: receipt, activated_by: "fu_scooter_taylor" });
    const replay = await call("/api/meet/recording-policy", "POST", { action: "activate", approval_receipt_id: receipt });
    expect(replay.status).toBe(409);
  });
});

describe("reading an ended call", () => {
  it("ingests each conference exactly once: turns, participants, consent on the platform's announcement, pointers, HELD", async () => {
    // The refused rows are retried on the next tick; nothing needs to be re-heard.
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.read.map((r) => r.state)).toEqual(["INGESTED", "INGESTED"]);
    const lp = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE google_event_id = 'ev_lp'").first<any>();
    expect(lp).toMatchObject({ status: "HELD", occurred_at: "2026-09-17T16:00:00.000Z", recording_enabled: 1, recording_ref: "drive_file_lp1", transcript_ref: "doc_lp1", privacy_label: "LP_PRIVATE" });
    const policy = await env.WP_OS_DB.prepare("SELECT receipt_id FROM meet_recording_policy WHERE firm_scope = 'west-peek'").first<any>();
    expect(lp.recording_policy_receipt_id).toBe(policy.receipt_id);

    const consent = (await env.WP_OS_DB.prepare("SELECT consent_type, state, basis, granted_by, recorded_by FROM consent_record WHERE meeting_id = ?1 ORDER BY consent_type").bind(lp.id).all<any>()).results;
    expect(consent.map((c) => [c.consent_type, c.state, c.recorded_by])).toEqual([["RECORDING", "GRANTED", "system"], ["TRANSCRIPTION", "GRANTED", "system"]]);
    for (const c of consent) expect(c.basis.startsWith(`${PLATFORM_CONSENT_BASIS}:`)).toBe(true);

    const imports = (await env.WP_OS_DB.prepare("SELECT status, provider_name FROM transcript_import WHERE meeting_id = ?1 AND status = 'IMPORTED'").bind(lp.id).all<any>()).results;
    expect(imports).toEqual([{ status: "IMPORTED", provider_name: "GOOGLE_MEET" }]);

    const notes = (await env.WP_OS_DB.prepare("SELECT body, note_type, privacy_label FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at, id").bind(lp.id).all<any>()).results;
    expect(notes).toHaveLength(4);
    expect(notes.every((n) => n.note_type === "TRANSCRIPT_DERIVED" && n.privacy_label === "LP_PRIVATE")).toBe(true);
    expect(notes.map((n) => n.body)).toEqual([
      "Sequoia Taylor [16:00:05]: Thanks for making time. We wanted to walk you through the fund.",
      "Olive Oak [16:00:20]: Happy to. What is the commitment amount you are asking for?",
      "Speaker not named in the export [16:00:30]: Can everyone hear me?",
      "Speaker not named in the export [16:00:33]: I think so.",
    ]);

    const participants = (await env.WP_OS_DB.prepare("SELECT display_name FROM meeting_participant WHERE meeting_id = ?1 ORDER BY display_name").bind(lp.id).all<any>()).results.map((p) => p.display_name);
    // Two from the calendar (the partner by her firm name, the guest by the invitation's display
    // name), none duplicated by Meet — the join is by name, and both names were already there.
    expect(participants).toEqual(["Olive Oak", "Sequoia Taylor"]);

    const inbox = (await env.WP_OS_DB.prepare("SELECT conference_record, state, delivered_via, turns, unattributed_turns, transcript_import_id FROM meet_event_inbox ORDER BY conference_record").all<any>()).results;
    expect(inbox.map((r) => [r.conference_record, r.state, r.delivered_via, r.turns, r.unattributed_turns])).toEqual([
      ["conferenceRecords/int1", "INGESTED", "poll", 1, 0],
      ["conferenceRecords/lp1", "INGESTED", "poll", 4, 2],
    ]);
    expect(inbox.every((r) => r.transcript_import_id)).toBe(true);
  });

  it("routes an LP meeting's words to the private content class — the router's data policy, not a prompt, refuses a training lane", async () => {
    const lp = await env.WP_OS_DB.prepare("SELECT privacy_label FROM meeting WHERE google_event_id = 'ev_lp'").first<any>();
    expect(lp.privacy_label).toBe("LP_PRIVATE");
    // Every note derived from the transcript carries the meeting's label, so a run over them is
    // labelled LP_PRIVATE — and the egress gate (`dataPolicyAllows`, default-deny) admits that
    // label on NO provider whose terms permit training. Checked against the real catalogue, and
    // it must examine at least one training-permitting lane to mean anything.
    const training = (await env.WP_OS_DB.prepare("SELECT id FROM provider_registry WHERE training_permitted = 1").all<any>()).results;
    expect(training.length).toBeGreaterThan(0);
    const leaks = (await env.WP_OS_DB.prepare(
      "SELECT pdp.provider_id FROM provider_data_policy pdp JOIN provider_registry p ON p.id = pdp.provider_id WHERE p.training_permitted = 1 AND pdp.privacy_label = 'LP_PRIVATE' AND pdp.allowed = 1",
    ).all<any>()).results;
    expect(leaks).toEqual([]);
    // The content class agrees when the words themselves carry an LP marker, whatever the machine.
    const note = await env.WP_OS_DB.prepare("SELECT body FROM meeting_note WHERE meeting_id = (SELECT id FROM meeting WHERE google_event_id = 'ev_lp') AND body LIKE '%commitment amount%'").first<any>();
    expect(classifyContent({ sensitivity: lp.privacy_label, machineKey: "west_peek_live_events", inputs: [note.body] }).publicModelApproved).toBe(false);
  });

  it("reads nothing twice: a second tick, and a Pub/Sub message about a conference already read, add no rows", async () => {
    g.pubsubMessages.push({ ackId: "ack1", messageId: "m1", attributes: { "ce-type": "google.workspace.meet.transcript.v2.fileGenerated", "ce-subject": "//meet.googleapis.com/conferenceRecords/lp1/transcripts/t1" }, data: { transcript: { name: "conferenceRecords/lp1/transcripts/t1" } } });
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(out.ok).toBe(true);
    expect(out.heard.pubsub).toMatchObject({ pulled: 1, inserted: 0 });
    expect(g.acked).toEqual(["ack1"]);
    expect(out.read).toEqual([]);
    expect(out.summary).toMatch(/^nothing to read/);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_event_inbox").first<any>())!.n).toBe(2);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM transcript_import WHERE status = 'IMPORTED'").first<any>())!.n).toBe(2);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting_note").first<any>())!.n).toBe(5);
  });

  it("hears about a new conference from Pub/Sub, matches it to its meeting by space, and waits (RECEIVED) while the transcript is not yet a file", async () => {
    g.calendarItems.push(calendarItem({ id: "ev_second", summary: "Partners sync", start: "2026-09-18T11:00:00.000Z", code: "aaa-bbbb-ccc", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "scooter@westpeek.ventures" }] }));
    await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW });
    g.conferences.push({ ...INTERNAL_CONF, name: "conferenceRecords/int2", startTime: "2026-09-18T11:01:00.000Z", endTime: "2026-09-18T11:30:00.000Z", transcript: { name: "conferenceRecords/int2/transcripts/t1", state: "ENDED", document: null, entries: [] }, recording: null });
    g.pubsubMessages.push({ ackId: "ack2", messageId: "m2", attributes: { "ce-type": "google.workspace.meet.conference.v2.ended", "ce-subject": "//meet.googleapis.com/conferenceRecords/int2" }, data: { conferenceRecord: { name: "conferenceRecords/int2" } } });
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(out.heard.pubsub).toMatchObject({ pulled: 1, inserted: 1 });
    expect(out.read).toEqual([{ conference_record: "conferenceRecords/int2", state: "RECEIVED", detail: "transcript ENDED; not yet a file" }]);
    const row = await env.WP_OS_DB.prepare("SELECT meeting_id, delivered_via, state FROM meet_event_inbox WHERE conference_record = 'conferenceRecords/int2'").first<any>();
    const second = await env.WP_OS_DB.prepare("SELECT id FROM meeting WHERE google_event_id = 'ev_second'").first<any>();
    expect(row).toEqual({ meeting_id: second.id, delivered_via: "pubsub", state: "RECEIVED" });
    // The file lands; the next tick reads it.
    g.conferences[2]!.transcript = { name: "conferenceRecords/int2/transcripts/t1", state: "FILE_GENERATED", document: "doc_int2", entries: [{ participant: "conferenceRecords/int1/participants/p1", text: "Second sync.", startTime: "2026-09-18T11:01:05.000Z" }] };
    const next = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(next.read).toEqual([{ conference_record: "conferenceRecords/int2", state: "INGESTED", detail: "1 turn(s); 2 participant(s)" }]);
  });

  it("names a missing delegation grant on the ledger and keeps polling, rather than dying", async () => {
    g.grantedScopes.delete("https://www.googleapis.com/auth/meetings.space.created");
    // Force a renewal so the grant is actually consulted: an ACTIVE row with a week to run would be left alone.
    await env.WP_OS_DB.prepare("UPDATE meet_space_subscription SET expires_at = ?1").bind(new Date(NOW.getTime() + 3_600_000).toISOString()).run();
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(out.heard.subscription.state).toBe("SCOPE_MISSING");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_space_subscription WHERE state = 'SCOPE_MISSING'").first<any>())!.n).toBe(2);
    expect(out.heard.subscription.detail).toContain("meetings.space.created");
    const ledger = await env.WP_OS_DB.prepare("SELECT subscription_state FROM google_calendar_sync WHERE calendar_key = 'westpeek'").first<any>();
    expect(ledger.subscription_state).toBe("SCOPE_MISSING");
    expect(out.summary).toContain("events scope_missing");
    g.grantedScopes.add("https://www.googleapis.com/auth/meetings.space.created");
    // The grant lands; the next tick clears the state on its own.
    const back = await runMeetIngest(env, { fetchImpl: g.fetch, now: NOW });
    expect(back.heard.subscription.state).toBe("ACTIVE");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_space_subscription WHERE state = 'ACTIVE'").first<any>())!.n).toBe(2);
  });

  it("is reachable as a job and reports on /api/meet/status", async () => {
    const job = await env.WP_OS_DB.prepare("SELECT id, job_key, schedule_kind, interval_minutes FROM scheduled_job WHERE id = 'sjb_meet_ingest'").first<any>();
    expect(job).toEqual({ id: "sjb_meet_ingest", job_key: "meet_ingest", schedule_kind: "INTERVAL", interval_minutes: 60 });
    const status = await call<any>("/api/meet/status");
    expect(status.status).toBe(200);
    expect(status.body.recording_policy.active).toBe(1);
    expect(status.body.inbox).toEqual({ INGESTED: 3 });
    expect(status.body.calendars[0].subscription_state).toBe("ACTIVE");
  });

  it("never records platform consent for a meeting that was typed in by hand", async () => {
    const { recordPlatformAnnouncedConsent } = await import("../src/worker/services/meetIngest");
    await env.WP_OS_DB.prepare("INSERT INTO meeting (id, title, meeting_type, status, privacy_label, firm_scope, created_by) VALUES ('mtg_hand','Typed in','FOUNDER','SCHEDULED','INTERNAL','west-peek','fu_scooter_taylor')").run();
    const meeting = (await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = 'mtg_hand'").first<any>())!;
    await expect(recordPlatformAnnouncedConsent(env, { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] }, meeting, "conferenceRecords/x")).rejects.toMatchObject({ code: "not_firm_hosted" });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = 'mtg_hand'").first<any>())!.n).toBe(0);
  });
});
