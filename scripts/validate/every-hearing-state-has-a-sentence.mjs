#!/usr/bin/env node
/**
 * every-hearing-state-has-a-sentence.mjs — `npm run validate:room-hears`.
 *
 * ONE ASSERTION: EVERY WAY A MEETING'S WORDS REACH ITS RECORD IS A NAMED STATE WITH A SENTENCE
 * AND A TEST, AND NO COMPONENT COMPOSES ITS OWN VERSION OF THAT SENTENCE.
 *
 * WHAT THIS GUARDS (owner, 19 Sep 2026). After Walter walked her through a fake meeting: "If I
 * push Join on Meet what happens? I got to the Google Meet page but is that enough? Is it
 * recording? Are my AI employees there from Join on Meet alone?" Nothing on the During face said
 * how the room hears. The fix is a line under the recording switch whose every variant is a named
 * state in `src/shared/meetings/howTheRoomHears.ts`, chosen off the row. This scan is what keeps
 * that true after tonight:
 *
 *   1 · EVERY STATE HAS A SENTENCE. Each name in `HEARING_STATES` has an entry in
 *       `HEARING_SENTENCES` that returns a full line (≥ 60 characters) for a representative set of
 *       facts and opens with its channel; each `LIVE_PATHS` name has a `LIVE_PATH_SENTENCES` entry.
 *   2 · EVERY STATE HAS A TEST. `tests/howTheRoomHears.test.ts` names every state and every path
 *       as a string literal in its reach table — a state nothing asserts is a state nothing proves.
 *   3 · EVERY STATE IS REACHABLE. `hearingStateOf` over a grid of facts returns every state at
 *       least once; a state no facts reach is dead prose.
 *   4 · THE CADENCE IS READ, NEVER WRITTEN. The Worker service reads `interval_minutes` for
 *       `meet_ingest` from `scheduled_job`; the shared module contains no literal "60 min".
 *   5 · NO COMPONENT COMPOSES THE SENTENCE. `RoomPanel.tsx`, `MeetingsPage.tsx`,
 *       `MeetingFacesPanel.tsx` and `LiveHelpPanel.tsx` (comments stripped) must not carry the
 *       marker phrases the module owns ("transcribed by Google", "does not hear it live",
 *       "never in the Meet call", "in its own window — no app shell"); they render them from the module.
 *   6 · THE LINE IS ON THE PAGE. `RoomPanel.tsx` calls the module's `hearing(` and emits
 *       `data-testid={`hears-…`}`; `MeetingsPage.tsx` emits the Join line and the standalone line;
 *       `LiveHelpPanel.tsx` emits `seat-line`; `MeetingFacesPanel.tsx` emits `after-sources`.
 *
 * HARD-FAILS ON ZERO: zero states, zero paths, zero test literals, zero component files — each
 * exits 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` plants each defect — a state with no sentence, a state absent from the test, a
 * hard-coded cadence, a component composing the line — and proves each is caught, then proves the
 * shipped module passes.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";
import { stripTsComments } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const MODULE = path.join(ROOT, "src", "shared", "meetings", "howTheRoomHears.ts");
const SERVICE = path.join(ROOT, "src", "worker", "services", "howTheRoomHears.ts");
const TEST = path.join(ROOT, "tests", "howTheRoomHears.test.ts");
const COMPONENTS = ["RoomPanel.tsx", "MeetingsPage.tsx", "MeetingFacesPanel.tsx", "LiveHelpPanel.tsx", "CallDoors.tsx"].map((f) => path.join(ROOT, "src", "client", "pages", f));

/** Phrases the module owns. A component that carries one has composed its own version. */
export const OWNED_PHRASES = ["transcribed by Google", "does not hear it live", "never in the Meet call", "in its own window — no app shell", "read into this record within"];

const SAMPLE_FACTS = {
  source: "google_calendar",
  meet_link: "https://meet.google.com/abc-defg-hij",
  call_ended_at: null,
  firm_default_on: true,
  ingest_every_minutes: 60,
  meet: { state: "INGESTED", conference_ended_at: "2026-09-19T15:02:00Z", turns: 12, participants: 2, read_at: "2026-09-19T15:48:00Z", detail: "x" },
  transcription_available: true,
  recording_policy_active: true,
  consent: { transcription: "GRANTED", recording: "GRANTED" },
  turns_captured: 3,
  notes_typed: 1,
};

