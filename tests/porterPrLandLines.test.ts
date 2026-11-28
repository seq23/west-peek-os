import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOT_BUILT_HEADING, landLinesProblem, parseLandCheck, prBodyWithLandLines, sortCodes, writeLandLines } from "../scripts/lib/pr-land-lines.mjs";
import { landLinesFirst } from "../scripts/duties/web-property-change.mjs";

/**
 * PORTER WRITES THE LINES land READS BEFORE IT LANDS (28 Nov 2026, wc_59ef2d40). Scooter's "Go ahead and publish"
 * spent two LAND attempts on `~/bin/land 41` stopping for a missing Review class, Forms, Outcome and Not built, lines
 * nothing in the runner wrote. The check output below is land --check's real shape (problems_print).
 */
const CHECK_41 = `
PR #41: 4 problem(s) to fix in its description. ALL of them are listed here, each with the line to add (the forms live in pr-body-template.md, seq-bin):
  1. [REVIEW_CLASS_UNDECLARED] PR #41 does not say its review class (money (functions/_lib/pd/pricing.mjs)), so land cannot tell whether it waits on a reviewer.
       add: Review class: none — <why this is in no review class, 3+ words>
  2. [FORMS_UNDECLARED] the diff touches a form (functions/api/lead.js).
       add: Forms: none — <why no form page or server path is touched, 3+ words>
  3. [OUTCOME_UNDECLARED] PR #41 says nothing about its outcome.
       add: Outcome: none — <why nothing scheduled or produced changes, 3+ words>
  4. [NOT_BUILT_UNDECLARED] PR #41 has no '## Not built' section.
       add: ## Not built

STOPPED: NAMED STOP [REVIEW_CLASS_UNDECLARED] ...`;
const REVIEWER_LEFT = `
PR #41: 1 problem(s) to fix in its description.
  1. [REVIEW_PASS_MISSING] PR #41 needs a review (money) and changes code: no fresh reviewer's Ship-ready PASS stands for head 3091c0a.
       add: Ship-ready: PASS — <fresh reviewer> looked at <the real output> at 3091c0a; Engineering: PASS`;

const lines = () => ({
  review_class: "Review class: money — the quote flow computes the prices quoted to clients",
  forms: "Forms: lead form — preview: TEST Porter lead submitted on the preview, received by the Work sheet",
  outcome: "Outcome: the live dashboard sign-in page answers — check: curl -s -o /dev/null -w '%{http_code}' https://westpeekproductions.com/dashboard — expect: >= 200 — by: next day",
  not_built: ["Nothing cut."],
});

function fakeGh(body: string) {
  const state = { body };
  const run = (_cmd: string, args: string[]) => {
    if (args[1] === "view") return { status: 0, stdout: JSON.stringify({ body: state.body }) };
    if (args[1] === "edit") {
      state.body = readFileSync(String(args[args.indexOf("--body-file") + 1]), "utf8");
      return { status: 0, stdout: "" };
    }
    throw new Error("unexpected gh");
  };
  return { state, run };
}

describe("land --check is read for what the PR lacks", () => {
  it("reads every numbered code, and sorts them by who can clear them", () => {
    const { codes } = parseLandCheck(CHECK_41);
    expect(codes.map((c) => c.code)).toEqual(["REVIEW_CLASS_UNDECLARED", "FORMS_UNDECLARED", "OUTCOME_UNDECLARED", "NOT_BUILT_UNDECLARED"]);
    expect(sortCodes(codes).builder).toHaveLength(4);
    const r = sortCodes(parseLandCheck(REVIEWER_LEFT).codes);
    expect(r.builder).toHaveLength(0);
    expect(r.reviewer.map((c) => c.code)).toEqual(["REVIEW_PASS_MISSING"]);
  });
});

