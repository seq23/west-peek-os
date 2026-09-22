#!/usr/bin/env node
/**
 * a-kind-has-one-registry.mjs — `npm run validate:card-kinds`.
 *
 * ONE ASSERTION: THERE IS EXACTLY ONE LIST OF THE VALUES `work_card.kind` CAN HOLD.
 *
 * WHAT WAS WRONG. `kind` decides which runner the sweep hands a card to — nine values, written
 * from eight different files, compared in four more, and named nowhere. `workSweep.ts` knew six of
 * them, `productions.ts` knew three, `preview.ts` kept its own list of seven, `blocks.ts` kept a
 * fourth list so a job name could not leak into a sentence a partner reads. Four components each
 * keeping their own list with no link: this repo's named defect class.
 *
 * The question that made it matter is the operator's, and it is not academic: "what can I start
 * myself?" A card of a recurring kind is opened by its job under a title that job composes, and
 * `duplicateOf()` in `services/workCards.ts` joins a new card to a live one with the same title
 * and owner. So a hand-made "Productions press for October" is not a second card — it is silently
 * joined to the job's card, and the person who wrote it watches nothing happen. Offering that door
 * is worse than not having one.
 *
 * `src/shared/work/cardKinds.ts` is now the one list. This scan is what keeps it one.
 *
 * WHAT IS CHECKED
 *   1 · THE REGISTRY IS WELL FORMED. Every entry has a SCREAMING_SNAKE key, a label, a one-line
 *       sentence, a door of EMAIL | HAND | JOB and a non-empty `requires`. Keys are unique.
 *   2 · `startableByHand` IS DERIVED, NOT ASSERTED. A JOB-door kind must be `false` and must say
 *       why in its own sentence; every other door must be `true`. A flag that can disagree with
 *       the door is a third list.
 *   3 · EVERY WRITE SITE IS ACCOUNTED FOR. Every `INSERT INTO work_card` / `UPDATE work_card SET
 *       kind` in `src/worker` must be in the in-file register below, and every register entry must
 *       still point at a site that exists. A stale exemption FAILS — the register cannot outlive
 *       the code it exempts.
 *   4 · EVERY KIND A WRITE SITE CAN WRITE IS REGISTERED. A site writing a SQL literal is read
 *       directly. A site binding a value names the SYMBOL that holds its kinds, and the literals
 *       are read out of that symbol's declaration in the real source — never restated here. A
 *       pass-through site (one that writes back a kind it just read off `work_card`) must prove it
 *       really does read it back.
 *
 *       THE WRITE SIDE IS THE COMPLETE GUARD. A kind cannot be in the database unless something
 *       put it there, so covering every write site covers every kind that can exist.
 *   5 · EVERY KIND THE WORKER COMPARES IS REGISTERED. `card.kind === "…"` anywhere under
 *       `src/worker` or `src/shared`. A comparison against an unregistered kind is a branch that
 *       can never be taken, or a registry that has fallen behind.
 *   6 · NO REGISTRY ENTRY IS DEAD. Every key appears as a literal somewhere in the worker or the
 *       shared tree. An entry nothing uses is a promise the product does not keep.
 *   7 · EVERY JOB-DOOR KIND IS BANNED FROM A BLOCK SENTENCE. `shared/work/blocks.ts` refuses an
 *       internal stage or job name in the sentence a partner reads. Which names those are is the
 *       registry's to say, so a new recurring kind cannot be added without that list covering it.
 *
 * HARD-FAILS ON ZERO: zero kinds, zero write sites, or zero comparisons each exit 1. An empty loop
 * reporting success is Rule 0.
 *
 * `--self-test` feeds broken registries, a stale register entry, an unregistered kind and a
 * job-door kind missing from the banned list through the same functions and requires each to be
 * caught, alongside the shipped registry, which must pass.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";
import { loadTs } from "./lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTRY = path.join(ROOT, "src", "shared", "work", "cardKinds.ts");
const WORKER_DIR = path.join(ROOT, "src", "worker");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const BLOCKS = path.join(ROOT, "src", "shared", "work", "blocks.ts");

const DOORS = ["EMAIL", "HAND", "JOB"];

/**
 * THE WRITE-SITE REGISTER. One entry per file that writes `work_card.kind`, saying how the kinds
 * it can write are resolved. `symbol` is read out of the real source — this file never restates a
 * kind. `passThrough` means the site writes back a kind it has just read off `work_card`, which
 * introduces no new value; the scan proves the read is really there.
 *
 * An entry whose file has no write site FAILS, and a write site with no entry FAILS. The register
 * says how to resolve, never what the answer is.
 */
