/**
 * Shared local-D1 access for backup/restore.
 *
 * Mechanism: shells out to `npx wrangler d1 execute WP_OS_DB --local …`, which operates
 * on the SAME miniflare-backed SQLite store that `wrangler dev` and
 * `wrangler d1 migrations apply --local` use (`.wrangler/state/v3/d1/…`). Fully offline;
 * no Cloudflare credentials involved. `--remote` is never used.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BACKUPS_DIR = fileURLToPath(new URL("../../backups", import.meta.url));
export const DB_BINDING = "WP_OS_DB";

const MAX_BUFFER = 512 * 1024 * 1024;

function wrangler(args, { json = false } = {}) {
  const fullArgs = ["wrangler", ...args];
  const stdout = execFileSync("npx", fullArgs, {
    cwd: APP_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "true" }, // non-interactive
  });
  return stdout;
}

/** Run a read/write SQL command against the local D1; returns all result rows. */
export function d1Query(sql) {
  const out = wrangler(["d1", "execute", DB_BINDING, "--local", "--json", "--command", sql]);
  const parsed = JSON.parse(out);
  return parsed.flatMap((entry) => entry.results ?? []);
}

/** Run SQL without needing result rows (DDL/DML). */
export function d1Exec(sql) {
  wrangler(["d1", "execute", DB_BINDING, "--local", "--command", sql]);
}

/** Apply all pending migrations to the local D1 (idempotent; wrangler tracks d1_migrations). */
export function d1Migrate() {
  wrangler(["d1", "migrations", "apply", DB_BINDING, "--local"]);
}

/** Names of all user tables (excludes SQLite/miniflare internals and wrangler's d1_migrations). */
export function listUserTables() {
  return d1Query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
  ).map((r) => r.name);
}

export function isLocalDbEmpty() {
  return listUserTables().length === 0;
}

/** Drop every table (user + d1_migrations). The local dev store only — destructive.
 *  FK enforcement is on, so parents can only drop after their children: retry in
 *  passes until nothing remains. */
export function wipeLocalDb() {
  let remaining = d1Query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).map((r) => r.name);
  while (remaining.length > 0) {
    const stillThere = [];
    for (const name of remaining) {
      try {
        d1Exec(`DROP TABLE IF EXISTS "${name}"`);
      } catch {
        stillThere.push(name);
      }
    }
    if (stillThere.length === remaining.length) {
      throw new Error(`wipe made no progress; tables stuck: ${stillThere.join(", ")}`);
    }
    remaining = stillThere;
  }
}

/** Escape a JS value as a SQLite literal. */
export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}
