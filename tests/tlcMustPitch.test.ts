import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { brandSendGate } from "../src/shared/tlc/learningClub";
import { wayInWords } from "../src/shared/tlc/mustPitch";
import { buildBrandBatchPrompt, contentHashes, openBrandBatchCard, runDrip, runTlcCard } from "../src/worker/services/learningClub";
import { sweepOnce } from "../src/worker/services/workSweep";

/**
 * BRANDS WE MUST PITCH (owner, 23 Oct 2026: "are we reaching out to anthropic i think that is important
 * and google?"). Her list comes first, outside the five-per-club cap; a brand with no public address is a
 * "Needs a way in" item, never a silent drop; an address she supplies is accepted without a page check;
 * and the send gate is exactly what it was.
 */

let t: TestDb;
let env: Env;
const SEQUOIA = "sequoia@westpeek.ventures";
const live = async (url: string): Promise<boolean> => !url.includes("dead.example");
const call = (path: string, body?: unknown) =>
  handleRequest(
    new Request(`https://test.local${path}`, body === undefined ? { headers: { "x-wpos-dev-user": SEQUOIA } } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-wpos-dev-user": SEQUOIA, "sec-fetch-site": "same-origin" } }),
    env,
  );
interface WayInView { brand_key: string; brand: string; state: string; months: string[]; pages: string[]; words: string; changed_at: string; checked_at: string; on_approvals: boolean }
interface Overview { must_pitch: Array<{ id: string; month: string; brand: string; reason: string; added_by: string }>; removed: Array<{ brand: string; removed_by: string; removed_at: string }>; way_in: WayInView[]; history: Array<{ brand: string; action: string; by_who: string; at: string }> }
const overview = async (): Promise<Overview> => (await (await call("/api/tlc/must-pitch")).json()) as Overview;

const WEEK1 = new Date("2026-11-09T14:00:00.000Z");
const WEEK2 = new Date("2026-11-16T14:00:00.000Z");
const WEEK3 = new Date("2026-11-23T14:00:00.000Z");

/** One brand batch, with the model's answer and the pages it can read. Returns the prompt it was given. */
async function batch(now: Date, answer: unknown, pages: Record<string, string> = {}): Promise<{ prompt: string; read: string[] }> {
  expect((await openBrandBatchCard(env, now)).opened).toBe(true);
  let prompt = "";
  const read: string[] = [];
  await sweepOnce(env, now, {
    tlc: (e, c) =>
      runTlcCard(e, c, {
        search: async (_e, _a, p) => {
          prompt = p;
          return { ok: true, text: JSON.stringify(answer), detail: "ok" };
        },
        urlCheck: live,
        pageText: async (u) => {
          read.push(u);
          return pages[u] ?? null;
        },
        now,
      }),
  });
  return { prompt, read };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
  for (const [m, d, topic] of [["2027-01", "2027-01-21", "The Longevity Reset"], ["2027-02", "2027-02-18", "Matcha & Tea"], ["2027-03", "2027-03-18", "Build Your Own AI Agent"]] as const) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES (?1, ?2, ?3, 'EVENING', ?4, 'A hands-on evening.', 'TOPIC_READY', '[]', ?5)")
      .bind(`tlc_${m}`, m, d, topic, `${m.replace("-", "")}`.padEnd(32, "a")).run();
  }
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the owner's seeds", () => {
  it("Anthropic for January and March, FORVR Mood for February, Google for March, each with her reason and her name", async () => {
    const o = await overview();
    expect(o.must_pitch.map((r) => [r.month, r.brand, r.added_by])).toEqual([
      ["2027-01", "Anthropic", "Sequoia"],
      ["2027-02", "FORVR Mood", "Sequoia"],
      ["2027-03", "Anthropic", "Sequoia"],
      ["2027-03", "Google", "Sequoia"],
    ]);
    expect(o.must_pitch[0]!.reason).toMatch(/AI partner.*Title partner if the backup club, AI Tools for Your Work, runs/);
    expect(o.must_pitch[1]!.reason).toBe("Owner's pick: a scrappy challenger fragrance brand competing with the big houses. Title or Presenting.");
    expect(o.must_pitch[3]!.reason).toMatch(/Google for Startups \/ Google Cloud.*host venue/);
  });
});

