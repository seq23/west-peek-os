/**
 * PORTER'S PR CARRIES THE LINES `~/bin/land` READS, WRITTEN BEFORE IT LANDS (28 Nov 2026, wc_59ef2d40).
 *
 * Scooter replied "Go ahead and publish" on the Productions build. Porter's LAND ran `~/bin/land 41` and it stopped
 * twice the same way: PR #41 had no `Review class:`, `Forms:`, `Outcome:` or `## Not built` (land's description
 * gates, 24-27 Nov 2026). Nothing in the runner ever wrote them, so every Porter PR in a repo whose diff touches a
 * form, a money path or anything scheduled could never land, and the card spent its three attempts on the same stop.
 *
 * THE DESIGN. Before landing, the runner asks land itself what the PR lacks (`land --check <pr>`, read-only). The
 * builder answers in one short turn with those lines (it holds the plan, the diff and the preview), THIS module
 * checks their shape and writes them into the PR body, and land --check is read again. Land stays the authority on
 * what is required: nothing here keeps its own list of when a line is due.
 *
 * WHAT IS REFUSED (NAMED STOPS, so a LAND never retries a stop no turn can clear):
 *   LAND_LINES_MISSING     a line land asked for is absent, keeps its template placeholder, or has no reason.
 *   LAND_NEEDS_REVIEWER    land wants a fresh reviewer's PASS (a review class, a first launch): the builder never
 *                          signs its own review, so the runner stops by name for a person instead of retrying.
 *   PR_BODY_UNREAD / PR_BODY_NOT_WRITTEN   as in pr-self-review.mjs.
 * Structure only: whether a reason is honest is the reviewer's call, never a keyword's.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** land's description codes the builder writes a line for → the key in `land_lines` and the line's prefix. */
export const LAND_LINE_FOR = {
  REVIEW_CLASS_UNDECLARED: { key: "review_class", prefix: "Review class:" },
  FORMS_UNDECLARED: { key: "forms", prefix: "Forms:" },
  OUTCOME_UNDECLARED: { key: "outcome", prefix: "Outcome:" },
  OUTCOME_CHECK_NOT_READ_ONLY: { key: "outcome", prefix: "Outcome:" },
  PATCH_OR_REBUILD_MISSING: { key: "patch_or_rebuild", prefix: "Patch or rebuild:" },
  NOT_CLICKED_THROUGH: { key: "clicked_through", prefix: "Clicked through:" },
  NOT_BUILT_UNDECLARED: { key: "not_built", prefix: null },
};
/** Codes only a fresh reviewer (never the builder) can clear. */
export const REVIEWER_CODES = new Set(["REVIEW_PASS_MISSING", "REVIEW_REQUIRED", "STALE_PASS", "LAUNCH_PASS_MISSING"]);
export const NOT_BUILT_HEADING = "## Not built";
const MIN_REASON_WORDS = 3;
const MAX_LINE = 600;
const MAX_BODY = 65_000;

const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const words = (s) => (s ? s.split(" ").length : 0);

/**
 * What `land --check` printed → `{ codes: [{ code, why }], add }` with every numbered problem, in order. Pure.
 * Its list reads `  1. [CODE] why` with `       add: <line>` under each (land's problems_print).
 */
export function parseLandCheck(output) {
  const codes = [];
  for (const line of String(output ?? "").split("\n")) {
    const m = line.match(/^\s*\d+\.\s+\[([A-Z_]+)\]\s*(.*)$/);
    if (m) codes.push({ code: m[1], why: m[2].trim() });
  }
  return { codes };
}

/** The codes split by who can clear them. Pure. */
export function sortCodes(codes) {
  const builder = [];
  const reviewer = [];
  const other = [];
  for (const c of codes) {
    if (LAND_LINE_FOR[c.code]) builder.push(c);
    else if (REVIEWER_CODES.has(c.code)) reviewer.push(c);
    else other.push(c);
  }
  return { builder, reviewer, other };
}

/** Null when `lines` carries every line the codes ask for, in land's form; otherwise what is wrong. Pure. */
export function landLinesProblem(lines, codes) {
  const l = lines && typeof lines === "object" && !Array.isArray(lines) ? lines : {};
  const keys = [...new Set(codes.map((c) => LAND_LINE_FOR[c.code]?.key).filter(Boolean))];
  for (const key of keys) {
    const spec = Object.values(LAND_LINE_FOR).find((s) => s.key === key);
    if (key === "not_built") {
      const items = Array.isArray(l.not_built) ? l.not_built.map(text).filter(Boolean) : [];
      if (!items.length) return 'land_lines.not_built is missing: each item from the plan or his words this PR does not build, word for word, or ["Nothing cut."]';
      if (items.some((i) => /<[^>]+>/.test(i))) return "land_lines.not_built still holds a template placeholder (<...>)";
      continue;
    }
    const line = text(l[key]);
    if (!line) return `land_lines.${key} is missing: land asked for a "${spec.prefix}" line`;
    if (!line.startsWith(spec.prefix)) return `land_lines.${key} must start with "${spec.prefix}"`;
    if (/<[^>]+>/.test(line)) return `land_lines.${key} still holds a template placeholder (<...>)`;
    const reason = line.split(/\s+—\s+/).slice(1).join(" — ");
    if (words(text(reason)) < MIN_REASON_WORDS) return `land_lines.${key} needs " — " and a reason of ${MIN_REASON_WORDS}+ words after it`;
    if (line.length > MAX_LINE) return `land_lines.${key} is over ${MAX_LINE} characters`;
  }
  return null;
}

