import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { contentHashes, runDrip } from "../src/worker/services/learningClub";
import { applyOwnerEmailInstructions, herWordsIn } from "../src/worker/services/tlcOwnerInstruction";
import { mustPitchToSearch } from "../src/worker/services/tlcMustPitch";
import { ownerContactLines } from "../src/worker/services/tlcDraftNotice";
import { angleLineProblems, ownerAngleFirstEmail, ownerContactInstructions } from "../src/shared/tlc/ownerInstruction";
import { standingRulesIn } from "../src/shared/tlc/brandReply";

/**
 * HER EMAILED BRAND CONTACT REACHES THE BRAND'S DEAL (29 Oct 2026 incident, fixed 31 Oct 2026). Fake brand, fake
 * person, fake addresses only: the real contact goes in as data through this same path, never in the repo.
 *
 * She replied to a brand-reply approval email (TLR-…, another brand's answer) with "pitch this person at <Brand> -
 * <address>" and how to frame it. The whole note became her change to the other brand's answer, its address sentence
 * became a standing rule for every brand, and the must-pitch brand stayed at "Needs a way in".
 */
let t: TestDb;
let env: Env;
const SEQUOIA = "sequoia@westpeek.ventures";
const SERVICE_ACCOUNT = JSON.stringify({ client_email: "sa@firm.iam.example", private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
const NOW = new Date("2026-11-02T14:00:00.000Z");
const nb: Record<string, string> = {};

const NOTE = [
  "Here are more changes:",
  "",
  "By locking in an LLM Partner (Acmeai) and a Memory Partner at $5,000/month each, you secure $10K/month.",
  "",
  "pitch this person at Acmeai - pat@acmeai.example.When pitching Pat",
  "Example’s partnership team, do not frame this as an event logo-placement.",
  "Frame it as a developer activation pipeline:",
  "",
  "   1. Guaranteed API Consumption: By forcing the entire cohort to build on",
  "   the product for 6 consecutive months.",
  "   2. Enterprise Code Proofs: open-source templates every month.",
  "",
  "Should we draft the formal prospectus now, or the email pitch first?",
  "",
  "On Thu, Oct 29, 2026 at 12:32 PM Sequoia Taylor <sequoia@westpeek.ventures>",
  "wrote:",
  "",
  "> earlier note: email nobody@quoted.example about it",
].join("\n");
const RAW = `From: Sequoia Taylor <${SEQUOIA}>\r\nTo: os@joinwestpeek.com\r\nSubject: Re: Wynn: 1 brand reply to approve · TLR-QQQQQQ\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${NOTE.replace(/\n/g, "\r\n")}\r\n`;

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT, WP_OS_NEVERBOUNCE_API_KEY: "nb_test" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://api.neverbounce.com/")) {
      const email = new URL(u).searchParams.get("email") ?? "";
      return new Response(JSON.stringify({ status: "success", result: nb[email] ?? "valid" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  for (const [m, d, topic] of [["2027-01", "2027-01-23", "The Longevity Reset"], ["2027-03", "2027-03-18", "Build Your Own AI Agent"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token, switch_deadline) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', '[]', ?5, '2026-11-15')")
      .bind(`tlc_${m}`, m, d, topic, m.replace("-", "").padEnd(32, "c")).run();
  }
  const h = await contentHashes(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
  // Her list: Acmeai for January and March, stuck at "Needs a way in".
  for (const m of ["2027-01", "2027-03"]) await env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch (id, month, brand, reason, added_by) VALUES (?1, ?2, 'Acmeai', 'important', 'Sequoia')").bind(`tmp_${m}`, m).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_way_in (brand_key, brand, state, months_json, pages_checked_json, why, opened_at, checked_at, changed_at) VALUES ('acmeai', 'Acmeai', 'OPEN', '[\"2027-01\",\"2027-03\"]', '[]', 'no address', ?1, ?1, ?1)").bind(NOW.toISOString()).run();
  // The thread she replied on: another brand's answer, for the March club.
  await env.WP_OS_DB.prepare("INSERT INTO tlc_deal (id, event_id, brand, contact_email, contact_source_url, firm_scope, first_sent_at, drip_step) VALUES ('tld_other', 'tlc_2027-03', 'Vectorco', 'mike@vectorco.example', 'https://vectorco.example', 'west-peek', '2026-10-27T00:00:00Z', 1)").run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state) VALUES ('tbr_1', 'tld_other', '<m@x>', 'Re', 'hi', ?1, 'QUESTION', 'Re', 'draft', 'NOTIFIED')").bind(NOW.toISOString()).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, sent_at) VALUES ('TLR-QQQQQQ', '[\"tbr_1\"]', '2026-10-29', ?1)").bind(NOW.toISOString()).run();
  await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope) VALUES ('inm_1', '<her@mail>', 'inbound-email/her.eml', ?1, 'os@joinwestpeek.com', 'Re: Wynn: 1 brand reply to approve · TLR-QQQQQQ', ?2, 100, ?3, 'west-peek')")
    .bind(SEQUOIA, new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), JSON.stringify({ passed: true, partner: SEQUOIA })).run();
  // The same words from someone else (spoofed, or not her) are never applied.
  await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope) VALUES ('inm_2', '<spoof@mail>', 'inbound-email/spoof.eml', ?1, 'os@joinwestpeek.com', 'hi', ?2, 100, ?3, 'west-peek')")
    .bind(SEQUOIA, new Date(NOW.getTime() - 86_400_000).toISOString(), JSON.stringify({ passed: false, partner: null })).run();
});
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("her note is read for a brand contact", () => {
  it("finds the brand, the address (ending at '.com' even with no space after it), the name and her angle", () => {
    const words = herWordsIn(RAW);
    expect(words).not.toContain("nobody@quoted.example"); // the quoted email is not her instruction
    const found = ownerContactInstructions(words, ["Acmeai", "Google"], [{ month: "2027-01", topic: "The Longevity Reset" }, { month: "2027-03", topic: "Build Your Own AI Agent" }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ brand: "Acmeai", brandKey: "acmeai", email: "pat@acmeai.example", contactName: "Pat Example", months: null });
    expect(found[0]!.angle).toMatch(/^When pitching Pat Example’s partnership team/);
    expect(found[0]!.angle).toContain("Enterprise Code Proofs");
    expect(found[0]!.angle).not.toContain("Should we draft"); // her closing question to Wynn is not the angle
  });
  it("an address with no instruction, or one of ours, is not a contact", () => {
    expect(ownerContactInstructions("FYI the old thread was with ops@acmeai.example last year.", ["Acmeai"])).toEqual([]);
    expect(ownerContactInstructions("pitch Acmeai, reply to sequoia@westpeek.ventures", ["Acmeai"])).toEqual([]);
  });
  it("a brand outside her list still counts when she names it", () => {
    expect(ownerContactInstructions("please reach out to the team at Brightwave - jo@brightwave.example", [])[0]).toMatchObject({ brand: "Brightwave", email: "jo@brightwave.example" });
  });
  it("the address sentence is never learned as a standing rule for every brand", () => {
    for (const r of standingRulesIn(herWordsIn(RAW))) expect(r).not.toMatch(/@/);
  });
});

