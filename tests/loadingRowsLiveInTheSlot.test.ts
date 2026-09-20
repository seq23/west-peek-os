import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A LIST THAT IS STILL READING SAYS SO IN ITS OWN SLOT — NEVER BESIDE AN EMPTY <ul>.
 *
 * Main went red on 20 Sep 2026 (`d1-design-states`, "Set up → setup-jobs"): while its three fetches
 * were in flight, Set up drew an empty `<ul class="card-list">` with "Reading the roster…" as a
 * `<p>` next to it. A reader saw a blank list; the sweep said so. The design rule is older than the
 * page — loading and empty share ONE slot, told apart by tone — and the Employees lists took this
 * exact shape on 18 Sep for this exact reason.
 *
 * This reads the client source rather than rendering it, because the defect is a shape in the
 * markup: a `data-testid="X-loading"` paragraph followed by the `card-list` named `X`. Hard-fails
 * when it finds no card lists at all, so a moved directory cannot pass by examining nothing.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

const CLIENT = join(__dirname, "..", "src", "client");

describe("loading rows live inside the list they describe", () => {
  const files = tsxFiles(CLIENT).map((f) => [f, readFileSync(f, "utf8")] as const);
  const lists = files.reduce((n, [, s]) => n + (s.match(/className="card-list"/g)?.length ?? 0), 0);

  it("examines real card lists", () => {
    expect(lists).toBeGreaterThan(10);
  });

  it("no '-loading' paragraph stands beside the empty card list it is meant to explain", () => {
    const offenders: string[] = [];
    for (const [file, source] of files) {
      for (const m of source.matchAll(/<p[^>]*data-testid="([\w-]+)-loading"[^>]*>/g)) {
        const base = m[1]!;
        const after = source.slice(m.index! + m[0].length, m.index! + m[0].length + 1200);
        const listNamedBase = new RegExp(`<(ul|ol)[^>]*className="card-list"[^>]*data-testid="${base}"`);
        if (listNamedBase.test(after)) offenders.push(`${file.replace(CLIENT, "src/client")} → ${base}`);
      }
    }
    expect(offenders, "draw these as <li className=\"state-message\"> inside the list instead").toEqual([]);
  });

  it("the Set up jobs list carries its own loading row (the 20 Sep regression)", () => {
    const setup = files.find(([f]) => f.endsWith("SetupPage.tsx"))?.[1];
    expect(setup, "SetupPage.tsx moved; point this pin at it").toBeTruthy();
    const list = /<ul className="card-list" data-testid="setup-jobs"[^>]*>([\s\S]*?)<\/ul>/.exec(setup!);
    expect(list, "the setup-jobs list is gone").toBeTruthy();
    expect(list![1]).toMatch(/<li className="state-message" data-testid="setup-jobs-loading">/);
  });
});
