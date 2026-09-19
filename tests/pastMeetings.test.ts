import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  HAPPENING_NOW, HELD_NOTHING_ON_THE_RECORD, MEETING_SETTLES_AFTER_MINUTES, isInProgress, isPastMeeting, isUpcoming, splitMeetings,
} from "../src/shared/meetings/pastMeetings";
import { markMeetingStarted, settlePastMeetings } from "../src/worker/services/meetings";
import { handleRequest } from "../src/worker/index";

/**
 * A MEETING WHOSE TIME HAS PASSED IS NEVER "COMING UP" (19 Sep 2026).
 *
 * Production: the Meetings masthead read "Nothing today. The next one is Wed, Sep 16 at 08:00 AM"
 * on Saturday the 19th, with the 16th and the 18th listed under "Coming up". The sync imports a
 * week back as SCHEDULED and the list treated SCHEDULED as upcoming whatever the date.
 */

const NOW = new Date("2026-09-19T14:00:00.000Z");

describe("the split — pure", () => {
  const rows = [
    { id: "a", status: "SCHEDULED", scheduled_at: "2026-09-16T12:00:00.000Z", occurred_at: null }, // past, synced-shaped
    { id: "b", status: "SCHEDULED", scheduled_at: "2026-09-18T15:00:00.000Z", occurred_at: null }, // past
    { id: "c", status: "SCHEDULED", scheduled_at: "2026-09-19T12:45:00.000Z", occurred_at: null }, // 75 min ago — inside the settle window, still "now"
    { id: "d", status: "SCHEDULED", scheduled_at: "2026-09-22T13:00:00.000Z", occurred_at: null }, // ahead
    { id: "e", status: "SCHEDULED", scheduled_at: null, occurred_at: null }, // no time — unknown is not past
    { id: "f", status: "HELD", scheduled_at: "2026-09-19T13:00:00.000Z", occurred_at: "2026-09-19T13:00:00.000Z" },
    { id: "g", status: "CANCELLED", scheduled_at: "2026-09-25T13:00:00.000Z", occurred_at: null },
  ];

  it("a past-dated SCHEDULED meeting never appears under Coming up, whatever its source", () => {
    const { upcoming, past } = splitMeetings(rows, NOW);
    expect(upcoming.map((m) => m.id)).toEqual(["c", "d", "e"]);
    expect(past.map((m) => m.id)).toEqual(["g", "f", "b", "a"]); // newest first by its own time; a cancelled future meeting is still "what happened to it"
    for (const m of upcoming) expect(isPastMeeting(m, NOW), `${m.id} is past and listed as upcoming`).toBe(false);
    for (const m of rows.filter((r) => r.status === "SCHEDULED" && isPastMeeting(r, NOW))) {
      expect(upcoming.some((u) => u.id === m.id), `${m.id} leaked into Coming up`).toBe(false);
      expect(past.some((p) => p.id === m.id), `${m.id} is on neither list`).toBe(true);
    }
  });

  it("the masthead's next one is the first SCHEDULED meeting whose time is not past", () => {
    const { upcoming } = splitMeetings(rows, NOW);
    expect(upcoming[0]!.id).toBe("c");
    // Ninety minutes later the 12:45 meeting has settled and the next one is Tuesday's.
    const later = new Date(NOW.getTime() + 90 * 60_000);
    expect(splitMeetings(rows, later).upcoming[0]!.id).toBe("d");
  });

  it("past is scheduled_at plus the settle window — ninety minutes, since the schema carries no end time", () => {
    expect(MEETING_SETTLES_AFTER_MINUTES).toBe(90);
    const edge = { status: "SCHEDULED", scheduled_at: new Date(NOW.getTime() - 90 * 60_000).toISOString(), occurred_at: null };
    expect(isPastMeeting(edge, NOW)).toBe(false);
    expect(isPastMeeting(edge, new Date(NOW.getTime() + 1))).toBe(true);
    expect(isUpcoming({ status: "SCHEDULED", scheduled_at: "not a date", occurred_at: null }, NOW)).toBe(true);
    expect(isUpcoming({ status: "HELD", scheduled_at: "2027-01-01T00:00:00.000Z", occurred_at: null }, NOW)).toBe(false);
  });

  /*
   * IN PROGRESS IS DERIVED, NEVER PRESSED (19 Sep 2026). Owner, on "It is happening now": "wtf is
   * that button". A started meeting leaves Coming up and reads "happening now" on the record.
   */
  it("a SCHEDULED meeting that something started is off Coming up and reads happening now", () => {
    const started = { id: "h", status: "SCHEDULED", scheduled_at: "2026-09-22T13:00:00.000Z", occurred_at: null, started_at: "2026-09-19T13:58:00.000Z" };
    expect(isInProgress(started)).toBe(true);
    expect(isUpcoming(started, NOW)).toBe(false);
    const { upcoming, past } = splitMeetings([...rows, started], NOW);
    expect(upcoming.map((m) => m.id)).not.toContain("h");
    expect(past.map((m) => m.id)).toContain("h");
    // The masthead's next one skips it too.
    expect(upcoming[0]!.id).toBe("c");
    expect(isInProgress({ ...started, status: "HELD" })).toBe(false);
    expect(isInProgress({ ...started, started_at: null })).toBe(false);
    expect(HAPPENING_NOW).toBe("happening now");
  });

  it("the page uses the shared split and the shared reading, not its own filter", () => {
    const page = readFileSync(new URL("../src/client/pages/MeetingsPage.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/splitMeetings\(rows, new Date\(\)\)/);
    expect(page, "the old status-only filter is back").not.toMatch(/rows\.filter\(\(m\) => m\.status === "SCHEDULED"\)/);
    expect(page).toContain("HELD_NOTHING_ON_THE_RECORD");
    expect(HELD_NOTHING_ON_THE_RECORD).toBe("held, nothing on the record");
    expect(page).toContain("HAPPENING_NOW");
    // The retired control: no "It is happening now", no start- door that only chose a face.
    expect(page).not.toContain("It is happening now");
    expect(page).not.toContain("data-testid={`start-${m.id}`}");
  });
});

describe("one place marks a meeting started", () => {
  let t: TestDb;
  let env: Env;
  const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
  const ACTOR = { type: "HUMAN" as const, firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
  async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
    const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: body === undefined ? MP : { ...MP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: (await res.json()) as T };
  }
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
  });
  afterAll(async () => {
    await disposeTestDb(t);
  });

  it("joining from the app, their yes, and Google's conference-started all land on the same column; the first start wins; the list moves it off Coming up", async () => {
    const created = await call<{ id: string }>("/api/meetings", "POST", { title: "Started by joining", meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
    const id = created.body.id;
    const before = await call<{ meetings: Array<{ id: string; started_at: string | null }> }>("/api/meetings");
    expect(before.body.meetings.find((m) => m.id === id)?.started_at ?? null).toBeNull();

    const joined = await call<{ started_at: string; started_via: string; changed: boolean }>(`/api/meetings/${id}/started`, "POST", { via: "join_on_meet" });
    expect(joined.status).toBe(200);
    expect(joined.body.changed).toBe(true);
    expect(joined.body.started_via).toBe("join_on_meet");

    // A second start of any kind leaves the first moment alone.
    const again = await markMeetingStarted(env, ACTOR, id, "capture");
    expect(again.changed).toBe(false);
    expect(again.started_via).toBe("join_on_meet");
    expect(again.started_at).toBe(joined.body.started_at);

    const list = await call<{ meetings: Array<{ id: string; status: string; started_at: string | null; scheduled_at: string | null; occurred_at: string | null }> }>("/api/meetings");
    const row = list.body.meetings.find((m) => m.id === id)!;
    expect(row.started_at).toBe(joined.body.started_at);
    expect(isUpcoming(row, new Date())).toBe(false);
    expect(isInProgress(row)).toBe(true);
    const event = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'meeting.started' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(Number(event?.n)).toBe(1);

    // Their yes starts a meeting nobody joined from the app (capture is a start), and the
    // conference-started name is accepted for the sibling's live path.
    const second = await call<{ id: string }>("/api/meetings", "POST", { title: "Started by their yes", meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
    await call(`/api/meetings/${second.body.id}/capture/consent`, "POST", { answer: "GRANTED", granted_by: "Deana Oliver", basis: "asked out loud at the start" });
    const viaYes = await t.db.prepare("SELECT started_via FROM meeting WHERE id = ?1").bind(second.body.id).first<{ started_via: string | null }>();
    expect(viaYes?.started_via).toBe("capture");
    const third = await call<{ id: string }>("/api/meetings", "POST", { title: "Started by Google", meeting_type: "FOUNDER", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await markMeetingStarted(env, ACTOR, third.body.id, "conference_started", "2026-09-19T15:00:00.000Z")).started_at).toBe("2026-09-19T15:00:00.000Z");
    // A no does not start anything, and the route refuses a name it does not know.
    const fourth = await call<{ id: string }>("/api/meetings", "POST", { title: "Said no", meeting_type: "FOUNDER" });
    await call(`/api/meetings/${fourth.body.id}/capture/consent`, "POST", { answer: "DENIED", basis: "asked out loud" });
    expect((await t.db.prepare("SELECT started_at FROM meeting WHERE id = ?1").bind(fourth.body.id).first<{ started_at: string | null }>())?.started_at).toBeNull();
    expect((await call(`/api/meetings/${fourth.body.id}/started`, "POST", { via: "button" })).status).toBe(400);
  });
});

describe("the server settles synced rows", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
    const insert = (id: string, when: string, source: string) =>
      env.WP_OS_DB.prepare(
        `INSERT INTO meeting (id, title, meeting_type, scheduled_at, status, privacy_label, firm_scope, created_by, source)
         VALUES (?1, ?2, 'FOUNDER', ?3, 'SCHEDULED', 'INTERNAL', 'west-peek', 'system', ?4)`,
      ).bind(id, `Meeting ${id}`, when, source).run();
    await insert("mtg_past_synced", "2026-09-16T12:00:00.000Z", "google_calendar");
    await insert("mtg_recent_synced", "2026-09-19T13:00:00.000Z", "google_calendar"); // 60 min ago — not yet
    await insert("mtg_ahead_synced", "2026-09-22T13:00:00.000Z", "google_calendar");
    await insert("mtg_past_manual", "2026-09-16T12:00:00.000Z", "manual");
  });
  afterAll(async () => {
    await disposeTestDb(t);
  });

  it("a synced meeting past its window becomes HELD at its scheduled time, on the record with the reason; others are untouched", async () => {
    const out = await settlePastMeetings(env, NOW);
    expect(out.settled).toEqual(["mtg_past_synced"]);
    const rows = (await env.WP_OS_DB.prepare("SELECT id, status, occurred_at FROM meeting WHERE id LIKE 'mtg_%' ORDER BY id").all<{ id: string; status: string; occurred_at: string | null }>()).results!;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.mtg_past_synced!.status).toBe("HELD");
    expect(by.mtg_past_synced!.occurred_at).toBe("2026-09-16T12:00:00.000Z");
    expect(by.mtg_recent_synced!.status, "inside the settle window is still now").toBe("SCHEDULED");
    expect(by.mtg_ahead_synced!.status).toBe("SCHEDULED");
    expect(by.mtg_past_manual!.status, "a person's own row is theirs to move").toBe("SCHEDULED");
    const ev = await env.WP_OS_DB.prepare(
      "SELECT payload_json FROM event_record WHERE event_type = 'meeting.transitioned' AND object_id = 'mtg_past_synced'",
    ).first<{ payload_json: string }>();
    expect(ev).toBeTruthy();
    const payload = JSON.parse(ev!.payload_json) as { settled_from: string; note: string; to: string };
    expect(payload.settled_from).toBe("calendar");
    expect(payload.to).toBe("HELD");
    expect(payload.note).toBe(HELD_NOTHING_ON_THE_RECORD);
    // Idempotent: a second pass settles nothing.
    expect((await settlePastMeetings(env, NOW)).settled).toEqual([]);
  });

  it("the list route and the calendar sync both call it, so a quiet night still reads right", () => {
    const meetings = readFileSync(new URL("../src/worker/services/meetings.ts", import.meta.url), "utf8");
    const sync = readFileSync(new URL("../src/worker/services/calendarSync.ts", import.meta.url), "utf8");
    expect(meetings).toMatch(/export async function handleListMeetings[\s\S]{0,400}await settlePastMeetings\(ctx\.env\)/);
    expect(sync).toMatch(/await applyPlan\(env, actor, source, plan, now\);[\s\S]{0,400}await settlePastMeetings\(env, now, source\.firmScope\)/);
  });
});
