#!/usr/bin/env node
/**
 * the-room-hears-only-a-firm-meet.mjs — `npm run validate:meet-live`.
 *
 * THE ROOM HEARS A GOOGLE MEET LIVE ONLY FOR A FIRM-HOSTED CALL, WITH CONSENT ON THE RECORD, AND
 * THE AUDIO GOES NOWHERE BUT WORKERS AI.
 *
 * Tier 4 (migration 0215) puts the OS in a call as a participant. That is the most consequential
 * thing this repo does with sound, so the properties below are read from CODE, not from the
 * paragraphs above the code, and each one fails the build on its own:
 *
 *   1 · THE GATES COME BEFORE THE SESSION. In `meetLive.ts`, `openSession` must refuse a meeting
 *       that is not a firm-hosted Meet (`isFirmHostedMeet`), read the firm recording default
 *       (`firmRecordingPolicy`), record platform-announced consent
 *       (`recordPlatformAnnouncedConsent`) and authorise `meet.live.join` — and every one of those
 *       must appear BEFORE the INSERT that writes a JOINING session. A session written first and
 *       gated after is a live microphone with a promise attached.
 *   2 · THE HEARTBEAT OFFERS ONLY CALENDAR MEETS. The due query must bind `source =
 *       'google_calendar'` and `meet_conference_id IS NOT NULL`; a manual meeting is never even
 *       offered to the listener.
 *   3 · THE ONLY WAY IN IS THE GOVERNED IMPORT. `meetLive.ts` reaches the words through
 *       `transcribeWithSpeakers(` and the record through `ingestTranscript(`; it must not INSERT
 *       into meeting_note or transcript_import itself, and must not call `fetch(` at all.
 *   4 · THE NETWORK BOUNDARY OF THE LISTENER. `listener-core.mjs` makes no network call of its
 *       own (everything is injected); `meet-media-page.js` — the browser peer — makes none either
 *       (no fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource); `live-listener.mjs` fetches
 *       only `${BASE_URL}…`; and `audio_base64` is handed only to the Worker's `/chunk` route.
 *       Google's hosts are fixed in `googleWorkspaceClient.ts` and are all googleapis.com.
 *   5 · THE AUDIO REACHES WORKERS AI THROUGH THE BINDING, WITH `mip_opt_out: true`. The two speech
 *       adapters call `binding.run(` and nothing else; neither contains `fetch(`.
 *   6 · THE STATES ARE ONE VOCABULARY. `MEET_LIVE_STATES` in `meetLiveView.ts` and the CHECK on
 *       `meeting.meet_live_state` in migration 0215 must list the same names — a state the During
 *       face renders that the database refuses, or the reverse, is a page that lies.
 *   7 · LP AND BROKER MEETINGS NEVER JOIN LIVE. The owner's rule (19 Sep 2026): the Meet Media API
 *       is Pre-GA and term (vi) of the Developer Preview terms lets Google use what passes through
 *       it, so an LP conversation never does. `openSession` must call `liveAllowedForType(` before
 *       the INSERT, and the REAL function, loaded from TypeScript, must refuse a planted LP meeting
 *       and a planted Broker meeting while admitting the four types that may join.
 *
 * HARD-FAILS ON ZERO sources, zero states, or zero gates found.
 *
 * `--self-test` plants each defect and requires it to be caught, beside a clean run that must pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCES = {
  live: "src/worker/services/meetLive.ts",
  view: "src/worker/services/meetLiveView.ts",
  migration: "migrations/0215_the_room_hears_the_meet_live.sql",
  core: "scripts/meet/lib/listener-core.mjs",
  page: "scripts/meet/lib/meet-media-page.js",
  cli: "scripts/meet/live-listener.mjs",
  google: "src/worker/effects/googleWorkspaceClient.ts",
  nova: "src/worker/ai/providers/workersAiNova3.ts",
  whisper: "src/worker/ai/providers/workersAiWhisper.ts",
};

function readSources() {
  const out = {};
  for (const [k, rel] of Object.entries(SOURCES)) out[k] = stripCommentsFor(rel, readFileSync(path.join(ROOT, rel), "utf8"));
  return out;
}

function fnBody(source, name) {
  const at = source.indexOf(`export async function ${name}(`);
  if (at < 0) return null;
  const next = source.slice(at + 1).search(/\n(export )?(async )?function |\n\/\/ ──|\nexport const /);
  return next < 0 ? source.slice(at) : source.slice(at, at + 1 + next);
}

/** 1 · the gates before the session. */
export function checkGates(live) {
  const violations = [];
  const body = fnBody(live, "openSession");
  if (!body) return { violations: ["meetLive.ts has no openSession — the gated door is gone"], gates: 0 };
  const insert = body.search(/INSERT INTO meet_live_session[\s\S]*?'JOINING'/);
  if (insert < 0) violations.push("openSession never writes a JOINING session — nothing to gate");
  const gates = [
    ["isFirmHostedMeet(", "the calendar-synced-with-a-conference check"],
    ["liveAllowedForType(", "the meeting-type rule (LP and Broker never join live)"],
    ["firmRecordingPolicy(", "the firm recording default"],
    ["recordPlatformAnnouncedConsent(", "platform-announced consent"],
    ['"meet.live.join"', "authorisation of meet.live.join"],
  ];
  let found = 0;
  for (const [needle, what] of gates) {
    const at = body.indexOf(needle);
    if (at < 0) violations.push(`openSession does not check ${what} (${needle})`);
    else if (insert >= 0 && at > insert) violations.push(`openSession checks ${what} AFTER writing the session — a live microphone with a promise attached`);
    else found += 1;
  }
  return { violations, gates: found };
}

