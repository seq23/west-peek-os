#!/usr/bin/env node
/**
 * the-record-scales.mjs — `npm run validate:record-scales`.
 *
 * ONE ASSERTION: THE WORK PAGE STAYS USABLE ON DAY 200 — FINISHED WORK IS RETRIEVED FROM THE
 * SERVER, NOT SLICED IN THE BROWSER, AND NOTHING THE FIRM HAS FINISHED CAN PUSH SOMETHING THAT IS
 * WAITING ON HER OFF THE BOARD.
 *
 * WHAT WENT WRONG, and it was measured rather than suspected. On 18 Sep 2026 the live Work page was
 * loaded against a database holding a realistic 200 days of output — 531 finished cards:
 *
 *   · `/api/work-cards/by-owner` returned EVERY card under `LIMIT 500`, ordered by age
 *   · the page then rendered `finished.slice(0, 50)` of them
 *   · so 481 finished cards were unreachable from the page, silently, with nothing on screen
 *     admitting it. The page printed "Finished 496" over fifty rows.
 *   · and because the cap is ordered by age, on the day the firm passes 500 finished cards an OPEN
 *     card nobody has picked up since March falls off the BOARD — the one row the page exists for
 *
 * None of that failed anything. The build was green, every class was defined, every heading rule
 * reached a heading. The defect only exists at volume, which is exactly the kind this repo keeps
 * shipping: correct on day 1, wrong on day 200, invisible in between.
 *
 * WHAT IS CHECKED
 *   1 · THE BOARD CARRIES LIVE WORK ONLY. `handleWorkByOwner` constrains state to OPEN /
 *       IN_PROGRESS / BLOCKED. A board that also carries the record can be truncated by the record.
 *   2 · THE PAGE DOES NOT SLICE A LIST OF FINISHED WORK. No `.slice(0, n)` over anything named for
 *       finished/done/record in the Work client. Truncating in the browser is the failure above,
 *       and it is worse behind a search box, because an empty result then looks like an answer.
 *   3 · THE COLLAPSE KEY IS THE DECLARED ONE. `RECORD_GROUP_COLUMNS` in `@shared/work/record` is
 *       the specification of "the same thing, run again"; the GROUP BY in the record query must
 *       name exactly those expressions. A specification no code reads is a wish.
 *   4 · THE RECORD QUERY KEEPS ITS ONE BARE AGGREGATE. It relies on SQLite's documented guarantee
 *       that with exactly one bare MAX()/MIN(), the other bare columns come from the row that
 *       produced it — which is what makes "Reopen" act on the most recent attempt. A second bare
 *       aggregate silently voids that.
 *   5 · EVERY CONTROL REACHES THE SERVER. Each filter the record view offers — search, who, month,
 *       state — must be put on the request, and the view must page rather than stop at one screen.
 *       A control that narrows a list the browser already holds is the day-1 design again.
 *   6 · THE ROUTE EXISTS AND IS REGISTERED.
 *
 * HARD-FAILS ON ZERO. No record query, no group columns, no client file, or a scan that read no
 * files at all, each exit 1. A validator that passes an empty loop is the defect this repo calls
 * Rule 0, and it has produced it more than once.
 *
 * `--self-test` plants each failure — including the exact pre-fix shapes, `LIMIT 500` with no state
 * constraint and `finished.slice(0, 50)` — and requires every one to be caught.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVICE = path.join(ROOT, "src", "worker", "services", "workCards.ts");
const ROUTER = path.join(ROOT, "src", "worker", "index.ts");
const RECORD_VIEW = path.join(ROOT, "src", "client", "pages", "WorkRecordView.tsx");
const WORK_PAGE = path.join(ROOT, "src", "client", "pages", "WorkCardsPage.tsx");
const SHARED = path.join(ROOT, "src", "shared", "work", "record.ts");

const LIVE_STATES = ["OPEN", "IN_PROGRESS", "BLOCKED"];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** SQL line comments inside a template literal are not JS comments; strip them separately. */
function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ");
}

/**
 * The body of one SQL template literal, found by the marker it must contain.
 *
 * Matched on `prepare(` … backtick … backtick rather than on line numbers, so moving the function
 * does not silently stop this scan from finding anything — which would turn it into a pass.
 */
