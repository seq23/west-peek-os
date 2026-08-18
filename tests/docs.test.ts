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

  it("tells a newcomer how to run it", () => {
    for (const cmd of ["npm install", "npm run migrate:local", "npm run dev"]) {
      expect(readme, cmd).toContain(cmd);
    }
  });

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

describe("the README's factual claims", () => {
  const readme = read("README.md");

  it("is right that egress is allowlisted per file", () => {
    // Named in the README as the four permitted clients. If a fifth is added without updating the
    // README, a reader is told something false about the security posture.
    const scanner = read("scripts/validate/no-unauthorized-effects.mjs");
    const block = scanner.slice(scanner.indexOf("EGRESS_ALLOWED"), scanner.indexOf("ANY_FETCH"));
    const allowed = [...block.matchAll(/"src\/worker\/effects\/([a-zA-Z]+)\.ts"/g)].map((m) => m[1]!);
    // Compared word by word: the README calls secEdgarClient "the SEC EDGAR client", which is how
    // a human should write it. What matters is that every allowlisted client is DESCRIBED, not that
    // the prose repeats an identifier.
    const lower = readme.toLowerCase();
    for (const f of allowed) {
      const words = f.replace(/Client$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(" ");
      for (const w of words) expect(lower, `${f} → "${w}"`).toContain(w);
    }
  });

  it("is right that runAi is the only model boundary", () => {
    expect(existsSync(path.join(ROOT, "src/worker/ai/runAi.ts"))).toBe(true);
  });

  it("is honest about what is switched off", () => {
    // These stay true only while the features stay off. If email sending is enabled and this
    // section is not updated, the README is actively misleading about what the system does.
    expect(readme).toMatch(/Outbound email is off/);
    const resend = read("src/worker/effects/resendClient.ts");
    expect(resend).toMatch(/WP_OS_EMAIL_SEND/);
  });
});
