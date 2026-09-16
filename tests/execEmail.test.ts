import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  DETAILS_RULE,
  SECTION_MAX_LINES,
  SUBJECT_MAX,
  boldNumbers,
  bulletsFrom,
  execFooter,
  lintExecEmail,
  renderExecEmail,
  type ExecEmailInput,
} from "../src/shared/email/execEmail";
import { sendFirmUserCopy, sendPartnerEmail } from "../src/worker/services/execEmail";
import { copyEmail } from "../src/worker/services/deliverables";
import { customerSummary, monthlySummary, pressSummary, renderIntroNote, renderMonthlyEmail } from "../src/worker/services/productions";
import { blogHelpEmail } from "../src/worker/services/blogHelp";
import { hireSummary, renderHireNote, type HireCandidate } from "../src/worker/services/productionsHire";

/**
 * EVERY EMAIL AN EMPLOYEE SENDS A PARTNER IS THE SAME SHAPE (16 Sep 2026).
 *
 * Operator: "busy-executive format, enforced in code, not by hoping." This file renders each kind
 * of email the system sends a partner through the one formatter and holds the OUTPUT to the rules:
 * subject ≤ 70 as "<Employee>: <what>", TL;DR first, labelled sections as bullets with no section
 * over six lines, the full material under a rule, a footer naming the employee and the mailbox,
 * and no wall of prose anywhere. Then it proves the lint still bites, with hand-built emails that
 * break each rule — a validator that cannot fail is decoration.
 *
 * The send path is exercised too: a message the lint rejects is NOT sent and the refusal is on
 * the record with the violations; a clean one goes out with an HTML part and Reply-To set to the
 * intake mailbox; the destination and the deployment switch are still the only two gates.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; html?: string; reply_to?: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html?: string; reply_to?: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, html: body.html, reply_to: body.reply_to });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

/** Every kind of email the system sends a partner, as the sender composes it. */
function everyKind(): Array<{ name: string; input: ExecEmailInput }> {
  const ideas = [{ organisation: "Example Nonprofit", trigger: "announced a summit", approach: "Head of Community", angle: "the summit needs a community", url: "https://example.org/summit" }];
  const pitches = [{ writer: "A. Writer", outlet: "Community Weekly", email: "a@cw.example", contactUrl: "https://cw.example/about", emailKind: "personal" as const, whyThisWriter: "covers community", hook: "Community is an operating advantage", proofUrl: "https://cw.example/piece", draft: "Hi A —\nI run West Peek Productions.\nTwenty minutes?" }];
  const monthly = monthlySummary("2026-10", ideas, pitches, ["https://dead.example"], [{ name: "VK", reason: "Russian" }]);
  const intro = renderIntroNote();
  const longProse = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of a long finding that goes on for a while and says a great deal about nothing in particular.`).join("\n");
  return [
    {
      name: "reply: DONE",
      input: { employee: "Wyatt", what: "done — Verify Sensori is real", tldr: "Finished what you asked for. Nothing needs deciding.", sections: [{ label: "What you asked", bullets: ["Verify Sensori is real"] }, { label: "What I found", bullets: bulletsFrom("Sensori is real: named angels, a live product, on-thesis CPG. Worth a call.") }, { label: "Your call", bullets: ["Nothing, unless you want it taken further."] }], details: "Sensori is real: named angels, a live product, on-thesis CPG. Worth a call." },
    },
    {
      name: "reply: BLOCKED, with a long prose finding",
      input: { employee: "Wesley", what: "blocked — Find the LP letter", tldr: "Blocked. One decision from you unblocks it.", sections: [{ label: "What you asked", bullets: ["Find the LP letter"] }, { label: "Where I am stuck", bullets: bulletsFrom(longProse) }, { label: "Your call", bullets: ["Answer by replying."] }], details: longProse },
    },
    { name: "Walker: monthly Productions note", input: { employee: "Walker", what: monthly.what, tldr: monthly.tldr, sections: monthly.sections, details: renderMonthlyEmail("2026-10", ideas, pitches, ["https://dead.example"], [{ name: "VK", reason: "Russian" }]) } },
    { name: "Walker: customer ideas", input: { employee: "Walker", ...customerSummary("2026-10", ideas, []), details: "the note" } },
    { name: "Walker: press pitches", input: { employee: "Walker", ...pressSummary("2026-10", pitches, []), details: "the note" } },
    {
      name: "Walker: weekly hire search",
      input: (() => {
        const fresh: HireCandidate[] = [
          { name: "Jordan Example", title: "Senior Experiential Producer (freelance)", company: "Independent", city: "Brooklyn, NY", profileUrl: "https://linkedin.com/in/jordan-example", evidenceUrl: "https://agency.example/team/jordan", why: "Team page lists 12 brand activations produced end to end.\nBio says freelance since 2023 and names two sponsorship deals closed.", openingLine: "Your Nike House of Innovation build is the kind of thing we want more of.", fit: 8, profileCheck: "refused" },
          { name: "Sam Sample", title: "Executive Producer", company: "Freelance", city: "Los Angeles, CA", profileUrl: "https://samsample.example", evidenceUrl: null, why: "Portfolio shows brand partnerships sold and produced.", openingLine: "Loved the Coachella activation.", fit: 7, profileCheck: "live" },
        ];
        const seen = [{ ...fresh[1]!, firstSeen: "2026-09-14T14:00:00.000Z" }];
        const acted = [{ name: "Old Name", status: "CONTACTED" as const }];
        const dropped = [{ name: "Dead Link", reason: "the profile page did not answer (404)" }];
        const rejected = [{ name: "Not Senior", reason: "three years, not eight" }];
        return { employee: "Walker", ...hireSummary("2026-W38", fresh, seen, acted, dropped, rejected), details: renderHireNote("2026-W38", fresh, seen, acted, dropped, rejected) };
      })(),
    },
    { name: "Walker: introduction", input: { employee: "Walker", what: "your chief of staff — about that first email, and how to reach me", tldr: "I'm Walker, your chief of staff. The first note was below standard and is fixed.", sections: [{ label: "What was wrong", bullets: ["The list wandered.", "No addresses."] }, { label: "Your call", bullets: ["Nothing now."] }], details: intro.text } },
    {
      name: "Parker: Room packet (shape)",
      input: { employee: "Parker", what: "your October 2026 Room — The Scaled Boardroom, an executive dinner and think tank (PDF inside)", tldr: "A Room proposed: **The Scaled Boardroom**, 30–40 people, $22,000–$28,000, 3 sponsors ranked. Keep it or dismiss it.", sections: [{ label: "What you asked", bullets: ["Black lawyers who are partners or GCs in New York"] }, { label: "What I found", bullets: ["Concept: **The Scaled Boardroom**", "Venue: **SAGA**, est. $9,000–$11,000."] }, { label: "Your call", bullets: ["Keep it or dismiss it: https://os.joinwestpeek.com/#/rooms"] }], details: "THE CONCEPT — The Scaled Boardroom\nan executive dinner\n\nBUDGET\n- venue: $9,000–$11,000 — comp" },
    },
    {
      name: "the morning brief, emailed to yourself from Home",
      input: copyEmail({ kind: "daily_brief", title: "Morning brief — 2026-09-16", body: "_Sequoia's edition_\n\n## One-minute executive summary\n\nMarkets flat. Two portfolio updates.\n\n## Private markets\n\nA seed round in functional drinks.", prepared_by: "Wren", created_at: "2026-09-16T06:45:00.000Z" }, "Sequoia Taylor", "# Morning brief — 2026-09-16\n\nthe markdown"),
    },
    {
      name: "a research packet, emailed to yourself from Home",
      input: copyEmail({ kind: "research_packet", title: "Functional drinks in the US", body: "A question, the sources, what they support.", prepared_by: "Wyatt", created_at: "2026-09-10T10:00:00.000Z" }, "Scooter Taylor", "# Functional drinks\n\ntext"),
    },
    {
      name: "blog help: outline",
      input: blogHelpEmail({
        employee: "Wren",
        ask: { modes: ["OUTLINE"], topic: "why early-stage founders should hire a recruiter before a CFO", ask: "help me make an outline…" },
        outline: { title: "The first hire is the hire who hires", alternates: ["Recruiter before CFO", "Who builds the team", "Your first ten"], thesis: "People are the scarce resource at seed.", sections: [{ heading: "The cash myth", proves: "x", leansOn: [] }, { heading: "What a recruiter does at 8 people", proves: "y", leansOn: [] }], opening: "o", closing: "c", notes: [] },
        draft: null, phrases: null,
        research: { notes: [{ fact: "f", whyItMatters: "", source: "s", url: "https://a.example/1", date: null }], dropped: ["https://dead.example"], rejected: [] },
        strippedUrls: 1, failures: [], body: "## Outline\n\ntext", deliverableId: "dlv_1",
      }),
    },
    {
      name: "blog help: draft and phrases together",
      input: blogHelpEmail({
        employee: "Walker",
        ask: { modes: ["DRAFT", "PHRASE"], topic: "what LPs get wrong about emerging managers", ask: "write a blog post…" },
        outline: null,
        draft: { title: "What LPs get wrong", bodyMarkdown: "## One\n\ntext [1]", sources: [{ n: 1, url: "https://a.example/1", note: "" }], words: 1010 },
        phrases: { candidates: [{ phrase: "Good people should meet good people", reasoning: "r", recursAs: "sign-off" }, { phrase: "Early inclusion beats early access", reasoning: "r", recursAs: "header" }], recommendation: "Early inclusion beats early access", why: "it is what we do" },
        research: { notes: [{ fact: "f", whyItMatters: "", source: "s", url: "https://a.example/1", date: null }], dropped: [], rejected: [] },
        strippedUrls: 0, failures: [], body: "## Draft\n\n" + Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a hard-wrapped paragraph.`).join("\n"), deliverableId: "dlv_2",
      }),
    },
  ];
}

