import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { calendarItem, makeFakeGoogle, type FakeConference, type FakeGoogle } from "./helpers/fakeGoogle";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runCalendarSync } from "../src/worker/services/calendarSync";
import { runMeetIngest, PLATFORM_CONSENT_BASIS } from "../src/worker/services/meetIngest";
import { liveChunk, stateForJoinFailure, costPerHour, LIVE_PROVIDER, MEET_LIVE_STATES, LISTENER_STALE_MS } from "../src/worker/services/meetLive";
import { meetLiveView, liveAllowedForType } from "../src/worker/services/meetLiveView";
import { roomState, buildRoomContext, ROLL_EVERY_MS } from "../src/worker/services/meetingRoom";
import { draftInputFor } from "../src/worker/services/meetingAfter";
import { SCOPE, serviceAccountToken, getSpace, connectActiveConference } from "../src/worker/effects/googleWorkspaceClient";
import { resolveFirmUser } from "../src/worker/auth";
// The listener's decision loop, exactly as the Mac runs it, against the fake Meet media server.
import { createListener, SCOPES } from "../scripts/meet/lib/listener-core.mjs";

/**
 * Phase Meet, tier 4 — the room hears the Meet LIVE.
 *
 * Rules under test: the live path opens only for a calendar-synced meeting with a Meet conference,
 * only under the firm recording default, with platform-announced consent recorded first; a manual
 * meeting has no live path at all; every slice goes through the governed import and becomes
 * TRANSCRIPT_DERIVED notes the room's context and the After draft read; an LP meeting's live notes
 * carry LP_PRIVATE; every outcome is a named state on the meeting row (scope missing, preview
 * missing, edition refused, no listener, ended); the official transcript supersedes the live
 * notes and consent is not recorded twice; the listener's whole loop runs end to end against a
 * fake Meet media server and never sends audio anywhere but the Worker.
 */

let t: TestDb;
let env: Env;
let g: FakeGoogle;
// Real time, because the heartbeat's window and the listener's staleness are read off the clock.
const NOW = new Date();
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const TODAY_START = iso(-5 * 60_000);
const TOMORROW_START = iso(24 * 3_600_000);
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const LISTENER = { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com" };

const NOVA = {
  run: async (model: string, input: Record<string, unknown>) => {
    if (!model.includes("nova-3")) return { text: "words only" };
    const audio = (input.audio as { body: Uint8Array }).body;
    // The fixture slice says which words it carries, so a test can follow a sentence to a note.
    const said = new TextDecoder().decode(audio);
    // Two speakers: the second takes over at the first "and" / "with", so a sentence can be followed to its turns.
    let speaker = 0;
    const words = said.split(" ").map((w) => { if (w === "and" || w === "with") speaker = 1; return { punctuated_word: w, speaker }; });
    return { results: { channels: [{ alternatives: [{ transcript: said, words }] }] }, usage: { neurons: Math.round(said.length * 1.5) } };
  },
};

async function call<T = any>(path: string, method = "GET", body?: unknown, headers: Record<string, string> = MP): Promise<{ status: number; body: T }> {
  const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: (await res.json()) as T };
}

const slice = (text: string, seq: number, seconds = 60) => ({ audio_base64: Buffer.from(text).toString("base64"), sequence: seq, content_type: "audio/webm;codecs=opus", seconds });

async function approvedReceipt(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await call<{ id: string }>("/api/approvals", "POST", { action_key: actionKey, object_type: objectType, object_id: objectId, title: `meet: ${actionKey}`, submit: true });
  expect(created.status).toBe(201);
  const decided = await call(`/api/approvals/${created.body.id}/decide`, "POST", { decision: "approved" });
  expect(decided.status).toBe(200);
  return created.body.id;
}

let lpMeeting: any;
let internalMeeting: any;
let founderMeeting: any;
let manualMeeting: any;

