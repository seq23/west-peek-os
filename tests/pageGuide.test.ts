import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_GUIDES, pageGuide } from "../src/shared/help/pageGuide";
import { NAV_TITLES, actsByBand, asksHowThePageWorks, boldSpans, guideIntent, renderButtonsAnswer, renderGuideAnswer, renderGuideMarkdown, renderWalkthroughAnswer } from "../src/shared/help/pageGuide/render";
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
    for (const face of ["Coming up", "On the record", "Start a meeting now", "Google Meet", "Before", "During", "Beside the call", "After"]) expect(bands).toContain(face);
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
      "Walter, how does this tab work?",
      "I think you still have the old page instructions",
    ]) {
      expect(asksHowThePageWorks(q), q).toBe(true);
      expect(guideIntent(q), q).toBe("how");
    }
  });

  /*
   * 19 Sep 2026, her words: "walk me through a fake meeting", "explain what all of the buttons do".
   * Until tonight both fell into "how does this page work" and got the guide top to bottom — the
   * right page, the wrong shape. Each is its own shape now, and "walk me through the page" is a
   * walkthrough, not a guide: she asked for a scenario, not a description.
   */
  it("hears a request for a walkthrough, in the owner's words and others", () => {
    for (const q of [
      "walk me through a real meeting",
      "walk me through the page",
      "can you walk me through a fake meeting",
      "show me how I'd use this",
      "show me how you would run a meeting on this page",
      "take me through it step by step",
      "give me a scenario",
      "what would I actually do here, first?",
      "pretend I have a founder call tomorrow",
    ]) {
      expect(guideIntent(q), q).toBe("walkthrough");
      expect(asksHowThePageWorks(q), q).toBe(false);
    }
  });

  it("hears a request to explain the buttons, in the owner's words and others", () => {
    for (const q of [
      "explain what all of the buttons do",
      "what does each button do",
      "what do all the buttons do",
      "explain the buttons",
      "explain the buttons on this page",
      "what are all these controls for?",
      "list the controls",
    ]) {
      expect(guideIntent(q), q).toBe("buttons");
      expect(asksHowThePageWorks(q), q).toBe(false);
    }
  });

  it("leaves a question about the firm's data or one control to the host", () => {
    for (const q of [
      "what does Move it do",
      "which of these is worth a second cheque?",
      "why is this deal stalled",
      "how long has Psyflo been in diligence",
      "what does a soft commitment mean here?",
      "If I push Join on Meet what happens?",
      "is it recording?",
    ]) {
      expect(guideIntent(q), q).toBeNull();
      expect(asksHowThePageWorks(q), q).toBe(false);
    }
  });
});

