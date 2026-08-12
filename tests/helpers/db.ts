import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Miniflare } from "miniflare";
import type { Env } from "../../src/worker/env";

/**
 * Test database helper: a miniflare-backed local D1 (in-memory; no credentials, fully
 * offline) with all migrations/*.sql applied in filename order.
 *
 * Idempotency mirrors wrangler: applied migration filenames are tracked in a
 * `d1_migrations` table and skipped on re-application. `D1Database.exec()` hands the
 * whole file to SQLite, so statements are NOT naively split on ";" — trigger bodies
 * (BEGIN … END;) parse correctly.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/**
 * The migration the schema should report as current: the last file in the
 * migrations directory, without its `.sql` suffix. Derived (not hard-coded) so a
 * new phase migration cannot leave a stale pin behind in the assertions.
 */
export function latestMigrationName(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const last = files[files.length - 1];
  if (!last) throw new Error("no migrations found");
  return last.replace(/\.sql$/, "");
}

export interface TestDb {
  mf: Miniflare;
  db: D1Database;
  /** Local miniflare R2 bucket for document round-trip tests (P5). */
  docs: R2Bucket;
}

export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response('unused'); } }",
    d1Databases: { WP_OS_DB: "wpos-test" },
    r2Buckets: { WP_OS_DOCUMENTS: "wpos-test-documents" },
  });
  const db = await mf.getD1Database("WP_OS_DB");
  const docs = (await mf.getR2Bucket("WP_OS_DOCUMENTS")) as unknown as R2Bucket;
  await applyMigrations(db);
  return { mf, db, docs };
}

export async function disposeTestDb(t: TestDb | undefined): Promise<void> {
  await t?.mf.dispose();
}

/**
 * Split a migration file into individual SQLite statements.
 *
 * Needed because the D1 `exec()` splitter (workerd) splits naively on ";" and rejects
 * comment-only segments — both break on our migration files (leading comments, trigger
 * bodies with BEGIN …; END;). This splitter:
 * - strips `--` line comments and `/* … *\/` block comments,
 * - respects single-quoted string literals (with '' escapes),
 * - does not split inside BEGIN…END blocks (trigger bodies).
 * Limitation: CASE…END expressions inside a trigger body would confuse the depth
 * counter; migrations must not use them (none do).
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0; // BEGIN…END nesting depth
  let i = 0;

  const flush = () => {
    const s = current.trim();
    if (s.length > 0) statements.push(s);
    current = "";
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (word === "BEGIN") depth++;
      else if (word === "END" && depth > 0) depth--;
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ";" && depth === 0) {
      flush();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  flush();
  return statements;
}

/** Returns the migration filenames applied by THIS call (already-applied ones are skipped). */
export async function applyMigrations(db: D1Database): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
  );
  const appliedRows = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set((appliedRows.results ?? []).map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const justApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of splitSqlStatements(sql)) {
      await db.prepare(statement).run();
    }
    await db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(file).run();
    justApplied.push(file);
  }
  return justApplied;
}

/** Minimal Env for exercising the worker handler directly. */
export function makeTestEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    WP_OS_DB: db,
    WP_OS_ENV: "local",
    ASSETS: {
      fetch: async () => new Response("<html>spa</html>", {
        headers: { "content-type": "text/html" },
      }),
    } as unknown as Fetcher,
    ...overrides,
  };
}
