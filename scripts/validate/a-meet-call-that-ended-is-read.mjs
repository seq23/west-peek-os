#!/usr/bin/env node
/**
 * a-meet-call-that-ended-is-read.mjs — `npm run validate:meet-ingest`.
 *
 * A MEET CALL THAT ENDED IS READ EXACTLY ONCE, WITH THE ATTRIBUTION MEET GAVE IT AND NO MORE.
 *
 * Four properties, each of which fails silently if broken:
 *
 *   1 · ONE INGEST PER ENDED CONFERENCE. The ingest hears about a conference from Pub/Sub AND
 *       from polling, sometimes both, sometimes twice. A fixture of heard events (duplicates,
 *       both doors, a still-live call) must resolve to exactly one inbox identity per ended
 *       conference — the same reduction `meet_event_inbox.conference_record UNIQUE` enforces.
 *   2 · UNATTRIBUTED TURNS STAY UNATTRIBUTED. An entry Meet did not attribute, or attributed to a
 *       participant resource not in the list, must come back with `speaker: null` and render as
 *       "Speaker not named" — never handed to the nearest name. Close-out assigns work from these
 *       turns; an invented attribution is a task for somebody who never agreed to it.
 *   3 · LP MEETINGS ARE PRIVATE BY CONSTRUCTION. The inference that types a meeting LP must label
 *       it LP_PRIVATE, and the note writer must bind the MEETING'S label onto every derived note
 *       (read from code, not prose) — that label is what the router's default-deny data policy
 *       keys on, so a training-permitting lane can never see the words.
 *   4 · THE GOVERNED PATH IS THE ONLY PATH. `meetIngest.ts` must reach the transcript through
 *       `ingestTranscript(` and must not INSERT into meeting_note or transcript_import itself; and
 *       the field that unlocks platform-announced consent must not be on the HTTP ingest schema.
 *
 * HARD-FAILS ON ZERO fixtures, zero turns, or zero sources read.
 *
 * `--self-test` plants each defect and requires it to be caught, beside a clean run that must pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHARED = path.join(ROOT, "src", "shared", "meetings");
const SOURCES = {
  ingest: "src/worker/services/meetIngest.ts",
  adapter: "src/worker/services/captureAdapter.ts",
  meetings: "src/worker/services/meetings.ts",
  live: "src/worker/services/meetLive.ts",
};

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Ended conferences as the two doors report them: pubsub twice, poll once, plus one still live. */
function fixtureHeard() {
  // `record` is the fixture's own statement of which conference each hearing is about — the
  // ground truth the reduction is checked against, independent of the code under test.
  return [
    { via: "pubsub", resource: "conferenceRecords/lp1/transcripts/t1", record: "conferenceRecords/lp1", ended: true },
    { via: "pubsub", resource: "conferenceRecords/lp1", record: "conferenceRecords/lp1", ended: true },
    { via: "poll", resource: "conferenceRecords/lp1", record: "conferenceRecords/lp1", ended: true },
    { via: "poll", resource: "conferenceRecords/int1", record: "conferenceRecords/int1", ended: true },
    { via: "pubsub", resource: "conferenceRecords/int1/recordings/r1", record: "conferenceRecords/int1", ended: true },
    { via: "poll", resource: "conferenceRecords/live1", record: "conferenceRecords/live1", ended: false },
  ];
}

function fixtureTranscripts() {
  const participants = (r) => [
    { name: `${r}/participants/p1`, displayName: "Sequoia Taylor", kind: "SIGNED_IN", userResource: "users/1", earliestStartTime: null, latestEndTime: null },
    { name: `${r}/participants/p2`, displayName: "Olive Oak", kind: "SIGNED_IN", userResource: "users/2", earliestStartTime: null, latestEndTime: null },
  ];
  const entry = (r, p, text, at) => ({ name: `${r}/transcripts/t1/entries/${at}`, participant: p ? `${r}/participants/${p}` : null, text, languageCode: "en", startTime: `2026-09-17T16:${at}Z`, endTime: null });
  return [
    {
      record: "conferenceRecords/lp1", meetingType: "LP", attendees: [{ email: "sequoia@westpeek.ventures", displayName: null, self: true }, { email: "olive@oakfo.com", displayName: "Olive Oak", self: false }],
      participants: participants("conferenceRecords/lp1"),
      entries: [
        entry("conferenceRecords/lp1", "p1", "Thanks for making time.", "00:05"),
        entry("conferenceRecords/lp1", "p2", "What is the commitment amount?", "00:20"),
        entry("conferenceRecords/lp1", null, "Can everyone hear me?", "00:30"),
        entry("conferenceRecords/lp1", "p9", "I think so.", "00:33"),
      ],
      expectUnattributed: 2,
    },
    {
      record: "conferenceRecords/int1", meetingType: "INTERNAL", attendees: [{ email: "sequoia@westpeek.ventures", displayName: null, self: true }, { email: "scooter@westpeek.ventures", displayName: null, self: false }],
      participants: participants("conferenceRecords/int1"),
      entries: [entry("conferenceRecords/int1", "p1", "Let's go through the week.", "00:02"), entry("conferenceRecords/int1", "p1", "First, the pipeline.", "00:06")],
      expectUnattributed: 0,
    },
  ];
}

