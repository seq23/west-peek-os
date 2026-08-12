/**
 * restore.mjs — restore a backup JSON into an EMPTY local D1.
 *
 * Refuses to run against a non-empty local D1 unless `--force` is passed (which drops
 * every existing table first). Mechanism:
 *   1. verify emptiness (or wipe with --force),
 *   2. `wrangler d1 migrations apply --local` to rebuild schema + seeds and record
 *      d1_migrations so future migrate runs stay consistent,
 *   3. drop the append-only/immutability triggers for the duration of the load,
 *   4. replace seed content with the backup's rows per table (plain INSERTs),
 *   5. RECREATE every dropped trigger and verify the full set is back,
 *   6. verify restored row counts against the backup manifest.
 *
 * Why step 3 exists: those triggers exist to stop the APPLICATION from rewriting
 * institutional history, and they do their job — they also reject the DELETEs a
 * faithful reload needs. A restore is a privileged administrative rebuild, not an
 * application flow, and it is already gated behind `--force`. Step 5 is the part
 * that matters: a restore that quietly left the guarantees off would be far worse
 * than one that failed, so the trigger set is re-created from its own recorded SQL
 * and counted back before the restore is allowed to report success.
 *
 * Usage: node scripts/backup/restore.mjs [--file <backup.json>] [--force]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BACKUPS_DIR,
  d1Exec,
  d1Migrate,
  d1Query,
  isLocalDbEmpty,
  sqlLiteral,
  wipeLocalDb,
} from "./d1.mjs";

const BATCH_SIZE = 50;

function latestBackupFile() {
  if (!existsSync(BACKUPS_DIR)) return null;
  const files = readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith("wpos-backup-") && f.endsWith(".json"))
    .sort();
  return files.length > 0 ? path.join(BACKUPS_DIR, files[files.length - 1]) : null;
}

function insertRows(table, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const columns = Object.keys(batch[0]);
    const values = batch
      .map((row) => `(${columns.map((c) => sqlLiteral(row[c])).join(", ")})`)
      .join(", ");
    d1Exec(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${values}`);
  }
}

/**
 * Run `fn(table)` over tables in an FK-safe order without hardcoding dependencies:
 * retry in passes — tables whose constraints are satisfied succeed first, dependents
 * succeed in later passes (children-first for DELETE, parents-first for INSERT).
 */
function inDependencyOrder(tables, fn, label) {
  let remaining = [...tables];
  let lastError = null;
  while (remaining.length > 0) {
    const stuck = [];
    for (const table of remaining) {
      try {
        fn(table);
      } catch (err) {
        lastError = err;
        stuck.push(table);
      }
    }
    if (stuck.length === remaining.length) {
      const cause = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`${label} made no progress; tables stuck: ${stuck.join(", ")}. Last error: ${cause}`);
    }
    remaining = stuck;
  }
}

export function runRestore(backupFile, { force = false } = {}) {
  if (!backupFile || !existsSync(backupFile)) {
    throw new Error(`backup file not found: ${backupFile ?? "(none — no backups/ present)"}`);
  }
  const backup = JSON.parse(readFileSync(backupFile, "utf8"));

  if (!isLocalDbEmpty()) {
    if (!force) {
      throw new Error("local D1 is not empty — refusing to restore without --force");
    }
    wipeLocalDb();
  }

  // Rebuild schema via the migration runner so d1_migrations stays truthful.
  d1Migrate();

  const tables = Object.keys(backup.tables);

  // event_record is append-only (D15): never wiped. It is empty right after migrations
  // and gets the backup's rows appended below.
  const eventCount = d1Query("SELECT COUNT(*) AS n FROM event_record")[0]?.n ?? 0;
  if (tables.includes("event_record") && eventCount !== 0) {
    throw new Error("event_record is not empty after migration apply; refusing to append");
  }

  // Take the append-only/immutability triggers down for the load, recording their
  // own CREATE statements so they can be put back exactly as the migrations wrote them.
  const triggers = d1Query("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL");
  for (const trigger of triggers) d1Exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);

  // Replace migration seed content with the backup's rows.
  inDependencyOrder(tables, (table) => d1Exec(`DELETE FROM "${table}"`), "seed wipe");
  inDependencyOrder(tables, (table) => insertRows(table, backup.tables[table]), "row insert");

  // Put every guarantee back, and prove it. A restored database that lost its
  // append-only enforcement is not a restored database.
  for (const trigger of triggers) d1Exec(trigger.sql);
  const restoredTriggers = d1Query("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name);
  const missing = triggers.map((t) => t.name).filter((name) => !restoredTriggers.includes(name));
  if (missing.length > 0) {
    throw new Error(`restore verification failed: ${missing.length} append-only trigger(s) were not restored: ${missing.join(", ")}`);
  }

  // Verify row counts against the backup manifest.
  for (const [table, rows] of Object.entries(backup.tables)) {
    const actual = d1Query(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n ?? 0;
    if (actual !== rows.length) {
      throw new Error(`restore verification failed: ${table} has ${actual} rows, expected ${rows.length}`);
    }
  }
  return { tables: Object.fromEntries(tables.map((t) => [t, backup.tables[t].length])), backupMeta: backup.meta };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fileIdx = process.argv.indexOf("--file");
    const file = fileIdx >= 0 ? process.argv[fileIdx + 1] : latestBackupFile();
    const force = process.argv.includes("--force");
    const result = runRestore(file, { force });
    const summary = Object.entries(result.tables)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    console.log(`restored from backup of ${result.backupMeta.createdAt}: ${summary}`);
  } catch (err) {
    console.error(`restore failed: ${err.message}`);
    process.exit(1);
  }
}
