import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_GUIDES, pageGuide } from "../src/shared/help/pageGuide";
import { NAV_TITLES, asksHowThePageWorks, renderGuideAnswer, renderGuideMarkdown } from "../src/shared/help/pageGuide/render";
import { parseInlines, parseMarkdown, plainText } from "../src/shared/help/markdownLite";
import { HOSTED_NAV_GROUPS, PAGE_HOSTS } from "../src/shared/help/pageHosts";
import { pagePurpose } from "../src/shared/help/pagePurpose";

/**
 * Every page a person works on has a guide, and the guide is what the host says.
 *
 * Owner, 19 Sep 2026, on asking Walter how Meetings works: "I can't understand anything he said —
 * it's all jumbled … I think he still has the old page instructions." Two defects, two pins:
 *
 *   1. STALE — the description came from prose nothing read against the page. The guides are
 *      held to the page by `validate:page-guides`; this suite holds the REST of the system to the
 *      guides: every hosted page has one, the purpose block derives from it, the nav titles the
 *      worker speaks are App.tsx's, and the retired Meetings trio is gone everywhere.
 *   2. JUMBLED — a paragraph with three bolded phrases. The rendered answer is asserted to be a
 *      numbered band list and bulleted acts with every control in bold, and the parser the client
 *      paints with is asserted to keep that structure.
 */

const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const NAV = [...APP.matchAll(/\{ key: "([a-z0-9-]+)", label: "([^"]+)"/g)].map((m) => ({ key: m[1]!, label: m[2]! }));
const ROUTE_KEYS = [...APP.matchAll(/active === "([a-z0-9-]+)"/g)].map((m) => m[1]!);

function navKeysByGroup(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of APP.split(/group: "/).slice(1)) {
    const group = chunk.slice(0, chunk.indexOf('"'));
    const body = chunk.split(/\n  \},/)[0]!;
    out.set(group, [...body.matchAll(/\{ key: "([a-z0-9-]+)", label: "/g)].map((m) => m[1]!));
  }
  return out;
}
const BY_GROUP = navKeysByGroup();

const RETIRED_MEETINGS_TRIO = ["Prepare for a meeting", "Confer with an AI employee", "Run a close-out"];

describe("which pages have a guide", () => {
  it("reads a real nav out of App.tsx", () => {
    expect(NAV.length).toBeGreaterThan(20);
    expect(BY_GROUP.get("Now")?.length).toBe(3);
  });

  it("every hosted page — Deals, Firm, Learn — has a guide", () => {
    const hosted = HOSTED_NAV_GROUPS.flatMap((g) => BY_GROUP.get(g) ?? []);
    expect(hosted.length).toBeGreaterThan(10);
    expect(hosted.filter((k) => !pageGuide(k))).toEqual([]);
    // And every page that has a host has a guide — a host without a guide answers from memory.
    expect(Object.keys(PAGE_HOSTS).filter((k) => ROUTE_KEYS.includes(k) && NAV.some((n) => n.key === k) && !pageGuide(k))).toEqual([]);
  });

  it("the Now surfaces and the pinned doors have a guide", () => {
    for (const k of [...(BY_GROUP.get("Now") ?? []), "home", "intent", "capture"]) expect(pageGuide(k), k).toBeDefined();
  });

  it("no guide describes a page that no longer exists", () => {
    expect(Object.keys(PAGE_GUIDES).filter((k) => !ROUTE_KEYS.includes(k))).toEqual([]);
    for (const [k, g] of Object.entries(PAGE_GUIDES)) expect(g.navKey, k).toBe(k);
  });

  it("the titles the worker speaks are the nav's own labels", () => {
    for (const n of NAV) expect(NAV_TITLES[n.key], n.key).toBe(n.label);
    for (const g of Object.values(PAGE_GUIDES)) expect(g.title).toBe(NAV_TITLES[g.navKey]);
  });

  it("the purpose block at the top of a guided page is the guide's, not a second copy", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      const p = pagePurpose(g.navKey);
      expect(p?.purpose, g.navKey).toBe(g.purpose);
      expect(p?.youCan, g.navKey).toEqual(g.youCan);
    }
  });
});

describe("how a guide is written", () => {
  it("says what the page is for in one or two sentences, and two to four things you can do", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      expect(g.purpose.length, g.navKey).toBeGreaterThan(40);
      expect(g.purpose.length, g.navKey).toBeLessThan(260);
      expect(g.youCan.length, g.navKey).toBeGreaterThanOrEqual(2);
      expect(g.youCan.length, g.navKey).toBeLessThanOrEqual(4);
    }
  });

  it("names its bands and acts in one line each, in a person's words", () => {
    const jargon = /\b(payload|schema|endpoint|CRUD|idempoten|foreign key|migration|D1|JSON|API|testid)\b/i;
    for (const g of Object.values(PAGE_GUIDES)) {
      expect(g.bands.length, g.navKey).toBeGreaterThan(0);
      expect(g.acts.length, g.navKey).toBeGreaterThan(0);
      for (const b of g.bands) {
        expect(b.shows.length, `${g.navKey}: ${b.name}`).toBeLessThan(220);
        expect(jargon.test(`${b.name} ${b.shows}`), `${g.navKey}: ${b.name}`).toBe(false);
      }
      for (const a of g.acts) {
        expect(a.does.length, `${g.navKey}: ${a.label}`).toBeLessThan(220);
        expect(jargon.test(`${a.does} ${a.then ?? ""}`), `${g.navKey}: ${a.label}`).toBe(false);
      }
    }
  });

  it("never carries the Meetings page as it was before 19 Sep 2026", () => {
    const all = JSON.stringify(PAGE_GUIDES);
    for (const phrase of RETIRED_MEETINGS_TRIO) expect(all).not.toContain(phrase);
  });

  it("Meetings describes the three faces, the room, the Meet band and the one approval", () => {
    const m = pageGuide("meetings")!;
    const bands = m.bands.map((b) => b.name);
    for (const face of ["Coming up", "On the record", "Start a meeting now", "Google Meet", "Before", "During", "After"]) expect(bands).toContain(face);
    const acts = m.acts.map((a) => a.label);
    for (const label of ["Open the room", "They said yes — record", "Ask", "Seat", "Approve — make these the record", "Move it"]) expect(acts).toContain(label);
    expect(m.elsewhere.map((l) => l.page)).toContain("dealflow");
  });
});

