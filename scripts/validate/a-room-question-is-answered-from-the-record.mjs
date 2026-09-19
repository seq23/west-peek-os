#!/usr/bin/env node
/**
 * a-room-question-is-answered-from-the-record.mjs — `npm run validate:room-answers`.
 *
 * ONE ASSERTION: A REPORT OR CHART BUILT IN THE LIVE ROOM COMES FROM THE FIRM'S OWN RECORD, CITES
 * THE ROWS IT USED, AND A QUESTION OUTSIDE THE ALLOWLIST IS REFUSED BY NAME.
 *
 * WHAT THIS GUARDS (Phase C, owner-approved 18 Sep 2026). "Build a report or chart on the spot." The
 * model produces a PLAN, `src/shared/meetings/roomQuery.ts` compiles it into one parameterised
 * SELECT over an allowlist, and the rows go straight into a saved block — the model never sees
 * them. That is only true while three things hold, and this scan checks all three against the
 * REAL compiler and the REAL schema:
 *
 *   1 · THE ALLOWLIST IS TRUE. Every table and column it names exists in the schema the migrations
 *       build (replayed in `node:sqlite`); every table marked `privacy` carries `privacy_label`,
 *       every `archivable` one carries `archived_at`, and all carry `firm_scope`. A column that
 *       drifts here is a query that fails on every meeting.
 *   2 · THE FIXTURES ANSWER FROM THE RECORD. Rows are planted, each fixture's plan is compiled and
 *       RUN, and the result must contain exactly the rows planted for it and cite each by id — or,
 *       for an aggregate, cite each group. A plan for a table outside the allowlist, or a column
 *       outside its table, is refused BY NAME before any SQL exists. A cap above 50 is refused.
 *       The privacy clause is applied: a row above the reader's label is not returned.
 *   3 · THE ROOM USES IT. `runRecordQuery` in meetingRoom.ts calls `compileRecordQuery` and
 *       `citationsFor`, saves `cites` on the block, and the file's one `runAi` call takes only the
 *       prompt — no rows are ever handed to a model.
 *
 * HARD-FAILS ON ZERO: zero fixtures, zero allowlisted tables, zero migrations — each exits 1.
 *
 * `--self-test` plants each defect and proves it is caught, and proves the shipped source passes.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { stripCommentsFor, stripTsComments } from "./lib/strip-comments.mjs";

/** Replay every migration in order into memory (the Phase B readers' technique, kept local so importing it does not run their scan). */
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