describe("applied through the must-pitch path, once, for the thread's club", () => {
  it("her contact is on the brand's way-in item and its March deal; January is still searched", async () => {
    const raw: Record<string, string> = { "inbound-email/her.eml": RAW, "inbound-email/spoof.eml": RAW };
    const lines = await applyOwnerEmailInstructions(env, NOW, "west-peek", async (k) => raw[k] ?? null);
    expect(lines).toEqual(["Acmeai <pat@acmeai.example>: 2027-03 queued"]);
    const way = await env.WP_OS_DB.prepare("SELECT * FROM tlc_way_in WHERE brand_key = 'acmeai'").first<{ state: string; contact_email: string; contact_months_json: string; supplied_by: string }>();
    expect(way).toMatchObject({ state: "CONTACT_ADDED", contact_email: "pat@acmeai.example", contact_months_json: '["2027-03"]', supplied_by: "Sequoia (by email)" });
    const deals = (await env.WP_OS_DB.prepare("SELECT event_id, contact_email, contact_name, contact_source_url, owner_angle FROM tlc_deal WHERE lower(brand) = 'acmeai'").all<{ event_id: string; contact_source_url: string; owner_angle: string; contact_name: string }>()).results;
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ event_id: "tlc_2027-03", contact_name: "Pat Example" });
    expect(deals[0]!.contact_source_url).toMatch(/^owner-supplied:/);
    expect(deals[0]!.owner_angle).toMatch(/developer activation pipeline/);
    // January is not covered by her contact, so it is still searched like any must-pitch brand.
    const search = await mustPitchToSearch(env, [{ id: "tlc_2027-01", month: "2027-01" }, { id: "tlc_2027-03", month: "2027-03" }], [{ brand: "Acmeai", event_id: "tlc_2027-03" }], "west-peek");
    expect(search.filter((s) => s.brand === "Acmeai").map((s) => s.months)).toEqual([["2027-01"]]);
    // Read once: a second pass applies nothing.
    expect(await applyOwnerEmailInstructions(env, NOW, "west-peek", async (k) => raw[k] ?? null)).toEqual([]);
  });

  it("email 1 opens with West Peek, carries her angle in brand words, and goes to her even when NeverBounce says accept-all", async () => {
    nb["pat@acmeai.example"] = "catchall";
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = ?1 WHERE lower(brand) = 'acmeai'").bind(NOW.toISOString()).run();
    const out = await runDrip(env, NOW, "west-peek", {}, async () => "We would build the series on Acmeai: members build on it across six events and publish open-source templates each month.");
    expect(out.addressRefused ?? []).toEqual([]);
    const m = await env.WP_OS_DB.prepare("SELECT m.subject, m.body, m.state FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE lower(d.brand) = 'acmeai'").first<{ subject: string; body: string; state: string }>();
    expect(m?.state).toBe("AWAITING_APPROVAL");
    expect(m!.body).toMatch(/^Hi Pat,\n\nI'm Sequoia Taylor of West Peek\. We are a community of about 5,000 /);
    expect(m!.body).toContain("Quarantine Con");
    expect(m!.body).toContain("West Peek Rooms");
    expect(m!.body).toContain("The Learning Club");
    expect(m!.body).toContain("members build on it across six events");
    expect(m!.body).not.toMatch(/\$|guarantee|forcing|\bcall\b/i);
    const check = await env.WP_OS_DB.prepare("SELECT result FROM tlc_address_check WHERE email = 'pat@acmeai.example'").first<{ result: string }>();
    expect(check?.result).toBe("catchall");
    expect(ownerContactLines({ contact_source_url: "owner-supplied:Sequoia (by email)", owner_angle: "Frame it as a pipeline.", nb_result: "catchall", step: 0 })).toEqual([
      "Address: the one you gave Wynn yourself, so it is used as you gave it. NeverBounce: accept-all (the domain takes any address, so it cannot confirm this one).",
      "Your angle (from your email): Frame it as a pipeline.",
    ]);
  });

  it("a line that breaks her rules is left out, never put in front of the brand", () => {
    expect(angleLineProblems("Guaranteed API consumption by forcing the cohort onto Claude.")).toEqual(["guarantee language"]);
    expect(angleLineProblems("A $10,000 / mo title slot.")).toContain("money");
    expect(angleLineProblems("Could we hop on a call?")).toContain("a call ask");
    const mail = ownerAngleFirstEmail({ brand: "Acmeai", contactName: null, topic: "Build Your Own AI Agent", month: "2027-03", angleLine: "Guaranteed consumption, by forcing it." });
    expect(mail.text).not.toMatch(/guarantee|forcing/i);
    expect(mail.text).toMatch(/^Hi,\n\nI'm Sequoia Taylor of West Peek\./);
  });
});
