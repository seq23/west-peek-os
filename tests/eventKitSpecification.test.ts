import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVENT_KIT_PLATFORM,
  EVENT_KIT_SECTIONS,
  GREENROOM_MINUTES_BEFORE,
  ON_SCREEN_SHAPES,
  RETIRED_PLATFORMS,
  STREAM_SLOT,
  buildEventKitPrompt,
  eventKitTldr,
  openItemsFor,
  parseEventKit,
  proposedSlotFor,
  renderEventKitMarkdown,
  verifyEventKit,
  type EventKitSource,
} from "../src/shared/events/eventKit";

/**
 * THE SPECIFICATION IS THE THING THE GENERATOR OBEYS, NOT A DOCUMENT BESIDE IT.
 *
 * `docs/EVENT_KIT_SPECIFICATION.md` is written from the kit that was actually sent to Scooter for
 * the September livestream (`docs/EVENT_KIT_EXAMPLE_SEPTEMBER.md`, kept verbatim): five named
 * sections in order, the closed On Screen vocabulary, the four retired platforms, the computed
 * proposed slot with its greenroom, and the three things that are marked open rather than invented.
 *
 * So this suite READS BOTH DOCUMENTS and compares them with the code. Add a section to the spec
 * without adding it to `EVENT_KIT_SECTIONS` and the build fails; rename a key in the code and the
 * build fails; drop a retired platform from the spec's strike list and the build fails. Neither can
 * drift quietly, which is the only durable version of "the code follows the spec".
 *
 * RULE 0: every test here counts what it examined and fails on zero. A regex that silently matched
 * nothing in a reformatted document would otherwise report the specification as satisfied by
 * examining none of it — precisely the defect class this repo keeps finding.
 */

const SPEC = readFileSync(new URL("../docs/EVENT_KIT_SPECIFICATION.md", import.meta.url), "utf8");
const EXAMPLE = readFileSync(new URL("../docs/EVENT_KIT_EXAMPLE_SEPTEMBER.md", import.meta.url), "utf8");

/** The `| n | Section | `key` |` table in the spec, in the order the rows are written. */
function specSections(): Array<{ n: number; label: string; key: string }> {
  const rows: Array<{ n: number; label: string; key: string }> = [];
  for (const m of SPEC.matchAll(/^\|\s*(\d)\s*\|\s*([^|]+?)\s*\|\s*`([a-z_]+)`\s*\|$/gm)) {
    rows.push({ n: Number(m[1]), label: m[2]!.trim(), key: m[3]! });
  }
  return rows;
}

