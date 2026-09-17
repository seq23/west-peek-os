#!/usr/bin/env node
/**
 * an-instruction-reaches-a-model.mjs — `npm run validate:instructions`.
 *
 * ONE ASSERTION: NO PATH THAT ACCEPTS A HUMAN'S PROSE MAY WORK A CARD WITHOUT THAT PROSE REACHING
 * A REASONING MODEL FIRST.
 *
 * ─── What went wrong, and why a validator rather than a fix ────────────────────────────────────
 *
 * The operator, twice: "when I give a task, the agent should use an LLM that is highly intelligent
 * to interpret the ask", and "make sure everything I say reaches a thinking model."
 *
 * A work card can carry human prose in four columns — `prompt`, the request text, an unanswered
 * `work_card_note`, and `block_answer`. The general employee loop reads all four. The SPECIALISED
 * CHAINS, dispatched by `work_card.kind` in `services/workSweep.ts`, read none of them: Parker's
 * Room and Workshop packets, Walker's two Productions duties, a partner's blog help and Preston's
 * deck rework each read their own row and nothing else. She typed an instruction, pressed send, and
 * it went into a column nothing ever read.
 *
 * Fixing the six chains is a fix. What makes it a GUARANTEE is that the seventh chain cannot be
 * added without this check failing, because the seventh is the one nobody will remember.
 *
 * ─── What is checked ───────────────────────────────────────────────────────────────────────────
 *
 *   1 · EVERY DISPATCH BRANCH IS ACCOUNTED FOR. The `card.kind` branches in `sweepOnce` are read
 *       out of the source rather than listed here, so a new kind appears in this scan the moment
 *       it appears in the sweep. Each must name a runner module, and that module must call
 *       `steerFor` — or be the general loop, which carries the words into its own step prompt.
 *   2 · A CHAIN THAT CANNOT HONOUR HER WORDS STOPS. Every module that calls `steerFor` must act on
 *       `.cannot` — a steer read and not acted on is the defect wearing a model call.
 *   3 · THE INTERPRETATION IS A GOVERNED, CAPABLE CALL. `services/instruction.ts` must reach a
 *       model through `runAi` with `interpretation: true`, and must not pass `preferredModel` or
 *       pin a provider by hand, which would put the choice back where a config row can move it.
 *   4 · THE ROUTER HONOURS IT. `ai/runAi.ts` must, for an interpretation, filter candidates on
 *       `supports_reasoning` from the catalogue and exclude the search-grounded models — and must
 *       not let the cheapest-by-price branch decide. A pricing row is configuration; configuration
 *       may order the candidates and may not choose them. Migration 0158 is the precedent: one
 *       price of $1/$1 made a search model "cheapest adequate" for every unpinned call in the firm.
 *   5 · THE MODEL IT ELECTS EXISTS. At least one `provider_model` row in `migrations/` is
 *       `supports_reasoning = 1`, ACTIVE, and priced. A capability filter with nothing to match is
 *       the "runs but inert" shape, and that is exactly what a fresh database had.
 *   6 · THE RECEIPT IS REAL. The interpretation is recorded against the card with what she typed,
 *       and a route serves it — "tell me what my instructions turned into" is answerable from the
 *       product, not from an agent reading a database.
 *
 * Comments are stripped before scanning, so the paragraphs above and the ones in the services
 * cannot make the scan pass or fail.
 *
 * HARD-FAILS ON ZERO: zero sources, zero dispatch branches, or zero chains examined all exit 1.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside clean fixtures that must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_DIR = path.join(ROOT, "src", "worker");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const SWEEP = path.join("src", "worker", "services", "workSweep.ts");
const INTERPRETER = path.join("src", "worker", "services", "instruction.ts");
const RUNAI = path.join("src", "worker", "ai", "runAi.ts");

/**
 * The one branch that is allowed to have no `steerFor`: the general employee loop already puts
 * `work_card.prompt` and every unanswered note into the step prompt it builds, and acknowledges
 * them in writing before it may carry on. Named here rather than inferred, so exempting a second
 * chain is a visible edit to this file.
 */
const GENERAL_LOOP = "employeeWork.ts";

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// ── 1 · Every branch of the sweep's dispatch, and the module it runs ──────────────────────────