beforeAll(async () => {
  t = await createTestDb();
  g = makeFakeGoogle();
  env = makeTestEnv(t.db, { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: g.serviceAccountJson, AI: NOVA });
  await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, created_by) VALUES ('lp_oak','Oak Family Office','FAMILY_OFFICE','fu_scooter_taylor')").run();
  await env.WP_OS_DB.prepare("INSERT INTO person (id, full_name, email, organization) VALUES ('per_oak','Olive Oak','olive@oakfo.com','Oak Family Office')").run();
  g.calendarItems = [
    calendarItem({ id: "ev_lp", summary: "Oak catch-up", start: TODAY_START, code: "ddd-eeee-fff", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "olive@oakfo.com", displayName: "Olive Oak" }] }),
    calendarItem({ id: "ev_internal", summary: "Partners sync", start: TODAY_START, code: "aaa-bbbb-ccc", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "scooter@westpeek.ventures" }] }),
    calendarItem({ id: "ev_founder", summary: "Acme intro", start: TODAY_START, code: "bbb-cccc-ddd", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "founder@acme.example", displayName: "Ada Acme" }] }),
    calendarItem({ id: "ev_tomorrow", summary: "Tomorrow", start: TOMORROW_START, code: "ggg-hhhh-iii", attendees: [{ email: "sequoia@westpeek.ventures", self: true }] }),
  ];
  await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW });
  lpMeeting = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE google_event_id = 'ev_lp'").first<any>();
  internalMeeting = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE google_event_id = 'ev_internal'").first<any>();
  founderMeeting = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE google_event_id = 'ev_founder'").first<any>();
  expect([lpMeeting.meeting_type, internalMeeting.meeting_type, founderMeeting.meeting_type]).toEqual(["LP", "INTERNAL", "FOUNDER"]);
  const manual = await call<{ id: string }>("/api/meetings", "POST", { title: "Typed in by hand", meeting_type: "FOUNDER", scheduled_at: NOW.toISOString() });
  expect(manual.status).toBe(201);
  manualMeeting = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(manual.body.id).first<any>();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("1. the states are one vocabulary", () => {
  it("names every state the migration's CHECK admits, and maps a failed join to the one the During face needs", async () => {
    const sql = (await env.WP_OS_DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meeting'").first<{ sql: string }>())!.sql;
    for (const s of MEET_LIVE_STATES) expect(sql, `${s} must be in the CHECK`).toContain(`'${s}'`);
    expect(MEET_LIVE_STATES).toHaveLength(11);
    expect(liveAllowedForType("LP")).toBe(false);
    expect(liveAllowedForType("BROKER")).toBe(false);
    for (const t of ["INTERNAL", "FOUNDER", "DILIGENCE", "PORTFOLIO", "OTHER"]) expect(liveAllowedForType(t), t).toBe(true);
    expect(stateForJoinFailure("scope_missing")).toBe("meet_live_unavailable_scope");
    expect(stateForJoinFailure("preview_missing")).toBe("meet_live_unavailable_preview");
    expect(stateForJoinFailure("forbidden")).toBe("meet_live_unavailable_edition");
    expect(stateForJoinFailure("unauthorised")).toBe("meet_live_unavailable_edition");
    expect(stateForJoinFailure("timeout")).toBe("meet_live_failed");
    expect(stateForJoinFailure(undefined)).toBe("meet_live_failed");
    // A manual meeting: the live path does not apply and the view says so with a NULL state.
    const view = await meetLiveView(env, manualMeeting, NOW);
    expect(view).toMatchObject({ state: null, applicable: false, session: null, live_turns: 0 });
  });
});

describe("2. the heartbeat: who may, and what is due", () => {
  it("refuses a partner and a nobody; accepts the listener; lists only calendar Meets in their window and marks them not started", async () => {
    const partner = await call("/api/meet/live/heartbeat", "POST", { device_id: "mac-test" });
    expect(partner.status).toBe(403);
    const nobody = await handleRequest(new Request("https://test.local/api/meet/live/heartbeat", { method: "POST", body: "{}" }), env);
    expect(nobody.status).toBe(401);
    const hb = await call("/api/meet/live/heartbeat", "POST", { device_id: "mac-test", version: "meet-live-1", media_scope: "SCOPE_MISSING", detail: "grant missing" }, LISTENER);
    expect(hb.status).toBe(200);
    // Today's three Meets, not tomorrow's, never the manual one.
    const ids = hb.body.due.map((d: any) => d.meeting_id).sort();
    expect(ids).toEqual([internalMeeting.id, lpMeeting.id, founderMeeting.id].sort());
    expect(hb.body.due.find((d: any) => d.meeting_id === internalMeeting.id)).toMatchObject({ meeting_code: "aaa-bbbb-ccc", confidential: false, policy_active: false, meet_live_state: "meet_not_started", live_allowed: true, session: null });
    // THE OWNER'S RULE: an LP meeting is offered with live_allowed=false and already says why on the row.
    expect(hb.body.due.find((d: any) => d.meeting_id === lpMeeting.id)).toMatchObject({ meeting_code: "ddd-eeee-fff", confidential: true, meet_live_state: "meet_live_off_lp_policy", live_allowed: false, session: null });
    expect(hb.body.listener).toMatchObject({ device_id: "mac-test", media_scope: "SCOPE_MISSING", detail: "grant missing" });
    const row = await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(manualMeeting.id).first<any>();
    expect(row.meet_live_state).toBeNull();
    expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>()).meet_live_state).toBe("meet_not_started");
    const lp = await env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail FROM meeting WHERE id = ?1").bind(lpMeeting.id).first<any>();
    expect(lp.meet_live_state).toBe("meet_live_off_lp_policy");
    expect(lp.meet_live_detail).toContain("off for LP and Broker meetings by policy");
  });
});

