import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Documentation that stays true (P48).
 *
 * Docs rot silently — a broken link or a renamed script is invisible until a new developer hits it
 * on their first morning. These assertions are cheap and catch exactly that: every link resolves,
 * every command exists, and the README's claims about the codebase still hold.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("the README exists and orients", () => {
  const readme = read("README.md");

  it("names every command it recommends", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    const used = new Set([...readme.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((s) => !scripts[s])).toEqual([]);
  });

  it("links only to documents that exist", () => {
    const links = [...readme.matchAll(/\]\(([^)h][^)]*\.md)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(5);
    expect(links.filter((l) => !existsSync(path.join(ROOT, l)))).toEqual([]);
  });

  it("points at files that are really there", () => {
    const paths = [...readme.matchAll(/`(src\/[a-zA-Z0-9/._-]+\.ts)`/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(2);
    expect(paths.filter((p) => !existsSync(path.join(ROOT, p)))).toEqual([]);
  });
});

describe("the docs index", () => {
  it("links only to documents that exist", () => {
    const index = read("docs/README.md");
    const links = [...index.matchAll(/\]\(([^)h][^)]*\.md)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(10);
    expect(links.filter((l) => !existsSync(path.join(ROOT, "docs", l)))).toEqual([]);
  });
});
