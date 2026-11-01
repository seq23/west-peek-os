#!/usr/bin/env node
/**
 * A MIGRATION KEEPS ITS DATA — `npm run validate:migrations-keep-data`.
 *
 * THE RULE (owner, 1 Nov 2026). No database migration may delete a table, a column or a table's rows
 * by accident. A D1 migration runs against production before the code ships and there is no undo:
 * a dropped table is gone the moment `wrangler d1 migrations apply` reaches it.
 *
 * WHAT IS CHECKED. Every `.sql` file under `migrations/` that is NEW OR CHANGED against the base —
 * the pull request's base commit in CI, the pushed-over commit on a push, and `origin/main` (its
 * merge-base with HEAD, plus uncommitted and untracked files) locally. Files already on the base are
 * grandfathered: history is a record, and re-litigating it would block every PR. A changed old file
 * is checked in full. Each checked file fails on:
 *   · DROP TABLE of a table that already held data (one created earlier in the same file is fine);
 *   · ALTER TABLE … DROP (DROP COLUMN and every other ALTER … DROP);
 *   · DELETE FROM a table with no WHERE;
 *   · TRUNCATE;
 *   · a TABLE REBUILD THAT LOSES A COLUMN. The SQLite rebuild — CREATE TABLE x_new, INSERT … SELECT
 *     from x, DROP x, ALTER TABLE x_new RENAME TO x (or the rename-to-x_old variant) — is judged as
 *     a whole: the table that ends up holding the old name must carry every column the old table
 *     had (replayed from every earlier migration in filename order), the rows must actually be
 *     copied by an INSERT … SELECT, and an explicit INSERT column list must name every one of them.
 *     A rebuild of a table no earlier migration creates cannot be proved and fails closed.
 *
 * THE ESCAPE. A deliberate destructive migration carries, on its own line:
 *     -- destructive-ok: <reason> (backed up: <where>)
 * Both the reason and the backup location must be non-empty. A malformed line excuses nothing.
 *
 * This scan READS COMMENTS ON PURPOSE for that one line, and strips comments and string literals
 * (`stripSqlComments` below) before judging any statement, so prose or a quoted 'DROP TABLE' in
 * seed data cannot fail it.
 *
 * RULE 0: zero migration files, or a replay of all of them that finds zero tables, is a hard
 * failure — a scan that can see nothing would pass everything. A base it cannot resolve is a named
 * stop (MIGRATION_GUARD_NO_BASE), never a silent pass.
 *
 *   node <this file>              check new/changed migrations
 *   node <this file> --self-test  prove it catches each shape and passes the annotated one
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "migrations";

// ─── SQL masking ──────────────────────────────────────────────────────────────────────────────
/**
 * Replace comments and the CONTENT of string literals with spaces, keeping every offset and
 * newline, so a statement's position still maps to its line in the real file. Quoted identifiers
 * ("x", `x`, [x]) are kept: they are names, not data.
 */
export function stripSqlComments(sql) {
  const out = sql.split("");
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const end = sql.indexOf(close, i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else i++;
  }
  return out.join("");
}

