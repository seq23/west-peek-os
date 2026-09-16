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
    { organisation: "example nonprofit", trigger: "a second trigger at the same place", approach: "CMO", url: "https://example.org/other" },
  ],
});

/** A judge that keeps everything it is shown — for tests about the plumbing, not the judgement. */
const keepAll = async (_e: unknown, _a: unknown, prompt: string) => {
  const key = /"verdicts":\[\{"organisation"/.test(prompt) ? "organisation" : "writer";
  const start = prompt.indexOf(key === "organisation" ? "LEADS:\n" : "PITCHES:\n");
  const end = prompt.lastIndexOf("Return ONLY JSON");
  const body = JSON.parse(prompt.slice(start, end).replace(/^(LEADS|PITCHES):\n/, "")) as Record<string, string>[];
  return { ok: true, text: JSON.stringify({ verdicts: body.map((b) => ({ [key]: b[key], keep: true, reason: "fine" })) }), detail: "ok" };
};

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

  it("describes the one monthly job on the Work page as Scooter's agency duty, not fund work", () => {
    expect(JOB_FACTS.productions_monthly?.what).toMatch(/Scooter's own agency, not the fund/);
    expect(JOB_FACTS.productions_monthly?.deliveredBy).toEqual(["Walker"]);
    // The two it folded and the one-off introduction are RETIRED (0169): off the page, out of the facts.
    for (const key of ["productions_customer_ideas", "productions_press_pitches", "productions_intro_note"]) {
      expect(JOB_FACTS[key], `${key} is retired and must not be described as live work`).toBeUndefined();
    }
  });
});

describe("what survives the search", () => {
  it("drops an idea with no URL, a repeated organisation, and one whose page is dead", async () => {
    const parsed = parseCustomerIdeas(customerJson);
    expect(parsed.map((i) => i.organisation)).toEqual(["Example Nonprofit", "Dead Link Co"]);
    expect(buildCustomerPrompt("2026-10")).toMatch(/United States/);
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
    const text = renderPressEmail("2026-10", [{ ...pitches[0]!, emailKind: "personal" }, pitches[1]!], []);
    expect(text).toContain("To: a.writer@communityweekly.example");
    expect(text).toContain("(the writer's own address — read from https://communityweekly.example/about)");
    expect(text).toContain("To: no public address on any page checked — write via the outlet's contact page");
    expect(text).toMatch(/nothing leaves this system for a journalist/);
  });

  /*
   * THE ADDRESS HUNT. Operator, 15 Sep 2026: "why couldn't u find these journalists' emails — this
   * seems weak and like it should have been achievable." The first run kept an address only if the
   * one page the search cited showed it. Now the pages that show addresses are asked for, fetched
   * and read, the writer's own address wins, an outlet inbox is the labelled fallback, and a
   * pattern or a remembered address is never used.
   */
  it("reads addresses off a page and prefers the writer's own over the outlet's inbox", async () => {
    const { addressesIn, chooseAddress } = await import("../src/worker/services/productions");
    const page = `<a href="mailto:lia&#64;icymi.example">email</a> tips@icymi.example logo@2x.png noreply@icymi.example editors@icymi.example`;
    const found = addressesIn(page);
    expect(found).toEqual(expect.arrayContaining(["lia@icymi.example", "tips@icymi.example", "editors@icymi.example"]));
    expect(found).not.toContain("noreply@icymi.example");
    expect(chooseAddress(found, "Lia Haberman", "icymi.example")).toEqual({ email: "lia@icymi.example", kind: "personal" });
    expect(chooseAddress(["tips@icymi.example"], "Lia Haberman", "icymi.example")).toEqual({ email: "tips@icymi.example", kind: "outlet" });
    expect(chooseAddress(["someone@elsewhere.example"], "Lia Haberman", "icymi.example")).toBeNull();
  });

  it("hunts: asks for the pages that show an address, reads them, and records where the address came from", async () => {
    const { findWriterAddress } = await import("../src/worker/services/productions");
    const pitch = { writer: "Conor Murray", outlet: "Forbes", email: null, contactUrl: null, whyThisWriter: "", hook: "", proofUrl: "https://forbes.example/sites/conormurray/piece", draft: "" };
    const asked: string[] = [];
    const out = await findWriterAddress(env, { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: ["west-peek"] }, pitch, {
      search: async (_e, _a, prompt) => { asked.push(prompt); return { ok: true, text: "https://forbes.example/sites/conormurray/\nhttps://muckrack.example/conor-murray", detail: "ok" }; },
      pageText: async (url) => (url === "https://muckrack.example/conor-murray" ? "Conor Murray, Forbes. Contact: cmurray@forbes.example" : "no addresses here"),
    });
    expect(asked[0]).toMatch(/public email address of Conor Murray/);
    expect(out.email).toBe("cmurray@forbes.example");
    expect(out.emailKind).toBe("personal");
    expect(out.contactUrl).toBe("https://muckrack.example/conor-murray");
    // Nothing found anywhere: no address, and the contact page to write via is named.
    const none = await findWriterAddress(env, { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: ["west-peek"] }, pitch, {
      search: async () => ({ ok: true, text: "https://forbes.example/contact", detail: "ok" }),
      pageText: async () => "a page with no address",
    });
    expect(none.email).toBeNull();
    expect(none.contactUrl).toBe("https://forbes.example/contact");
  });

  it("chooses the five with intent: the prompt demands a mix of outlets and a piece each choice is earned by", async () => {
    const { buildPressPrompt } = await import("../src/worker/services/productions");
    const prompt = buildPressPrompt("2026-10");
    expect(prompt).toMatch(/TRADE PRESS those buyers read daily/);
    expect(prompt).toMatch(/CREATOR-ECONOMY or COMMUNITY NEWSLETTER/);
    expect(prompt).toMatch(/EVENTS-INDUSTRY OUTLET/);
    expect(prompt).toMatch(/WILDCARD earned by a specific recent piece/);
    expect(prompt).toMatch(/A writer chosen because their beat vaguely matches\s+is not a choice/);
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
      productions: (e, card) => runProductionsCard(e, card, { search: async () => ({ ok: true, text: pressJson, detail: "ok" }), urlCheck: async () => false, pageText: async () => null, now: NOW }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("BLOCKED");
    const mail = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(opened.cardId).first<{ n: number }>())!;
    expect(mail.n).toBe(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(opened.cardId).run();
  });

  it("is dispatched by job_key from the scheduler, and re-running is a success that opens nothing", async () => {
    // Only the live rows: a RETIRED row (0169) is not paused, it is retired, and stays so.
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED' WHERE status = 'ACTIVE' AND job_key NOT IN ('productions_press_pitches')").run();
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'ACTIVE', next_run_at = ?1 WHERE job_key = 'productions_press_pitches'").bind(NOW.toISOString()).run();
    const results = await runDueJobs(env, new Date(NOW.getTime() + 60_000));
    const run = results.find((r) => r.job_key === "productions_press_pitches");
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.summary).toMatch(/Opened "Walker: 5 press pitches for West Peek Productions \(2026-10\)"/);
    const cards = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'PRODUCTIONS_PRESS' AND state != 'CANCELLED'").first<{ n: number }>();
    expect(cards!.n).toBe(1);
  });

  it("Walker introduces himself once: the note goes to Scooter, names os@joinwestpeek.com, and the job pauses itself", async () => {
    const { runIntroNote, renderIntroNote } = await import("../src/worker/services/productions");
    const note = renderIntroNote();
    expect(note.text).toMatch(/I'm Walker, your chief of staff/);
    expect(note.text).toMatch(/below the standard/);
    expect(note.text).toMatch(/os@joinwestpeek\.com/);
    expect(note.text).toMatch(/Porter routes it/);
    // A transport, so the send is real up to the provider's door.
    const { vi } = await import("vitest");
    const sends: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.resend.com")) { sends.push(String(init?.body)); return new Response(JSON.stringify({ id: "re_intro" }), { status: 200 }); }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    const withMail = { ...env, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    const first = await runIntroNote(withMail);
    vi.unstubAllGlobals();
    expect(first.status, first.summary).toBe("SUCCEEDED");
    expect(sends[0]).toContain("scooter@westpeek.ventures");
    expect(first.summary).toMatch(/sent to scooter@westpeek\.ventures/);
    // 0169 retired the job; sending the note must not quietly bring it back to PAUSED (or ACTIVE).
    const job = await env.WP_OS_DB.prepare("SELECT status FROM scheduled_job WHERE job_key = 'productions_intro_note'").first<{ status: string }>();
    expect(job?.status).toBe("RETIRED");
    const again = await runIntroNote(withMail);
    expect(again.summary).toMatch(/already sent/);
    const sent = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'deliverable.emailed_to_partner' AND payload_json LIKE '%Walker, your chief of staff%'").first<{ n: number }>())!.n;
    expect(sent).toBe(1);
  });

  it("ONE email a month: the monthly card does both searches, hunts the addresses, and sends Scooter a single note", async () => {
    const { openProductionsCard, renderMonthlyEmail } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2026-11-01T14:00:00.000Z"));
    expect(opened.title).toBe("Walker: West Peek Productions this month (2026-11)");
    let searches = 0;
    const out = await sweepOnce(env, new Date("2026-11-01T14:05:00.000Z"), {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => { searches += 1; return { ok: true, text: /journalists/.test(prompt) ? pressJson : customerJson, detail: "ok" }; },
        urlCheck,
        judge: keepAll,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date("2026-11-01T14:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("DONE");
    const mails = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all<{ payload_json: string }>()).results ?? [];
    const delivered = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!.description;
    expect(delivered).toMatch(/Walker: West Peek Productions this month — \d+ customer lead\(s\) and \d+ press pitch\(es\)/);
    expect(delivered).toMatch(/═══ 1 · WHO COULD BUY THIS MONTH/);
    expect(delivered).toMatch(/═══ 2 · PRESS PITCHES — YOURS TO SEND/);
    expect(delivered).toMatch(/Walker, your chief of staff/);
    expect(delivered).toMatch(/os@joinwestpeek\.com/);
    expect(mails.length, "at most one email for the month").toBeLessThanOrEqual(1);
    expect(searches).toBeGreaterThanOrEqual(2);
    expect(renderMonthlyEmail("2026-11", [], [], [])).toMatch(/Nothing with a live citation this month/);
  });

  it("BOTH HALVES OR NOTHING: a customer search with no urls is asked once more, and if still empty the card is BLOCKED and NO email goes out", async () => {
    // 16 Sep 2026, 00:02Z: Scooter received "0 customer lead(s) and 4 press pitch(es)" because the
    // customer search answered without a url on any entry and the card emailed anyway.
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2026-12-01T14:00:00.000Z"));
    const noUrls = JSON.stringify({ results: [{ organisation: "U.S. Space Force", trigger: "a launch programme", approach: "Comms lead", angle: "n/a" }] });
    const customerPrompts: string[] = [];
    const out = await sweepOnce(env, new Date("2026-12-01T14:05:00.000Z"), {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => {
          if (/journalists/.test(prompt)) return { ok: true, text: pressJson, detail: "ok" };
          customerPrompts.push(prompt);
          return { ok: true, text: noUrls, detail: "ok" };
        },
        judge: keepAll,
        urlCheck,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date("2026-12-01T14:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("BLOCKED");
    expect(customerPrompts.length, "asked once, then once more with the miss named").toBe(2);
    expect(customerPrompts[1]).toMatch(/Your previous answer was discarded[\s\S]*Rejected last time: nothing usable was returned/);
    const mails = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all<{ payload_json: string }>()).results ?? [];
    expect(mails.length, "a half note must not be sent").toBe(0);
    const row = (await env.WP_OS_DB.prepare("SELECT state, next_action FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; next_action: string }>())!;
    expect(row.state).toBe("BLOCKED");
    expect(row.next_action).toMatch(/Not sending a half note — no customer lead survived \(the search answered with no usable entry/);
  });
  it("THE JUDGEMENT PASS: what the searcher found is held to the brief by a second model; failures are dropped and the reason is on the note", async () => {
    // 16 Sep 2026: the searcher, told "United States, no government", returned VK, the Space Force
    // and a 2025 basketball schedule. The judge is the fix — not another line in the search prompt.
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-01-01T14:00:00.000Z"));
    const mixed = JSON.stringify({ results: [
      { organisation: "Example Nonprofit", trigger: "announced a national summit for March", approach: "Head of Community", angle: "the summit needs a community", url: "https://example.org/summit" },
      { organisation: "VK", trigger: "Uchi.ru unveiled a new visual style", approach: "Head of Brand", angle: "segmentation", url: "https://vk.company/ru/press/releases/12400/" },
      { organisation: "U.S. Space Force", trigger: "launch programme forecast to grow", approach: "Comms lead", angle: "storytelling", url: "https://www.spaceforce.mil/News/" },
    ] });
    const judgePrompts: string[] = [];
    const out = await sweepOnce(env, new Date("2027-01-01T14:05:00.000Z"), {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => ({ ok: true, text: /journalists/.test(prompt) ? pressJson : mixed, detail: "ok" }),
        judge: async (_e, _a, prompt) => {
          judgePrompts.push(prompt);
          if (/"verdicts":\[\{"organisation"/.test(prompt)) {
            return { ok: true, text: JSON.stringify({ verdicts: [
              { organisation: "Example Nonprofit", keep: true, reason: "US nonprofit, summit announced" },
              { organisation: "VK", keep: false, reason: "Russian company; a .ru press page is not a US buyer" },
              { organisation: "U.S. Space Force", keep: false, reason: "a military; does not hire agencies like this" },
            ] }), detail: "ok" };
          }
          return { ok: true, text: JSON.stringify({ verdicts: [{ writer: "A. Writer", keep: true, reason: "covers community programmes" }, { writer: "B. Guesser", keep: false, reason: "hook is the positioning restated" }] }), detail: "ok" };
        },
        urlCheck: async () => true,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date("2027-01-01T14:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("DONE");
    expect(judgePrompts.length, "one judgement per half").toBe(2);
    expect(judgePrompts[0]).toMatch(/KEEP a lead only if ALL of these hold \(this month is 2027-01\)/);
    const delivered = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!.description;
    expect(delivered).toMatch(/1 customer lead\(s\) and 1 press pitch\(es\)/);
    expect(delivered).toMatch(/1\. Example Nonprofit/);
    expect(delivered).not.toMatch(/\n\d+\. VK\n/);
    expect(delivered).not.toMatch(/B\. Guesser — GTM Letter/);
    expect(delivered).toMatch(/Left out on judgement .*VK — Russian company.*U\.S\. Space Force — a military.*B\. Guesser — hook is the positioning restated/);
  });

  it("a judge that cannot answer BLOCKS the card: unjudged research is never sent", async () => {
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-02-01T14:00:00.000Z"));
    const out = await sweepOnce(env, new Date("2027-02-01T14:05:00.000Z"), {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => ({ ok: true, text: /journalists/.test(prompt) ? pressJson : customerJson, detail: "ok" }),
        judge: async () => ({ ok: false, text: "", detail: "provider 503" }),
        urlCheck,
        pageText: async () => null,
        now: new Date("2027-02-01T14:05:00.000Z"),
      }),
    });
    expect(out.outcome).toBe("BLOCKED");
    const mails = (await env.WP_OS_DB.prepare("SELECT 1 FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all()).results ?? [];
    expect(mails.length).toBe(0);
    const row = (await env.WP_OS_DB.prepare("SELECT next_action FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ next_action: string }>())!;
    expect(row.next_action).toMatch(/the judgement pass failed: provider 503/);
  });
});