describe("must-pitch brands come first", () => {
  it("are named in the prompt before the model's own search, and are queued first and outside the five-per-club cap", async () => {
    const six = ["One", "Two", "Three", "Four", "Five", "Six"].map((n) => ({ month: "2027-01", brand: `${n} Co`, category: "Wellness", contact_name: `${n} Person`, contact_email: `${n.toLowerCase()}@${n.toLowerCase()}.example`, contact_source_url: `https://${n.toLowerCase()}.example/team` }));
    const pages: Record<string, string> = Object.fromEntries(six.map((b) => [b.contact_source_url, `Partnerships: ${b.contact_email}`]));
    pages["https://anthropic.example/events"] = "Events and community: Dev Rel <devrel@anthropic.example>";
    const { prompt } = await batch(
      WEEK1,
      {
        must_pitch: [
          { brand: "Anthropic", contact_name: "Dev Rel", contact_email: "devrel@anthropic.example", contact_source_url: "https://anthropic.example/events", pages_checked: ["https://anthropic.example/events"] },
          { brand: "Google", contact_name: "", contact_email: "", contact_source_url: "", pages_checked: ["https://startup.google.example/programs", "https://cloud.google.example/startup"] },
        ],
        // The model also offers Anthropic as one of its own picks: it is never a second, capped pick.
        brands: [{ month: "2027-01", brand: "Anthropic", contact_email: "devrel@anthropic.example", contact_source_url: "https://anthropic.example/events" }, ...six],
      },
      pages,
    );
    const first = prompt.indexOf("FIRST, before choosing any brand of your own");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(prompt.indexOf("Find brands to sponsor these clubs"));
    expect(prompt).toContain("- Anthropic, for January 2027 and March 2027.");
    expect(prompt).toContain("- Google, for March 2027.");
    expect(prompt).toMatch(/partnerships, events, community, a startup program or developer relations/);
    expect(prompt).toMatch(/They do not count toward the 5 per club/);
    const deals = (await env.WP_OS_DB.prepare("SELECT brand, event_id, contact_email, contact_source_url FROM tlc_deal ORDER BY rowid").all<{ brand: string; event_id: string; contact_email: string; contact_source_url: string }>()).results!;
    // Her brands first; then the model's own, capped at five for January. Six Co is over the cap.
    expect(deals.map((d) => [d.brand, d.event_id])).toEqual([
      ["Anthropic", "tlc_2027-01"],
      ["Anthropic", "tlc_2027-03"],
      ["One Co", "tlc_2027-01"],
      ["Two Co", "tlc_2027-01"],
      ["Three Co", "tlc_2027-01"],
      ["Four Co", "tlc_2027-01"],
      ["Five Co", "tlc_2027-01"],
    ]);
    expect(deals[0]!.contact_source_url).toBe("https://anthropic.example/events");
    const card = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE kind = 'TLC_BRAND_BATCH' ORDER BY created_at DESC LIMIT 1").first<{ description: string }>();
    expect(card!.description).toContain("Brands we must pitch, queued first: Anthropic (2027-01, 2027-03).");
    expect(card!.description).toContain("Six Co: over the 5-a-club limit");
  });

  it("the prompt carries no must-pitch section when her list has nothing open", () => {
    expect(buildBrandBatchPrompt([], [])).not.toContain("FIRST, before choosing");
  });
});