function buildSchema(files) {
  const db = new DatabaseSync(":memory:");
  for (const [name, raw] of files) {
    for (const stmt of splitStatements(stripCommentsFor(name, raw))) {
      try {
        db.exec(stmt);
      } catch {
        // Seeds and guarded ALTERs may not apply to a bare database; the SHAPE is the point.
      }
    }
  }
  return db;
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const QUERY = path.join(ROOT, "src", "shared", "meetings", "roomQuery.ts");
const ROOM = path.join(ROOT, "src", "worker", "services", "meetingRoom.ts");

// ── The fixtures: what a partner asks, the plan the model would make, what the record must say ──

const SCOPE = "west-peek";
const CO = "cc_room_fix_1";
const CO2 = "cc_room_fix_2";
const FUND = "fund_room_fix";
const LP = "lp_room_fix";

/** Rows planted before the fixtures run. Every id here is what a fixture must cite. */
const PLANTED = [
  ["canonical_company", { id: CO, canonical_name: "Fixture Robotics", sector: "robotics", status: "ACTIVE", privacy_label: "INTERNAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["canonical_company", { id: CO2, canonical_name: "Fixture Secret Co", sector: "robotics", status: "ACTIVE", privacy_label: "CONFIDENTIAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["investment_opportunity", { id: "io_room_fix_1", company_id: CO, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Fixture Seed", status: "SCREENING", privacy_label: "INTERNAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["investment_opportunity", { id: "io_room_fix_2", company_id: CO, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Fixture Series A", status: "DILIGENCE", privacy_label: "INTERNAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["investment_opportunity", { id: "io_room_fix_3", company_id: CO, opportunity_type: "EARLY_STAGE_PRIMARY", title: "Fixture Archived", status: "SCREENING", privacy_label: "INTERNAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor", archived_at: "2026-01-01T00:00:00.000Z" }],
  ["fund", { id: FUND, name: "Fixture Fund I", status: "ACTIVE", firm_scope: SCOPE, target_size_minor: 5000000000, currency: "USD", vintage_year: 2026 }],
  ["lp_record", { id: LP, legal_name: "Fixture Family Office", lp_type: "FAMILY_OFFICE", status: "ENGAGED", privacy_label: "CONFIDENTIAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["lp_commitment", { id: "lpc_room_fix_1", lp_record_id: LP, fund_id: FUND, amount_minor: 250000000, currency: "USD", state: "SIGNED", committed_on: "2026-03-01", privacy_label: "CONFIDENTIAL", firm_scope: SCOPE, recorded_by: "fu_scooter_taylor" }],
  ["meeting", { id: "mtg_room_fix_1", title: "Fixture call", meeting_type: "FOUNDER", status: "HELD", company_id: CO, privacy_label: "INTERNAL", firm_scope: SCOPE, created_by: "fu_scooter_taylor", scheduled_at: "2026-09-01T10:00:00.000Z" }],
  ["meeting_commitment", { id: "mc_room_fix_1", meeting_id: "mtg_room_fix_1", commitment_text: "Send the diligence list", owner_side: "FIRM", status: "OPEN", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
  ["meeting_commitment", { id: "mc_room_fix_2", meeting_id: "mtg_room_fix_1", commitment_text: "Send the cohort data", owner_side: "COUNTERPARTY", owed_by: "Fixture CFO", status: "OPEN", firm_scope: SCOPE, created_by: "fu_scooter_taylor" }],
];

/** A reader who may see INTERNAL but not CONFIDENTIAL, so the privacy clause has something to hide. */
const READER_CLAUSE = "privacy_label IN ('PUBLIC', 'INTERNAL')";

export const FIXTURES = [
  {
    question: "show me the live deals for Fixture Robotics",
    plan: { table: "investment_opportunity", select: ["title", "status"], where: [{ column: "company_id", op: "eq", value: CO }] },
    expect: { cites: ["investment_opportunity:io_room_fix_1", "investment_opportunity:io_room_fix_2"] },
  },
  {
    question: "…including the archived one",
    plan: { table: "investment_opportunity", select: ["title"], where: [{ column: "company_id", op: "eq", value: CO }], include_archived: true },
    expect: { cites: ["investment_opportunity:io_room_fix_1", "investment_opportunity:io_room_fix_2", "investment_opportunity:io_room_fix_3"] },
  },
  {
    question: "chart the pipeline by stage",
    plan: { table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, chart: "bar", order_by: { column: "status", dir: "asc" } },
    expect: { cites: ["investment_opportunity:status=DILIGENCE", "investment_opportunity:status=SCREENING"] },
  },
  {
    question: "which robotics companies do we know",
    plan: { table: "canonical_company", select: ["canonical_name"], where: [{ column: "sector", op: "eq", value: "robotics" }] },
    // The CONFIDENTIAL company is above this reader's label and must not come back.
    expect: { cites: [`canonical_company:${CO}`] },
  },
  {
    question: "what does the family office have committed to Fund I",
    plan: { table: "lp_commitment", select: ["amount_minor", "state"], where: [{ column: "fund_id", op: "eq", value: FUND }] },
    // A Managing Partner reading: the clause is 1=1.
    visibility: "1=1",
    expect: { cites: ["lp_commitment:lpc_room_fix_1"], confidential: true },
  },
  {
    question: "what do they still owe us from the last call",
    plan: { table: "meeting_commitment", select: ["commitment_text", "owed_by"], where: [{ column: "owner_side", op: "eq", value: "COUNTERPARTY" }, { column: "honoured_at", op: "is_null" }, { column: "meeting_id", op: "eq", value: "mtg_room_fix_1" }] },
    expect: { cites: ["meeting_commitment:mc_room_fix_2"] },
  },
  {
    question: "how much is committed to Fund I in total",
    plan: { table: "lp_commitment", metric: { fn: "sum", column: "amount_minor" }, where: [{ column: "fund_id", op: "eq", value: FUND }] },
    visibility: "1=1",
    expect: { cites: ["lp_commitment:metric=250000000"] },
  },
  {
    question: "list every user's email",
    plan: { table: "firm_user", select: ["email"] },
    expect: { refused: /"firm_user" is not a table the room may read/ },
  },
  {
    question: "show me the partners' private notes on Fixture Robotics",
    plan: { table: "canonical_company", select: ["mp_notes"] },
    expect: { refused: /"canonical_company.mp_notes" is not a column/ },
  },
  {
    question: "dump the whole pipeline",
    plan: { table: "investment_opportunity", limit: 5000 },
    expect: { refused: /limit/ },
  },
  {
    question: "a plan that tries to smuggle SQL through the table name",
    plan: { table: "canonical_company; DROP TABLE meeting", select: ["id"] },
    expect: { refused: /not in the shape|is not a table/ },
  },
];

// ── 1 · the allowlist is true of the schema ───────────────────────────────────────────────────

export function checkAllowlist(db, ALLOWLIST) {
  const violations = [];
  const entries = Object.entries(ALLOWLIST);
  for (const [table, def] of entries) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (cols.length === 0) {
      violations.push(`allowlisted table ${table} is not built by the migrations`);
      continue;
    }
    for (const c of Object.keys(def.columns)) if (!cols.includes(c)) violations.push(`allowlisted column ${table}.${c} does not exist — every plan naming it would fail`);
    if (def.privacy && !cols.includes("privacy_label")) violations.push(`${table} is marked privacy but has no privacy_label column`);
    if (!def.privacy && cols.includes("privacy_label")) violations.push(`${table} carries privacy_label but the allowlist does not apply the visibility clause to it — rows above the reader's label would be returned`);
    if (def.archivable && !cols.includes("archived_at")) violations.push(`${table} is marked archivable but has no archived_at column`);
    if (!def.archivable && cols.includes("archived_at")) violations.push(`${table} carries archived_at but the allowlist never hides archived rows from it`);
    if (!cols.includes("firm_scope")) violations.push(`${table} has no firm_scope column — the scope clause the compiler always adds would fail`);
  }
  return { violations, examined: entries.length };
}

// ── 2 · the fixtures answer from the record ───────────────────────────────────────────────────

function plant(db) {
  for (const [table, row] of PLANTED) {
    const cols = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c]));
  }
}

export function runFixtures(db, mod, fixtures) {
  const violations = [];
  const { compileRecordQuery, citationsFor, RecordQueryRefused } = mod;
  for (const f of fixtures) {
    let compiled;
    try {
      compiled = compileRecordQuery(f.plan, { firmScope: SCOPE, visibility: f.visibility ?? READER_CLAUSE });
    } catch (err) {
      if (f.expect.refused) {
        if (!(err instanceof RecordQueryRefused)) violations.push(`"${f.question}": refused, but not with RecordQueryRefused (${err?.message})`);
        else if (!f.expect.refused.test(err.message)) violations.push(`"${f.question}": refused for the wrong reason — got "${err.message}", wanted ${f.expect.refused}`);
        continue;
      }
      violations.push(`"${f.question}": the compiler refused a plan it should accept: ${err?.message}`);
      continue;
    }
    if (f.expect.refused) {
      violations.push(`"${f.question}": a plan outside the allowlist was ACCEPTED (${compiled.sql}) — it must be refused by name`);
      continue;
    }
    if (!/^SELECT /.test(compiled.sql) || /;/.test(compiled.sql)) violations.push(`"${f.question}": compiled to something other than one SELECT: ${compiled.sql}`);
    if (!compiled.sql.includes("firm_scope = ?1")) violations.push(`"${f.question}": the firm scope is not the first bound condition`);
    if (!/LIMIT \d+$/.test(compiled.sql) || Number(compiled.sql.match(/LIMIT (\d+)$/)[1]) > 50) violations.push(`"${f.question}": no cap, or a cap above 50`);
    let rows;
    try {
      rows = db.prepare(compiled.sql).all(...compiled.params);
    } catch (err) {
      violations.push(`"${f.question}": the compiled SQL does not run against the real schema: ${err?.message} — ${compiled.sql}`);
      continue;
    }
    const cites = citationsFor(compiled, rows).sort();
    const want = [...f.expect.cites].sort();
    if (JSON.stringify(cites) !== JSON.stringify(want)) violations.push(`"${f.question}": cited ${JSON.stringify(cites)}, the record says ${JSON.stringify(want)}`);
    if (f.expect.confidential !== undefined && compiled.confidential !== f.expect.confidential) violations.push(`"${f.question}": confidential should be ${f.expect.confidential}`);
  }
  return { violations, examined: fixtures.length };
}

// ── 3 · the room uses the compiler, cites, and hands no rows to a model ───────────────────────

function fnBody(src, name) {
  const m = new RegExp(`(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\{[ \\t]*\\n`).exec(src);
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

export function checkRoomUsesIt(roomSrc) {
  const violations = [];
  let examined = 0;
  const q = fnBody(roomSrc, "runRecordQuery");
  if (!q) violations.push("runRecordQuery is missing from meetingRoom.ts — the room cannot build a table");
  else {
    examined += 1;
    if (!q.includes("compileRecordQuery(")) violations.push("runRecordQuery does not compile the plan through compileRecordQuery — the allowlist is bypassed");
    if (!q.includes("citationsFor(")) violations.push("runRecordQuery does not compute citations");
    if (!/\bcites\b/.test(q)) violations.push("runRecordQuery saves a block with no `cites` — the answer does not say which rows it used");
    if (/runAi\(/.test(q)) violations.push("runRecordQuery calls runAi — rows from the record would reach a model");
    if (!/RecordQueryRefused/.test(q)) violations.push("runRecordQuery does not save a refusal by name when the plan is outside the allowlist");
  }
  const runs = [...roomSrc.matchAll(/runAi\(\s*env\s*,\s*\{([\s\S]*?)\}\s*\)/g)];
  examined += runs.length;
  if (runs.length === 0) violations.push("meetingRoom.ts never calls runAi, so nobody can answer");
  for (const r of runs) {
    if (!/inputs:\s*\[prompt\]/.test(r[1])) violations.push("a runAi call in meetingRoom.ts sends something other than [prompt] — rows must never reach a model");
    if (!/confidential:\s*isConfidentialMeeting\(meeting\)/.test(r[1])) violations.push("a runAi call in meetingRoom.ts does not derive `confidential` from the meeting — an LP conversation could reach a training-permitting lane");
  }
  return { violations, examined };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

function schema() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort().map((f) => [path.join(MIGRATIONS_DIR, f), stripCommentsFor(path.join(MIGRATIONS_DIR, f), readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))]);
  const db = buildSchema(files);
  plant(db);
  return { db, migrations: files.length };
}

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const mod = await import(pathToFileURL(QUERY).href);
  const { db, migrations } = schema();

  const allow = checkAllowlist(db, mod.ALLOWLIST);
  say(allow.violations.length === 0 && allow.examined >= 10, `the shipped allowlist (${allow.examined} tables) is true of the schema ${migrations} migrations build: ${allow.violations.join("; ")}`);
  const drifted = { ...mod.ALLOWLIST, canonical_company: { ...mod.ALLOWLIST.canonical_company, columns: { ...mod.ALLOWLIST.canonical_company.columns, mp_notess: "text" } } };
  say(checkAllowlist(db, drifted).violations.some((v) => /mp_notess/.test(v)), "a column that drifted from the schema is caught");
  const unclaused = { ...mod.ALLOWLIST, canonical_company: { ...mod.ALLOWLIST.canonical_company, privacy: false } };
  say(checkAllowlist(db, unclaused).violations.some((v) => /visibility clause/.test(v)), "a privacy-labelled table without the clause is caught");
  const ghost = { ...mod.ALLOWLIST, ghost_table: { label: "x", columns: { id: "text" }, privacy: false, archivable: false, confidential: false } };
  say(checkAllowlist(db, ghost).violations.some((v) => /ghost_table/.test(v)), "an allowlisted table the migrations never build is caught");

  const fx = runFixtures(db, mod, FIXTURES);
  say(fx.violations.length === 0 && fx.examined >= 8, `all ${fx.examined} fixtures answer from the record or are refused by name: ${fx.violations.join("; ")}`);
  const wrongCite = FIXTURES.map((f, i) => (i === 0 ? { ...f, expect: { cites: ["investment_opportunity:io_room_fix_1"] } } : f));
  say(runFixtures(db, mod, wrongCite).violations.some((v) => /cited/.test(v)), "an answer that cites different rows than the record holds is caught");
  const leaky = { ...mod, compileRecordQuery: (raw, ctx) => mod.compileRecordQuery(raw.table === "firm_user" ? { table: "canonical_company", select: ["id"] } : raw, ctx) };
  say(runFixtures(db, leaky, FIXTURES).violations.some((v) => /ACCEPTED/.test(v)), "a compiler that lets a forbidden table through is caught");
  const uncapped = { ...mod, compileRecordQuery: (raw, ctx) => { const c = mod.compileRecordQuery(raw, ctx); return { ...c, sql: c.sql.replace(/LIMIT \d+$/, "LIMIT 5000") }; } };
  say(runFixtures(db, uncapped, FIXTURES).violations.some((v) => /cap/.test(v)), "a compiled query without the 50-row cap is caught");
  const noClause = { ...mod, compileRecordQuery: (raw, ctx) => mod.compileRecordQuery(raw, { ...ctx, visibility: "1=1" }) };
  say(runFixtures(db, noClause, FIXTURES).violations.some((v) => /robotics companies/.test(v)), "a compiler that drops the privacy clause returns the confidential company and is caught");

  const room = stripTsComments(readFileSync(ROOM, "utf8"));
  const uses = checkRoomUsesIt(room);
  say(uses.violations.length === 0 && uses.examined >= 2, `the room compiles, cites, and hands no rows to a model (${uses.examined} sites examined): ${uses.violations.join("; ")}`);
  say(checkRoomUsesIt(room.replace("const cites = citationsFor(compiled, rows);", "const cites = [];")).violations.some((v) => /citations/.test(v)), "a room that stops citing is caught");
  say(checkRoomUsesIt(room.replace("inputs: [prompt],", "inputs: [prompt, JSON.stringify(rows)],")).violations.some((v) => /rows must never reach a model/.test(v)), "a room that sends rows to a model is caught");
  say(checkRoomUsesIt(room.replace("expectedOutputTokens: 600, confidential: isConfidentialMeeting(meeting)", "expectedOutputTokens: 600, confidential: false")).violations.some((v) => /derive `confidential`/.test(v)), "a room that stops deriving confidential from the meeting is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: a drifted column, an unclaused table, a ghost table, a wrong citation, a leaky compiler, an uncapped query, a dropped privacy clause, a non-citing room, a row-leaking room and a non-confidential LP call are each caught; the shipped source passes.");
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const mod = await import(pathToFileURL(QUERY).href);
  const { db, migrations } = schema();
  const allow = checkAllowlist(db, mod.ALLOWLIST);
  const fx = runFixtures(db, mod, FIXTURES);
  const uses = checkRoomUsesIt(stripTsComments(readFileSync(ROOM, "utf8")));

  const empty = [
    migrations === 0 && "read 0 migrations",
    allow.examined === 0 && "the allowlist names 0 tables",
    fx.examined === 0 && "ran 0 fixtures",
    uses.examined === 0 && "examined 0 sites in meetingRoom.ts",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`ROOM-ANSWERS SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }
  const violations = [...allow.violations, ...fx.violations, ...uses.violations];
  if (violations.length > 0) {
    console.error("ROOM-ANSWERS SCAN FAILED — a question in the room could be answered from somewhere other than the record, or without saying which rows:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  const refused = FIXTURES.filter((f) => f.expect.refused).length;
  console.log(
    `ROOM-ANSWERS SCAN PASSED: ${allow.examined} allowlisted tables are true of the schema ${migrations} migrations build; ${fx.examined} fixture questions — ${fx.examined - refused} answered from planted rows with every row cited (privacy clause and 50-row cap applied), ${refused} outside the allowlist refused by name; ` +
      `the room compiles through the allowlist, cites, derives confidential from the meeting, and hands no rows to a model (${uses.examined} sites).`,
  );
}
