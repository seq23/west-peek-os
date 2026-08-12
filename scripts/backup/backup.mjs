/**
 * backup.mjs — export all local D1 tables to a timestamped JSON file under backups/.
 *
 * The backups/ directory is gitignored and must never be packaged. This is a LOCAL
 * proof path (miniflare store only), not offsite/disaster recovery.
 *
 * Usage: node scripts/backup/backup.mjs [--out <file>]
 * Prints the written path as the last stdout line:  WROTE <path>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BACKUPS_DIR, d1Query, listUserTables } from "./d1.mjs";

export function runBackup(outFile = null) {
  const tables = listUserTables();
  if (tables.length === 0) {
    throw new Error("local D1 has no user tables — run `npm run migrate:local` first");
  }

  const data = {};
  let totalRows = 0;
  for (const table of tables) {
    const rows = d1Query(`SELECT * FROM "${table}"`);
    data[table] = rows;
    totalRows += rows.length;
  }

  const schemaVersion =
    tables.includes("schema_version") && data.schema_version.length > 0
      ? data.schema_version.map((r) => r.migration).sort().at(-1)
      : null;

  const migrationsApplied = d1Query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
  ).length
    ? d1Query("SELECT name FROM d1_migrations ORDER BY name").map((r) => r.name)
    : [];

  const createdAt = new Date().toISOString();
  const file =
    outFile ??
    path.join(BACKUPS_DIR, `wpos-backup-${createdAt.replace(/[:.]/g, "-")}.json`);

  const payload = {
    meta: {
      createdAt,
      source: "local miniflare D1 (.wrangler/state/v3/d1)",
      binding: "WP_OS_DB",
      schemaVersion,
      migrationsApplied,
      tables: tables.map((t) => ({ name: t, rows: data[t].length })),
      totalRows,
    },
    tables: data,
  };

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return { file, totalRows, tables: tables.length, schemaVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outIdx = process.argv.indexOf("--out");
    const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
    const result = runBackup(out);
    console.log(
      `backed up ${result.tables} tables / ${result.totalRows} rows (schema ${result.schemaVersion ?? "none"})`,
    );
    console.log(`WROTE ${result.file}`);
  } catch (err) {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
  }
}
