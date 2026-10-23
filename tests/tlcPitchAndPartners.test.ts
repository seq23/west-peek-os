import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { brandPitchProblems, clubWhen, renderBrandPitch, renderInternalOnePager, safetyLines, type TlcClubView } from "../src/shared/tlc/pitch";
import { TLC_OWNER, TLC_RECIPIENTS } from "../src/shared/tlc/learningClub";
import { partnersPanel } from "../src/shared/rooms/partnersPanel";
import { sendPartnerEmail, sendPartnersEmail } from "../src/worker/services/execEmail";
import { clubViewOf, contentHashes, type TlcEventRow } from "../src/worker/services/learningClub";

/**
 * THE LEARNING CLUB, AFTER THE HOSTILE REVIEW AND THE OWNER'S RULINGS (22 Oct 2026). What has to be true:
 *  - each month has a brand pitch that reads clean: no "Dry January", no exclusivity, no internal
 *    label or name, no stale date, no promised result, a price, an ask and Sequoia as the contact;
 *  - January carries 21+ and <=0.5% ABV; March carries the confidential-data rule; February is
 *    Thursday 11 February 2027;
 *  - every TLC email to a partner reaches Sequoia only, whichever path sends it;
 *  - the Partners panel's numbers, across TLC deals and general Room sponsors;
 *  - approvals are of exact content, partners only; the public pitch needs no login and leaks nothing.
 */

// Shaped like the three real packets (the words are paraphrased; no sponsor data is in this repo).
const JAN: TlcClubView = {
  topic: "Zero-Proof Home Bar", month: "2027-01", eventDate: "2027-01-23", slot: "AFTERNOON",
  angle: "Dry January, done properly. In one Saturday afternoon, 25–40 New Yorkers learn to build a home bar with no alcohol in it. The room is for people cutting back.",
  whyNow: "January is the category's biggest month. A survey found many drinkers likely to do Dry January 2026 — and non-alcoholic beer sales rose.",
  sources: [{ title: "NIQ — Dry January in the US On-Premise (2026)", url: "https://nielseniq.com/x" }],
  categories: [{ category: "Non-alcoholic spirits and aperitifs (lead)", why: "the base of every drink", example_brands: ["Brand A"] }, { category: "Glassware (donated)", why: "x", example_brands: [] }],
  handsOn: "60 minutes at stations of four; each person builds three drinks.", takeHome: "Three recipes they made themselves.", recap: null,
};
const FEB: TlcClubView = {
  topic: "Fragrance Lab", month: "2027-02", eventDate: "2027-02-11", slot: "EVENING",
  angle: "Blend your own signature scent the week before Valentine's Day. A working perfumer teaches the notes. Proposed date: Sat 6 Feb 2027, 1–5 pm. Fragrance is learned by nose.",
  whyNow: "Fragrance is still growing in the US.", sources: [{ title: "Retail Dive", url: "https://retaildive.com/x" }],
  categories: [{ category: "Fragrance house (lead)", why: "fits", example_brands: ["Brand B"] }], handsOn: null, takeHome: "A bottle of their own scent.", recap: null,
};
const MAR: TlcClubView = {
  topic: "AI Tools for Your Work", month: "2027-03", eventDate: "2027-03-18", slot: "EVENING",
  angle: "A Thursday evening for people who already use AI at work. In four hours they go from occasional prompting to three automations running on their own work: a weekly report that drafts itself. Everyone brings a laptop.",
  whyNow: "Most people now use AI at work, and fewer get help to learn it.", sources: [{ title: "PwC survey", url: "https://pwc.example/x" }],
  categories: [{ category: "AI assistant (lead, category-exclusive)", why: "runs every build", example_brands: ["Brand C"] }], handsOn: "Build 1: paste a real meeting transcript into the assistant.", takeHome: "Three working automations in their own accounts.", recap: null,
};

