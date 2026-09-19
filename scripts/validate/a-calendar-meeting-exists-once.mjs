#!/usr/bin/env node
/**
 * a-calendar-meeting-exists-once.mjs — `npm run validate:calendar-sync`.
 *
 * TWO ASSERTIONS, BOTH ABOUT THINGS THAT FAIL SILENTLY.
 *
 * 1 · A CALENDAR EVENT EXISTS HERE AS EXACTLY ONE MEETING. The sync runs every hour, through two
 *     doors (the Calendar API, or the private iCal feed when the API is shut). A sync that creates
 *     a second meeting for an event it has already seen does not error — it produces a meetings
 *     page with the same call listed twice, a Join button on each, and two transcripts of one
 *     conversation, one of which close-out will assign work from. This runs the REAL planning
 *     function (`shared/meetings/calendarSync.ts`) over a fixture through both doors, twice each,
 *     and requires: one create per distinct event on the first pass, zero on the second, the same
 *     identity from either door, and a title change producing one update and no create.
 *
 * 2 · THE TWO BUSINESSES NEVER BLEND. Owner, 18 Sep 2026: "West Peek OS does NOT read the spry.vc
 *     calendar for anything — Boss OS reads that one, never West Peek OS." A spry.vc address, a
 *     staylor@ mailbox or the spry iCal key anywhere in the calendar or Meet code paths is a
 *     violation — read from CODE with comments stripped, so this paragraph cannot trip it and a
 *     comment cannot excuse it.
 *
 * HARD-FAILS ON ZERO: zero fixture events, zero sources scanned, or a registry with no calendar
 * each exit 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` plants each defect and requires it to be caught, beside a clean run that must pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHARED = path.join(ROOT, "src", "shared", "meetings");

/** The code paths that may name a calendar or a Meet mailbox. Tests are not scanned: they assert the absence. */
const GUARDED_SOURCES = [
  "src/shared/meetings/calendarSources.ts",
  "src/shared/meetings/calendarSync.ts",
  "src/shared/meetings/meetTranscript.ts",
  "src/worker/services/calendarSync.ts",
  "src/worker/services/meetIngest.ts",
  "src/worker/effects/googleWorkspaceClient.ts",
  "src/worker/env.ts",
  "scripts/vault/cloudflare-mapping.json",
  "deployment/env-var-registry.json",
];

const BLEND_MARKERS = [/spry\.vc/i, /\bstaylor@/i, /CAL_ICS_STAYLOR_SPRY/, /CAL_ICS_SPRY\b/, /WP_OS_CAL_ICS_SPRY/];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** 2 · Pure: which guarded sources name the other business. */
export function checkNoBlend(sources) {
  const violations = [];
  for (const [rel, raw] of Object.entries(sources)) {
    const code = rel.endsWith(".json") ? raw : stripComments(raw);
    for (const marker of BLEND_MARKERS) {
      if (marker.test(code)) violations.push(`${rel}: names the other business (${marker}) — West Peek OS never reads the spry.vc calendar`);
    }
  }
  return { scanned: Object.keys(sources).length, violations };
}