/** 2 · the heartbeat offers only calendar Meets. */
export function checkHeartbeat(live) {
  const violations = [];
  const body = fnBody(live, "heartbeat");
  if (!body) return { violations: ["meetLive.ts has no heartbeat"], checked: 0 };
  if (!/source = 'google_calendar'/.test(body)) violations.push("the heartbeat's due query does not require source = 'google_calendar' — a manual meeting could be offered to the listener");
  if (!/meet_conference_id IS NOT NULL/.test(body)) violations.push("the heartbeat's due query does not require a Meet conference id");
  return { violations, checked: 1 };
}

/** 3 · the only way in is the governed import. */
export function checkGovernedPath(live) {
  const violations = [];
  if (!/transcribeWithSpeakers\(/.test(live)) violations.push("meetLive.ts does not reach the words through transcribeWithSpeakers(");
  if (!/ingestTranscript\(/.test(live)) violations.push("meetLive.ts does not reach the record through ingestTranscript(");
  if (/INSERT INTO meeting_note/i.test(live)) violations.push("meetLive.ts writes meeting_note directly — around the governed import");
  if (/INSERT INTO transcript_import/i.test(live)) violations.push("meetLive.ts writes transcript_import directly — around the two gates");
  if (/\bfetch\(/.test(live)) violations.push("meetLive.ts calls fetch( — the Worker side of the live path talks to no network host");
  return { violations, checked: 1 };
}

const NETWORK_CALL = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|sendBeacon\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b/;

/** 4 · the listener's network boundary. */
export function checkListenerBoundary(sources) {
  const violations = [];
  if (NETWORK_CALL.test(sources.core)) violations.push("listener-core.mjs makes a network call of its own — every side effect must be injected so the loop can be proven against fakes");
  if (NETWORK_CALL.test(sources.page)) violations.push("meet-media-page.js makes a network call — the browser peer must hand everything to Node and talk to nobody");
  if (!/RTCPeerConnection\(/.test(sources.page)) violations.push("meet-media-page.js has no RTCPeerConnection — the peer is gone");
  const fetches = [...sources.cli.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  if (fetches.length === 0) violations.push("live-listener.mjs never calls the Worker");
  for (const target of fetches) if (!/^`\$\{BASE_URL\}/.test(target)) violations.push(`live-listener.mjs fetches ${target} — only \${BASE_URL}… is allowed`);
  // audio_base64 leaves the listener only towards a /chunk route on the Worker.
  for (const [name, src] of [["listener-core.mjs", sources.core], ["live-listener.mjs", sources.cli]]) {
    for (const m of src.matchAll(/audio_base64/g)) {
      const around = src.slice(Math.max(0, m.index - 400), m.index + 200);
      if (!/\/chunk`|\/chunk\b/.test(around) && !/onSlice|__wposSlice|slice/.test(around)) violations.push(`${name} handles audio_base64 away from the /chunk route`);
    }
    for (const m of src.matchAll(/\/chunk/g)) {
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
      // A chunk URL handed to a fetch or to a host of its own is audio leaving by another door.
      if (/\bfetch\(|:\/\//.test(line) && !/deps\.worker\(|workerCall\(/.test(line)) violations.push(`${name}: a /chunk call that is not through the Worker wire: ${line.trim().slice(0, 100)}`);
    }
  }
  const hosts = [...sources.google.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
  const foreign = hosts.filter((h) => !/(^|\.)googleapis\.com$|(^|\.)google\.com$/.test(h));
  if (hosts.length === 0) violations.push("googleWorkspaceClient.ts names no host");
  if (foreign.length > 0) violations.push(`googleWorkspaceClient.ts names a host that is not Google's: ${[...new Set(foreign)].join(", ")}`);
  return { violations, fetches: fetches.length, hosts: new Set(hosts).size };
}

/** 5 · the audio reaches Workers AI through the binding, opted out of model improvement. */
export function checkSpeechAdapters(sources) {
  const violations = [];
  for (const [name, src] of [["workersAiNova3.ts", sources.nova], ["workersAiWhisper.ts", sources.whisper]]) {
    if (!/binding!?\.run\(/.test(src) && !/\.run\(/.test(src)) violations.push(`${name} does not call the binding's run(`);
    if (/\bfetch\(/.test(src)) violations.push(`${name} calls fetch( — audio must go through the Workers AI binding, never a vendor host`);
  }
  if (!/mip_opt_out:\s*true/.test(sources.nova)) violations.push("workersAiNova3.ts no longer sets mip_opt_out: true — the audio would be a contribution to the vendor's model");
  return { violations, checked: 2 };
}

/** 6 · the states are one vocabulary. */
export function checkStates(sources) {
  const violations = [];
  const tsBlock = /MEET_LIVE_STATES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(sources.view);
  const ts = tsBlock ? [...tsBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
  const sqlBlock = /meet_live_state\s+TEXT\s*CHECK\s*\(([\s\S]*?)\)\s*\)\s*;/.exec(sources.migration);
  const sql = sqlBlock ? [...sqlBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  if (ts.length === 0) violations.push("meetLiveView.ts declares no MEET_LIVE_STATES");
  if (sql.length === 0) violations.push("migration 0215 has no CHECK on meeting.meet_live_state");
  for (const s of ts) if (!sql.includes(s)) violations.push(`state ${s} is rendered by the During face but refused by the database`);
  for (const s of sql) if (!ts.includes(s)) violations.push(`state ${s} is admitted by the database but unknown to the During face`);
  return { violations, states: ts.length };
}

/** 7 · the owner's rule, run against the real function with planted meetings. */
export function checkTypeRule(view) {
  const violations = [];
  const planted = [
    { title: "Oak Family Office catch-up", meeting_type: "LP", allowed: false },
    { title: "Placement agent call", meeting_type: "BROKER", allowed: false },
    { title: "Partners sync", meeting_type: "INTERNAL", allowed: true },
    { title: "Acme intro", meeting_type: "FOUNDER", allowed: true },
    { title: "Acme diligence", meeting_type: "DILIGENCE", allowed: true },
    { title: "Portfolio check-in", meeting_type: "PORTFOLIO", allowed: true },
  ];
  if (typeof view.liveAllowedForType !== "function") return { violations: ["meetLiveView.ts exports no liveAllowedForType — the owner's rule has no function"], planted: 0 };
  for (const m of planted) {
    const got = view.liveAllowedForType(m.meeting_type);
    if (got !== m.allowed) violations.push(`a planted ${m.meeting_type} meeting ("${m.title}") would ${got ? "JOIN the live media stream" : "be refused"} — the owner's rule says ${m.allowed ? "it may" : "it never does"}`);
  }
  const excluded = Array.isArray(view.LIVE_EXCLUDED_MEETING_TYPES) ? [...view.LIVE_EXCLUDED_MEETING_TYPES].sort() : [];
  if (excluded.join(",") !== "BROKER,LP") violations.push(`LIVE_EXCLUDED_MEETING_TYPES is [${excluded.join(", ")}], not exactly LP and BROKER`);
  return { violations, planted: planted.length };
}

function runAll(sources, view) {
  const results = [checkGates(sources.live), checkHeartbeat(sources.live), checkGovernedPath(sources.live), checkListenerBoundary(sources), checkSpeechAdapters(sources), checkStates(sources), checkTypeRule(view)];
  return { violations: results.flatMap((r) => r.violations), gates: results[0].gates, states: results[5].states, fetches: results[3].fetches, hosts: results[3].hosts, planted: results[6].planted };
}

async function selfTest() {
  const sources = readSources();
  const view = await loadTs(path.join(ROOT, "src", "worker", "services", "meetLiveView.ts"));
  const clean = runAll(sources, view);
  if (clean.violations.length > 0) throw new Error(`self-test: clean run failed: ${clean.violations.join("; ")}`);
  const expect = (label, mutated, pattern, mutatedView = view) => {
    const out = runAll(mutated, mutatedView);
    if (!out.violations.some((v) => pattern.test(v))) throw new Error(`self-test: ${label} was not caught (got: ${out.violations.join("; ") || "nothing"})`);
  };
  // NEGATIVE PROOF OF THE OWNER'S RULE: a rule that lets an LP meeting through, and a join without the gate.
  expect("an LP meeting allowed to join live", sources, /planted LP meeting .* would JOIN/, { ...view, liveAllowedForType: (t) => t !== "BROKER" });
  expect("a Broker meeting allowed to join live", sources, /planted BROKER meeting .* would JOIN/, { ...view, liveAllowedForType: (t) => t !== "LP" });
  expect("a rule that refuses founders too", sources, /planted FOUNDER meeting .* be refused/, { ...view, liveAllowedForType: (t) => t === "INTERNAL" });
  expect("the type gate removed from openSession", { ...sources, live: sources.live.replace(/  if \(!liveAllowedForType\(meeting\.meeting_type\)\) \{[\s\S]*?\n  \}\n/, "") }, /does not check the meeting-type rule/);
  // a · the firm-hosted check removed
  expect("a session opened without the firm-hosted check", { ...sources, live: sources.live.replace(/if \(!isFirmHostedMeet\(meeting\)\) \{[\s\S]*?\n  \}\n/, "") }, /does not check the calendar-synced/);
  // b · the consent recorded after the session is written
  const consentCall = /  let consent: \{ transcription: string; recording: string \};\n  try \{\n    consent = await recordPlatformAnnouncedConsent\(env, actor, meeting, input\.conference_record\);\n  \} catch \(err\) \{[\s\S]*?\n  \}\n/;
  const moved = sources.live.replace(consentCall, "").replace(/(  await setMeetLiveState\(env, meeting\.id, "meet_live_joining")/, '  const consent = await recordPlatformAnnouncedConsent(env, actor, meeting, input.conference_record);\n$1');
  expect("consent recorded after the session", { ...sources, live: moved }, /AFTER writing the session/);
  // c · a manual meeting offered to the listener
  expect("a due query without the calendar filter", { ...sources, live: sources.live.replace("m.source = 'google_calendar' AND ", "") }, /manual meeting could be offered/);
  // d · a direct note write
  expect("a direct note write", { ...sources, live: `${sources.live}\nawait env.WP_OS_DB.prepare("INSERT INTO meeting_note (id) VALUES (?1)").run();` }, /writes meeting_note directly/);
  // e · the core fetching for itself
  expect("a core that fetches", { ...sources, core: `${sources.core}\nawait fetch("https://example.com");` }, /listener-core\.mjs makes a network call/);
  // f · the page talking to the network
  expect("a page that talks", { ...sources, page: sources.page.replace("window.__wpos = {", 'navigator.sendBeacon("https://x.example/audio", "…");\nwindow.__wpos = {') }, /meet-media-page\.js makes a network call/);
  // g · the CLI fetching a second host
  expect("a CLI fetching elsewhere", { ...sources, cli: `${sources.cli}\nawait fetch("https://api.vendor.example/upload", { body: audio_base64 });` }, /only \$\{BASE_URL\}/);
  // h · a state the database refuses
  expect("a state the database refuses", { ...sources, view: sources.view.replace('"meet_live_failed",', '"meet_live_failed",\n  "meet_live_dreaming",') }, /refused by the database/);
  // i · mip_opt_out removed
  expect("mip_opt_out removed", { ...sources, nova: sources.nova.replace("mip_opt_out: true", "mip_opt_out: false") }, /mip_opt_out/);
  // j · a vendor host in the speech adapter
  expect("a speech adapter that fetches", { ...sources, nova: `${sources.nova}\nawait fetch("https://api.deepgram.com/v1/listen");` }, /audio must go through the Workers AI binding/);
  console.log("MEET LIVE SELF-TEST PASSED: 14 fixtures — clean, an LP meeting allowed live, a Broker meeting allowed live, founders refused, the type gate removed, no firm-hosted check, consent after the session, a manual meeting offered, a direct note write, a fetching core, a talking page, a CLI fetching elsewhere, a state the database refuses, mip_opt_out removed, a speech adapter that fetches.");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }
  const sources = readSources();
  const view = await loadTs(path.join(ROOT, "src", "worker", "services", "meetLiveView.ts"));
  const out = runAll(sources, view);
  if (Object.keys(sources).length === 0 || out.gates === 0 || out.states === 0 || out.planted === 0) {
    console.error(`MEET LIVE SCAN FAILED — examined ${Object.keys(sources).length} source(s), ${out.gates} gate(s), ${out.states} state(s), ${out.planted} planted meeting(s). Rule 0.`);
    process.exit(1);
  }
  if (out.violations.length > 0) {
    console.error("MEET LIVE SCAN FAILED — the room could hear something it must not, or send it somewhere it must not:");
    for (const v of out.violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `MEET LIVE SCAN PASSED: ${out.gates} gates checked before a session is written (firm-hosted Meet, the meeting-type rule, firm recording default, platform-announced consent, meet.live.join); ` +
      `${out.planted} planted meetings through the real rule — LP and Broker refused, the four types that may join admitted; ` +
      `the heartbeat offers only calendar Meets with a conference; the words enter only through transcribeWithSpeakers → ingestTranscript; ` +
      `the listener core and the peer page make no network call, the CLI fetches only the Worker (${out.fetches} call site(s)), audio goes only to /chunk, and the Google client names ${out.hosts} host(s), all Google's; ` +
      `both speech adapters use the Workers AI binding with mip_opt_out; ${out.states} live states agree between the During face and migration 0215.`,
  );
}

main().catch((err) => {
  console.error(`MEET LIVE SCAN FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