describe("the three brand pitches read clean", () => {
  it("no review blocker survives in any month", () => {
    for (const v of [JAN, FEB, MAR]) {
      const html = renderBrandPitch(v);
      expect(brandPitchProblems(html)).toEqual([]);
      // The order the review asked for.
      const at = (h: string) => html.indexOf(h);
      expect(at("Why now for your category")).toBeLessThan(at("Who is in the room"));
      expect(at("Who is in the room")).toBeLessThan(at("What you get"));
      expect(at("What you get")).toBeLessThan(at("Price and the ask"));
      expect(at("Price and the ask")).toBeLessThan(at(TLC_OWNER.email));
      expect(html).toMatch(/Partner: \$5,000/);
      expect(html).toMatch(/Presenting partner: \$15,000/);
      expect(html).toMatch(/Photo and content rights/);
      expect(html).toMatch(/Opt-in lead capture/);
      expect(html).toMatch(/A recap within a week, with the numbers/);
      // The packet's own why-now and its own sources, never the quarterly trend story.
      expect(html).toContain(v.sources[0]!.url);
    }
  });
  it("January: 21+ and 0.5% ABV, and never 'Dry January' as our words", () => {
    const html = renderBrandPitch(JAN);
    expect(html).toContain("21+ only, with ID checked at the door. Every drink served is non-alcoholic (0.5% ABV or less).");
    expect(html.replace(/<ol class="src">[\s\S]*?<\/ol>/g, "")).not.toMatch(/dry january/i);
    expect(html).not.toMatch(/\(lead|\(donated/);
  });
  it("February: Thursday 11 February 2027, evening; the stale proposed date is gone", () => {
    expect(clubWhen("2027-02-11", "EVENING")).toBe("Thursday 11 February 2027, 6–10 pm");
    const html = renderBrandPitch(FEB);
    expect(html).toContain("Thursday 11 February 2027, 6–10 pm");
    expect(html).not.toMatch(/6 Feb|Proposed date/);
  });
  it("March: the confidential-data rule, no promised result, no exclusivity", () => {
    const html = renderBrandPitch(MAR);
    expect(html).toContain("never their employer's confidential data");
    expect(html).toContain("we do not promise any particular result");
    expect(html).not.toMatch(/running on their own|working automations|drafts itself|exclusive/i);
    expect(safetyLines("Zero-Proof Home Bar")).toHaveLength(1);
    expect(safetyLines("Fragrance Lab")).toEqual([]);
  });
  it("the internal one-pager has the economics, the categories with brands, the origin, the risks and the decisions", () => {
    const html = renderInternalOnePager({ ...MAR, origin: "BRANDS_SPENDING", status: "TOPIC_PROPOSED", vetoUntil: "2026-10-25T23:28:12.271Z", committedUsd: 5_000, committedPartners: 1, pitchUrl: "https://os.joinwestpeek.com/api/tlc-pitch/abc" });
    for (const s of ["The economics", "Sponsor categories", "Risks", "What you decide", "Brands spending now", "Brand C", "$5,000 of $15,000 (33%) · 1 of ~3 partners", "about 3 partners at $5,000, or 1 presenting partner at $15,000", "$100M"]) expect(html).toContain(s);
    expect(html).not.toMatch(/exclusive/i);
    expect(html).toContain("not for brands");
  });
});

describe("February's date, in the migration", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await disposeTestDb(t); });
  it("moves only the February row still on 20 Feb to Thursday 11 Feb, evening; veto window and status untouched", async () => {
    const sql = readFileSync(new URL("../migrations/0263_tlc_pitch_partners_and_one_recipient.sql", import.meta.url), "utf8");
    const update = /UPDATE tlc_event SET event_date = '2027-02-11'[^;]*;/.exec(sql)![0];
    await t.db.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, status, veto_until) VALUES ('tlc_2027-02', '2027-02', '2027-02-20', 'AFTERNOON', 'Fragrance Lab', 'TOPIC_PROPOSED', '2026-10-25T23:28:12.271Z'), ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'AI', 'TOPIC_PROPOSED', '2026-10-25T23:28:12.271Z')").run();
    await t.db.prepare(update).run();
    const rows = (await t.db.prepare("SELECT month, event_date, slot, status, veto_until FROM tlc_event ORDER BY month").all()).results;
    expect(rows).toEqual([
      { month: "2027-02", event_date: "2027-02-11", slot: "EVENING", status: "TOPIC_PROPOSED", veto_until: "2026-10-25T23:28:12.271Z" },
      { month: "2027-03", event_date: "2027-03-18", slot: "EVENING", status: "TOPIC_PROPOSED", veto_until: "2026-10-25T23:28:12.271Z" },
    ]);
  });
});