/** The fixture: one recurring series (two instances), one single event, one cancelled, one without a Meet link, and a duplicate delivery. */
function fixtureApi() {
  const mk = (id, summary, start, code, status = "confirmed") => ({
    id, summary, status,
    start: { dateTime: start }, end: { dateTime: start },
    organizer: { email: "sequoia@westpeek.ventures" },
    attendees: [{ email: "sequoia@westpeek.ventures", self: true }, { email: "guest@example.com" }],
    ...(code ? { hangoutLink: `https://meet.google.com/${code}`, conferenceData: { conferenceId: code, entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/${code}` }] } } : {}),
  });
  return [
    mk("abc123_20260916T130000Z", "Weekly", "2026-09-16T13:00:00Z", "svf-nzzr-pax"),
    mk("abc123_20260923T130000Z", "Weekly", "2026-09-23T13:00:00Z", "svf-nzzr-pax"),
    mk("single1", "Founder intro", "2026-09-18T15:00:00Z", "aaa-bbbb-ccc"),
    mk("single1", "Founder intro", "2026-09-18T15:00:00Z", "aaa-bbbb-ccc"), // delivered twice in one page
    mk("gone1", "Cancelled call", "2026-09-19T15:00:00Z", "ddd-eeee-fff", "cancelled"),
    mk("nolink1", "Dentist", "2026-09-20T15:00:00Z", null),
  ];
}

function fixtureIcs() {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:single1@google.com", "SUMMARY:Founder intro", "DTSTART:20260918T150000Z", "DTEND:20260918T153000Z",
    "ATTENDEE:mailto:guest@example.com", "X-GOOGLE-CONFERENCE:https://meet.google.com/aaa-bbbb-ccc", "END:VEVENT",
    "BEGIN:VEVENT", "UID:abc123@google.com", "RECURRENCE-ID:20260916T130000Z", "SUMMARY:Weekly", "DTSTART:20260916T130000Z", "DTEND:20260916T133000Z",
    "X-GOOGLE-CONFERENCE:https://meet.google.com/svf-nzzr-pax", "END:VEVENT",
    "BEGIN:VEVENT", "UID:nolink1@google.com", "SUMMARY:Dentist", "DTSTART:20260920T150000Z", "DTEND:20260920T160000Z", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Persist a plan the way the service does, into the shape the planner reads back. */
function persist(existing, plan) {
  const rows = [...existing];
  for (const a of plan) {
    if (a.kind === "create") rows.push({ id: `m_${a.event.googleEventId}`, google_event_id: a.event.googleEventId, title: a.event.title, scheduled_at: a.event.startsAt, meet_link: a.event.meetLink, meet_conference_id: a.event.meetingCode, status: "SCHEDULED" });
    if (a.kind === "update") { const r = rows.find((x) => x.id === a.meetingId); Object.assign(r, { title: a.event.title, scheduled_at: a.event.startsAt, meet_link: a.event.meetLink, meet_conference_id: a.event.meetingCode }); }
    if (a.kind === "cancel") rows.find((x) => x.id === a.meetingId).status = "CANCELLED";
  }
  return rows;
}

/** 1 · Pure, given the real module: the identity and idempotency properties over the fixture. */
export function checkExistsOnce(mod, apiItems, ics) {
  const known = { firmDomains: ["westpeek.ventures"], lpEmails: new Set(), lpDomains: new Set(), companyDomains: new Map() };
  const violations = [];
  const apiEvents = apiItems.map(mod.eventFromCalendarApi);
  const distinct = new Set(apiEvents.filter((e) => e.status !== "cancelled" && e.meetingCode).map((e) => e.googleEventId));
  if (apiEvents.length === 0) return { examined: 0, violations: ["zero events in the fixture"] };

  // First pass through the API door.
  const first = mod.planCalendarSync(apiEvents, [], known);
  const creates = first.filter((a) => a.kind === "create");
  if (creates.length !== distinct.size) violations.push(`first pass created ${creates.length} meeting(s) for ${distinct.size} distinct Meet event(s)`);
  if (new Set(creates.map((a) => a.event.googleEventId)).size !== creates.length) violations.push("first pass created two meetings for one event id");
  if (!first.some((a) => a.kind === "skip" && a.reason === "no_meet_link")) violations.push("an event without a Meet link was not named as skipped");
  let rows = persist([], first);

  // Second pass, same calendar: nothing new.
  const second = mod.planCalendarSync(apiEvents, rows, known);
  const again = second.filter((a) => a.kind === "create" || a.kind === "update");
  if (again.length > 0) violations.push(`second pass over an unchanged calendar produced ${again.length} write(s)`);

  // The other door, same events: no create for anything the API already produced.
  const icsEvents = mod.eventsFromIcs(ics);
  if (icsEvents.length === 0) violations.push("the iCal fixture parsed to zero events");
  const viaIcs = mod.planCalendarSync(icsEvents, rows, known);
  const icsCreates = viaIcs.filter((a) => a.kind === "create");
  if (icsCreates.length > 0) violations.push(`the iCal door created ${icsCreates.length} meeting(s) the API door had already created: ${icsCreates.map((a) => a.event.googleEventId).join(", ")}`);

  // A title change is one update and no create; a cancellation is one cancel.
  const renamed = apiItems.map((i) => (i.id === "single1" ? { ...i, summary: "Founder intro (renamed)" } : i));
  const third = mod.planCalendarSync(renamed.map(mod.eventFromCalendarApi), rows, known);
  if (third.filter((a) => a.kind === "update").length !== 1 || third.some((a) => a.kind === "create")) violations.push("a renamed event did not produce exactly one update and zero creates");
  rows = persist(rows, third);
  const cancelledLater = renamed.map((i) => (i.id === "single1" ? { ...i, status: "cancelled" } : i));
  const fourth = mod.planCalendarSync(cancelledLater.map(mod.eventFromCalendarApi), rows, known);
  if (fourth.filter((a) => a.kind === "cancel").length !== 1) violations.push("a cancelled event did not produce exactly one cancel");

  return { examined: apiEvents.length, distinct: distinct.size, violations };
}

function readSources() {
  const out = {};
  for (const rel of GUARDED_SOURCES) out[rel] = readFileSync(path.join(ROOT, rel), "utf8");
  return out;
}

async function loadModule() {
  return loadTs(path.join(SHARED, "calendarSync.ts"));
}

async function selfTest() {
  const mod = await loadModule();
  const clean = checkExistsOnce(mod, fixtureApi(), fixtureIcs());
  if (clean.violations.length > 0) throw new Error(`self-test: clean fixture failed: ${clean.violations.join("; ")}`);

  const empty = checkExistsOnce(mod, [], fixtureIcs());
  if (empty.examined !== 0 || empty.violations.length === 0) throw new Error("self-test: zero events was not caught");

  // A planner that ignores identity — the pre-fix shape: every event becomes a create.
  const broken = { ...mod, planCalendarSync: (events) => events.filter((e) => e.meetingCode).map((event) => ({ kind: "create", event, inference: {} })) };
  const dup = checkExistsOnce(broken, fixtureApi(), fixtureIcs());
  if (!dup.violations.some((v) => /second pass|two meetings|iCal door created/.test(v))) throw new Error("self-test: a duplicating planner was not caught");

  // The iCal door keeping "@google.com" on the UID — the defect this file found on 18 Sep 2026.
  const rawUid = { ...mod, eventsFromIcs: (ics) => mod.eventsFromIcs(ics).map((e) => ({ ...e, googleEventId: `${e.googleEventId}@google.com` })) };
  const twoDoors = checkExistsOnce(rawUid, fixtureApi(), fixtureIcs());
  if (!twoDoors.violations.some((v) => /iCal door created/.test(v))) throw new Error("self-test: a cross-door duplicate was not caught");

  const blend = checkNoBlend({
    "src/shared/meetings/calendarSources.ts": 'export const X = [{ key: "spry", subjectEmail: "staylor@spry.vc" }];',
    "src/worker/env.ts": "interface Env { WP_OS_CAL_ICS_SPRY?: string }",
    "src/worker/services/calendarSync.ts": "// a comment mentioning spry.vc is fine\nconst ok = 1;",
  });
  if (blend.violations.length !== 4) throw new Error(`self-test: expected 4 blend violations, got ${blend.violations.length}: ${blend.violations.join("; ")}`);
  const blendClean = checkNoBlend({ "src/worker/services/calendarSync.ts": "// spry.vc in a comment only\nconst subject = 'sequoia@westpeek.ventures';" });
  if (blendClean.violations.length !== 0) throw new Error("self-test: a comment tripped the blend guard");

  console.log("CALENDAR SYNC SELF-TEST PASSED: 6 fixtures — clean, zero events, a duplicating planner, a cross-door duplicate, four blend markers across two planted sources, a comment-only mention.");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  const mod = await loadModule();
  const sources = readSources();
  const registry = await loadTs(path.join(SHARED, "calendarSources.ts"));
  if (!Array.isArray(registry.CALENDAR_SOURCES) || registry.CALENDAR_SOURCES.length === 0) {
    console.error("CALENDAR SYNC SCAN FAILED — the calendar registry names no calendar.");
    process.exit(1);
  }
  const once = checkExistsOnce(mod, fixtureApi(), fixtureIcs());
  const blend = checkNoBlend(sources);
  if (once.examined === 0 || blend.scanned === 0) {
    console.error(`CALENDAR SYNC SCAN FAILED — examined ${once.examined} events and ${blend.scanned} sources.`);
    process.exit(1);
  }
  const violations = [...once.violations, ...blend.violations];
  if (violations.length > 0) {
    console.error("CALENDAR SYNC SCAN FAILED:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `CALENDAR SYNC SCAN PASSED: ${once.examined} fixture event(s) (${once.distinct} distinct Meet events) exist as exactly one meeting each ` +
      `through both doors and across four passes; ${registry.CALENDAR_SOURCES.length} calendar registered (${registry.CALENDAR_SOURCES.map((s) => s.subjectEmail).join(", ")}); ` +
      `${blend.scanned} guarded sources name no spry.vc mailbox or key.`,
  );
}

main().catch((err) => {
  console.error(`CALENDAR SYNC SCAN FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