/** 1 · The reduction the inbox performs, expressed over the fixture. */
export function checkOneIngestEach(mod, heard) {
  const violations = [];
  const identities = new Map();
  for (const h of heard) {
    const record = mod.conferenceRecordOf(h.resource);
    if (!record) { violations.push(`could not name a conference for ${h.resource}`); continue; }
    if (record !== h.record) violations.push(`${h.resource} was keyed as ${record}, not ${h.record}`);
    identities.set(record, (identities.get(record) ?? 0) + 1);
  }
  const ended = new Set(heard.filter((h) => h.ended).map((h) => h.record));
  const live = new Set(heard.filter((h) => !h.ended).map((h) => h.record));
  for (const record of ended) if (!identities.has(record)) violations.push(`${record} was heard about and has no identity`);
  // The inbox row is keyed by conference record, so however many times it was heard, one row.
  const rows = [...identities.keys()].filter((r) => !live.has(r));
  if (rows.length !== ended.size) violations.push(`${heard.length} hearings about ${ended.size} ended conference(s) produced ${rows.length} inbox identities`);
  return { heard: heard.length, ended: ended.size, violations };
}

/** 2 · Attribution is a join, and a failed join stays null. */
export function checkAttribution(mod, fixtures) {
  const violations = [];
  let turns = 0;
  for (const f of fixtures) {
    const out = mod.turnsFromMeet(f.entries, f.participants);
    turns += out.turns.length;
    if (out.unattributed !== f.expectUnattributed) violations.push(`${f.record}: ${out.unattributed} unattributed turn(s), expected ${f.expectUnattributed} — an attribution was invented or lost`);
    for (const t of out.turns) {
      const known = f.participants.some((p) => p.displayName === t.speaker);
      if (t.speaker !== null && !known) violations.push(`${f.record}: a turn was attributed to "${t.speaker}", who is not in the participant list`);
    }
    const text = mod.meetTranscriptText(out.turns);
    const nulls = out.turns.filter((t) => t.speaker === null).length;
    const said = (text.match(/Speaker not named in the export/g) ?? []).length;
    if (said !== nulls) violations.push(`${f.record}: ${nulls} unattributed turn(s) but ${said} say so in the rendered text`);
    if (out.turns.some((t) => !t.text.trim())) violations.push(`${f.record}: an empty turn was written`);
  }
  return { fixtures: fixtures.length, turns, violations };
}

/** 3 · LP meetings are LP_PRIVATE from inference, and every derived note inherits the meeting's label. */
export function checkPrivateClass(calMod, fixtures, adapterSource) {
  const violations = [];
  const known = { firmDomains: ["westpeek.ventures"], lpEmails: new Set(["olive@oakfo.com"]), lpDomains: new Set(), companyDomains: new Map() };
  let lpSeen = 0;
  for (const f of fixtures) {
    const inf = calMod.inferMeetingType(f.attendees, known);
    if (inf.meetingType !== f.meetingType) violations.push(`${f.record}: inferred ${inf.meetingType}, fixture says ${f.meetingType}`);
    if (f.meetingType === "LP") {
      lpSeen += 1;
      if (inf.privacyLabel !== "LP_PRIVATE") violations.push(`${f.record}: an LP meeting was labelled ${inf.privacyLabel}, not LP_PRIVATE`);
    }
  }
  if (lpSeen === 0) violations.push("the fixture holds no LP meeting, so the private class was not exercised");
  const code = stripComments(adapterSource);
  const insert = /INSERT INTO meeting_note[\s\S]*?\.bind\(([\s\S]*?)\)\s*\.run\(\)/.exec(code);
  if (!insert) violations.push("captureAdapter.ts: could not find the meeting_note INSERT");
  else if (!/meeting\.privacy_label/.test(insert[1])) violations.push("captureAdapter.ts: the meeting_note INSERT does not bind the meeting's own privacy_label onto the derived note");
  return { lpSeen, violations };
}

