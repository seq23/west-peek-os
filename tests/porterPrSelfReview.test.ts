import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MUTATION_HEADING, SELF_REVIEW_CHECKS, SELF_REVIEW_HEADING, selfReviewProblem, withSelfReviewFixed, writeSelfReview } from "../scripts/lib/pr-self-review.mjs";

/**
 * PORTER'S PR CARRIES ITS SELF-REVIEW AND MUTATION PROOF (23 Nov 2026; topbarz-voting #21 failed its review for
 * lacking them). The runner writes both sections into the PR body from the BUILD result, and refuses by name when
 * either is missing or empty, or when gh cannot read or write the body. `gh` is a fake that keeps the PR's body.
 */
function fakeGh(body: string | null, opts: { editFails?: boolean; editIgnored?: boolean } = {}) {
  const state = { body, edits: 0 };
  const run = (cmd: string, args: string[]) => {
    expect(cmd).toBe("gh");
    if (args[1] === "view") return state.body === null ? { status: 1, stdout: "", stderr: "HTTP 502" } : { status: 0, stdout: JSON.stringify({ body: state.body }) };
    if (args[1] === "edit") {
      state.edits += 1;
      if (opts.editFails) return { status: 1, stderr: "GraphQL: Could not resolve to a PullRequest" };
      if (!opts.editIgnored) state.body = readFileSync(String(args[args.indexOf("--body-file") + 1]), "utf8");
      return { status: 0, stdout: "" };
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { state, run };
}

const review = () => SELF_REVIEW_CHECKS.map((c) => ({ check: c.key, found: `checked ${c.name} on the preview at 390px and found nothing broken` }));
const good = () => ({
  phase: "BUILD",
  status: "ok",
  self_review: review(),
  mutation_proof: [
    { fix: "vote button | keeps one vote", mutation: "removed the one-vote check in vote.js", test: "first-run (second vote accepted)\nline two", went_red: true },
    { fix: "button label colour", covered_by: 1 },
  ],
});
const write = (body: string | null, result: unknown, opts = {}) => {
  const gh = fakeGh(body, opts);
  return { out: writeSelfReview({ cwd: "/tmp", number: 21, result, run: gh.run }), gh };
};
const count = (s: string, h: string) => s.split("\n").filter((l) => l.trim() === h).length;

describe("Porter's PR body carries its self-review and mutation proof", () => {
  it("writes both sections at the end of the PR's own body, one row per cause and per fix, and rewrites them on the next push", () => {
    const { out, gh } = write("Rebuilds the vote page.\n\n## Self-review\nold line\n\n## Mutation proof\n| old |\n\n## Proof\nscreens at 390px", good());
    expect(out.ok).toBe(true);
    const body = gh.state.body as string;
    expect(body).toContain("Rebuilds the vote page.");
    expect(body).toContain("screens at 390px");
    expect(body).not.toContain("old line");
    expect(count(body, SELF_REVIEW_HEADING)).toBe(1);
    expect(count(body, MUTATION_HEADING)).toBe(1);
    const reviewLines = String(String(body.split(SELF_REVIEW_HEADING)[1]).split(MUTATION_HEADING)[0]).split("\n").filter((l) => /^\d+\. /.test(l));
    expect(reviewLines).toHaveLength(SELF_REVIEW_CHECKS.length);
    const table = String(body.split(MUTATION_HEADING)[1]).split("\n").filter((l) => l.startsWith("|"));
    // header + separator + two rows; a pipe or newline in the model's text never splits a row
    expect(table).toHaveLength(4);
    expect(table.every((l) => l.split(/(?<!\\)\|/).length === 6)).toBe(true);

    // the next push writes them again: still one of each
    const again = writeSelfReview({ cwd: "/tmp", number: 21, result: good(), run: gh.run });
    expect(again.ok).toBe(true);
    expect(count(gh.state.body as string, SELF_REVIEW_HEADING)).toBe(1);
    expect(count(gh.state.body as string, MUTATION_HEADING)).toBe(1);

    // a body past GitHub's 65,536-character limit is cut, never the two sections
    const huge = write("x".repeat(80_000), good());
    expect(huge.out.ok).toBe(true);
    expect((huge.gh.state.body as string).length).toBeLessThanOrEqual(65_536);
    expect(count(huge.gh.state.body as string, MUTATION_HEADING)).toBe(1);
  });

  it("refuses by name, and leaves the PR body untouched, when either section is missing or has no real content", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["no self-review", { ...good(), self_review: undefined }],
      ["no mutation proof", { ...good(), mutation_proof: undefined }],
      ["an empty mutation proof", { ...good(), mutation_proof: [] }],
      ["a cause left out", { ...good(), self_review: review().slice(1) }],
      ["a cause twice", { ...good(), self_review: [...review(), review()[0]] }],
      ["a one-word line", { ...good(), self_review: review().map((r, i) => (i === 3 ? { ...r, found: "fine" } : r)) }],
      ["the same line under every cause", { ...good(), self_review: review().map((r) => ({ ...r, found: "all good, nothing found here" })) }],
      ["a mutation row naming no test", { ...good(), mutation_proof: [{ fix: "one vote", mutation: "removed the check", test: "", went_red: true }] }],
      ["a test that stayed green", { ...good(), mutation_proof: [{ fix: "one vote", mutation: "removed the check", test: "first-run", went_red: false }] }],
      ["covered by a row that does not exist", { ...good(), mutation_proof: [{ fix: "label", covered_by: 1 }] }],
      ["a none with no reason", { ...good(), mutation_proof: { none: "copy only" } }],
    ];
    for (const [name, result] of bad) {
      const { out, gh } = write("Rebuilds the vote page.", result);
      expect(out.ok, name).toBe(false);
      expect(out.ok ? "" : out.tag, name).toBe("SELF_REVIEW_MISSING");
      expect(gh.state.edits, name).toBe(0);
    }
    // a reasoned none is accepted, as land accepts it
    expect(write("x", { ...good(), mutation_proof: { none: "copy only: two words on the about page change, no behaviour" } }).out.ok).toBe(true);
  });

  it("an unreadable body, a refused edit, or an edit that did not take is a named stop, never a pass", () => {
    const unread = write(null, good());
    expect(unread.out).toMatchObject({ ok: false, tag: "PR_BODY_UNREAD" });
    expect(unread.gh.state.edits).toBe(0);
    // last round's sections are still on the PR: a refused edit must not pass on them
    const stale = `body\n\n${SELF_REVIEW_HEADING}\nlast round\n\n${MUTATION_HEADING}\n| last round |`;
    expect(write(stale, good(), { editFails: true }).out).toMatchObject({ ok: false, tag: "PR_BODY_NOT_WRITTEN" });
    expect(write("body", good(), { editIgnored: true }).out).toMatchObject({ ok: false, tag: "PR_BODY_NOT_WRITTEN" });
  });

  it("the BUILD runner writes them after reading the PR and before watching its checks, and stops when they are refused", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "duties", "web-property-change.mjs"), "utf8");
    const build = src.slice(src.indexOf('if (phase === "BUILD") {'));
    const at = (needle: string) => build.indexOf(needle);
    expect(at("writeSelfReview(")).toBeGreaterThan(at("pr = await prFor("));
    expect(at("writeSelfReview(")).toBeLessThan(at("await watchChecks("));
    expect(build).toMatch(/if \(!selfReview\.ok\) return \{ phase, status: "failed"/);
  });
});

