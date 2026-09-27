import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TYPE_WORDS, typeWord } from "../src/shared/community/typeWords";

import { communityGuide } from "../src/shared/help/pageGuide/community";
import { stripTsComments } from "../scripts/validate/lib/strip-comments.mjs";

/**
 * The Community page's three design guarantees, pinned after 27 Sep 2026.
 *
 * 1. A machine's key never reaches the screen. The biggest tile read `general_tech_adjacent`
 *    because the dictionary was a closed list and Network OS's vocabulary is not.
 * 2. Where the people live is said ONCE, first, as a band with a button — not as one of three
 *    grey notices the reader skims past.
 * 3. ONE ROSTER. The page carried an "Add or update a member" form, a "Members" list and a
 *    "Who is in the room" mix, all on a LOCAL table Network OS never saw — beside a header that
 *    said a local roster was wrong. None of it may come back, on the page or in its guide; the
 *    only door for someone new is Capture, which proposes them to Network OS. Introductions is
 *    retired from this page too (whether it belongs in Network OS is decided later).
 */

const PAGE = readFileSync(new URL("../src/client/pages/CommunityPage.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
/** The page as code: its comments may tell the history of the roster; its markup may not carry one. */
const CODE = stripTsComments(PAGE);

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
    // The second grey notice that repeated the same fact is gone — and with the member form gone,
    // so is the last grey notice on the page.
    expect(PAGE).not.toContain('data-testid="community-scope"');
    expect(PAGE.match(/className="notice"/g) ?? []).toHaveLength(0);
    // The band also carries the one door for someone new: Capture, which proposes them to Network OS.
    const capture = PAGE.indexOf('data-testid="community-capture-link"');
    expect(capture).toBeGreaterThan(band);
    expect(capture).toBeLessThan(population);
    expect(PAGE).toMatch(/className="link-button"\s+href="#\/capture"\s+data-testid="community-capture-link"/);
    expect(PAGE).toContain("proposes them to Network OS");
    // …and it is the ONLY orange button: one `btn-primary`, and the Capture door is not a second.
    expect(PAGE.match(/className="btn-primary"/g) ?? []).toHaveLength(1);
  });

  it("wears the accent and the tiles carry a meter", () => {
    expect(CSS).toMatch(/\.boundary-band \{[^}]*border-left: 4px solid var\(--wp-orange\)/s);
    expect(CSS).toMatch(/\.cohort-meter-fill \{[^}]*var\(--wp-orange\)/s);
    expect(PAGE).toContain('className="cohort-meter-fill"');
  });
});

describe("one roster: nothing on the page adds a member, and nothing on the page is Introductions", () => {
  const ROSTER_TESTIDS = ["community-form", "community-name", "community-save", "community-list", "community-counts", "community-empty", "community-mix", "community-mix-bars"];

  it("carries no member form, no members list and no mix", () => {
    for (const id of ROSTER_TESTIDS) expect(CODE, id).not.toContain(`data-testid="${id}"`);
    for (const text of ["Add or update a member", "Who is in the room", "Save member", "MEMBER_KINDS", "typeFilter", "mix-bars", "com_member"]) {
      expect(CODE, text).not.toContain(text);
    }
    // The local table's routes stay for the gathering and council code; the PAGE never calls them.
    expect(CODE).not.toContain("/api/community/members");
    // With no form there is nothing to post: the page reads, and only reads.
    expect(CODE).not.toMatch(/\bapi</);
    expect(CODE).not.toMatch(/method:\s*"POST"/);
  });

  it("no longer embeds Introductions", () => {
    expect(CODE).not.toContain("IntroductionsPage");
    expect(CODE).not.toContain("<IntroductionsPage");
    for (const id of ["run-matching", "signal-body", "add-signal", "signal-person"]) expect(CODE, id).not.toContain(id);
  });

  it("its guide lists none of them either, and lists the Capture door", () => {
    const testids = [...communityGuide.bands.map((b) => b.testid), ...communityGuide.acts.map((a) => a.testid)].filter(Boolean);
    for (const id of [...ROSTER_TESTIDS, "run-matching", "signal-body", "add-signal", "approve-match-", "connected-"]) {
      expect(testids, id).not.toContain(id);
    }
    const names = [...communityGuide.bands.map((b) => b.name), ...communityGuide.acts.map((a) => a.label), ...communityGuide.youCan];
    for (const name of ["Add or update a member", "Members", "Who is in the room", "Save member", "Introductions", "What we know about people", "Note it"]) {
      expect(names, name).not.toContain(name);
    }
    expect(JSON.stringify(communityGuide)).not.toMatch(/member form|add a member|Note it|Look for matches/i);
    expect(communityGuide.acts.map((a) => a.testid)).toContain("community-capture-link");
    expect(communityGuide.sources).toEqual(["src/client/pages/CommunityPage.tsx"]);
    // Every testid the guide names is on the page — the guide describes what is there, not what was.
    for (const id of testids) expect(CODE, id).toContain(`data-testid="${id}"`);
  });

  it("the orphaned mix styles left with the mix", () => {
    for (const cls of [".mix-bars", ".mix-row", ".mix-fill"]) expect(CSS, cls).not.toContain(`${cls} `);
    expect(CSS).toMatch(/\.boundary-band-copy \{/);
  });
});