describe("3. opening a session: the gates, in order", () => {
  it("refuses a manual meeting by name and leaves its state NULL", async () => {
    const r = await call("/api/meet/live/sessions", "POST", { meeting_id: manualMeeting.id, conference_record: "conferenceRecords/x1", listener_device: "mac-test" }, LISTENER);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_firm_hosted");
    expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(manualMeeting.id).first<any>()).meet_live_state).toBeNull();
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_live_session").first<any>()).n).toBe(0);
  });

  it("refuses an LP meeting by the owner's rule — no session, no consent, the row says why — and a Broker meeting the same", async () => {
    const r = await call("/api/meet/live/sessions", "POST", { meeting_id: lpMeeting.id, conference_record: "conferenceRecords/lp_never", listener_device: "mac-test" }, LISTENER);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lp_policy", meet_live_state: "meet_live_off_lp_policy" });
    expect(r.body.detail).toContain("Pre-GA");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_live_session WHERE meeting_id = ?1").bind(lpMeeting.id).first<any>()).n).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1").bind(lpMeeting.id).first<any>()).n).toBe(0);
    const broker = await call<{ id: string }>("/api/meetings", "POST", { title: "Broker call", meeting_type: "BROKER", scheduled_at: NOW.toISOString() });
    await env.WP_OS_DB.prepare("UPDATE meeting SET source = 'google_calendar', meet_conference_id = 'brk-brkr-brk', calendar_key = 'westpeek' WHERE id = ?1").bind(broker.body.id).run();
    const b = await call("/api/meet/live/sessions", "POST", { meeting_id: broker.body.id, conference_record: "conferenceRecords/brk_never", listener_device: "mac-test" }, LISTENER);
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("lp_policy");
    expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(broker.body.id).first<any>()).meet_live_state).toBe("meet_live_off_lp_policy");
  });

  it("refuses while the firm default is off — the meeting reads meet_live_unavailable_policy and no consent is written", async () => {
    const r = await call("/api/meet/live/sessions", "POST", { meeting_id: internalMeeting.id, conference_record: "conferenceRecords/int_live", listener_device: "mac-test" }, LISTENER);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "recording_policy_off", meet_live_state: "meet_live_unavailable_policy" });
    const m = await env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>();
    expect(m.meet_live_state).toBe("meet_live_unavailable_policy");
    expect(m.meet_live_detail).toContain("meet.recording_policy.firm_default");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record").first<any>()).n).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT state FROM meet_live_session WHERE conference_record = 'conferenceRecords/int_live'").first<any>()).state).toBe("REFUSED");
  });

  it("a partner may not open one, even with the default on; an LP meeting is still refused with the default on", async () => {
    const receipt = await approvedReceipt("meet.recording_policy.firm_default", "meet_recording_policy", "west-peek");
    const on = await call("/api/meet/recording-policy", "POST", { action: "activate", approval_receipt_id: receipt });
    expect(on.status).toBe(200);
    const r = await call("/api/meet/live/sessions", "POST", { meeting_id: internalMeeting.id, conference_record: "conferenceRecords/int_live", listener_device: "mac-test" });
    expect(r.status).toBe(403);
    const lp = await call("/api/meet/live/sessions", "POST", { meeting_id: lpMeeting.id, conference_record: "conferenceRecords/lp_never", listener_device: "mac-test" }, LISTENER);
    expect(lp.status).toBe(409);
    expect(lp.body.error).toBe("lp_policy");
  });

  it("opens with the default on: consent on the platform's announcement, recording enabled from the firm receipt, state joining — and a second open is the same session", async () => {
    const r = await call("/api/meet/live/sessions", "POST", { meeting_id: internalMeeting.id, conference_record: "conferenceRecords/int_live", listener_device: "mac-test", join_identity: "sequoia@westpeek.ventures" }, LISTENER);
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(true);
    expect(r.body.session).toMatchObject({ meeting_id: internalMeeting.id, meeting_code: "aaa-bbbb-ccc", state: "JOINING", listener_device: "mac-test", join_identity: "sequoia@westpeek.ventures", chunks: 0, turns: 0 });
    const m = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>();
    const policy = await env.WP_OS_DB.prepare("SELECT receipt_id FROM meet_recording_policy WHERE firm_scope = 'west-peek'").first<any>();
    expect(m).toMatchObject({ meet_live_state: "meet_live_joining", recording_enabled: 1, recording_policy_receipt_id: policy.receipt_id });
    const consent = (await env.WP_OS_DB.prepare("SELECT id, consent_type, state, basis, recorded_by FROM consent_record WHERE meeting_id = ?1 ORDER BY consent_type").bind(internalMeeting.id).all<any>()).results;
    expect(consent.map((c: any) => [c.consent_type, c.state, c.recorded_by])).toEqual([["RECORDING", "GRANTED", "system"], ["TRANSCRIPTION", "GRANTED", "system"]]);
    for (const c of consent) expect(c.basis).toContain(`${PLATFORM_CONSENT_BASIS}:`);
    expect(r.body.session.consent_recording_id).toBe(consent[0].id);
    expect(r.body.session.consent_transcription_id).toBe(consent[1].id);
    const again = await call("/api/meet/live/sessions", "POST", { meeting_id: internalMeeting.id, conference_record: "conferenceRecords/int_live", listener_device: "mac-test" }, LISTENER);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.session.id).toBe(r.body.session.id);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1").bind(internalMeeting.id).first<any>()).n).toBe(2);
  });
});

