import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TYPE_WORDS, typeWord } from "../src/shared/community/typeWords";
import {
  OTHER_COLOR,
  RECENCY_WORDS,
  UNPLACED_KEYS,
  VIZ_SLOTS,
  WARMTH_ORDER,
  heroCounts,
  placedSlices,
  warmCount,
  warmthSlices,
  type PopulationSlice,
} from "../src/shared/community/populationShape";

import { communityGuide } from "../src/shared/help/pageGuide/community";
import { hasFirstAndLastName } from "../src/shared/community/personName";
import { stripTsComments } from "../scripts/validate/lib/strip-comments.mjs";

/**
 * The Community page's design guarantees, pinned after 27 Sep 2026.
 *
 * 1. A machine's key never reaches the screen. The biggest tile read `general_tech_adjacent`
 *    because the dictionary was a closed list and Network OS's vocabulary is not.
 * 2. Where the people live is said ONCE, first, as a band with two doors — not as one of three
 *    grey notices the reader skims past, and not with the Capture door buried in a sentence.
 * 3. ONE ROSTER. The page carried an "Add or update a member" form, a "Members" list and a
 *    "Who is in the room" mix, all on a LOCAL table Network OS never saw — beside a header that
 *    said a local roster was wrong. None of it may come back, on the page or in its guide; the
 *    only door for someone new is Capture, which sends them to Network OS's review queue.
 *    Introductions is retired from this page too (whether it belongs in Network OS is decided later).
 * 4. THE CHART PASS ("hero row + two rings"). Every category the endpoint can return reaches a
 *    legend row or the tech-adjacent line — nothing is silently dropped, and nothing unplaced
 *    is drawn as if the firm had placed it. The page hosts the ONE ring twice and draws nothing.
 * 5. NEWEST. The last 25 names are a read-only window with no per-row link, and the kind wears
 *    the same dictionary as everything else.
 */

const PAGE = readFileSync(new URL("../src/client/pages/CommunityPage.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
/** The page as code: its comments may tell the history of the roster; its markup may not carry one. */
const CODE = stripTsComments(PAGE);

/** The community as it stood on 27 Sep 2026 — the shape the pass was designed against. */
const LIVE_BY_TYPE: PopulationSlice[] = [
  { key: "general_tech_adjacent", count: 4571, pct: 97 },
  { key: "media", count: 43, pct: 0.9 },
  { key: "founder", count: 42, pct: 0.9 },
  { key: "operator", count: 28, pct: 0.6 },
  { key: "service_provider", count: 18, pct: 0.4 },
  { key: "investor", count: 6, pct: 0.1 },
  { key: "lawyer", count: 4, pct: 0.1 },
];
const LIVE_RECENCY: PopulationSlice[] = [{ key: "never", count: 4712, pct: 100 }];
const LIVE_DEAL_FLOW: PopulationSlice[] = [
  { key: "unknown", count: 4711, pct: 100 },
  { key: "yes", count: 1, pct: 0 },
];

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
    // The ring slices are labelled through the same dictionary, in the shape module.
    const shape = readFileSync(new URL("../src/shared/community/populationShape.ts", import.meta.url), "utf8");
    expect(shape).toContain('from "./typeWords"');
    expect(shape).not.toMatch(/TYPE_WORDS\[/);
  });
});

