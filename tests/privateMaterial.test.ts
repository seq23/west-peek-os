import { describe, expect, it } from "vitest";
import { privateMaterialConstraint, privateMaterialSentence } from "../src/shared/intake/privateMaterial";
import { PASSAGE_WORDS, privateDocsIn, privateProof, privateSentenceIn } from "../scripts/duties/private-proof.mjs";

/**
 * #357 (13 Nov 2026): a partner's "keep this private" in a build request rides on the job as a standing constraint and
 * keeps it private-model-only (webPropertyChange.parkPhase). The phrasing below is a stand-in of the same shape, not
 * the partner's text.
 */
describe("a partner's privacy instruction is read off the request", () => {
  it("finds the sentence that asks for privacy, in the shapes partners write it", () => {
    const req = "We're ready to build the site. Start with the plan in the folder. The plan doc is for you two and me only, so please don't copy or forward it. The brand folder will fill in.";
    expect(privateMaterialSentence([req])).toBe("The plan doc is for you two and me only, so please don't copy or forward it.");
    expect(privateMaterialSentence(["Use the deck. Keep this private."])).toBe("Keep this private.");
    expect(privateMaterialSentence(["The pricing sheet is confidential."])).toBe("The pricing sheet is confidential.");
    expect(privateMaterialSentence([null, "Do not forward the numbers doc to anyone."])).toBe("Do not forward the numbers doc to anyone.");
  });

  it("NEGATIVE: an ordinary request carries no privacy rule", () => {
    for (const plain of [
      "Change the hero copy on westpeekproductions.com and add the new logo from the folder.",
      "Add a private beta sign-up form and a privacy policy page.",
      "Copy the footer from the main site and forward the contact form to Scooter.",
    ]) {
      expect(privateMaterialSentence([plain]), plain).toBeNull();
    }
  });

  it("the constraint quotes the partner and forbids every public surface", () => {
    const c = privateMaterialConstraint("Keep this private.");
    expect(c).toContain('"Keep this private."');
    for (const surface of ["repo", "commit", "PR", "preview", "email"]) expect(c).toContain(surface);
  });
});

/**
 * #357, the proof (owner's ruling, 13 Nov 2026): what is private in a private document is its substance — figures,
 * names, and its finance, contract, pay and targets sections. Those fail the build. Plain prose used as site copy,
 * when the partner's own material names the document as the source, is recorded and does not fail it. Every word
 * below is invented for this test; nothing here is a partner's document.
 */
