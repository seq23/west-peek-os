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
 * until someone pulled by hand. When idle it now fast-forwards a clean main checkout, and leaves a
 * dirty, non-main or diverged one exactly as it was.
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
    expect(pullMainIfClean(co, undefined, (l: string) => lines.push(l)).reason).toBe("dirty");
    pullMainIfClean(co, undefined, (l: string) => lines.push(l));
    expect(git(co, "rev-parse", "HEAD")).toBe(before);
    expect(lines.filter((l) => /uncommitted/.test(l))).toHaveLength(1);
  });

  it("never touches a checkout on another branch, or one that has diverged", () => {
    const branch = cloneAt("branch");
    git(branch, "checkout", "--quiet", "-b", "fix/x");
    const b0 = git(branch, "rev-parse", "HEAD");
    landOnOrigin("fourth");
    expect(pullMainIfClean(branch, undefined, () => {}).reason).toBe("not_main");
    expect(git(branch, "rev-parse", "HEAD")).toBe(b0);

    const div = cloneAt("diverged");
    writeFileSync(path.join(div, "local.txt"), "mine");
    git(div, "add", ".");
    git(div, "commit", "--quiet", "-m", "local only");
    const d0 = git(div, "rev-parse", "HEAD");
    landOnOrigin("fifth");
    expect(pullMainIfClean(div, undefined, () => {}).reason).toBe("diverged");
    expect(git(div, "rev-parse", "HEAD")).toBe(d0);
  });
});
