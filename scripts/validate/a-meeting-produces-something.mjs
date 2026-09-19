#!/usr/bin/env node
/**
 * a-meeting-produces-something.mjs — `npm run validate:meeting-yield`.
 *
 * ONE ASSERTION: EVERY MEETING CAN PRODUCE ITS FOUR OUTPUTS, AND NONE OF THEM CAN BECOME A RECORD
 * WITHOUT A PERSON.
 *
 * WHAT THIS GUARDS (Phase B, owner-approved 18 Sep 2026). A meeting used to end in notes and a
 * close-out of firm-side follow-ups. Nothing wrote down what was SETTLED, what was still UNKNOWN,
 * what the OTHER side owed, or what a deal meeting meant for the deal's stage — so the meeting
 * system stored prose and gave nothing back. Phase B made the four first-class. This scan fails if
 * any of them can be lost again, in any of the ways this repo has lost things before:
 *
 *   1 · THE TABLES EXIST in the schema the migrations actually build (replayed in `node:sqlite`,
 *       not read off the newest file). "Exists but nothing invokes it" is one defect class; "is
 *       invoked but does not exist" is the one a mistyped migration produces.
 *   2 · THE DRAFT IS A PROPOSAL. `approveMeetingAfter` refuses a non-human actor BEFORE it
 *       authorizes, authorizes `meeting.after.approve`, and writes ALL FOUR objects — a decision,
 *       a commitment, an open question, a stage proposal. An approve that silently dropped one
 *       object would pass every other test and lose that output for every meeting.
 *   3 · EACH OBJECT GOES THROUGH ITS OWN KEY. `recordDecision`, `recordOpenQuestion` and
 *       `proposeStageChange` each call authorize() with their own action key, and every key is in
 *       the registry — an unregistered key is a 403 in production and a pass in every local test.
 *   4 · A STAGE PROPOSAL NEVER MOVES A DEAL. `decideStageProposal` calls `transitionOpportunity`
 *       and contains no `UPDATE investment_opportunity` of its own.
 *   5 · THE DRAFTER REFUSES AN EMPTY PAGE BEFORE IT ASKS A MODEL, and never reads an off-record
 *       note. A model handed nothing invents deliverables; this repo has watched it happen.
 *   6 · THE LIST SAYS WHAT EACH MEETING PRODUCED, from the server: every count the page reads
 *       off a row (`m.decision_count` …) is a column the list query actually selects. Two
 *       components each keeping their own list with no link is a named defect class here.
 *   7 · EVERY MEETING TYPE HAS A LEAD who exists on the roster, because the lead is who drafts.
 *
 * HARD-FAILS ON ZERO: zero tables, zero keys, zero client fields, zero types — each exits 1. An
 * empty loop reporting success is the defect this repo calls Rule 0.
 *
 * `--self-test` plants each defect in a fixture and proves it is caught, and proves the shipped
 * source passes.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { stripCommentsFor, stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const AFTER = path.join(ROOT, "src", "worker", "services", "meetingAfter.ts");
const MEETINGS = path.join(ROOT, "src", "worker", "services", "meetings.ts");
const PAGE = path.join(ROOT, "src", "client", "pages", "MeetingsPage.tsx");
const ACTION_TYPES = path.join(ROOT, "src", "shared", "registry", "actionTypes.ts");
const MEETING_TYPES = path.join(ROOT, "src", "shared", "meetings", "meetingTypes.ts");
const ROSTER = path.join(ROOT, "src", "shared", "registry", "aiEmployees.ts");

const REQUIRED_TABLES = ["meeting_decision", "meeting_commitment", "meeting_open_question", "meeting_stage_proposal", "meeting_artifact", "meeting_after_draft"];
const REQUIRED_COLUMNS = [
  ["meeting_commitment", "owed_by"],
  ["meeting_commitment", "honoured_at"],
  ["work_card", "meeting_id"],
  ["meeting", "lp_record_id"],
];
const OBJECT_KEYS = {
  recordDecision: "meeting.decision.record",
  recordOpenQuestion: "meeting.open_question.record",
  proposeStageChange: "meeting.stage_change.propose",
};

function readTs(file) {
  return stripTsComments(readFileSync(file, "utf8"));
}

// ── 1 · the schema the migrations build ──────────────────────────────────────────────────────

function splitStatements(sql) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const line of sql.split("\n")) {
    const bare = line.replace(/--.*$/, "");
    if (/\bBEGIN\b/i.test(bare) && !/\bEND\b/i.test(bare)) depth += 1;
    if (/\bEND\s*;/i.test(bare) && depth > 0) depth -= 1;
    buf += `${line}\n`;
    if (depth === 0 && /;\s*$/.test(bare)) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Replay every migration in order into memory. Data statements may fail; the SHAPE is the point. */
