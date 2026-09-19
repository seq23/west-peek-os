import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  HELD_NOTHING_ON_THE_RECORD, MEETING_SETTLES_AFTER_MINUTES, isPastMeeting, isUpcoming, splitMeetings,
} from "../src/shared/meetings/pastMeetings";
import { settlePastMeetings } from "../src/worker/services/meetings";

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

  it("the page uses the shared split and the shared reading, not its own filter", () => {
    const page = readFileSync(new URL("../src/client/pages/MeetingsPage.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/splitMeetings\(rows, new Date\(\)\)/);
    expect(page, "the old status-only filter is back").not.toMatch(/rows\.filter\(\(m\) => m\.status === "SCHEDULED"\)/);
    expect(page).toContain("HELD_NOTHING_ON_THE_RECORD");
    expect(HELD_NOTHING_ON_THE_RECORD).toBe("held, nothing on the record");
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