describe("every email kind renders to the busy-executive format", () => {
  for (const { name, input } of everyKind()) {
    it(name, () => {
      const r = renderExecEmail(input);
      const violations = lintExecEmail(r.subject, r.text, input.employee);
      expect(violations, `${name}:\n${r.text}`).toEqual([]);
      expect(r.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
      expect(r.subject).toMatch(new RegExp(`^${input.employee}: \\S`));
      expect(r.text.split("\n")[0]).toMatch(/^\*\*TL;DR:\*\* \S/);
      expect(r.text.trim().split("\n").pop()).toBe(execFooter(input.employee));
      // The HTML part carries the same content: the TL;DR, every label, every bullet.
      expect(r.html).toContain("<strong>TL;DR:</strong>");
      for (const s of input.sections) if (s.bullets.length) expect(r.html).toContain(`<strong>${s.label.replace(/&/g, "&amp;")}</strong>`);
      expect(r.html).not.toMatch(/<img|<script/i);
      if (input.details) expect(r.text).toContain(DETAILS_RULE);
    });
  }

  it("caps a section at six lines and points at the details for the rest", () => {
    const r = renderExecEmail({ employee: "Wren", what: "x", tldr: "t", sections: [{ label: "What I found", bullets: Array.from({ length: 12 }, (_, i) => `finding ${i + 1}`) }, { label: "Your call", bullets: ["y"] }], details: "all twelve" });
    const section = r.text.split("**What I found**\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(section).toHaveLength(SECTION_MAX_LINES);
    expect(section[SECTION_MAX_LINES - 1]).toMatch(/^• … and \*\*7\*\* more, under Details below\./);
    expect(lintExecEmail(r.subject, r.text, "Wren")).toEqual([]);
  });

  it("truncates a long subject to 70 with an ellipsis, and bolds numbers in bullets but not inside URLs", () => {
    const r = renderExecEmail({ employee: "Parker", what: "your October 2026 Room — a very long title that keeps going well past the seventy character line", tldr: "t", sections: [{ label: "A", bullets: ["x"] }, { label: "B", bullets: ["y"] }] });
    expect(r.subject.length).toBe(SUBJECT_MAX);
    expect(r.subject.endsWith("…")).toBe(true);
    expect(boldNumbers("3 sponsors at $22,000 and 15% — see https://example.org/2026/09/post-1 on 2026-09-15")).toBe("**3** sponsors at **$22,000** and **15%** — see https://example.org/2026/09/post-1 on 2026-09-15");
    expect(boldNumbers("already **3** bold, 63rd floor, re_1")).toBe("already **3** bold, 63rd floor, re_1");
  });

  it("breaks a wall of prose in the details by construction", () => {
    const r = renderExecEmail({ employee: "Wren", what: "x", tldr: "t", sections: [{ label: "A", bullets: ["x"] }, { label: "B", bullets: ["y"] }], details: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") });
    expect(lintExecEmail(r.subject, r.text, "Wren")).toEqual([]);
  });
});

describe("the lint still bites", () => {
  const good = renderExecEmail({ employee: "Wren", what: "done — the thing", tldr: "Finished.", sections: [{ label: "What you asked", bullets: ["the thing"] }, { label: "Your call", bullets: ["nothing"] }], details: "all of it" });
  it("passes the clean one", () => expect(lintExecEmail(good.subject, good.text, "Wren")).toEqual([]));

  const cases: Array<[string, string, string, RegExp]> = [
    ["a subject over 70", "Wren: " + "x".repeat(80), good.text, /subject is 86 characters/],
    ["a subject that is not <Employee>: <what>", "Done: the thing", good.text, /does not start with "Wren: "/],
    ["a subject with no employee at all", "the thing is done", good.text, /does not read "<Employee>: <what it is>"/],
    ["no TL;DR first", good.subject, good.text.replace("**TL;DR:** Finished.", "Hi — I finished the thing."), /first line is not a TL;DR/],
    ["prose above the details", good.subject, good.text.replace("**What you asked**", "I thought I would write you a paragraph here about the thing.\n**What you asked**"), /neither a label nor a bullet/],
    ["only one section", good.subject, good.text.replace("**Your call**\n• nothing\n", ""), /only 1 labelled section/],
    ["a section over six lines", good.subject, good.text.replace("• the thing", Array.from({ length: 7 }, (_, i) => `• thing ${i}`).join("\n")), /runs past 6 lines/],
    ["a wall of prose in the details", good.subject, good.text.replace("all of it", Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n")), /wall of prose/],
    ["no footer", good.subject, good.text.replace(execFooter("Wren"), "Cheers."), /not the employee's footer/],
    ["the wrong employee in the footer", good.subject, good.text.replace(execFooter("Wren"), execFooter("Walker")), /does not name Wren/],
  ];
  for (const [name, subject, text, expected] of cases) {
    it(`catches ${name}`, () => expect(lintExecEmail(subject, text, "Wren").join("; ")).toMatch(expected));
  }
});

describe("the one door", () => {
  const email: ExecEmailInput = { employee: "Wren", what: "done — the thing", tldr: "Finished.", sections: [{ label: "What you asked", bullets: ["the thing"] }, { label: "Your call", bullets: ["nothing"] }], details: "all of it" };

  it("sends a clean email with an HTML part and Reply-To set to the intake mailbox, and records it", async () => {
    const out = await sendPartnerEmail(env, { to: "sequoia@westpeek.ventures", email, objectType: "work_card", objectId: "wc_door_1", firmScope: "west-peek", actorId: "aie_wren" });
    expect(out.sent, out.reason).toBe(true);
    expect(out.subject).toBe("Wren: done — the thing");
    const last = sent[sent.length - 1]!;
    expect(last.to).toBe("sequoia@westpeek.ventures");
    expect(last.html).toContain("<strong>TL;DR:</strong>");
    expect(last.reply_to).toBe("os@joinwestpeek.com");
    const ev = await env.WP_OS_DB.prepare("SELECT event_type FROM event_record WHERE object_id = 'wc_door_1' ORDER BY created_at DESC LIMIT 1").first<{ event_type: string }>();
    expect(ev?.event_type).toBe("deliverable.emailed_to_partner");
  });

  it("refuses any destination that is not a partner, and does nothing when the switch is off", async () => {
    const before = sent.length;
    expect((await sendPartnerEmail(env, { to: "founder@sensori.example", email, objectType: "x", objectId: "x", firmScope: "west-peek" })).reason).toMatch(/not one of the two partner addresses/);
    const off = { ...env, WP_OS_AI_EMAIL_PARTNERS: "off" } as Env;
    expect((await sendPartnerEmail(off, { to: "scooter@westpeek.ventures", email, objectType: "x", objectId: "x", firmScope: "west-peek" })).reason).toMatch(/WP_OS_AI_EMAIL_PARTNERS is off/);
    expect(sent).toHaveLength(before);
  });

  it("a partner's own copy from Home takes the same layout and the same transport, without the employee switch", async () => {
    const off = { ...env, WP_OS_AI_EMAIL_PARTNERS: "off" } as Env;
    const out = await sendFirmUserCopy(off, { recipient: { id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures" }, email: copyEmail({ kind: "daily_brief", title: "Morning brief — 2026-09-16", body: "## A\n\nx", prepared_by: "Wren", created_at: "2026-09-16T06:45:00.000Z" }, "Sequoia Taylor", "# Morning brief"), objectType: "deliverable", objectId: "dlv_copy_1", firmScope: "west-peek", byFirmUserId: "fu_sequoia_taylor" });
    expect(out.sent, out.reason).toBe(true);
    expect(sent[sent.length - 1]!.subject).toBe("Wren: morning brief — Morning brief — 2026-09-16");
    expect(sent[sent.length - 1]!.text).toMatch(/^\*\*TL;DR:\*\* A copy of the morning brief/);
  });
});
