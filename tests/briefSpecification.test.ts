import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HEADLINES_REQUIRED,
  REPORT_SECTIONS,
  REQUIRED_SECTIONS,
  buildSynthesisPrompt,
  importanceScores,
  parseReport,
  verifyBrief,
  buildSources,
  type EvidencePacket,
} from "../src/shared/intelligence/reportSchema";

/**
 * THE SPECIFICATION IS THE THING THE GENERATOR OBEYS, NOT A DOCUMENT BESIDE IT.
 *
 * `docs/EXECUTIVE_BRIEF_SPECIFICATION.md` is the operator's own description of the morning brief:
 * eleven named sections in order, the dashboard rows, the regime strip, a score on every headline,
 * the exclusions, the watchlist substitution, and the rule she cares about most — never invent a
 * live number.
 *
 * It sat in `docs/` as an untracked file for a day. A specification nothing reads is exactly the
 * void that swallowed her instruction to Parker: written down, stored, obeyed by nothing. So this
 * suite READS THE DOCUMENT and compares it with the code. Add a section to the spec without adding
 * it to `REPORT_SECTIONS` and the build fails; rename a section key in the code and the build
 * fails. Neither can drift quietly, which is the only durable version of "the code follows the
 * spec".
 *
 * RULE 0: every test here counts what it examined and fails on zero. A regex that silently matches
 * nothing in a document that has been reformatted would otherwise report the spec as satisfied by
 * examining none of it — which is precisely the defect class this repo keeps finding.
 */

const SPEC = readFileSync(new URL("../docs/EXECUTIVE_BRIEF_SPECIFICATION.md", import.meta.url), "utf8");

/** The `| n | Section | `key` |` table in the spec, in the order the rows are written. */
function specSections(): Array<{ n: number; label: string; key: string }> {
  const rows: Array<{ n: number; label: string; key: string }> = [];
  for (const m of SPEC.matchAll(/^\|\s*(\d{1,2})\s*\|\s*([^|]+?)\s*\|\s*`([a-z_]+)`\s*\|$/gm)) {
    rows.push({ n: Number(m[1]), label: m[2]!.trim(), key: m[3]! });
  }
  return rows;
}

