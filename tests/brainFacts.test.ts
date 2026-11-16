import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { businessesFor, subsection, wordLookup } from "../src/shared/brain/brainSections";
// @ts-expect-error — a plain .mjs script with no type declarations.
import { brainFactsFrom } from "../scripts/lib/brain-facts.mjs";
import { writeProfile } from "../src/worker/services/partnerProfile";
import { knownFor, understand, type Reader } from "../src/worker/services/partnerUnderstood";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { systemIdentity } from "../src/worker/services/dealIntake";

/**
 * THE FIRST READ GETS THE BRAIN'S SETTLED FACTS (15 Nov 2026: "west Peek productions and top barz are diff entities why
 * would anything re top barz be unclear?"). The Mac takes the brain's Partners and Businesses sections and the word
 * lookup (never the whole body, private spans removed) and writes them onto the profile through the existing route;
 * the reader then gets the sender's section, the card's business, Top Barz when the email names it, and the lookup,
 * whole. The brain below is made up.
 */
const BRAIN = [
  "# West Peek",
  "## Company",
  "- the opening section nobody needs here",
  "## Partners",
  "### Scooter Taylor (Managing Partner)",
  "- **Roles:** co-MP; never logs into the OS (20 Sep).",
  "- **Standing holds (his own emails, recorded 15 Nov 2026):** Nothing goes live without his OK on a preview · \"Do not build invoice or billing features yet\"",
  "- Prefers short emails.",
  "<!-- confidential -->a private line<!-- /confidential -->",
  "### Sequoia Taylor",
  "- Her own section.",
  "## Businesses and projects",
  "### West Peek Productions (the agency)",
  "The agency's pipeline holds only agency clients.",
  "### Top Barz",
  "A separate entity: the CultureCon contest. Never part of the Productions pipeline.",
  "### West Peek (the community)",
  "The community.",
  "#### Which business is this word?",
  "- \"studio\" = West Peek Productions",
  "## Settled decisions",
  "- a long list nobody needs here",
].join("\n");

let t: TestDb;
let env: Env;
beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => disposeTestDb(t));

describe("on the Mac: only the sections, never the whole brain", () => {
  it("takes Partners and Businesses (with the lookup), drops private spans and every other section", () => {
    const { md, missing } = brainFactsFrom(BRAIN);
    expect(missing).toEqual([]);
    expect(md).toContain("### Scooter Taylor");
    expect(md).toContain("### Top Barz");
    expect(md).toContain("Which business is this word?");
    expect(md).not.toContain("a private line");
    expect(md).not.toContain("nobody needs here");
    expect(brainFactsFrom("# x\n## Company\n- y").missing).toEqual(["## Partners", "## Businesses and projects", "which business is this word?"]);
  });

});

describe("in the Worker: the reader's settled facts", () => {
  it("are his section, the card's business, Top Barz and the lookup, whole; and a reader given them flags nothing about Top Barz", async () => {
    expect(businessesFor("Porter: westpeekproductions.com dashboard", "Keep the Top Barz rows out.")).toEqual(["West Peek Productions", "Top Barz"]);
    expect(subsection(BRAIN, "Nobody")).toBeNull();
    expect(wordLookup(BRAIN)).toContain('"studio" = West Peek Productions');

    await writeProfile(env, "scooter@westpeek.ventures", { brain_md: brainFactsFrom(BRAIN).md });
    const card = await createWorkCardInternal(env, systemIdentity(), { title: "Porter: westpeekproductions.com dashboard", description: "x", owner_type: "AI", owner_id: "aie_porter", priority: "NORMAL", firm_scope: "west-peek", next_action: "x" });
    const written = "Keep this pipeline studio-only. Leave the Top Barz rows out.";
    const known = await knownFor(env, card.id, "west-peek", "scooter@westpeek.ventures", written);
    for (const want of ["### Scooter Taylor", "### West Peek Productions", "### Top Barz", "Which business is this word?"]) expect(known.text).toContain(want);
    expect(known.text).not.toContain("### Sequoia Taylor");
    expect(known.text).not.toContain("a private line");
    expect(known.standingHolds, "only his Standing holds line, one per item; his roles line is context, never a hold").toEqual(["Nothing goes live without his OK on a preview", "Do not build invoice or billing features yet"]);

    const reader: Reader = { name: "CLAUDE", read: async (_e, input) => ({ ok: true, detail: "ok", reader: "CLAUDE", text: input.prompt.includes("Never part of the Productions pipeline") ? "ASK: Keep this pipeline studio-only." : "ASK: Keep this pipeline studio-only.\nUNCLEAR: Leave the Top Barz rows out :: is Top Barz part of Productions?" }) };
    const out = await understand(env, { subject: "d", written, read: [reader], employeeId: null, firmScope: "west-peek", known: known.text, standingHolds: known.standingHolds });
    expect(out.brief.unclear, "Top Barz is settled, so nothing about it is unclear").toEqual([]);
    expect(out.brief.holds, "his standing hold counts though the email does not repeat it").toContain("Nothing goes live without his OK on a preview");
  });
});

describe("an idea for later is noted, never also a hold", () => {
  it("lists it once, as noted, and keeps his real holds", async () => {
    const written = "1. Rename \"Who is buying\" to \"Organization type.\"\n2. Remove \"Source\" from the deal view. Don't delete or change those tracker rows.\n\nTranscript-assisted Discovery notes are an idea for later, not part of this round.";
    const idea = "Transcript-assisted Discovery notes are an idea for later, not part of this round.";
    const reader: Reader = { name: "CLAUDE", read: async () => ({ ok: true, detail: "ok", reader: "CLAUDE", text: `ASK: Rename "Who is buying" to "Organization type."\nASK: Remove "Source" from the deal view.\nHOLD: Don't delete or change those tracker rows.\nHOLD: ${idea}` }) };
    const out = await understand(env, { subject: "d", written, read: [reader], employeeId: null, firmScope: "west-peek" });
    expect(out.noted.some((n) => /idea for later/.test(n)), "the idea is kept as noted").toBe(true);
    expect(out.brief.holds.filter((h) => /idea for later/.test(h)), "and is not a hold").toEqual([]);
    expect(out.brief.holds.some((h) => /tracker rows/.test(h)), "his real hold stays").toBe(true);
  });
});

describe("a reader that lists no holds does not cost him his own", () => {
  it("keeps the hold his typed email carries, and the brain's go-live hold collapses into it", async () => {
    const written = "1. Move \"What we do\" above \"Who we work with.\"\n2. Remove the badge row.\n\nEverything below stays in the preview for me to check first; nothing goes live.";
    const reader: Reader = { name: "WORKERS_AI", read: async () => ({ ok: true, detail: "ok", reader: "WORKERS_AI", text: "ASK: Move \"What we do\" above \"Who we work with.\"\nASK: Remove the badge row." }) };
    const out = await understand(env, { subject: "site", written, read: [reader], employeeId: null, firmScope: "west-peek", standingHolds: ["Do not publish or go live with anything - I approve each step", "Do not build invoice or billing features yet"] });
    expect(out.brief.holds).toEqual(["Everything below stays in the preview for me to check first; nothing goes live.", "Do not build invoice or billing features yet"]);
  });
});
