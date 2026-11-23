/**
 * PORTER'S PR CARRIES ITS OWN SELF-REVIEW AND MUTATION PROOF (23 Nov 2026).
 *
 * topbarz-voting #21 went to a fresh reviewer with neither section and failed at the first check ("no
 * mutation proof"). Her rule for every builder (~/.claude/agents/builder.md): before review, the builder is its
 * own hostile reviewer on the eight causes of failed reviews and writes `## Self-review` (one line per cause:
 * what was checked, what was found) and `## Mutation proof` (one row per fix: the mutation made and the test that
 * went red) in the PR body. `~/bin/land` refuses a code PR without the second.
 *
 * WHO WRITES THEM. The BUILD model reports both in its result file (`self_review`, `mutation_proof`); THIS module
 * turns them into the two sections and the SCRIPT writes them into the PR body after the PR is read and before
 * its checks are watched. One writer for every lane: a PR Claude opened with `gh pr create`, one the runner opened
 * for Codex, a staged rebuild's PR, and an older PR a rebuild commits on top of (each BUILD rewrites the sections,
 * so a PR opened before this rule gets them on its next push).
 *
 * WHAT IS REFUSED (a NAMED STOP, so no preview email goes out and nothing lands on a PR without them):
 *   SELF_REVIEW_MISSING   a section absent, a cause missing or repeated, an unknown cause, a line too thin to say
 *                         what was checked, the same line pasted under several causes, a mutation row without
 *                         the mutation or the test, a test that did not go red, a "none" without its reason.
 *   PR_BODY_UNREAD        gh could not read the PR's body: nothing is written over a body we did not see.
 *   PR_BODY_NOT_WRITTEN   gh refused the edit, or the body read back does not carry both sections.
 * Structure only: whether a line is honest is the fresh reviewer's call, never a keyword's.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The eight causes of failed reviews, most common first (builder.md, 22 Nov 2026). `key` is what the result names. */
export const SELF_REVIEW_CHECKS = [
  { key: "abuse", name: "Abuse and data loss" },
  { key: "real_output", name: "Real output" },
  { key: "outage", name: "Outage" },
  { key: "tests", name: "Tests that prove nothing" },
  { key: "half_built", name: "Half-built" },
  { key: "edges", name: "Logic edges" },
  { key: "design", name: "Design" },
  { key: "ci", name: "CI" },
];

export const SELF_REVIEW_HEADING = "## Self-review";
export const MUTATION_HEADING = "## Mutation proof";

const MIN_LINE_WORDS = 4;
const MIN_NONE_WORDS = 6;
const MAX_CELL = 400;
const MAX_ROWS = 25;
/** GitHub refuses a PR body over 65,536 characters; the sections always fit, the rest of the body is cut first. */
const MAX_BODY = 65_000;

const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const words = (s) => (s ? s.split(" ").length : 0);
const cell = (s) => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s).replace(/\|/g, "\\|");

/** Null when the result carries both sections with real content; otherwise what is missing, for an engineer. Pure. */
export function selfReviewProblem(result) {
  const r = result && typeof result === "object" ? result : {};
  const rows = r.self_review;
  if (!Array.isArray(rows) || rows.length === 0) return `self_review is missing: one row per cause, { check, found }, for all ${SELF_REVIEW_CHECKS.length} causes (${SELF_REVIEW_CHECKS.map((c) => c.key).join(", ")})`;
  const known = new Set(SELF_REVIEW_CHECKS.map((c) => c.key));
  const seen = new Map();
  for (const row of rows) {
    const key = text(row?.check);
    if (!known.has(key)) return `self_review names an unknown cause "${key.slice(0, 40)}" (the causes are ${[...known].join(", ")})`;
    if (seen.has(key)) return `self_review names the cause "${key}" twice`;
    const found = text(row?.found);
    if (words(found) < MIN_LINE_WORDS) return `self_review's "${key}" line does not say what was checked and found (${MIN_LINE_WORDS}+ words)`;
    seen.set(key, found.toLowerCase());
  }
  const absent = [...known].filter((k) => !seen.has(k));
  if (absent.length) return `self_review is missing the cause(s) ${absent.join(", ")}`;
  if (new Set(seen.values()).size < seen.size) return "self_review repeats the same line under several causes: each cause says what was checked for IT";

  const proof = r.mutation_proof;
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    if (words(text(proof.none)) < MIN_NONE_WORDS) return `mutation_proof { none } must say why there is no behaviour to break (${MIN_NONE_WORDS}+ words)`;
    return null;
  }
  if (!Array.isArray(proof) || proof.length === 0) return "mutation_proof is missing: one row per fix, { fix, mutation, test, went_red: true } (or { none: \"<why there is no behaviour to break>\" })";
  if (proof.length > MAX_ROWS) return `mutation_proof has ${proof.length} rows; at most ${MAX_ROWS}`;
  for (const [i, row] of proof.entries()) {
    const n = i + 1;
    if (!text(row?.fix)) return `mutation_proof row ${n} does not name the fix`;
    if (row?.covered_by !== undefined) {
      const by = Number(row.covered_by);
      const target = Number.isInteger(by) && by >= 1 && by < n ? proof[by - 1] : null;
      if (!target || target.covered_by !== undefined) return `mutation_proof row ${n} is covered_by ${String(row.covered_by).slice(0, 10)}, which is not an earlier row with its own test`;
      continue;
    }
    if (words(text(row?.mutation)) < 2) return `mutation_proof row ${n} does not say the mutation made (what was undone or broken)`;
    if (words(text(row?.test)) < 1 || text(row?.test).length < 3) return `mutation_proof row ${n} names no test that went red`;
    if (row?.went_red !== true) return `mutation_proof row ${n}: the test did not go red (went_red must be true); a test that stays green under the mutation proves nothing`;
  }
  return null;
}