describe("what the host says when asked how the page works", () => {
  it("is a one-line purpose, numbered bands, bulleted acts with every control in bold — never a paragraph", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      const md = renderGuideAnswer(g);
      const blocks = parseMarkdown(md);
      expect(blocks[0]?.kind, g.navKey).toBe("paragraph");
      expect(plainText([blocks[0]!]), g.navKey).toMatch(/^This is how .+ works, top to bottom\.$/);

      const ordered = blocks.filter((b) => b.kind === "ordered");
      expect(ordered.length, g.navKey).toBe(1);
      expect(ordered[0]!.kind === "ordered" && ordered[0]!.items.length, g.navKey).toBe(g.bands.length);

      const bulleted = blocks.filter((b) => b.kind === "bulleted");
      expect(bulleted.length, g.navKey).toBeGreaterThanOrEqual(1);
      const actItems = bulleted[0]!.kind === "bulleted" ? bulleted[0]!.items : [];
      expect(actItems.length, g.navKey).toBe(g.acts.length);
      for (const a of g.acts) expect(md, `${g.navKey}: ${a.label}`).toContain(`**${a.label}**`);
      // The human act is spoken first.
      const first = g.acts.find((a) => a.primary);
      if (first) expect(actItems[0]![0]?.kind === "strong" && actItems[0]![0]!.text, g.navKey).toBe(first.label);

      for (const b of blocks) {
        if (b.kind === "paragraph") expect(plainText([b]).length, `${g.navKey} paragraph`).toBeLessThan(300);
      }
      expect(md.split("\n").some((l) => l.length > 300), g.navKey).toBe(false);
      // No question back to the reader.
      expect(md.trimEnd().endsWith("?")).toBe(false);
    }
  });

  it("the Help tab renders the same guide text as the host, minus the opener", () => {
    for (const g of Object.values(PAGE_GUIDES)) expect(renderGuideAnswer(g)).toContain(renderGuideMarkdown(g));
  });
});

describe("recognising the question", () => {
  it("hears the ways a partner asks how a page works", () => {
    for (const q of [
      "how does this page work",
      "How does this page work now?",
      "how does this work",
      "what is this page for",
      "what can I do here?",
      "explain this page to me",
      "walk me through the page",
      "what do all the buttons do",
      "Walter, how does this tab work?",
      "I think you still have the old page instructions",
    ]) {
      expect(asksHowThePageWorks(q), q).toBe(true);
    }
  });

  it("leaves a question about the firm's data or one control to the host", () => {
    for (const q of [
      "what does Move it do",
      "which of these is worth a second cheque?",
      "why is this deal stalled",
      "how long has Psyflo been in diligence",
      "what does a soft commitment mean here?",
    ]) {
      expect(asksHowThePageWorks(q), q).toBe(false);
    }
  });
});

describe("the little Markdown the client paints", () => {
  it("keeps a heading a heading, a list a list, and bold bold", () => {
    const blocks = parseMarkdown("**Meetings.** One record.\n\n## What you see\n1. **Coming up** — soonest first\n2. **On the record** — newest first\n\n## What you can do\n- **Open the room** — opens it\n- **Ask** — asks");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "heading", "ordered", "heading", "bulleted"]);
    expect(blocks[2]!.kind === "ordered" && blocks[2]!.items.length).toBe(2);
    expect(blocks[4]!.kind === "bulleted" && blocks[4]!.items[1]![0]).toEqual({ kind: "strong", text: "Ask" });
  });

  it("does not turn a paragraph that mentions a number into a list, and leaves unbalanced stars alone", () => {
    expect(parseMarkdown("Seven days at New. 14 in Screening.").map((b) => b.kind)).toEqual(["paragraph"]);
    expect(parseInlines("2 ** 3 is eight")).toEqual([{ kind: "text", text: "2 ** 3 is eight" }]);
  });

  it("runs plain lines together and breaks on a blank line", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks.length).toBe(2);
    expect(plainText(blocks)).toBe("one two\nthree");
  });
});