export function buildSchema(files) {
  const db = new DatabaseSync(":memory:");
  for (const [name, raw] of files) {
    for (const stmt of splitStatements(stripCommentsFor(name, raw))) {
      try {
        db.exec(stmt);
      } catch {
        // See sql-against-schema.mjs: seeds and guarded ALTERs may not apply to a bare database.
      }
    }
  }
  return db;
}

export function checkSchema(db, migrationCount) {
  const violations = [];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  for (const t of REQUIRED_TABLES) {
    if (!tables.has(t)) violations.push(`table ${t} is not built by the migrations — the code that writes it will fail on every meeting`);
  }
  for (const [t, c] of REQUIRED_COLUMNS) {
    if (!tables.has(t)) continue;
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
    if (!cols.includes(c)) violations.push(`${t}.${c} is not built by the migrations`);
  }
  return { violations, examined: migrationCount, tables: tables.size };
}

// ── 2–5 · meetingAfter.ts ─────────────────────────────────────────────────────────────────────

/**
 * The source of one exported function, braces balanced from the line its body opens on.
 *
 * The body's `{` is the first one that ends a line: a return type such as
 * `Promise<{ draft: Row; reused: boolean }>` carries braces of its own, inline, and the first
 * version of this took the first `{` it saw and read every function as empty.
 */
function fnBody(src, name) {
  const m = new RegExp(`export async function ${name}\\b[\\s\\S]*?\\{[ \\t]*\\n`).exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].lastIndexOf("{"); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

export function checkAfterService(src) {
  const violations = [];
  let examined = 0;

  const approve = fnBody(src, "approveMeetingAfter");
  if (!approve) violations.push("approveMeetingAfter is missing from meetingAfter.ts");
  else {
    examined += 1;
    const human = approve.indexOf("requireHuman(");
    const authz = approve.indexOf('"meeting.after.approve"');
    if (human === -1) violations.push("approveMeetingAfter does not refuse a non-human actor — an employee could turn its own draft into records");
    if (authz === -1) violations.push("approveMeetingAfter does not authorize meeting.after.approve");
    if (human !== -1 && authz !== -1 && human > authz) violations.push("approveMeetingAfter authorizes before it checks the actor is a person; the human check must come first");
    for (const [call, what] of [
      ["recordDecision(", "decisions"],
      ["INSERT INTO meeting_commitment", "commitments"],
      ["recordOpenQuestion(", "open questions"],
      ["proposeStageChange(", "the stage proposal"],
    ]) {
      if (!approve.includes(call)) violations.push(`approveMeetingAfter does not write ${what} — one of the four outputs is dropped on approval`);
    }
    if (!approve.includes('"meeting.commitment.create"')) violations.push("approveMeetingAfter writes commitments without authorizing meeting.commitment.create");
  }

  for (const [fn, key] of Object.entries(OBJECT_KEYS)) {
    const body = fnBody(src, fn);
    if (!body) {
      violations.push(`${fn} is missing from meetingAfter.ts`);
      continue;
    }
    examined += 1;
    if (!body.includes(`"${key}"`)) violations.push(`${fn} does not authorize ${key} — its rows would be written outside the one choke point`);
  }

  const decide = fnBody(src, "decideStageProposal");
  if (!decide) violations.push("decideStageProposal is missing");
  else {
    examined += 1;
    if (!decide.includes("requireHuman(")) violations.push("decideStageProposal does not refuse a non-human actor");
    if (!decide.includes("transitionOpportunity(")) violations.push("decideStageProposal does not call transitionOpportunity — a stage move would skip the pipeline's own rules");
    if (/UPDATE\s+investment_opportunity/i.test(decide)) violations.push("decideStageProposal updates investment_opportunity directly instead of through transitionOpportunity");
  }

  const draft = fnBody(src, "draftMeetingAfter");
  if (!draft) violations.push("draftMeetingAfter is missing");
  else {
    examined += 1;
    const refuse = draft.search(/if\s*\(\s*!input\.text\.trim\(\)\s*\)/);
    const run = draft.indexOf("runAi(");
    if (refuse === -1) violations.push("draftMeetingAfter does not refuse an empty input — a model handed nothing invents deliverables");
    if (run === -1) violations.push("draftMeetingAfter never calls runAi, so nothing can be drafted");
    if (refuse !== -1 && run !== -1 && refuse > run) violations.push("draftMeetingAfter asks the model before checking there is anything to read");
  }

  const input = fnBody(src, "draftInputFor");
  if (!input) violations.push("draftInputFor is missing");
  else {
    examined += 1;
    if (/OFF_RECORD/.test(input) && !/NOT IN\s*\([^)]*OFF_RECORD/.test(input) && !/note_type IN \('MANUAL','TRANSCRIPT_DERIVED'\)/.test(input)) {
      violations.push("draftInputFor reads OFF_RECORD notes");
    }
    if (!/note_type IN \('MANUAL','TRANSCRIPT_DERIVED'\)/.test(input) && !/NOT IN\s*\([^)]*OFF_RECORD/.test(input)) {
      violations.push("draftInputFor does not exclude off-record notes — an off-record line could become a decision");
    }
  }

  return { violations, examined };
}