describe("no address means a 'Needs a way in' item, never a silent drop", () => {
  it("Google had no address: an item in her words, with the pages checked, on the panel and on Approvals", async () => {
    const o = await overview();
    const g = o.way_in.find((w) => w.brand === "Google")!;
    expect(g.state).toBe("OPEN");
    expect(g.months).toEqual(["2027-03"]);
    expect(g.pages).toEqual(["https://startup.google.example/programs", "https://cloud.google.example/startup"]);
    expect(g.words).toBe("Google (Mar): no public partnerships address found. Pages checked: https://startup.google.example/programs, https://cloud.google.example/startup. If you have a contact or an intro, add it here.");
    expect(g.on_approvals).toBe(true);
    expect(o.history.some((h) => h.brand === "Google" && h.action === "NO_ADDRESS" && h.by_who === "Wynn")).toBe(true);
    const card = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE kind = 'TLC_BRAND_BATCH' ORDER BY created_at DESC LIMIT 1").first<{ description: string }>();
    expect(card!.description).toContain(`• Needs a way in: ${g.words}`);
  });

  it("the sentence reads the way she asked, across months", () => {
    expect(wayInWords({ brand: "Anthropic", months: ["2027-03", "2027-01"], pages: ["https://a.example/x"] })).toBe(
      "Anthropic (Jan, Mar): no public partnerships address found. Pages checked: https://a.example/x. If you have a contact or an intro, add it here.",
    );
  });

  it("an address the model claims but the page does not carry is a way-in item too, and the page check is exactly as strict", async () => {
    await call("/api/tlc/must-pitch", { month: "2027-02", brand: "Leaf Labs", reason: "Tea partner" });
    await batch(WEEK2, {
      must_pitch: [
        { brand: "Leaf Labs", contact_name: "A Person", contact_email: "guess@leaflabs.example", contact_source_url: "https://leaflabs.example/about", pages_checked: [] },
        // Google: no contact again this week.
        { brand: "Google", contact_email: "", contact_source_url: "", pages_checked: ["https://startup.google.example/programs"] },
      ],
      brands: [],
    }, { "https://leaflabs.example/about": "About us. Write to us via the form." });
    const o = await overview();
    const leaf = o.way_in.find((w) => w.brand === "Leaf Labs")!;
    expect(leaf.state).toBe("OPEN");
    expect(leaf.pages).toEqual(["https://leaflabs.example/about"]);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_deal WHERE brand = 'Leaf Labs'").first<{ n: number }>())!.n).toBe(0);
    // A batch that queued nothing new still finishes as a stop she can see, never a silent exit.
    const card = await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE kind = 'TLC_BRAND_BATCH' ORDER BY created_at DESC LIMIT 1").first<{ state: string; description: string }>();
    expect(card!.state).toBe("DONE");
    expect(card!.description).toContain("Needs a way in: Leaf Labs (Feb)");
  });

  it("is re-checked weekly but resurfaces only when something changes; hiding it keeps it off Approvals until then", async () => {
    const before = (await overview()).way_in.find((w) => w.brand === "Google")!;
    // Week 2 re-checked it with nothing new: checked again, not changed.
    expect(before.checked_at).toBe(WEEK2.toISOString());
    expect(before.changed_at).toBe(WEEK1.toISOString());
    expect((await call(`/api/tlc/way-in/${encodeURIComponent(before.brand_key)}/hide`, {})).status).toBe(200);
    expect((await overview()).way_in.find((w) => w.brand === "Google")!.on_approvals).toBe(false);
    // Something changes: Google is added for January too. The next batch resurfaces it.
    expect((await call("/api/tlc/must-pitch", { month: "2027-01", brand: "Google", reason: "Cloud credits" })).status).toBe(200);
    await batch(WEEK3, { must_pitch: [], brands: [] });
    const after = (await overview()).way_in.find((w) => w.brand === "Google")!;
    expect(after.months).toEqual(["2027-01", "2027-03"]);
    expect(after.changed_at).toBe(WEEK3.toISOString());
    expect(after.on_approvals).toBe(true);
    expect(after.words.startsWith("Google (Jan, Mar): no public partnerships address found.")).toBe(true);
  });
});

