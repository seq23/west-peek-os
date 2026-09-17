import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { generateForPartner, type Synthesise } from "../src/worker/services/dailyIntelligence";
import {
  PROMPT_VERSION, REQUIRED_SECTIONS, buildSynthesisPrompt, verifyBrief, buildSources, parseReport,
  type EvidencePacket,
} from "../src/shared/intelligence/reportSchema";
import { DEFAULT_LENS, LENSES, editionLine, lensFor } from "../src/shared/intelligence/interests";

/**
 * ONE BRIEF, TWO LENSES (audit of 15 Sep 2026).
 *
 * The operator asked whether Scooter's brief is built to the same standard as Sequoia's. The
 * guarantee this file pins: both partners are written by the SAME template, held to the SAME
 * required sections and the SAME verifier, and the only thing that differs between the two prompts
 * on one morning is the lens block and the reader's name. The lens comes from the profile row —
 * data — never from a branch on who the partner is.
 */

const SEQUOIA = "fu_sequoia_taylor";
const SCOOTER = "fu_scooter_taylor";

const packet = (over: Partial<EvidencePacket> = {}): EvidencePacket => ({
  report_date: "2026-09-15",
  partner_name: "Sequoia Taylor",
  firm_context: { sectors: ["venture capital"], portfolio: ["Acme"], watchlist: [], themes: [] },
  open_narratives: [],
  events: [
    { event_id: "e1", title: "The ten-year crossed 5%", summary: "Yields rose on inflation worries.", publisher: "Bloomberg", published_at: "2026-09-15T06:00:00Z", categories: ["MACRO"], source_urls: ["https://bloomberg.test/1"], importance: 9, why_ranked: [] },
    { event_id: "e2", title: "A creator platform raised a Series A", summary: "A community-led brand tool raised $12m.", publisher: "TechCrunch", published_at: "2026-09-15T05:00:00Z", categories: ["FUNDING"], source_urls: ["https://techcrunch.test/2"], importance: 6, why_ranked: [] },
  ],
  ...over,
});

describe("the lens is data on the profile, with a safe default", () => {
  it("names two lenses and falls back to the fund's own", () => {
    expect(Object.keys(LENSES).sort()).toEqual(["growth", "investing"]);
    expect(lensFor("growth").label).toBe("marketing & growth lens");
    expect(lensFor("investing").label).toBe("markets & private-markets lens");
    expect(lensFor(null).key).toBe(DEFAULT_LENS);
    expect(lensFor("astrology").key).toBe(DEFAULT_LENS);
  });

  it("carries the categories the operator named", () => {
    expect(LENSES.growth.categories).toEqual(["marketing", "growth", "brand", "creator economy", "community", "events", "go-to-market"]);
    expect(LENSES.investing.categories).toEqual(["markets", "VC and private markets", "secondaries", "legal and the courts", "AI"]);
  });

  it("writes the header line from the first name and the lens", () => {
    expect(editionLine("Scooter Taylor", lensFor("growth"))).toBe("Edition: Scooter — marketing & growth lens");
    expect(editionLine("Sequoia Taylor", lensFor("investing"))).toBe("Edition: Sequoia — markets & private-markets lens");
    expect(editionLine("  ", lensFor(null))).toBe("Edition: Partner — markets & private-markets lens");
  });
});