export const WRITE_SITES = [
  { file: "src/worker/services/workCards.ts", symbol: "kind", why: "the one INSERT that creates a card; the default kind is decided from her words" },
  { file: "src/worker/services/productions.ts", symbol: "ProductionsKind", why: "the three monthly Productions duties stamp their card" },
  { file: "src/worker/services/productionsHire.ts", symbol: "HIRE_CARD_KIND", why: "Walker's weekly hire search stamps its card" },
  { file: "src/worker/services/webPropertyChange.ts", symbol: "WEB_PROPERTY_CHANGE_KIND", why: "Porter's web property change stamps its card" },
  { file: "src/worker/services/roomPacket.ts", why: "SQL literal — the Room packet stamps its own card" },
  { file: "src/worker/services/deck.ts", why: "SQL literal — a sent-back deck version opens Preston's rework" },
  { file: "src/worker/services/dealIntake.ts", why: "SQL literal — an inbound ask for blog help is stamped at the door" },
  { file: "src/worker/services/employeeWork.ts", passThrough: true, why: "a chief of staff handing work on copies the kind it just read off the original card" },
];

// ── Reading the tree ──────────────────────────────────────────────────────────────────────────

function readTree(dir, ext = ".ts") {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(ext) || name.endsWith(".tsx")) {
        const rel = path.relative(ROOT, full).split(path.sep).join("/");
        out[rel] = stripCommentsFor(full, readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return out;
}

// ── 1 · The registry is well formed ───────────────────────────────────────────────────────────

export function checkRegistryShape(kinds) {
  const violations = [];
  const seen = new Set();
  for (const k of kinds ?? []) {
    const at = k?.key ?? "(an entry with no key)";
    if (!k?.key || !/^[A-Z][A-Z0-9_]*$/.test(k.key)) violations.push(`${at} — a kind's key is the literal stored in work_card.kind and must be SCREAMING_SNAKE`);
    if (seen.has(k?.key)) violations.push(`${at} — listed twice; a key that appears twice is two answers to one question`);
    seen.add(k?.key);
    if (!k?.label || !k.label.trim()) violations.push(`${at} — has no label, so nothing can name it on screen`);
    if (!k?.oneLine || k.oneLine.trim().length < 20) violations.push(`${at} — has no one-line sentence; the registry exists to answer "what is this" without a grep`);
    if (!DOORS.includes(k?.door)) violations.push(`${at} — door is ${JSON.stringify(k?.door)}, and a card comes through one of ${DOORS.join(" | ")}`);
    if (typeof k?.startableByHand !== "boolean") violations.push(`${at} — startableByHand must be true or false, never absent`);
    if (!Array.isArray(k?.requires) || k.requires.length === 0 || k.requires.some((r) => typeof r !== "string" || !r.trim())) {
      violations.push(`${at} — requires must name at least one thing the runner cannot start without`);
    }
  }
  return { examined: (kinds ?? []).length, violations };
}

// ── 2 · startableByHand is derived from the door ──────────────────────────────────────────────

export function checkHandDoorFollowsTheJobDoor(kinds) {
  const violations = [];
  for (const k of kinds ?? []) {
    const job = k?.door === "JOB";
    if (job && k.startableByHand !== false) {
      violations.push(
        `${k.key} — opened by a job but marked startable by hand. duplicateOf() in services/workCards.ts joins a ` +
          "new card to a live one with the same title and owner, so a hand-made one would be silently joined to the " +
          "job's card and never worked. That is not a rough door; it is no door.",
      );
    }
    if (!job && k?.startableByHand !== true) {
      violations.push(`${k.key} — comes through the ${k?.door} door, which a person drives, yet it is marked not startable by hand`);
    }
    if (k?.startableByHand === false && !/\bjob\b/i.test(k?.oneLine ?? "")) {
      violations.push(`${k.key} — cannot be started by hand and its sentence does not say why. "You cannot" with no reason is the answer that sends her to an engineer.`);
    }
  }
  return { examined: (kinds ?? []).length, violations };
}

// ── 3 & 4 · Every write site is registered, and writes only registered kinds ───────────────────

// Bounded to ONE statement: the character class stops at the quote or backtick that closes the
// SQL string, so an unrelated `UPDATE work_card SET state = …` cannot run on into the next line
// and find the word "kind" in a different query. That false positive was the scan's first defect.
const WRITE_SITE = /INSERT INTO work_card\b(?![_a-z])|UPDATE work_card\s+SET[^`"\n;]{0,200}\bkind\b/g;
const SQL_KIND_LITERAL = /SET kind = '([A-Z][A-Z0-9_]*)'/g;

/** Which files under the worker actually write `work_card.kind`. Derived, never declared. */
export function findWriteSites(sources) {
  const found = [];
  for (const [file, src] of Object.entries(sources)) {
    WRITE_SITE.lastIndex = 0;
    if (WRITE_SITE.test(src)) found.push(file);
  }
  return found.sort();
}

/**
 * The string literals a named symbol can hold, read out of the real source: a `const NAME = "X"`,
 * a `type Name = "A" | "B"`, or a `const name = …` initialiser that names kinds inline. Returns
 * null when the symbol cannot be found at all, which is how a stale register entry fails.
 */
export function literalsOfSymbol(sources, symbol, preferFile = null) {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decls = [
    new RegExp(`\\btype\\s+${esc}\\s*=([^;]{0,600});`),
    new RegExp(`\\bconst\\s+${esc}\\s*(?::[^=]{0,120})?=([^;]{0,600});`),
  ];
  // The declaring file first: `const kind = …` is a common local name, and searching the whole
  // tree for it found somebody else's. Then the rest, for a constant imported from shared/.
  const order = preferFile && sources[preferFile] !== undefined
    ? [sources[preferFile], ...Object.entries(sources).filter(([f]) => f !== preferFile).map(([, v]) => v)]
    : Object.values(sources);
  for (const src of order) {
    for (const d of decls) {
      const m = d.exec(src);
      if (!m) continue;
      const lits = [...m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((x) => x[1]);
      if (lits.length > 0) return lits;
    }
  }
  return null;
}

export function checkWriteSites(sources, kinds, register = WRITE_SITES, symbolSources = null) {
  const violations = [];
  const keys = new Set((kinds ?? []).map((k) => k.key));
  const sites = findWriteSites(sources);
  const registered = new Map(register.map((e) => [e.file, e]));

  for (const site of sites) {
    if (!registered.has(site)) {
      violations.push(
        `${site} writes work_card.kind and is not in the write-site register in this scan. Every write site is ` +
          "named there with how its kinds are resolved, or a new kind can enter the database unregistered.",
      );
    }
  }
  for (const entry of register) {
    if (!sites.includes(entry.file)) {
      violations.push(`${entry.file} is in the write-site register (“${entry.why}”) but no longer writes work_card.kind — a stale exemption`);
      continue;
    }
    const src = sources[entry.file];
    if (entry.passThrough) {
      if (!/SELECT kind[\s\S]{0,200}?FROM work_card/.test(src)) {
        violations.push(`${entry.file} is registered as a pass-through but never reads kind back off work_card, so it is writing a value from somewhere else`);
      }
      continue;
    }
    const written = [...src.matchAll(SQL_KIND_LITERAL)].map((m) => m[1]);
    if (entry.symbol) {
      const lits = literalsOfSymbol(symbolSources ?? sources, entry.symbol, entry.file);
      if (lits === null) {
        violations.push(`${entry.file} resolves its kinds through \`${entry.symbol}\`, and no declaration of that symbol holding string literals exists any more — the register is stale`);
      } else {
        written.push(...lits);
      }
    }
    if (written.length === 0 && !entry.symbol) {
      violations.push(`${entry.file} is registered as writing SQL literals and none were found — either the write moved or this parse is stale`);
    }
    for (const w of written) {
      if (!keys.has(w)) violations.push(`${entry.file} can write kind "${w}", which is not in src/shared/work/cardKinds.ts`);
    }
  }
  return { examined: sites.length, violations };
}

