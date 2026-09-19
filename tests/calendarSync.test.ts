import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { calendarItem, makeFakeGoogle, type FakeGoogle } from "./helpers/fakeGoogle";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runCalendarSync, syncCalendar } from "../src/worker/services/calendarSync";
import { CALENDAR_SOURCES } from "../src/shared/meetings/calendarSources";
import { eventsFromIcs, inferMeetingType, meetingCodeFromLink, planCalendarSync } from "../src/shared/meetings/calendarSync";

/**
 * Phase Meet, tier 1 — a calendar event exists here as exactly one meeting.
 *
 * The rules under test: one meeting per (calendar, event) however many times the sync runs;
 * title/time follow the calendar but the type a person set does not flip back; the type is
 * inferred by a stated rule and the guess is flagged; the iCal door serves when the API is shut
 * and the ledger says so; and the only calendar read is the firm's.
 */

let t: TestDb;
let env: Env;
let g: FakeGoogle;
const NOW = new Date("2026-09-18T12:00:00.000Z");
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const src = CALENDAR_SOURCES[0]!;

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(new Request(`https://test.local${path}`, { method, headers: { ...MP, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  g = makeFakeGoogle();
  env = makeTestEnv(t.db, { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: g.serviceAccountJson, WP_OS_CAL_ICS_WESTPEEK: "https://calendar.google.com/calendar/ical/private-abc/basic.ics" });
  await env.WP_OS_DB.prepare("INSERT INTO canonical_company (id, canonical_name, website, created_by) VALUES ('cc_acme','Acme','https://www.acme.io','fu_scooter_taylor')").run();
  await env.WP_OS_DB.prepare("INSERT INTO lp_record (id, legal_name, lp_type, created_by) VALUES ('lp_oak','Oak Family Office','FAMILY_OFFICE','fu_scooter_taylor')").run();
  await env.WP_OS_DB.prepare("INSERT INTO person (id, full_name, email, organization) VALUES ('per_oak','Olive Oak','olive@oakfo.com','Oak Family Office')").run();
  g.calendarItems = [
    calendarItem({ id: "ev_internal", summary: "Partners sync", start: "2026-09-19T15:00:00.000Z", code: "aaa-bbbb-ccc", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "scooter@westpeek.ventures" }] }),
    calendarItem({ id: "ev_lp", summary: "Oak catch-up", start: "2026-09-19T16:00:00.000Z", code: "ddd-eeee-fff", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "olive@oakfo.com", displayName: "Olive Oak" }] }),
    calendarItem({ id: "ev_founder", summary: "Acme intro", start: "2026-09-20T15:00:00.000Z", code: "ggg-hhhh-iii", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "jo@acme.io", displayName: "Jo Acme" }] }),
    calendarItem({ id: "ev_unknown", summary: "Coffee", start: "2026-09-21T15:00:00.000Z", code: "jjj-kkkk-lll", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "someone@gmail.com" }] }),
    calendarItem({ id: "ev_nolink", summary: "Dentist", start: "2026-09-22T15:00:00.000Z", code: null }),
  ];
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the pure half", () => {
  it("reads a Meet code out of a link and nothing else", () => {
    expect(meetingCodeFromLink("https://meet.google.com/abc-defg-hjk?authuser=0")).toBe("abc-defg-hjk");
    expect(meetingCodeFromLink("https://zoom.us/j/123")).toBeNull();
    expect(meetingCodeFromLink(null)).toBeNull();
  });

  it("infers INTERNAL, LP, FOUNDER, or a flagged guess — LP winning over a company match", () => {
    const known = { firmDomains: ["westpeek.ventures"], lpEmails: new Set(["olive@oakfo.com"]), lpDomains: new Set<string>(), companyDomains: new Map([["oakfo.com", "cc_x"], ["acme.io", "cc_acme"]]) };
    const me = { email: "sequoia@westpeek.ventures", displayName: null, self: true };
    expect(inferMeetingType([me, { email: "scooter@westpeek.ventures", displayName: null, self: false }], known)).toMatchObject({ meetingType: "INTERNAL", inference: "FIRM_ONLY" });
    expect(inferMeetingType([me, { email: "olive@oakfo.com", displayName: null, self: false }], known)).toMatchObject({ meetingType: "LP", inference: "LP_CONTACT", privacyLabel: "LP_PRIVATE" });
    expect(inferMeetingType([me, { email: "jo@acme.io", displayName: null, self: false }], known)).toMatchObject({ meetingType: "FOUNDER", inference: "COMPANY_DOMAIN", companyId: "cc_acme" });
    expect(inferMeetingType([me, { email: "x@gmail.com", displayName: null, self: false }], known)).toMatchObject({ meetingType: "FOUNDER", inference: "UNKNOWN_CHECK_IT" });
  });

  it("plans one action per event, and 'nothing to do' is a named skip", () => {
    const known = { firmDomains: ["westpeek.ventures"], lpEmails: new Set<string>(), lpDomains: new Set<string>(), companyDomains: new Map<string, string>() };
    const ev = { googleEventId: "e1", title: "T", startsAt: "2026-09-19T15:00:00.000Z", endsAt: null, allDay: false, meetLink: "https://meet.google.com/aaa-bbbb-ccc", meetingCode: "aaa-bbbb-ccc", attendees: [], organizerEmail: null, status: "confirmed" as const, htmlLink: null };
    const plan1 = planCalendarSync([ev, { ...ev, googleEventId: "e2", meetingCode: null, meetLink: null }], [], known);
    expect(plan1.map((p) => p.kind)).toEqual(["create", "skip"]);
    const plan2 = planCalendarSync([ev], [{ id: "m1", google_event_id: "e1", title: "T", scheduled_at: ev.startsAt, meet_link: ev.meetLink, meet_conference_id: ev.meetingCode, status: "SCHEDULED" }], known);
    expect(plan2).toEqual([{ kind: "skip", event: ev, reason: "unchanged" }]);
    const plan3 = planCalendarSync([{ ...ev, title: "Renamed" }], [{ id: "m1", google_event_id: "e1", title: "T", scheduled_at: ev.startsAt, meet_link: ev.meetLink, meet_conference_id: ev.meetingCode, status: "SCHEDULED" }], known);
    expect(plan3[0]).toMatchObject({ kind: "update", meetingId: "m1", changed: ["title"] });
  });

  it("reads Google's iCal export into the same shape", () => {
    const ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:uid-1@google.com", "SUMMARY:Oak catch-up", "DTSTART:20260919T160000Z", "DTEND:20260919T163000Z",
      "ATTENDEE;CN=Olive Oak:mailto:olive@oakfo.com", "ORGANIZER:mailto:sequoia@westpeek.ventures",
      "X-GOOGLE-CONFERENCE:https://meet.google.com/ddd-eeee-fff", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const e = eventsFromIcs(ics)[0]!;
    expect(e).toMatchObject({ googleEventId: "uid-1", title: "Oak catch-up", startsAt: "2026-09-19T16:00:00Z", meetingCode: "ddd-eeee-fff", organizerEmail: "sequoia@westpeek.ventures" });
    expect(e.attendees).toEqual([{ email: "olive@oakfo.com", displayName: "Olive Oak", self: false }]);
  });
});

