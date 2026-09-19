#!/usr/bin/env node
/**
 * every-company-is-in-the-pipeline.mjs — `npm run validate:companies-in-pipeline`.
 *
 * ONE ASSERTION: A COMPANY CANNOT ARRIVE WITHOUT AN OPPORTUNITY ON THE BOARD.
 *
 * Owner, 18 Sep 2026: "all companies should be in the pipeline, no matter how they come in. They
 * are top of funnel if they are in the system. From email we have to DECIDE on them."
 *
 * WHAT WENT WRONG. `ROUTE_POLICY` in services/dealIntake.ts carried `opensRecord`, true for the
 * MANUAL route and false for EMAIL, NETWORK_OS and SCOUT. The three unattended routes created the
 * register row and raised a card that said "then open it at the top of the funnel", and nothing
 * checked that the card did. Production, read on 18 Sep: Northwind Robotics (22 Aug, no card at
 * all) and Vynlo (24 Aug, by email, deck read, card DONE) — two companies in the register with no
 * opportunity, invisible on the board, one of them behind a card that concluded without the thing
 * it governed. The Companies page rendered each as "Not in the pipeline", calmly, as if that were a
 * state a company could legitimately be in.
 *
 * WHAT IS CHECKED, all read from code with comments stripped, never from prose:
 *   1 · THE ROUTE TABLE HAS NO SWITCH. Every `ROUTE_POLICY` entry is parsed and none may carry a
 *       key that gates opening, writing, recording or skipping — `opensRecord` under any name.
 *   2 · THE DOOR CANNOT RETURN WITHOUT AN OPPORTUNITY. `FunnelEntry.opportunity_id` and
 *       `FunnelEntry.opportunity` are non-nullable, and `openIntoFunnel` declares its `opportunity`
 *       local non-nullable and returns `opportunity.id`. With `npm run typecheck` green, TypeScript's
 *       definite-assignment rule then proves every path through the function assigns one — which is
 *       a stronger guarantee than any regex over the branches, and it is what this leans on.
 *   3 · THE PIN EXISTS. `tests/dealIntake.test.ts` runs every route in `INTAKE_ROUTES` against local
 *       D1 and asserts exactly one live opportunity each; the test is found by name and must name
 *       every route. A guard whose test was quietly deleted is the inert-guard defect.
 *   4 · THE CALM LABEL IS GONE. `CompaniesPage.tsx` may not render "Not in the pipeline" and must
 *       render the fault notice, with its testid, for a company row that has no deal.
 *   5 · THE BACKFILL IS SHAPED RIGHT. Migration 0197 opens one for every non-MERGED company with
 *       no non-archived opportunity — the `NOT EXISTS` and the `archived_at IS NULL` are both there.
 *
 * HARD-FAILS ON ZERO: zero routes, zero policy entries, or a source file that cannot be read each
 * exit 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside a clean fixture that must pass.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const INTAKE = path.join(ROOT, "src", "worker", "services", "dealIntake.ts");
const TEST = path.join(ROOT, "tests", "dealIntake.test.ts");
const PAGE = path.join(ROOT, "src", "client", "pages", "CompaniesPage.tsx");
const MIGRATION = path.join(ROOT, "migrations", "0197_every_company_is_in_the_pipeline.sql");

/** A policy key that would let a route decide whether the pipeline gets written. */
const GATE_KEY = /open|write|record|pipeline|skip|funnel/i;

/** The routes the code declares. */
export function parseRoutes(source) {
  const m = /export const INTAKE_ROUTES = \[([^\]]*)\] as const;/.exec(source);
  if (!m) return null;
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

