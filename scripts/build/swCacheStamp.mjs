import { createHash } from "node:crypto";

/**
 * The pure logic behind the sw.js hygiene fix (Wave F, 22 Sep 2026 — plan §6). Split out of
 * `stamp-sw-cache.mjs` so it can be unit tested (`tests/swCacheStamp.test.ts`) without a real Vite
 * build — the file I/O is a thin wrapper around these two functions.
 */

/**
 * A deterministic id for one build, from the names of the assets Vite produced (already
 * hash-named per file by Vite itself — this just folds the whole set into one short id for the
 * service worker's cache name). Order-independent, so it does not change just because a directory
 * listing happened to come back in a different order.
 */
export function computeBuildId(assetNames) {
  if (!Array.isArray(assetNames) || assetNames.length === 0) {
    // A build with nothing to hash would mean the cache name never changes between deploys — the
    // exact bug this script exists to prevent. Fail loudly rather than emit a constant id.
    throw new Error("computeBuildId: no built assets given — the cache name would never rotate");
  }
  return createHash("sha256").update(assetNames.slice().sort().join("\n")).digest("hex").slice(0, 12);
}

/** Replace the `__BUILD_ID__` placeholder in the service worker source with the real build id. */
export function stampServiceWorker(source, buildId) {
  if (!source.includes("__BUILD_ID__")) {
    // A sw.js that has drifted (hand-edited back to a literal cache name, or the placeholder
    // renamed) would otherwise silently ship un-stamped — the same "hand-bumped and forgotten"
    // failure this whole change replaces. Refuse rather than ship it quietly.
    throw new Error("stampServiceWorker: sw.js has no __BUILD_ID__ placeholder — refusing to ship an un-keyed cache name");
  }
  return source.replaceAll("__BUILD_ID__", buildId);
}