describe("the Network OS boundary", () => {
  it("is said once, first, as a band with two doors", () => {
    const band = PAGE.indexOf('data-testid="community-network-os"');
    const population = PAGE.indexOf("<PopulationPanel />");
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(population);
    expect(PAGE).toMatch(/<aside className="boundary-band" data-testid="community-network-os">/);
    // ONE paragraph, and it names the Capture tab as an option (operator, 27 Sep 2026: "it says
    // nothing about the capture tab as an option").
    const copy = CODE.slice(CODE.indexOf('className="boundary-band-copy"'), CODE.indexOf('className="boundary-band-doors"'));
    expect(copy.match(/className="boundary-band-text"/g) ?? []).toHaveLength(1);
    expect(copy).toContain("The people live in Network OS.");
    expect(copy).toContain("Capture them here");
    expect(copy).toContain("review queue");
    // The second grey notice that repeated the same fact is gone — and with the member form gone,
    // so is the last grey notice on the page.
    expect(PAGE).not.toContain('data-testid="community-scope"');
    expect(PAGE.match(/className="notice"/g) ?? []).toHaveLength(0);
    // TWO DOORS, in a flex group, Capture first: the ink button, then the one orange button.
    const doors = CODE.indexOf('className="boundary-band-doors"');
    const capture = CODE.indexOf('data-testid="community-capture-link"');
    const network = CODE.indexOf('data-testid="community-network-os-link"');
    expect(doors).toBeGreaterThan(band);
    expect(capture).toBeGreaterThan(doors);
    expect(network).toBeGreaterThan(capture);
    expect(network).toBeLessThan(population);
    expect(CODE).toMatch(/className="btn-strong"\s+href="#\/capture"\s+data-testid="community-capture-link"/);
    expect(CODE).toMatch(/className="btn-primary"\s+href="https:\/\/network\.joinwestpeek\.com"/);
    // …and Network OS is the ONLY orange button: one `btn-primary`; Capture is not a second, and
    // the in-sentence link-button is gone.
    expect(CODE.match(/className="btn-primary"/g) ?? []).toHaveLength(1);
    expect(CODE).not.toContain('className="link-button"');
  });

  it("wears the accent, the doors have a rule, and the tiles carry no meter", () => {
    expect(CSS).toMatch(/\.boundary-band \{[^}]*border-left: 4px solid var\(--wp-orange\)/s);
    expect(CSS).toMatch(/\.boundary-band-doors \{[^}]*display: flex/s);
    // The seven meter tiles are gone from the page AND their rules from the stylesheet: their
    // numbers live in the hero row, the ring legends and the tech-adjacent line now.
    expect(CODE).not.toContain("cohort-meter");
    expect(CODE).not.toContain("cohort-metered");
    expect(CSS).not.toContain(".cohort-meter");
    expect(CSS).toMatch(/\.cohort-hero \.cohort-count \{[^}]*var\(--wp-orange-deep\)/s);
  });
});