/** Everything in a fixed-width code span under one named heading of the spec. */
function backticked(heading: string): string[] {
  const start = SPEC.indexOf(heading);
  if (start < 0) return [];
  const rest = SPEC.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return Array.from((end < 0 ? rest : rest.slice(0, end)).matchAll(/`([^`]+)`/g)).map((m) => m[1]!);
}

const src = (over: Partial<EventKitSource> = {}): EventKitSource => ({
  stream: "WORKSHOP",
  month: "2026-11",
  topic: "Community",
  angleTitle: "Community as a Service",
  whyThisAngle: "It is the angle a founder can act on the same week.",
  promise: "Leave with the first month of a community plan, written.",
  whoItsFor: "founders and brand owners with an audience and no community",
  hostName: "Scooter Taylor",
  coHostName: "Sequoia Taylor",
  guestWanted: false,
  guestName: null,
  runOfShow: [
    { time: "6:00 PM", minutes: 5, what: "Welcome", who: "Scooter" },
    { time: "6:05 PM", minutes: 40, what: "The working session", who: "Scooter + Sequoia" },
    { time: "6:45 PM", minutes: 15, what: "Wrap", who: "both" },
  ],
  totalMinutes: 60,
  ...over,
});

const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    event_title: "Community as a Service: build the first month, live",
    format: "Live working session (teach + build)",
    description: {
      title: "Community as a Service: build the first month, live",
      hook: "Most brands have an audience and call it a community. In sixty minutes you will write the first month of a real one.",
      parts: [
        { label: "Part 1: What a community actually is", minutes: 15, detail: "The difference between an audience and a community, in one worked example." },
        { label: "Part 2: Build your first month", minutes: 30, detail: "You write the four weeks, live, and we pressure-test two of them on air." },
        { label: "Part 3: Questions", minutes: 15, detail: "Bring the one you are stuck on." },
      ],
      who_its_for: "founders and brand owners with an audience and no community",
      audience_tip: "Join from a desktop with a blank doc open so you can write alongside us.",
    },
    run_of_show: [
      { time: "5:45 PM ET", segment: "Greenroom check-in", description: "Audio and video test, lower thirds, screen share rehearsed.", on_screen: { shape: "BACKSTAGE", who: "Scooter Taylor + Sequoia Taylor" } },
      { time: "6:00 PM ET", segment: "Intro & welcome", description: "Sets the sixty-minute agenda.", on_screen: { shape: "SOLO", who: "Scooter Taylor" } },
      { time: "6:05 PM ET", segment: "The working session", description: "The four weeks, written live.", on_screen: { shape: "SCREEN SHARE", who: "Scooter Taylor sharing the template" } },
      { time: "6:45 PM ET", segment: "Wrap-up and call to action", description: "Takeaways and where to send the plan.", on_screen: { shape: "3-UP", who: "Scooter Taylor + Sequoia Taylor + co-host" } },
    ],
    discussion_guide: {
      opening_script: "Welcome in. Sixty minutes, and you leave with a month of community written — not a framework, the actual weeks.",
      questions: [
        { n: 1, theme: "The distinction", question: "What is the first thing that turns an audience into a community?" },
        { n: 2, theme: "The first month", question: "What goes in week one that you cannot skip?" },
        { n: 3, theme: "The failure mode", question: "Where do brands usually lose it by week six?" },
      ],
    },
    social_posts: [
      { kind: "ANNOUNCE", voice: "West Peek", body: "Sixty minutes. You leave with the first month of your community, written.", hashtags: ["#WestPeek", "#Community"] },
      { kind: "SPEAKER", voice: "Scooter Taylor", body: "I am going live to build a community plan with you, in an hour.", hashtags: ["#WestPeek"] },
    ],
    ...over,
  });

const built = (overSrc: Partial<EventKitSource> = {}, overAnswer: Record<string, unknown> = {}) => {
  const s = src(overSrc);
  const slot = proposedSlotFor(s.month, s.stream);
  const open = openItemsFor({ coHostName: s.coHostName, guestWanted: s.guestWanted, guestName: s.guestName });
  const parsed = parseEventKit(answer(overAnswer), s, slot, open);
  expect(parsed, "the reference answer did not parse at all").toBeTruthy();
  return verifyEventKit(parsed!, s);
};

describe("the specification and the generator say the same thing", () => {
  it("names five sections, and the code carries exactly those, in that order", () => {
    const rows = specSections();
    expect(rows.length, "Rule 0: no section rows were read out of the specification — has the table been reformatted?").toBe(5);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.key)).toEqual(EVENT_KIT_SECTIONS.map((s) => s.key));
    expect(rows.map((r) => r.label)).toEqual(EVENT_KIT_SECTIONS.map((s) => s.label));
  });

  it("renders every section the specification names, numbered in its order", () => {
    const md = renderEventKitMarkdown(built());
    const rows = specSections();
    expect(rows.length, "Rule 0: no sections examined").toBeGreaterThan(0);
    for (const r of rows) expect(md, `the kit never renders the section "${r.label}"`).toContain(`## ${r.n}. ${r.label}`);
  });

  it("strikes every retired platform the specification lists, by name", () => {
    const named = backticked("### 1 · The platform");
    const struck = named.filter((n) => n !== "EVENT_KIT_PLATFORM" && n !== "verifyEventKit" && n !== "retired_platform_removed");
    expect(struck.length, "Rule 0: the specification names no retired platforms").toBe(4);
    expect(struck).toEqual([...RETIRED_PLATFORMS]);
    for (const p of struck) {
      const kit = built({}, { description: { title: "T", hook: `Watch on ${p} or wherever you are.`, parts: [], who_its_for: "x", audience_tip: "" } });
      expect(kit.description.hook, `"${p}" survived into the kit`).not.toContain(p);
      expect(kit.description.hook).toContain(EVENT_KIT_PLATFORM);
      expect(kit.flags.map((f) => f.code)).toContain("retired_platform_removed");
    }
    // The September kit is exactly why the list exists: it named all four.
    for (const p of struck) expect(EXAMPLE, `the example no longer names "${p}" — is this still the kit that shipped?`).toContain(p);
  });

  it("asks the model for every On Screen shape the specification lists, and accepts no other", () => {
    const shapes = backticked("### 4 · The On Screen column").filter((s) => s !== "EventKit" && s !== "on_screen_defaulted");
    expect(shapes.length, "Rule 0: no On Screen shapes were read out of the specification").toBe(5);
    expect(shapes).toEqual([...ON_SCREEN_SHAPES]);
    const s = src();
    const prompt = buildEventKitPrompt(s, proposedSlotFor(s.month, s.stream), openItemsFor({ coHostName: s.coHostName, guestWanted: false, guestName: null }));
    for (const shape of shapes) expect(prompt, `the prompt never mentions the On Screen shape "${shape}"`).toContain(shape);
    // A shape nobody agreed on does not become a blank cell; it is flagged and defaulted.
    const rogue = built({}, {
      run_of_show: [
        { time: "5:45 PM ET", segment: "Greenroom check-in", description: "…", on_screen: { shape: "BACKSTAGE", who: "all" } },
        { time: "6:00 PM ET", segment: "Intro", description: "…", on_screen: { shape: "PICTURE IN PICTURE", who: "" } },
      ],
    });
    expect(rogue.flags.map((f) => f.code)).toContain("on_screen_defaulted");
    expect(rogue.runOfShow[1]!.onScreen.shape).toBe("SOLO");
    expect(rogue.runOfShow.every((r) => (ON_SCREEN_SHAPES as readonly string[]).includes(r.onScreen.shape))).toBe(true);
  });

  it("proposes a real date at the slot the specification publishes, and says PROPOSED", () => {
    const rows = Array.from(SPEC.matchAll(/^\|\s*(Workshop|Room)\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|$/gm)).map((m) => ({ stream: m[1]!.toUpperCase() as "WORKSHOP" | "ROOM", slot: m[2]!.trim(), time: m[3]! }));
    expect(rows.length, "Rule 0: no house slots were read out of the specification").toBe(2);
    for (const r of rows) {
      expect(STREAM_SLOT[r.stream].startEt, `the ${r.stream} slot's time disagrees with the specification`).toBe(r.time);
      const slot = proposedSlotFor("2026-11", r.stream);
      expect(slot.startEt).toBe(r.time);
      expect(r.slot.toLowerCase()).toContain(slot.weekday.toLowerCase());
      expect(slot.label.startsWith("PROPOSED — "), "the slot does not say PROPOSED").toBe(true);
      // A real date: the label's weekday is the date's weekday, not a name beside a number.
      expect(new Date(`${slot.date}T00:00:00Z`).getUTCDay()).toBe(STREAM_SLOT[r.stream].weekday);
      expect(slot.date.startsWith("2026-11")).toBe(true);
    }
    // November 2026: second Thursday is the 12th, third Wednesday is the 18th.
    expect(proposedSlotFor("2026-11", "WORKSHOP").date).toBe("2026-11-12");
    expect(proposedSlotFor("2026-11", "ROOM").date).toBe("2026-11-18");
  });

  it("keeps the greenroom the September kit had, at the interval the specification states", () => {
    const stated = /\*\*(\d+) minutes\*\* before the broadcast/.exec(SPEC);
    expect(stated, "Rule 0: the specification does not state the greenroom interval").toBeTruthy();
    expect(Number(stated![1])).toBe(GREENROOM_MINUTES_BEFORE);
    expect(EXAMPLE, "the example no longer shows a greenroom check-in").toMatch(/Greenroom Check-in/i);
    const slot = proposedSlotFor("2026-11", "WORKSHOP");
    expect(slot.startEt).toBe("6:00 PM ET");
    expect(slot.greenroomEt).toBe("5:45 PM ET");
    // Dropped by the model, put back by the system.
    const dropped = built({}, { run_of_show: [{ time: "6:00 PM ET", segment: "Intro", description: "…", on_screen: { shape: "SOLO", who: "Scooter Taylor" } }] });
    expect(dropped.flags.map((f) => f.code)).toContain("greenroom_inserted");
    expect(dropped.runOfShow[0]!.segment).toMatch(/greenroom/i);
    expect(dropped.runOfShow[0]!.timeEt).toBe("5:45 PM ET");
  });

  it("marks open every kind the specification lists, and never invents one", () => {
    const kinds = Array.from(SPEC.matchAll(/^\|\s*`(CO_HOST|GUEST|JOIN_LINK)`\s*\|/gm)).map((m) => m[1]!);
    expect(kinds.length, "Rule 0: no open kinds were read out of the specification").toBe(3);
    // A packet with a co-host and no guest still has one thing it cannot know: the link.
    const withCoHost = built();
    expect(withCoHost.open.map((o) => o.kind)).toEqual(["JOIN_LINK"]);
    // Nobody named, a guest wanted: all three.
    const bare = built({ coHostName: null, guestWanted: true, guestName: null });
    expect(bare.open.map((o) => o.kind).sort()).toEqual([...kinds].sort());
    for (const o of bare.open) expect(o.label, `"${o.kind}" is marked open without saying so`).toMatch(/^OPEN — /);
    // THE JOIN LINK HAS NO FIELD: there is nothing on the kit a model could put one in.
    expect(Object.keys(bare)).not.toContain("joinLink");
    expect(JSON.stringify(bare)).not.toMatch(/https:\/\/westpeek\.live\/[a-z]/i);
  });

  it("takes a person back out of a seat nobody has been asked to fill", () => {
    const invented = built(
      { coHostName: null },
      {
        run_of_show: [
          { time: "5:45 PM ET", segment: "Greenroom check-in", description: "…", on_screen: { shape: "BACKSTAGE", who: "all" } },
          { time: "6:00 PM ET", segment: "Intro", description: "…", on_screen: { shape: "2-UP", who: "Scooter Taylor + Marcus Whitfield (co-host)" } },
        ],
      },
    );
    expect(invented.flags.map((f) => f.code)).toContain("invented_person_removed");
    // Out of the kit itself — and the seat restored.
    expect(JSON.stringify(invented.runOfShow)).not.toContain("Marcus Whitfield");
    expect(renderEventKitMarkdown({ ...invented, flags: [] })).not.toContain("Marcus Whitfield");
    expect(invented.runOfShow[1]!.onScreen.who).toContain("OPEN — co-host not yet decided");
    // But SAID, on the flag, so a partner reads what Parker had to take back out of his own draft
    // rather than a document that silently disagrees with the one he generated.
    expect(invented.flags.find((f) => f.code === "invented_person_removed")!.detail).toContain("Marcus Whitfield");
  });

  it("refuses a bracket anywhere — the way the September kit shipped one", () => {
    expect(EXAMPLE, "the example no longer carries the bracket this rule exists for").toContain("[Insert Date]");
    const bracketed = built({}, {
      description: { title: "T", hook: "Broadcast [Insert Date] at 6:00 PM ET.", parts: [], who_its_for: "x", audience_tip: "Register at [LINK]" },
    });
    expect(bracketed.flags.filter((f) => f.code === "placeholder_removed").length).toBeGreaterThanOrEqual(2);
    expect(bracketed.description.hook).not.toContain("[Insert Date]");
    expect(bracketed.description.hook).toContain("PROPOSED — ");
    expect(bracketed.description.audienceTip).not.toContain("[LINK]");
    // And nothing in a clean kit carries one either.
    expect(renderEventKitMarkdown(built())).not.toMatch(/\[(?!\d+\])[^\]\n]{0,80}\]\s*(?!\()/);
  });

  it("carries the platform and the delivery rule the specification states, into the prompt and the page", () => {
    const s = src();
    const prompt = buildEventKitPrompt(s, proposedSlotFor(s.month, s.stream), openItemsFor({ coHostName: null, guestWanted: true, guestName: null }));
    expect(prompt).toContain(EVENT_KIT_PLATFORM);
    expect(prompt).toContain("WRITE THE DRAFT PROPOSED EVENT KIT");
    expect(prompt).toMatch(/no \[Insert Date\]|square-\s*\n?\s*bracket placeholders/);
    expect(SPEC.replace(/\s+/g, " "), "the specification lost the sentence the delivery rule comes from").toContain("The email never carries the text");
    // The TL;DR is what the mail carries: title, proposed date and time, duration shape, why.
    const tldr = eventKitTldr(built());
    expect(tldr).toContain("PROPOSED — ");
    expect(tldr).toContain("60 minutes");
    expect(tldr).toContain(EVENT_KIT_PLATFORM);
    expect(tldr).toContain("Why this angle:");
  });
});