describe("an owner-supplied contact is accepted", () => {
  it("skips the page check because she supplied it, and queues the brand for every open month on her list", async () => {
    const key = encodeURIComponent((await overview()).way_in.find((w) => w.brand === "Google")!.brand_key);
    expect((await call(`/api/tlc/way-in/${key}/contact`, { contact_name: "A Friend", contact_email: "not an address" })).status).toBe(400);
    const res = await call(`/api/tlc/way-in/${key}/contact`, { contact_name: "A Friend", contact_email: "Friend@Google.example", note: "intro from the accelerator" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queued: string[] }).queued).toEqual(["2027-01", "2027-03"]);
    const deals = (await env.WP_OS_DB.prepare("SELECT event_id, contact_name, contact_email, contact_source_url, stage, drip_step FROM tlc_deal WHERE brand = 'Google' ORDER BY event_id").all<Record<string, unknown>>()).results!;
    expect(deals).toEqual([
      { event_id: "tlc_2027-01", contact_name: "A Friend", contact_email: "friend@google.example", contact_source_url: "owner-supplied:Sequoia", stage: "PROSPECT", drip_step: 0 },
      { event_id: "tlc_2027-03", contact_name: "A Friend", contact_email: "friend@google.example", contact_source_url: "owner-supplied:Sequoia", stage: "PROSPECT", drip_step: 0 },
    ]);
    const o = await overview();
    const g = o.way_in.find((w) => w.brand === "Google")!;
    expect(g.state).toBe("CONTACT_ADDED");
    expect(g.on_approvals).toBe(false);
    expect(o.history.some((h) => h.brand === "Google" && h.action === "CONTACT_ADDED" && h.by_who === "Sequoia")).toBe(true);
  });

  it("is never searched again, and no page is read for it", async () => {
    const week4 = new Date("2026-11-30T14:00:00.000Z");
    const { prompt, read } = await batch(week4, { must_pitch: [], brands: [] });
    expect(prompt).not.toContain("- Google, for");
    expect(read.some((u) => u.includes("google"))).toBe(false);
  });
});

describe("the list: add, remove with who and when", () => {
  it("adds once per month, removes by marking, and keeps every change", async () => {
    expect((await call("/api/tlc/must-pitch", { month: "2027-02", brand: "leaf labs", reason: "again" })).status).toBe(409);
    expect((await call("/api/tlc/must-pitch", { month: "2027-02", brand: "", reason: "x" })).status).toBe(400);
    const row = (await overview()).must_pitch.find((r) => r.brand === "Leaf Labs")!;
    expect((await call(`/api/tlc/must-pitch/${row.id}/remove`, {})).status).toBe(200);
    expect((await call(`/api/tlc/must-pitch/${row.id}/remove`, {})).status).toBe(404);
    const o = await overview();
    expect(o.must_pitch.some((r) => r.brand === "Leaf Labs")).toBe(false);
    expect(o.removed.find((r) => r.brand === "Leaf Labs")).toMatchObject({ removed_by: "Sequoia" });
    expect(o.history.filter((h) => h.brand === "Leaf Labs").map((h) => [h.action, h.by_who])).toEqual(expect.arrayContaining([["ADDED", "Sequoia"], ["REMOVED", "Sequoia"]]));
    // Never deleted, by the database itself.
    await expect(env.WP_OS_DB.prepare("DELETE FROM tlc_must_pitch WHERE id = ?1").bind(row.id).run()).rejects.toThrow(/never deleted/);
  });
});

describe("the gate is unchanged", () => {
  it("a must-pitch deal, found or hers, is held while the gate is shut and waits for a per-email approval when it is open", async () => {
    const held = await runDrip(env, new Date("2026-11-09T15:00:00.000Z"));
    expect(held.gate.open).toBe(false);
    expect(held.sent + held.awaitingApproval).toBe(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM external_effect_request").first<{ n: number }>())!.n).toBe(0);
    // The gate's answer is the same function of the same inputs: nothing about must-pitch reaches it.
    const h = await contentHashes(env);
    const onList = { allowed: true, code: "ALLOWED", reason: "TLC brand sales is on your Outside email list." };
    expect(brandSendGate({ brand_send: "on", pitch_approved_hash: h.pitch, playbook_approved_hash: h.playbook }, onList, h)).toEqual({ open: true, reasons: [], outside_email_allowed: true });
    expect(brandSendGate({ pitch_approved_hash: h.pitch, playbook_approved_hash: h.playbook }, onList, h).open).toBe(false);
    // Open it fully: every email, Google's (her contact) included, waits for an approval card. None is sent.
    await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
    await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(h.pitch, h.playbook).run();
    const out = await runDrip(env, new Date("2026-11-09T15:05:00.000Z"));
    expect(out.gate.open).toBe(true);
    expect(out.sent).toBe(0);
    expect(out.awaitingApproval).toBeGreaterThan(0);
    const unapproved = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE effect_request_id IS NOT NULL AND approval_card_id IS NULL").first<{ n: number }>();
    expect(unapproved!.n).toBe(0);
    await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = 'off' WHERE key = 'brand_send'").run();
  });
});
