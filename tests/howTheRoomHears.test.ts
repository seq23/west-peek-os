import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  HEARING_SENTENCES,
  HEARING_STATES,
  JOIN_ON_MEET_LINE,
  LIVE_PATHS,
  LIVE_PATH_SENTENCES,
  SEATED_EMPLOYEE_LINE,
  STANDALONE_ROOM_LINE,
  hearing,
  hearingStateOf,
  livePath,
  type HearingFacts,
  type HearingState,
  type LivePath,
  type MaterialSource,
} from "../src/shared/meetings/howTheRoomHears";

/**
 * HOW THE ROOM HEARS — every named state has a sentence, and the facts reach each one.
 *
 * Owner, 19 Sep 2026: "If I push Join on Meet what happens? I got to the Google Meet page but is
 * that enough? Is it recording? Are my AI employees there from Join on Meet alone?" The During
 * face now says how this meeting's words reach its record, from named states chosen off the row.
 * This suite is the one `validate:room-hears` reads: every state in `HEARING_STATES` and every
 * path in `LIVE_PATHS` must be named here as the state a set of facts reaches, or the build fails.
 *
 * WHAT THE SENTENCES MUST SAY, because these are the owner's questions in order: a Meet call is
 * NOT heard live by Join on Meet alone; the transcript comes from Google within the ingest cadence
 * READ FROM THE JOB ROW; the laptop switch is a different path; a seated employee is never in the
 * call.
 */

