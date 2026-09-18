#!/usr/bin/env node
/**
 * a-kind-the-database-accepts.mjs — `npm run validate:deliverable-kinds`.
 *
 * ONE ASSERTION: EVERY KIND THE CODE CAN PRODUCE IS A KIND THE DATABASE WILL STORE.
 *
 * WHAT WENT WRONG. Migration 0183 built the preview lane. `DELIVERABLE_KINDS` gained
 * `approval_preview` in the same change. The CHECK on `deliverable.kind` did not. So production
 * accepted every kind except the one the new feature existed to write, and the insert that files a
 * preview died every time it ran.
 *
 * NOTHING FAILED LOUDLY, WHICH IS THE POINT. Previews reach her by email; only the archived copy
 * goes through `deliverable`. The owner reviewed a preview, said "its perfect", and the artifact
 * behind it was never stored. The only symptom anywhere was `validate:value-shapes` going red
 * against production — a check deliberately excluded from CI because it needs production
 * credentials. So the one signal was in the one place CI cannot see, and it sat there.
 *
 * This is the repo's named defect class, the one in CLAUDE.md: "two components each keeping their
 * own list with no link". A TypeScript array and a SQL CHECK, both correct-looking, agreeing with
 * nobody. Rewriting the CHECK once fixes today. This makes the two lists unable to disagree.
 *
 * WHAT IS CHECKED
 *   1 · EVERY KIND IN `DELIVERABLE_KINDS` APPEARS IN THE EFFECTIVE CHECK. A kind the code emits
 *       and the column refuses is a guaranteed runtime failure on a path somebody shipped.
 *   2 · EVERY KIND IN THE CHECK APPEARS IN `DELIVERABLE_KINDS`. The reverse is not cosmetic: a
 *       value the database accepts and the union does not name is a row no page can render and no
 *       `switch` can handle, and it will arrive from an older deploy or a hand-run statement.
 *   3 · EVERY KIND HAS A DEFINITION in `DELIVERABLE_KINDS_BY_KEY`. A key in the union with no
 *       definition is a label, page and doc_type read off `undefined` at the moment of handover.
 *   4 · NO FOREIGN KEY ANYWHERE POINTS AT A ROLLBACK COPY. Rebuilding a table to widen a CHECK
 *       requires renaming it, and SQLite rewrites other tables' foreign keys to follow the rename,
 *       so the obvious migration silently repoints them at a snapshot nothing writes to. Confirmed
 *       by experiment on 18 Sep 2026, not assumed. `legacy_alter_table` suppresses it, but a pragma
 *       D1 might ignore is not a guarantee, so the end state is asserted here instead of trusted
 *       there.
 *
 *       THIS IS THE WHOLE SCHEMA, not one column. The first version of this check looked only at
 *       `preview_approval` — the table already on the author's mind — and CI then found
 *       `deliverable_feedback.deliverable_id` pointing at `deliverable_old_0180`, dragged there by
 *       migration 0180 the previous day and unnoticed since. Every feedback row the owner left was
 *       being validated against a frozen 56-row snapshot. A scan that only looks where you already
 *       suspect is not a scan.
 *
 * THE EFFECTIVE CHECK is derived by replaying every migration in order, because the CHECK is
 * whatever the LAST statement to define the column said. Reading only the newest migration that
 * mentions `deliverable` would have this validator pass the moment somebody adds an unrelated
 * migration touching that table — the exact bug found in the sibling repo's `validate:ceiling-kind`
 * on 18 Sep 2026, whose `spendMigration()` read only the newest file and went blind.
 *
 * HARD-FAILS ON ZERO: zero kinds parsed, zero migrations read, or no CHECK found at all each exit
 * 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside a clean fixture that must pass.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const KINDS_FILE = path.join(ROOT, "src", "shared", "deliverables", "deliverable.ts");
const MIGRATIONS = path.join(ROOT, "migrations");

/** The kinds the code can emit. */
export function parseKinds(source) {
  const block = /export const DELIVERABLE_KINDS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) return null;
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** The keys that actually have a definition behind them. */
export function parseDefinedKeys(source) {
  const block = /DELIVERABLE_KINDS_BY_KEY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!block) return null;
  return [...block[1].matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

/**
 * The CHECK as the database actually holds it: the last definition wins, because a later migration
 * that rebuilds the table supersedes every earlier one. Order matters and is why this replays.
 */
export function effectiveCheck(migrationsInOrder) {
  let found = null;
  for (const sql of migrationsInOrder) {
    // Match the column definition wherever it is declared, including in a rebuild under a
    // temporary name, and keep the LAST one seen.
    for (const m of sql.matchAll(/kind\s+TEXT\s+NOT NULL\s*\n?\s*CHECK\s*\(\s*kind IN \(([^)]*)\)/g)) {
      found = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
  }
  return found;
}

/**
 * A table name that is a rollback copy rather than a live table: `_old_0180`, `_pre_0189`, `_copy`.
 * Nothing should ever reference one — they exist to be read once by a person and then forgotten.
 */
export function isRollbackCopy(name) {
  return /_(old|pre)_\d+$|_copy$/.test(name);
}

/**
 * EVERY foreign key in the schema, as it stands after every migration has run, keyed by
 * `table.column` so the last definition of each wins.
 *
 * NOT one column somebody thought to check. The reason `deliverable_feedback` pointed at
 * `deliverable_old_0180` for a full day is that the manual sweep looking for this was written for
 * `preview_approval` — the table already on the author's mind — and a single sloppy LIKE missed the
 * other one. A scan that only looks where you already suspect is not a scan.
 */
export function foreignKeys(migrationsInOrder) {
  /** @type {Map<string, string>} */
  const fks = new Map();

  /*
   * IN FILE ORDER, ONE STATEMENT AT A TIME. The first version of this grouped the work — every
   * CREATE, then every RENAME, then every DROP — and was silently wrong on exactly the migration it
   * was written for. A rebuild is create-new, drop-old, rename-new-into-place; processed in groups,
   * the drops run last and delete the keys the renames had just established, so both repaired
   * tables vanished from the scan and it reported 330 healthy keys with a straight face.
   *
   * The negative proof caught it: breaking the migration on purpose produced no violation. A guard
   * that cannot fail is the "runs but inert" defect wearing a validator's clothes, and it would
   * have shipped as proof that the thing it did not check was fine.
   */
  const STATEMENT =
    /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\)|ALTER TABLE\s+"?([a-z_0-9]+)"?\s+RENAME TO\s+"?([a-z_0-9]+)"?|DROP TABLE(?:\s+IF EXISTS)?\s+"?([a-z_0-9]+)"?/gi;

  for (const sql of migrationsInOrder) {
    for (const m of sql.matchAll(STATEMENT)) {
      const [, created, body, renameFrom, renameTo, dropped] = m;
      if (created) {
        for (const c of body.matchAll(/^\s*([a-z_0-9]+)\s+[A-Z]+[^,\n]*REFERENCES\s+"?([a-z_0-9]+)"?/gim)) {
          fks.set(`${created}.${c[1]}`, c[2]);
        }
      } else if (renameFrom) {
        for (const [key, target] of [...fks]) {
          if (key.startsWith(`${renameFrom}.`)) {
            fks.delete(key);
            fks.set(`${renameTo}.${key.slice(renameFrom.length + 1)}`, target);
          }
        }
      } else if (dropped) {
        for (const key of [...fks.keys()]) if (key.startsWith(`${dropped}.`)) fks.delete(key);
      }
    }
  }
  return fks;
}

export function audit({ kinds, defined, check, fks }) {
  const violations = [];
  for (const k of kinds) {
    if (!check.includes(k)) {
      violations.push(
        `\`${k}\` is in DELIVERABLE_KINDS but not in deliverable.kind's CHECK — the database will ` +
          `refuse every row the code writes for it`,
      );
    }
    if (!defined.includes(k)) {
      violations.push(`\`${k}\` is in DELIVERABLE_KINDS but has no entry in DELIVERABLE_KINDS_BY_KEY`);
    }
  }
  for (const k of check) {
    if (!kinds.includes(k)) {
      violations.push(
        `\`${k}\` is accepted by deliverable.kind's CHECK but is not in DELIVERABLE_KINDS — a row ` +
          `no page can render and no switch can handle`,
      );
    }
  }
  for (const [column, target] of fks) {
    if (isRollbackCopy(target)) {
      violations.push(
        `${column} references \`${target}\`, a rollback copy — a table rename dragged this foreign ` +
          `key onto a snapshot nothing writes to, so every row validates against frozen data`,
      );
    }
  }
  return violations;
}

function readMigrationsInOrder() {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return { files, sql: files.map((f) => stripCommentsFor(path.join(MIGRATIONS, f), readFileSync(path.join(MIGRATIONS, f), "utf8"))) };
}

function selfTest() {
  const fail = (m) => {
    console.error(`SELF-TEST FAILED — ${m}`);
    process.exit(1);
  };
  const ok = (m) => console.log(`  ✓ ${m}`);

  // The real pre-fix state: the union had approval_preview, the CHECK did not.
  const pre = audit({
    kinds: ["event_kit", "approval_preview"],
    defined: ["event_kit", "approval_preview"],
    check: ["event_kit"],
    fks: new Map(),
  });
  if (!pre.some((v) => v.includes("refuse every row"))) fail("the real 0183 gap was not caught");
  ok("the kind 0183 added to the code and not to the CHECK");

  const reverse = audit({ kinds: ["event_kit"], defined: ["event_kit"], check: ["event_kit", "ghost_kind"], fks: new Map() });
  if (!reverse.some((v) => v.includes("no page can render"))) fail("a CHECK-only kind was not caught");
  ok("a kind the database accepts that the code does not name");

  const undef = audit({ kinds: ["event_kit"], defined: [], check: ["event_kit"], fks: new Map() });
  if (undef.length === 0) fail("a kind with no definition was not caught");
  ok("a kind in the union with no definition behind it");

  // The silent one: the migration rebuilt the table and the rename dragged the foreign key along.
  const fk = audit({
    kinds: ["event_kit"], defined: ["event_kit"], check: ["event_kit"],
    fks: new Map([["preview_approval.deliverable_id", "deliverable_pre_0189"]]),
  });
  if (!fk.some((v) => v.includes("rollback copy"))) fail("the repointed foreign key was not caught");
  ok("preview_approval dragged onto the rollback copy by the rename");

  // The one that actually shipped, and the one a per-table check missed.
  const real = audit({
    kinds: ["event_kit"], defined: ["event_kit"], check: ["event_kit"],
    fks: new Map([["deliverable_feedback.deliverable_id", "deliverable_old_0180"]]),
  });
  if (!real.some((v) => v.includes("deliverable_feedback"))) fail("the real 0180 drag was not caught");
  ok("deliverable_feedback dragged onto deliverable_old_0180 — the one that shipped");

  // THE ORDER BUG, pinned. A rebuild is create-new, drop-old, rename-into-place. A scan that
  // groups statements by type runs the drop last and deletes the key the rename just established,
  // so the repaired table disappears and the scan reports health. This fixture is the real shape of
  // migration 0189 and must end with the key present and pointing at the live table.
  const rebuilt = foreignKeys([
    `CREATE TABLE t_new (\n  id TEXT PRIMARY KEY,\n  parent_id TEXT REFERENCES parent (id)\n);\nDROP TABLE t;\nALTER TABLE t_new RENAME TO t;`,
  ]);
  if (rebuilt.get("t.parent_id") !== "parent") {
    fail("a rebuilt table's foreign key was lost — statements are not being walked in order");
  }
  ok("a create-drop-rename rebuild keeps its foreign key (the bug that made this guard inert)");

  // The rename bookkeeping itself: a key defined under a temporary name must follow it home.
  const followed = foreignKeys([
    `CREATE TABLE d_new (\n  id TEXT PRIMARY KEY,\n  owner TEXT REFERENCES firm_user (id)\n)`,
    `ALTER TABLE d_new RENAME TO deliverable`,
  ]);
  if (followed.get("deliverable.owner") !== "firm_user") fail("a rename did not carry its foreign keys");
  ok("a foreign key follows its table through a rename");

  // Last-definition-wins: an earlier narrow CHECK must not mask a later wide one, and an unrelated
  // later migration mentioning the table must not blind the scan.
  const replayed = effectiveCheck([
    "kind TEXT NOT NULL CHECK (kind IN ('event_kit'))",
    "kind TEXT NOT NULL CHECK (kind IN ('event_kit','approval_preview'))",
    "ALTER TABLE deliverable ADD COLUMN unrelated TEXT;",
  ]);
  if (!replayed || !replayed.includes("approval_preview")) fail("replay did not take the last definition");
  ok("the last definition wins, and an unrelated later migration does not blind the scan");

  const clean = audit({
    kinds: ["event_kit", "approval_preview"],
    defined: ["event_kit", "approval_preview"],
    check: ["event_kit", "approval_preview"],
    fks: new Map([["preview_approval.deliverable_id", "deliverable"]]),
  });
  if (clean.length !== 0) fail(`a clean fixture was rejected: ${clean.join("; ")}`);
  ok("a clean fixture passes");

  console.log("DELIVERABLE KIND SELF-TEST PASSED");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const source = stripCommentsFor(KINDS_FILE, readFileSync(KINDS_FILE, "utf8"));
  const kinds = parseKinds(source);
  const defined = parseDefinedKeys(source);
  const { files, sql } = readMigrationsInOrder();
  const check = effectiveCheck(sql);
  const fks = foreignKeys(sql);

  if (!kinds || kinds.length === 0) {
    console.error("DELIVERABLE KIND SCAN FAILED — read zero kinds from DELIVERABLE_KINDS. Rule 0.");
    process.exit(1);
  }
  if (!defined || defined.length === 0) {
    console.error("DELIVERABLE KIND SCAN FAILED — read zero entries from DELIVERABLE_KINDS_BY_KEY. Rule 0.");
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("DELIVERABLE KIND SCAN FAILED — read zero migrations. Rule 0.");
    process.exit(1);
  }
  if (!check || check.length === 0) {
    console.error(
      "DELIVERABLE KIND SCAN FAILED — found no CHECK on deliverable.kind in any migration. Either the\n" +
        "column stopped being constrained, or this scan's pattern no longer matches how it is written.\n" +
        "Both are failures: an unconstrained kind column is how a typo becomes a permanent row.",
    );
    process.exit(1);
  }
  if (fks.size === 0) {
    console.error("DELIVERABLE KIND SCAN FAILED — read zero foreign keys from the migrations. Rule 0.");
    process.exit(1);
  }

  const violations = audit({ kinds, defined, check, fks });
  if (violations.length > 0) {
    console.error("DELIVERABLE KIND SCAN FAILED — the code and the database disagree about what can be delivered:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nDELIVERABLE_KINDS in src/shared/deliverables/deliverable.ts and the CHECK on deliverable.kind\n" +
        "are one list kept in two places. Adding a kind means a migration that widens the CHECK in the\n" +
        "same change — migration 0183 added `approval_preview` to the code and not to the column, and\n" +
        "the preview lane could not file a single artifact until 0189 fixed it.",
    );
    process.exit(1);
  }

  console.log(
    `DELIVERABLE KIND SCAN PASSED: ${kinds.length} kind(s) in DELIVERABLE_KINDS, each defined and each ` +
      `accepted by deliverable.kind's CHECK as replayed across ${files.length} migrations; the CHECK ` +
      `names nothing the code cannot render; none of ${fks.size} foreign keys points at a rollback copy.`,
  );
}

main();
