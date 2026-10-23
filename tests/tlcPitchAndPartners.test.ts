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
      // The tiers, Title first, and what each gets; never our goal, costs or a season offer.
      const at2 = (h: string) => html.indexOf(h);
      expect(at2("Title partner: $25,000")).toBeGreaterThan(0);
      expect(at2("Title partner: $25,000")).toBeLessThan(at2("Partner: $5,000"));
      for (const t of ["Partner: $5,000", "Lead partner: $10,000", "Presenting partner: $15,000", "Product partner (in kind)", "The Learning Club, presented by"]) expect(html).toContain(t);
      expect(html).not.toMatch(/\bgoal\b|cost budget|\bnet\b|\bseason\b/i);
      expect(html).toContain("An intimate room, sized to your goals: planned for 25–40 people");
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
    expect(html).toContain("Zero-Proof January, done properly.");
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
    for (const s of ["The economics", "Sponsor categories", "Risks", "What you decide", "Brands spending now", "Brand C", "$5,000 of $25,000 (20%) · 1 partner", "Two routes: one Title partner at $25,000; or a mix", "costs up to $15,000", "Season (recommendation", "$100M"]) expect(html).toContain(s);
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
  it("on its deadline the backup takes over, Sequoia alone is told what switched and why; a Title yes keeps the primary", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_parker','aie_wynn')").run();
    const { applyBackupSwitch } = await import("../src/worker/services/learningClub");
    const backup = JSON.stringify({ topic: "Find Your Voice", angle: "Make a short piece with AI voice and video.", packet: { why_now: "w" }, categories: [{ category: "AI video", why: "x", example_brands: [] }], seats_min: 40, seats_max: 60 });
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, status, backup_json, switch_deadline, seats_min, seats_max) VALUES ('tlc_2031-02', '2031-02', '2031-02-13', 'EVENING', 'Fragrance Lab', 'TOPIC_READY', ?1, '2030-12-15', 30, 40), ('tlc_2031-03', '2031-03', '2031-03-13', 'EVENING', 'Build Your Own AI Agent', 'TOPIC_READY', ?1, '2030-12-15', 80, 120)").bind(backup).run();
    await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, stage, tier, yes_at) VALUES ('d_cash', 'tlc_2031-02', 'One', 'a@one.example', 'https://one.example', 'CALL', 'PARTNER', '2030-12-01'), ('d_prod', 'tlc_2031-02', 'Two', 'a@two.example', 'https://two.example', 'CALL', 'PRODUCT', '2030-12-01'), ('d_title', 'tlc_2031-03', 'Three', 'a@three.example', 'https://three.example', 'CALL', 'TITLE', '2030-12-01')").run();
    const row = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(id).first<TlcEventRow>())!;
    expect(await applyBackupSwitch(env, await row("tlc_2031-02"), new Date("2030-12-14T12:00:00Z"))).toBeNull();
    sends.length = 0;
    // One cash yes (the product partner does not count), no Title partner: the backup takes over.
    expect(await applyBackupSwitch(env, await row("tlc_2031-02"), new Date("2030-12-15T12:00:00Z"))).toBe("SWITCHED");
    const after = await row("tlc_2031-02");
    expect([after.topic, after.seats_min, after.seats_max, after.status]).toEqual(["Find Your Voice", 40, 60, "TOPIC_READY"]);
    expect(JSON.parse(after.backup_json!).switched_from).toBe("Fragrance Lab");
    expect(sends).toHaveLength(1);
    expect([sends[0]!.to].flat()).toEqual(["sequoia@westpeek.ventures"]);
    const body = JSON.stringify(sends[0]);
    expect(body).toContain("switched from Fragrance Lab to Find Your Voice");
    expect(body).toMatch(/1(\\\*\\\*|<\/strong>)? cash sponsor had said yes and no Title partner/);
    // Once done, never again.
    expect(await applyBackupSwitch(env, after, new Date("2030-12-16T12:00:00Z"))).toBeNull();
    // A Title partner's yes keeps the primary.
    expect(await applyBackupSwitch(env, await row("tlc_2031-03"), new Date("2030-12-15T12:00:00Z"))).toBe("KEPT");
    expect((await row("tlc_2031-03")).topic).toBe("Build Your Own AI Agent");
  });

  it("counts a club as funded only when its agreed cash (never product) reaches its goal", async () => {
    const { fundedEventCount } = await import("../src/worker/services/learningClub");
    const before = await fundedEventCount(env);
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, topic) VALUES ('tlc_2032-01', '2032-01', '2032-01-15', 'A'), ('tlc_2032-02', '2032-02', '2032-02-12', 'B')").run();
    await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, stage, tier, cash_offer_usd) VALUES ('f1', 'tlc_2032-01', 'T', 't@x.example', 'https://x.example', 'PAID', 'TITLE', 25000), ('f2', 'tlc_2032-02', 'P', 'p@x.example', 'https://x.example', 'AGREED', 'PARTNER', 20000), ('f3', 'tlc_2032-02', 'K', 'k@x.example', 'https://x.example', 'AGREED', 'PRODUCT', 9000)").run();
    expect(await fundedEventCount(env)).toBe(before + 1);
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
      tlcTargetUsd: 25_000, cardUrl: (id) => `#/work/${id}`,
    },
    now,
  );
  it("counts only agreed or paid money toward the target, lists every yes with its stage, and badges the new ones", () => {
    const tlc = panel.find((e) => e.eventId === "tlc_2027-01")!;
    expect(tlc.progressWords).toBe("$5,000 of $25,000 · 1 partner");
    expect(tlc.progressPct).toBe(20);
    expect(tlc.partners.map((p) => [p.brand, p.role, p.amountUsd, p.stageWords, p.isNew, p.threadUrl])).toEqual([
      ["Ever", "Partner", 5000, "said yes", true, null],
      ["Acme", "Partner", 5000, "agreed", true, "#/work/wc_d1"],
      ["Bolt", "Presenting partner", 15000, "call", false, null],
    ]);
    const a = panel.find((e) => e.eventId === "ev_a")!;
    expect(a.progressWords).toBe("$12,000 of $20,000");
    expect(a.progressPct).toBe(60);
    expect(a.partners.map((p) => [p.brand, p.role, p.amountUsd, p.stageWords])).toEqual([["Cloudco", "Presenting partner", 12000, "agreed"]]);
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

describe("the owner's rulings on rooms, money, sponsors and ideas (22 Oct 2026)", () => {
  it("the room size is the club's own: pitch, drip and internal page read it, and never a size we have not set", async () => {
    const { dripEmail, seatsOf } = await import("../src/shared/tlc/learningClub");
    expect(seatsOf(null)).toEqual({ min: 25, max: 40 });
    expect(seatsOf({ seats_min: 80, seats_max: 120 })).toEqual({ min: 80, max: 120 });
    const big = { ...MAR, seats: { min: 80, max: 120 } };
    expect(renderBrandPitch(big)).toContain("An intimate room, sized to your goals: planned for 80–120 people");
    expect(renderBrandPitch(big)).toContain("80–120 New Yorkers who chose this topic");
    expect(renderBrandPitch(big)).not.toContain("25–40");
    expect(renderInternalOnePager({ ...big, origin: null, status: "TOPIC_READY", vetoUntil: null, committedUsd: 0, committedPartners: 0, pitchUrl: null })).toContain("Room: planned for 80–120 people");
    const d = dripEmail({ step: 0, brand: "Acme", contactName: null, topic: "T", month: "2027-03", eventDate: "2027-03-18", why: null, seats: { min: 80, max: 120 } });
    expect(d.text).toContain("80 to 120 people");
    expect(d.text).not.toContain("25 to 40");
  });

  it("sponsors are complementary: competing categories are flagged inside, and peptide sellers or sportsbooks in Q1 never stand; prediction markets may", async () => {
    const m = await import("../src/shared/tlc/learningClub");
    expect(m.competingCategories([{ category: "Non-alcoholic spirits" }, { category: "Non-alcoholic beer" }, { category: "Glassware" }])).toHaveLength(1);
    expect(m.competingCategories([{ category: "Zero-proof spirit" }, { category: "Premium mixers and sodas" }, { category: "Glassware and barware" }, { category: "Wellness, sleep or fitness" }, { category: "Food and garnish" }])).toEqual([]);
    // A bench slot is only offered with the lead's OK, so it is not a clash.
    expect(m.competingCategories([{ category: "AI fragrance house" }, { category: "Indie fragrance house", bench: true }])).toEqual([]);
    const inside = renderInternalOnePager({ ...JAN, categories: [{ category: "Non-alcoholic spirits", why: "x", example_brands: [] }, { category: "Non-alcoholic beer", why: "x", example_brands: [] }], origin: null, status: "TOPIC_READY", vetoUntil: null, committedUsd: 0, committedPartners: 0, pitchUrl: null });
    expect(inside).toMatch(/Sponsors must not compete: &quot;Non-alcoholic spirits&quot; and &quot;Non-alcoholic beer&quot;/);
    expect(m.sponsorMixProblems("2027-02", [{ category: "Sportsbook" }])).toEqual(['betting brands stay out of Q1 2027 ("Sportsbook")']);
    // Owner, 23 Oct 2026: prediction markets are not betting. Kalshi, Polymarket and Robinhood may sponsor any month, Q1 included.
    for (const month of ["2027-01", "2027-02", "2027-03", "2027-05"]) {
      expect(m.sponsorMixProblems(month, [{ category: "Prediction market" }]), month).toEqual([]);
      expect(m.sponsorMixProblems(month, [{ category: "Prediction market (Kalshi)" }, { category: "Event contracts (Polymarket)" }, { category: "Investing app (Robinhood)" }]), month).toEqual([]);
    }
    for (const c of ["Prediction market", "Event contracts", "Kalshi", "Polymarket", "Robinhood"]) expect(m.isBettingCategory(c), c).toBe(false);
    // Sportsbooks stay out exactly as before: Q1 refused, never beside trading, by category or by name.
    for (const c of ["Sportsbook", "Sports betting", "Online casino", "DraftKings", "FanDuel"]) {
      expect(m.isBettingCategory(c), c).toBe(true);
      expect(m.sponsorMixProblems("2027-01", [{ category: c }]), c).toEqual([`betting brands stay out of Q1 2027 ("${c}")`]);
      expect(m.sponsorMixProblems("2027-03", [{ category: c }]), c).toHaveLength(1);
    }
    expect(m.sponsorMixProblems("2027-04", [{ category: "Sportsbook" }])).toEqual([]);
    expect(m.sponsorMixProblems("2027-05", [{ category: "Sportsbook" }, { category: "Trading app" }])).toEqual(['betting and trading brands never share an event ("Sportsbook" and "Trading app")']);
    expect(m.sponsorMixProblems("2027-04", [{ category: "Peptide clinic" }])[0]).toMatch(/no peptide sellers/);
    expect(m.sponsorMixProblems("2027-04", [{ category: "Trading app" }])).toEqual([]);
    expect(m.doNotRun("Peptides and biohacking")).toMatch(/FDA warning letters/);
    expect(m.doNotRun("The Longevity Reset")).toBeNull();
    expect(brandPitchProblems(renderBrandPitch({ ...MAR, angle: "Leave the cult behind. A second line." }))).toContain('"cult" language');
  });

  it("a list inside a partner's email is the partner's idea only when the email says so; otherwise a suggested list", async () => {
    const { creditForQuote, TLC_IDEA_ORIGIN_LABEL } = await import("../src/shared/tlc/learningClub");
    const listMail = "Here is the starting list:\n- Fragrance Lab\n- Matcha & Tea\n- Zero-Proof Home Bar";
    expect(creditForQuote(listMail, "Fragrance Lab")).toBe("SUGGESTED_LIST");
    expect(creditForQuote("My list for the club:\n- Fragrance Lab\n- Matcha", "Fragrance Lab")).toBe("OWNER_IDEA");
    expect(creditForQuote("We should do a learning club about trading.", "a learning club about trading")).toBe("OWNER_IDEA");
    expect(TLC_IDEA_ORIGIN_LABEL.SUGGESTED_LIST).toBe("Suggested list (written by the assistant, 22 Oct)");
  });

  it("a hands-on idea with a designed AI angle is eligible from April 2027; one without stays gated until 6 clubs have each raised $25,000", async () => {
    const { ideaEligibility } = await import("../src/shared/tlc/learningClub");
    const matcha = { topic: "Matcha & Tea", earliest_month: "2027-04", packet: { ai_angle: "An AI-designed tasting flight and a personal flavour profile." } };
    expect(ideaEligibility(matcha, "2027-03", 0)).toEqual({ eligible: false, why: "not before 2027-04" });
    expect(ideaEligibility(matcha, "2027-04", 0)).toEqual({ eligible: true, why: null });
    const plain = { topic: "Matcha & Tea", earliest_month: null, packet: null };
    expect(ideaEligibility(plain, "2027-06", 0).eligible).toBe(false);
    // Six funded clubs, not two (owner correction, 22 Oct 2026).
    expect(ideaEligibility(plain, "2027-06", 2).eligible).toBe(false);
    expect(ideaEligibility(plain, "2027-06", 5).why).toMatch(/waits until 6 clubs have each raised \$25,000 \(5 so far\)/);
    expect(ideaEligibility(plain, "2027-06", 6)).toEqual({ eligible: true, why: null });
    // The AI-angled version is unaffected by the count.
    expect(ideaEligibility(matcha, "2027-04", 0)).toEqual({ eligible: true, why: null });
    expect(ideaEligibility({ topic: "Build Your Own AI Agent" }, "2027-03", 0).eligible).toBe(true);
  });

  it("every month's backup takes over only on its deadline, only with fewer than 2 cash yeses and no Title partner", async () => {
    const { switchVerdict } = await import("../src/shared/tlc/learningClub");
    const b = { topic: "Find Your Voice", angle: "a", packet: {}, categories: [] };
    const at = (d: string) => new Date(`${d}T13:00:00Z`);
    expect(switchVerdict(null, "2026-12-15", at("2026-12-20"), { cashYes: 0, titleYes: false })).toBe("NO_BACKUP");
    expect(switchVerdict(b, null, at("2026-12-20"), { cashYes: 0, titleYes: false })).toBe("NO_BACKUP");
    expect(switchVerdict(b, "2026-12-15", at("2026-12-14"), { cashYes: 0, titleYes: false })).toBe("NOT_DUE");
    expect(switchVerdict(b, "2026-12-15", at("2026-12-15"), { cashYes: 1, titleYes: false })).toBe("SWITCH");
    expect(switchVerdict(b, "2026-12-15", at("2026-12-15"), { cashYes: 2, titleYes: false })).toBe("KEEP");
    expect(switchVerdict(b, "2026-12-15", at("2026-12-15"), { cashYes: 1, titleYes: true })).toBe("KEEP");
    expect(switchVerdict({ ...b, applied_at: "2026-12-15" }, "2026-12-15", at("2026-12-16"), { cashYes: 0, titleYes: false })).toBe("DONE");
  });

  it("every non-AI club carries an AI segment and an AI partner slot; AI topics need neither; one frontier model is seated", async () => {
    const m = await import("../src/shared/tlc/learningClub");
    expect(m.isAiTopic("Build Your Own AI Agent")).toBe(true);
    expect(m.isAiTopic("AI Tools for Your Work")).toBe(true);
    expect(m.isAiTopic("The Longevity Reset")).toBe(false);
    expect(m.aiRuleProblems("The Longevity Reset", {}, [])).toHaveLength(2);
    expect(m.aiRuleProblems("The Longevity Reset", { ai_segment: "Your health data, explained by AI" }, [{ category: "AI partner", ai_partner: true }])).toEqual([]);
    expect(m.aiRuleProblems("Build Your Own AI Agent", {}, [])).toEqual([]);
    expect(m.runOfShowLines("Your health data, explained by AI")).toContain("Go deeper, with AI: Your health data, explained by AI: 45 min");
    expect(m.frontierConflict([{ id: "a", frontier: true }], { id: "b", frontier: true })).toMatch(/one frontier-model company/);
    expect(m.frontierConflict([{ id: "a", frontier: true }], { id: "c", frontier: false })).toBeNull();
    expect(m.frontierConflict([{ id: "a", frontier: true }], { id: "a", frontier: true })).toBeNull();
    const view = { ...JAN, topic: "The Longevity Reset", angle: "One evening on sleep and strength.", aiSegment: "Your health data, explained by AI: guests use an assistant on their own sleep or lab numbers.", categories: [{ category: "Wearable", why: "w", example_brands: ["Brand W"] }, { category: "AI partner (frontier model)", why: "Runs the AI segment.", example_brands: ["Model A", "Model B"], ai_partner: true, frontier_model: true }] };
    const pitch = renderBrandPitch(view);
    expect(pitch).toContain("The AI segment: Your health data, explained by AI");
    expect(pitch).toContain("AI is not medical advice");
    expect(brandPitchProblems(pitch)).toEqual([]);
    const inside = renderInternalOnePager({ ...view, origin: "OWNER_IDEA", status: "TOPIC_READY", vetoUntil: null, committedUsd: 0, committedPartners: 0, pitchUrl: null, backup: { topic: "AI Tools for Your Work", angle: "Keep Thinking.", deadline: "2026-11-15" } });
    expect(inside).toContain("<strong>AI partner:</strong> AI partner (frontier model) (targets: Model A, then Model B)");
    expect(inside).toContain("Backup topic, switch on 2026-11-15");
    expect(inside).toContain("<strong>AI Tools for Your Work.</strong>");
    // The brand pitch shows only the primary.
    expect(pitch).not.toContain("AI Tools for Your Work");
    expect(pitch).not.toMatch(/backup/i);
    const bare = renderInternalOnePager({ ...view, aiSegment: null, categories: [], origin: null, status: "TOPIC_READY", vetoUntil: null, committedUsd: 0, committedPartners: 0, pitchUrl: null });
    expect(bare).toMatch(/AI rule: &quot;The Longevity Reset&quot; is not an AI topic/);
  });

  it("the Partners panel counts a Title deal as the whole goal, shows product partners apart, and never counts them", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const deal = (id: string, tier: string | null, stage: string, cash: number | null, inKind: string | null = null) => ({ id, event_id: "e", brand: id, tier, stage, cash_offer_usd: cash, counter_usd: null, in_kind_offer: inKind, yes_at: "2026-11-18T10:00:00Z", replied_at: null, updated_at: "2026-11-18T10:00:00Z", decision_card_id: null });
    const run = (deals: ReturnType<typeof deal>[]) => partnersPanel({ tlcEvents: [{ id: "e", month: "2027-01", topic: "T", event_date: "2027-01-23" }], tlcDeals: deals, roomEvents: [], roomSponsors: [], tlcTargetUsd: 25_000, cardUrl: (i) => i }, now)[0]!;
    const title = run([deal("Claude", "TITLE", "AGREED", null), deal("Sensori", "PRODUCT", "AGREED", null, "spirit for the night")]);
    expect(title.progressWords).toBe("$25,000 of $25,000 · 1 partner");
    expect(title.progressPct).toBe(100);
    expect(title.inKindWords).toBe("In kind: Sensori (spirit for the night)");
    expect(title.partners.map((p) => p.role)).toEqual(["Title partner"]);
    expect(title.warnings).toEqual([]);
    const mix = run([deal("A", "PARTNER", "AGREED", null), deal("B", "LEAD", "PAID", null), deal("C", "PARTNER", "AGREED", 7_500), deal("D", "PRESENTING", "CALL", null)]);
    expect(mix.progressWords).toBe("$22,500 of $25,000 · 3 partners");
    const clash = run([deal("T", "TITLE", "AGREED", null), deal("X", "PARTNER", "AGREED", null)]);
    expect(clash.warnings[0]).toMatch(/only cash partner/);
    // A club the partners gave its own goal is measured against it.
    const own = partnersPanel({ tlcEvents: [{ id: "e", month: "2027-03", topic: "T", event_date: "2027-03-18", sponsor_goal_usd: 40_000 }], tlcDeals: [deal("A", "LEAD", "AGREED", null)], roomEvents: [], roomSponsors: [], tlcTargetUsd: 25_000, cardUrl: (i) => i }, now)[0]!;
    expect(own.progressWords).toBe("$10,000 of $40,000 · 1 partner");
  });

  it("the 0264 relabel moves exactly the eleven assistant-list ideas, keeps the owner's own, and allows MERGED", async () => {
    const t2 = await createTestDb();
    try {
      const sql = readFileSync(new URL("../migrations/0264_tlc_economics_tiers_room_size_and_idea_origins.sql", import.meta.url), "utf8");
      const update = /UPDATE tlc_idea\s+SET origin = 'SUGGESTED_LIST'[\s\S]*?;/.exec(sql)![0];
      const SRC = "wc_b6177490-bd4f-4d71-9783-edb42e918253";
      const NOTE = "On the partners' starting list (os@ email, 22 Oct).";
      const listed = ["Fragrance Lab", "Matcha & Tea", "Zero-Proof Home Bar", "Home Espresso & Coffee", "Skincare Science", "Knife Skills & Home Cooking", "Sleep & Recovery", "Film Photography", "Sewing & Visible Mending", "AI Tools for Your Work", "Buying Your First NYC Home"];
      let n = 0;
      for (const topic of listed) await t2.db.prepare("INSERT INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref) VALUES (?1, ?2, ?3, ?4, 'OWNER_IDEA', 'Sequoia and Scooter', '2026-10-22', ?5)").bind(`i${n++}`, topic, topic.toLowerCase(), NOTE, SRC).run();
      await t2.db.prepare("INSERT INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref) VALUES ('own', 'Sewing, matcha, day trading', 'sewing matcha day trading', '\"deep-dive one topic (sewing, matcha, day trading)\"', 'OWNER_IDEA', 'Sequoia', '2026-10-22', ?1)").bind(SRC).run();
      await t2.db.prepare(update).run();
      const rows = (await t2.db.prepare("SELECT topic, origin, suggested_by FROM tlc_idea ORDER BY id").all<{ topic: string; origin: string; suggested_by: string }>()).results;
      expect(rows.filter((r) => r.origin === "SUGGESTED_LIST").map((r) => r.topic).sort()).toEqual([...listed].sort());
      expect(rows.filter((r) => r.origin === "SUGGESTED_LIST").every((r) => r.suggested_by === "Assistant (planning doc)")).toBe(true);
      expect(rows.find((r) => r.topic === "Sewing, matcha, day trading")).toEqual({ topic: "Sewing, matcha, day trading", origin: "OWNER_IDEA", suggested_by: "Sequoia" });
      await t2.db.prepare("UPDATE tlc_idea SET status = 'MERGED', merged_into = 'The Longevity Reset' WHERE id = 'i0'").run();
      await expect(t2.db.prepare("DELETE FROM tlc_idea WHERE id = 'i0'").run()).rejects.toThrow(/never deleted/);
    } finally {
      await disposeTestDb(t2);
    }
  });
});