// ── 3 · the keys are registered ──────────────────────────────────────────────────────────────

export function checkKeysRegistered(registrySrc, keys) {
  const violations = [];
  for (const key of keys) {
    if (!registrySrc.includes(`key: "${key}"`)) violations.push(`${key} is not in actionTypes.ts — authorize() denies it and the feature 403s in production`);
  }
  return { violations, examined: keys.length };
}

// ── 6 · the list's counts exist on the server ────────────────────────────────────────────────

/** The row fields the page reads inside its two summarising functions. */
export function fieldsThePageReads(pageSrc) {
  const fields = new Set();
  for (const fn of ["readinessInWords", "outputsInWords"]) {
    const body = fnBody(pageSrc.replace(/function /g, "export async function ").replace(/export async function (?!readinessInWords|outputsInWords)/g, "function "), fn);
    if (!body) continue;
    for (const m of body.matchAll(/\bm\.([a-z_]+)\b/g)) fields.add(m[1]);
  }
  return [...fields].sort();
}

export function checkListCounts(meetingsSrc, fields) {
  const violations = [];
  const listFn = fnBody(meetingsSrc, "handleListMeetings") ?? "";
  for (const f of fields) {
    if (!new RegExp(`AS\\s+${f}\\b`).test(listFn)) violations.push(`the page reads m.${f} but handleListMeetings never selects it — the row would say 0 for every meeting`);
  }
  return { violations, examined: fields.length };
}

// ── 7 · every type has a lead on the roster ──────────────────────────────────────────────────

