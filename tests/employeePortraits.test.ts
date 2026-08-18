import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { AI_EMPLOYEE_ROSTER } from "@shared/registry/aiEmployees";
import { portraitAlt, portraitFor } from "../src/client/lib/employeePortraits";

/**
 * The manifest and the committed files are two lists that must not drift apart. Either kind of
 * drift is silent in the browser — a name in the manifest with no file renders a broken image
 * until onError hides it, and a file with no manifest entry is dead weight shipped in every build.
 */
const DIR = new URL("../src/client/public/employees/", import.meta.url).pathname;
const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).map((f) => f.replace(/\.jpg$/, ""));

describe("employee portraits", () => {
  it("gives every roster employee a portrait", () => {
    const missing = AI_EMPLOYEE_ROSTER.filter((e) => !portraitFor(e.name)).map((e) => e.name);
    expect(missing).toEqual([]);
  });

  it("resolves every manifest entry to a file that exists", () => {
    const unresolved = AI_EMPLOYEE_ROSTER
      .map((e) => ({ name: e.name, file: portraitFor(e.name)!.split("/").pop()!.replace(/\.jpg$/, "") }))
      .filter((x) => !onDisk.includes(x.file));
    expect(unresolved).toEqual([]);
  });

  it("ships no portrait that no employee claims", () => {
    const claimed = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name.toLowerCase()));
    expect(onDisk.filter((f) => !claimed.has(f))).toEqual([]);
  });

  it("names the portrait as AI-generated in its alt text", () => {
    // A reader who cannot see the image must still learn it is not a photograph of a real person.
    expect(portraitAlt("Walter", "Meeting Buddy")).toContain("AI-generated");
    expect(portraitAlt("Walter", "Meeting Buddy")).not.toMatch(/photo(graph)? of/i);
  });
});
