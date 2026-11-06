import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { COMMUNITY_ABOUT, overstatedCommunityClaims, trueCommunityWords } from "../src/shared/community/size";

/**
 * OUTREACH NEVER CLAIMS A BIGGER COMMUNITY THAN THE SOURCE OF TRUTH (risk R-PRF-04 / R-EVT-03, found 2 Nov 2026).
 * Brand emails, Wynn's "who we are" row and queued drafts said "more than 5,000"; the brain's figure is
 * "about 5,000" and the only measured count is 4,712. Fake brands and addresses only.
 */
let t: TestDb;
let env: Env;
beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => { await disposeTestDb(t); });

const OLD_PROOF = "Our community of more than 5,000 founders, operators and creatives meets in person through West Peek Rooms, our event series in New York.";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx|md|html|json)$/.test(n) ? [p] : [];
  });
}

describe("outreach text cannot claim a community count above the source of truth", () => {
  it("the check catches an overstated count, every text we write passes it, and stored text is read through it", async () => {
    // 1 · The check sees an overstatement (negative proof), and leaves money and other counts alone.
    for (const bad of [OLD_PROOF, "a community of 5,000+ founders", "West Peek community: more than 5,000 founders", "over 5,000 members", "6,000 people", "a 5,000-person community of more than 5,000"]) {
      expect(overstatedCommunityClaims(bad), bad).not.toEqual([]);
      expect(overstatedCommunityClaims(trueCommunityWords(bad)), bad).toEqual([]);
    }
    expect(trueCommunityWords(OLD_PROOF)).toBe(OLD_PROOF.replace("more than 5,000", "about 5,000"));
    for (const fine of ["a community of about 5,000 founders", "community of ~5,000", "A Partner seat is $5,000 people love", "a pop-up with 5,000+ visitors", "4,712 contacts"]) {
      expect(overstatedCommunityClaims(fine), fine).toEqual([]);
    }

    // 2 · No source file says more than the truth, and the words brands read carry the true figure.
    const files = sourceFiles(join(__dirname, "../src"));
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((f) => overstatedCommunityClaims(readFileSync(f, "utf8")).map((c) => `${f}: ${c}`));
    expect(found).toEqual([]);
    const { TLC_DRIP_PROOF_LINE, TLC_ABOUT_COMMUNITY, TLC_ABOUT_WEST_PEEK, dripEmail } = await import("../src/shared/tlc/learningClub");
    const { ownerAngleFirstEmail } = await import("../src/shared/tlc/ownerInstruction");
    const { DECK_SLIDES } = await import("../src/shared/deck/definition");
    const told = [
      TLC_DRIP_PROOF_LINE, TLC_ABOUT_COMMUNITY, TLC_ABOUT_WEST_PEEK,
      dripEmail({ step: 0, brand: "Vector Co", contactName: "Pat", topic: "Fragrance Lab", month: "2027-02", eventDate: "2027-02-11", why: null }).text,
      ownerAngleFirstEmail({ brand: "Vector Co", contactName: "Pat", topic: "Fragrance Lab", month: "2027-02", angleLine: null }).text,
      JSON.stringify(DECK_SLIDES),
    ];
    for (const text of told) {
      // Brand-facing text says it grew to nearly 5,000 at its height (owner, 6 Nov 2026); the firm's own says about 5,000.
      expect(text).toMatch(new RegExp(`${COMMUNITY_ABOUT}|nearly 5,000`));
      expect(overstatedCommunityClaims(text)).toEqual([]);
    }

    // 3 · Stored text: Wynn's WHO_WE_ARE row (seeded by migration 0273 with the old words) reaches a draft as the truth,
    //     a queued brand email is corrected before it goes, a sent one stays as history, and a draft that overstates is refused.
    const { wynnRules, draftProblems } = await import("../src/worker/services/tlcBrandReply");
    const stored = await env.WP_OS_DB.prepare("SELECT rule FROM tlc_wynn_rule WHERE code = 'WHO_WE_ARE'").first<{ rule: string }>();
    expect(overstatedCommunityClaims(stored!.rule)).not.toEqual([]);
    const who = (await wynnRules(env)).find((r) => r.code === "WHO_WE_ARE")!.rule;
    // Read the 6 Nov 2026 way: a community that grew to nearly 5,000 at its height, never a size today.
    expect(who).toContain("community that grew to nearly 5,000 people at its height");
    expect(overstatedCommunityClaims(who)).toEqual([]);
    expect(draftProblems(`Hi Pat,\n\n${OLD_PROOF}`, "INTERESTED" as never).join("|")).toMatch(/community size above the true one/);
    expect(draftProblems(`Hi Pat,\n\n${TLC_DRIP_PROOF_LINE}`, "INTERESTED" as never).join("|")).not.toMatch(/community size/);

    const { fileDraft } = await import("../src/worker/services/learningClub");
    const { recomposeGuestCounts } = await import("../src/worker/services/tlcDraftNotice");
    const mk = async (brand: string) => {
      const id = `tld_${brand.replace(/\W/g, "")}`;
      await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_name, contact_email, contact_source_url, why_fit, firm_scope) VALUES (?1, 'tlc_2027-03', ?2, 'Pat Example', ?3, 'https://example.test/team', 'they host tastings', 'west-peek')")
        .bind(id, brand, `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`).run();
      await fileDraft(env, { id, brand, contact_email: `pat@${brand.toLowerCase().replace(/\W/g, "")}.example`, drip_step: 0 }, { subject: `${brand} + a small room in New York`, text: `Hi Pat,\n\n${OLD_PROOF}` });
      return id;
    };
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', 'tok_claim')").run();
    const queued = await mk("Claim Co");
    const sent = await mk("Sent Claim Co");
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'SENT' WHERE deal_id = ?1").bind(sent).run();
    await recomposeGuestCounts(env);
    const row = async (id: string) => (await env.WP_OS_DB.prepare(
      "SELECT m.body, r.payload_json, a.summary FROM tlc_drip_message m JOIN external_effect_request r ON r.id = m.effect_request_id JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = ?1",
    ).bind(id).first<{ body: string; payload_json: string; summary: string }>())!;
    const q = await row(queued);
    for (const text of [q.body, (JSON.parse(q.payload_json) as { text: string }).text, q.summary]) {
      expect(text).toContain("community that grew to nearly 5,000 founders, operators and creatives at its height");
      expect(overstatedCommunityClaims(text)).toEqual([]);
    }
    expect((await row(sent)).body).toContain("more than 5,000");
  });
});