export function checkLeads(typesSrc, rosterSrc) {
  const violations = [];
  const leads = [...typesSrc.matchAll(/key:\s*"([A-Z_]+)"[\s\S]*?suggests:\s*\[\s*"([A-Za-z]+)"/g)].map((m) => ({ type: m[1], lead: m[2] }));
  const names = new Set([...rosterSrc.matchAll(/\bE\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
  for (const { type, lead } of leads) {
    if (!names.has(lead)) violations.push(`${type}'s lead ${lead} is not on the roster, so nobody drafts or briefs that type`);
  }
  return { violations, examined: leads.length };
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  const shipped = readTs(AFTER);
  const good = checkAfterService(shipped);
  say(good.violations.length === 0 && good.examined >= 7, `the shipped meetingAfter.ts passes (${good.examined} functions examined): ${good.violations.join("; ")}`);

  const noHuman = shipped.replace(/requireHuman\(actor, "Approving[^;]*;/, "");
  say(checkAfterService(noHuman).violations.some((v) => /non-human/.test(v)), "an approve that any actor can run is caught");

  const dropsQuestions = shipped.replace(/await recordOpenQuestion\(env, actor, meeting\.id, \{ \.\.\.q[^;]*;/, "");
  say(checkAfterService(dropsQuestions).violations.some((v) => /open questions/.test(v)), "an approve that drops open questions is caught");

  const directUpdate = shipped.replace("await transitionOpportunity(env, actor, p.opportunity_id, p.to_status as OpportunityStatus, note ?? p.rationale);", 'await env.WP_OS_DB.prepare("UPDATE investment_opportunity SET status = ?2 WHERE id = ?1").bind(p.opportunity_id, p.to_status).run();');
  const du = checkAfterService(directUpdate).violations;
  say(du.some((v) => /transitionOpportunity/.test(v)) && du.some((v) => /directly/.test(v)), "a stage decision that updates the deal itself is caught");

  const unkeyed = shipped.replace('"meeting.decision.record"', '"meeting.note.add"');
  say(checkAfterService(unkeyed).violations.some((v) => /recordDecision does not authorize/.test(v)), "a decision written under somebody else's key is caught");

  const modelFirst = shipped.replace(/if \(!input\.text\.trim\(\)\) \{[\s\S]*?return \{ draft, reused: false \};\n  \}\n/, "").replace("    aiRunId = run.id;", "    aiRunId = run.id;\n    if (!input.text.trim()) { throw new Error('late'); }");
  say(checkAfterService(modelFirst).violations.some((v) => /before checking|empty input/.test(v)), "a drafter that asks the model before checking for input is caught");

  const readsOffRecord = shipped.replace("note_type IN ('MANUAL','TRANSCRIPT_DERIVED')", "note_type IN ('MANUAL','OFF_RECORD','TRANSCRIPT_DERIVED')");
  say(checkAfterService(readsOffRecord).violations.some((v) => /off-record/i.test(v)), "a drafter that reads off-record notes is caught");

  const registry = readTs(ACTION_TYPES);
  say(checkKeysRegistered(registry, Object.values(OBJECT_KEYS).concat("meeting.after.approve", "meeting.brief.assemble")).violations.length === 0, "the shipped registry carries every Phase B key");
  say(checkKeysRegistered(registry.replace('key: "meeting.after.approve"', 'key: "meeting.after.approv"'), ["meeting.after.approve"]).violations.length === 1, "a missing key is caught");

  const page = readTs(PAGE);
  const fields = fieldsThePageReads(page);
  say(fields.length >= 5, `the page reads ${fields.length} row fields in its two summaries`);
  const meetings = readTs(MEETINGS);
  say(checkListCounts(meetings, fields).violations.length === 0, "every field the page reads is selected by the list");
  say(checkListCounts(meetings, [...fields, "decisions_pending"]).violations.length === 1, "a field the page reads that the list never selects is caught");

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => [path.join(MIGRATIONS_DIR, f), stripCommentsFor(path.join(MIGRATIONS_DIR, f), readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))]);
  const schema = checkSchema(buildSchema(files), files.length);
  say(schema.violations.length === 0 && schema.tables > 100, `the replayed schema carries every Phase B table (${schema.tables} tables from ${schema.examined} migrations)`);
  const without = files.map(([n, s]) => [n, s.replace(/CREATE TABLE IF NOT EXISTS meeting_open_question[\s\S]*?\);/, "")]);
  say(checkSchema(buildSchema(without), without.length).violations.some((v) => /meeting_open_question/.test(v)), "a migration set that never builds meeting_open_question is caught");

  const leads = checkLeads(readTs(MEETING_TYPES), readTs(ROSTER));
  say(leads.violations.length === 0 && leads.examined >= 6, `every one of ${leads.examined} meeting types has a lead on the roster`);
  say(checkLeads(readTs(MEETING_TYPES).replace('suggests: ["Wesley"]', 'suggests: ["Nobody"]'), readTs(ROSTER)).violations.length === 1, "a type whose lead is not on the roster is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: an any-actor approve, a dropped output, a direct deal update, a mis-keyed write, a model-first drafter, an off-record read, a missing key, an unselected count, a missing table and a roster-less lead are each caught; the shipped source passes.");
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => [path.join(MIGRATIONS_DIR, f), stripCommentsFor(path.join(MIGRATIONS_DIR, f), readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))]);
  const schema = checkSchema(buildSchema(files), files.length);
  const service = checkAfterService(readTs(AFTER));
  const keys = checkKeysRegistered(readTs(ACTION_TYPES), Object.values(OBJECT_KEYS).concat("meeting.after.approve", "meeting.brief.assemble"));
  const fields = fieldsThePageReads(readTs(PAGE));
  const list = checkListCounts(readTs(MEETINGS), fields);
  const leads = checkLeads(readTs(MEETING_TYPES), readTs(ROSTER));

  const empty = [
    schema.examined === 0 && "read 0 migrations",
    service.examined === 0 && "examined 0 functions in meetingAfter.ts",
    keys.examined === 0 && "checked 0 action keys",
    list.examined === 0 && "the page reads 0 row fields — the list says nothing about what a meeting produced",
    leads.examined === 0 && "read 0 meeting types",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`MEETING-YIELD SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...schema.violations, ...service.violations, ...keys.violations, ...list.violations, ...leads.violations];
  if (violations.length > 0) {
    console.error("MEETING-YIELD SCAN FAILED — a meeting could produce nothing, or produce a record without a person:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `MEETING-YIELD SCAN PASSED: ${REQUIRED_TABLES.length} After tables built by ${schema.examined} migrations; ${service.examined} functions in meetingAfter.ts keep the draft a proposal, ` +
      `write all four outputs under their own keys (${keys.examined} registered), move a deal only through transitionOpportunity, and refuse an empty page before asking a model; ` +
      `the list selects every one of the ${list.examined} counts the page reads; ${leads.examined} meeting types each have a lead on the roster.`,
  );
}