describe("the sync", () => {
  it("creates exactly one meeting per Meet event, typed by the rule, and none for an event without a link", async () => {
    const out = (await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW }))[0]!;
    expect(out).toMatchObject({ ok: true, via: "api", eventsSeen: 5, created: 4, skippedNoLink: 1, checkIt: 1 });
    const rows = (await env.WP_OS_DB.prepare("SELECT google_event_id, meeting_type, type_inference, privacy_label, company_id, meet_conference_id, meet_link, source, firm_scope FROM meeting WHERE calendar_key = ?1 ORDER BY google_event_id").bind(src.key).all<any>()).results;
    expect(rows.map((r) => [r.google_event_id, r.meeting_type, r.type_inference, r.privacy_label, r.company_id])).toEqual([
      ["ev_founder", "FOUNDER", "COMPANY_DOMAIN", "INTERNAL", "cc_acme"],
      ["ev_internal", "INTERNAL", "FIRM_ONLY", "INTERNAL", null],
      ["ev_lp", "LP", "LP_CONTACT", "LP_PRIVATE", null],
      ["ev_unknown", "FOUNDER", "UNKNOWN_CHECK_IT", "INTERNAL", null],
    ]);
    for (const r of rows) {
      expect(r.source).toBe("google_calendar");
      expect(r.firm_scope).toBe("west-peek");
      expect(r.meet_link).toBe(`https://meet.google.com/${r.meet_conference_id}`);
    }
    const participants = (await env.WP_OS_DB.prepare("SELECT p.participant_type, p.display_name, p.firm_user_id FROM meeting_participant p JOIN meeting m ON m.id = p.meeting_id WHERE m.google_event_id = 'ev_internal' ORDER BY p.display_name").all<any>()).results;
    expect(participants).toEqual([
      { participant_type: "FIRM_USER", display_name: "Scooter Taylor", firm_user_id: "fu_scooter_taylor" },
      { participant_type: "FIRM_USER", display_name: "Sequoia Taylor", firm_user_id: "fu_sequoia_taylor" },
    ]);
  });

  it("is idempotent: a second run creates nothing and the count per event stays one", async () => {
    const again = (await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW }))[0]!;
    expect(again).toMatchObject({ ok: true, created: 0, updated: 0, unchanged: 4 });
    const dup = await env.WP_OS_DB.prepare("SELECT google_event_id, COUNT(*) AS n FROM meeting WHERE calendar_key = ?1 GROUP BY google_event_id HAVING n > 1").bind(src.key).all();
    expect(dup.results).toEqual([]);
  });

  it("follows the calendar for title and time, but never flips a type a person corrected", async () => {
    await env.WP_OS_DB.prepare("UPDATE meeting SET meeting_type = 'LP', privacy_label = 'LP_PRIVATE' WHERE google_event_id = 'ev_unknown'").run();
    g.calendarItems[3] = calendarItem({ id: "ev_unknown", summary: "Coffee with a prospective LP", start: "2026-09-21T16:00:00.000Z", code: "jjj-kkkk-lll", attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "someone@gmail.com" }] });
    const out = (await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW }))[0]!;
    expect(out).toMatchObject({ updated: 1, created: 0 });
    const row = await env.WP_OS_DB.prepare("SELECT title, scheduled_at, meeting_type FROM meeting WHERE google_event_id = 'ev_unknown'").first<any>();
    expect(row).toEqual({ title: "Coffee with a prospective LP", scheduled_at: "2026-09-21T16:00:00.000Z", meeting_type: "LP" });
  });

  it("cancels the meeting when the event is cancelled", async () => {
    g.calendarItems[2] = { ...g.calendarItems[2]!, status: "cancelled" };
    const out = (await runCalendarSync(env, { fetchImpl: g.fetch, now: NOW }))[0]!;
    expect(out.cancelled).toBe(1);
    expect((await env.WP_OS_DB.prepare("SELECT status FROM meeting WHERE google_event_id = 'ev_founder'").first<any>())!.status).toBe("CANCELLED");
  });

  it("serves through the iCal door when the API is down, and the ledger says so", async () => {
    g.calendarApiDown = true;
    g.ics = [
      "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ev_from_ics", "SUMMARY:Board prep", "DTSTART:20260923T150000Z", "DTEND:20260923T160000Z",
      "ATTENDEE:mailto:sequoia@westpeek.ventures", "X-GOOGLE-CONFERENCE:https://meet.google.com/mmm-nnnn-ooo", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const out = await syncCalendar(env, src, { fetchImpl: g.fetch, now: NOW });
    expect(out).toMatchObject({ ok: true, via: "ics", created: 1 });
    expect(out.detail).toContain("via iCal (API failed: http: google responded 503");
    const ledger = await env.WP_OS_DB.prepare("SELECT last_via, last_status FROM google_calendar_sync WHERE calendar_key = ?1").bind(src.key).first<any>();
    expect(ledger).toEqual({ last_via: "ics", last_status: "OK" });
    g.calendarApiDown = false;
  });

  it("fails as a named FAILED row, not silence, when both doors are shut", async () => {
    g.calendarApiDown = true;
    const shut = makeTestEnv(t.db, { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: g.serviceAccountJson });
    const out = await syncCalendar(shut, src, { fetchImpl: g.fetch, now: NOW });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("no second door");
    const ledger = await env.WP_OS_DB.prepare("SELECT last_status, last_detail FROM google_calendar_sync WHERE calendar_key = ?1").bind(src.key).first<any>();
    expect(ledger.last_status).toBe("FAILED");
    g.calendarApiDown = false;
  });

  it("reads ONLY the firm calendar — never a spry.vc mailbox", async () => {
    expect(CALENDAR_SOURCES).toHaveLength(1);
    expect(CALENDAR_SOURCES[0]!.subjectEmail).toBe("sequoia@westpeek.ventures");
    const subjects = new Set<string>();
    for (const r of g.requests.filter((r) => r.url.includes("oauth2.googleapis.com/token"))) void r;
    // Every token minted under impersonation names the firm mailbox and nothing else.
    for (const r of g.requests) if (r.url.includes("spry")) subjects.add(r.url);
    expect([...subjects]).toEqual([]);
    expect(JSON.stringify(g.requests)).not.toMatch(/spry\.vc/);
  });

  it("is reachable as a job and as a route", async () => {
    const job = await env.WP_OS_DB.prepare("SELECT id, job_key, schedule_kind, interval_minutes, status FROM scheduled_job WHERE id = 'sjb_calendar_sync'").first<any>();
    expect(job).toEqual({ id: "sjb_calendar_sync", job_key: "calendar_sync", schedule_kind: "INTERVAL", interval_minutes: 60, status: "ACTIVE" });
    const ledger = await call<any>("/api/meet/calendar");
    expect(ledger.status).toBe(200);
    expect(ledger.body.registered).toEqual([{ calendar_key: "westpeek", subject_email: "sequoia@westpeek.ventures", firm_scope: "west-peek" }]);
    expect(ledger.body.ledger[0].calendar_key).toBe("westpeek");
  });
});