describe("BUILD proves what is private in the private document stayed out of the PR (#357)", () => {
  const SENTENCE = "The ledger doc is for you two and me only, so please don't copy or forward it.";
  const CONSTRAINTS = ["Scooter's own track is never in the vote", privateMaterialConstraint(SENTENCE)];
  const PATHS = ["00-start/Read me first.txt", "00-start/Orchard ledger v3", "01-site/Site brief.txt"];
  const DOC = "00-start/Orchard ledger v3";
  const SECRET = [
    "Who we are",
    "We grow pears on the north hill and press cider in the old stone cellar every single autumn for our neighbours.",
    "Our people",
    "The pressing is led every season by our friend Marguerite Vandersloot who also keeps the bees.",
    "Money and targets",
    "We want to sell far more cider to the village shops and the two markets before the frost comes.",
    "Next season",
    "The cellar should hold 90 barrels and the shop price moves to twelve dollars a bottle by spring.",
  ].join("\n");
  const docs = [{ path: DOC, text: SECRET }];
  // The partner's public material: his README names the ledger as the source for the site.
  const README = "Start here. The ledger is the source for the website. The site brief has the page list.";
  const diffOf = (...added: string[]) => ["diff --git a/site/index.html b/site/index.html", "--- a/site/index.html", "+++ b/site/index.html", "@@ -1,2 +1,9 @@", " <main>", ...added.map((l) => `+${l}`), " </main>"].join("\n");
  const run = (diff: string | null, publicTexts: string[] = [README]) => privateProof({ constraints: CONSTRAINTS, paths: PATHS, docs, diff, publicTexts });

  it("the Worker's constraint is the one the Mac reads, and it names the document by the partner's own word or by a private file name", () => {
    expect(privateSentenceIn(CONSTRAINTS)).toBe(SENTENCE);
    expect(privateSentenceIn(["Scooter's own track is never in the vote"])).toBeNull();
    expect(privateDocsIn(PATHS, SENTENCE), "'ledger' is his word for it").toEqual([DOC]);
    expect(privateDocsIn(["a/Plan (full, private)", "a/Site brief.txt"], "Keep this private.")).toEqual(["a/Plan (full, private)"]);
  });

  it("a clean PR passes and says how many documents it read", () => {
    const out = run(diffOf("<h1>Pears and cider from the hill</h1>", "<p>Visit us each autumn.</p>"));
    expect(out).toMatchObject({ ok: true, checked: 1, used: [] });
    expect(out.line).toContain("1 document(s) read");
  });

  it("plain prose used as site copy, on a job whose material names the document as the source, is recorded with file and line and does not fail", () => {
    const out = run(diffOf("<h1>Welcome</h1>", "<p>We grow pears on the <b>north hill</b> and press cider in the old stone cellar — every single autumn.</p>"));
    expect(out.ok).toBe(true);
    expect(out.used).toEqual([{ file: "site/index.html", line: 3, words: 18 }]);
    expect(out.line).toContain("1 plain-prose passage(s)");
    expect(out.line).toContain("site/index.html:3");
    // The same prose fails when nothing public names the document as a source.
    expect(run(diffOf("<p>We grow pears on the north hill and press cider in the old stone cellar.</p>"), ["Start here. The site brief has the page list."]).ok).toBe(false);
  });

  it("a passage with a figure, with a name from the document, or from a money or targets section fails the build, and the failure never repeats the document's words", () => {
    const cases: Array<[string, RegExp]> = [
      ["<p>The cellar should hold 90 barrels and the shop price moves on.</p>", /number, amount or date/],
      ["<p>The pressing is led every season by our friend Marguerite Vandersloot.</p>", /name from the document/],
      ["<p>we want to sell far more cider to the village shops, and the two markets</p>", /finance, contract, pay or targets section/],
    ];
    for (const [leak, why] of cases) {
      const out = run(diffOf("<h1>Welcome</h1>", leak));
      expect(out.ok, leak).toBe(false);
      expect(out.reason, leak).toMatch(why);
      expect(out.reason).toContain(DOC);
      expect(out.reason).toContain("site/index.html:3");
      expect(out.files).toEqual(["site/index.html"]);
      expect(out.reason).not.toMatch(/barrels|Marguerite|Vandersloot|village shops|twelve dollars/i);
    }
    // A line the PR REMOVES, and an overlap shorter than a passage, are not a copy.
    expect(run(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +0,0 @@", "-The cellar should hold 90 barrels and the shop price moves on."].join("\n")).ok).toBe(true);
    const short = "The cellar should hold 90 barrels and the shop price".split(" ").slice(0, PASSAGE_WORDS - 1).join(" ");
    expect(run(diffOf(`<p>${short}</p>`)).ok).toBe(true);
  });

  it("a privacy rule with nothing checked is a failure: no document identified, the document unreadable, or the diff unreadable", () => {
    const clean = diffOf("<h1>Welcome</h1>");
    const none = privateProof({ constraints: CONSTRAINTS, paths: ["01-site/Site brief.txt"], docs: [], diff: clean, publicTexts: [README] });
    expect(none).toMatchObject({ ok: false, checked: 0 });
    const unreadable = privateProof({ constraints: CONSTRAINTS, paths: PATHS, docs: [{ path: DOC, text: null }], diff: clean, publicTexts: [README] });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reason).toContain("could not be read");
    expect(run(null).ok).toBe(false);
    // No privacy rule on the job: nothing to prove, nothing fails.
    expect(privateProof({ constraints: ["Scooter's own track is never in the vote"], paths: PATHS, docs: [], diff: clean })).toEqual({ ok: true, checked: 0, line: null });
  });
});
