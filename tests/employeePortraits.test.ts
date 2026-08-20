import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  it("gives every working employee a portrait", () => {
    const missing = AI_EMPLOYEE_ROSTER.filter((e) => !portraitFor(e.name)).map((e) => e.name);
    expect(missing).toEqual([]);
  });

  it("keeps a face for the retired too, so bringing one back does not produce a stranger", () => {
    // The lounge can now un-retire somebody. Before all thirty-one portraits were committed, an
    // employee returning arrived with a grey initial on the page whose entire job is making the
    // workforce feel like people.
    for (const retired of ["Paige", "Priya", "Prue", "Wendy", "Willa", "Wilson", "Winnie", "Winton", "Wynn", "Penn", "Perry", "Perrin"]) {
      expect(portraitFor(retired), `${retired} has no face to come back to`).toBeTruthy();
    }
  });

  it("resolves a name regardless of how it is cased", () => {
    expect(portraitFor("WYATT")).toBe(portraitFor("Wyatt"));
    expect(portraitFor(" Wyatt ")).toBe(portraitFor("Wyatt"));
  });

  it("resolves every manifest entry to a file that exists", () => {
    const unresolved = AI_EMPLOYEE_ROSTER
      .filter((e) => portraitFor(e.name))
      .map((e) => ({ name: e.name, file: portraitFor(e.name)!.split("/").pop()!.replace(/\.jpg$/, "") }))
      .filter((x) => !onDisk.includes(x.file));
    expect(unresolved).toEqual([]);
  });

  it("ships no portrait belonging to nobody at all", () => {
    // The roster is now a SUBSET of what is committed — a face with no current employee is a
    // retired seat, which is the point. What must not exist is a file for somebody the firm has
    // never employed, which is dead weight in every build.
    const everEmployed = new Set([
      ...AI_EMPLOYEE_ROSTER.map((e) => e.name.toLowerCase()),
      "paige", "penn", "perrin", "perry", "priya", "prue",
      "wendy", "willa", "wilson", "winnie", "winton", "wynn",
    ]);
    expect(onDisk.filter((f) => !everEmployed.has(f))).toEqual([]);
  });

  it("names the portrait as AI-generated in its alt text", () => {
    // A reader who cannot see the image must still learn it is not a photograph of a real person.
    expect(portraitAlt("Walter", "Meeting Buddy")).toContain("AI-generated");
    expect(portraitAlt("Walter", "Meeting Buddy")).not.toMatch(/photo(graph)? of/i);
  });
});