describe("one template for both partners", () => {
  const forSequoia = packet({ partner_name: "Sequoia Taylor", edition: editionLine("Sequoia Taylor", LENSES.investing), lens: LENSES.investing });
  const forScooter = packet({ partner_name: "Scooter Taylor", edition: editionLine("Scooter Taylor", LENSES.growth), lens: LENSES.growth });

  it("differs between the two partners ONLY in the lens block and the reader's name", () => {
    const a = buildSynthesisPrompt(forSequoia).split("\n");
    const b = buildSynthesisPrompt(forScooter).split("\n");
    expect(a.length).toBe(b.length);
    const differing = a.map((line, i) => [line, b[i]] as const).filter(([x, y]) => x !== y);
    expect(differing.length).toBeGreaterThan(0);
    for (const [x, y] of differing) {
      const lensOrName = /^(READER:|EDITION:|THIS PARTNER'S LENS|WHAT \w+ ALSO FOLLOWS:)/;
      expect(x, `Sequoia's line "${x}" differs from Scooter's "${y}" outside the lens block`).toMatch(lensOrName);
      expect(y).toMatch(lensOrName);
    }
  });

  it("says the same section list, in the same order, to both", () => {
    const list = `${REQUIRED_SECTIONS.join(", ")}. Do not write a citations section`;
    expect(buildSynthesisPrompt(forSequoia)).toContain(list);
    expect(buildSynthesisPrompt(forScooter)).toContain(list);
    // The shared parts of the standard are in both, verbatim.
    for (const shared of ["Current regime", "The most important number on the board", "West Peek read-through", "Investor Importance: N/10"]) {
      expect(buildSynthesisPrompt(forScooter)).toContain(shared);
      expect(buildSynthesisPrompt(forSequoia)).toContain(shared);
    }
  });

  it("makes the lens explicit — 'this partner's lens' — and says emphasis is all it changes", () => {
    const p = buildSynthesisPrompt(forScooter);
    expect(p).toContain("EDITION: Edition: Scooter — marketing & growth lens");
    expect(p).toContain("THIS PARTNER'S LENS — MARKETING & GROWTH LENS. Lead with, and give the most room to: marketing, growth, brand, creator economy, community, events, go-to-market.");
    expect(p).toMatch(/never what is true, and never which\nsections exist/);
    const q = buildSynthesisPrompt(forSequoia);
    expect(q).toContain("THIS PARTNER'S LENS — MARKETS & PRIVATE-MARKETS LENS. Lead with, and give the most room to: markets, VC and private markets, secondaries, legal and the courts, AI.");
  });

  it("holds both partners to the same verifier", () => {
    const thin = `===SECTION executive_summary\nA cited line [1].\n===END`;
    const parsed = parseReport(thin)!;
    const a = verifyBrief(parsed, buildSources(forSequoia), { watchlistEmpty: true });
    const b = verifyBrief(parsed, buildSources(forScooter), { watchlistEmpty: true });
    expect(a).toEqual(b);
    expect(a.map((x) => x.section)).toEqual(expect.arrayContaining(REQUIRED_SECTIONS.filter((k) => k !== "executive_summary")));
  });
});

/**
 * END TO END: two profiles, one fixture, one fake model. Both reach READY on the same prompt
 * version with the same section set; the edition column is the only thing that tells them apart.
 */
// The headlines carry their five Investor Importance scores because a brief without them is
// refused (docs/EXECUTIVE_BRIEF_SPECIFICATION.md §2, verifyBrief). This fixture stands for a good
// brief, so it has to be one.
const HEADLINES = Array.from(
  { length: 5 },
  (_, i) => `**${i + 1}. A headline as a full claim** [1] — why it matters, in **bold** figures.\n\n**Investor Importance: ${i + 2}/10**`,
).join("\n\n");
const OUTPUT = REQUIRED_SECTIONS
  .map(
    (k) =>
      `===SECTION ${k}\n${k === "top_headlines" ? HEADLINES : `A substantial paragraph about ${k}, with the figure in **bold** and a citation [1].`}\n===END`,
  )
  .join("\n");
const prompts: Record<string, string> = {};
const fakeModel: Synthesise = async (_env, _actor, prompt, _date, firmUserId) => {
  prompts[firmUserId] = prompt;
  return { output: OUTPUT, aiRunId: null, model: "fake-test-model" };
};
const DEPS = {
  macro: async () => ({ readings: [], failures: [] }),
  market: async () => ({ ok: true, levels: [], calendar: [], citations: [], aiRunId: null, detail: "offline" }),
};

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: SEQUOIA, roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const NOW = new Date("2026-09-15T12:00:00Z"); // a Tuesday

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const run = (sql: string) => env.WP_OS_DB.prepare(sql).run();
  const src = await env.WP_OS_DB.prepare("SELECT id FROM intelligence_source LIMIT 1").first<{ id: string }>();
  const bind = src?.id ? `'${src.id}'` : "NULL";
  await run(`INSERT INTO intelligence_run (id, trigger_kind, idempotency_key, status, requested_by_type, requested_by_id, firm_scope)
    VALUES ('irun_lens','MANUAL','lens-run','SUCCEEDED','HUMAN','${SEQUOIA}','west-peek')`);
  await run(`INSERT INTO intelligence_item (id, run_id, source_id, dedupe_hash, title, body, url, published_at, category, firm_scope, created_at) VALUES
    ('ii_l1', 'irun_lens', ${bind}, 'h_l1', 'The ten-year crossed five percent', 'Treasury yields rose above five percent on inflation worries, dragging equities lower.', 'https://bloomberg.test/l1', '2026-09-15T06:00:00Z', 'MARKET', 'west-peek', '2026-09-15T06:00:00Z'),
    ('ii_l2', 'irun_lens', ${bind}, 'h_l2', 'A creator platform raised a Series A', 'A community-led brand tool raised twelve million dollars to sell to marketers.', 'https://techcrunch.test/l2', '2026-09-15T05:00:00Z', 'FUNDING_MA', 'west-peek', '2026-09-15T05:00:00Z')`);
  // The profiles ARE the difference. Scooter's lens was seeded by migration 0165; Sequoia has none.
  await run(`INSERT OR IGNORE INTO partner_intelligence_profile (firm_user_id, timezone, lens) VALUES ('${SEQUOIA}', 'America/New_York', 'investing')`);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("both partners, end to end", () => {
  it("seeds Scooter's lens as growth by migration and leaves Sequoia on the fund's own", async () => {
    const rows = (await env.WP_OS_DB.prepare("SELECT firm_user_id, lens FROM partner_intelligence_profile ORDER BY firm_user_id").all<{ firm_user_id: string; lens: string }>()).results ?? [];
    expect(rows).toEqual([{ firm_user_id: SCOOTER, lens: "growth" }, { firm_user_id: SEQUOIA, lens: "investing" }]);
  });

  it("produces the same section set on the same prompt version, with only the edition differing", async () => {
    const a = await generateForPartner(env, MP, SEQUOIA, NOW, fakeModel, DEPS);
    const b = await generateForPartner(env, MP, SCOOTER, NOW, fakeModel, DEPS);
    expect(a.status).toBe("READY");
    expect(b.status).toBe("READY");

    const reports = (await env.WP_OS_DB.prepare(
      "SELECT firm_user_id, prompt_version, edition FROM intelligence_report WHERE report_date = '2026-09-15' ORDER BY firm_user_id",
    ).all<{ firm_user_id: string; prompt_version: string; edition: string }>()).results ?? [];
    expect(reports).toEqual([
      { firm_user_id: SCOOTER, prompt_version: PROMPT_VERSION, edition: "Edition: Scooter — marketing & growth lens" },
      { firm_user_id: SEQUOIA, prompt_version: PROMPT_VERSION, edition: "Edition: Sequoia — markets & private-markets lens" },
    ]);

    const sectionsOf = async (id: string) =>
      ((await env.WP_OS_DB.prepare(
        `SELECT s.section_key, s.heading, s.position FROM intelligence_report_section s JOIN intelligence_report r ON r.id = s.report_id
          WHERE r.firm_user_id = ?1 AND r.report_date = '2026-09-15' ORDER BY s.position`,
      ).bind(id).all<{ section_key: string; heading: string; position: number }>()).results ?? []);
    const sa = await sectionsOf(SEQUOIA);
    const sb = await sectionsOf(SCOOTER);
    expect(sa.length).toBe(REQUIRED_SECTIONS.length + 1); // + the system-written Sources footer
    expect(sb).toEqual(sa);

    // The prompts the model saw differ only in the lens block and the reader's name.
    const pa = prompts[SEQUOIA]!.split("\n");
    const pb = prompts[SCOOTER]!.split("\n");
    expect(pa.length).toBe(pb.length);
    const differing = pa.map((line, i) => [line, pb[i]] as const).filter(([x, y]) => x !== y);
    expect(differing.length).toBeGreaterThan(0);
    for (const [x] of differing) expect(x).toMatch(/^(READER:|EDITION:|THIS PARTNER'S LENS|WHAT \w+ ALSO FOLLOWS:|- (sectors|themes):)/);
  });
});