/** 1 · every state and path has a sentence. */
export function checkSentences(mod) {
  const v = [];
  const states = mod.HEARING_STATES ?? [];
  const paths = mod.LIVE_PATHS ?? [];
  for (const s of states) {
    const fn = mod.HEARING_SENTENCES?.[s];
    if (typeof fn !== "function") {
      v.push(`state ${s} has no sentence`);
      continue;
    }
    const line = fn(SAMPLE_FACTS);
    if (typeof line !== "string" || line.length < 60) v.push(`state ${s}: its sentence is not a full line (${typeof line === "string" ? line.length : typeof line})`);
    else if (!/^(Google Meet call|In person or by phone)/.test(line)) v.push(`state ${s}: its sentence does not open with its channel`);
    const chip = mod.HEARING_CHIP_WORDS?.[s];
    if (typeof chip !== "string" || chip.length < 3 || chip.length > 48) v.push(`state ${s} has no chip words for the narrow room (3–48 characters)`);
  }
  for (const p of paths) {
    const line = mod.LIVE_PATH_SENTENCES?.[p];
    if (typeof line !== "string" || line.length < 40) v.push(`path ${p} has no sentence`);
  }
  return { violations: v, states: states.length, paths: paths.length };
}

/** 2 · every state and path is named in the test. */
export function checkTested(mod, testSource) {
  const v = [];
  const src = stripTsComments(testSource);
  let named = 0;
  for (const s of [...(mod.HEARING_STATES ?? []), ...(mod.LIVE_PATHS ?? [])]) {
    if (src.includes(`"${s}"`)) named += 1;
    else v.push(`${s} is not named in tests/howTheRoomHears.test.ts`);
  }
  return { violations: v, named };
}

/** 3 · every state is reachable from some facts. */
export function checkReachable(mod) {
  const v = [];
  const reached = new Set();
  const bools = [true, false];
  const inboxStates = [null, "RECEIVED", "INGESTED", "REFUSED", "NO_TRANSCRIPT", "NO_MEETING", "FAILED"];
  const consents = ["NOT_RECORDED", "GRANTED", "DENIED"];
  for (const source of ["manual", "google_calendar"])
    for (const inbox of inboxStates)
      for (const firm of bools)
        for (const avail of bools)
          for (const policy of bools)
            for (const consent of consents)
              for (const turns of [0, 5])
                for (const live of bools) {
                  const f = {
                    ...SAMPLE_FACTS,
                    source,
                    meet_link: source === "google_calendar" ? SAMPLE_FACTS.meet_link : null,
                    firm_default_on: firm,
                    meet: inbox ? { ...SAMPLE_FACTS.meet, state: inbox } : null,
                    transcription_available: avail,
                    recording_policy_active: policy,
                    consent: { transcription: consent, recording: consent },
                    turns_captured: turns,
                  };
                  reached.add(mod.hearingStateOf(f, { live }));
                }
  for (const s of mod.HEARING_STATES ?? []) if (!reached.has(s)) v.push(`state ${s} is reachable from no facts`);
  return { violations: v, reached: reached.size };
}

/** 4 · the cadence is read from the job row and never written as a literal. */
export function checkCadence(moduleSource, serviceSource) {
  const v = [];
  const mod = stripTsComments(moduleSource);
  const svc = stripTsComments(serviceSource);
  if (/\b60 ?min/.test(mod) || /within ~60/.test(mod) || /\bhourly\b|within the hour|an hour/.test(mod)) v.push("howTheRoomHears.ts hard-codes the ingest cadence; it must come from ingest_every_minutes");
  if (!/job_key = 'meet_ingest'/.test(svc) || !/interval_minutes/.test(svc)) v.push("the Worker service does not read interval_minutes for meet_ingest from scheduled_job");
  return v;
}

/** 5 · no component composes the sentence. */
export function checkComponents(sources) {
  const v = [];
  for (const [name, text] of Object.entries(sources)) {
    const src = stripTsComments(text);
    for (const phrase of OWNED_PHRASES) if (src.includes(phrase)) v.push(`${name} composes its own line ("${phrase}") instead of rendering the module's`);
  }
  return v;
}

