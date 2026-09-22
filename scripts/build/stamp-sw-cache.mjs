#!/usr/bin/env node
/**
 * Runs after `vite build` (see `npm run build`). Ties the service worker's cache name to this
 * build's own hashed assets, so a deploy can never leave yesterday's shell cached under an
 * unchanged key. See `src/client/public/sw.js` and `swCacheStamp.mjs` for why.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeBuildId, stampServiceWorker } from "./swCacheStamp.mjs";

const distClient = fileURLToPath(new URL("../../dist/client", import.meta.url));
const assetsDir = `${distClient}/assets`;
const swPath = `${distClient}/sw.js`;

if (!existsSync(assetsDir)) {
  throw new Error(`stamp-sw-cache: no built assets at ${assetsDir} — run "vite build" first`);
}
if (!existsSync(swPath)) {
  throw new Error(`stamp-sw-cache: no ${swPath} — is sw.js still in src/client/public?`);
}

const assetNames = readdirSync(assetsDir);
const buildId = computeBuildId(assetNames);
const stamped = stampServiceWorker(readFileSync(swPath, "utf8"), buildId);
writeFileSync(swPath, stamped);

// eslint-disable-next-line no-console
console.log(`sw.js cache keyed to build ${buildId} (${assetNames.length} asset${assetNames.length === 1 ? "" : "s"})`);