let t: TestDb;
let env: Env;
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, { method, headers: body === undefined ? MP : { ...MP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

const manual: HearingFacts = {
  source: "manual",
  meet_link: null,
  firm_default_on: true,
  ingest_every_minutes: 60,
  meet: null,
  transcription_available: true,
  recording_policy_active: true,
  consent: { transcription: "NOT_RECORDED", recording: "NOT_RECORDED" },
  turns_captured: 0,
  notes_typed: 0,
};
const meet: HearingFacts = { ...manual, source: "google_calendar", meet_link: "https://meet.google.com/abc-defg-hij" };
const inbox = (state: HearingFacts["meet"] extends infer M ? (M extends { state: infer S } ? S : never) : never, extra: Partial<NonNullable<HearingFacts["meet"]>> = {}): NonNullable<HearingFacts["meet"]> => ({
  state,
  conference_ended_at: "2026-09-19T15:02:00Z",
  turns: 212,
  participants: 3,
  read_at: "2026-09-19T15:48:00Z",
  detail: null,
  ...extra,
});

/** Every state, and the facts that reach it. The validator reads the state names off this table. */
const REACHES: Array<[HearingState, HearingFacts, boolean]> = [
  ["MEET_LIVE_HERE", meet, true],
  ["MEET_INGESTED", { ...meet, meet: inbox("INGESTED") }, false],
  ["MEET_WAITING_FOR_TRANSCRIPT", { ...meet, meet: inbox("RECEIVED", { turns: 0 }) }, false],
  ["MEET_NO_TRANSCRIPT", { ...meet, meet: inbox("NO_TRANSCRIPT", { turns: 0 }) }, false],
  ["MEET_REFUSED_DEFAULT_OFF", { ...meet, firm_default_on: false, meet: inbox("REFUSED") }, false],
  ["MEET_READ_FAILED", { ...meet, meet: inbox("FAILED", { detail: "token refused" }) }, false],
  ["MEET_DEFAULT_OFF", { ...meet, firm_default_on: false }, false],
  ["MEET_PENDING", meet, false],
  ["MANUAL_LIVE", { ...manual, turns_captured: 4, consent: { transcription: "GRANTED", recording: "GRANTED" } }, true],
  ["MANUAL_NO_SERVICE", { ...manual, transcription_available: false }, false],
  ["MANUAL_POLICY_OFF", { ...manual, recording_policy_active: false }, false],
  ["MANUAL_CONSENT_DENIED", { ...manual, consent: { transcription: "DENIED", recording: "DENIED" } }, false],
  ["MANUAL_CAPTURED_EARLIER", { ...manual, turns_captured: 9, consent: { transcription: "GRANTED", recording: "GRANTED" } }, false],
  ["MANUAL_READY", manual, false],
];

const PATHS: Array<[LivePath, HearingFacts]> = [
  ["LIVE_PATH_OPEN", meet],
  ["LIVE_PATH_POLICY_OFF", { ...meet, recording_policy_active: false }],
  ["LIVE_PATH_NO_SERVICE", { ...meet, transcription_available: false }],
  ["LIVE_PATH_CONSENT_DENIED", { ...meet, consent: { transcription: "REVOKED", recording: "GRANTED" } }],
];

describe("every state is reachable from the row and has a sentence", () => {
  it("the table above names every state once, and nothing that is not a state", () => {
    expect(REACHES.map(([s]) => s).sort()).toEqual([...HEARING_STATES].sort());
    expect(PATHS.map(([p]) => p).sort()).toEqual([...LIVE_PATHS].sort());
  });

  for (const [state, facts, live] of REACHES) {
    it(`${state} is what these facts reach, and its sentence is a full line`, () => {
      expect(hearingStateOf(facts, { live })).toBe(state);
      const h = hearing(facts, { live });
      expect(h.state).toBe(state);
      expect(h.sentence).toBe(HEARING_SENTENCES[state](facts));
      expect(h.sentence.length).toBeGreaterThan(60);
      expect(h.sentence.length).toBeLessThan(420);
      // The channel is the eyebrow and the sentence opens with it, so a reader on a phone sees the
      // channel first even when the line wraps.
      expect(h.sentence.startsWith(h.channel)).toBe(true);
    });
  }

  for (const [path, facts] of PATHS) {
    it(`${path} is the way to follow live from these gates`, () => {
      expect(livePath(facts)).toBe(path);
      expect(LIVE_PATH_SENTENCES[path].length).toBeGreaterThan(40);
    });
  }
});

describe("what the sentences say, in the owner's order", () => {
  it("a Meet call that is only joined is not heard live, and the transcript comes within the cadence from the job row", () => {
    const h = hearing({ ...meet, ingest_every_minutes: 45 }, { live: false });
    expect(h.state).toBe("MEET_PENDING");
    expect(h.sentence).toContain("Join on Meet only opens the call");
    expect(h.sentence).toContain("no employee is in it");
    expect(h.sentence).toContain("does not hear it live");
    expect(h.sentence).toContain("within ~45 min");
    expect(h.sentence).not.toContain("60");
    expect(h.live_path).toBe("LIVE_PATH_OPEN");
    expect(h.live_sentence).toContain("laptop");
  });

  it("with no job row the cadence is named as unknown rather than invented", () => {
    expect(hearing({ ...meet, ingest_every_minutes: null }, { live: false }).sentence).toContain("the next ingest run");
  });

  it("the laptop mic on a Meet reads: laptop mic · live · Meet transcript after the call as the authoritative record", () => {
    const h = hearing(meet, { live: true });
    expect(h.sentence).toContain("laptop mic · live");
    expect(h.sentence).toContain("through your speakers");
    expect(h.sentence).toContain("Google's transcript arrives after the call as the authoritative record");
    expect(h.live_path).toBeNull();
  });

  it("a read call says when it landed and how much", () => {
    const h = hearing({ ...meet, meet: inbox("INGESTED") }, { live: false });
    expect(h.sentence).toContain("212 turns");
    expect(h.sentence).toContain("3 participants");
    expect(h.sentence).toContain("nobody from the firm's AI was in the call");
  });

  it("the manual path names the laptop microphone and the seated employee's reach", () => {
    expect(hearing(manual, { live: false }).sentence).toContain("laptop microphone");
    expect(hearing({ ...manual, recording_policy_active: false }, { live: false }).sentence).toContain("Managing Partner");
    expect(hearing({ ...manual, turns_captured: 9 }, { live: false }).sentence).toContain("9 turns");
  });

  it("the three lines said beside the controls tell the truth about the code", () => {
    expect(JOIN_ON_MEET_LINE).toMatch(/new tab/);
    expect(JOIN_ON_MEET_LINE).toMatch(/no employee is in the call/);
    expect(JOIN_ON_MEET_LINE).toMatch(/does not hear it live/);
    expect(SEATED_EMPLOYEE_LINE).toMatch(/never in the Meet call/);
    expect(SEATED_EMPLOYEE_LINE).toMatch(/take a task that returns here/);
    expect(STANDALONE_ROOM_LINE).toMatch(/same room, in its own window/);
  });
});

describe("GET /api/meetings/:id/hearing — the facts come from the rows", () => {
  it("a manual meeting: no Meet, the cadence from the job row, the gates as the switch reads them", async () => {
    const created = await call<{ id: string }>("/api/meetings", "POST", { title: "Coffee with Deana", meeting_type: "FOUNDER" });
    expect(created.status).toBe(201);
    const res = await call<{ facts: HearingFacts; sources: MaterialSource[] }>(`/api/meetings/${created.body.id}/hearing`);
    expect(res.status).toBe(200);
    expect(res.body.facts.source).toBe("manual");
    expect(res.body.facts.meet_link).toBeNull();
    expect(res.body.facts.meet).toBeNull();
    // The number the sentence speaks is the job's own, read from its row — 0203 seeds it at 60.
    const job = await t.db.prepare("SELECT interval_minutes FROM scheduled_job WHERE job_key = 'meet_ingest'").first<{ interval_minutes: number }>();
    expect(job?.interval_minutes).toBe(60);
    expect(res.body.facts.ingest_every_minutes).toBe(60);
    expect(res.body.facts.recording_policy_active).toBe(false);
    // The test env binds no AI, so the switch's first gate is the missing service — and the state
    // says that, not the policy. Were a service bound, the policy would be the first gate named.
    expect(res.body.facts.transcription_available).toBe(false);
    expect(hearingStateOf(res.body.facts, { live: false })).toBe("MANUAL_NO_SERVICE");
    expect(hearingStateOf({ ...res.body.facts, transcription_available: true }, { live: false })).toBe("MANUAL_POLICY_OFF");
    expect(res.body.sources).toEqual([]);
  });

  it("a calendar Meet meeting: the firm default, the inbox row once the call is read, and the sources with times", async () => {
    const created = await call<{ id: string }>("/api/meetings", "POST", { title: "Deana Oliver, Psyflo — founder call", meeting_type: "FOUNDER" });
    const id = created.body.id;
    // The calendar sync's own columns (0202), written as it writes them.
    await t.db.prepare("UPDATE meeting SET source = 'google_calendar', meet_link = 'https://meet.google.com/svf-nzzr-pax', meet_conference_id = 'svf-nzzr-pax', calendar_key = 'westpeek' WHERE id = ?1").bind(id).run();

    const off = await call<{ facts: HearingFacts }>(`/api/meetings/${id}/hearing`);
    expect(off.body.facts.source).toBe("google_calendar");
    expect(off.body.facts.firm_default_on).toBe(false);
    expect(hearingStateOf(off.body.facts, { live: false })).toBe("MEET_DEFAULT_OFF");

    await t.db.prepare("INSERT INTO meet_recording_policy (firm_scope, active, receipt_id) VALUES ('west-peek', 1, 'apr_test') ON CONFLICT (firm_scope) DO UPDATE SET active = 1").run();
    const on = await call<{ facts: HearingFacts }>(`/api/meetings/${id}/hearing`);
    expect(on.body.facts.firm_default_on).toBe(true);
    expect(hearingStateOf(on.body.facts, { live: false })).toBe("MEET_PENDING");

    // The call was read: an inbox row and a Meet-native import with its turns, as meetIngest writes them.
    await t.db.prepare(
      "INSERT INTO transcript_import (id, meeting_id, source, status, imported_by, firm_scope, provider_name) VALUES ('ti_meet_1', ?1, 'PROVIDER', 'IMPORTED', 'system', 'west-peek', 'GOOGLE_MEET')",
    ).bind(id).run();
    for (let i = 0; i < 3; i += 1) {
      await t.db.prepare(
        "INSERT INTO meeting_note (id, meeting_id, note_type, body, author_type, author_id, transcript_import_id) VALUES (?1, ?2, 'TRANSCRIPT_DERIVED', ?3, 'AI', 'system', 'ti_meet_1')",
      ).bind(`mn_meet_${i}`, id, `Deana: line ${i}`).run();
    }
    await t.db.prepare(
      "INSERT INTO meet_event_inbox (id, conference_record, meeting_id, delivered_via, state, turns, participants_json, conference_ended_at, transcript_import_id) VALUES ('mei_1', 'conferenceRecords/abc', ?1, 'poll', 'INGESTED', 3, '[\"Deana Oliver\",\"Sequoia Taylor\"]', '2026-09-19T15:02:00Z', 'ti_meet_1')",
    ).bind(id).run();
    await call(`/api/meetings/${id}/notes`, "POST", { note_type: "MANUAL", body: "She wants the district contacts by Friday." });

    const read = await call<{ facts: HearingFacts; sources: MaterialSource[] }>(`/api/meetings/${id}/hearing`);
    expect(read.body.facts.meet?.state).toBe("INGESTED");
    expect(read.body.facts.meet?.turns).toBe(3);
    expect(read.body.facts.meet?.participants).toBe(2);
    expect(read.body.facts.meet?.read_at).toBeTruthy();
    expect(hearingStateOf(read.body.facts, { live: false })).toBe("MEET_INGESTED");
    expect(read.body.facts.notes_typed).toBe(1);

    const kinds = read.body.sources.map((s) => s.kind);
    expect(kinds).toEqual(["meet_transcript", "typed_notes"]);
    const meetSrc = read.body.sources.find((s) => s.kind === "meet_transcript")!;
    expect(meetSrc.turns).toBe(3);
    expect(meetSrc.first_at).toBeTruthy();
    expect(read.body.sources.find((s) => s.kind === "typed_notes")!.count).toBe(1);
  });

  /*
   * THE LAPTOP-MIC PATH ONTO A MEET CALL (owner, 19 Sep 2026): nothing is stored before "They said
   * yes"; after it, chunks flow, the row says LAPTOP_MIC, and the hearing state changes. The
   * transcription service is a fake binding here — Nova-3 answers in its own shape — so the path
   * is proven through the real adapter and the real two gates.
   */
  it("before their yes a chunk stores nothing; after it, chunks are stamped as the laptop mic and the state moves", async () => {
    const fakeAi = { run: async () => ({ results: { channels: [{ alternatives: [{ transcript: "we can send the data room by Friday", words: [] }] }] } }) };
    const live = makeTestEnv(t.db, { AI: fakeAi as never });
    const req = async <T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
      const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: body === undefined ? MP : { ...MP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), live);
      return { status: res.status, body: (await res.json()) as T };
    };
    const created = await req<{ id: string }>("/api/meetings", "POST", { title: "Deana on Meet, laptop mic", meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 600_000).toISOString() });
    const id = created.body.id;
    await t.db.prepare("UPDATE meeting SET source = 'google_calendar', meet_link = 'https://meet.google.com/abc-defg-hij', meet_conference_id = 'abc-defg-hij' WHERE id = ?1").bind(id).run();
    // The Managing Partner's recording policy for this meeting, through the ordinary approval.
    const card = await req<{ id: string }>("/api/approvals", "POST", { action_key: "meeting.recording_policy.activate", object_type: "meeting", object_id: id, title: "policy", submit: true });
    await req(`/api/approvals/${card.body.id}/decide`, "POST", { decision: "approved" });
    expect((await req(`/api/meetings/${id}/recording-policy`, "POST", { approval_receipt_id: card.body.id })).status).toBe(200);

    // The door was pressed: the row is in progress, and nothing is recorded yet.
    expect((await req(`/api/meetings/${id}/started`, "POST", { via: "laptop_mic" })).status).toBe(200);
    const before = await req<{ facts: HearingFacts }>(`/api/meetings/${id}/hearing`);
    expect(before.body.facts.transcription_available).toBe(true);
    expect(before.body.facts.recording_policy_active).toBe(true);
    expect(hearingStateOf(before.body.facts, { live: false })).toBe("MEET_PENDING");
    const refused = await req<{ error: string }>(`/api/meetings/${id}/capture/chunk`, "POST", { audio_base64: "AAAA", sequence: 0, content_type: "audio/webm", via: "laptop_mic" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("consent_not_granted");
    expect(Number((await t.db.prepare("SELECT COUNT(*) AS n FROM transcript_import WHERE meeting_id = ?1 AND status = 'IMPORTED'").bind(id).first<{ n: number }>())?.n)).toBe(0);
    expect(Number((await t.db.prepare("SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?1").bind(id).first<{ n: number }>())?.n)).toBe(0);

    // They said yes: chunks flow, each row names the laptop mic, and the state line moves.
    const yes = await req<{ can_capture: boolean }>(`/api/meetings/${id}/capture/consent`, "POST", { answer: "GRANTED", granted_by: "Deana Oliver", basis: "Asked out loud at the start of the call." });
    expect(yes.status).toBe(201);
    expect(yes.body.can_capture).toBe(true);
    const chunk = await req<{ turns_written: number; via: string; engine: string }>(`/api/meetings/${id}/capture/chunk`, "POST", { audio_base64: "AAAA", sequence: 1, content_type: "audio/webm", via: "laptop_mic" });
    expect(chunk.status).toBe(201);
    expect(chunk.body.via).toBe("laptop_mic");
    expect(chunk.body.turns_written).toBeGreaterThan(0);
    const row = await t.db.prepare("SELECT source, provider_name FROM transcript_import WHERE meeting_id = ?1 AND status = 'IMPORTED'").bind(id).first<{ source: string; provider_name: string | null }>();
    expect(row?.source).toBe("NATIVE");
    expect(row?.provider_name).toBe("LAPTOP_MIC");
    const after = await req<{ facts: HearingFacts; sources: MaterialSource[] }>(`/api/meetings/${id}/hearing`);
    expect(after.body.facts.turns_captured).toBeGreaterThan(0);
    expect(hearing(after.body.facts, { live: true }).state).toBe("MEET_LIVE_HERE");
    expect(hearing(after.body.facts, { live: true }).chip).toBe("laptop mic · live");
    expect(after.body.sources.map((s) => s.kind)).toEqual(["laptop_capture"]);
    // A chunk cannot claim to be anything else.
    expect((await req(`/api/meetings/${id}/capture/chunk`, "POST", { audio_base64: "AAAA", sequence: 2, content_type: "audio/webm", via: "meet_media" })).status).toBe(400);
  });

  it("is not served for a meeting the reader may not see", async () => {
    const created = await call<{ id: string }>("/api/meetings", "POST", { title: "LP catch-up", meeting_type: "LP", privacy_label: "LP_PRIVATE" });
    expect(created.status).toBe(201);
    const res = await handleRequest(
      new Request(`https://test.local/api/meetings/${created.body.id}/hearing`, { headers: { "x-wpos-dev-user": "preston@westpeek.ventures" } }),
      env,
    );
    expect([401, 403, 404]).toContain(res.status);
  });
});
