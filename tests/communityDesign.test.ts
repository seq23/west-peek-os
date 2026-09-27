import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TYPE_WORDS, typeWord } from "../src/shared/community/typeWords";

/**
 * The Community page's two design guarantees, pinned after 27 Sep 2026.
 *
 * 1. A machine's key never reaches the screen. The biggest tile read `general_tech_adjacent`
 *    because the dictionary was a closed list and Network OS's vocabulary is not.
 * 2. Where the people live is said ONCE, first, as a band with a button — not as one of three
 *    grey notices the reader skims past.
 */

const PAGE = readFileSync(new URL("../src/client/pages/CommunityPage.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

describe("person_type words", () => {
  it("knows the categories Network OS documents, and the one it actually stores", () => {
    for (const key of ["investor", "founder", "operator", "lawyer", "service_provider", "media", "general", "general_tech_adjacent", "unknown"]) {
      expect(TYPE_WORDS[key], key).toBeTruthy();
    }
    expect(typeWord("general_tech_adjacent")).toBe("Tech-adjacent");
  });

  it("never shows a key's underscores, even one it has never seen", () => {
    for (const key of ["angel_syndicate_lead", "SOME_NEW_KIND", "board-member", "x"]) {
      const word = typeWord(key);
      expect(word).not.toMatch(/[_]/);
      expect(word.charAt(0)).toBe(word.charAt(0).toUpperCase());
    }
    expect(typeWord("angel_syndicate_lead")).toBe("Angel syndicate lead");
    expect(typeWord("")).toBe(TYPE_WORDS.unknown);
  });

  it("is what the page uses — no private dictionary can drift from it", () => {
    expect(PAGE).toContain('from "@shared/community/typeWords"');
    expect(PAGE).toContain("typeWord(s.key)");
    expect(PAGE).not.toMatch(/TYPE_WORDS\[/);
  });
});

describe("the Network OS boundary", () => {
  it("is said once, first, as a band with a button", () => {
    const band = PAGE.indexOf('data-testid="community-network-os"');
    const population = PAGE.indexOf("<PopulationPanel />");
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(population);
    expect(PAGE).toMatch(/<aside className="boundary-band" data-testid="community-network-os">/);
    // The link is a real button in the accent, not an underlined phrase mid-sentence.
    expect(PAGE).toMatch(/className="btn-primary"\s+href="https:\/\/network\.joinwestpeek\.com"/);
    // The second grey notice that repeated the same fact is gone.
    expect(PAGE).not.toContain('data-testid="community-scope"');
    expect(PAGE.match(/className="notice"/g) ?? []).toHaveLength(1); // the save-error message only
  });

  it("wears the accent and the tiles carry a meter", () => {
    expect(CSS).toMatch(/\.boundary-band \{[^}]*border-left: 4px solid var\(--wp-orange\)/s);
    expect(CSS).toMatch(/\.cohort-meter-fill \{[^}]*var\(--wp-orange\)/s);
    expect(PAGE).toContain('className="cohort-meter-fill"');
  });
});