describe("4. a slice of the call becomes the room's record", () => {
  let sessionId: string;
  beforeAll(async () => {
    sessionId = (await env.WP_OS_DB.prepare("SELECT id FROM meet_live_session WHERE conference_record = 'conferenceRecords/int_live'").first<any>()).id;
  });

  it("a partner may not post audio; the listener's slice goes through Nova-3 and the governed import into TRANSCRIPT_DERIVED notes carrying the meeting's own label", async () => {
    const partner = await call(`/api/meet/live/sessions/${sessionId}/chunk`, "POST", slice("no", 0));
    expect(partner.status).toBe(403);
    const r = await call(`/api/meet/live/sessions/${sessionId}/chunk`, "POST", slice("We agreed to send the term sheet by Friday and the founder said runway is fourteen months", 0), LISTENER);
    expect(r.status).toBe(201);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ sequence: 0, engine: "NOVA3", turns_written: 2 });
    expect(r.body.speakers).toEqual([0, 1]);
    expect(r.body.neurons).toBeGreaterThan(0);
    expect(r.body.session).toMatchObject({ state: "LISTENING", chunks: 1, turns: 2, seconds_heard: 60 });
    const imp = (await env.WP_OS_DB.prepare("SELECT status, provider_name, source, imported_by, superseded_by FROM transcript_import WHERE meeting_id = ?1").bind(internalMeeting.id).all<any>()).results;
    expect(imp).toEqual([{ status: "IMPORTED", provider_name: LIVE_PROVIDER, source: "NATIVE", imported_by: "system", superseded_by: null }]);
    const notes = (await env.WP_OS_DB.prepare("SELECT body, note_type, privacy_label FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at, id").bind(internalMeeting.id).all<any>()).results;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ note_type: "TRANSCRIPT_DERIVED", privacy_label: internalMeeting.privacy_label });
    expect(notes[0].body).toBe("Speaker 1: We agreed to send the term sheet by Friday");
    expect(notes[1].body).toBe("Speaker 2: and the founder said runway is fourteen months");
    expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>()).meet_live_state).toBe("meet_live_listening");
  });

  it("a silent slice writes nothing and is not a failure; a slice after the session ends is refused", async () => {
    const r = await call(`/api/meet/live/sessions/${sessionId}/chunk`, "POST", slice(" ", 1), LISTENER);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ text: "", turns_written: 0 });
    expect(r.body.session.chunks).toBe(2);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?1").bind(internalMeeting.id).first<any>()).n).toBe(2);
  });

  it("the During face reads it: the room's state says listening with the live turns, and the context pack carries what was just said", async () => {
    const identity = (await resolveFirmUser(new Request("https://test.local/", { headers: MP }), env))!;
    const room = await roomState(env, identity, internalMeeting.id);
    expect(room.meet_live).toMatchObject({ state: "meet_live_listening", applicable: true, live_turns: 2, superseded: false });
    expect(room.meet_live.session).toMatchObject({ state: "LISTENING", chunks: 2, turns: 2 });
    expect(room.meet_live.listener_seen_at).toBeTruthy();
    expect(room.capture.turns).toBe(2);
    const context = await buildRoomContext(env, { ...internalMeeting, source: "google_calendar" });
    expect(context).toContain("term sheet by Friday");
  });

  it("rolls the After draft every ROLL_EVERY_MS from the words so far — a draft, never a record", async () => {
    // The first slice with words rolled the draft (nothing had been drafted); the cadence holds from there.
    const first = await env.WP_OS_DB.prepare("SELECT drafts_rolled, last_draft_at FROM meet_live_session WHERE id = ?1").bind(sessionId).first<any>();
    expect(first.last_draft_at).toBeTruthy();
    const identity = (await resolveFirmUser(new Request("https://test.local/", { headers: LISTENER }), env))!;
    const soon = new Date(Date.parse(first.last_draft_at) + 30_000);
    const early = await liveChunk(env, identity, sessionId, slice("Olive will confirm the commitment amount next week", 2), soon);
    expect(early.turns_written).toBe(1);
    expect(early.draft_rolled).toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT last_draft_at FROM meet_live_session WHERE id = ?1").bind(sessionId).first<any>()).last_draft_at, "inside the cadence, no roll").toBe(first.last_draft_at);
    const later = new Date(Date.parse(first.last_draft_at) + ROLL_EVERY_MS + 1000);
    const out = await liveChunk(env, identity, sessionId, slice(" ", 3), later);
    expect(out.turns_written).toBe(0);
    // A silent slice rolls nothing either — only new words do.
    expect((await env.WP_OS_DB.prepare("SELECT last_draft_at FROM meet_live_session WHERE id = ?1").bind(sessionId).first<any>()).last_draft_at).toBe(first.last_draft_at);
    const out2 = await liveChunk(env, identity, sessionId, slice("One more thing before we close", 4), later);
    expect(out2.turns_written).toBe(1);
    expect((await env.WP_OS_DB.prepare("SELECT last_draft_at FROM meet_live_session WHERE id = ?1").bind(sessionId).first<any>()).last_draft_at).toBe(later.toISOString());
    const draft = await env.WP_OS_DB.prepare("SELECT state, notes_read FROM meeting_after_draft WHERE meeting_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(internalMeeting.id).first<any>();
    expect(draft, "the drafter wrote a row — a DRAFT, or a named failure when no model can be read").toBeTruthy();
    expect(["DRAFTED", "FAILED", "REFUSED"]).toContain(draft.state);
    for (const table of ["meeting_decision", "meeting_commitment", "meeting_open_question"]) {
      expect((await env.WP_OS_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE meeting_id = ?1`).bind(internalMeeting.id).first<any>()).n, `${table} untouched`).toBe(0);
    }
  });

  it("a listener gone quiet is not listening: the view says meet_live_no_listener with when it was last heard", async () => {
    const stale = new Date(Date.now() + LISTENER_STALE_MS + 60_000);
    const view = await meetLiveView(env, internalMeeting, stale);
    expect(view.state).toBe("meet_live_no_listener");
    expect(view.detail).toContain("has not been heard from since");
    const fresh = await meetLiveView(env, internalMeeting, new Date());
    expect(fresh.state).toBe("meet_live_listening");
  });

  it("the cost per hour is what the platform reported, on the session and on the status route", async () => {
    const s = await env.WP_OS_DB.prepare("SELECT seconds_heard, neurons FROM meet_live_session WHERE id = ?1").bind(sessionId).first<any>();
    expect(s.seconds_heard).toBe(300);
    expect(s.neurons).toBeGreaterThan(0);
    const c = costPerHour(s);
    expect(c.neurons_per_hour).toBe(Math.round((s.neurons / 300) * 3600));
    expect(c.usd_per_hour).toBeGreaterThan(0);
    expect(costPerHour({ seconds_heard: 0, neurons: 0 })).toEqual({ neurons_per_hour: null, usd_per_hour: null });
    const status = await call("/api/meet/live/status");
    expect(status.status).toBe(200);
    expect(status.body.listeners[0]).toMatchObject({ device_id: "mac-test" });
    expect(status.body.sessions[0]).toMatchObject({ id: sessionId, title: "Partners sync", cost: c });
    expect(status.body.states).toEqual(MEET_LIVE_STATES);
  });

  it("ending: the session ends, the meeting is HELD and reads meet_live_ended", async () => {
    const r = await call(`/api/meet/live/sessions/${sessionId}/report`, "POST", { state: "ENDED", detail: "disconnected: REASON_CONFERENCE_ENDED" }, LISTENER);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "ENDED" });
    expect(r.body.ended_at).toBeTruthy();
    const m = await env.WP_OS_DB.prepare("SELECT status, meet_live_state, meet_live_detail, call_ended_at FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>();
    expect(m.status).toBe("HELD");
    expect(m.meet_live_state).toBe("meet_live_ended");
    expect(m.meet_live_detail).toContain("4 turn(s) heard live");
    // THE END-OF-CALL SIGNAL: one column, written by whichever side learns it first.
    expect(m.call_ended_at).toBe(r.body.ended_at);
    const late = await call(`/api/meet/live/sessions/${sessionId}/chunk`, "POST", slice("too late", 9), LISTENER);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("not_listening");
  });
});

describe("5. the join fails: three named states, with Google's own words", () => {
  const open = async (record: string) => (await call("/api/meet/live/sessions", "POST", { meeting_id: founderMeeting.id, conference_record: record, listener_device: "mac-test" }, LISTENER)).body.session.id as string;
  const stateOf = async () => env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail FROM meeting WHERE id = ?1").bind(founderMeeting.id).first<any>();

  it("scope missing → meet_live_unavailable_scope; preview missing → _preview; forbidden → _edition carrying the exact message; else → failed", async () => {
    let id = await open("conferenceRecords/int_a");
    let r = await call(`/api/meet/live/sessions/${id}/report`, "POST", { state: "FAILED", google_error_code: "scope_missing", detail: "the delegation grant does not cover https://www.googleapis.com/auth/meetings.conference.media.readonly for sequoia@westpeek.ventures" }, LISTENER);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("FAILED");
    expect(r.body.detail).toContain("scope_missing:");
    expect((await stateOf()).meet_live_state).toBe("meet_live_unavailable_scope");

    id = await open("conferenceRecords/int_b");
    await call(`/api/meet/live/sessions/${id}/report`, "POST", { state: "FAILED", google_error_code: "preview_missing", detail: 'Google answers "Method not found" on meet.googleapis.com/v2beta' }, LISTENER);
    expect(await stateOf()).toMatchObject({ meet_live_state: "meet_live_unavailable_preview" });

    id = await open("conferenceRecords/int_c");
    await call(`/api/meet/live/sessions/${id}/report`, "POST", { state: "FAILED", google_error_code: "forbidden", detail: "Google refused the join: The Meet Media API is not enabled for this organization's edition." }, LISTENER);
    const edition = await stateOf();
    expect(edition.meet_live_state).toBe("meet_live_unavailable_edition");
    expect(edition.meet_live_detail).toBe("Google refused the join: The Meet Media API is not enabled for this organization's edition.");

    id = await open("conferenceRecords/int_d");
    await call(`/api/meet/live/sessions/${id}/report`, "POST", { state: "FAILED", detail: "ice failed" }, LISTENER);
    expect((await stateOf()).meet_live_state).toBe("meet_live_failed");
    // Four sessions on the meeting, all FAILED, none accepting audio.
    const sessions = (await env.WP_OS_DB.prepare("SELECT state FROM meet_live_session WHERE meeting_id = ?1").bind(founderMeeting.id).all<any>()).results;
    expect(sessions.map((s: any) => s.state)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED"]);
  });
});

describe("6. the official transcript supersedes the live notes, and consent is recorded once", () => {
  const INT_CONF: FakeConference = {
    name: "conferenceRecords/int_live", space: "spaces/sp_int", meetingCode: "aaa-bbbb-ccc",
    startTime: iso(-4 * 60_000), endTime: iso(35 * 60_000),
    participants: [
      { name: "conferenceRecords/int_live/participants/p1", displayName: "Sequoia Taylor", kind: "SIGNED_IN" },
      { name: "conferenceRecords/int_live/participants/p2", displayName: "Scooter Taylor", kind: "SIGNED_IN" },
    ],
    transcript: {
      name: "conferenceRecords/int_live/transcripts/t1", state: "FILE_GENERATED", document: "doc_int_live",
      entries: [
        { participant: "conferenceRecords/int_live/participants/p1", text: "We agreed to send the term sheet by Friday.", startTime: iso(-3 * 60_000) },
        { participant: "conferenceRecords/int_live/participants/p2", text: "Scooter will confirm the amount next week.", startTime: iso(-2 * 60_000) },
      ],
    },
    recording: null,
  };

  it("after the call, the ingest reads the official transcript, supersedes the live import, and the draft input reads only the official words", async () => {
    g.conferences = [INT_CONF];
    const before = await draftInputFor(env, internalMeeting.id);
    expect(before.notes).toBe(4);
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: new Date(NOW.getTime() + 60 * 60_000) });
    const read = out.read.find((r) => r.conference_record === "conferenceRecords/int_live")!;
    expect(read.state).toBe("INGESTED");
    // Three slices carried words, so three live imports — each slice is its own governed import.
    expect(read.detail).toContain("supersedes 3 live import(s)");
    const imports = (await env.WP_OS_DB.prepare("SELECT id, provider_name, superseded_by FROM transcript_import WHERE meeting_id = ?1 AND status = 'IMPORTED' ORDER BY created_at, rowid").bind(internalMeeting.id).all<any>()).results;
    expect(imports).toHaveLength(4);
    const official = imports[imports.length - 1];
    const lives = imports.slice(0, 3);
    expect(lives.every((i: any) => i.provider_name === LIVE_PROVIDER && i.superseded_by === official.id)).toBe(true);
    expect(official.provider_name).toBe("GOOGLE_MEET");
    expect(official.superseded_by).toBeNull();
    const live = lives[0];
    expect((await env.WP_OS_DB.prepare("SELECT official_import_id FROM meet_live_session WHERE conference_record = 'conferenceRecords/int_live'").first<any>()).official_import_id).toBe(official.id);
    // The live notes are still on the record …
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?1 AND transcript_import_id = ?2").bind(internalMeeting.id, live.id).first<any>()).n).toBe(2);
    // … and the After draft reads the official transcript only.
    const after = await draftInputFor(env, internalMeeting.id);
    expect(after.notes).toBe(2);
    expect(after.text).toContain("Scooter Taylor");
    expect(after.text).not.toContain("Speaker 1:");
    const context = await buildRoomContext(env, { ...internalMeeting, source: "google_calendar" });
    expect(context).not.toContain("Speaker 1:");
    expect(context).toContain("Scooter Taylor");
    const view = await meetLiveView(env, internalMeeting, new Date());
    expect(view).toMatchObject({ state: "meet_live_ended", live_turns: 4, superseded: true });
    // Consent was recorded when the OS joined and is not recorded again when the transcript lands.
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM consent_record WHERE meeting_id = ?1").bind(internalMeeting.id).first<any>()).n).toBe(2);
    // The end-of-call signal: the listener wrote it first, and Google's end time does not overwrite it.
    const ended = await env.WP_OS_DB.prepare("SELECT call_ended_at FROM meeting WHERE id = ?1").bind(internalMeeting.id).first<any>();
    expect(ended.call_ended_at).not.toBe(INT_CONF.endTime);
    expect(Date.parse(ended.call_ended_at)).toBeLessThan(Date.parse(INT_CONF.endTime!));
  });

  it("a call the room did not hear live still gets the signal from Google's end time when the official transcript is read", async () => {
    const LP_CONF: FakeConference = {
      name: "conferenceRecords/lp_after", space: "spaces/sp_lp", meetingCode: "ddd-eeee-fff",
      startTime: iso(-4 * 60_000), endTime: iso(30 * 60_000),
      participants: [{ name: "conferenceRecords/lp_after/participants/p1", displayName: "Sequoia Taylor", kind: "SIGNED_IN" }],
      transcript: { name: "conferenceRecords/lp_after/transcripts/t1", state: "FILE_GENERATED", document: "doc_lp_after", entries: [{ participant: "conferenceRecords/lp_after/participants/p1", text: "Thank you for the time.", startTime: iso(-3 * 60_000) }] },
      recording: null,
    };
    g.conferences = [LP_CONF];
    const out = await runMeetIngest(env, { fetchImpl: g.fetch, now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(out.read.find((r) => r.conference_record === "conferenceRecords/lp_after")?.state).toBe("INGESTED");
    const lp = await env.WP_OS_DB.prepare("SELECT call_ended_at, meet_live_state, privacy_label FROM meeting WHERE id = ?1").bind(lpMeeting.id).first<any>();
    expect(lp.call_ended_at).toBe(LP_CONF.endTime);
    // The LP meeting kept the GA path only: never joined live, notes still LP_PRIVATE, by policy.
    expect(lp.meet_live_state).toBe("meet_live_off_lp_policy");
    expect(lp.privacy_label).toBe("LP_PRIVATE");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM transcript_import WHERE meeting_id = ?1 AND provider_name = ?2").bind(lpMeeting.id, LIVE_PROVIDER).first<any>()).n).toBe(0);
  });
});

describe("7. end to end: the listener's loop against a fake Meet media server", () => {
  const conference = { code: "ggg-hhhh-iii", record: "conferenceRecords/tomorrow_live" };
  let meeting: any;
  const calls: Array<{ method: string; url: string }> = [];
  const log: string[] = [];
  let clock = Date.now();
  let listener: ReturnType<typeof createListener>;
  const peers: any[] = [];

  beforeAll(async () => {
    meeting = await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE google_event_id = 'ev_tomorrow'").first<any>();
    // Reset the fake's request log so the boundary assertion below is about this loop only.
    g.requests.length = 0;
    const worker = async (path: string, body?: unknown, method = "POST") => {
      calls.push({ method, url: `https://test.local${path}` });
      const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: { ...LISTENER, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
      return { status: res.status, body: await res.json() };
    };
    const google = {
      token: (scopes: string[], subject: string | null) => serviceAccountToken(env, scopes, subject, g.fetch),
      getSpace: (token: string, name: string) => getSpace(token, name, g.fetch),
      connectActiveConference: (token: string, name: string, offer: string) => connectActiveConference(token, name, offer, g.fetch),
    };
    const createPeer = async () => {
      const p: any = {
        left: false, answer: null, sliceCb: null, statusCb: null,
        async createOffer() { return "v=0\r\nfake-offer with 3 recvonly audio m-lines"; },
        async setAnswer(a: string) { this.answer = a; setTimeout(() => this.statusCb?.({ state: "JOINED" }), 0); },
        onSlice(cb: any) { this.sliceCb = cb; },
        onStatus(cb: any) { this.statusCb = cb; },
        async leave() { this.left = true; },
      };
      peers.push(p);
      return p;
    };
    listener = createListener({ worker, google, createPeer, now: () => clock, log: (l: string) => log.push(l), deviceId: "mac-e2e", subject: "sequoia@westpeek.ventures" });
  });

  it("not started: the loop heartbeats, reads the space, opens nothing", async () => {
    // Tomorrow's meeting, moved to now, so it is in the Worker's window.
    await env.WP_OS_DB.prepare("UPDATE meeting SET scheduled_at = ?2 WHERE id = ?1").bind(meeting.id, new Date().toISOString()).run();
    const out = await listener.cycle();
    expect(out.due).toBeGreaterThanOrEqual(1);
    expect(out.media_scope).toBe("SCOPE_MISSING");
    expect(peers).toHaveLength(0);
    expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(meeting.id).first<any>()).meet_live_state).toBe("meet_not_started");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meet_live_session WHERE meeting_id = ?1").bind(meeting.id).first<any>()).n).toBe(0);
  });

  it("started, grant missing: the Worker opens the session (consent recorded), the join fails scope_missing, and the meeting says so", async () => {
    g.activeConferences.set(conference.code, conference.record);
    await listener.cycle();
    expect(peers).toHaveLength(0);
    const m = await env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail FROM meeting WHERE id = ?1").bind(meeting.id).first<any>();
    expect(m.meet_live_state).toBe("meet_live_unavailable_scope");
    expect(m.meet_live_detail).toContain("meetings.conference.media.readonly");
    expect((await env.WP_OS_DB.prepare("SELECT state FROM meet_live_session WHERE conference_record = ?1").bind(conference.record).first<any>()).state).toBe("FAILED");
  });

  it("the grant lands but the project is not in the Developer Preview: Google's 'Method not found' becomes meet_live_unavailable_preview", async () => {
    g.grantedScopes.add(SCOPES.meetMedia);
    g.mediaApi = "preview_missing";
    clock += 5 * 60_000 + 1; // past the retry backoff
    await listener.cycle();
    expect(peers).toHaveLength(1);
    expect(peers[0].left).toBe(true);
    const m = await env.WP_OS_DB.prepare("SELECT meet_live_state, meet_live_detail FROM meeting WHERE id = ?1").bind(meeting.id).first<any>();
    expect(m.meet_live_state).toBe("meet_live_unavailable_preview");
    expect(m.meet_live_detail).toContain("Method not found");
  });

  it("everything granted: join → LISTENING → slices heard → the conference ends → ENDED; audio went only to the Worker", async () => {
    g.mediaApi = "ok";
    clock += 5 * 60_000 + 1;
    await listener.cycle();
    // The join finishes after cycle() returns (the peer answers, the Worker records LISTENING). A
    // fixed 80ms sleep here was a guess about the machine: on a loaded CI runner it read the row
    // before the join had landed (19 Sep 2026, meet_live_unavailable_preview — the previous
    // test's state — instead of meet_live_listening). Wait for the condition, not the clock.
    await vi.waitFor(() => expect(peers).toHaveLength(2), { timeout: 5_000, interval: 20 });
    const peer = peers[1];
    expect(peer.answer).toContain("fake-meet");
    expect(g.offers).toHaveLength(1);
    await vi.waitFor(
      async () => expect((await env.WP_OS_DB.prepare("SELECT meet_live_state FROM meeting WHERE id = ?1").bind(meeting.id).first<any>()).meet_live_state).toBe("meet_live_listening"),
      { timeout: 5_000, interval: 20 },
    );

    peer.sliceCb({ audio_base64: Buffer.from("Good morning everyone let us start with the pipeline").toString("base64"), content_type: "audio/webm;codecs=opus", seconds: 60 });
    peer.sliceCb({ audio_base64: Buffer.from("The founder said their runway is fourteen months").toString("base64"), content_type: "audio/webm;codecs=opus", seconds: 60 });
    // The loop posts slices one at a time; wait for both to be written down.
    await listener.active.get(meeting.id)!.pending;
    const notes = (await env.WP_OS_DB.prepare("SELECT body FROM meeting_note WHERE meeting_id = ?1 ORDER BY created_at, id").bind(meeting.id).all<any>()).results;
    expect(notes.map((n: any) => n.body), log.join("\n")).toEqual([
      "Speaker 1: Good morning everyone let us start",
      "Speaker 2: with the pipeline",
      "Speaker 1: The founder said their runway is fourteen months",
    ]);
    const session = await env.WP_OS_DB.prepare("SELECT state, chunks, turns, seconds_heard FROM meet_live_session WHERE conference_record = ?1").bind(conference.record).first<any>();
    expect(session).toMatchObject({ state: "LISTENING", chunks: 2, turns: 3, seconds_heard: 120 });

    g.activeConferences.delete(conference.code);
    clock += 60_000 + 1;
    await listener.cycle();
    expect(peer.left).toBe(true);
    expect(listener.active.size).toBe(0);
    const m = await env.WP_OS_DB.prepare("SELECT status, meet_live_state FROM meeting WHERE id = ?1").bind(meeting.id).first<any>();
    expect(m).toEqual({ status: "HELD", meet_live_state: "meet_live_ended" });

    // THE NETWORK BOUNDARY, on the record of every request this loop made: Google's hosts for
    // tokens and spaces, and the Worker for everything else. Audio (the chunk route) went to the
    // Worker only; no request to Google carried audio.
    const googleHosts = new Set(g.requests.map((r) => new URL(r.url).hostname));
    expect([...googleHosts].sort()).toEqual(["meet.googleapis.com", "oauth2.googleapis.com"]);
    const audioCalls = calls.filter((c) => /\/chunk$/.test(c.url));
    expect(audioCalls).toHaveLength(2);
    expect(audioCalls.every((c) => new URL(c.url).hostname === "test.local")).toBe(true);
    expect(g.requests.some((r) => /chunk|audio/i.test(r.url))).toBe(false);
    expect(log.some((l) => /joined .* as sequoia@westpeek\.ventures/.test(l))).toBe(true);
  });
});