// ── 5 · Every kind the worker compares is registered ──────────────────────────────────────────

const CARD_KIND_COMPARISON = /\bcard\.kind\s*(?:===|!==)\s*"([A-Z][A-Z0-9_]*)"/g;

export function checkComparisons(sources, kinds) {
  const keys = new Set((kinds ?? []).map((k) => k.key));
  const violations = [];
  let examined = 0;
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(CARD_KIND_COMPARISON)) {
      examined += 1;
      if (!keys.has(m[1])) {
        violations.push(`${file} compares card.kind against "${m[1]}", which is not in src/shared/work/cardKinds.ts — a branch that can never be taken, or a registry that has fallen behind`);
      }
    }
  }
  return { examined, violations };
}

// ── 6 · No registry entry is dead ─────────────────────────────────────────────────────────────

export function checkNothingIsDead(sources, kinds) {
  const violations = [];
  const all = Object.entries(sources);
  for (const k of kinds ?? []) {
    const lit = `"${k.key}"`;
    const sql = `'${k.key}'`;
    const used = all.some(([file, src]) => !file.endsWith("shared/work/cardKinds.ts") && (src.includes(lit) || src.includes(sql)));
    if (!used) violations.push(`${k.key} is in the registry and appears nowhere in src/worker or src/shared — an entry nothing uses is a promise the product does not keep`);
  }
  return { examined: (kinds ?? []).length, violations };
}

