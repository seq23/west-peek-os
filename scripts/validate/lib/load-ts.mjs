/**
 * Import a TypeScript module from a validator, WITH its relative imports.
 *
 * Node runs a `.ts` file natively but resolves a bare `./sibling` import as JavaScript only, so a
 * shared module that imports another shared module cannot be loaded by `import()` alone. esbuild
 * (already a dependency, through vite) bundles the entry and its imports into one ESM file in the
 * temp directory, which is then imported. No emit into the repo; the file is removed on exit.
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function loadTs(entry) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wpos-validate-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, `${path.basename(entry, ".ts")}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", target: "node20", outfile, logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}