describe("the walkthrough and the buttons, for every guide", () => {
  it("every guide has a walkthrough whose bold controls are the page's own, and Meetings has both scenarios", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      expect(g.walkthroughs.length, g.navKey).toBeGreaterThanOrEqual(1);
      const labels = new Set(g.acts.map((a) => a.label));
      const bands = new Set(g.bands.map((b) => b.name));
      for (const w of g.walkthroughs) {
        expect(w.steps.length, `${g.navKey}: ${w.scenario}`).toBeGreaterThanOrEqual(2);
        let acts = 0;
        for (const st of w.steps) {
          for (const span of boldSpans(`${st.do} ${st.then ?? ""} ${st.not ?? ""}`)) {
            expect(labels.has(span) || bands.has(span), `${g.navKey}: **${span}**`).toBe(true);
            if (labels.has(span)) acts += 1;
          }
        }
        expect(acts, `${g.navKey}: ${w.scenario} presses nothing`).toBeGreaterThan(0);
      }
    }
    const m = pageGuide("meetings")!;
    expect(m.walkthroughs.map((w) => w.scenario)).toEqual([
      "A founder call that arrived from the calendar, on Google Meet",
      "In person or by phone — no calendar, the laptop microphone",
    ]);
    const meet = m.walkthroughs[0]!;
    const order = ["**Go to this meeting**", "**Seat**", "**Join on Meet**", "**Use my laptop mic for this Meet call**", "**Ask**", "**Done — open the record**", "**Draft what came out of it**", "**Approve — make these the record**", "**Move it**"];
    let last = -1;
    for (const control of order) {
      const at = meet.steps.findIndex((st, i) => i > last && st.do.includes(control));
      expect(at, `${control} in order`).toBeGreaterThan(last);
      last = at;
    }
    const join = meet.steps.find((st) => st.do.includes("**Join on Meet**"))!;
    // Tier 4 (19 Sep 2026) made "nothing joins for you" false: Join on Meet alone still puts no
    // employee in the call, and the NEXT step — the call starting — is where the OS joins, with
    // the two limits said on it (firm-hosted under the firm default; never LP or Broker).
    expect(join.not).toMatch(/Join on Meet alone puts no employee in the call/);
    expect(join.not).not.toMatch(/nothing joins for you/);
    expect(join.then).toMatch(/Beside the call/);
    expect(join.then).toMatch(/Inside the call/);
    const joins = meet.steps[meet.steps.indexOf(join) + 1]!;
    expect(joins.do).toMatch(/the OS joins it from the Mac/);
    expect(joins.then).toMatch(/in the call · live/);
    expect(joins.then).toMatch(/the Mac is not listening|preview not yet granted|the join refused/);
    expect(joins.not).toMatch(/never for LP or Broker/);
    expect(joins.not).toMatch(/firm-hosted Meet under the firm default/);
    // One room, several doors — said in those words, first step of the walk.
    expect(m.purpose).toMatch(/One room per meeting, several doors/);
    expect(meet.steps.find((st) => st.do.includes("**Go to this meeting**"))!.do).toMatch(/one room, several doors/);
    const mic = meet.steps.find((st) => st.do.includes("**Use my laptop mic for this Meet call**"))!;
    expect(mic.then).toMatch(/They said yes — record/);
    expect(mic.then).toMatch(/speakers, not headphones/);
    expect(mic.not).toMatch(/nothing records before their yes/);
    expect(mic.not).toMatch(/authoritative record/);
    // The retired control is not in the walk.
    expect(JSON.stringify(m)).not.toContain("It is happening now");
    expect(JSON.stringify(m)).not.toContain("Bring it in");
    const seat = meet.steps.find((st) => st.do.includes("**Seat**"))!;
    expect(seat.not).toMatch(/not a participant in the Google Meet call himself/);
    expect(seat.not).toMatch(/the call itself once the OS is in it/);
    const person = m.walkthroughs[1]!;
    expect(person.steps.some((st) => st.do.includes("**They said yes — record**"))).toBe(true);
    expect(person.steps.some((st) => (st.then ?? "").includes("laptop microphone"))).toBe(true);
  });

  it("renders as a heading per scenario and numbered steps, with what does not happen said on the step", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      const md = renderWalkthroughAnswer(g);
      const blocks = parseMarkdown(md);
      expect(plainText([blocks[0]!]), g.navKey).toMatch(/^Here is how you would use .+, start to finish/);
      expect(blocks.filter((b) => b.kind === "heading").length, g.navKey).toBe(g.walkthroughs.length);
      const ordered = blocks.filter((b) => b.kind === "ordered");
      expect(ordered.length, g.navKey).toBe(g.walkthroughs.length);
      g.walkthroughs.forEach((w, i) => expect(ordered[i]!.kind === "ordered" && ordered[i]!.items.length, `${g.navKey}: ${w.scenario}`).toBe(w.steps.length));
      expect(md.trimEnd().endsWith("?")).toBe(false);
    }
    expect(renderWalkthroughAnswer(pageGuide("meetings")!)).toContain("What does not happen: Join on Meet alone puts no employee in the call");
    expect(renderWalkthroughAnswer(pageGuide("meetings")!)).toContain("What does not happen: only a firm-hosted Meet under the firm default is joined");
  });

  it("the buttons answer carries every act once, under the band it sits in, human act first", () => {
    for (const g of Object.values(PAGE_GUIDES)) {
      const groups = actsByBand(g);
      expect(groups.flatMap((x) => x.acts).length, g.navKey).toBe(g.acts.length);
      const md = renderButtonsAnswer(g);
      for (const a of g.acts) expect(md.split(`**${a.label}**`).length - 1, `${g.navKey}: ${a.label}`).toBe(g.acts.filter((b) => b.label === a.label).length);
      const blocks = parseMarkdown(md);
      expect(blocks.filter((b) => b.kind === "heading").length, g.navKey).toBe(groups.length);
    }
    const groups = actsByBand(pageGuide("meetings")!);
    expect(groups.map((x) => x.band)).toEqual(["Coming up", "On the record", "Start a meeting now", "Google Meet", "Before", "During", "Beside the call", "After"]);
    expect(groups.find((x) => x.band === "During")!.acts.map((a) => a.label)).toContain("Seat");
    expect(groups.find((x) => x.band === "After")!.acts[0]!.primary).toBe(true);
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
