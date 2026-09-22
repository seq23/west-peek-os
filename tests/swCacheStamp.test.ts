import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeBuildId, stampServiceWorker } from "../scripts/build/swCacheStamp.mjs";

/**
 * THE SW.JS HYGIENE FIX (Wave F, 22 Sep 2026 — plan §6). `sw.js` cached every non-API GET
 * cache-first with no revalidation and evicted only when the hardcoded `CACHE` constant was bumped
 * BY HAND — so a deploy that changed every hashed asset could still leave the old shell served from
 * an unchanged cache key. `scripts/build/stamp-sw-cache.mjs` (run from `npm run build`) replaces the
 * `__BUILD_ID__` placeholder in `src/client/public/sw.js` with a hash of that build's own asset
 * filenames, so `activate`'s existing "delete every cache key that isn't this one" logic actually
 * has something to act on every time the bundle changes.
 */
describe("computeBuildId", () => {
  it("changes when the set of built assets changes", () => {
    const a = computeBuildId(["index-abc123.js", "index-def456.css"]);
    const b = computeBuildId(["index-xyz999.js", "index-def456.css"]);
    expect(a).not.toBe(b);
  });

  it("is the same id for the same assets regardless of listing order", () => {
    const a = computeBuildId(["b.js", "a.css"]);
    const b = computeBuildId(["a.css", "b.js"]);
    expect(a).toBe(b);
  });

  it("refuses an empty build — a cache name that never changes is exactly the bug this exists to fix", () => {
    expect(() => computeBuildId([])).toThrow(/no built assets/);
  });
});

describe("stampServiceWorker", () => {
  it("replaces every occurrence of the placeholder with the real build id", () => {
    const source = 'const CACHE = "wpos-shell-__BUILD_ID__"; // __BUILD_ID__ again';
    const stamped = stampServiceWorker(source, "deadbeef1234");
    expect(stamped).toBe('const CACHE = "wpos-shell-deadbeef1234"; // deadbeef1234 again');
  });

  it("refuses to stamp a source with no placeholder — a hand-edited or drifted sw.js must not ship silently un-keyed", () => {
    expect(() => stampServiceWorker('const CACHE = "wpos-shell-v2";', "deadbeef1234")).toThrow(/no __BUILD_ID__ placeholder/);
  });

  it("stamps the real sw.js source shipped in this repo", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/client/public/sw.js", import.meta.url)), "utf8");
    expect(source, "sw.js has drifted from the __BUILD_ID__ contract this build step depends on").toContain("__BUILD_ID__");

    const stamped = stampServiceWorker(source, "0e1d66673c4b");
    expect(stamped).toContain('const CACHE = "wpos-shell-0e1d66673c4b";');
    expect(stamped).not.toContain("__BUILD_ID__");

    // Everything else about the worker — the /api/* skip, the SHELL list, the activate cleanup —
    // is untouched. This is a one-line hygiene fix, not a rewrite.
    expect(stamped).toContain('if (url.pathname.startsWith("/api/")) return;');
    expect(stamped).toContain("keys.filter((k) => k !== CACHE)");
  });
});