// ── 7 · A job name never reaches a sentence a partner reads ───────────────────────────────────

/**
 * `blocks.ts` refuses "an internal stage or job name" in a block sentence. WHICH names those are is
 * the registry's to say — otherwise adding a recurring kind quietly widens what can be pasted into
 * the one sentence the operator is meant to be able to act on.
 */
export function checkJobKindsAreBannedFromBlockSentences(blocksSrc, kinds) {
  const violations = [];
  // ONE ENTRY, not everything up to it: the entries are one per line, and `[\s\S]*?` swallowed the
  // four patterns above this one into a regex that matched nothing.
  const block = /\{\s*pattern:\s*(\/[^\n]*?\/[a-z]*)\s*,\s*why:\s*"an internal stage or job name"/.exec(blocksSrc ?? "");
  if (!block) {
    return {
      examined: 0,
      violations: ["shared/work/blocks.ts no longer carries a banned pattern reasoned 'an internal stage or job name' — either the guard went, or this parse is stale"],
    };
  }
  const body = block[1].slice(1, block[1].lastIndexOf("/"));
  let re;
  try {
    re = new RegExp(body);
  } catch {
    return { examined: 0, violations: [`the banned 'internal stage or job name' pattern in blocks.ts does not compile here: ${body}`] };
  }
  let examined = 0;
  for (const k of (kinds ?? []).filter((x) => x.door === "JOB")) {
    examined += 1;
    if (!re.test(k.key)) {
      violations.push(`${k.key} is opened by a job and the banned-words pattern in shared/work/blocks.ts does not catch it — a job name could be pasted into the sentence a partner reads and is asked to act on`);
    }
  }
  return { examined, violations };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

const GOOD = [
  { key: "ARTIFACT", label: "Build me something", oneLine: "One producer builds the thing you asked for and files it.", startableByHand: true, requires: ["what to build"], door: "HAND" },
  { key: "ROOM_PACKET", label: "Room packet", oneLine: "Opened by the Room job for the month it is building; a hand-made one would be joined to that job's card.", startableByHand: false, requires: ["the month"], door: "JOB" },
];

const SELF_TEST = {
  "an entry with no door": {
    run: () => checkRegistryShape([{ ...GOOD[0], door: "POST" }]).violations,
    expect: /comes through one of/,
  },
  "an entry with nothing it requires": {
    run: () => checkRegistryShape([{ ...GOOD[0], requires: [] }]).violations,
    expect: /at least one thing the runner cannot start without/,
  },
  "the shipped shape of a good pair": {
    run: () => checkRegistryShape(GOOD).violations,
    expect: null,
  },
  "a job kind offered as a hand door": {
    run: () => checkHandDoorFollowsTheJobDoor([{ ...GOOD[1], startableByHand: true }]).violations,
    expect: /silently joined to the job's card/,
  },
  "a hand kind refused by hand": {
    run: () => checkHandDoorFollowsTheJobDoor([{ ...GOOD[0], startableByHand: false, oneLine: "the job opens it" }]).violations,
    expect: /which a person drives/,
  },
  "a refusal with no reason in its sentence": {
    run: () => checkHandDoorFollowsTheJobDoor([{ ...GOOD[1], oneLine: "You cannot start one of these yourself, sorry." }]).violations,
    expect: /does not say why/,
  },
  "the good pair passes the door rule": {
    run: () => checkHandDoorFollowsTheJobDoor(GOOD).violations,
    expect: null,
  },
  "a write site nobody registered": {
    run: () =>
      checkWriteSites(
        { "src/worker/services/newThing.ts": "UPDATE work_card SET kind = 'ARTIFACT' WHERE id = ?1" },
        GOOD,
        [],
      ).violations,
    expect: /not in the write-site register/,
  },
  "a register entry whose file stopped writing": {
    run: () => checkWriteSites({ "src/worker/services/gone.ts": "const x = 1;" }, GOOD, [{ file: "src/worker/services/gone.ts", why: "SQL literal" }]).violations,
    expect: /stale exemption/,
  },
  "a site writing a kind nobody registered": {
    run: () =>
      checkWriteSites(
        { "src/worker/services/x.ts": "UPDATE work_card SET kind = 'INVOICE_CHASE' WHERE id = ?1" },
        GOOD,
        [{ file: "src/worker/services/x.ts", why: "SQL literal" }],
      ).violations,
    expect: /"INVOICE_CHASE", which is not in/,
  },
  "a symbol the register names and the source no longer declares": {
    run: () =>
      checkWriteSites(
        { "src/worker/services/x.ts": "UPDATE work_card SET kind = ?2 WHERE id = ?1" },
        GOOD,
        [{ file: "src/worker/services/x.ts", symbol: "GONE_KIND", why: "bound" }],
      ).violations,
    expect: /the register is stale/,
  },
  "a symbol whose union has drifted": {
    run: () =>
      checkWriteSites(
        {
          "src/worker/services/x.ts": 'UPDATE work_card SET kind = ?2 WHERE id = ?1\ntype XKind = "ARTIFACT" | "INVOICE_CHASE";',
        },
        GOOD,
        [{ file: "src/worker/services/x.ts", symbol: "XKind", why: "bound" }],
      ).violations,
    expect: /"INVOICE_CHASE", which is not in/,
  },
  "a pass-through that does not read the kind back": {
    run: () =>
      checkWriteSites(
        { "src/worker/services/x.ts": "UPDATE work_card SET kind = ?2 WHERE id = ?1" },
        GOOD,
        [{ file: "src/worker/services/x.ts", passThrough: true, why: "hands on" }],
      ).violations,
    expect: /never reads kind back off work_card/,
  },
  "a comparison against an unregistered kind": {
    run: () => checkComparisons({ "src/worker/services/x.ts": 'if (card.kind === "INVOICE_CHASE") {}' }, GOOD).violations,
    expect: /compares card.kind against "INVOICE_CHASE"/,
  },
  "a comparison against a registered kind": {
    run: () => checkComparisons({ "src/worker/services/x.ts": 'if (card.kind === "ARTIFACT") {}' }, GOOD).violations,
    expect: null,
  },
  "a registry entry nothing uses": {
    run: () => checkNothingIsDead({ "src/worker/services/x.ts": 'card.kind === "ARTIFACT"' }, GOOD).violations,
    expect: /appears nowhere in src\/worker or src\/shared/,
  },
  "a job kind the block sentence guard does not ban": {
    run: () =>
      checkJobKindsAreBannedFromBlockSentences(
        '{ pattern: /\\b(DISCOVER|ARTIFACT)\\b/, why: "an internal stage or job name" },',
        GOOD,
      ).violations,
    expect: /pasted into the sentence a partner reads/,
  },
  "a job kind the guard does ban": {
    run: () =>
      checkJobKindsAreBannedFromBlockSentences(
        '{ pattern: /\\b(DISCOVER|ROOM_PACKET)\\b/, why: "an internal stage or job name" },',
        GOOD,
      ).violations,
    expect: null,
  },
  "the banned pattern having gone entirely": {
    run: () => checkJobKindsAreBannedFromBlockSentences("const BANNED = [];", GOOD).violations,
    expect: /no longer carries a banned pattern/,
  },
};

async function selfTest() {
  let failed = 0;
  for (const [name, c] of Object.entries(SELF_TEST)) {
    const found = c.run();
    const caught = c.expect === null ? found.length === 0 : found.some((v) => c.expect.test(v));
    if (!caught) {
      console.error(`SELF-TEST FAILED — "${name}": expected ${c.expect ?? "no violation"}, got ${JSON.stringify(found)}`);
      failed += 1;
    }
  }
  // The clean fixture that matters most: the shipped registry, through the shipped rules.
  const { CARD_KINDS } = await loadTs(REGISTRY);
  const shipped = [...checkRegistryShape(CARD_KINDS).violations, ...checkHandDoorFollowsTheJobDoor(CARD_KINDS).violations];
  if (shipped.length > 0) {
    console.error(`SELF-TEST FAILED — the shipped registry does not pass its own standard: ${shipped.join("; ")}`);
    failed += 1;
  }
  if (failed > 0) process.exit(1);
  console.log(`CARD-KIND SELF-TEST PASSED: ${Object.keys(SELF_TEST).length} fixtures behave as stated; the shipped registry of ${CARD_KINDS.length} kind(s) passes.`);
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(REGISTRY)) {
    console.error("CARD-KIND SCAN FAILED — src/shared/work/cardKinds.ts does not exist. The registry is the thing this scan is about.");
    process.exit(1);
  }
  const { CARD_KINDS } = await loadTs(REGISTRY);
  const worker = readTree(WORKER_DIR);
  const shared = readTree(SHARED_DIR);
  const sources = { ...worker, ...shared };
  const blocksSrc = stripCommentsFor(BLOCKS, readFileSync(BLOCKS, "utf8"));

  const shape = checkRegistryShape(CARD_KINDS);
  const doors = checkHandDoorFollowsTheJobDoor(CARD_KINDS);
  // Sites are discovered in the worker; the symbols they resolve through may be declared in
  // shared/ (WEB_PROPERTY_CHANGE_KIND is), so resolution reads the whole tree.
  const writes = checkWriteSites(worker, CARD_KINDS, WRITE_SITES, sources);
  const compares = checkComparisons(sources, CARD_KINDS);
  const dead = checkNothingIsDead(sources, CARD_KINDS);
  const banned = checkJobKindsAreBannedFromBlockSentences(blocksSrc, CARD_KINDS);

  const empty = [
    shape.examined === 0 && "read ZERO kinds from src/shared/work/cardKinds.ts",
    Object.keys(worker).length === 0 && "read ZERO worker sources",
    writes.examined === 0 && "found ZERO places that write work_card.kind — a column nothing writes, or a stale parse",
    compares.examined === 0 && "found ZERO comparisons against card.kind — the sweep branches on this column, so zero means the parse is stale",
    banned.examined === 0 && "checked ZERO job-door kinds against the block-sentence guard",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`CARD-KIND SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...shape.violations, ...doors.violations, ...writes.violations, ...compares.violations, ...dead.violations, ...banned.violations];
  if (violations.length > 0) {
    console.error("CARD-KIND SCAN FAILED — the code and src/shared/work/cardKinds.ts disagree about what a card can be:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\n`kind` decides which runner the sweep hands a card to. Before the registry it was nine values written\n" +
        "from eight files and named nowhere, which is why nothing could answer the operator's question —\n" +
        "\"what can I start myself?\" — without a grep. One list, or it is not a registry.",
    );
    process.exit(1);
  }

  console.log(
    `CARD-KIND SCAN PASSED: ${shape.examined} kind(s) in src/shared/work/cardKinds.ts, each well formed and each ` +
      `startable-by-hand answer derived from its door; ${writes.examined} write site(s) all registered and writing ` +
      `only registered kinds; ${compares.examined} comparison(s) against card.kind all registered; no dead entry; ` +
      `${banned.examined} job-door kind(s) banned from a block sentence a partner reads.`,
  );
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  await main();
}
