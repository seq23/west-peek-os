import { describe, expect, it } from "vitest";
import {
  cleanPreviewUrls,
  clauseLine,
  currentPreviewLine,
  decidedSoFar,
  doneNotice,
  liveUrlsFrom,
  noticeWords,
  planNotice,
  PREVIEW_REPLY_FORMS,
  previewNotice,
  questionNotice,
  STAGE,
  stageSubject,
  stuckNotice,
  type NoticeEmail,
} from "../src/shared/work/porterNotices";
import { boldNumbers, lintExecEmail, renderExecEmail } from "../src/shared/email/execEmail";
import { readApprovalReply } from "../src/shared/work/approvalReply";
import { plainTitle } from "../src/shared/work/siteChange";
import { rebuildIntentFor } from "../src/worker/services/webPropertyChange";
// The Mac's reader, held to the same answers as the Worker's (one rule, two runtimes).
import { previewUrlsFrom, branchAlias } from "../scripts/duties/web-property-change.mjs";

/**
 * PORTER'S EMAILS, ONE SCREEN, THE ANSWER FIRST (owner, 23 Sep 2026).
 *
 * "too long and i have no idea what he wants from me. it says blocked and i have no idea how to
 * unblock" — then: the reply options ARE the TL;DR; missing items are optional; the plan is on the
 * card; a preview link at every stopping point; the stage in plain words in the subject; "blocked"
 * only when he is.
 */

const render = (n: NoticeEmail) => renderExecEmail({ employee: "Porter", ...n, details: null });

const SIX_ASKS = [
  { question: "Orange: the package approves black and orange but gives no hex. Use the orange already live on westpeek.ventures (#c45a3c)?", recommended: "Yes, #c45a3c, held in one CSS token so a later change is one line" },
  { question: "Workshops copy: the brief calls the \"curated 'rooms'\" wording an early draft. Ship it as written?", recommended: "Yes, ship the brief's wording as written" },
  { question: "History gallery: the archive has 184 Instagram posts. Show nine event series, one flyer each, with a one-line description?", recommended: "Yes, those nine, and you edit the lines on the preview" },
  { question: "Replacing /about with the history retires public claims now on joinwestpeek.com. Retire them?", recommended: "Yes, retire them; the brief's story replaces them" },
  { question: "Image rights: the Ep 1–3 headshots came from third-party pages. OK to publish?", recommended: "For Ep 2 and 3, use the founder photos already live on westpeek.ventures" },
  { question: "Fonts: does West Peek's Maax licence cover self-hosting them as web fonts?", recommended: "Yes, self-host Maax" },
];
const FOUR_MISSING = [
  { item: "Sengo application link", where: "the pitch page" },
  { item: "Sengo logo", where: "the pitch page" },
  { item: "past pitch-winner records", where: "the pitch page" },
  { item: "Ep 4 and Ep 5 YouTube links", where: "the episodes page" },
];
const ROW_GREEN = { preview_url: "https://work-wpc-c9e36e8b.west-peek-community.pages.dev", pr_url: "https://github.com/seq23/join-west-peek-main/pull/31", check_state: "GREEN", check_green_at: "2026-09-23T17:40:00.000Z", placeholders_json: JSON.stringify(FOUR_MISSING.map((m) => m.item)) };