export function sqlContaining(src, marker) {
  for (const m of stripComments(src).matchAll(/prepare\(\s*`([\s\S]*?)`/g)) {
    if (m[1].includes(marker)) return stripSqlComments(m[1]);
  }
  return null;
}

// ── 1 · The board carries live work only ──────────────────────────────────────────────────────

export function checkBoardIsLiveOnly(serviceSrc) {
  const violations = [];
  /*
   * MARKER SHARPENED 22 Sep 2026 (Wave A). "COALESCE(e.name, u.full_name) AS owner_name" used to
   * name only the board query in `handleWorkByOwner` — it now also appears in `handleGetWorkCard`'s
   * own single-row owner lookup (added so the card detail page can show "Working it: <employee>"
   * without a second endpoint). `sqlContaining` returns the FIRST match in the file, and
   * `handleGetWorkCard` sits above `handleWorkByOwner`, so the ambiguous marker silently started
   * scanning the wrong query — a one-row lookup with no `state` clause at all, which is a false
   * positive of exactly the shape this validator exists to catch, not a real defect. The board
   * query alone selects `wc.next_action, wc.due_at, wc.capture_id` together; the single-row lookup
   * selects neither.
   */
  const sql = sqlContaining(serviceSrc, "wc.next_action, wc.due_at, wc.capture_id");
  if (!sql) {
    return {
      examined: 0,
      violations: ["could not find the board query in workCards.ts — this scan has stopped reading the file it audits"],
    };
  }
  const missing = LIVE_STATES.filter((s) => !new RegExp(`'${s}'`).test(sql));
  if (missing.length > 0 || !/wc\.state\s+IN\s*\(/i.test(sql)) {
    violations.push(
      "the board query does not constrain wc.state to the live states — it therefore also carries the " +
        "record, and any cap on it can drop a waiting card in favour of a finished one " +
        `(missing: ${missing.join(", ") || "the IN clause itself"})`,
    );
  }
  if (/\bDONE\b/.test(sql) || /\bCANCELLED\b/.test(sql)) {
    violations.push("the board query still names DONE or CANCELLED — finished work belongs to the record route");
  }
  return { examined: 1, violations };
}

// ── 2 · Nothing slices a list of finished work in the browser ─────────────────────────────────

/** `finished.slice(0, 50)`, `record.slice(0, 40)`, `done.slice(0,100)` — the shape of the bug. */
const CLIENT_SLICE = /\b(\w*(?:finished|record|done|history|archive)\w*)\s*(?:!|\?)?\s*\.slice\(\s*0\s*,\s*\d+\s*\)/gi;

export function checkNoClientTruncation(files) {
  const violations = [];
  let examined = 0;
  for (const [name, raw] of Object.entries(files)) {
    examined += 1;
    const src = stripComments(raw);
    for (const m of src.matchAll(CLIENT_SLICE)) {
      violations.push(
        `${name} truncates finished work in the browser: \`${m[0]}\`. On 18 Sep that hid 481 of 531 ` +
          "finished cards with nothing on screen saying so. Ask the server for a page of the record.",
      );
    }
  }
  return { examined, violations };
}

// ── 3 · The collapse key is the declared one ──────────────────────────────────────────────────

export function checkGroupByMatchesSpec(serviceSrc, columns, sqlFor) {
  const sql = sqlContaining(serviceSrc, "GROUP BY");
  if (!sql) return { examined: 0, violations: ["no GROUP BY query found — the record's collapse has gone"] };
  const violations = [];
  // The query builds its GROUP BY from the shared array, which is the point: what is checked here
  // is that it still does, rather than having been inlined and then drifted.
  if (!/GROUP BY \$\{groupBy\}/.test(sql)) {
    violations.push(
      "the record query no longer builds its GROUP BY from RECORD_GROUP_COLUMNS. Inlining the columns " +
        "is how the collapse and its specification drift apart, which is the thing this check exists for",
    );
  }
  const built = stripComments(serviceSrc).match(
    /const\s+groupBy\s*=\s*RECORD_GROUP_COLUMNS\.map\(\(c\)\s*=>\s*RECORD_GROUP_SQL\[c\]\)\.join\(", "\)/,
  );
  if (!built) {
    violations.push("`groupBy` is not built from RECORD_GROUP_COLUMNS × RECORD_GROUP_SQL");
  }
  for (const c of columns) {
    if (!sqlFor[c]) violations.push(`RECORD_GROUP_COLUMNS names "${c}" but RECORD_GROUP_SQL has no expression for it`);
  }
  return { examined: columns.length, violations };
}

// ── 4 · One bare aggregate, so the bare columns are the right row's ───────────────────────────

export function checkOneBareAggregate(serviceSrc) {
  const sql = sqlContaining(serviceSrc, "GROUP BY");
  if (!sql) return { examined: 0, violations: ["no grouped query found"] };
  const violations = [];
  // COUNT(*) is not a bare MIN/MAX and does not affect the guarantee; MIN/MAX do.
  const bare = [...sql.matchAll(/\b(MAX|MIN)\s*\(/gi)];
  if (bare.length !== 1) {
    violations.push(
      `the record query has ${bare.length} bare MAX()/MIN() aggregates. SQLite only guarantees that the ` +
        "other bare columns come from the row that produced the aggregate when there is exactly one, and " +
        "that guarantee is what makes Reopen act on the most recent attempt rather than an arbitrary sibling.",
    );
  }
  return { examined: 1, violations };
}

// ── 4b · The search cannot build a LIKE pattern D1 refuses ────────────────────────────────────

/**
 * MEASURED AGAINST THE REAL BINDING, 18 Sep 2026: D1 answers a LIKE pattern of 50 characters or
 * more with `SQLITE_ERROR: LIKE or GLOB pattern too complex`. A 40-character term (42 with its two
 * wildcards) is fine; 48 is not. The first version of this route built one `%<whole query>%`, so
 * the longest and most specific searches — the ones she makes when she actually remembers
 * something — came back as a 500 and a blank record. That is the failure mode that looks like "the
 * firm has never done this", which is the worst answer this surface can give.
 *
 * The fix is `searchTerms`: one capped term per word, ANDed. This holds the cap to a number that
 * cannot reach the limit, and requires the route to go through it rather than around it.
 */
export function checkSearchCannotExceedTheLikeLimit(serviceSrc, termMax, termsMax) {
  const src = stripComments(serviceSrc);
  const violations = [];
  if (!/for \(const term of searchTerms\(/.test(src)) {
    violations.push(
      "the record route no longer builds its LIKE terms through searchTerms() — a single pattern over the " +
        "whole query is what D1 refused with 'LIKE or GLOB pattern too complex' on any search past ~48 characters",
    );
  }
  // +2 for the wildcards the route wraps each term in. The limit itself is 50; 40 leaves headroom.
  if (termMax + 2 > 44) {
    violations.push(
      `LIKE_TERM_MAX is ${termMax}, which with its two wildcards is ${termMax + 2} characters — D1 refuses a ` +
        "pattern at 50 and this leaves no headroom",
    );
  }
  if (termsMax > 8) {
    violations.push(`LIKE_TERMS_MAX is ${termsMax} — that many ANDed LIKEs over the firm's whole history is a scan nobody asked for`);
  }
  return { examined: 3, violations };
}

// ── 5 · Every control reaches the server, and the view pages ──────────────────────────────────

const CONTROLS = [
  { param: "q", why: "free-text search" },
  { param: "who", why: "the who filter" },
  { param: "month", why: "the month filter" },
  { param: "state", why: "the done/dropped filter" },
  { param: "cursor", why: "paging past the first screen" },
];

export function checkControlsReachTheServer(viewSrc) {
  if (!viewSrc) return { examined: 0, violations: ["the record view was not read"] };
  const src = stripComments(viewSrc);
  const violations = [];
  for (const c of CONTROLS) {
    if (!new RegExp(`params\\.set\\(\\s*"${c.param}"`).test(src)) {
      violations.push(
        `${c.why} is never put on the request (params.set("${c.param}", …) is absent) — a control that narrows ` +
          "a list the browser already holds cannot see past the first page",
      );
    }
  }
  if (!/data-testid="work-record-search"/.test(src)) {
    violations.push("the record offers no search box — month alone makes her guess before it will show her anything");
  }
  if (!/bandByMonth/.test(src)) {
    violations.push("the record no longer groups by month — the spine is what makes a long list scannable");
  }
  if (!/next_cursor/.test(src)) {
    violations.push("the record view ignores next_cursor — it therefore stops at one page, silently");
  }
  return { examined: CONTROLS.length + 3, violations };
}

// ── 6 · The route exists ──────────────────────────────────────────────────────────────────────

export function checkRouteRegistered(routerSrc, serviceSrc) {
  const violations = [];
  if (!/\.get\(\s*"\/api\/work-cards\/record"\s*,\s*handleWorkRecord\s*\)/.test(stripComments(routerSrc))) {
    violations.push("/api/work-cards/record is not registered — the record view is asking a route that does not exist");
  }
  if (!/export async function handleWorkRecord/.test(serviceSrc)) {
    violations.push("handleWorkRecord is not exported from workCards.ts");
  }
  return { examined: 2, violations };
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────

async function run() {
  const service = readFileSync(SERVICE, "utf8");
  const router = readFileSync(ROUTER, "utf8");
  const view = readFileSync(RECORD_VIEW, "utf8");
  const page = readFileSync(WORK_PAGE, "utf8");

  const shared = await import(SHARED);
  const columns = shared.RECORD_GROUP_COLUMNS;
  const sqlFor = shared.RECORD_GROUP_SQL;

  const board = checkBoardIsLiveOnly(service);
  const truncation = checkNoClientTruncation({
    "src/client/pages/WorkCardsPage.tsx": page,
    "src/client/pages/WorkRecordView.tsx": view,
  });
  const group = checkGroupByMatchesSpec(service, columns, sqlFor);
  const aggregate = checkOneBareAggregate(service);
  const like = checkSearchCannotExceedTheLikeLimit(service, shared.LIKE_TERM_MAX, shared.LIKE_TERMS_MAX);
  const controls = checkControlsReachTheServer(view);
  const route = checkRouteRegistered(router, service);

  const empty = [
    board.examined === 0 && "did not find the board query",
    truncation.examined === 0 && "read no Work client files",
    group.examined === 0 && "found no declared collapse columns",
    aggregate.examined === 0 && "found no grouped record query",
    like.examined === 0 && "checked nothing about the search terms",
    controls.examined === 0 && "read nothing in the record view",
    route.examined === 0 && "checked no routes",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`RECORD SCALE SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [
    ...board.violations,
    ...truncation.violations,
    ...group.violations,
    ...aggregate.violations,
    ...like.violations,
    ...controls.violations,
    ...route.violations,
  ];
  if (violations.length > 0) {
    console.error("RECORD SCALE SCAN FAILED — the Work page would not survive day 200:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nOn 18 Sep 2026, against 531 finished cards, the page showed fifty of them under a heading");
    console.error("that said 496, and the other 481 were unreachable with nothing admitting it. The test of");
    console.error("this surface is whether she can find last month's Room packet in ten seconds on day 200.");
    process.exit(1);
  }

  console.log(
    `RECORD SCALE SCAN PASSED: the board carries live work only; ${truncation.examined} Work client file(s) ` +
      `truncate no finished list in the browser; the collapse groups on the ${columns.length} declared columns ` +
      `(${columns.join(", ")}) with one bare aggregate; the search builds ≤${shared.LIKE_TERMS_MAX} terms of ` +
      `≤${shared.LIKE_TERM_MAX} characters, under D1's 50-character LIKE limit; ${CONTROLS.length} controls all reach the server and ` +
      "the record pages; the route is registered.",
  );
}

/** Each planted failure must still be caught. A validator nobody has broken on purpose is a guess. */
function selfTest() {
  const cases = [];
  const fail = (name, fn, match) => cases.push({ name, fn, match });

  // THE REAL PRE-FIX SHAPES, verbatim.
  fail(
    "the board query as it actually shipped — no state constraint, capped at 500",
    () =>
      checkBoardIsLiveOnly(
        'x = env.DB.prepare(`SELECT wc.id, wc.next_action, wc.due_at, wc.capture_id, COALESCE(e.name, u.full_name) AS owner_name FROM work_card wc WHERE ${v} ORDER BY wc.created_at DESC LIMIT 500`)',
      ).violations,
    /does not constrain wc.state/,
  );
  fail(
    "the page as it actually shipped — finished.slice(0, 50)",
    () => checkNoClientTruncation({ "p.tsx": "{finished.slice(0, 50).map((c) => (<li/>))}" }).violations,
    /truncates finished work in the browser/,
  );
  fail(
    "the same bug under another name",
    () => checkNoClientTruncation({ "p.tsx": "recordRows.slice(0, 200)" }).violations,
    /truncates finished work/,
  );
  fail(
    "a GROUP BY inlined instead of built from the declaration",
    () =>
      checkGroupByMatchesSpec(
        'x = env.DB.prepare(`SELECT a FROM work_card wc GROUP BY wc.title, wc.owner_id ORDER BY at DESC`)',
        ["month", "title"],
        { month: "substr(wc.created_at, 1, 7)", title: "wc.title" },
      ).violations,
    /no longer builds its GROUP BY/,
  );
  fail(
    "a second bare aggregate voids the row guarantee",
    () =>
      checkOneBareAggregate(
        'x = env.DB.prepare(`SELECT MAX(wc.created_at) AS at, MIN(wc.created_at) AS first, wc.id FROM work_card wc GROUP BY wc.title`)',
      ).violations,
    /bare MAX\(\)\/MIN\(\) aggregates/,
  );
  fail(
    "a search box that filters what the browser already holds",
    () =>
      checkControlsReachTheServer(
        '<input data-testid="work-record-search"/>; rows.filter(r => r.title.includes(q)); bandByMonth(rows); next_cursor',
      ).violations,
    /free-text search is never put on the request/,
  );
  fail(
    "a record that stops at one page",
    () =>
      checkControlsReachTheServer(
        '<input data-testid="work-record-search"/> params.set("q",a);params.set("who",b);params.set("month",c);params.set("state",d);bandByMonth(x)',
      ).violations,
    /ignores next_cursor/,
  );
  fail(
    "a record with no month spine",
    () =>
      checkControlsReachTheServer(
        '<input data-testid="work-record-search"/> params.set("q",a);params.set("who",b);params.set("month",c);params.set("state",d);params.set("cursor",e);next_cursor',
      ).violations,
    /no longer groups by month/,
  );
  fail(
    "one LIKE over the whole query — the shape D1 refused with 'pattern too complex'",
    () => checkSearchCannotExceedTheLikeLimit('const like = `%${q}%`; where.push(`title LIKE ${bind(like)}`)', 32, 6).violations,
    /no longer builds its LIKE terms through searchTerms/,
  );
  fail(
    "a term cap raised until it can reach D1's limit again",
    () => checkSearchCannotExceedTheLikeLimit("for (const term of searchTerms(q)) {}", 60, 6).violations,
    /leaves no headroom/,
  );
  fail(
    "an unregistered route",
    () => checkRouteRegistered('.get("/api/work-cards/by-owner", handleWorkByOwner)', "export async function handleWorkRecord").violations,
    /is not registered/,
  );
  fail(
    "the scan losing sight of the file it audits reports that, rather than passing",
    () => checkBoardIsLiveOnly("nothing resembling a query in here").violations,
    /stopped reading the file it audits/,
  );

  // CLEAN FIXTURES MUST PASS — a scan that fails everything is as useless as one that passes it.
  const clean = [
    {
      name: "the board query as it now stands",
      run: () =>
        checkBoardIsLiveOnly(
          "x = env.DB.prepare(`SELECT wc.next_action, wc.due_at, wc.capture_id, COALESCE(e.name, u.full_name) AS owner_name FROM work_card wc WHERE ${v} AND wc.state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED') ORDER BY wc.created_at DESC`)",
        ).violations,
    },
    {
      name: "a slice that is not of finished work",
      run: () => checkNoClientTruncation({ "p.tsx": "c.looks.slice(0, 2)" }).violations,
    },
    {
      name: "the search as it now stands",
      run: () => checkSearchCannotExceedTheLikeLimit("for (const term of searchTerms(q ?? \"\")) {}", 32, 6).violations,
    },
    {
      name: "a record view wired to the server on every control",
      run: () =>
        checkControlsReachTheServer(
          '<input data-testid="work-record-search"/> params.set("q",a);params.set("who",b);params.set("month",c);params.set("state",d);params.set("cursor",e); bandByMonth(rows); next_cursor',
        ).violations,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = c.fn();
    if (got.length === 0 || !got.some((v) => c.match.test(v))) {
      failed += 1;
      console.error(`SELF-TEST FAILED: "${c.name}" was not caught — got ${JSON.stringify(got)}`);
    }
  }
  for (const c of clean) {
    const got = c.run();
    if (got.length > 0) {
      failed += 1;
      console.error(`SELF-TEST FAILED: clean fixture "${c.name}" was rejected — ${JSON.stringify(got)}`);
    }
  }
  // The zero-item guard is the one this repo keeps regressing: prove an empty read is not a pass.
  if (checkNoClientTruncation({}).examined !== 0) {
    failed += 1;
    console.error("SELF-TEST FAILED: scanning no files somehow examined something");
  }
  if (sqlContaining("", "GROUP BY") !== null) {
    failed += 1;
    console.error("SELF-TEST FAILED: an empty source produced a query");
  }

  if (failed > 0) process.exit(1);
  console.log(
    `SELF-TEST PASSED: ${cases.length}/${cases.length} planted failures caught — including both shapes that ` +
      `actually shipped — and ${clean.length}/${clean.length} clean fixtures accepted.`,
  );
}

if (process.argv.includes("--self-test")) selfTest();
else await run();