/**
 * Read the dispatch out of `sweepOnce` rather than listing the kinds here.
 *
 * A list in this file is a second place to maintain, and the whole defect class this repo keeps
 * finding is "two components each keeping their own list with no link". The kinds come from the
 * source; a kind added to the sweep is examined by this scan on the same commit.
 */
export function dispatchBranches(sweepSrc) {
  const src = stripComments(sweepSrc);
  const body = /export async function sweepOnce\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
  const branches = [];
  /*
   * ONLY THE DISPATCH ITSELF, not every mention of a kind in the function.
   *
   * `sweepOnce` tests `card.kind` in two places: the deck-wait guard near the top, which names four
   * kinds in one boolean expression, and the dispatch proper. A scan that walked every occurrence
   * matched the guard first, consumed past the real DECK_REWORK arm, and paired five branches out
   * of six — reporting success on five sixths of the job. The dispatch is the `try { ... }` that
   * assigns `finished`, so that is what is read.
   */
  const dispatch = /try\s*\{[\s\S]*?\n  \} catch/.exec(body)?.[0] ?? body;
  // Each arm, taken independently: the kind it tests, then the first module imported before the
  // next arm begins. An arm that imports nothing pairs with nothing and is caught by the count.
  const tests = [...dispatch.matchAll(/card\.kind === "([A-Z_]+)"|isProductionsKind\(card\.kind\)/g)];
  for (let i = 0; i < tests.length; i += 1) {
    const from = tests[i].index;
    const to = i + 1 < tests.length ? tests[i + 1].index : dispatch.length;
    const mod = /await import\("\.\/([A-Za-z]+)"\)/.exec(dispatch.slice(from, to));
    if (mod) branches.push({ kind: tests[i][1] ?? "PRODUCTIONS_*", module: `${mod[1]}.ts` });
  }
  // The final `else` — a card with no kind, or one nothing claims — runs the general loop.
  if (/runners\.general \?\? workCard/.test(body)) branches.push({ kind: "(no kind)", module: GENERAL_LOOP });
  return branches;
}

/**
 * How many kinds the dispatch actually tests, counted a DIFFERENT WAY from `dispatchBranches`.
 *
 * WHY BOTH. The first version of `dispatchBranches` had a broken quantifier and returned ONE branch
 * out of six. Every check passed, the summary line read "1 chain module(s) examined", and the scan
 * reported success having examined a sixth of what it exists to examine. `branches.length === 0`
 * did not catch it, because one is not zero. Rule 0 is not only about empty loops: a loop that
 * silently shrinks is the same defect arriving quietly. So the branches are counted twice, by two
 * expressions that would have to break in the same way to agree, and a disagreement is a failure.
 */
export function dispatchKindCount(sweepSrc) {
  const body = /export async function sweepOnce\([\s\S]*?\n}/.exec(stripComments(sweepSrc))?.[0] ?? "";
  const dispatch = /try\s*\{[\s\S]*?\n  \} catch/.exec(body)?.[0] ?? body;
  const named = new Set(Array.from(dispatch.matchAll(/card\.kind === "([A-Z_]+)"/g)).map((m) => m[1]));
  const productions = /isProductionsKind\(card\.kind\)/.test(dispatch) ? 1 : 0;
  const general = /runners\.general \?\? workCard/.test(body) ? 1 : 0;
  return named.size + productions + general;
}