/** 4 · The only path is the governed one, and the request schema cannot claim a platform. */
export function checkGovernedPath(sources) {
  const violations = [];
  const ingest = stripComments(sources.ingest);
  if (!/\bingestTranscript\(/.test(ingest)) violations.push("meetIngest.ts: does not reach the transcript through ingestTranscript()");
  if (/INSERT INTO meeting_note/i.test(ingest)) violations.push("meetIngest.ts: writes meeting_note directly, around the governed import");
  if (/INSERT INTO transcript_import/i.test(ingest)) violations.push("meetIngest.ts: writes transcript_import directly, around the governed import");
  if (!/recordPlatformAnnouncedConsent/.test(ingest) || !/google_meet_announced/.test(ingest)) violations.push("meetIngest.ts: platform-announced consent is not recorded under its named basis");
  if (!/source !== "google_calendar"/.test(ingest)) violations.push("meetIngest.ts: platform-announced consent is not refused for a meeting that was typed in by hand");
  const adapter = stripComments(sources.adapter);
  const schema = /const ingestSchema = z\.object\(\{([\s\S]*?)\}\);/.exec(adapter);
  if (!schema) violations.push("captureAdapter.ts: could not find ingestSchema");
  else if (/platform/.test(schema[1])) violations.push("captureAdapter.ts: the HTTP ingest schema accepts a platform, so a request could claim platform-announced consent");
  const meetings = stripComments(sources.meetings);
  // Tier 4 (19 Sep 2026) added the live listener's provider. EXACTLY these two, in this order:
  // the official transcript and what was heard live — both SYSTEM-actor imports under the
  // platform-announced consent, and nothing a request can name.
  if (!/PLATFORM_NATIVE_TRANSCRIPT_PROVIDERS\s*=\s*\[\s*"GOOGLE_MEET",\s*"GOOGLE_MEET_LIVE"\s*\]/.test(meetings)) violations.push("meetings.ts: the platform-native exception is not exactly [\"GOOGLE_MEET\", \"GOOGLE_MEET_LIVE\"]");
  const live = stripComments(sources.live);
  if (!/platform:\s*LIVE_PROVIDER/.test(live)) violations.push("meetLive.ts: the live slice does not enter the import as the platform-native provider (platform: LIVE_PROVIDER)");
  if (!/actor\.type !== "HUMAN" && !platformNative/.test(meetings)) violations.push("meetings.ts: a non-human import is no longer refused unless platform-native");
  if (!/recording_enabled !== 1/.test(meetings) || !/consent\.state !== "GRANTED"/.test(meetings)) violations.push("meetings.ts: importTranscript no longer checks both gates");
  return { checked: Object.keys(sources).length, violations };
}

function readSources() {
  return Object.fromEntries(Object.entries(SOURCES).map(([k, rel]) => [k, readFileSync(path.join(ROOT, rel), "utf8")]));
}

async function selfTest() {
  const mod = await loadTs(path.join(SHARED, "meetTranscript.ts"));
  const calMod = await loadTs(path.join(SHARED, "calendarSync.ts"));
  const sources = readSources();
  const fixtures = fixtureTranscripts();

  const clean = [checkOneIngestEach(mod, fixtureHeard()), checkAttribution(mod, fixtures), checkPrivateClass(calMod, fixtures, sources.adapter), checkGovernedPath(sources)];
  const cleanViolations = clean.flatMap((c) => c.violations);
  if (cleanViolations.length > 0) throw new Error(`self-test: clean run failed: ${cleanViolations.join("; ")}`);

  // A join that hands an unknown participant to the nearest name above — the guess this file forbids.
  const guessing = {
    ...mod,
    turnsFromMeet: (entries, participants) => {
      const out = mod.turnsFromMeet(entries, participants);
      let last = null;
      for (const t of out.turns) { if (t.speaker) last = t.speaker; else t.speaker = last; }
      return { ...out, unattributed: 0 };
    },
  };
  if (!checkAttribution(guessing, fixtures).violations.some((v) => /invented or lost/.test(v))) throw new Error("self-test: a guessing join was not caught");

  // A renderer that drops the "not named" marker.
  const bare = { ...mod, meetTranscriptText: (turns) => turns.map((t) => `${t.speaker ?? ""}: ${t.text}`).join("\n") };
  if (!checkAttribution(bare, fixtures).violations.some((v) => /say so in the rendered text/.test(v))) throw new Error("self-test: a bare renderer was not caught");

  // An identity that keys by resource rather than by conference: two rows for one call.
  const perResource = { ...mod, conferenceRecordOf: (r) => r };
  if (!checkOneIngestEach(perResource, fixtureHeard()).violations.some((v) => /inbox identities|was keyed as/.test(v))) throw new Error("self-test: a per-resource identity was not caught");

  // An inference that files LP calls as INTERNAL.
  const blind = { ...calMod, inferMeetingType: () => ({ meetingType: "INTERNAL", inference: "FIRM_ONLY", companyId: null, privacyLabel: "INTERNAL" }) };
  if (!checkPrivateClass(blind, fixtures, sources.adapter).violations.some((v) => /inferred INTERNAL/.test(v))) throw new Error("self-test: an LP-blind inference was not caught");

  // A note writer that hard-codes INTERNAL.
  const flatAdapter = sources.adapter.replace(/meeting\.privacy_label, meeting\.firm_scope,/, "'INTERNAL', meeting.firm_scope,");
  if (!checkPrivateClass(calMod, fixtures, flatAdapter).violations.some((v) => /does not bind the meeting's own privacy_label/.test(v))) throw new Error("self-test: a flat-label note writer was not caught");

  // An ingest that writes notes directly, and a schema that accepts a platform.
  const around = { ...sources, ingest: `${sources.ingest}\nawait env.WP_OS_DB.prepare("INSERT INTO meeting_note (id) VALUES (?1)").run();` };
  if (!checkGovernedPath(around).violations.some((v) => /writes meeting_note directly/.test(v))) throw new Error("self-test: a direct note write was not caught");
  const claiming = { ...sources, adapter: sources.adapter.replace("document_id: z.string().max(80).nullish(),", 'document_id: z.string().max(80).nullish(),\n  platform: z.literal("GOOGLE_MEET").optional(),') };
  if (!checkGovernedPath(claiming).violations.some((v) => /accepts a platform/.test(v))) throw new Error("self-test: a platform-claiming schema was not caught");
  // A third platform-native provider nobody argued for, and a live slice imported as an ordinary one.
  const widened = { ...sources, meetings: sources.meetings.replace('["GOOGLE_MEET", "GOOGLE_MEET_LIVE"]', '["GOOGLE_MEET", "GOOGLE_MEET_LIVE", "ZOOM"]') };
  if (!checkGovernedPath(widened).violations.some((v) => /not exactly/.test(v))) throw new Error("self-test: a widened platform-native list was not caught");
  const plain = { ...sources, live: sources.live.replace("platform: LIVE_PROVIDER", "platform: undefined") };
  if (!checkGovernedPath(plain).violations.some((v) => /live slice does not enter/.test(v))) throw new Error("self-test: a live slice imported without its provider was not caught");

  if (checkAttribution(mod, []).fixtures !== 0) throw new Error("self-test: zero fixtures miscounted");
  console.log("MEET INGEST SELF-TEST PASSED: 10 fixtures — clean, a guessing join, a bare renderer, a per-resource identity, an LP-blind inference, a flat-label note writer, a direct note write, a platform-claiming schema, a widened platform-native list, a live slice without its provider.");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  const mod = await loadTs(path.join(SHARED, "meetTranscript.ts"));
  const calMod = await loadTs(path.join(SHARED, "calendarSync.ts"));
  const sources = readSources();
  const fixtures = fixtureTranscripts();
  const once = checkOneIngestEach(mod, fixtureHeard());
  const attribution = checkAttribution(mod, fixtures);
  const privateClass = checkPrivateClass(calMod, fixtures, sources.adapter);
  const governed = checkGovernedPath(sources);
  if (fixtures.length === 0 || attribution.turns === 0 || once.ended === 0 || governed.checked === 0) {
    console.error(`MEET INGEST SCAN FAILED — examined ${fixtures.length} fixture(s), ${attribution.turns} turn(s), ${once.ended} ended conference(s), ${governed.checked} source(s).`);
    process.exit(1);
  }
  const violations = [...once.violations, ...attribution.violations, ...privateClass.violations, ...governed.violations];
  if (violations.length > 0) {
    console.error("MEET INGEST SCAN FAILED:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `MEET INGEST SCAN PASSED: ${once.heard} hearings resolve to ${once.ended} ended conference(s), one ingest identity each; ` +
      `${attribution.turns} turn(s) across ${fixtures.length} fixture(s) attributed only by participant join, ${fixtures.reduce((n, f) => n + f.expectUnattributed, 0)} kept unattributed and said so; ` +
      `${privateClass.lpSeen} LP meeting(s) labelled LP_PRIVATE and every derived note inherits the meeting's label; ` +
      `the ingest reaches transcripts only through ingestTranscript() and no request can claim a platform.`,
  );
}

main().catch((err) => {
  console.error(`MEET INGEST SCAN FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
