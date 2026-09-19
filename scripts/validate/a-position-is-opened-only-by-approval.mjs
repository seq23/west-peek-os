#!/usr/bin/env node
/**
 * a-position-is-opened-only-by-approval.mjs — `npm run validate:booking`.
 *
 * ONE ASSERTION: NOTHING REACHES `position` EXCEPT THROUGH `executeTransaction`, AND A PARTNER'S
 * APPROVAL OF THE BOOKING CARD IS WIRED TO IT.
 *
 * WHAT THIS GUARDS, 18 Sep 2026 (Phase D: portfolio, design §6, decision Q1). The owner asked for an
 * easy, intuitive way to book a company as a real Fund I position. The easy way that is WRONG is a
 * route that writes `position` when the partner presses Save — one click, no card, no receipt. The
 * design's way keeps the ladder and removes the rung after the decision: Save composes the existing
 * draft-and-card path and stops; approving the card calls `executeTransaction`, the one function
 * that has ever opened a position, with the card as its receipt. This scan keeps both halves true,
 * because the second is the kind of thing that "exists but nothing invokes it" (Rule 0) and the
 * first is the kind of thing a later convenience quietly adds.
 *
 * WHAT IS CHECKED, over code with comments stripped (a sentence must never satisfy a scan):
 *   1 · ONE WRITER. Under `src/worker`, `INSERT INTO position` and `UPDATE position SET` appear only
 *       in `services/investment.ts`, and only inside `applyPositionEffect` / `reversePositionEffect`.
 *       (`position_mark`, `position_reserve` and friends are other tables and are not matched.)
 *   2 · ONE CALLER. `applyPositionEffect(` is called from `executeTransaction` and nowhere else.
 *   3 · THE COMPOSITE ROUTE STOPS AT THE CARD. `services/portfolioBooking.ts` calls
 *       `createTransaction(` and `submitTransactionForApproval(`, and never `executeTransaction(`,
 *       `applyPositionEffect(`, nor any SQL on `position`.
 *   4 · APPROVAL EXECUTES. `services/approvals.ts` `decideApproval` calls `bookOnApproval(` on an
 *       approved transaction card; `bookOnApproval` in investment.ts calls `executeTransaction(`
 *       with the card's id as the receipt; the standing-authority path in
 *       `submitTransactionForApproval` calls it too.
 *   5 · THE DOOR IS ROUTED, ONCE, IN ITS BLOCK. `index.ts` carries a contiguous
 *       `// === Phase D: portfolio ===` block holding `/api/holdings/:company_id/book`, `/sell` and
 *       `/api/positions/:id/reserve`, and none is routed outside it.
 *   6 · THE RECEIPT RUNG IS GONE FROM THE PAGE. `RecordInvestment.tsx` no longer posts to
 *       `/execute` — approval is the last human act, and a page that still offers the paste box is
 *       describing a ladder that no longer exists.
 *   7 · THE TEST IS REAL. `tests/portfolioBooking.test.ts` exists, asserts a position count of
 *       exactly one after approval (`toHaveLength(1)`), asserts the replay is refused (`409`), and
 *       excuses nothing (`.skip`, `.only`, `.todo`).
 *   8 · HARD-FAILS ON ZERO. A missing anchor file, an empty route block, or a scan that examined no
 *       worker file exits 1 rather than reporting a clean board.
 *
 * `--self-test` mutates the REAL shipped sources into each failure this exists to catch and requires
 * every one to be caught, alongside the shipped versions, which must pass. That is the negative proof.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const FILES = {
  investment: "src/worker/services/investment.ts",
  approvals: "src/worker/services/approvals.ts",
  booking: "src/worker/services/portfolioBooking.ts",
  index: "src/worker/index.ts",
  page: "src/client/pages/RecordInvestment.tsx",
  test: "tests/portfolioBooking.test.ts",
};

const ROUTES = ["/api/holdings/:company_id/book", "/api/holdings/:company_id/sell", "/api/positions/:id/reserve"];

function read(rel) {
  return stripTsComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

function walk(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push({ rel, text: read(rel) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** SQL that writes the `position` table itself — not position_mark, position_reserve, etc. */
const POSITION_WRITE = /\b(INSERT\s+INTO|UPDATE)\s+position\b(?!_)/gi;

/** The body of a top-level `async function name(` … up to its closing `\n}` at column 0. */
function fnBody(text, name) {
  const m = text.match(new RegExp(`(?:export )?async function ${name}\\s*\\([\\s\\S]*?\\n}\\n`));
  return m ? m[0] : null;
}