const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*))?`;
export function norm(name) {
  const last = name.trim().split(/\s*\.\s*(?=(?:"|`|\[|[A-Za-z_]))/).pop();
  return last.replace(/^["`[]|["`\]]$/g, "").toLowerCase();
}

/** Split masked SQL into statements with their start offsets. */
function statements(masked) {
  const res = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ";") {
      const text = masked.slice(start, i);
      const lead = text.length - text.trimStart().length;
      if (text.trim()) res.push({ text: text.trim().replace(/\s+/g, " "), offset: start + lead });
      start = i + 1;
    }
  }
  return res;
}

/** Top-level comma split of a parenthesised body. */
function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parenBody(text, from) {
  const open = text.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

const NOT_A_COLUMN = new Set(["constraint", "primary", "unique", "check", "foreign"]);
function columnsOf(body) {
  const cols = new Set();
  for (const item of splitTop(body)) {
    const m = item.match(new RegExp(`^(${NAME})`));
    if (!m) continue;
    const col = norm(m[1]);
    if (NOT_A_COLUMN.has(col) || col.includes("=")) continue;
    cols.add(col);
  }
  return cols;
}

// ─── Simulation ───────────────────────────────────────────────────────────────────────────────
/**
 * Run one file's statements over a schema. `schema` maps table → { cols:Set|null, fresh, origin }.
 * `fresh` = created in THIS file (holds no old data); `origin` = the pre-existing name whose data
 * the object carries. Returns the findings (only meaningful when `judge` is true).
 */
export function simulate(sql, schema, everExisted, judge) {
  const masked = stripSqlComments(sql);
  const lineAt = (off) => masked.slice(0, off).split("\n").length;
  const findings = [];
  const flag = (st, msg) => judge && findings.push({ line: lineAt(st.offset), msg });
  const drops = [];
  const copies = [];

  for (const st of statements(masked)) {
    const s = st.text;
    let m;
    if ((m = s.match(new RegExp(`^CREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*([\\s\\S]*)$`, "i")))) {
      const name = norm(m[1]);
      if (/IF\s+NOT\s+EXISTS/i.test(s) && schema.has(name)) continue;
      const rest = m[2];
      const aside = rest.match(new RegExp(`^AS\\s+SELECT\\s+\\*\\s+FROM\\s+(${NAME})\\s*$`, "i"));
      const src = aside ? schema.get(norm(aside[1])) : null;
      if (judge && src && !src.fresh) {
        // The copy-aside rebuild: `CREATE TABLE x_copy AS SELECT * FROM x` carries x's data and columns.
        schema.set(name, { cols: src.cols ? new Set(src.cols) : null, fresh: false, origin: src.origin });
      } else {
        const cols = /^AS\b/i.test(rest) ? null : columnsOf(parenBody(rest, 0) ?? "");
        schema.set(name, { cols, fresh: judge, origin: judge ? null : name });
      }
      everExisted.add(name);
    } else if ((m = s.match(new RegExp(`^CREATE\\s+VIRTUAL\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s+USING\\s+\\w+\\s*([\\s\\S]*)$`, "i")))) {
      const name = norm(m[1]);
      if (/IF\s+NOT\s+EXISTS/i.test(s) && schema.has(name)) continue;
      schema.set(name, { cols: columnsOf(parenBody(m[2], 0) ?? ""), fresh: judge, origin: judge ? null : name });
      everExisted.add(name);
    } else if ((m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${NAME})\\s+RENAME\\s+TO\\s+(${NAME})`, "i")))) {
      const from = norm(m[1]);
      const to = norm(m[2]);
      const obj = schema.get(from) ?? { cols: null, fresh: false, origin: from };
      schema.delete(from);
      if (!judge) obj.origin = to; // across history the name moves; within the judged file the data's origin does not
      schema.set(to, obj);
      everExisted.add(to);
    } else if ((m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${NAME})\\s+RENAME\\s+(?:COLUMN\\s+)?(${NAME})\\s+TO\\s+(${NAME})`, "i")))) {
      const obj = schema.get(norm(m[1]));
      if (obj?.cols) {
        obj.cols.delete(norm(m[2]));
        obj.cols.add(norm(m[3]));
      }
    } else if ((m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${NAME})\\s+ADD\\s+(?:COLUMN\\s+)?(${NAME})`, "i")))) {
      const obj = schema.get(norm(m[1]));
      if (obj?.cols) obj.cols.add(norm(m[2]));
    } else if ((m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+(${NAME})\\s+DROP\\b(?:\\s+COLUMN)?\\s*(${NAME})?`, "i")))) {
      const name = norm(m[1]);
      const obj = schema.get(name);
      if (!obj?.fresh) flag(st, `ALTER TABLE ${name} DROP${m[2] ? ` ${norm(m[2])}` : ""} — deletes a column and its data`);
      if (obj?.cols && m[2]) obj.cols.delete(norm(m[2]));
    } else if ((m = s.match(new RegExp(`^DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?(${NAME})`, "i")))) {
      const name = norm(m[2]);
      const obj = schema.get(name);
      schema.delete(name);
      if (obj?.fresh) continue;
      if (!obj && m[1] && !everExisted.has(name)) continue; // IF EXISTS on a name no migration ever made
      drops.push({ st, name, origin: obj?.origin ?? name, cols: obj?.cols ? new Set(obj.cols) : null, known: Boolean(obj) });
    } else if (/^TRUNCATE\b/i.test(s)) {
      flag(st, "TRUNCATE — deletes every row");
    } else if ((m = s.match(new RegExp(`^INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(${NAME})\\s*(\\([^)]*\\))?\\s*SELECT\\b[\\s\\S]*?\\bFROM\\s+(${NAME})`, "i")))) {
      const from = norm(m[3]);
      copies.push({ into: schema.get(norm(m[1])), list: m[2] ? columnsOf(m[2].slice(1, -1)) : null, fromOrigin: schema.get(from)?.origin ?? from });
    }
    // DELETE can sit inside a trigger body, so it is looked for anywhere in the statement.
    for (const d of s.matchAll(new RegExp(`\\bDELETE\\s+FROM\\s+(${NAME})`, "gi"))) {
      const name = norm(d[1]);
      const tail = s.slice(d.index + d[0].length);
      if (/\bWHERE\b/i.test(tail)) continue;
      if (schema.get(name)?.fresh) continue;
      flag(st, `DELETE FROM ${name} with no WHERE — deletes every row`);
    }
  }

  // A dropped table is judged as a rebuild once the whole file has run.
  for (const d of drops) {
    const final = schema.get(d.origin);
    if (!final || !final.fresh) {
      flag(d.st, `DROP TABLE ${d.name} — deletes ${d.origin === d.name ? "the table" : `${d.origin}'s data`} and nothing takes its place`);
      continue;
    }
    const copy = copies.find((c) => c.into === final && c.fromOrigin === d.origin);
    if (!copy) {
      flag(d.st, `rebuild of ${d.origin} copies no rows — no INSERT INTO the new ${d.origin} … SELECT … FROM its old rows`);
      continue;
    }
    if (!d.known || !d.cols) {
      flag(d.st, `rebuild of ${d.origin} cannot be proved to keep every column: no earlier migration creates ${d.origin} with a column list`);
      continue;
    }
    const lost = [...d.cols].filter((c) => !final.cols?.has(c) || (copy.list && !copy.list.has(c)));
    if (lost.length) flag(d.st, `rebuild of ${d.origin} loses column(s): ${lost.join(", ")}`);
  }
  return findings;
}

// ─── The annotation ───────────────────────────────────────────────────────────────────────────
export function annotation(sql) {
  const line = sql.split("\n").find((l) => /^\s*--\s*destructive-ok\b/i.test(l));
  if (!line) return { present: false, valid: false };
  const m = line.match(/^\s*--\s*destructive-ok:\s*(.*?)\s*\(\s*backed up:\s*(.*?)\s*\)\s*$/i);
  if (!m || !m[1] || !m[2]) return { present: true, valid: false, line: line.trim() };
  return { present: true, valid: true, reason: m[1], where: m[2] };
}

/** Judge one file against the schema built by every migration before it. */
export function judgeFile(sql, priorSqls) {
  const schema = new Map();
  const ever = new Set();
  for (const p of priorSqls) {
    try {
      simulate(p, schema, ever, false);
    } catch {
      /* an unparseable old file only makes the replay know less, which fails closed */
    }
  }
  const findings = simulate(sql, schema, ever, true);
  const note = annotation(sql);
  return { findings, note, excused: findings.length > 0 && note.valid };
}

// ─── Which files ──────────────────────────────────────────────────────────────────────────────
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

export function resolveBase(root, env = process.env) {
  let sha = env.MIGRATION_GUARD_BASE || null;
  let label = sha ? "MIGRATION_GUARD_BASE" : null;
  if (!sha && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    if (ev.pull_request?.base?.sha) [sha, label] = [ev.pull_request.base.sha, "the pull request's base"];
    else if (ev.before && !/^0+$/.test(ev.before)) [sha, label] = [ev.before, "the commit this push replaced"];
  }
  if (sha) {
    if (!tryGit(root, "cat-file", "-e", `${sha}^{commit}`)) tryGit(root, "fetch", "--no-tags", "--depth=1", "origin", sha);
    if (tryGit(root, "cat-file", "-e", `${sha}^{commit}`) !== null) return { sha, label };
    return null;
  }
  if (!tryGit(root, "rev-parse", "--verify", "-q", "refs/remotes/origin/main")) {
    tryGit(root, "fetch", "--no-tags", "--depth=1", "origin", "main:refs/remotes/origin/main");
  }
  const main = tryGit(root, "rev-parse", "--verify", "-q", "refs/remotes/origin/main");
  if (!main) return null;
  const mb = tryGit(root, "merge-base", main, "HEAD");
  return { sha: mb || main, label: "origin/main" };
}

/** New or changed .sql files under the migrations dir, base → working tree, plus untracked. */
export function changedMigrations(root, base, dir = MIGRATIONS_DIR) {
  const out = new Set();
  const diff = git(root, "diff", "--name-status", "--no-renames", base, "--", dir);
  for (const line of diff.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    if (/^[AM]/.test(status) && file.endsWith(".sql")) out.add(file);
  }
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "--", dir);
  for (const f of untracked.split("\n").filter(Boolean)) if (f.endsWith(".sql")) out.add(f);
  return [...out].sort();
}

export function check(root, files) {
  const dirAbs = path.join(root, MIGRATIONS_DIR);
  const all = readdirSync(dirAbs).filter((f) => f.endsWith(".sql")).sort();
  const violations = [];
  const excused = [];
  for (const rel of files) {
    const base = path.basename(rel);
    const prior = all.filter((f) => f < base).map((f) => readFileSync(path.join(dirAbs, f), "utf8"));
    const sql = readFileSync(path.join(root, rel), "utf8");
    const r = judgeFile(sql, prior);
    if (r.excused) excused.push(`${rel}: ${r.findings.length} destructive statement(s) excused — ${r.note.reason} (backed up: ${r.note.where})`);
    else {
      for (const f of r.findings) violations.push(`${rel}:${f.line} ${f.msg}`);
      if (r.findings.length && r.note.present) violations.push(`${rel}: the destructive-ok line is malformed ("${r.note.line}") — it needs a reason and "(backed up: <where>)"`);
    }
  }
  return { violations, excused, total: all.length };
}

// ─── Self-test ────────────────────────────────────────────────────────────────────────────────
const OLD = "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT, CHECK (email <> ''));";

function selfTest() {
  let failed = 0;
  const expect = (name, sql, wantCaught, prior = [OLD]) => {
    const r = judgeFile(sql, prior);
    const caught = r.findings.length > 0 && !r.excused;
    if (caught !== wantCaught) {
      failed++;
      console.error(`  ✗ ${name} — expected ${wantCaught ? "FAIL" : "PASS"}, got ${caught ? "FAIL" : "PASS"} ${JSON.stringify(r.findings)}`);
    } else console.log(`  ✓ ${name}`);
  };
  const OK = "-- destructive-ok: users table retired, replaced by people (backed up: R2 backups/2026-11-01/users.sql)\n";

  expect("DROP TABLE is caught", "DROP TABLE users;", true);
  expect("DROP TABLE IF EXISTS of a real table is caught", "DROP TABLE IF EXISTS users;", true);
  expect("ALTER TABLE … DROP COLUMN is caught", "ALTER TABLE users DROP COLUMN email;", true);
  expect("ALTER TABLE … DROP <col> (no COLUMN keyword) is caught", 'ALTER TABLE "users" DROP name;', true);
  expect("DELETE FROM with no WHERE is caught", "DELETE FROM users;", true);
  expect("DELETE FROM inside a trigger with no WHERE is caught", "CREATE TRIGGER t AFTER INSERT ON users BEGIN DELETE FROM users; END;", true);
  expect("DELETE FROM … WHERE passes", "DELETE FROM users WHERE id = 1;", false);
  expect("TRUNCATE is caught", "TRUNCATE TABLE users;", true);
  expect(
    "a rebuild that loses a column is caught",
    "CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT NOT NULL);\nINSERT INTO users_new (id, email) SELECT id, email FROM users;\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;",
    true,
  );
  expect(
    "a rebuild that keeps every column passes",
    "CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, created_at TEXT);\nINSERT INTO users_new (id, email, name) SELECT id, email, name FROM users;\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;",
    false,
  );
  expect(
    "a rebuild whose INSERT list leaves a kept column empty is caught",
    "CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT, name TEXT);\nINSERT INTO users_new (id, email) SELECT id, email FROM users;\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;",
    true,
  );
  expect(
    "the rename-to-old rebuild keeping every column passes",
    "ALTER TABLE users RENAME TO users_old;\nCREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT);\nINSERT INTO users SELECT * FROM users_old;\nDROP TABLE users_old;",
    false,
  );
  expect(
    "the rename-to-old rebuild losing a column is caught",
    "ALTER TABLE users RENAME TO users_old;\nCREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO users (id, email) SELECT id, email FROM users_old;\nDROP TABLE users_old;",
    true,
  );
  expect(
    "the copy-aside rebuild keeping every column passes",
    "CREATE TABLE users_copy AS SELECT * FROM users;\nDROP TABLE users;\nCREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT);\nINSERT INTO users (id, email, name) SELECT id, email, name FROM users_copy;\nDROP TABLE users_copy;",
    false,
  );
  expect(
    "the copy-aside rebuild losing a column is caught",
    "CREATE TABLE users_copy AS SELECT * FROM users;\nDROP TABLE users;\nCREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);\nINSERT INTO users (id, email) SELECT id, email FROM users_copy;\nDROP TABLE users_copy;",
    true,
  );
  expect(
    "a rebuild that copies no rows is caught",
    "CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT, name TEXT);\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;",
    true,
  );
  expect(
    "a rebuild of a table no earlier migration creates fails closed",
    "CREATE TABLE ghosts_new (id INTEGER);\nINSERT INTO ghosts_new SELECT * FROM ghosts;\nDROP TABLE ghosts;\nALTER TABLE ghosts_new RENAME TO ghosts;",
    true,
  );
  expect("a column added in a later migration is part of the old table", "CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT, name TEXT);\nINSERT INTO users_new SELECT * FROM users;\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;", true, [OLD, "ALTER TABLE users ADD COLUMN phone TEXT;"]);
  expect("dropping a table made earlier in the same file passes", "CREATE TABLE scratch (x INTEGER);\nDROP TABLE scratch;", false);
  expect("DROP TABLE IF EXISTS on a name no migration made passes", "DROP TABLE IF EXISTS users_new;\nCREATE TABLE users_new (id INTEGER);", false);
  expect("DROP VIEW / DROP INDEX / DROP TRIGGER pass", "DROP VIEW IF EXISTS v;\nDROP INDEX IF EXISTS i;\nDROP TRIGGER IF EXISTS t;", false);
  expect("'DROP TABLE users' inside a string literal passes", "INSERT INTO notes (body) VALUES ('never DROP TABLE users; ok');", false);
  expect("DROP TABLE in a comment passes", "-- we used to DROP TABLE users here\n/* DELETE FROM users; */\nSELECT 1;", false);
  expect("additive migration passes", "CREATE TABLE IF NOT EXISTS people (id INTEGER);\nALTER TABLE users ADD COLUMN phone TEXT;\nINSERT OR IGNORE INTO people (id) VALUES (1);", false);
  expect("the annotated destructive migration passes", OK + "DROP TABLE users;", false);
  expect("an annotation with an empty reason is caught", "-- destructive-ok:  (backed up: R2)\nDROP TABLE users;", true);
  expect("an annotation without (backed up: …) is caught", "-- destructive-ok: retired\nDROP TABLE users;", true);
  expect("an annotation with an empty backup location is caught", "-- destructive-ok: retired (backed up: )\nDROP TABLE users;", true);

  // Grandfathering: only new or changed files are listed, against a real git history.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "migration-guard-"));
  try {
    const g = (...a) => git(tmp, ...a);
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    mkdirSync(path.join(tmp, MIGRATIONS_DIR), { recursive: true });
    writeFileSync(path.join(tmp, MIGRATIONS_DIR, "0001_old.sql"), OLD + "\nDROP TABLE legacy;\n");
    writeFileSync(path.join(tmp, MIGRATIONS_DIR, "0002_untouched.sql"), "SELECT 1;\n");
    g("add", ".");
    g("commit", "-q", "-m", "base");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(path.join(tmp, MIGRATIONS_DIR, "0003_new.sql"), "DROP TABLE users;\n");
    writeFileSync(path.join(tmp, MIGRATIONS_DIR, "README.md"), "not sql\n");
    const base = resolveBase(tmp, {});
    const files = changedMigrations(tmp, base.sha);
    const ok1 = JSON.stringify(files) === JSON.stringify([`${MIGRATIONS_DIR}/0003_new.sql`]);
    console.log(`  ${ok1 ? "✓" : "✗"} only the new file is checked; the historical DROP in 0001 is grandfathered`);
    const r1 = check(tmp, files);
    const ok2 = r1.violations.length === 1 && /DROP TABLE users/.test(r1.violations[0]);
    console.log(`  ${ok2 ? "✓" : "✗"} the new DROP is caught end to end`);
    writeFileSync(path.join(tmp, MIGRATIONS_DIR, "0002_untouched.sql"), "SELECT 1;\nDELETE FROM users;\n");
    const ok3 = changedMigrations(tmp, base.sha).includes(`${MIGRATIONS_DIR}/0002_untouched.sql`);
    console.log(`  ${ok3 ? "✓" : "✗"} a changed historical file is checked again`);
    if (!ok1 || !ok2 || !ok3) failed++;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failed) {
    console.error(`SELF-TEST FAILED — ${failed} case(s)`);
    process.exit(1);
  }
  console.log("self-test passed: every destructive shape is caught, the annotated one passes, history is grandfathered");
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────
function main() {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const dirAbs = path.join(root, MIGRATIONS_DIR);
  if (!existsSync(dirAbs)) {
    console.error(`migrations-keep-data: ${MIGRATIONS_DIR}/ does not exist — nothing to guard is not a pass`);
    process.exit(1);
  }
  const all = readdirSync(dirAbs).filter((f) => f.endsWith(".sql")).sort();
  const schema = new Map();
  for (const f of all) {
    try {
      simulate(readFileSync(path.join(dirAbs, f), "utf8"), schema, new Set(), false);
    } catch {
      /* counted below */
    }
  }
  if (all.length === 0 || schema.size === 0) {
    console.error(`migrations-keep-data: ${all.length} migration file(s), ${schema.size} table(s) replayed — a scan that sees nothing would pass everything`);
    process.exit(1);
  }
  const base = resolveBase(root);
  if (!base) {
    console.error("MIGRATION_GUARD_NO_BASE: could not resolve a base commit (PR base, push 'before', or origin/main) — cannot tell new migrations from old");
    process.exit(1);
  }
  const files = changedMigrations(root, base.sha);
  const { violations, excused } = check(root, files);
  for (const e of excused) console.log(`  excused: ${e}`);
  if (violations.length) {
    console.error(`migrations-keep-data: ${violations.length} destructive statement(s) in new or changed migrations (base: ${base.label} ${base.sha.slice(0, 7)}):`);
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error('If it is deliberate, add on its own line: -- destructive-ok: <reason> (backed up: <where>)');
    process.exit(1);
  }
  console.log(
    `migrations-keep-data: OK — ${files.length} new/changed of ${all.length} migration(s) checked against ${base.label} ${base.sha.slice(0, 7)}; ${schema.size} tables replayed; ${all.length - files.length} historical file(s) grandfathered`,
  );
}

const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (RUN_DIRECTLY && process.argv.includes("--self-test")) selfTest();
else if (RUN_DIRECTLY) main();