describe("8. the routes, through the router", () => {
  it("resolves a Meet code to the meeting for the side panel (tier 3), refuses a code that is not one, and 401s nobody on every live route", async () => {
    const ok = await call("/api/meet/live/resolve?code=AAA-BBBB-CCC");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ meeting_id: internalMeeting.id, title: "Partners sync", meet_live_state: "meet_live_ended", candidates: 1 });
    expect(ok.body.call_ended_at).toBeTruthy();
    const lp = await call("/api/meet/live/resolve?code=ddd-eeee-fff");
    expect(lp.body).toMatchObject({ meeting_id: lpMeeting.id, meet_live_state: "meet_live_off_lp_policy" });
    expect((await call("/api/meet/live/resolve?code=nope")).status).toBe(400);
    expect((await call("/api/meet/live/resolve?code=zzz-zzzz-zzz")).status).toBe(404);
    for (const [method, path] of [["POST", "/api/meet/live/heartbeat"], ["POST", "/api/meet/live/sessions"], ["POST", "/api/meet/live/sessions/x/report"], ["POST", "/api/meet/live/sessions/x/chunk"], ["GET", "/api/meet/live/status"], ["GET", "/api/meet/live/resolve?code=ddd-eeee-fff"], ["POST", "/api/meet/live/adopt"]] as const) {
      const res = await handleRequest(new Request(`https://test.local${path}`, { method, body: method === "POST" ? "{}" : undefined }), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("'Record this meeting now' adopts a Meet the calendar does not know as an ordinary meeting the panel finds again — manual, so no live path", async () => {
    expect((await call("/api/meet/live/resolve?code=qqq-rrrr-sss")).status).toBe(404);
    const adopted = await call("/api/meet/live/adopt", "POST", { code: "QQQ-RRRR-SSS" });
    expect(adopted.status).toBe(201);
    expect(adopted.body).toMatchObject({ adopted: true, title: "Meet call qqq-rrrr-sss" });
    const m = await env.WP_OS_DB.prepare("SELECT source, meeting_type, type_inference, meet_conference_id, meet_link, meet_live_state FROM meeting WHERE id = ?1").bind(adopted.body.meeting_id).first<any>();
    expect(m).toEqual({ source: "manual", meeting_type: "FOUNDER", type_inference: "UNKNOWN_CHECK_IT", meet_conference_id: "qqq-rrrr-sss", meet_link: "https://meet.google.com/qqq-rrrr-sss", meet_live_state: null });
    const found = await call("/api/meet/live/resolve?code=qqq-rrrr-sss");
    expect(found.body).toMatchObject({ meeting_id: adopted.body.meeting_id, source: "manual", call_ended_at: null });
    const live = await call("/api/meet/live/sessions", "POST", { meeting_id: adopted.body.meeting_id, conference_record: "conferenceRecords/adopted", listener_device: "mac-test" }, LISTENER);
    expect(live.status).toBe(409);
    expect(live.body.error).toBe("not_firm_hosted");
    expect((await call("/api/meet/live/adopt", "POST", { code: "not a code" })).status).toBe(400);
  });

  it("a cross-site write is refused before any handler runs; same-origin and non-browser requests pass", async () => {
    const post = (site: string | null) => handleRequest(new Request("https://test.local/api/meet/live/adopt", { method: "POST", headers: { ...MP, "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) }, body: JSON.stringify({ code: "ttt-uuuu-vvv" }) }), env);
    expect((await post("cross-site")).status).toBe(403);
    expect(((await (await post("cross-site")).json()) as { error: string }).error).toBe("cross_site_refused");
    expect((await post("same-site")).status).toBe(403);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM meeting WHERE meet_conference_id = 'ttt-uuuu-vvv'").first<any>()).n, "refused before the handler: nothing was created").toBe(0);
    expect((await post("same-origin")).status).toBe(201);
    expect((await post("none")).status).toBe(201);
    expect((await post(null)).status).toBe(201);
    // GET is never refused on this ground: reading from an iframe is the whole point.
    const get = await handleRequest(new Request("https://test.local/api/me", { headers: { ...MP, "sec-fetch-site": "cross-site" } }), env);
    expect(get.status).toBe(200);
  });
});