/** Every ROUTE_POLICY entry, as { route: [keys] }. */
export function parsePolicy(source) {
  const block = /export const ROUTE_POLICY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (!block) return null;
  const entries = {};
  // Each top-level entry is `  ROUTE: {` at two-space indent, closed by `  },` at the same indent.
  for (const m of block[1].matchAll(/^\s{2}([A-Z_]+):\s*\{([\s\S]*?)^\s{2}\}/gm)) {
    entries[m[1]] = [...m[2].matchAll(/^\s{4}([a-zA-Z_]+)\s*:/gm)].map((k) => k[1]);
  }
  return entries;
}

/** The body of `openIntoFunnel`, from its declaration to the next top-level closing brace. */
export function funnelBody(source) {
  const start = source.indexOf("export async function openIntoFunnel(");
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  return end < 0 ? null : source.slice(start, end + 3);
}

export function auditIntake({ routes, policy, source }) {
  const violations = [];
  for (const [route, keys] of Object.entries(policy)) {
    for (const k of keys) {
      if (GATE_KEY.test(k)) {
        violations.push(`ROUTE_POLICY.${route} carries \`${k}\` — a switch that lets a route decide whether the pipeline is written. Every route opens the opportunity; there is no switch.`);
      }
    }
  }
  for (const r of routes) if (!policy[r]) violations.push(`route ${r} is declared but has no ROUTE_POLICY entry`);

  const entry = /export interface FunnelEntry \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  if (!/^\s*opportunity_id:\s*string;\s*$/m.test(entry)) {
    violations.push("FunnelEntry.opportunity_id is not a plain `string` — a nullable id is a route that may return without opening one");
  }
  if (!/^\s*opportunity:\s*OpportunityRow;\s*$/m.test(entry)) {
    violations.push("FunnelEntry.opportunity is not a plain `OpportunityRow` — a nullable row is a route that may return without opening one");
  }

  const body = funnelBody(source);
  if (!body) {
    violations.push("openIntoFunnel was not found in dealIntake.ts");
  } else {
    if (!/let opportunity: OpportunityRow;/.test(body)) {
      violations.push("openIntoFunnel does not declare `let opportunity: OpportunityRow;` — the non-nullable local is what makes TypeScript prove every branch assigns one");
    }
    if (!/opportunity_id:\s*opportunity\.id/.test(body)) {
      violations.push("openIntoFunnel does not return `opportunity_id: opportunity.id`");
    }
    if ((body.match(/createOpportunity\(/g) ?? []).length < 2) {
      violations.push("openIntoFunnel calls createOpportunity fewer than twice — the partner's branch and the unattended branch must each open one");
    }
  }
  return violations;
}

export function auditTest({ routes, testSource }) {
  const violations = [];
  const pin = /it\("leaves EXACTLY ONE live opportunity on the board whichever door[^"]*"/.exec(testSource);
  if (!pin) {
    violations.push("tests/dealIntake.test.ts no longer carries the exactly-one-live-opportunity pin");
    return violations;
  }
  const rest = testSource.slice(pin.index, pin.index + 4000);
  for (const r of routes) {
    if (!new RegExp(`route:\\s*"${r}"`).test(rest)) violations.push(`the exactly-one pin does not exercise the ${r} route`);
  }
  if (!/toHaveLength\(1\)/.test(rest)) violations.push("the exactly-one pin does not assert a length of exactly one");
  return violations;
}

export function auditPage(pageSource) {
  const violations = [];
  if (/Not in the pipeline/.test(pageSource)) {
    violations.push('CompaniesPage.tsx renders "Not in the pipeline" as a calm label — a company with no deal is a fault and must say so');
  }
  if (!/data-testid=\{`company-no-deal-\$\{c\.id\}`\}/.test(pageSource)) {
    violations.push("CompaniesPage.tsx does not render the `company-no-deal-<id>` fault notice for a row with no deal");
  }
  if (!/notice-bad/.test(pageSource)) {
    violations.push("the fault notice on CompaniesPage.tsx is not styled as a fault (`notice-bad`)");
  }
  return violations;
}

export function auditMigration(sql) {
  const violations = [];
  if (!/INSERT INTO investment_opportunity/.test(sql)) violations.push("migration 0197 does not insert into investment_opportunity");
  if (!/NOT EXISTS\s*\(\s*SELECT 1 FROM investment_opportunity o\s+WHERE o\.company_id = c\.id AND o\.archived_at IS NULL/.test(sql)) {
    violations.push("migration 0197 does not restrict itself to companies with no NON-ARCHIVED opportunity");
  }
  if (!/c\.status <> 'MERGED'/.test(sql)) violations.push("migration 0197 would open an opportunity on a MERGED company");
  if (!/INSERT INTO event_record/.test(sql)) violations.push("migration 0197 does not say why on the spine");
  return violations;
}

function read(file) {
  if (!existsSync(file)) {
    console.error(`COMPANIES-IN-PIPELINE SCAN FAILED — ${path.relative(ROOT, file)} does not exist. Rule 0.`);
    process.exit(1);
  }
  return stripCommentsFor(file, readFileSync(file, "utf8"));
}

function selfTest() {
  const fail = (m) => {
    console.error(`SELF-TEST FAILED — ${m}`);
    process.exit(1);
  };
  const ok = (m) => console.log(`  ✓ ${m}`);

  const clean = read(INTAKE);
  const routes = parseRoutes(clean);
  const policy = parsePolicy(clean);
  if (!routes || routes.length < 4) fail("the real route table did not parse");
  ok(`the real route table parses (${routes.join(", ")})`);

  // THE REAL PRE-FIX SHAPE: `opensRecord: false` on three routes.
  const preFix = {
    MANUAL: ["owner", "machine", "opensRecord", "finderMayScrap"],
    EMAIL: ["owner", "machine", "opensRecord", "finderMayScrap"],
    NETWORK_OS: ["owner", "machine", "opensRecord"],
    SCOUT: ["owner", "machine", "opensRecord"],
  };
  const v1 = auditIntake({ routes, policy: preFix, source: clean });
  if (!v1.some((v) => v.includes("opensRecord"))) fail("the real `opensRecord` switch was not caught");
  ok("the real pre-fix switch, `opensRecord`, on every route");

  // The same switch under another name.
  const renamed = { ...policy, EMAIL: [...policy.EMAIL, "skipPipeline"] };
  if (!auditIntake({ routes, policy: renamed, source: clean }).some((v) => v.includes("skipPipeline"))) fail("a renamed switch was not caught");
  ok("the same switch under another name");

  // The real pre-fix return shape: a nullable opportunity.
  const nullable = clean
    .replace(/opportunity_id: string;/, "opportunity_id: string | null;")
    .replace(/opportunity: OpportunityRow;\n  work_card_id/, "opportunity: OpportunityRow | null;\n  work_card_id")
    .replace("let opportunity: OpportunityRow;", "let opportunity: OpportunityRow | null = null;");
  const v2 = auditIntake({ routes, policy, source: nullable });
  if (!v2.some((v) => v.includes("opportunity_id is not a plain"))) fail("a nullable opportunity_id was not caught");
  if (!v2.some((v) => v.includes("opportunity is not a plain"))) fail("a nullable opportunity row was not caught");
  if (!v2.some((v) => v.includes("let opportunity: OpportunityRow;"))) fail("a nullable local was not caught");
  ok("a door that may return with no opportunity (the real pre-fix return shape)");

  // The unattended branch removed: only the partner's createOpportunity remains.
  const oneCall = clean.replace(/opportunity = await createOpportunity\(env, intakeActor\(policy\),[\s\S]*?\}\);/, "opportunity = (await getOpportunity(env, 'x'))!;");
  if (!auditIntake({ routes, policy, source: oneCall }).some((v) => v.includes("fewer than twice"))) fail("a removed unattended branch was not caught");
  ok("the unattended branch removed");

  // The pin deleted, and the pin missing a route.
  const testSource = read(TEST);
  if (auditTest({ routes, testSource }).length !== 0) fail(`the real pin was rejected: ${auditTest({ routes, testSource }).join("; ")}`);
  if (!auditTest({ routes, testSource: testSource.replace("leaves EXACTLY ONE live opportunity", "leaves some opportunity") }).some((v) => v.includes("no longer carries"))) fail("a deleted pin was not caught");
  if (!auditTest({ routes: [...routes, "CARRIER_PIGEON"], testSource }).some((v) => v.includes("CARRIER_PIGEON"))) fail("a route the pin does not exercise was not caught");
  ok("the pin deleted, and a fifth route the pin does not exercise");

  // The real calm label.
  const page = read(PAGE);
  if (auditPage(page).length !== 0) fail(`the real page was rejected: ${auditPage(page).join("; ")}`);
  const calm = page.replace(/\{!s && \([\s\S]*?\)\}\n/, "").replace('{s?.label ?? "—"}', '{s?.label ?? "Not in the pipeline"}');
  const v3 = auditPage(calm);
  if (!v3.some((v) => v.includes("calm label"))) fail('the real "Not in the pipeline" label was not caught');
  if (!v3.some((v) => v.includes("company-no-deal"))) fail("a page with no fault notice was not caught");
  ok('the real calm label, "Not in the pipeline", with the fault notice removed');

  // The backfill missing its archived clause.
  const sql = read(MIGRATION);
  if (auditMigration(sql).length !== 0) fail(`the real migration was rejected: ${auditMigration(sql).join("; ")}`);
  if (!auditMigration(sql.replace(" AND o.archived_at IS NULL", "")).some((v) => v.includes("NON-ARCHIVED"))) fail("a backfill blind to archived records was not caught");
  if (!auditMigration(sql.replace("c.status <> 'MERGED'", "1=1")).some((v) => v.includes("MERGED"))) fail("a backfill that opens deals on merged husks was not caught");
  ok("a backfill that ignores archived records, and one that revives merged husks");

  if (auditIntake({ routes, policy, source: clean }).length !== 0) fail(`the real source was rejected: ${auditIntake({ routes, policy, source: clean }).join("; ")}`);
  ok("the real source, test, page and migration all pass");

  console.log("COMPANIES-IN-PIPELINE SELF-TEST PASSED");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const source = read(INTAKE);
  const routes = parseRoutes(source);
  const policy = parsePolicy(source);
  if (!routes || routes.length === 0) {
    console.error("COMPANIES-IN-PIPELINE SCAN FAILED — read zero routes from INTAKE_ROUTES. Rule 0.");
    process.exit(1);
  }
  if (!policy || Object.keys(policy).length === 0) {
    console.error("COMPANIES-IN-PIPELINE SCAN FAILED — read zero entries from ROUTE_POLICY. Rule 0.");
    process.exit(1);
  }

  const violations = [
    ...auditIntake({ routes, policy, source }),
    ...auditTest({ routes, testSource: read(TEST) }),
    ...auditPage(read(PAGE)),
    ...auditMigration(read(MIGRATION)),
  ];
  if (violations.length > 0) {
    console.error("COMPANIES-IN-PIPELINE SCAN FAILED — a company can be in the system and not on the board:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nOwner, 18 Sep 2026: every company is top of funnel the moment it is in the system, whichever\n" +
        "door it came through; the human act is the decision, not the admission. Northwind Robotics and\n" +
        "Vynlo sat in the register for a month with no opportunity because one route of four wrote the\n" +
        "pipeline and a card was trusted to do the rest.",
    );
    process.exit(1);
  }
  console.log(
    `COMPANIES-IN-PIPELINE SCAN PASSED: ${routes.length} route(s), ${Object.keys(policy).length} policy entries, none with a ` +
      `switch; the door returns a non-nullable opportunity; the exactly-one pin exercises every route; the calm label is ` +
      `gone; migration 0197 backfills only what has nothing non-archived on the board.`,
  );
}

main();