/** Rule 1 + 2 — one writer, one caller. */
export function checkOneWriter(workerFiles) {
  const bad = [];
  let writes = 0;
  for (const f of workerFiles) {
    const hits = [...f.text.matchAll(POSITION_WRITE)];
    if (hits.length === 0) continue;
    writes += hits.length;
    if (f.rel !== FILES.investment) {
      bad.push(`${f.rel} writes the position table (${hits.length}×) — only investment.ts's execute path may`);
      continue;
    }
    const apply = fnBody(f.text, "applyPositionEffect");
    const reverse = fnBody(f.text, "reversePositionEffect");
    const allowed = (apply ?? "") + (reverse ?? "");
    const inside = [...allowed.matchAll(POSITION_WRITE)].length;
    if (!apply) bad.push("investment.ts no longer defines applyPositionEffect — the one writer is gone");
    if (inside !== hits.length) {
      bad.push(`investment.ts writes position ${hits.length}× but only ${inside}× inside applyPositionEffect/reversePositionEffect`);
    }
  }
  if (writes === 0) bad.push("no worker file writes the position table at all — the ledger has no writer (Rule 0)");

  const inv = workerFiles.find((f) => f.rel === FILES.investment);
  if (inv) {
    const callers = [...inv.text.matchAll(/applyPositionEffect\s*\(/g)].length;
    const execute = fnBody(inv.text, "executeTransaction");
    const insideExecute = execute ? [...execute.matchAll(/applyPositionEffect\s*\(/g)].length : 0;
    // One definition plus one call, and that call is inside executeTransaction.
    if (!execute) bad.push("investment.ts no longer defines executeTransaction");
    if (callers - 1 !== insideExecute || insideExecute !== 1) {
      bad.push(`applyPositionEffect( is called ${callers - 1}× outside its definition, ${insideExecute}× inside executeTransaction — must be exactly one call, from execute`);
    }
  }
  for (const f of workerFiles) {
    if (f.rel === FILES.investment) continue;
    if (/applyPositionEffect\s*\(/.test(f.text)) bad.push(`${f.rel} calls applyPositionEffect( — the position effect belongs to execute alone`);
  }
  return bad;
}

/** Rule 3 — the composite route stops at the card. */
export function checkCompositeStops(booking) {
  const bad = [];
  if (!/createTransaction\s*\(/.test(booking)) bad.push("portfolioBooking.ts does not call createTransaction( — it is not walking the existing draft path");
  if (!/submitTransactionForApproval\s*\(/.test(booking)) bad.push("portfolioBooking.ts does not call submitTransactionForApproval( — no card is raised");
  if (/executeTransaction\s*\(/.test(booking)) bad.push("portfolioBooking.ts calls executeTransaction( — Save must stop at the card; approval executes");
  if (/applyPositionEffect\s*\(/.test(booking)) bad.push("portfolioBooking.ts calls applyPositionEffect( — a position opened by Save is the defect this scan exists for");
  if (POSITION_WRITE.test(booking)) bad.push("portfolioBooking.ts writes the position table directly");
  POSITION_WRITE.lastIndex = 0;
  return bad;
}

/** Rule 4 — approval executes, in both approval paths, through the receipt. */
export function checkApprovalExecutes(approvals, investment) {
  const bad = [];
  const decide = fnBody(approvals, "decideApproval");
  if (!decide) bad.push("approvals.ts no longer defines decideApproval");
  else if (!/bookOnApproval\s*\(/.test(decide)) bad.push("decideApproval does not call bookOnApproval( — approving a booking card would book nothing (Rule 0)");

  const hook = fnBody(investment, "bookOnApproval");
  if (!hook) bad.push("investment.ts no longer defines bookOnApproval");
  else {
    if (!/executeTransaction\s*\(\s*env,\s*actor,\s*txn\.id,\s*card\.id/.test(hook)) {
      bad.push("bookOnApproval does not call executeTransaction( with the card as the receipt — it must book through the one path, receipt-verified");
    }
    if (!/txn\.fund_id/.test(hook)) bad.push("bookOnApproval does not read the draft's fund — it would book to a fund nobody named");
  }
  const submit = fnBody(investment, "submitTransactionForApproval");
  if (!submit) bad.push("investment.ts no longer defines submitTransactionForApproval");
  else if (!/bookOnApproval\s*\(/.test(submit)) bad.push("the standing-authority path in submitTransactionForApproval does not call bookOnApproval( — a card approved in advance would sit approved and unbooked");
  return bad;
}

/**
 * Rule 5 — the routes live in the `// === Phase D: portfolio ===` block, once.
 *
 * `indexRaw` is index.ts UNSTRIPPED, and the one reader of this file that is: the block markers
 * `// === Phase D: portfolio ===` / `// === end Phase D ===` ARE comments, by the coordinator's
 * convention for this branch, so they have to be found in the raw text. DELIBERATELY DOES NOT STRIP
 * COMMENTS for that one lookup. Every route check below runs over the stripped text, so a sentence
 * naming a route can neither satisfy nor block the scan.
 */
export function checkRouteBlock(indexRaw) {
  const bad = [];
  const start = indexRaw.indexOf("// === Phase D: portfolio ===");
  if (start < 0) {
    bad.push("index.ts has no `// === Phase D: portfolio ===` block");
    return { bad, routes: 0 };
  }
  const rest = indexRaw.slice(start);
  const endMarker = rest.indexOf("// === end Phase D ===");
  const block = stripTsComments(endMarker < 0 ? rest : rest.slice(0, endMarker));
  const outside = stripTsComments(indexRaw.slice(0, start) + (endMarker < 0 ? "" : rest.slice(endMarker)));
  let routes = 0;
  for (const r of ROUTES) {
    if (!block.includes(`"${r}"`)) bad.push(`${r} is not routed inside the Phase D block`);
    else routes += 1;
    if (outside.includes(`"${r}"`)) bad.push(`${r} is routed somewhere outside the Phase D block as well`);
  }
  if (!/handleBookHolding/.test(block)) bad.push("the Phase D block does not route handleBookHolding");
  return { bad, routes };
}

/** Rule 6 — the receipt-paste rung is gone from the page. */
export function checkPage(page) {
  const bad = [];
  if (/\/execute`/.test(page) || /\/execute"/.test(page)) bad.push("RecordInvestment.tsx still posts to /execute — the receipt-paste rung is meant to be gone; approval executes");
  if (/txn-execute-/.test(page)) bad.push("RecordInvestment.tsx still renders the `txn-execute-` button — the rung after the decision");
  return bad;
}

/** Rule 7 — the test is real. */
export function checkTest(test) {
  const bad = [];
  if (!/toHaveLength\(1\)/.test(test)) bad.push("portfolioBooking.test.ts never asserts exactly one position after approval");
  if (!/toBe\(409\)/.test(test)) bad.push("portfolioBooking.test.ts never asserts the replay is refused (409)");
  if (!/\/decide`/.test(test)) bad.push("portfolioBooking.test.ts never decides a card — approval is what it exists to prove");
  if (/\.(skip|only|todo)\(/.test(test)) bad.push("portfolioBooking.test.ts excuses something (.skip/.only/.todo)");
  return bad;
}

export function runAll(sources) {
  const problems = [];
  problems.push(...checkOneWriter(sources.workerFiles));
  problems.push(...checkCompositeStops(sources.booking));
  problems.push(...checkApprovalExecutes(sources.approvals, sources.investment));
  const routed = checkRouteBlock(sources.indexRaw);
  problems.push(...routed.bad);
  problems.push(...checkPage(sources.page));
  problems.push(...checkTest(sources.test));
  return { problems, routes: routed.routes, files: sources.workerFiles.length };
}

function loadSources() {
  for (const rel of Object.values(FILES)) {
    if (!existsSync(path.join(ROOT, rel))) {
      console.error(`BOOKING SCAN FAILED — ${rel} is missing. A guard over a file that does not exist guards nothing.`);
      process.exit(1);
    }
  }
  const workerFiles = walk("src/worker");
  return {
    workerFiles,
    investment: read(FILES.investment),
    approvals: read(FILES.approvals),
    booking: read(FILES.booking),
    indexRaw: readFileSync(path.join(ROOT, FILES.index), "utf8"),
    page: read(FILES.page),
    test: read(FILES.test),
  };
}

function selfTest() {
  const shipped = loadSources();
  const clean = runAll(shipped);
  if (clean.problems.length > 0) {
    console.error("SELF-TEST FAILED: the shipped sources do not pass:\n  " + clean.problems.join("\n  "));
    process.exit(1);
  }
  const mutate = (label, fn) => {
    const s = { ...shipped, workerFiles: shipped.workerFiles.map((f) => ({ ...f })) };
    fn(s);
    return [label, s];
  };
  const swapWorker = (s, rel, fn) => {
    const f = s.workerFiles.find((x) => x.rel === rel);
    f.text = fn(f.text);
    if (rel === FILES.investment) s.investment = f.text;
    if (rel === FILES.approvals) s.approvals = f.text;
    if (rel === FILES.booking) s.booking = f.text;
  };
  const cases = [
    mutate("Save writes position directly (the one-click defect)", (s) =>
      swapWorker(s, FILES.booking, (t) => t + "\nasync function shortcut(env) { await env.WP_OS_DB.prepare(\"INSERT INTO position (id) VALUES ('x')\").run(); }\n"),
    ),
    mutate("Save calls executeTransaction itself, skipping the partner", (s) =>
      swapWorker(s, FILES.booking, (t) => t.replace("submitTransactionForApproval(env, actor, transaction.id)", "executeTransaction(env, actor, transaction.id, undefined, input.fund_id)")),
    ),
    mutate("a second worker file opens positions", (s) => {
      s.workerFiles.push({ rel: "src/worker/services/fake.ts", text: "export async function f(env) { await env.WP_OS_DB.prepare('UPDATE position SET quantity = 1').run(); }" });
    }),
    mutate("applyPositionEffect called from somewhere other than execute", (s) =>
      swapWorker(s, FILES.investment, (t) => t + "\nexport async function sneak(env, actor, txn) { return applyPositionEffect(env, actor, txn, 'f'); }\n"),
    ),
    mutate("decideApproval no longer books (exists but nothing invokes it)", (s) =>
      swapWorker(s, FILES.approvals, (t) => t.replace(/bookOnApproval\s*\(/g, "notBooking(")),
    ),
    mutate("bookOnApproval executes without the card as receipt", (s) =>
      swapWorker(s, FILES.investment, (t) => t.replace("executeTransaction(env, actor, txn.id, card.id, txn.fund_id)", "executeTransaction(env, actor, txn.id, undefined, txn.fund_id)")),
    ),
    mutate("the standing-authority path forgets to book", (s) =>
      swapWorker(s, FILES.investment, (t) => t.replace('if (card.state === "approved") await bookOnApproval(env, actor, card);', "")),
    ),
    mutate("the book route leaves its block", (s) => {
      s.indexRaw = s.indexRaw.replace('  .post("/api/holdings/:company_id/book", handleBookHolding)\n', "").replace("// === Phase Portfolio ===", '.post("/api/holdings/:company_id/book", handleBookHolding)\n  // === Phase Portfolio ===');
    }),
    mutate("the block marker disappears", (s) => {
      s.indexRaw = s.indexRaw.replace("// === Phase D: portfolio ===", "// routes");
    }),
    mutate("the page grows the receipt-paste rung back", (s) => {
      s.page += '\nasync function execute(id) { await api(`/api/transactions/${id}/execute`, { method: "POST", body: { approval_receipt_id: receipt } }); }\n';
    }),
    mutate("the test stops asserting exactly one position", (s) => {
      s.test = s.test.replace(/toHaveLength\(1\)/g, "toBeTruthy()");
    }),
    mutate("the test excuses a case", (s) => {
      s.test = s.test.replace("it(\"APPROVAL BOOKS IT", "it.skip(\"APPROVAL BOOKS IT");
    }),
    mutate("no worker file writes position at all (a scan over nothing)", (s) => {
      for (const f of s.workerFiles) f.text = f.text.replace(POSITION_WRITE, "INSERT INTO nowhere");
      s.investment = s.workerFiles.find((f) => f.rel === FILES.investment).text;
    }),
  ];
  let caught = 0;
  const missed = [];
  for (const [label, s] of cases) {
    if (runAll(s).problems.length > 0) caught += 1;
    else missed.push(label);
  }
  if (missed.length > 0) {
    console.error("SELF-TEST FAILED: these broken states were NOT caught:\n  " + missed.join("\n  "));
    process.exit(1);
  }
  console.log(`a-position-is-opened-only-by-approval: self-test passed (shipped clean, ${caught}/${cases.length} broken states caught).`);
}

const args = new Set(process.argv.slice(2));
if (args.has("--self-test")) {
  selfTest();
} else {
  const sources = loadSources();
  if (sources.workerFiles.length === 0) {
    console.error("BOOKING SCAN FAILED — examined 0 worker files. A scan that checks nothing is not a passing scan.");
    process.exit(1);
  }
  const { problems, routes, files } = runAll(sources);
  if (problems.length > 0) {
    console.error("BOOKING SCAN FAILED — a position may be opened somewhere other than a partner's approval:\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nThe ladder is: Save → draft + card; approve → executeTransaction (receipt-verified) → position.");
    console.error("Nothing else writes position, and approval must be wired to execute (design §6, Q1).");
    process.exit(1);
  }
  console.log(
    `a-position-is-opened-only-by-approval: ${files} worker files examined · one writer (applyPositionEffect), one caller (executeTransaction) · ` +
      `Save stops at the card · approval books through the receipt in both paths · ${routes} routes in the Phase D block · no receipt rung on the page · test guarded.`,
  );
}