/*
 * 28 Nov 2026, wc_9f7312e4: a 48-minute build with its PR open was failed for "mutation_proof row 3 does not say the
 * mutation made". The builder gets ONE turn to write the sections again; the gate itself is unchanged.
 */
describe("a refused self-review gets one turn to be written again, never a finished build thrown away", () => {
  const thin = () => ({ ...good(), pr_url: "https://github.com/seq23/join-west-peek-main/pull/44", items: [{ item: "homepage", state: "done" }], mutation_proof: [...good().mutation_proof.slice(0, 1), { fix: "tiles", test: "validate:community-site", went_red: true }] });

  it("asks once with the refusal and its own result; takes only the two sections, and only when they now pass", async () => {
    const notes: string[] = [];
    const first = thin();
    expect(selfReviewProblem(first)).toMatch(/row 2 does not say the mutation made/);
    const out = await withSelfReviewFixed(first, async (note) => {
      notes.push(note);
      return { ...good(), pr_url: "https://evil.example/pull/1", items: [] };
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/DO NOT EDIT THE WORKTREE/);
    expect(notes[0]).toMatch(/row 2 does not say the mutation made/);
    expect(notes[0]).toContain('"pr_url":"https://github.com/seq23/join-west-peek-main/pull/44"');
    expect(selfReviewProblem(out.result)).toBeNull();
    expect(out.result.pr_url, "nothing but the two sections is taken from the second turn").toBe("https://github.com/seq23/join-west-peek-main/pull/44");
    expect(out.result.items).toEqual([{ item: "homepage", state: "done" }]);
    expect(out.line).toMatch(/wrote it again in one turn and it passes/);
    // And the writer then passes it.
    expect(write("body", out.result).out.ok).toBe(true);
  });

  it("a second turn that is still refused, writes nothing, or throws leaves the original result, which the gate refuses by name", async () => {
    for (const askAgain of [async () => thin(), async () => null, async () => { throw new Error("model out"); }]) {
      let calls = 0;
      const out = await withSelfReviewFixed(thin(), async () => { calls += 1; return askAgain(); });
      expect(calls).toBe(1);
      expect(selfReviewProblem(out.result)).toMatch(/row 2/);
      expect(out.line).toMatch(/did not fix it/);
      const w = write("body", out.result).out;
      expect(w.ok).toBe(false);
      expect(!w.ok && w.tag).toBe("SELF_REVIEW_MISSING");
    }
  });

  it("a result that already passes asks nothing", async () => {
    let calls = 0;
    const out = await withSelfReviewFixed(good(), async () => { calls += 1; return null; });
    expect(calls).toBe(0);
    expect(out.line).toBeNull();
  });

  it("the BUILD runner gives that turn before the gate, and the gate still stops a refused result", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "duties", "web-property-change.mjs"), "utf8");
    const build = src.slice(src.indexOf('if (phase === "BUILD") {'));
    expect(build.indexOf("await withSelfReviewFixed(")).toBeGreaterThan(build.indexOf("pr = await prFor("));
    expect(build.indexOf("await withSelfReviewFixed(")).toBeLessThan(build.indexOf("writeSelfReview("));
    expect(build).toMatch(/if \(!selfReview\.ok\) return \{ phase, status: "failed"/);
  });
});