describe("the lines are checked for land's shape and written into the body", () => {
  const codes = parseLandCheck(CHECK_41).codes;
  it("refuses a missing line, a kept placeholder, a line without its prefix and a reason too thin", () => {
    expect(landLinesProblem(lines(), codes)).toBeNull();
    expect(landLinesProblem({ ...lines(), forms: undefined }, codes)).toMatch(/forms is missing/);
    expect(landLinesProblem({ ...lines(), review_class: "Review class: none — <why this is in no review class, 3+ words>" }, codes)).toMatch(/placeholder/);
    expect(landLinesProblem({ ...lines(), outcome: "the site works — check: curl" }, codes)).toMatch(/must start with "Outcome:"/);
    expect(landLinesProblem({ ...lines(), review_class: "Review class: none — fine" }, codes)).toMatch(/reason/);
    expect(landLinesProblem({ ...lines(), not_built: [] }, codes)).toMatch(/not_built is missing/);
  });

  it("rewrites earlier copies instead of adding a second, and keeps the rest of the body", () => {
    const before = "## What changed\nBoard and quote flow.\n\nReview class: none — old\n\n## Not built\n- old item\n\n## Self-review\n1. **Abuse:** checked";
    const out = prBodyWithLandLines(before, lines(), codes);
    expect(out.ok).toBe(true);
    const body = out.body as string;
    expect(body).toContain("Board and quote flow.");
    expect(body).toContain("## Self-review\n1. **Abuse:** checked");
    expect(body.split("\n").filter((l) => l.startsWith("Review class:"))).toEqual([lines().review_class]);
    expect(body).not.toContain("old item");
    expect(body.split("\n").filter((l) => l.trim() === NOT_BUILT_HEADING)).toHaveLength(1);
    expect(body).toMatch(/## Not built\nNothing cut\./);
  });

  it("writes through gh and reads it back", () => {
    const gh = fakeGh("Board.");
    const out = writeLandLines({ cwd: "/tmp", number: 41, lines: lines(), codes, run: gh.run });
    expect(out.ok).toBe(true);
    expect(gh.state.body).toContain("Forms: lead form — preview: TEST Porter lead");
  });
});

describe("LAND writes the lines first, and never lands on a stop no turn can clear", () => {
  const base = () => ({ job: { pr: { number: 41 } }, names: { worktree: "/tmp" }, jobDir: mkdtempSync(path.join(tmpdir(), "landlines-")), packageDir: "/nope", attachments: [], ctx: {}, progress: () => {}, land: "/bin/land" });

  it("wc_59ef2d40: four missing lines → one turn writes them → land --check passes", async () => {
    const checks = [{ code: 1, out: CHECK_41 }, { code: 0, out: "" }];
    const written: unknown[] = [];
    let turns = 0;
    const out = await landLinesFirst(base(), {
      check: async () => checks.shift()!,
      turn: async () => ((turns += 1), { status: "ok", land_lines: lines(), pre_land: "Google sign-in and both sheets read on the preview" }),
      write: (l: unknown) => (written.push(l), { ok: true, line: "written" }),
    });
    expect(out.ok).toBe(true);
    expect(turns).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("a clean PR lands with no turn", async () => {
    let turns = 0;
    const out = await landLinesFirst(base(), { check: async () => ({ code: 0, out: "" }), turn: async () => ((turns += 1), null), write: () => ({ ok: true }) });
    expect(out.ok).toBe(true);
    expect(turns).toBe(0);
  });

  it("a review class names LAND_NEEDS_REVIEWER, never a land the builder signed for", async () => {
    const checks = [{ code: 1, out: CHECK_41 }, { code: 1, out: REVIEWER_LEFT }];
    const out = await landLinesFirst(base(), { check: async () => checks.shift()!, turn: async () => ({ status: "ok", land_lines: lines() }), write: () => ({ ok: true, line: "w" }) });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/LAND_NEEDS_REVIEWER/);
  });

  it("the builder's pre-deploy check failing stops the landing by name", async () => {
    const out = await landLinesFirst(base(), { check: async () => ({ code: 1, out: CHECK_41 }), turn: async () => ({ status: "failed", reason: "the preview's Google sign-in refuses the live client id" }), write: () => ({ ok: true }) });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/PRE_LAND_CHECK.*Google sign-in/);
  });

  it("lines the turn left out stop by name before anything is written", async () => {
    let wrote = 0;
    const out = await landLinesFirst(base(), {
      check: async () => ({ code: 1, out: CHECK_41 }),
      turn: async () => ({ status: "ok", land_lines: { ...lines(), outcome: undefined } }),
      write: (l: any, c: any) => {
        wrote += 1;
        return writeLandLines({ cwd: "/tmp", number: 41, lines: l, codes: c, run: fakeGh("x").run });
      },
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/LAND_LINES_MISSING.*outcome/);
    expect(wrote).toBe(1);
  });

  it("GitHub unread (75) is said as unread, never as lines to write", async () => {
    let turns = 0;
    const out = await landLinesFirst(base(), { check: async () => ({ code: 75, out: "HTTP 502" }), turn: async () => ((turns += 1), null), write: () => ({ ok: true }) });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/could not read/);
    expect(turns).toBe(0);
  });
});