export function checkChainsInterpret(sources, branches) {
  const violations = [];
  let examined = 0;
  for (const b of branches) {
    const file = Object.keys(sources).find((f) => f.endsWith(path.join("services", b.module)));
    if (!file) {
      violations.push(`the sweep dispatches "${b.kind}" to ${b.module}, which this scan cannot find`);
      continue;
    }
    examined += 1;
    const src = stripComments(sources[file]);
    if (b.module === GENERAL_LOOP) {
      // The general loop's own guarantee: her words go into the prompt it builds, every step.
      if (!/prompt:\s*card\.prompt/.test(src) || !/steering:\s*await unansweredNotes/.test(src)) {
        violations.push(`${b.module} is the general loop and must carry card.prompt AND the unanswered notes into every step prompt; it no longer does`);
      }
      continue;
    }
    if (!/\bsteerFor\s*\(/.test(src)) {
      violations.push(
        `the sweep dispatches "${b.kind}" to ${b.module}, and ${b.module} never calls steerFor — ` +
          `anything a partner types onto one of those cards reaches no model at all`,
      );
      continue;
    }
    // 2 · A steer that is read and not acted on is worse than none: it looks handled.
    if (!/steer\.cannot\.length\s*>\s*0/.test(src) || !/blockCard\(/.test(src)) {
      violations.push(
        `${b.module} calls steerFor but never blocks on steer.cannot — a step whose input includes ` +
          `prose it cannot honour must say so rather than doing the default`,
      );
    }
    if (!/steer\.text/.test(src)) {
      violations.push(`${b.module} calls steerFor but never uses steer.text, so the steer reaches none of its prompts`);
    }
  }
  return { violations, examined };
}

// ── 3 · The interpretation is a governed, capable call ────────────────────────────────────────

export function checkInterpreter(src) {
  const violations = [];
  const s = stripComments(src);
  if (!/\brunAi\s*\(/.test(s)) violations.push("services/instruction.ts does not call runAi, so no model reads anything");
  if (!/interpretation:\s*true/.test(s)) {
    violations.push("the interpretation call does not set budgetContext.interpretation, so the router treats it as ordinary work");
  }
  if (/preferredModel\s*:/.test(s)) {
    violations.push("the interpretation call names a preferredModel, which puts the choice back where a stale constant decides it");
  }
  if (/providerKey\s*:/.test(s)) {
    violations.push("the interpretation call pins a provider by hand rather than asking the catalogue what can reason");
  }
  // 6 · The receipt.
  if (!/INSERT INTO work_card_instruction/.test(s)) {
    violations.push("nothing records what she typed against what the model made of it, so the receipt cannot be shown");
  }
  if (!/said_json/.test(s)) violations.push("the receipt does not store her words, only the interpretation");
  return { violations };
}

// ── 4 · The router honours it ─────────────────────────────────────────────────────────────────

export function checkRouter(src) {
  const violations = [];
  const s = stripComments(src);
  if (!/budgetContext\?\.interpretation === true/.test(s)) {
    violations.push("runAi does not read budgetContext.interpretation, so setting it does nothing");
  }
  if (!/supports_reasoning\s*=\s*1/.test(s)) {
    violations.push(
      "runAi never asks the catalogue which models can reason, so an interpretation is chosen by price — " +
        "and a pricing row is configuration (migration 0158: one $1/$1 row elected a search model firm-wide)",
    );
  }
  if (!/isSearchGrounded/.test(s)) {
    violations.push("runAi does not exclude the search-grounded models, so an interpretation can be answered from a search index");
  }
  // The judgement path must imply from interpretation, or CHEAPO could still downgrade it.
  if (!/isJudgement\s*=\s*isInterpretation/.test(s)) {
    violations.push("interpretation does not imply judgement, so a cost posture can still downgrade the call that reads her instruction");
  }
  return { violations };
}

// ── 5 · The model it elects exists ────────────────────────────────────────────────────────────

/**
 * A capability filter with nothing to match is inert. Checked against the MIGRATIONS rather than a
 * live database because that is the only thing a build can read — and because the hole this found
 * was in the migrations: five routing policies pinned `anthropic/claude-sonnet-5` and nothing in
 * `migrations/` ever registered or priced it, so every pinned lane was unroutable on a fresh
 * database. Third occurrence of that shape in this repo (0147 fixed one lane of it).
 */
/** Split a SQL row list on top-level commas, respecting quotes and brackets. */
function splitRow(row) {
  const out = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (quoted) {
      cur += ch;
      if (ch === "'") quoted = row[i + 1] === "'";
      continue;
    }
    if (ch === "'") { quoted = true; cur += ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unquote = (v) => (v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v);

/**
 * Every `provider_model` row any migration writes, read BY COLUMN NAME rather than by position.
 *
 * Positional matching was tried and abandoned: the catalogue is written in three different column
 * orders across 0015, 0088 and 0175, and a regex that counts commas passes by luck on one of them.
 * The insert names its columns; this reads that list and maps the row onto it, so a row written in
 * any order is understood and a row written in a shape this cannot parse is reported rather than
 * skipped silently.
 */
export function providerModelRows(all) {
  const rows = [];
  for (const stmt of all.matchAll(/INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+provider_model\s*\(([\s\S]*?)\)\s*(VALUES|SELECT)([\s\S]*?);/gi)) {
    const cols = splitRow(stmt[1]).map((c) => c.trim().toLowerCase());
    const body = stmt[3];
    const tuples =
      stmt[2].toUpperCase() === "VALUES"
        ? Array.from(body.matchAll(/\(([\s\S]*?)\)(?=\s*(?:,\s*\(|;|$))/g)).map((m) => m[1])
        : [body.split(/\bWHERE\b|\bFROM\b/i)[0]];
    for (const t of tuples) {
      const vals = splitRow(t);
      if (vals.length !== cols.length) continue;
      rows.push(Object.fromEntries(cols.map((c, i) => [c, unquote(vals[i])])));
    }
  }
  return rows;
}

export function checkCatalogueHasAReasoner(migrations) {
  const violations = [];
  const all = Object.values(migrations).join("\n");
  const reasoners = providerModelRows(all)
    .filter((r) => r.supports_reasoning === "1" && r.status === "ACTIVE")
    .map((r) => r.model);
  if (reasoners.length === 0) {
    violations.push(
      "no migration registers an ACTIVE provider_model row with supports_reasoning = 1, so the capability " +
        "filter can never match anything and every interpretation degrades to the best of a weak field",
    );
    return { violations, reasoners };
  }
  for (const model of reasoners) {
    const priced = new RegExp(`provider_pricing_snapshot[\\s\\S]{0,600}?'${model.replace(/[/.\-]/g, "\\$&")}'`).test(all);
    if (!priced) {
      violations.push(`${model} is ACTIVE and can reason but has no pricing snapshot, so runAi can never route to it`);
    }
  }
  return { violations, reasoners };
}

// ── 6 · The receipt is reachable ──────────────────────────────────────────────────────────────

export function checkReceiptRoute(sources) {
  const violations = [];
  const router = Object.entries(sources).find(([f]) => f.endsWith(path.join("worker", "index.ts")));
  if (!router) return { violations: ["cannot find the worker's route table"] };
  /*
   * THE ROUTE, NOT THE IMPORT. This first read `/handleWorkCardInstructions/` over the whole file
   * and passed with the route deleted, because the import statement above it still matched — the
   * negative proof caught it. An imported handler nothing routes to is the "exists but nothing
   * invokes it" defect, which is the one this check exists to prevent, so it must be the `.get(...)`
   * line that is asserted.
   */
  if (!/\.get\(\s*"\/api\/work-cards\/:id\/instructions"\s*,\s*handleWorkCardInstructions\s*\)/.test(stripComments(router[1]))) {
    violations.push(
      "nothing serves the interpretation receipt, so 'tell me what my instructions turned into' is still " +
        "a question that needs an agent and a database",
    );
  }
  return { violations };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

/**
 * Each fixture is the REAL pre-fix shape, reduced to what the scan reads. `expect: null` means the
 * fixture must pass — a scan that fails everything proves nothing.
 */
const SELF_TEST = {
  "the real defect: a chain the sweep dispatches to that reads no instruction at all": {
    branches: [{ kind: "ROOM_PACKET", module: "roomPacket.ts" }],
    sources: {
      "src/worker/services/roomPacket.ts":
        "export async function runRoomPacketCard(env, card) { const packet = await load(card.id); return runStage(env, packet); }",
    },
    expect: /never calls steerFor/,
  },
  "a chain that interprets and then ignores what it cannot do": {
    branches: [{ kind: "BLOG_HELP", module: "blogHelp.ts" }],
    sources: {
      "src/worker/services/blogHelp.ts":
        "export async function runBlogHelpCard(env, card) { const steer = await steerFor(env, a, r); return write(steer.text); }",
    },
    expect: /never blocks on steer\.cannot/,
  },
  "a chain that interprets, blocks correctly, and then never uses the steer": {
    branches: [{ kind: "DECK_REWORK", module: "deck.ts" }],
    sources: {
      "src/worker/services/deck.ts":
        "export async function runDeckRework(env, card) { const steer = await steerFor(env, a, r); if (steer.cannot.length > 0) { await blockCard(env, card, {}); return; } return rebuild(env); }",
    },
    expect: /never uses steer\.text/,
  },
  "the general loop, which is allowed no steerFor and must still carry her words": {
    branches: [{ kind: "(no kind)", module: GENERAL_LOOP }],
    sources: {
      [`src/worker/services/${GENERAL_LOOP}`]:
        "const loopCtx = { prompt: card.prompt, steering: await unansweredNotes(env, card.id) };",
    },
    expect: null,
  },
  "the general loop with the steering notes taken out of it": {
    branches: [{ kind: "(no kind)", module: GENERAL_LOOP }],
    sources: { [`src/worker/services/${GENERAL_LOOP}`]: "const loopCtx = { prompt: card.prompt };" },
    expect: /must carry card\.prompt AND the unanswered notes/,
  },
  "a compliant chain": {
    branches: [{ kind: "ROOM_PACKET", module: "roomPacket.ts" }],
    sources: {
      "src/worker/services/roomPacket.ts":
        "export async function run(env, card) { const steer = await steerFor(env, a, r); if (steer.cannot.length > 0) { await blockCard(env, card, {}); return; } return runStage(env, p, { steer: steer.text }); }",
    },
    expect: null,
  },
  "the interpretation call left on the ordinary routing path": {
    interpreter: "const { run } = await runAi(env, { purpose: 'x', budgetContext: { judgement: true } }); INSERT INTO work_card_instruction said_json",
    expect: /does not set budgetContext\.interpretation/,
  },
  "the interpretation call naming a model by hand": {
    interpreter:
      "const { run } = await runAi(env, { budgetContext: { interpretation: true, preferredModel: 'anthropic/claude-sonnet-5' } }); INSERT INTO work_card_instruction said_json",
    expect: /names a preferredModel/,
  },
  "an interpretation with no receipt behind it": {
    interpreter: "const { run } = await runAi(env, { budgetContext: { interpretation: true } });",
    expect: /nothing records what she typed/,
  },
  "the router ignoring the flag entirely": {
    router: "const isJudgement = input.budgetContext?.judgement === true; isSearchGrounded(c.model); supports_reasoning = 1",
    expect: /does not read budgetContext\.interpretation/,
  },
  "the real defect shape: the router choosing an interpretation by price alone": {
    router:
      "const isInterpretation = input.budgetContext?.interpretation === true; const isJudgement = isInterpretation || x; isSearchGrounded(c.model); const cheapest = candidates.reduce(min);",
    expect: /never asks the catalogue which models can reason/,
  },
  "a compliant router": {
    router:
      "const isInterpretation = input.budgetContext?.interpretation === true; const isJudgement = isInterpretation || input.budgetContext?.judgement === true; isSearchGrounded(c.model); 'SELECT provider_id, model FROM provider_model WHERE supports_reasoning = 1'",
    expect: null,
  },
  "the real defect shape: a pinned model nothing ever registered": {
    migrations: {
      "0088.sql": `INSERT INTO routing_policy VALUES ('rpol_x','university',1,'[{"provider_key":"openrouter","model":"anthropic/claude-sonnet-5"}]');`,
    },
    expect: /no migration registers an ACTIVE provider_model row with supports_reasoning = 1/,
  },
  "a reasoning model registered but never priced": {
    migrations: {
      "0175.sql":
        "INSERT INTO provider_model (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens, supports_tools, supports_reasoning, max_data_class, pricing_state, pricing_source_note, status, registered_by, firm_scope) SELECT 'pm_x', 'prov_openrouter', 'anthropic/claude-sonnet-5', 'Claude Sonnet 5', '[\"text-completion\"]', 200000, 8192, 1, 1, 'INTERNAL', 'ILLUSTRATIVE', 'note', 'ACTIVE', 'migration:0175', 'west-peek';",
    },
    expect: /has no pricing snapshot/,
  },
  "the receipt handler imported but never routed to — the real shape this scan first missed": {
    routeSources: {
      "src/worker/index.ts":
        'import { handleWorkCardInstructions } from "./services/instruction";\n.get("/api/work-cards/:id", handleGetWorkCard)',
    },
    expect: /nothing serves the interpretation receipt/,
  },
  "the receipt properly routed": {
    routeSources: {
      "src/worker/index.ts": '.get("/api/work-cards/:id/instructions", handleWorkCardInstructions)',
    },
    expect: null,
  },
  "the receipt with nothing serving it": {
    routeSources: { "src/worker/index.ts": '.get("/api/work-cards/:id", handleGetWorkCard)' },
    expect: /nothing serves the interpretation receipt/,
  },
};

function selfTest() {
  let failed = 0;
  for (const [name, c] of Object.entries(SELF_TEST)) {
    const found = [
      ...(c.sources ? checkChainsInterpret(c.sources, c.branches).violations : []),
      ...(c.interpreter ? checkInterpreter(c.interpreter).violations : []),
      ...(c.router ? checkRouter(c.router).violations : []),
      ...(c.migrations ? checkCatalogueHasAReasoner(c.migrations).violations : []),
      ...(c.routeSources ? checkReceiptRoute(c.routeSources).violations : []),
    ];
    const caught = c.expect === null ? found.length === 0 : found.some((v) => c.expect.test(v));
    if (!caught) {
      console.error(`SELF-TEST FAILED — "${name}": expected ${c.expect ?? "no violation"}, got ${JSON.stringify(found)}`);
      failed += 1;
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`SELF-TEST PASSED: ${Object.keys(SELF_TEST).length} fixtures behave as stated, including the real pre-fix shapes.`);
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const sources = readTree(WORKER_DIR);
  const migrations = Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => [f, readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")]),
  );

  if (Object.keys(sources).length === 0) {
    console.error(`INSTRUCTION SCAN FAILED — examined 0 worker sources under ${path.relative(ROOT, WORKER_DIR)}.`);
    process.exit(1);
  }
  if (Object.keys(migrations).length === 0) {
    console.error(`INSTRUCTION SCAN FAILED — examined 0 migrations under ${path.relative(ROOT, MIGRATIONS_DIR)}.`);
    process.exit(1);
  }
  for (const required of [SWEEP, INTERPRETER, RUNAI]) {
    if (!sources[required]) {
      console.error(`INSTRUCTION SCAN FAILED — ${required} is not there to read.`);
      process.exit(1);
    }
  }

  const branches = dispatchBranches(sources[SWEEP]);
  const expected = dispatchKindCount(sources[SWEEP]);
  // THE EMPTY-LOOP GUARD. Work is dispatched by kind; a scan that finds no branches is reading the
  // wrong function, not proving that every branch interprets.
  if (branches.length === 0 || expected === 0) {
    console.error("INSTRUCTION SCAN FAILED — found 0 dispatch branches in sweepOnce.");
    console.error("Cards are worked by kind. Zero means this scan cannot see the dispatch it exists to check.");
    process.exit(1);
  }
  // THE SHRINKING-LOOP GUARD, which is the one that actually fired: see dispatchKindCount.
  if (branches.length !== expected) {
    console.error(`INSTRUCTION SCAN FAILED — the sweep tests ${expected} kind(s) and this scan paired only ${branches.length} with a module.`);
    console.error(`Paired: ${branches.map((b) => `${b.kind}→${b.module}`).join(", ") || "none"}.`);
    console.error("A scan that examines a subset and reports success is worse than one that fails.");
    process.exit(1);
  }

  const chains = checkChainsInterpret(sources, branches);
  if (chains.examined !== branches.length) {
    console.error(`INSTRUCTION SCAN FAILED — examined ${chains.examined} chain module(s) for ${branches.length} branch(es).`);
    process.exit(1);
  }

  const interpreter = checkInterpreter(sources[INTERPRETER]);
  const router = checkRouter(sources[RUNAI]);
  const catalogue = checkCatalogueHasAReasoner(migrations);
  const receipt = checkReceiptRoute(sources);

  const violations = [
    ...chains.violations,
    ...interpreter.violations,
    ...router.violations,
    ...catalogue.violations,
    ...receipt.violations,
  ];
  if (violations.length > 0) {
    console.error("INSTRUCTION SCAN FAILED — a partner can type something that reaches no model:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nEvery path that accepts human prose passes it to a reasoning model before the work runs.");
    console.error("services/instruction.ts is the one place that happens; a chain that cannot honour what she");
    console.error("asked for blocks the card and says which part. See migration 0175.");
    process.exit(1);
  }

  console.log(
    `INSTRUCTION SCAN PASSED: ${branches.length} dispatch branch(es) in the sweep, ${chains.examined} chain ` +
      `module(s) examined, every one reaching a model with what a partner typed and stopping on what it ` +
      `cannot do; the interpretation is a governed call the catalogue's reasoning models answer ` +
      `(${catalogue.reasoners.join(", ")}), not a price comparison; the receipt is recorded and served.`,
  );
}