describe("every TLC email to a partner reaches Sequoia only", () => {
  let t: TestDb;
  let env: Env;
  const sends: Array<{ to: string | string[]; cc?: string[] }> = [];
  beforeAll(async () => {
    t = await createTestDb();
    env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.resend.com")) { sends.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 }); }
      return new Response("ok", { status: 200 });
    });
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind) VALUES ('wc_tlc', 'TLC topics', 'x', 'AI', 'aie_parker', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'TLC_TOPICS'), ('wc_other', 'Other', 'x', 'AI', 'aie_parker', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'RESEARCH')").run();
  });
  afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });
  beforeEach(() => { sends.length = 0; });

  const email = { employee: "Wynn", what: "TLC test", tldr: "A line.", sections: [{ label: "What I found", bullets: ["b"] }, { label: "Your call", bullets: ["c"] }] };
  it("re-addresses a TLC message to Sequoia at the partner-mail door, whatever the path asked for", async () => {
    expect(TLC_RECIPIENTS).toEqual(["sequoia@westpeek.ventures"]);
    const cases = [
      { to: "scooter@westpeek.ventures", cardKind: "TLC_SPONSOR_DECISION", objectType: "work_card", objectId: "wc_x" },
      { to: "scooter@westpeek.ventures", cardKind: null, objectType: "tlc_event", objectId: "tlc_2027-01" },
      { to: "scooter@westpeek.ventures", cardKind: null, objectType: "tlc_deal", objectId: "td_1" },
      { to: "scooter@westpeek.ventures", cc: ["sequoia@westpeek.ventures"], cardKind: null, objectType: "preview_approval", objectId: "pa_1", kind: "TLC_BRAND_BATCH" },
    ];
    for (const c of cases) {
      const out = await sendPartnerEmail(env, { to: c.to, ...(c.cc ? { cc: c.cc } : {}), email, objectType: c.objectType, objectId: c.objectId, firmScope: "west-peek", cardKind: c.kind ?? c.cardKind });
      expect(out.to).toBe("sequoia@westpeek.ventures");
      expect(out.sent).toBe(true);
    }
    const both = await sendPartnersEmail(env, { to: ["sequoia@westpeek.ventures", "scooter@westpeek.ventures"], email, objectType: "tlc_event", objectId: "tlc_2027-01", firmScope: "west-peek" });
    expect(both.recipients).toEqual(["sequoia@westpeek.ventures"]);
    // A STUCK or friction notice on a TLC card, sent by generic code that names only the card.
    await sendPartnerEmail(env, { to: "scooter@westpeek.ventures", email, objectType: "work_card", objectId: "wc_tlc", firmScope: "west-peek" });
    for (const s of sends) {
      expect([s.to].flat()).toEqual(["sequoia@westpeek.ventures"]);
      expect(JSON.stringify(s)).not.toMatch(/scooter@/i);
    }
    expect(sends.length).toBeGreaterThanOrEqual(6);
  });
  it("leaves every other email alone", async () => {
    const out = await sendPartnerEmail(env, { to: "scooter@westpeek.ventures", email: { ...email, what: "Other test" }, objectType: "work_card", objectId: "wc_other", firmScope: "west-peek", cardKind: "RESEARCH" });
    expect(out.to).toBe("scooter@westpeek.ventures");
  });
  it("sibling sweep: every TLC send in the service goes through the one owner door, and no TLC file names Scooter's address", () => {
    const service = readFileSync(new URL("../src/worker/services/learningClub.ts", import.meta.url), "utf8");
    expect(service.match(/sendOrPreview\(/g)).toHaveLength(1);
    expect(service).toMatch(/for \(const address of TLC_RECIPIENTS\) \{\n\s+const out = await sendOrPreview\(env, \{\n\s+to: address,/);
    expect(service).not.toMatch(/sendPartnerEmail\(|sendPartnersEmail\(|sendViaResend\(|sendViaCloudflare\(/);
    expect(service).not.toMatch(/emailBoth/);
    for (const f of ["src/shared/tlc/learningClub.ts", "src/shared/tlc/pitch.ts", "src/worker/services/learningClub.ts", ...readdirSync(new URL("../src/client/pages", import.meta.url)).filter((x) => /LearningClub|Partners/.test(x)).map((x) => `src/client/pages/${x}`)]) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).not.toMatch(/scooter@/i);
    }
  });
});

describe("the Partners panel, across TLC deals and general Room sponsors", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const panel = partnersPanel(
    {
      tlcEvents: [{ id: "tlc_2027-01", month: "2027-01", topic: "Zero-Proof Home Bar", event_date: "2027-01-23" }],
      tlcDeals: [
        { id: "d1", event_id: "tlc_2027-01", brand: "Acme", tier: "PARTNER", stage: "AGREED", cash_offer_usd: 5000, counter_usd: null, yes_at: "2026-11-18T10:00:00Z", replied_at: null, updated_at: "2026-11-18T10:00:00Z", decision_card_id: "wc_d1" },
        { id: "d2", event_id: "tlc_2027-01", brand: "Bolt", tier: "PRESENTING", stage: "CALL", cash_offer_usd: null, counter_usd: null, yes_at: "2026-11-01T10:00:00Z", replied_at: null, updated_at: "2026-11-01T10:00:00Z", decision_card_id: null },
        { id: "d3", event_id: "tlc_2027-01", brand: "Cask", tier: null, stage: "PITCHED", cash_offer_usd: null, counter_usd: null, yes_at: null, replied_at: "2026-11-19T10:00:00Z", updated_at: "2026-11-19T10:00:00Z", decision_card_id: null },
        { id: "d4", event_id: "tlc_2027-01", brand: "Dune", tier: "PARTNER", stage: "DECLINED", cash_offer_usd: 5000, counter_usd: null, yes_at: "2026-11-19T10:00:00Z", replied_at: null, updated_at: "2026-11-19T10:00:00Z", decision_card_id: null },
        { id: "d5", event_id: "tlc_2027-01", brand: "Ever", tier: "PARTNER", stage: "PITCHED", cash_offer_usd: null, counter_usd: null, yes_at: "2026-11-19T09:00:00Z", replied_at: null, updated_at: "2026-11-19T09:00:00Z", decision_card_id: null },
      ],
      roomEvents: [
        { id: "ev_a", title: "Founders Room", starts_at: "2026-12-04T23:00:00Z", sponsor_target_usd: 20_000 },
        { id: "ev_b", title: "Operators Room", starts_at: "2026-12-11T23:00:00Z", sponsor_target_usd: null },
      ],
      roomSponsors: [
        { id: "s1", event_id: "ev_a", org_name: "Cloudco", tier: "PRESENTING", stage: "COMMITTED", committed_usd: 12_000, ask_high_usd: 15_000, ask_low_usd: 10_000, contact_url: "https://cloudco.example/p", source_url: null, updated_at: "2026-10-01T00:00:00Z" },
        { id: "s2", event_id: "ev_a", org_name: "Lawco", tier: "SUPPORTING", stage: "SENT", committed_usd: null, ask_high_usd: 5_000, ask_low_usd: 2_500, contact_url: null, source_url: null, updated_at: "2026-11-19T00:00:00Z" },
        { id: "s3", event_id: "ev_b", org_name: "Bankco", tier: "SUPPORTING", stage: "COMMITTED", committed_usd: 3_000, ask_high_usd: null, ask_low_usd: null, contact_url: null, source_url: null, updated_at: "2026-11-15T00:00:00Z" },
      ],
      tlcTargetUsd: 15_000, tlcPartnerPriceUsd: 5_000, tlcPresentingPriceUsd: 15_000, cardUrl: (id) => `#/work/${id}`,
    },
    now,
  );
  it("counts only agreed or paid money toward the target, lists every yes with its stage, and badges the new ones", () => {
    const tlc = panel.find((e) => e.eventId === "tlc_2027-01")!;
    expect(tlc.progressWords).toBe("$5,000 of $15,000 · 1 of ~3 partners");
    expect(tlc.progressPct).toBe(33);
    expect(tlc.partners.map((p) => [p.brand, p.role, p.amountUsd, p.stageWords, p.isNew, p.threadUrl])).toEqual([
      ["Ever", "Partner", 5000, "said yes", true, null],
      ["Acme", "Partner", 5000, "agreed", true, "#/work/wc_d1"],
      ["Bolt", "Presenting", 15000, "call", false, null],
    ]);
    const a = panel.find((e) => e.eventId === "ev_a")!;
    expect(a.progressWords).toBe("$12,000 of $20,000");
    expect(a.progressPct).toBe(60);
    expect(a.partners.map((p) => [p.brand, p.role, p.amountUsd, p.stageWords])).toEqual([["Cloudco", "Presenting", 12000, "agreed"]]);
    const b = panel.find((e) => e.eventId === "ev_b")!;
    expect(b.progressWords).toBe("$3,000 committed · no target set");
    expect(b.progressPct).toBeNull();
  });
});

describe("approvals are of exact content, partners only; the public pitch needs no login", () => {
  let t: TestDb;
  let env: Env;
  const post = (who: string, body: unknown) =>
    handleRequest(new Request("https://test.local/api/tlc/approve", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-wpos-dev-user": who, "sec-fetch-site": "same-origin" } }), env);
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db);
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, packet_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'AI Tools for Your Work', 'A Thursday evening for people who already use AI at work.', 'TOPIC_PROPOSED', '{\"why_now\":\"Most people use AI at work.\"}', '0123456789abcdef0123456789abcdef')").run();
  });
  afterAll(async () => { await disposeTestDb(t); });

  it("refuses an approval of anything but the content on screen, stores its hash, and clears it when the pitch changes", async () => {
    const h = await contentHashes(env);
    expect((await post("sequoia@westpeek.ventures", { what: "pitch", hash: "f".repeat(64) })).status).toBe(409);
    expect((await post("sequoia@westpeek.ventures", { what: "brand_send_on" })).status).toBe(409);
    expect((await post("sequoia@westpeek.ventures", { what: "pitch", hash: h.pitch })).status).toBe(200);
    expect((await post("sequoia@westpeek.ventures", { what: "playbook", hash: h.playbook })).status).toBe(200);
    const on = await post("sequoia@westpeek.ventures", { what: "brand_send_on" });
    expect(on.status).toBe(200);
    // One word of the pitch changes: the approval is gone and the switch says why.
    await env.WP_OS_DB.prepare("UPDATE tlc_event SET angle = 'A Thursday evening for anyone who uses AI at work.' WHERE id = 'tlc_2027-03'").run();
    const res = await handleRequest(new Request("https://test.local/api/tlc", { headers: { "x-wpos-dev-user": "sequoia@westpeek.ventures" } }), env);
    const body = (await res.json()) as { approvals: { pitch: { state: string } }; send_gate: { open: boolean; reasons: string[] } };
    expect(body.approvals.pitch.state).toBe("CHANGED");
    expect(body.send_gate.reasons).toContain("the brand pitch changed after it was approved; approve it again");
    // Stop sending always works.
    expect((await post("sequoia@westpeek.ventures", { what: "brand_send_off" })).status).toBe(200);
  });
  it("is partners only", async () => {
    const res = await post("nobody@example.com", { what: "brand_send_off" });
    expect([401, 403]).toContain(res.status);
  });
  it("serves the brand pitch at its token with no login, and nothing at any other", async () => {
    const ok = await handleRequest(new Request("https://test.local/api/tlc-pitch/0123456789abcdef0123456789abcdef"), env);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("<title>The Learning Club: AI Tools for Your Work</title>");
    expect(brandPitchProblems(html)).toEqual([]);
    expect(ok.headers.get("x-robots-tag")).toMatch(/noindex/);
    for (const bad of ["0123456789abcdef0123456789abcdee", "x", "tlc_2027-03"]) {
      expect((await handleRequest(new Request(`https://test.local/api/tlc-pitch/${bad}`), env)).status).toBe(404);
    }
    const row = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = 'tlc_2027-03'").first<TlcEventRow>();
    expect(clubViewOf(row!).whyNow).toBe("Most people use AI at work.");
  });
});
