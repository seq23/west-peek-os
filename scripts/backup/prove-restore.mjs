/**
 * prove-restore.mjs — end-to-end local backup/restore proof:
 *   seed proof record → backup → wipe local D1 → restore → record readable again.
 *
 * Operates ONLY on the local miniflare D1 (.wrangler/state). Exits non-zero on any
 * failure. The proof record is an append-only event_record row, left in place.
 */
import { pathToFileURL } from "node:url";
import { d1Exec, d1Migrate, d1Query, wipeLocalDb } from "./d1.mjs";
import { runBackup } from "./backup.mjs";
import { runRestore } from "./restore.mjs";

export function proveRestore() {
  const proofId = `evt_backup_proof_${Date.now()}`;
  const steps = [];
  const step = (name, fn) => {
    process.stdout.write(`• ${name} … `);
    const result = fn();
    steps.push(name);
    console.log("ok");
    return result;
  };

  step("apply migrations to local D1", () => d1Migrate());

  step(`insert proof record ${proofId}`, () =>
    d1Exec(
      `INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
       VALUES ('${proofId}', 'backup_restore.proof', 'system', 'prove-restore', 'backup', 'local', 'firm', '{}')`,
    ),
  );

  const backup = step("backup all tables", () => runBackup());

  step("wipe local D1 (drop all tables)", () => wipeLocalDb());

  step("restore from backup", () => runRestore(backup.file));

  const found = step("read proof record back", () =>
    d1Query(`SELECT id, event_type FROM event_record WHERE id = '${proofId}'`),
  );
  if (found.length !== 1) {
    throw new Error(`proof record ${proofId} not readable after restore (found ${found.length})`);
  }

  const seeds = d1Query("SELECT COUNT(*) AS n FROM firm_user")[0]?.n ?? 0;
  if (seeds < 2) throw new Error(`seeded firm users missing after restore (found ${seeds})`);

  return { proofId, backupFile: backup.file, steps };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = proveRestore();
    console.log(`PROOF PASSED — ${result.proofId} readable after wipe+restore (backup: ${result.backupFile})`);
  } catch (err) {
    console.error(`PROOF FAILED — ${err.message}`);
    process.exit(1);
  }
}
