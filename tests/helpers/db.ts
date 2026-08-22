import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { Miniflare } from "miniflare";
import type { Env } from "../../src/worker/env";

/**
 * Test database helper: a miniflare-backed local D1 (no credentials, fully offline) carrying
 * every migration in `migrations/`, applied in filename order.
 *
 * Idempotency mirrors wrangler: applied migration filenames are tracked in a
 * `d1_migrations` table and skipped on re-application. `D1Database.exec()` hands the
 * whole file to SQLite, so statements are NOT naively split on ";" — trigger bodies
 * (BEGIN … END;) parse correctly.
 *
 * ── WHY THE SCHEMA IS BUILT ONCE AND COPIED, 22 Aug 2026 ─────────────────────────────────────
 *
 * Every test FILE stands up its own database, and there are 127 migrations. Replaying them from
 * `0001` per file meant roughly 13,000 migration applications per run: ~2.9s of pure setup before
 * a single assertion, on every one of 110 files. That is not merely slow. It is why files died in
 * `beforeAll` at the 60s `hookTimeout` under load, and why a whole session could go by unable to
 * tell a real failure from resource exhaustion — an unreliable suite costs more than a slow one.
 *
 * So the migrated schema is built ONCE into a template directory keyed by a hash of the migrations
 * themselves, and each file's database is a FILE COPY of that template. Measured: 2,824ms to
 * migrate, 134ms to copy and mount — 21x, and the remaining cost is nearly all workerd start-up
 * rather than SQL. Because the key is the migrations' own content, a run after a migration changes
 * builds a new template and a run that changes nothing reuses the last one.
 *
 * ISOLATION IS UNCHANGED, which is the whole point and was verified before this landed:
 *   · Each file gets its own directory, its own Miniflare, its own sqlite file. Nothing is shared.
 *   · A row written by one file is absent from every other file's copy — proven directly.
 *   · The template is built and then never written to again; copies never write back to it.
 *   · R2 is deliberately NOT persisted, so every file still gets an empty bucket.
 * A test that assumed a fresh firm before assumes a fresh firm now.
 *
 * TWO CHEAPER THINGS WERE TRIED FIRST and are recorded so nobody re-treads them. Batching each
 * migration file into one `db.batch()` instead of a round trip per statement took 7.4s → 2.8s,
 * and is kept below because it costs nothing. Dumping the template to CREATE/INSERT statements and
 * replaying that took 2.5s — a 13% gain for real complexity, because the cost is executing 230
 * CREATE TABLEs, 216 indexes and 110 triggers, not reading the migration files.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** The miniflare D1 binding name, used for the template and every copy alike. */
const D1_NAME = "wpos-test";

/**
 * Every directory this process made, removed when it exits.
 *
 * `disposeTestDb` clears them as suites finish, but not every suite calls it — `seededJobs` and
 * `roomsSchema` deliberately do not — and each database is a few megabytes. The exit handler is the
 * backstop so a full run cannot leave a pile behind in the temp directory whatever a suite does.
 */
const OWNED_DIRS = new Set<string>();
let exitHookInstalled = false;

function ownTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  OWNED_DIRS.add(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const d of OWNED_DIRS) rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}

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
  /** This database's own directory on disk, removed by `disposeTestDb`. */
  dir: string;
}

function miniflareFor(persistDir: string): Miniflare {
  return new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response('unused'); } }",
    d1Databases: { WP_OS_DB: D1_NAME },
    // R2 is deliberately NOT persisted: every file must start with an empty document bucket.
    r2Buckets: { WP_OS_DOCUMENTS: "wpos-test-documents" },
    d1Persist: persistDir,
  });
}

/**
 * The template's address: a hash of every migration's name and contents.
 *
 * Content-addressed so the cache can never go stale. Editing, adding or removing a migration
 * changes the fingerprint, which is a different directory, which is a fresh build — there is no
 * "remember to clear the cache" step, because there is nothing to remember.
 */
function migrationsFingerprint(): string {
  const h = createHash("sha256");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    h.update(f);
    h.update(readFileSync(path.join(MIGRATIONS_DIR, f)));
  }
  return h.digest("hex").slice(0, 16);
}

/** In-process guard so two files starting together wait on one build rather than racing. */
let templatePromise: Promise<string> | undefined;