/** Everything in a fixed-width code span in one named section of the spec. */
function backticked(heading: string): string[] {
  const start = SPEC.indexOf(`## ${heading}`);
  if (start < 0) return [];
  const rest = SPEC.slice(start + heading.length);
  const end = rest.indexOf("\n## ");
  return Array.from((end < 0 ? rest : rest.slice(0, end)).matchAll(/`([^`]+)`/g)).map((m) => m[1]!);
}

const packet = (): EvidencePacket => ({
  report_date: "2026-09-16",
  partner_name: "Sequoia Taylor",
  firm_context: { sectors: [], portfolio: [], watchlist: [], themes: [] },
  open_narratives: [],
  events: [
    { event_id: "iitem_a", title: "Fed cuts", summary: "…", publisher: "Reuters", published_at: null, categories: [], source_urls: ["https://reuters.test/fed"], importance: 5, why_ranked: [] },
  ],
  macro_readings: [{ label: "10-year Treasury yield", value: "4.96%", asOf: "2026-09-11", sourceUrl: "https://fred.stlouisfed.org/series/DGS10", sourceName: "FRED DGS10" }],
  macro_failures: [{ label: "Brent crude", detail: "HTTP 503" }],
  market_citations: ["https://cnbc.test/premarket"],
  watchlist_entries: [],
});

describe("the specification and the generator say the same thing", () => {
  it("names eleven sections, and the code requires exactly those, in that order", () => {
    const rows = specSections();
    expect(rows.length, "Rule 0: no section rows were read out of the specification — has the table been reformatted?").toBe(11);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(rows.map((r) => r.key)).toEqual([...REQUIRED_SECTIONS]);
  });

  it("every key the specification names is a real section in the schema, and the schema leads with them", () => {
    const rows = specSections();
    const known = new Set(REPORT_SECTIONS.map((s) => s.key as string));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(known.has(r.key), `the specification names "${r.key}", which the schema does not have`).toBe(true);
    // The eleven come first, then the system-written footer. Anything after that is legacy shape
    // kept so reports written by an older prompt still render.
    expect(REPORT_SECTIONS.slice(0, 12).map((s) => s.key)).toEqual([...REQUIRED_SECTIONS, "citations"]);
  });

  it("asks the model for every dashboard row the specification lists", () => {
    const rows = backticked("The dashboard rows, exactly");
    expect(rows.length, "Rule 0: no dashboard rows were read out of the specification").toBe(8);
    const prompt = buildSynthesisPrompt(packet());
    for (const row of rows) expect(prompt, `the prompt never mentions the dashboard row "${row}"`).toContain(row);
  });

  it("asks the model for every regime the specification lists, with the three tones", () => {
    // The nine regimes, then the three tone WORDS the panel turns into the operator's lights. The
    // spec section explains why the light is not an emoji in the stored text; the vocabulary is
    // asserted in both directions so the prompt and the renderer cannot drift apart.
    const named = backticked("The regime strip, exactly");
    const regimes = named.filter((n) => !["GREEN", "YELLOW", "RED"].includes(n));
    const tones = named.filter((n) => ["GREEN", "YELLOW", "RED"].includes(n));
    expect(regimes.length, "Rule 0: no regimes were read out of the specification").toBe(9);
    expect(tones.length, "Rule 0: the specification names no tone vocabulary").toBe(3);
    // Wrapped, because the prompt hard-wraps its own lines and "PE fundraising" straddles one.
    const prompt = buildSynthesisPrompt(packet()).replace(/\s+/g, " ");
    for (const r of regimes) expect(prompt, `the prompt never mentions the regime "${r}"`).toContain(r);
    for (const tone of tones) expect(prompt, `the prompt never asks for the tone "${tone}"`).toContain(tone);
    expect(prompt).toContain("Current regime");
    expect(prompt).toContain("The most important number on the board");
  });

  it("renders every tone the prompt asks for — the strip is words in the record and lights on the page", () => {
    const tones = backticked("The regime strip, exactly").filter((n) => ["GREEN", "YELLOW", "RED"].includes(n));
    expect(tones.length, "Rule 0: no tones examined").toBe(3);
    // The panel's own rule, restated here so a change to one side fails rather than silently
    // producing a strip that renders as plain text. Kept as the same expression the panel uses.
    const readLight = (line: string) =>
      line.replace(/^[-*·]\s+/, "").match(/^\*{0,2}([A-Za-z][A-Za-z /&-]{1,40}?)\*{0,2}:\s*\*{0,2}(GREEN|YELLOW|RED)\*{0,2}\s*[—–-]\s*(.+)$/i);
    for (const tone of tones) {
      expect(readLight(`Equities: ${tone} — earnings strong, discount-rate pressure rising`), `the panel cannot read the tone "${tone}"`).toBeTruthy();
    }
    expect(readLight("Equities: TEAL — a tone nobody agreed on")).toBeNull();
  });

  it("keeps the exclusions structural: a section the schema does not know is discarded, not asked about", () => {
    const parsed = parseReport(
      "===SECTION executive_summary\nA substantial paragraph that carries a claim worth reading [1].\n===END\n" +
        "===SECTION astrology\nMercury is in retrograde and the markets feel it.\n===END",
    );
    expect(parsed, "the parser returned nothing at all").toBeTruthy();
    expect(parsed!.length).toBe(1);
    expect(parsed!.map((s) => s.key)).toEqual(["executive_summary"]);
  });

  it("puts the firm's own watchlist in front of the model rather than a company of its choosing", () => {
    const withEntries = buildSynthesisPrompt({ ...packet(), watchlist_entries: [{ label: "Sensori", note: "deck read in August" }] });
    expect(withEntries).toContain("Sensori");
    const empty = buildSynthesisPrompt(packet());
    expect(empty).toContain("EMPTY — the firm has no watchlist entries recorded");
    // The operator's example tracked SpaceX. Ours must never name a company the firm did not.
    expect(empty).not.toContain("SpaceX");
  });

  it("carries the never-invent-a-number rule into the prompt, by name and with the sentence to use", () => {
    const prompt = buildSynthesisPrompt(packet());
    expect(prompt).toContain("Never invent a number");
    expect(prompt).toContain("COULD NOT BE FETCHED");
    expect(prompt).toContain("Brent crude (HTTP 503)");
    expect(prompt).toMatch(/I do not have a reliable print/);
  });
});

describe("a brief that loses what the specification asks for is refused", () => {
  const headlines = Array.from({ length: HEADLINES_REQUIRED }, (_, i) => `Headline ${i + 1} [1]. Why it matters: it moves a number this firm watches. **Investor Importance: ${i + 2}/10**`).join("\n\n");
  const full = (over: Partial<Record<string, string>> = {}) =>
    REQUIRED_SECTIONS.map(
      (k) => `===SECTION ${k}\n${over[k] ?? (k === "top_headlines" ? headlines : `A substantial paragraph about ${k} that carries a claim worth reading [1].`)}\n===END`,
    ).join("\n");

  const sources = () => buildSources(packet());

  it("passes a brief that has every section, every citation and every score", () => {
    const problems = verifyBrief(parseReport(full())!, sources(), { watchlistEmpty: true });
    expect(problems, `a compliant brief was refused: ${problems.map((p) => p.detail).join("; ")}`).toEqual([]);
    expect(REQUIRED_SECTIONS.length, "Rule 0: the verifier examined no sections").toBeGreaterThan(0);
  });

  it("refuses a brief whose headlines lost their Investor Importance scores", () => {
    const stripped = headlines.replace(/\*\*Investor Importance: \d+\/10\*\*/g, "");
    const problems = verifyBrief(parseReport(full({ top_headlines: stripped }))!, sources(), { watchlistEmpty: true });
    expect(problems.map((p) => p.problem)).toEqual(["missing_importance_score"]);
    expect(problems[0]!.detail).toContain("0 Investor Importance");
  });

  it("refuses a brief scored four headlines out of five", () => {
    const four = headlines.replace(/\n\n[^\n]*Investor Importance: 6\/10\*\*/, "");
    expect(importanceScores(four).length).toBe(4);
    const problems = verifyBrief(parseReport(full({ top_headlines: four }))!, sources(), { watchlistEmpty: true });
    expect(problems.map((p) => p.problem)).toEqual(["missing_importance_score"]);
  });

  it("refuses a score that is not on the scale", () => {
    const problems = verifyBrief(parseReport(full({ top_headlines: `${headlines}\n\nSixth [1]. **Investor Importance: 44/10**` }))!, sources(), { watchlistEmpty: true });
    expect(problems.map((p) => p.problem)).toEqual(["missing_importance_score"]);
    expect(problems[0]!.detail).toContain("44/10");
  });

  it("refuses a brief that dropped its citations, and one that typed a URL instead of citing", () => {
    const noCite = verifyBrief(parseReport(full({ ai_technology: "A long enough paragraph about AI carrying no numbered source at all." }))!, sources(), { watchlistEmpty: true });
    expect(noCite.map((p) => `${p.section}:${p.problem}`)).toEqual(["ai_technology:no_citation"]);
    const typed = verifyBrief(parseReport(full({ watch: "One thing to watch, said at length, per https://invented.test/story and nothing else [1]." }))!, sources(), { watchlistEmpty: true });
    expect(typed.map((p) => p.problem)).toContain("invented_url");
  });

  it("refuses a brief that lost a section the specification requires, naming it", () => {
    for (const key of REQUIRED_SECTIONS) {
      const raw = full().replace(new RegExp(`===SECTION ${key}\\n[\\s\\S]*?===END`), "");
      const problems = verifyBrief(parseReport(raw)!, sources(), { watchlistEmpty: true });
      expect(problems.some((p) => p.problem === "missing_section" && p.section === key), `losing "${key}" was not refused`).toBe(true);
    }
    expect(REQUIRED_SECTIONS.length).toBe(11);
  });
});