describe("the plan email (the 12:42 email she could not use, rewritten)", () => {
  const n = planNotice({ title: "Community site redesign", asks: SIX_ASKS, missing: FOUR_MISSING, previewLine: null, cardId: "wc_c9e36e8b" });
  const r = render(n);

  it("the subject names the stage: \"<plain title>: Plan ready\" — never \"blocked\", never the brief cut mid-word", () => {
    expect(r.subject).toBe("Porter: Community site redesign: Plan ready");
    expect(r.subject).not.toMatch(/blocked|…/i);
  });

  it("the first line says what to do, with \"approved\"; the TL;DR block is first and carries all four reply forms", () => {
    const lines = r.text.split("\n");
    expect(lines[0]).toMatch(/^\*\*TL;DR:\*\* Plan ready\. Reply \*\*approved\*\* and I'll build the preview now, with placeholders for the \*\*4\*\* missing items\. Nothing goes live until you approve the preview\./);
    expect(lines.slice(1, 5)).toEqual([
      "• **approved**: take my 6 recommendations and build the preview",
      "• **approved to production**: skip the preview and land on green",
      "• **changes: …**: hold it and tell me what to change",
      "• anything else: read as your answers to the decisions below",
    ]);
    expect(r.text.match(/\*\*approved\*\*:/g), "the options once, at the top — no duplicate at the bottom").toHaveLength(1);
  });

  it("six decisions, one line each with the recommendation in bold; missing items OPTIONAL, every one listed, never \"…and N more\"", () => {
    expect(r.text).toMatch(/\*\*6 decisions \(my recommendation in bold\)\*\*\n(• .+ → \*\*.+\*\*\n){6}/);
    expect(r.text).toMatch(/\*\*Missing items \(optional\)\*\*\n• Sengo application link\n• Sengo logo\n• past pitch-winner records\n• Ep \*{0,2}4\*{0,2} and Ep \*{0,2}5\*{0,2} YouTube links\n• You don't need these to continue\. I'll use placeholders; add them to Drive or attach them to any reply and I'll rebuild\./);
    expect(r.text).not.toMatch(/and \d+ more|please send/i);
  });

  it("no plan body, one card link, the first preview promised; under the length cap; a valid exec email", () => {
    expect(r.text).not.toMatch(/THE PLAN|WHAT WAS PROVEN|# /);
    expect(r.text).toMatch(/The full plan is on the card: https:\/\/os\.joinwestpeek\.com\/#\/work \(card wc_c9e36e8b\)/);
    expect(r.text).toMatch(/The first preview comes right after you approve the plan\./);
    expect(noticeWords(n), "fits one phone screen without the decisions").toBeLessThan(250);
    expect(r.text.replace(/card wc_\S+/, "")).not.toMatch(/blocked/i);
    expect(lintExecEmail(r.subject, r.text, "Porter")).toEqual([]);
  });

  it("a plan re-sent after a preview exists carries the current preview line instead of the promise", () => {
    const again = render(planNotice({ title: "Community site redesign", asks: SIX_ASKS, missing: [], previewLine: currentPreviewLine(ROW_GREEN), cardId: "wc_x" }));
    expect(again.text).toMatch(/Current preview \(built 12:40 CT, \*\*4\*\* placeholders\): https:\/\/work-wpc-c9e36e8b\.west-peek-community\.pages\.dev/);
    expect(again.text).not.toMatch(/first preview comes/);
  });
});

describe("the preview email (owner's spec, 23 Sep 2026)", () => {
  const n = previewNotice({ title: "Community site redesign", previewLine: currentPreviewLine(ROW_GREEN), placeholders: FOUR_MISSING.map((m) => m.item), cardId: "wc_c9e36e8b" });
  const r = render(n);

  it("\"<title>: Preview ready\"; the TL;DR is the four reply options, first; then the link, what is still missing, the card", () => {
    expect(r.subject).toBe("Porter: Community site redesign: Preview ready");
    const lines = r.text.split("\n");
    expect(lines[0]).toBe("**TL;DR:** Preview ready, with **4** placeholders. Reply with one of these:");
    expect(lines.slice(1, 5)).toEqual(PREVIEW_REPLY_FORMS.map((f) => `• ${f}`));
    expect(r.text).toMatch(/\*\*Preview\*\*\n• Current preview \(built 12:40 CT, \*\*4\*\* placeholders\): https:\/\/work-wpc-c9e36e8b\.west-peek-community\.pages\.dev\n/);
    expect(r.text).toMatch(/\*\*Still missing \(optional\)\*\*\n• Sengo application link\n/);
    expect(r.text, "no PR link, no proof dump, no details block").not.toMatch(/github\.com|WHAT WAS PROVEN|Full details/);
    expect(lintExecEmail(r.subject, r.text, "Porter")).toEqual([]);
    expect(noticeWords(n)).toBeLessThan(250);
  });

  it("the preview lists what was decided, one line each, and how — so whoever holds the card sees what they signed off", () => {
    const answers = SIX_ASKS.map((a, i) => `${i + 1}. ${a.recommended} (approved as recommended)`);
    const decided = decidedSoFar(SIX_ASKS, answers, "Sequoia");
    expect(decided).toHaveLength(6);
    // "<topic>: <chosen answer, short>" (owner review, 23 Sep 2026) — the answer, not its backstory,
    // and never a line cut mid-sentence.
    expect(decided[0]).toBe("Orange: #c45a3c");
    expect(decided).toEqual(["Orange: #c45a3c", "Workshops copy: ship the brief's wording as written", "History gallery: those nine", "Replacing /about with the history retires public claims now on joinwestpeek.com: retire them", "Image rights: For Ep 2 and 3, use the founder photos already live on westpeek.ventures", "Fonts: self-host Maax"]);
    const r2 = render(previewNotice({ title: "Community site redesign", previewLine: currentPreviewLine(ROW_GREEN), placeholders: [], decided, cardId: "wc_x" }));
    expect(r2.text).toMatch(/\*\*Decided so far\*\*\n(• [^\n(…]+\n){6}/);
    expect(decidedSoFar(SIX_ASKS.slice(0, 1), ["use black, not orange"], "Scooter")).toEqual(["Orange: use black, as Scooter answered"]);
  });

  it("a rebuild is \"New preview ready\" and says what was filled in since the last preview", () => {
    const again = render(previewNotice({ title: "Community site redesign", previewLine: currentPreviewLine(ROW_GREEN), placeholders: ["Sengo logo"], filled: ["Sengo application link"], round: 2, cardId: "wc_x" }));
    expect(again.subject).toBe("Porter: Community site redesign: New preview ready");
    expect(again.text).toMatch(/\*\*Filled in since the last preview\*\*\n• Sengo application link\n/);
  });
});

describe("every notice names its stage, and only STUCK says \"Blocked\"", () => {
  const line = currentPreviewLine(ROW_GREEN);
  const notices: Array<[string, NoticeEmail]> = [
    [STAGE.PLAN, planNotice({ title: "T", asks: SIX_ASKS.slice(0, 1), missing: [], previewLine: line, cardId: "wc_1" })],
    [STAGE.PREVIEW, previewNotice({ title: "T", previewLine: line, placeholders: [], cardId: "wc_1" })],
    [STAGE.REBUILD, previewNotice({ title: "T", previewLine: line, placeholders: [], round: 3, cardId: "wc_1" })],
    [STAGE.QUESTION, questionNotice({ title: "T", question: ["Which Sengo logo — the black or the white?"], previewLine: line, missing: ["Sengo logo"], cardId: "wc_1" })],
    [STAGE.DONE, doneNotice({ title: "T", liveUrls: liveUrlsFrom("https://joinwestpeek.com/ → 200\nhttps://joinwestpeek.com/pitch → 200"), missing: ["Sengo logo"], previewLine: line, cardId: "wc_1" })],
    [STAGE.STUCK, stuckNotice({ title: "T", blockedBy: "the Mac has been asleep for 46 minutes", next: "Sequoia has been told.", previewLine: line, cardId: "wc_1" })],
  ];
  for (const [stage, n] of notices) {
    it(`${stage}: the subject is "<title>: ${stage}", the preview link rides on it, and "blocked" appears only if it is STUCK`, () => {
      const r = render(n);
      expect(r.subject).toBe(`Porter: T: ${stage}`);
      expect(r.text).toMatch(/https:\/\/work-wpc-c9e36e8b\.west-peek-community\.pages\.dev/);
      const said = `${r.subject}\n${r.text}`.replace(/card wc_\S+/g, "");
      if (stage === STAGE.STUCK) expect(r.text).toMatch(/^\*\*TL;DR:\*\* Blocked: the Mac has been asleep for \*\*46\*\* minutes/);
      else expect(said).not.toMatch(/blocked/i);
      expect(lintExecEmail(r.subject, r.text, "Porter")).toEqual([]);
    });
  }
  it("the stage word is never cut; a long title is cut at a word", () => {
    expect(stageSubject("A very long title for a change that goes on and on and on forever", STAGE.REBUILD)).toMatch(/…: New preview ready$/);
  });
});

describe("the preview link: one per site the card changes, the branch alias, never a hash or another site", () => {
  const COMMENT = [
    "## Deploying with Cloudflare Pages",
    "<tr><td><strong>Preview URL:</strong></td><td><a href='https://3f2a1b9c.west-peek-community.pages.dev'>https://3f2a1b9c.west-peek-community.pages.dev</a></td></tr>",
    "<tr><td><strong>Branch Preview URL:</strong></td><td><a href='https://work-wpc-c9e36e8b.west-peek-community.pages.dev'>https://work-wpc-c9e36e8b.west-peek-community.pages.dev&lt;/a></td></tr>",
  ].join("\n");
  const ALL = [COMMENT, COMMENT.replaceAll("west-peek-community", "west-peek-ventures"), COMMENT.replaceAll("west-peek-community", "west-peek-productions")];
  const MANGLED = "https://3f2a1b9c.west-peek-community.pages.dev' · https://work-wpc-c9e36e8b.west-peek-community.pages.dev&lt;/a · https://3f2a1b9c.west-peek-ventures.pages.dev · https://work-wpc-c9e36e8b.west-peek-ventures.pages.dev · https://3f2a1b9c.west-peek-productions.pages.dev · https://work-wpc-c9e36e8b.west-peek-productions.pages.dev";

  it("the real bot comment for a community-only card yields exactly the community branch alias — on the Mac and in the Worker", () => {
    expect(previewUrlsFrom([], ALL, ["west-peek-community.pages.dev"], "work/wpc-c9e36e8b")).toBe("https://work-wpc-c9e36e8b.west-peek-community.pages.dev");
    expect(cleanPreviewUrls(ALL.join("\n"), ["west-peek-community.pages.dev"], "work/wpc-c9e36e8b")).toBe("https://work-wpc-c9e36e8b.west-peek-community.pages.dev");
  });

  it("the mangled value stored on wc_c9e36e8b reaches her as the one clean link", () => {
    expect(currentPreviewLine({ ...ROW_GREEN, preview_url: MANGLED }, [], { pagesHosts: ["west-peek-community.pages.dev"], branch: "work/wpc-c9e36e8b" })).toMatch(/: https:\/\/work-wpc-c9e36e8b\.west-peek-community\.pages\.dev$/);
  });

  it("the two readers agree on every fixture", () => {
    const cases: Array<[string[], string[], string]> = [
      [ALL, ["west-peek-community.pages.dev"], "work/wpc-c9e36e8b"],
      [[COMMENT], [], ""],
      [["https://11aa22bb.west-peek-ventures.pages.dev"], ["west-peek-community.pages.dev"], "b"],
      [["| Preview URL | https://3f9a1c2e-west-peek-live.seq-taylor.workers.dev |"], [], ""],
      [["deployed to https://west-peek-live.seq-taylor.workers.dev"], [], ""],
    ];
    for (const [bodies, hosts, branch] of cases) expect(cleanPreviewUrls(bodies.join("\n"), hosts, branch)).toBe(previewUrlsFrom([], bodies, hosts, branch));
    expect(branchAlias("work/wpc-c9e36e8b")).toBe("work-wpc-c9e36e8b");
  });
});

describe("the words", () => {
  it("a clock time is never bolded as a figure; a figure still is", () => {
    expect(boldNumbers("built 12:40 CT, 4 placeholders")).toBe("built 12:40 CT, **4** placeholders");
  });

  it("\"publish\" and \"changes:\" are read, and each maps to what she asked of a preview", () => {
    expect(readApprovalReply("publish").kind).toBe("PUBLISH");
    expect(readApprovalReply("Publish!\n\nSent from my iPhone").kind).toBe("PUBLISH");
    expect(readApprovalReply("changes: swap the logo")).toEqual({ kind: "REFUSED", text: "changes: swap the logo", changes: true });
    expect(readApprovalReply("no")).toEqual({ kind: "REFUSED", text: "no" });
    expect(rebuildIntentFor("publish")).toBe("PUBLISH");
    expect(rebuildIntentFor("preview")).toBe("PREVIEW");
    expect(rebuildIntentFor("I added missing items")).toBe("PREVIEW");
    expect(rebuildIntentFor("Attached: logo.png")).toBe("PREVIEW");
    expect(rebuildIntentFor("changes: bigger header")).toBe("CHANGES");
    expect(rebuildIntentFor("make the header bigger")).toBe("CHANGES");
    expect(rebuildIntentFor("approved"), "approved lands; it is not a rebuild").toBeNull();
    expect(rebuildIntentFor("stop"), "stop holds").toBeNull();
    expect(rebuildIntentFor("approved to production")).toBeNull();
  });
});

/**
 * THE PREVIEW EMAIL ON wc_c9e36e8b, 14:48, 23 SEP 2026 (owner review). Its subject carried the whole
 * email subject ("Community site redesign — everything is in…"), and three lines were cut mid-sentence
 * with "…". These are the row's real strings.
 */
describe("the preview email, on the live card's real strings", () => {
  const PLACEHOLDERS = [
    "Sengo's current pitch-application link (their prior Airtable invitation is no longer accessible; no public URL found)",
    "Sengo logo",
    "Pitch competition winner records (headshot, company logo, company description, win date per winner)",
    "Episode 4 (Meka Egwuekwe) and Episode 5 (Kimberly Gant) YouTube links",
  ];
  const email = previewNotice({
    title: plainTitle({ title: 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign (j', kind: "WEB_PROPERTY_CHANGE", host: null, subject: "From sequoia@westpeek.ventures: Community site redesign — everything is in the Drive folder", ask: null }),
    previewLine: currentPreviewLine(ROW_GREEN),
    placeholders: PLACEHOLDERS,
    decided: decidedSoFar(SIX_ASKS, SIX_ASKS.map((a, i) => `${i + 1}. ${a.recommended} (approved as recommended)`), "Sequoia"),
    cardId: "wc_c9e36e8b",
  });
  const r = render(email);

  it("the subject uses the card's own plain-title reader: \"Community site redesign: Preview ready\"", () => {
    expect(r.subject).toBe("Porter: Community site redesign: Preview ready");
    expect(stageSubject(plainTitle({ title: "x", kind: "WEB_PROPERTY_CHANGE", host: "joinwestpeek.com", subject: "From a@b.c: Community site redesign — everything is in the Drive folder", ask: null }), STAGE.PREVIEW)).toBe(
      "Community site redesign · joinwestpeek.com: Preview ready",
    );
  });

  it("no line ends in \"…\", and each missing item is its name without the backstory", () => {
    for (const line of r.text.split("\n")) expect(line, `a line cut mid-sentence: ${line}`).not.toMatch(/…\s*$/);
    expect(r.text).toMatch(/\*\*Still missing \(optional\)\*\*\n• Sengo's current pitch-application link\n• Sengo logo\n• Pitch competition winner records\n• Episode \*\*4\*\* \(Meka Egwuekwe\) and Episode \*\*5\*\* \(Kimberly Gant\) YouTube links\n/);
    expect(r.text).toMatch(/• Orange: #c45a3c\n/);
    expect(r.text).not.toMatch(/Airtable|win date|approved by Sequoia/);
  });

  it("clauseLine keeps whole clauses and never adds an ellipsis", () => {
    expect(clauseLine("Yes, #c45a3c, held in one CSS token so a later change is one line", 30)).toBe("Yes, #c45a3c");
    expect(clauseLine("A single very long clause without any boundary at all whatsoever here", 10)).toBe("A single very long clause without any boundary at all whatsoever here");
    expect(clauseLine("Ends with an open (parenthesis that was cut", 90)).toBe("Ends with an open");
    expect(clauseLine("Ep 6 guest headshot (JPG)", 90)).toBe("Ep 6 guest headshot (JPG)");
    expect(clauseLine("Sengo logo (their old one is gone, find a new one)", 90)).toBe("Sengo logo");
  });
});
