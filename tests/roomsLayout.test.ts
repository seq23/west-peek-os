import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The shape of Events & Rooms.
 *
 * This is the page the operator named when she said the tabs were jumbled — "add a final pass for
 * every single tab that make sure the pages are not jumbled like the events tab and look more like
 * the LP tab", and "i dont underestand why it cant be simple like the lp page. everything is there
 * and its easy to follow."
 *
 * Every property below is one that was actually wrong, and every one of them is the kind of thing
 * that comes back the next time somebody adds a feature to this page. They are structural checks on
 * the source, in the manner of tests/accessibility.test.ts: cheap, and they fail for the right
 * reason.
 *
 * ONE OF THEM IS A DIRECT OPERATOR INSTRUCTION with no other test behind it — "declined proposals
 * should go somewhere after they are declined. somewhere below greyed out." It was implemented and
 * nothing anywhere checked it still existed.
 */

const ROOMS = readFileSync(new URL("../src/client/pages/RoomsPage.tsx", import.meta.url), "utf8");
const EVENTS = readFileSync(new URL("../src/client/pages/EventsPage.tsx", import.meta.url), "utf8");
const CLOSEOUT = readFileSync(new URL("../src/client/pages/CloseoutPanel.tsx", import.meta.url), "utf8");
const TLC = readFileSync(new URL("../src/client/pages/LearningClubPanel.tsx", import.meta.url), "utf8");
const SPONSORS = readFileSync(new URL("../src/client/pages/RoomSponsorsPage.tsx", import.meta.url), "utf8");
const LINKS = readFileSync(new URL("../src/client/pages/RoomsLinks.tsx", import.meta.url), "utf8");
const SCHEDULE = readFileSync(new URL("../src/client/pages/ScheduleRoom.tsx", import.meta.url), "utf8");

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...src.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each h3, in order. */
function sections(src: string): string[] {
  return [...src.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

describe("Events & Rooms keeps the ranks the shell expects", () => {
  it("uses only h3 for a section and h4 for a thing inside one", () => {
    // The shell renders the page title as an h2. A section is therefore an h3 and a thing inside a
    // section is an h4; nothing goes deeper, because there is nothing deeper to navigate to.
    for (const [name, src] of [["RoomsPage", ROOMS], ["EventsPage", EVENTS], ["CloseoutPanel", CLOSEOUT], ["LearningClubPanel", TLC], ["RoomSponsorsPage", SPONSORS], ["RoomsLinks", LINKS], ["ScheduleRoom", SCHEDULE]] as const) {
      expect(ranks(src).filter((r) => r < 3 || r > 4), `${name} uses a rank outside h3/h4`).toEqual([]);
    }
  });

  it("does not restate the page title the shell already printed", () => {
    // The nav label is "Events & Rooms" and the shell prints it as the h2.
    expect(sections(ROOMS)).not.toContain("Events & Rooms");
    expect(sections(ROOMS)).not.toContain("Rooms");
    expect(sections(EVENTS)).not.toContain("Events");
  });

  it("mounts the record of gatherings as one of the folded rows, and its form as a card of its own", () => {
    // v8 (owner, 23 Oct 2026): "Put a gathering on the record" is a card near the top; "Every
    // gathering on the record" is a folded row lower down. Both read ONE list the page holds, so a
    // gathering put on the record shows in the record at once.
    expect(ROOMS).toContain("<PutOnRecordForm onCreated={() => events.reload()} />");
    expect(ROOMS).toMatch(/<RoomsFold title="Every gathering on the record"[^>]*testId="events-fold">\s*<GatheringRecord state=\{events\} \/>/);
    expect(ROOMS).not.toContain("<EventsPage");
    expect(EVENTS).toContain("<h3>Put a gathering on the record</h3>");
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet draws it from the h3. A hand-placed <hr> would be a second line.
    expect(ROOMS).not.toContain("<hr");
    expect(EVENTS).not.toContain("<hr");
  });
});

describe("Events & Rooms reads the order the owner approved (v8 mock-up, 23 Oct 2026)", () => {
  it("links row, Ideas, Put a gathering on the record, Ask Parker, the five folded rows, How this works — in that order", () => {
    const body = ROOMS.slice(ROOMS.indexOf('<section data-testid="rooms-page">'));
    const order = [
      '<RoomsLinks current="rooms" />',
      "<IdeasCard meName={meName} />",
      "<PutOnRecordForm",
      '<section className="card" data-testid="ask-parker">',
      '<RoomsFold title="Scheduled Rooms"',
      '<RoomsFold title="Kept for later"',
      'title="Workshops"',
      '<RoomsFold title="Every gathering on the record"',
      'data-testid="declined-proposals"',
      '<HowThisWorksFold page="Events & Rooms" testId="rooms-how">',
    ];
    const at = order.map((o) => body.indexOf(o));
    expect(at.filter((i) => i < 0), `missing: ${order.filter((_, k) => at[k]! < 0).join(" | ")}`).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The bottom lid holds Parker's card, how events work, how often West Peek gathers, and the guide.
    const how = body.slice(body.indexOf('<HowThisWorksFold page="Events & Rooms"'));
    for (const piece of ['<PageHostCard navKey="rooms" />', "<RoomsMap />", "<Programme />", "<HowThisWorks"]) expect(how).toContain(piece);
  });

  it("puts what waits on her inside Ask Parker, above the request, and the request one tap away", () => {
    const ask = ROOMS.slice(ROOMS.indexOf('data-testid="ask-parker"'), ROOMS.indexOf('<RoomsFold title="Scheduled Rooms"'));
    expect(ask.indexOf('data-testid="rooms-empty"')).toBeLessThan(ask.indexOf("<RequestRoom"));
    expect(ask.indexOf('data-testid="rooms-waiting"')).toBeLessThan(ask.indexOf("<RequestRoom"));
    expect(ask).toMatch(/<details className="rooms-ask" data-testid="ask-parker-fold" ref=\{askRef\}>\s*<summary>Ask Parker ▾<\/summary>/);
    expect(ROOMS).toContain('data-testid="propose-room"');
  });

  it("carries one detailed guide, and it is in the bottom lid", () => {
    expect((ROOMS.match(/<HowThisWorks\b/g) ?? []).length).toBe(1);
    expect(EVENTS).not.toContain("HowThisWorks");
    expect(ROOMS.indexOf("<HowThisWorks\n")).toBeGreaterThan(ROOMS.indexOf("<Programme />"));
    // Parker's card moved into it: the shell does not also print it at the top of Events & Rooms.
    const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
    expect(app).toContain('active !== "documents" && active !== "rooms" && <PageHostCard navKey={active} />');
  });
});

describe("four pages, each with the links row and a way back", () => {
  it("routes the three new pages, titles each, and files them under Events & Rooms", async () => {
    const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
    for (const [key, comp] of [["learning-club", "<LearningClubPage />"], ["room-sponsors", "<RoomSponsorsPage />"], ["research-library", "<ResearchLibraryPage />"]] as const) {
      expect(app, key).toContain(`active === "${key}" && ${comp}`);
      expect(app.slice(app.indexOf("const ALL_NAV_KEYS"), app.indexOf("]);", app.indexOf("const ALL_NAV_KEYS"))), key).toContain(`"${key}"`);
    }
    const { OFF_NAV_TITLES } = await import("../src/client/lib/pageTitles");
    expect(OFF_NAV_TITLES["learning-club"]).toEqual({ label: "The Learning Club", under: "rooms" });
    expect(OFF_NAV_TITLES["room-sponsors"]).toEqual({ label: "Room sponsors", under: "rooms" });
    expect(OFF_NAV_TITLES["research-library"]).toEqual({ label: "Research library", under: "rooms" });
  });

  it("puts the links row first on every page, and every page has ← Back", () => {
    expect(ROOMS).toContain('<RoomsLinks current="rooms" />');
    expect(TLC).toContain('<RoomsLinks current="learning-club" />');
    expect(TLC).toContain('<RoomsLinks current="research-library" />');
    expect(SPONSORS).toContain('<RoomsLinks current="room-sponsors" />');
    expect(LINKS).toContain("← Back to Events &amp; Rooms");
    expect(LINKS).toContain("← Back");
    for (const label of ["The Learning Club", "Room sponsors", "Research library"]) expect(LINKS).toContain(`label: "${label}"`);
  });

  it("keeps \"Who is paying for it\" — on Room sponsors, as its heading, with the committed total", () => {
    // Owner, 23 Oct 2026, angry that it was lost once. It is a heading on the Room sponsors page.
    expect(SPONSORS).toContain("<h3>Who is paying for it</h3>");
    expect(SPONSORS).toContain('data-testid="sponsors-committed"');
    expect(SPONSORS.indexOf('data-testid="sponsor-table"')).toBeLessThan(SPONSORS.indexOf('data-testid="add-sponsor"'));
    expect(SPONSORS).toContain("<h3>Add a sponsor to a Room</h3>");
    expect(SPONSORS).toContain("<ScheduleRoomButton");
    // The decline reason still sits beside a sponsor who said no.
    expect(SPONSORS).toContain("Said no: {s.decline_reason}");
  });

  it("has ONE list of partners who said yes, on The Learning Club", () => {
    expect(TLC).toContain("<h3>Partners who said yes</h3>");
    expect((TLC.match(/<PartnersPanel\b/g) ?? []).length).toBe(1);
    expect(TLC).toContain("<PartnersPanel />");
    expect(ROOMS).not.toContain("PartnersPanel");
    expect(SPONSORS).not.toContain("<PartnersPanel");
  });

  it("moves #270's Brands we must pitch and Needs a way in onto The Learning Club page", () => {
    const page = TLC.slice(TLC.indexOf("export function LearningClubPage"), TLC.indexOf("function ClubRow"));
    expect(page).toContain("<MustPitchSection");
    expect(ROOMS).not.toContain("MustPitchSection");
    for (const card of ["tlc-brand-sending", "tlc-next-clubs", "tlc-title-sponsors", "tlc-not-pitching", "tlc-partners", "tlc-steps-fold", "tlc-how"]) {
      expect(TLC, card).toContain(card);
    }
  });
});

describe("a declined Room goes on a shelf, not into nothing", () => {
  /*
   * Operator, verbatim: "declined proposals should go somewhere after they are declined. somewhere
   * below greyed out." Parker proposes a Room a month and most are declined by design, so a list
   * that silently drops them loses the record of what was considered.
   */
  it("keeps the shelf, its test hook, and the dimming that makes it history", () => {
    expect(ROOMS).toContain('data-testid="declined-proposals"');
    expect(ROOMS).toContain('className="rooms-fold declined-shelf"');
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.declined-shelf\s*\{[^}]*opacity/);
  });

  it("puts the shelf after the record of gatherings, as one closed lid, above How this works", () => {
    expect(ROOMS.indexOf('testId="rooms-kept"')).toBeLessThan(ROOMS.indexOf('data-testid="declined-proposals"'));
    expect(ROOMS.indexOf('testId="events-fold"')).toBeLessThan(ROOMS.indexOf('data-testid="declined-proposals"'));
    expect(ROOMS.indexOf('data-testid="declined-proposals"')).toBeLessThan(ROOMS.indexOf('<HowThisWorksFold page="Events & Rooms"'));
    // One <details>, closed by default (no `open` attribute), with the heading in its summary.
    expect(ROOMS).toMatch(/<details className="rooms-fold declined-shelf" data-testid="declined-proposals">\s*<summary>\s*<h3>Rooms we turned down<\/h3>/);
    expect(ROOMS).not.toMatch(/<details className="rooms-fold declined-shelf"[^>]*\bopen\b/);
  });

  it("follows a Room's life: waiting on her, kept for later, scheduled — each its own list", () => {
    expect(ROOMS).toContain('p.status === "PROPOSED" || p.status === "DRAFT"');
    expect(ROOMS).toContain('const kept = rooms.filter((p) => p.status === "APPROVED");');
    expect(ROOMS).toContain('const scheduled = rooms.filter((p) => p.status === "SCHEDULED");');
    expect(ROOMS).toContain('data-testid="rooms-waiting"');
    expect(ROOMS).toContain('data-testid="rooms-approved"');
    // What waits on her starts open; kept and scheduled start collapsed to one line.
    expect(ROOMS).toMatch(/waiting\.map\(\(p\) => card\(p, false\)\)/);
    expect(ROOMS).toMatch(/kept\.map\(\(p\) => card\(p, true\)\)/);
    expect(ROOMS).toMatch(/scheduled\.map\(\(p\) => card\(p, true\)\)/);
    // A kept Room carries "Schedule this Room"; that is the step that makes its sponsors live.
    expect(ROOMS).toMatch(/p\.status === "APPROVED" && \([\s\S]{0,600}<ScheduleRoomButton packetId=\{p\.id\}/);
    expect(SCHEDULE).toContain("Schedule this Room");
    expect(SCHEDULE).toContain("/schedule`");
  });

  it("gives every packet card a collapse-to-title toggle, remembered per browser", () => {
    // One head for every state of the card (DRAFT, open, collapsed), so the toggle cannot be lost
    // on one branch; localStorage behind try/catch so a private window just starts from default.
    expect(ROOMS).toContain('data-testid={`packet-toggle-${p.id}`}');
    expect(ROOMS).toContain("aria-expanded={!collapsed}");
    expect(ROOMS).toContain('data-collapsed="true"');
    expect(ROOMS).toContain('const COLLAPSED_KEY = "wpos.rooms.collapsed"');
    expect(ROOMS).toMatch(/try \{\s*const raw = window\.localStorage\.getItem\(COLLAPSED_KEY\)/);
    expect(ROOMS).toMatch(/try \{\s*window\.localStorage\.setItem\(COLLAPSED_KEY/);
    // The hook is called before the DRAFT early return, so it is never conditional.
    expect(ROOMS.indexOf("useCollapsed(p.id, props.startCollapsed)")).toBeLessThan(ROOMS.indexOf('if (p.status === "DRAFT") {'));
  });

  it("filters DECLINED out of the live list and only into the shelf", () => {
    expect(ROOMS).toContain('p.status !== "DECLINED"');
    expect(ROOMS).toContain('p.status === "DECLINED"');
  });

  it("shows the substance of a turned-down Room, not just its title", () => {
    // Operator, 15 Sep 2026: "rooms we turned down need more info so i can see how much was proposed
    // and what the event was about and types of people to be invited."
    const shelf = ROOMS.slice(ROOMS.indexOf('data-testid="declined-proposals"'), ROOMS.indexOf('<HowThisWorksFold page="Events & Rooms"'));
    expect(shelf).toContain("Who was to be invited");
    expect(shelf).toContain("Sponsorship proposed");
    expect(shelf).toContain("Why we said no");
    expect(shelf).toContain("Propose again with changes");
    expect(shelf).toContain("p.sponsor_total_usd");
  });

  it("has two doors into one queue: her brief, or Parker's own idea", () => {
    expect(ROOMS).toContain('data-testid="request-room-submit"');
    expect(ROOMS).toContain('data-testid="propose-room"');
    for (const field of ["room-audience", "room-month", "room-city", "room-sponsors", "room-notes"]) {
      expect(ROOMS).toContain(`data-testid="${field}"`);
    }
    // The packet says which door it came through, and shows the brief.
    expect(ROOMS).toContain('p.origin === "PARTNER_BRIEF"');
    expect(ROOMS).toContain("<BriefBlock");
  });

  it("folds every packet subsection behind a summary that carries the number, and keeps the decision outside the folds", () => {
    // Operator, 15 Sep 2026: "each of its subheadings need to be collapsable with an arrow… it takes
    // up too much space when things aren't collapsable and becomes too busy."
    for (const fold of ["fold-questions", "fold-guests", "fold-agenda", "fold-venues", "fold-sponsors", "fold-budget", "fold-risks", "fold-commitment"]) {
      expect(ROOMS).toContain(`testId={\`${fold}-\${p.id}\`}`);
    }
    expect(ROOMS).toContain('<details className="packet-fold"');
    // The one-number summaries.
    expect(ROOMS).toMatch(/venue\$\{d\.venues\.length === 1 \? "" : "s"\}, est\. \$\{venueSpan\(d\.venues\)\}/);
    expect(ROOMS).toMatch(/sponsor\$\{p\.sponsor_count === 1 \? "" : "s"\}, \$\{usd\(p\.sponsor_total_usd\)\} asked/);
    // Keep / Dismiss sit on the card, never inside a fold.
    const decision = ROOMS.indexOf('data-testid={`approve-${p.id}`}');
    const lastFold = ROOMS.lastIndexOf("</Fold>", decision);
    expect(lastFold).toBeGreaterThan(-1);
    expect(ROOMS.slice(lastFold, decision)).not.toContain("<Fold");
  });

  it("shows every venue's estimate with its basis, and the full budget with scenarios", () => {
    expect(ROOMS).toContain("Est. {range(v.estimate_low_usd ?? v.price_low_usd, v.estimate_high_usd ?? v.price_high_usd)}");
    expect(ROOMS).toContain('data-testid="packet-budget"');
    expect(ROOMS).toContain('data-testid="packet-scenarios"');
    expect(ROOMS).toContain("does not pay for itself");
  });

  it("says what the shelf is for when it is empty, rather than rendering nothing", () => {
    // A section that disappears when empty is a section nobody learns exists.
    const shelf = ROOMS.slice(ROOMS.indexOf('data-testid="declined-proposals"'), ROOMS.indexOf('<HowThisWorksFold page="Events & Rooms"'));
    expect(shelf).toContain("declined.length === 0");
    expect(shelf).toContain("state-empty");
  });
});

describe("nothing on this page is reachable only by guessing", () => {
  it("has no accordion gating the case for a decision", () => {
    // The packet — question, audience, venues, economics, and both decision buttons — used to exist
    // only for a reader who guessed a row was clickable.
    expect(ROOMS).not.toContain("openId");
    expect(ROOMS).not.toContain('className="card-head"');
  });

  it("shows the rhythm instead of hiding it behind a toggle", () => {
    expect(ROOMS).not.toContain("programme-toggle");
    expect(ROOMS).toContain('data-testid="programme-rhythm"');
    expect(ROOMS).toContain('data-testid="programme-money"');
    expect(ROOMS).toContain('data-testid="programme-why"');
  });

  it("announces the close-out step before it is due, in every state", () => {
    // It returned null for DRAFT, PLANNED and CANCELLED, so a partner met the step for the first
    // time on the one day it is hard to do — attendance is unrecoverable a week later.
    expect(EVENTS).not.toMatch(/return null/);
    expect(EVENTS).toContain("closeout-pending-");
    // And the notes box is open, not behind a link you must click first.
    expect(EVENTS).toContain("closeout-notes-");
    expect(EVENTS).not.toContain("closeout-open-");
  });

  it("gives every section an empty state instead of vanishing", () => {
    for (const hook of ["rooms-empty", "rooms-scheduled-empty", "rooms-approved-empty", "workshops-empty", "workshops-approved-empty"]) expect(ROOMS).toContain(hook);
    expect(SPONSORS).toContain("sponsors-empty");
    expect(EVENTS).toContain("events-empty");
    for (const hook of ["tlc-ideas-none", "Nothing set aside.", "No research page yet."]) expect(TLC).toContain(hook);
  });
});

describe("the screen speaks English, the code speaks enum", () => {
  it("never renders a raw status, stage or verification string", () => {
    // PROPOSED, APPROVED, DECLINED, UNVERIFIED and IN_CONVERSATION were printed in capitals.
    for (const expr of ["p.status", "ev.status", "s.stage", "v.verification", "p.format"]) {
      // `{p.status}` in the body renders it. `status={ev.status}` passes it to a child, which is
      // how the raw value is SUPPOSED to travel — the lookbehind is the difference between the two.
      const rendered = new RegExp(`(?<!=)\\{${expr.replace(".", "\\.")}\\}`);
      for (const [name, src] of [["RoomsPage", ROOMS], ["EventsPage", EVENTS], ["RoomSponsorsPage", SPONSORS], ["LearningClubPanel", TLC]] as const) {
        expect(rendered.test(src), `${name} renders ${expr} raw`).toBe(false);
      }
    }
    // Nor a lowercased enum, which is the same word with the shouting removed.
    expect(ROOMS).not.toContain("{p.status.toLowerCase()}");
    expect(EVENTS).not.toContain("{ev.status.toLowerCase()}");
  });

  it("keeps branching on the raw strings, because that is what the API sends", () => {
    expect(ROOMS).toContain('p.status === "PROPOSED"');
    expect(ROOMS).toContain('v.verification === "UNVERIFIED"');
    expect(EVENTS).toContain('status === "CANCELLED"');
  });

  it("gives every state a label a partner would say out loud", () => {
    // "Keep it or dismiss it" replaced "Waiting on you" on 15 Sep 2026 — operator: "its just a packet
    // with a suggestion… that we can dismiss or keep".
    for (const said of ["Keep it or dismiss it", "Turned down", "Nobody has called yet", "Kept for later · parked", "Scheduled"]) {
      expect(ROOMS, `missing plain-English label: ${said}`).toContain(said);
    }
    for (const said of ["In conversation", "Parked until the Room has a date", "On the list"]) expect(SCHEDULE, said).toContain(said);
    for (const said of ["Not on the calendar yet", "On the calendar", "Happening now"]) {
      expect(EVENTS, `missing plain-English label: ${said}`).toContain(said);
    }
  });

  it("uses only class names the stylesheet actually defines", () => {
    /*
     * A LARGE PART OF WHY THIS PAGE LOOKED JUMBLED. It used `pill`, `card-head`, `data`, `lede`,
     * `prewrap`, `negative`, `stack`, `primary` and `warn` — nine class names, none of which the
     * stylesheet has ever defined. Status badges rendered as bare shouting text, the "Propose"
     * button as a default grey button, and the agenda overflowed its card sideways. Nothing failed;
     * it just looked wrong, on the one page the operator was pointing at.
     */
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
    const undefinedClasses: string[] = [];
    for (const [file, src] of [["RoomsPage", ROOMS], ["EventsPage", EVENTS], ["LearningClubPanel", TLC], ["RoomSponsorsPage", SPONSORS], ["RoomsLinks", LINKS], ["ScheduleRoom", SCHEDULE]] as const) {
      for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
          if (!new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`).test(css)) {
            undefinedClasses.push(`${file}: .${cls}`);
          }
        }
      }
    }
    expect([...new Set(undefinedClasses)]).toEqual([]);
  });
});