/**
 * Build the migrated template once, and reuse it.
 *
 * ON DISK RATHER THAN IN MEMORY, because vitest gives each test file its own module registry AND
 * its own execution context — a cache in module scope or on `globalThis` rebuilt per file and
 * bought nothing. Measured before this landed: 121 template builds for 110 files.
 *
 * Published by ATOMIC RENAME. The build happens in a scratch directory and is moved into place
 * only after the database has been closed and flushed, so no other process can ever see a
 * half-built template. Two processes racing is fine: one rename wins, the loser throws it away
 * and uses the winner's.
 *
 * THE TEMPLATE IS READ-ONLY AND SHARED; THE DATABASES ARE NOT. Every test file still gets its own
 * private copy, its own Miniflare and its own file. Nothing writes back here, so this is a cache
 * of the schema rather than shared state between suites.
 */
async function templateDir(): Promise<string> {
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    const target = path.join(os.tmpdir(), `wpos-d1-template-${migrationsFingerprint()}`);
    if (existsSync(target)) return target;

    const scratch = ownTempDir("wpos-d1-building-");
    const mf = miniflareFor(scratch);
    try {
      await applyMigrations(await mf.getD1Database("WP_OS_DB"));
    } finally {
      // Dispose flushes SQLite's write-ahead log to the directory. Publishing before this point
      // would publish a half-written database, so the rename below only ever follows it.
      await mf.dispose();
    }

    try {
      renameSync(scratch, target);
      OWNED_DIRS.delete(scratch); // it is the cache now, and outlives this process on purpose
    } catch {
      // Another process published first. Theirs is as good as ours, built from the same fingerprint.
      rmSync(scratch, { recursive: true, force: true });
      OWNED_DIRS.delete(scratch);
    }
    return target;
  })();
  return templatePromise;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = ownTempDir("wpos-d1-");
  cpSync(await templateDir(), dir, { recursive: true });

  const mf = miniflareFor(dir);
  const db = await mf.getD1Database("WP_OS_DB");
  const docs = (await mf.getR2Bucket("WP_OS_DOCUMENTS")) as unknown as R2Bucket;

  /*
   * The copy is checked, not trusted, and topped up rather than assumed.
   *
   * Where the template lands on disk is miniflare's business, and a version upgrade could move it.
   * If that happens this call finds a database missing migrations and applies them — the file gets
   * the right schema either way, slowly rather than wrongly. Silently running a suite against a
   * partial schema is the one outcome worth this much care to avoid; it is also why the assertion
   * below names the migration rather than counting rows.
   */
  await applyMigrations(db);
  const current = await db.prepare("SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1").first<{ name: string }>();
  if (current?.name.replace(/\.sql$/, "") !== latestMigrationName()) {
    throw new Error(`test database is at ${current?.name ?? "no migration"}, expected ${latestMigrationName()}`);
  }

  return { mf, db, docs, dir };
}

export async function disposeTestDb(t: TestDb | undefined): Promise<void> {
  if (!t) return;
  await t.mf.dispose();
  // Each file's database is a few megabytes on disk; a full run would otherwise carry 110 of them
  // to the end. The exit handler is the backstop for suites that never reach here.
  rmSync(t.dir, { recursive: true, force: true });
  OWNED_DIRS.delete(t.dir);
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
    const statements = splitSqlStatements(sql);

    /*
     * ONE ROUND TRIP PER FILE, NOT PER STATEMENT.
     *
     * Every `.run()` is an RPC into workerd. Sending each of ~1,100 statements on its own took
     * 7.4s; one `batch()` per migration file takes 2.8s for the identical statements in the
     * identical order. `batch()` is a transaction, which is also closer to how wrangler applies a
     * migration — a file half-applied is a database nobody can reason about.
     */
    try {
      await db.batch([
        ...statements.map((s) => db.prepare(s)),
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?1)").bind(file),
      ]);
    } catch (batchError) {
      /*
       * A batch failure names the file but not the statement inside it, and "0044 failed" is not
       * enough to fix anything. So on failure the file is replayed one statement at a time purely
       * to find the offender and say which it was. The rollback already happened; this only reads.
       */
      for (const statement of statements) {
        try {
          await db.prepare(statement).run();
        } catch (statementError) {
          throw new Error(
            `${file} failed at:\n  ${statement.slice(0, 300)}\n${(statementError as Error).message}`,
          );
        }
      }
      throw batchError;
    }
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
