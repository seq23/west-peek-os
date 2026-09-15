import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  PRODUCTIONS_OFFER,
  buildCustomerPrompt,
  buildPressPrompt,
  keepLive,
  openProductionsCard,
  parseCustomerIdeas,
  parsePressPitches,
  renderPressEmail,
  runProductionsCard,
} from "../src/worker/services/productions";
import { sweepOnce } from "../src/worker/services/workSweep";
import { runDueJobs } from "../src/worker/services/jobs";
import { JOB_FACTS } from "../src/shared/work/scheduledWork";
import { skillsForMachines } from "../src/shared/skills/library";

/**
 * Walker helping West Peek Productions — Scooter's own agency (15 Sep 2026), proven offline.
 *
 * The three things that must be true: the work is monthly and idempotent; nothing without a live
 * URL survives, and no address is kept without the page it came from; the result reaches Scooter
 * and only Scooter, and nothing touches the fund or leaves for a prospect or a journalist.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-10-01T14:00:00.000Z");

const customerJson = JSON.stringify({
  results: [
    { organisation: "Example Nonprofit", trigger: "announced a national summit for March", approach: "Head of Community", angle: "the summit needs a community that outlives it", url: "https://example.org/summit" },
    { organisation: "Dead Link Co", trigger: "raised a Series B", approach: "VP Marketing", angle: "new audience", url: "https://dead.example/press" },
    { organisation: "No URL Inc", trigger: "hired a community lead", approach: "that lead" },
  ],
});

const pressJson = JSON.stringify({
  results: [
    { writer: "A. Writer", outlet: "Community Weekly", email: "a.writer@communityweekly.example", contact_url: "https://communityweekly.example/about", why_this_writer: "covers community programmes", hook: "Community is an operating advantage", proof_url: "https://communityweekly.example/piece", draft: "Hi A —\nI run West Peek Productions." },
    { writer: "B. Guesser", outlet: "GTM Letter", email: "b.guesser@gtmletter.example", contact_url: null, why_this_writer: "covers GTM", hook: "hook", proof_url: "https://gtmletter.example/post", draft: "Hi B" },
    { writer: "C. Nowhere", outlet: "Nowhere", proof_url: "https://dead.example/x", draft: "Hi C" },
  ],
});

const urlCheck = async (url: string): Promise<boolean> => !url.includes("dead.example");

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_walker'").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("what Walker is told", () => {
  it("carries the offer read from westpeekproductions.com and the boundary", () => {
    expect(PRODUCTIONS_OFFER).toContain("Community-as-a-Service");
    expect(PRODUCTIONS_OFFER).toContain("$2,500–$7,500");
    const prompt = buildCustomerPrompt("2026-10");
    expect(prompt).toContain("Scooter's OWN agency");
    expect(prompt).toContain("not for the fund");
    expect(prompt).toMatch(/Do NOT\n\s+invent a person's name or email/);
    const press = buildPressPrompt("2026-10");
    expect(press).toMatch(/ONLY if a live page shows it/);
    expect(press).toMatch(/Never guess an address pattern/);
  });

  it("has a written method on Scooter's personal-office machine that states the boundary", () => {
    const skill = skillsForMachines(["mp_personal_office"]).find((s) => s.key === "west_peek_productions_for_scooter");
    expect(skill).toBeTruthy();
    expect(skill!.guidance.join(" ")).toMatch(/not West Peek Ventures/);
    expect(skill!.guidance.join(" ")).toMatch(/scooter@westpeek.ventures only/);
    expect(skill!.guidance.join(" ")).toMatch(/No fabricated contacts/);
  });

  it("describes both jobs on the Work page as Scooter's agency duty, not fund work", () => {
    for (const key of ["productions_customer_ideas", "productions_press_pitches"]) {
      expect(JOB_FACTS[key]?.what).toMatch(/Scooter's own agency, not the fund/);
      expect(JOB_FACTS[key]?.deliveredBy).toEqual(["Walker"]);
    }
  });
});

describe("what survives the search", () => {
  it("drops an idea with no URL, and one whose page is dead", async () => {
    const parsed = parseCustomerIdeas(customerJson);
    expect(parsed.map((i) => i.organisation)).toEqual(["Example Nonprofit", "Dead Link Co"]);
    const live = await keepLive(parsed, (i) => i.url, urlCheck);
    expect(live.kept.map((i) => i.organisation)).toEqual(["Example Nonprofit"]);
    expect(live.dropped).toEqual(["https://dead.example/press"]);
  });

  it("keeps an email only with the page it was read from; otherwise points at the contact page", () => {
    const pitches = parsePressPitches(pressJson);
    expect(pitches).toHaveLength(3);
    expect(pitches[0]!.email).toBe("a.writer@communityweekly.example");
    // An address with no page behind it is a guess, and a guess is not sent to anybody.
    expect(pitches[1]!.email).toBeNull();
    const text = renderPressEmail("2026-10", pitches.slice(0, 2), []);
    expect(text).toContain("To: a.writer@communityweekly.example");
    expect(text).toContain("(address read from https://communityweekly.example/about)");
    expect(text).toContain("To: no public address found — contact page: not found");
    expect(text).toMatch(/nothing leaves this system for a journalist/);
  });
});

describe("the monthly card on Walker's desk", () => {
  it("opens once a month, however often the job fires", async () => {
    const first = await openProductionsCard(env, "productions_customer_ideas", NOW);
    const again = await openProductionsCard(env, "productions_customer_ideas", new Date(NOW.getTime() + 86_400_000 * 3));
    expect(first.opened).toBe(true);
    expect(again.opened).toBe(false);
    expect(again.cardId).toBe(first.cardId);
    const card = await env.WP_OS_DB.prepare("SELECT kind, owner_id, description FROM work_card WHERE id = ?1").bind(first.cardId).first<{ kind: string; owner_id: string; description: string }>();
    expect(card!.kind).toBe("PRODUCTIONS_CUSTOMERS");
    expect(card!.owner_id).toBe("aie_walker");
    expect(card!.description).toMatch(/Scooter's own business, not part of West Peek Ventures/);
  });

  it("is worked by the sweep: search, verify, email Scooter only, DONE — and Sequoia is not told", async () => {
    const out = await sweepOnce(env, NOW, {
      productions: (e, card) => runProductionsCard(e, card, { search: async () => ({ ok: true, text: customerJson, detail: "ok" }), urlCheck, now: NOW }),
    });
    expect(out.outcome).toBe("DONE");
    expect(out.summary).toMatch(/Walker: 1 who could buy Community-as-a-Service this month/);

    const card = out.card!;
    const mail = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(card.id).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mail).toHaveLength(1);
    const payload = JSON.parse(mail[0]!.payload_json) as { to: string; subject: string };
    expect(payload.to).toBe("scooter@westpeek.ventures");
    expect(payload.subject).toBe("Walker: 1 who could buy Community-as-a-Service this month");

    const notices = (await env.WP_OS_DB.prepare("SELECT firm_user_id FROM notification WHERE object_type = 'work_card' AND object_id = ?1").bind(card.id).all<{ firm_user_id: string | null }>()).results!;
    expect(notices.map((n) => n.firm_user_id)).toEqual(["fu_scooter_taylor"]);

    const done = await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string; description: string }>();
    expect(done!.state).toBe("DONE");
    expect(done!.description).toContain("Example Nonprofit");
    expect(done!.description).toContain("Left out because the cited page did not answer");
  });

  it("blocks, with the reason, when nothing has a live citation — and emails nothing", async () => {
    const opened = await openProductionsCard(env, "productions_press_pitches", NOW);
    const out = await sweepOnce(env, NOW, {
      productions: (e, card) => runProductionsCard(e, card, { search: async () => ({ ok: true, text: pressJson, detail: "ok" }), urlCheck: async () => false, now: NOW }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("BLOCKED");
    const mail = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(opened.cardId).first<{ n: number }>())!;
    expect(mail.n).toBe(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(opened.cardId).run();
  });

  it("is dispatched by job_key from the scheduler, and re-running is a success that opens nothing", async () => {
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED' WHERE job_key NOT IN ('productions_press_pitches')").run();
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'ACTIVE', next_run_at = ?1 WHERE job_key = 'productions_press_pitches'").bind(NOW.toISOString()).run();
    const results = await runDueJobs(env, new Date(NOW.getTime() + 60_000));
    const run = results.find((r) => r.job_key === "productions_press_pitches");
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.summary).toMatch(/Opened "Walker: 5 press pitches for West Peek Productions \(2026-10\)"/);
    const cards = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'PRODUCTIONS_PRESS' AND state != 'CANCELLED'").first<{ n: number }>();
    expect(cards!.n).toBe(1);
  });
});