/** 6 · the line is on the page. */
export function checkEmitted(sources) {
  const v = [];
  const need = {
    "RoomPanel.tsx": [/hearingOf\(|\bhearing\(/, /data-testid=\{`hears-/],
    "MeetingsPage.tsx": [/STANDALONE_ROOM_LINE/, /room-standalone-link-/, /<CallDoors/],
    "CallDoors.tsx": [/JOIN_ON_MEET_LINE/, /LAPTOP_MIC_NOTE/, /data-testid=\{`laptop-mic-\$\{meeting\.id\}`\}/],
    "LiveHelpPanel.tsx": [/SEATED_EMPLOYEE_LINE/, /data-testid="seat-line"/],
    "MeetingFacesPanel.tsx": [/data-testid="after-sources"/, /\/hearing`/],
  };
  for (const [name, res] of Object.entries(need)) {
    const src = sources[name];
    if (src === undefined) {
      v.push(`${name} is missing`);
      continue;
    }
    const stripped = stripTsComments(src);
    for (const re of res) if (!re.test(stripped)) v.push(`${name} does not emit ${re}`);
  }
  return v;
}

function readComponents() {
  const out = {};
  for (const p of COMPONENTS) if (existsSync(p)) out[path.basename(p)] = stripTsComments(readFileSync(p, "utf8"));
  return out;
}

async function runAll(mod, { moduleSource, serviceSource, testSource, components }) {
  const a = checkSentences(mod);
  const b = checkTested(mod, testSource);
  const c = checkReachable(mod);
  const violations = [...a.violations, ...b.violations, ...c.violations, ...checkCadence(moduleSource, serviceSource), ...checkComponents(components), ...checkEmitted(components)];
  return { violations, states: a.states, paths: a.paths, named: b.named, components: Object.keys(components).length };
}

async function main() {
  const mod = await loadTs(MODULE);
  const r = await runAll(mod, { moduleSource: stripTsComments(readFileSync(MODULE, "utf8")), serviceSource: stripTsComments(readFileSync(SERVICE, "utf8")), testSource: stripTsComments(readFileSync(TEST, "utf8")), components: readComponents() });
  if (r.states === 0 || r.paths === 0 || r.named === 0 || r.components === 0) {
    console.error(`validate:room-hears — examined ${r.states} states, ${r.paths} paths, ${r.named} test literals, ${r.components} components. Rule 0: an empty loop is a failure.`);
    process.exit(1);
  }
  if (r.violations.length > 0) {
    console.error(`validate:room-hears — ${r.violations.length} violation(s):`);
    for (const x of r.violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`validate:room-hears — ${r.states} states and ${r.paths} live paths: each has a sentence, a test and facts that reach it; the cadence is read from the job row; no component composes the line; ${r.components} components emit it.`);
}

async function selfTest() {
  const mod = await loadTs(MODULE);
  const moduleSource = stripTsComments(readFileSync(MODULE, "utf8"));
  const serviceSource = stripTsComments(readFileSync(SERVICE, "utf8"));
  const testSource = stripTsComments(readFileSync(TEST, "utf8"));
  const components = readComponents();
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  const noSentence = { ...mod, HEARING_STATES: [...mod.HEARING_STATES, "MEET_GHOST"], HEARING_SENTENCES: mod.HEARING_SENTENCES };
  say(checkSentences(noSentence).violations.some((v) => /MEET_GHOST has no sentence/.test(v)), "a state with no sentence is caught");

  const noChip = { ...mod, HEARING_CHIP_WORDS: { ...mod.HEARING_CHIP_WORDS, MEET_PENDING: "" } };
  say(checkSentences(noChip).violations.some((v) => /MEET_PENDING has no chip words/.test(v)), "a state with no chip words for the narrow room is caught");
  const shortSentence = { ...mod, HEARING_SENTENCES: { ...mod.HEARING_SENTENCES, MEET_PENDING: () => "Google Meet call" } };
  say(checkSentences(shortSentence).violations.some((v) => /MEET_PENDING: its sentence is not a full line/.test(v)), "a sentence that is not a full line is caught");

  say(checkTested(mod, testSource.replaceAll('"MEET_PENDING"', '"MEET_PENDINX"')).violations.some((v) => /MEET_PENDING is not named/.test(v)), "a state absent from the test is caught");

  const unreachable = { ...mod, HEARING_STATES: [...mod.HEARING_STATES, "MEET_GHOST"] };
  say(checkReachable(unreachable).violations.some((v) => /MEET_GHOST is reachable from no facts/.test(v)), "a state no facts reach is caught");

  say(checkCadence(moduleSource.replace("${minutes(f.ingest_every_minutes)}", "~60 min"), serviceSource).length > 0, "a hard-coded cadence in the module is caught");
  say(checkCadence(moduleSource, serviceSource.replace("job_key = 'meet_ingest'", "job_key = 'calendar_sync'")).length > 0, "a service that does not read the meet_ingest row is caught");

  const composing = { ...components, "RoomPanel.tsx": `${components["RoomPanel.tsx"]}\nconst x = "Google Meet call · transcribed by Google";` };
  say(checkComponents(composing).some((v) => /RoomPanel.tsx composes its own line/.test(v)), "a component composing the line is caught");
  say(checkComponents({ "RoomPanel.tsx": `// transcribed by Google\n${components["RoomPanel.tsx"]}` }).length === 0, "the phrase in a comment is not a violation");

  say(checkEmitted({ ...components, "LiveHelpPanel.tsx": components["LiveHelpPanel.tsx"].replace('data-testid="seat-line"', 'data-testid="seat-lime"') }).some((v) => /LiveHelpPanel.tsx does not emit/.test(v)), "a page that drops the line is caught");

  const shipped = await runAll(mod, { moduleSource, serviceSource, testSource, components });
  say(shipped.violations.length === 0 && shipped.states > 0 && shipped.named > 0, `the shipped module passes (${shipped.states} states, ${shipped.paths} paths): ${shipped.violations.slice(0, 5).join("; ")}`);

  if (failed > 0) {
    console.error(`validate:room-hears --self-test: ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("validate:room-hears --self-test: every planted defect was caught.");
}

if (process.argv.includes("--self-test")) await selfTest();
else await main();