/** The two sections as markdown, from a result `selfReviewProblem` passed. Pure. */
export function renderSections(result) {
  const byKey = new Map(result.self_review.map((r) => [text(r.check), text(r.found)]));
  const review = [SELF_REVIEW_HEADING, "", ...SELF_REVIEW_CHECKS.map((c, i) => `${i + 1}. **${c.name}:** ${byKey.get(c.key).slice(0, MAX_CELL * 2)}`)];
  const proof = result.mutation_proof;
  const rows = Array.isArray(proof)
    ? ["| # | Fix | Mutation made | Test that went red |", "|---|---|---|---|", ...proof.map((r, i) => (r.covered_by !== undefined ? `| ${i + 1} | ${cell(text(r.fix))} | covered by row ${Number(r.covered_by)} | covered by row ${Number(r.covered_by)} |` : `| ${i + 1} | ${cell(text(r.fix))} | ${cell(text(r.mutation))} | ${cell(text(r.test))} |`))]
    : [`None — ${cell(text(proof.none))}`];
  return [...review, "", MUTATION_HEADING, "", ...rows].join("\n");
}

/** The body without any earlier Self-review or Mutation proof section (heading to the next heading). Pure. */
export function withoutSections(body) {
  const out = [];
  let skipping = false;
  for (const line of String(body ?? "").split("\n")) {
    if (/^#{1,6}\s/.test(line)) skipping = /^#{1,6}\s*(self-review|mutation proof)\b/i.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * THE PR BODY WRITER. `{ ok: true, body }` — the PR's own body with both sections (re)written at its end — or a
 * named refusal when the result does not carry them. Pure.
 */
export function prBodyWithSelfReview(body, result) {
  const problem = selfReviewProblem(result);
  if (problem) return { ok: false, tag: "SELF_REVIEW_MISSING", why: `the build's PR is not handed on without its self-review and mutation proof: ${problem}` };
  const sections = renderSections(result);
  let rest = withoutSections(body);
  const room = MAX_BODY - sections.length - 80;
  if (rest.length > room) rest = `${rest.slice(0, Math.max(0, room))}\n\n…(cut to fit GitHub's PR body limit)`;
  return { ok: true, body: `${rest ? `${rest}\n\n` : ""}${sections}\n` };
}

/**
 * Read the PR's body, write it back with both sections, and read it again to see they are there.
 * `run(cmd, args, { cwd })` is spawnSync-shaped ({ status, stdout, stderr }) and injected, so the test drives a fake gh.
 * Returns `{ ok: true, line }` or `{ ok: false, tag, why }`.
 */
export function writeSelfReview({ cwd, number, result, run }) {
  const read = () => {
    const r = run("gh", ["pr", "view", String(number), "--json", "body"], { cwd });
    if (r?.status !== 0) return null;
    try {
      const j = JSON.parse(String(r.stdout ?? ""));
      return typeof j?.body === "string" ? j.body : null;
    } catch {
      return null;
    }
  };
  const problem = selfReviewProblem(result);
  if (problem) return prBodyWithSelfReview("", result);
  const before = read();
  if (before === null) return { ok: false, tag: "PR_BODY_UNREAD", why: `gh could not read PR #${number}'s body, so its self-review and mutation proof were not written; the build is not handed on without them` };
  const built = prBodyWithSelfReview(before, result);
  if (!built.ok) return built;
  const dir = mkdtempSync(path.join(tmpdir(), "porter-pr-body-"));
  try {
    const file = path.join(dir, "body.md");
    writeFileSync(file, built.body);
    const edit = run("gh", ["pr", "edit", String(number), "--body-file", file], { cwd });
    if (edit?.status !== 0) return { ok: false, tag: "PR_BODY_NOT_WRITTEN", why: `gh pr edit #${number} failed: ${String(edit?.stderr || edit?.stdout || "").trim().slice(0, 300)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = read();
  const has = (h) => typeof after === "string" && after.split("\n").some((l) => l.trim() === h);
  if (!has(SELF_REVIEW_HEADING) || !has(MUTATION_HEADING)) return { ok: false, tag: "PR_BODY_NOT_WRITTEN", why: `PR #${number}'s body, read back after the edit, does not carry both ${SELF_REVIEW_HEADING} and ${MUTATION_HEADING}` };
  const rows = Array.isArray(result.mutation_proof) ? `${result.mutation_proof.length} mutation row(s)` : "mutation proof: none, with its reason";
  return { ok: true, line: `PR #${number}: self-review (${SELF_REVIEW_CHECKS.length} causes) and ${rows} written into the PR body by the runner` };
}