/** The body with the lines (re)written: earlier copies of the same lines, and an earlier Not built section, go. Pure. */
export function prBodyWithLandLines(body, lines, codes) {
  const problem = landLinesProblem(lines, codes);
  if (problem) return { ok: false, tag: "LAND_LINES_MISSING", why: problem };
  const keys = new Set(codes.map((c) => LAND_LINE_FOR[c.code]?.key).filter(Boolean));
  const prefixes = Object.values(LAND_LINE_FOR).filter((s) => s.prefix && keys.has(s.key)).map((s) => s.prefix);
  const out = [];
  let skipping = false;
  for (const line of String(body ?? "").split("\n")) {
    if (/^#{1,6}\s/.test(line)) skipping = keys.has("not_built") && /^#{1,6}\s*not built\b/i.test(line);
    if (skipping) continue;
    if (prefixes.some((p) => line.trim().startsWith(p))) continue;
    out.push(line);
  }
  const added = [...new Set(Object.values(LAND_LINE_FOR).filter((s) => s.prefix && keys.has(s.key)).map((s) => s.key))].map((k) => text(lines[k]));
  const notBuilt = keys.has("not_built") ? ["", NOT_BUILT_HEADING, ...lines.not_built.map(text).filter(Boolean).map((i) => (i === "Nothing cut." ? i : `- ${i}`))] : [];
  const block = [...(added.length ? ["", ...added] : []), ...notBuilt].join("\n");
  let rest = out.join("\n").trim();
  const room = MAX_BODY - block.length - 80;
  if (rest.length > room) rest = `${rest.slice(0, Math.max(0, room))}\n\n…(cut to fit GitHub's PR body limit)`;
  return { ok: true, body: `${rest}\n${block}\n` };
}

/** Read the PR body, write the lines in, read it back. `run` is spawnSync-shaped and injected (tests drive a fake gh). */
export function writeLandLines({ cwd, number, lines, codes, run }) {
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
  const problem = landLinesProblem(lines, codes);
  if (problem) return { ok: false, tag: "LAND_LINES_MISSING", why: problem };
  const before = read();
  if (before === null) return { ok: false, tag: "PR_BODY_UNREAD", why: `gh could not read PR #${number}'s body, so the lines land asked for were not written` };
  const built = prBodyWithLandLines(before, lines, codes);
  if (!built.ok) return built;
  const dir = mkdtempSync(path.join(tmpdir(), "porter-pr-land-"));
  try {
    const file = path.join(dir, "body.md");
    writeFileSync(file, built.body);
    const edit = run("gh", ["pr", "edit", String(number), "--body-file", file], { cwd });
    if (edit?.status !== 0) return { ok: false, tag: "PR_BODY_NOT_WRITTEN", why: `gh pr edit #${number} failed: ${String(edit?.stderr || edit?.stdout || "").trim().slice(0, 300)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const after = read();
  if (after === null || after.trim() !== built.body.trim()) return { ok: false, tag: "PR_BODY_NOT_WRITTEN", why: `PR #${number}'s body, read back after the edit, does not carry the lines written` };
  return { ok: true, line: `PR #${number}: ${[...new Set(codes.map((c) => c.code))].join(", ")} written into the PR body before landing` };
}

/** The note for the builder's one pre-land turn. Pure. */
export function landLinesNote(checkOutput, linesPath) {
  return [
    "THIS TURN IS BEFORE THE LANDING. The script has NOT run ~/bin/land yet; ignore the Phase LAND steps below for this turn.",
    "Do not edit the worktree, commit or push. `land --check` says the PR's description lacks the lines below. Read the plan, the partner's words, the PR's diff (`gh pr diff`) and the preview, then write ONE JSON object to:",
    `  ${linesPath}`,
    '  { "status": "ok", "land_lines": { "review_class": "Review class: …", "forms": "Forms: …", "outcome": "Outcome: …", "patch_or_rebuild": "Patch or rebuild: …", "clicked_through": "Clicked through: …", "not_built": ["<each item not built, word for word>"] or ["Nothing cut."] }, "pre_land": "<each thing the partner asked to be checked BEFORE the deploy, and what you saw on the preview; or: nothing asked before the deploy>" }',
    "Only the keys land asked for are needed. Each line is in the one form land prints after `add:`, with every <placeholder> filled and a real reason after \" — \".",
    "- Review class: name the class honestly. A class (money, private-data, delete, store, launch, outreach) waits on a fresh reviewer, and that is correct: never write none to avoid one.",
    "- Forms: a touched form needs a marked TEST submission on the PREVIEW now (name it TEST) and what received it; never a real customer.",
    "- Outcome: one public read (gh api / curl of a public URL, per the template) that proves the change on the live site the next day.",
    "- If the partner asked for something to be confirmed before the deploy, check it on the preview now and say what you saw in pre_land. If it is not right, write { \"status\": \"failed\", \"reason\": \"<what is wrong>\" } and nothing lands.",
    "WHAT land --check PRINTED:",
    "```",
    String(checkOutput ?? "").slice(-6000),
    "```",
  ].join("\n");
}