describe("the chart pass: hero row + two rings", () => {
  it("places the top four kinds in the fixed colour slots and folds the rest into one Other", () => {
    const { slices, placed, unplaced } = placedSlices(LIVE_BY_TYPE);
    expect(slices.map((s) => s.key)).toEqual(["media", "founder", "operator", "service_provider", "other"]);
    expect(slices.slice(0, 4).map((s) => s.color)).toEqual([...VIZ_SLOTS]);
    expect(VIZ_SLOTS).toHaveLength(4);
    const other = slices[4]!;
    expect(other.color).toBe(OTHER_COLOR);
    expect(other.usd).toBe(10);
    expect(other.note).toContain("investors 6 · lawyers 4");
    expect(other.note).toContain("0.2% of everyone");
    // Notes carry the share of the WHOLE community, not of the placed.
    expect(slices[0]!.note).toBe("0.9% of everyone");
    expect(placed).toBe(141);
    expect(unplaced).toEqual([{ key: "general_tech_adjacent", count: 4571, pct: 97 }]);
    // No label is a key.
    for (const s of slices) expect(s.label).not.toMatch(/_/);
  });

  it("draws no Other when four or fewer kinds are placed, and never draws the unplaced", () => {
    const four = placedSlices(LIVE_BY_TYPE.filter((s) => !["investor", "lawyer"].includes(s.key)));
    expect(four.slices.map((s) => s.key)).not.toContain("other");
    expect(four.slices).toHaveLength(4);
    for (const key of UNPLACED_KEYS) {
      const out = placedSlices([{ key, count: 100, pct: 50 }, { key: "founder", count: 100, pct: 50 }]);
      expect(out.slices.map((s) => s.key)).toEqual(["founder"]);
      expect(out.placed).toBe(100);
      expect(out.unplaced.map((u) => u.key)).toEqual([key]);
    }
  });

  it("lets every key the endpoint can return reach a legend row or the tech-adjacent line", () => {
    const every: PopulationSlice[] = [
      ...Object.keys(TYPE_WORDS).map((key, i) => ({ key, count: 100 - i, pct: 1 })),
      { key: "angel_syndicate_lead", count: 1, pct: 0.1 },
    ];
    const { slices, unplaced } = placedSlices(every);
    const reached = new Set<string>([...slices.map((s) => s.key), ...unplaced.map((u) => u.key)]);
    const otherNote = slices.find((s) => s.key === "other")?.note ?? "";
    for (const s of every) {
      const inRow = reached.has(s.key);
      const inFold = otherNote.includes(typeWord(s.key).toLowerCase());
      expect(inRow || inFold, `${s.key} reaches the screen`).toBe(true);
    }
    // Still only four hues, however many kinds arrive.
    expect(slices.filter((s) => s.key !== "other")).toHaveLength(4);
  });

  it("orders warmth recent → fading → cold → never, in fixed colours, and warm = recent + fading", () => {
    const { slices, warm, total } = warmthSlices([
      { key: "cold", count: 5, pct: 50 },
      { key: "recent", count: 2, pct: 20 },
      { key: "fading", count: 3, pct: 30 },
    ]);
    expect(slices.map((s) => s.key)).toEqual(WARMTH_ORDER.map((w) => w.key));
    expect(slices.map((s) => s.color)).toEqual(WARMTH_ORDER.map((w) => w.color));
    expect(slices[0]!.color).toBe("var(--viz-1)");
    expect(slices[1]!.color).toBe("var(--viz-3)");
    expect(slices.map((s) => s.usd)).toEqual([2, 3, 5, 0]); // a missing bucket is 0, not absent
    expect(slices.map((s) => s.note)).toEqual(WARMTH_ORDER.map((w) => RECENCY_WORDS[w.key]));
    expect(warm).toBe(5);
    expect(total).toBe(10);
    expect(warmCount([{ key: "recent", count: 2, pct: 20 }, { key: "fading", count: 3, pct: 30 }, { key: "cold", count: 5, pct: 50 }])).toBe(5);
    expect(warmCount([])).toBe(0);
    // Today's truth: nobody warm, and the ring says so rather than faking it.
    const today = warmthSlices(LIVE_RECENCY);
    expect(today.warm).toBe(0);
    expect(today.total).toBe(4712);
  });

  it("derives the four hero numbers once, from the same helpers the rings use", () => {
    expect(heroCounts({ total: 4712, by_type: LIVE_BY_TYPE, deal_flow: LIVE_DEAL_FLOW, touch_recency: LIVE_RECENCY })).toEqual({
      people: 4712,
      placeable: 141,
      warm: 0,
      prospects: 1,
      notAsked: 4711,
    });
  });

  it("hosts the ONE ring twice and draws nothing itself", () => {
    expect(PAGE).toMatch(/import \{ AllocationRing \} from "\.\/AllocationRing"/);
    expect(CODE.match(/<AllocationRing\b/g) ?? []).toHaveLength(2);
    for (const drawing of ["strokeDasharray", "<svg", "<circle", "<path"]) expect(CODE, drawing).not.toContain(drawing);
    // The two hosts, by their test ids, and the hero row before them.
    const hero = CODE.indexOf('data-testid="community-hero"');
    const placedRing = CODE.indexOf('data-testid="community-cohorts"');
    const warmRing = CODE.indexOf('data-testid="community-recency"');
    expect(hero).toBeGreaterThan(0);
    expect(placedRing).toBeGreaterThan(hero);
    expect(warmRing).toBeGreaterThan(placedRing);
    expect(CODE).toContain('testid="community-placed"');
    expect(CODE).toContain('testid="community-warmth"');
    // The one ring shows its total at the centre and offers no second number there, so the warm
    // count lives in the warmth ring's HEADING, next to the title, and the caption says what the
    // centre number counts.
    const warmHead = CODE.slice(warmRing, CODE.indexOf('testid="community-warmth"'));
    expect(warmHead).toContain('data-testid="community-warm-count"');
    expect(warmHead).toMatch(/\{count\(warm\)\} warm of \{count\(warmth\.total\)\}/);
    expect(warmHead).toContain('caption="people"');
    expect(CSS).toMatch(/\.ring-host \.ring-head-count \{/);
    // Counts, never dollars: both hosts pass a count format.
    expect(CODE.match(/format=\{count\}/g) ?? []).toHaveLength(2);
    // The honest line under the placed ring, and the last-read line.
    expect(CODE).toContain("not yet placed — the survey fills this in.");
    expect(CODE).toContain('data-testid="community-source"');
    expect(CODE).toContain("Last read from Network OS");
    expect(PAGE).toContain('from "../lib/dates"');
    // Four hero tiles, each with a meaning line.
    for (const id of ["hero-people", "hero-placeable", "hero-warm", "hero-prospects"]) expect(CODE, id).toContain(`testid="${id}"`);
    expect(CSS).toMatch(/\.community-rings \{[^}]*display: grid/s);
    // EVERY KIND, COUNTED (operator, 28 Sep 2026: the placeable total "needs to be broken out
    // somewhere else on the page"). A list of every kind with its number, after the rings, the
    // tech-adjacent included — no filter on the key, only on a zero count — labelled through the
    // one dictionary.
    const kinds = CODE.indexOf('data-testid="community-kinds"');
    expect(kinds).toBeGreaterThan(warmRing);
    const kindsBlock = CODE.slice(kinds, CODE.indexOf("</section>", kinds));
    expect(kindsBlock).toContain("p.by_type");
    expect(kindsBlock).toContain("typeWord(s.key)");
    expect(kindsBlock).toContain("count(s.count)");
    expect(kindsBlock).not.toMatch(/UNPLACED_KEYS|general_tech_adjacent|isUnplaced/);
    expect(kindsBlock).toContain('data-testid={`kind-${s.key}`}');
    expect(CSS).toMatch(/\.kind-list \{[^}]*display: grid/s);
    expect(CSS).toMatch(/\.kind-count \{[^}]*tabular-nums/s);
    expect(CSS).toMatch(/\.cohort-meaning \{/);
    expect(CSS).toMatch(/\.tech-adjacent-line \{[^}]*var\(--wp-tint\)/s);
  });
});

describe("newest in the community", () => {
  it("is a read-only window of 25 with no per-row link, labelled through the one dictionary", () => {
    const newest = CODE.indexOf('data-testid="community-newest"');
    const population = CODE.indexOf('data-testid="community-population"');
    expect(newest).toBeGreaterThan(population);
    expect(CODE).toContain('"/api/community/newest?limit=25"');
    expect(CODE).toContain("Newest in the community");
    expect(CODE).toContain("the last 25 added in Network OS");
    expect(CODE).toContain('data-testid="community-newest-empty"');
    expect(CODE).toContain('data-testid="community-newest-skipped"');
    // THE SYNC STATE IS SAID (Codex on #207). While a load runs the rows are a prefix of the
    // community, and the subtitle says so from the endpoint's own `loading`; an empty read is
    // three different sentences for three different facts, chosen off `source.last_status`.
    const section = CODE.slice(newest, CODE.indexOf("export function CommunityPage"));
    expect(section).toContain('data-testid="community-newest-partial"');
    expect(section).toContain("read so far");
    expect(section).toContain('data-testid="community-newest-stale"');
    expect(section.match(/last_status/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(section).toContain("Network OS could not be read");
    expect(section).toContain("had nobody to give");
    expect(section).toContain("Nothing has been read from Network OS yet");
    // A NAME AND NOTHING ELSE (operator, 28 Sep 2026): the row draws `full_name` and no company,
    // kind, owner or date, and the meta line is gone from the page and the stylesheet.
    const rows = section.slice(section.indexOf('className="newest-list"'), section.indexOf("</ul>"));
    expect(rows).toContain("c.full_name");
    for (const field of ["c.company", "c.person_type", "c.relationship_owner", "c.created_at", "c.city", "typeWord(", "readableDate("]) {
      expect(rows, field).not.toContain(field);
    }
    expect(section).not.toContain("newest-meta");
    expect(CSS).not.toContain(".newest-meta");
    // No link on a row: Network OS has no per-contact URL. The band's button is the door.
    expect(section).not.toMatch(/<a\b/);
    expect(section).not.toContain("href=");
    expect(CSS).toMatch(/\.newest-row \{/);
    expect(CSS).toMatch(/\.newest-name \{[^}]*font-weight: 600/s);
  });
});

describe("a first and last name", () => {
  it("keeps what the operator's screen showed as people and declines what it showed as not", () => {
    // Verbatim from production, 28 Sep 2026 — Network OS's August import.
    for (const real of ["Alex Junior Rosario Nolasco", "Luna Bian", "Jacob Shulman", "A. Walton", "A.j. Ross", "AJ Streetr", "José Núñez", "Mary-Kate O'Neil"]) {
      expect(hasFirstAndLastName(real), real).toBe(true);
    }
    for (const junk of ["? ?", ". Goosby", ". Kasey", "ACP ?", "@BrandwithDrew Co-Founder", "@ProducedbyRHEA Shannon", "@tayllure Taylor", "*alt email: staylor@spry.vc more than a decade", "A K", "Madonna", "", "   ", null, undefined]) {
      expect(hasFirstAndLastName(junk), String(junk)).toBe(false);
    }
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

  it("its guide lists none of them either, and lists the two doors and the newest band", () => {
    const testids = [...communityGuide.bands.map((b) => b.testid), ...communityGuide.acts.map((a) => a.testid)].filter(Boolean);
    for (const id of [...ROSTER_TESTIDS, "run-matching", "signal-body", "add-signal", "approve-match-", "connected-"]) {
      expect(testids, id).not.toContain(id);
    }
    const names = [...communityGuide.bands.map((b) => b.name), ...communityGuide.acts.map((a) => a.label), ...communityGuide.youCan];
    for (const name of ["Add or update a member", "Members", "Who is in the room", "Save member", "Introductions", "What we know about people", "Note it"]) {
      expect(names, name).not.toContain(name);
    }
    expect(JSON.stringify(communityGuide)).not.toMatch(/member form|add a member|Note it|Look for matches/i);
    expect(communityGuide.acts.map((a) => a.testid)).toEqual(["community-capture-link", "community-network-os-link"]);
    expect(communityGuide.acts.map((a) => a.label)).toEqual(["Capture someone", "Open Network OS ↗"]);
    expect(communityGuide.bands.map((b) => b.testid)).toEqual(["community-network-os", "community-population", "community-newest"]);
    expect(communityGuide.bands[1]!.shows).toMatch(/ring/);
    expect(communityGuide.sources).toEqual(["src/client/pages/CommunityPage.tsx"]);
    // Every testid the guide names is on the page — the guide describes what is there, not what was.
    for (const id of testids) expect(CODE, id).toContain(`data-testid="${id}"`);
    // And the labels the guide gives the doors are the labels the page shows.
    for (const act of communityGuide.acts) expect(CODE, act.label).toContain(act.label);
  });

  it("the orphaned mix styles left with the mix", () => {
    for (const cls of [".mix-bars", ".mix-row", ".mix-fill"]) expect(CSS, cls).not.toContain(`${cls} `);
    expect(CSS).toMatch(/\.boundary-band-copy \{/);
  });
});