describe("a kit that loses what the specification asks for is refused or flagged", () => {
  it("does not parse at all without a run of show — the stage fails rather than storing an empty kit", () => {
    const s = src();
    const slot = proposedSlotFor(s.month, s.stream);
    const open = openItemsFor({ coHostName: s.coHostName, guestWanted: false, guestName: null });
    expect(parseEventKit(answer({ run_of_show: [] }), s, slot, open)).toBeNull();
    expect(parseEventKit("I cannot help with that.", s, slot, open)).toBeNull();
  });

  it("flags a kit that lost its questions or one of its two posts", () => {
    expect(built({}, { discussion_guide: { opening_script: "Welcome in.", questions: [] } }).flags.map((f) => f.code)).toContain("no_questions");
    const oneSided = built({}, { social_posts: [{ kind: "ANNOUNCE", voice: "West Peek", body: "Come along.", hashtags: [] }] });
    expect(oneSided.flags.map((f) => f.code)).toContain("no_social_posts");
    // And the clean kit is not flagged for either — a check that fires on everything proves nothing.
    expect(built().flags.map((f) => f.code)).not.toContain("no_questions");
    expect(built().flags.map((f) => f.code)).not.toContain("no_social_posts");
  });

  it("flags a description whose parts do not add up to the run of show", () => {
    const off = built({}, {
      description: { title: "T", hook: "H", parts: [{ label: "Part 1: all of it", minutes: 180, detail: "…" }], who_its_for: "x", audience_tip: "" },
    });
    expect(off.flags.map((f) => f.code)).toContain("duration_off");
    expect(built().flags.map((f) => f.code)).not.toContain("duration_off");
  });

  it("passes a complete kit clean — nothing corrected, and every section present", () => {
    const kit = built();
    expect(kit.flags, `a compliant kit was flagged: ${kit.flags.map((f) => f.detail).join("; ")}`).toEqual([]);
    expect(kit.runOfShow.length, "Rule 0: the verifier examined no run-of-show rows").toBeGreaterThan(0);
    expect(kit.header.platform).toBe(EVENT_KIT_PLATFORM);
    expect(kit.header.slot.label).toContain("PROPOSED");
    expect(kit.discussionGuide.questions.length).toBe(3);
    expect(kit.socialPosts.map((p) => p.kind).sort()).toEqual(["ANNOUNCE", "SPEAKER"]);
  });

  it("builds the same kit for a Room, from the Room's own slot", () => {
    const kit = built({ stream: "ROOM", month: "2026-11", topic: "Black lawyers", angleTitle: "The Scaled Boardroom", coHostName: null, guestWanted: true });
    expect(kit.header.slot.date).toBe("2026-11-18");
    expect(kit.header.slot.startEt).toBe("6:30 PM ET");
    expect(kit.open.map((o) => o.kind).sort()).toEqual(["CO_HOST", "GUEST", "JOIN_LINK"]);
    expect(renderEventKitMarkdown(kit)).toContain("## 3. Run of show");
  });
});
