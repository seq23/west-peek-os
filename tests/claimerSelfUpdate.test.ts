import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error — a plain .mjs script with no type declarations.
import { pullMainIfClean } from "../scripts/claimer/local-job-claimer.mjs";

/**
 * THE CLAIMER'S CHECKOUT KEEPS ITSELF CURRENT (23 Sep 2026), against REAL git repositories.
 *
 * `land` from a worktree never moved ~/GitHub/west-peek-os, so the launchd claimer ran old code
 * until someone pulled by hand. When idle it now fast-forwards a clean checkout (returning it to
 * main first when it is on another branch, #355), and leaves a dirty or diverged one exactly as it
 * was, as a named stop the heartbeat carries.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let root: string;
let origin: string;
let author: string;

function cloneAt(name: string): string {
  const dir = path.join(root, name);
  execFileSync("git", ["clone", "--quiet", origin, dir]);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}

function landOnOrigin(msg: string): string {
  writeFileSync(path.join(author, `${msg}.txt`), msg);
  git(author, "add", ".");
  git(author, "commit", "--quiet", "-m", msg);
  git(author, "push", "--quiet", "origin", "main");
  return git(author, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "claimer-pull-"));
  origin = path.join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  author = path.join(root, "author");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", author]);
  git(author, "config", "user.email", "t@t");
  git(author, "config", "user.name", "t");
  git(author, "remote", "add", "origin", origin);
  landOnOrigin("first");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("pullMainIfClean", () => {
  it("fast-forwards a clean main that is behind origin, and does nothing when current", () => {
    const co = cloneAt("clean");
    const tip = landOnOrigin("second");
    const lines: string[] = [];
    expect(pullMainIfClean(co, undefined, (l: string) => lines.push(l))).toEqual({ updated: true, reason: "fast_forwarded" });
    expect(git(co, "rev-parse", "HEAD")).toBe(tip);
    expect(pullMainIfClean(co, undefined, () => {})).toEqual({ updated: false, reason: "current" });
  });

  it("never touches a dirty checkout, and says so once", () => {
    const co = cloneAt("dirty");
    const before = git(co, "rev-parse", "HEAD");
    landOnOrigin("third");
    writeFileSync(path.join(co, "first.txt"), "edited");
    const lines: string[] = [];
    expect(pullMainIfClean(co, undefined, (l: string) => lines.push(l))).toEqual({ updated: false, reason: "dirty", stuck: "dirty" });
    pullMainIfClean(co, undefined, (l: string) => lines.push(l));
    expect(git(co, "rev-parse", "HEAD")).toBe(before);
    expect(lines.filter((l) => /uncommitted/.test(l))).toHaveLength(1);
  });

  // #355 (13 Nov 2026): the checkout sat on a merged side branch for two weeks and "not updating it"
  // was one line in a log. Off main and clean now goes back to main; the branch keeps its commits.
  it("returns a clean checkout on another branch to main and fast-forwards it; the side branch keeps its commits", () => {
    const branch = cloneAt("branch");
    git(branch, "checkout", "--quiet", "-b", "fix/x");
    writeFileSync(path.join(branch, "side.txt"), "side work");
    git(branch, "add", ".");
    git(branch, "commit", "--quiet", "-m", "side work");
    const side = git(branch, "rev-parse", "HEAD");
    const tip = landOnOrigin("fourth");
    const out = pullMainIfClean(branch, undefined, () => {});
    expect(out).toEqual({ updated: true, reason: "fast_forwarded" });
    expect(git(branch, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(branch, "rev-parse", "HEAD")).toBe(tip);
    expect(git(branch, "rev-parse", "fix/x"), "nothing on the side branch is lost").toBe(side);
  });

  it("a dirty side branch, or a main that has diverged, is left exactly as it was and comes back as a named stop", () => {
    const dirtySide = cloneAt("dirty-side");
    git(dirtySide, "checkout", "--quiet", "-b", "fix/y");
    writeFileSync(path.join(dirtySide, "first.txt"), "edited");
    const s0 = git(dirtySide, "rev-parse", "HEAD");
    landOnOrigin("fifth");
    expect(pullMainIfClean(dirtySide, undefined, () => {})).toEqual({ updated: false, reason: "dirty", stuck: "dirty" });
    expect(git(dirtySide, "rev-parse", "--abbrev-ref", "HEAD")).toBe("fix/y");
    expect(git(dirtySide, "rev-parse", "HEAD")).toBe(s0);

    const div = cloneAt("diverged");
    writeFileSync(path.join(div, "local.txt"), "mine");
    git(div, "add", ".");
    git(div, "commit", "--quiet", "-m", "local only");
    const d0 = git(div, "rev-parse", "HEAD");
    landOnOrigin("sixth");
    expect(pullMainIfClean(div, undefined, () => {})).toEqual({ updated: false, reason: "diverged", stuck: "diverged" });
    expect(git(div, "rev-parse", "HEAD")).toBe(d0);
  });
});
