import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error — a plain .mjs duty script
import { ensureWorktree } from "../scripts/duties/web-property-change.mjs";

/** 19 Nov 2026 (wc_59ef2d40): a job re-targeted to another repo found its worktree folder still the old repo's checkout. */
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
function repo(root: string, name: string): string {
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const clone = path.join(root, name);
  execFileSync("git", ["clone", "-q", bare, clone], { stdio: "pipe" });
  g(clone, "config", "user.email", "t@t"); g(clone, "config", "user.name", "t");
  writeFileSync(path.join(clone, `${name}.txt`), name);
  g(clone, "add", "."); g(clone, "commit", "-q", "-m", "init"); g(clone, "push", "-q", "origin", "HEAD:main");
  return clone;
}

describe("a job's worktree is always a checkout of the repo it builds", () => {
  it("a clean checkout of another repo is replaced; one with work in it is a named stop", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wt-other-"));
    const topbarz = repo(root, "topbarz");
    const main = repo(root, "jwpm");
    const names = { branch: "work/wpc-test", worktree: path.join(root, "jobs", "wt-test") };
    await ensureWorktree(topbarz, names, "PLAN", () => {});
    expect(existsSync(path.join(names.worktree, "topbarz.txt"))).toBe(true);
    await ensureWorktree(main, names, "BUILD", () => {});
    expect(existsSync(path.join(names.worktree, "jwpm.txt")), "now the new repo's checkout").toBe(true);
    expect(existsSync(path.join(names.worktree, "topbarz.txt"))).toBe(false);

    const held = { branch: "work/wpc-held", worktree: path.join(root, "jobs", "wt-held") };
    await ensureWorktree(topbarz, held, "PLAN", () => {});
    writeFileSync(path.join(held.worktree, "work.txt"), "unsaved");
    await expect(ensureWorktree(main, held, "BUILD", () => {})).rejects.toThrow(/WORKTREE_OF_ANOTHER_REPO/);
    expect(existsSync(path.join(held.worktree, "work.txt")), "work is never thrown away").toBe(true);
  });
});
