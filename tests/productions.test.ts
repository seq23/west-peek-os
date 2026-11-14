import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import {
  PRODUCTIONS_OFFER,
  buildCustomerPrompt,
  currentCustomerNamed,
  excludeCurrentCustomers,
  buildPressPrompt,
  keepLive,
  openProductionsCard,
  parseCustomerIdeas,
  parsePressPitches,
  renderPressEmail,
  runProductionsCard,
  MONTHLY_EXTRA_PASSES,
} from "../src/worker/services/productions";
import { sweepOnce } from "../src/worker/services/workSweep";
import { steersWith } from "./helpers/interpret";
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

/**
 * The new truth for a month below the floor (owner, 14 Nov 2026): nothing for Sequoia and nothing sent yet; the card is
 * researched again the next day, up to MONTHLY_EXTRA_PASSES times, then what met the bar goes to Scooter and it is DONE.
 */
async function expectThinMonth(out: Awaited<ReturnType<typeof sweepOnce>>, runner: Parameters<typeof sweepOnce>[2], from: Date): Promise<void> {
  expect(out.outcome, out.summary).toBe("PROGRESSED");
  const id = out.card!.id;
  const row = async () => (await env.WP_OS_DB.prepare("SELECT state, block_who, description FROM work_card WHERE id = ?1").bind(id).first<Record<string, string | null>>())!;
  expect((await row()).block_who).toBeNull();
  let last = out;
  for (let n = 1; n <= MONTHLY_EXTRA_PASSES; n += 1) last = await sweepOnce(env, new Date(from.getTime() + n * 25 * 3_600_000), runner);
  expect(last.outcome, last.summary).toBe("DONE");
  expect(await row()).toMatchObject({ state: "DONE", block_who: null });
  expect(String((await row()).description), "Scooter's note carries no shortfall notice").not.toMatch(/THIN MONTH|a month needs/i);
}

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

  it("drops a search result naming a current customer, by name or alias, before it can reach the note", async () => {
    const raw = JSON.stringify({ results: [
      { organisation: "Exec Leadership Council", trigger: "announced the MLM Symposium", approach: "Head of Events", url: "https://elc.example/symposium" },
      { organisation: "The New Teacher Project", trigger: "hired a comms lead", approach: "CMO", url: "https://tntp.example/news" },
      { organisation: "Some Council", trigger: "its symposium is announced for the MLM Symposium week", approach: "Director", url: "https://some.example" },
      { organisation: "Fresh Association", trigger: "announced its annual managers' conference", approach: "Head of Events", url: "https://fresh.example/conf" },
    ] });
    const { kept, excluded } = excludeCurrentCustomers(parseCustomerIdeas(raw));
    expect(kept.map((i) => i.organisation)).toEqual(["Fresh Association"]);
    expect(excluded.map((e) => e.name)).toEqual(["Exec Leadership Council", "The New Teacher Project", "Some Council"]);
    expect(excluded[1]!.reason).toMatch(/a current customer \(TNTP\)/);
    expect(currentCustomerNamed("nothing here")).toBeNull();

    // End to end through the monthly card: the customer is in the searcher's answer, the judge would
    // keep it, and it still never reaches the note — the exclusion is before the judge, not after.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-03-01T14:00:00.000Z"));
    const runner: Parameters<typeof sweepOnce>[2] = {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => ({ ok: true, text: /journalists/.test(prompt) ? pressJson : raw, detail: "ok" }),
        urlCheck: async () => true,
        judge: keepAll,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date("2027-03-01T14:05:00.000Z"),
      }),
    };
    const out = await sweepOnce(env, new Date("2027-03-01T14:05:00.000Z"), runner);
    expect(out.card?.id).toBe(opened.cardId);
    await expectThinMonth(out, runner, new Date("2027-03-01T14:05:00.000Z")); // fewer than six leads and two pitches: it goes, labelled, and the card stops by name (13 Nov 2026)
    const delivered = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!.description;
    expect(delivered).toMatch(/1\. Fresh Association/);
    expect(delivered).not.toMatch(/\d\. Exec Leadership Council/);
    expect(delivered).not.toMatch(/\d\. The New Teacher Project/);
    expect(delivered).toMatch(/Left out on judgement .*Exec Leadership Council — a current customer \(Exec Leadership Council\)/);
  });

  it("has a written method on Scooter's personal-office machine that states the boundary", () => {
    const skill = skillsForMachines(["mp_personal_office"]).find((s) => s.key === "west_peek_productions_for_scooter");
    expect(skill).toBeTruthy();
    expect(skill!.guidance.join(" ")).toMatch(/not West Peek Ventures/);
    expect(skill!.guidance.join(" ")).toMatch(/scooter@westpeek.ventures only/);
    expect(skill!.guidance.join(" ")).toMatch(/No fabricated contacts/);
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
    const sent = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'deliverable.emailed_to_partner' AND object_id = 'sjb_productions_intro_note'").first<{ n: number }>())!.n;
    expect(sent).toBe(1);
  });

  it("ONE email a month: the monthly card does both searches, hunts the addresses, and sends Scooter a single note", async () => {
    const { openProductionsCard, renderMonthlyEmail } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2026-11-01T14:00:00.000Z"));
    expect(opened.title).toBe("Walker: West Peek Productions this month (2026-11)");
    let searches = 0;
    const runner: Parameters<typeof sweepOnce>[2] = {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => { searches += 1; return { ok: true, text: /journalists/.test(prompt) ? pressJson : customerJson, detail: "ok" }; },
        urlCheck,
        judge: keepAll,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date("2026-11-01T14:05:00.000Z"),
      }),
    };
    const out = await sweepOnce(env, new Date("2026-11-01T14:05:00.000Z"), runner);
    expect(out.card?.id).toBe(opened.cardId);
    await expectThinMonth(out, runner, new Date("2026-11-01T14:05:00.000Z")); // fewer than six leads and two pitches: it goes, labelled, and the card stops by name (13 Nov 2026)
    const mails = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all<{ payload_json: string }>()).results ?? [];
    const delivered = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!.description;
    // The subject is the busy-executive one (≤ 70 chars, "Walker: <what>"), and the note is under it.
    expect(delivered).toMatch(/Walker: West Peek Productions in November — \d+ leads?, \d+ pitch(es)?/);
    expect(delivered).toMatch(/═══ 1 · WHO COULD BUY THIS MONTH/);
    expect(delivered).toMatch(/═══ 2 · PRESS PITCHES — YOURS TO SEND/);
    expect(delivered).toMatch(/Walker, your chief of staff/);
    // Where to write back is said once, by the email's own sign-off (the note's second footer was dropped, 14 Nov 2026).
    const { renderExecEmail } = await import("../src/shared/email/execEmail");
    const { monthlySummary } = await import("../src/worker/services/productions");
    const summary = monthlySummary("2026-11", [], [], [], []);
    expect(renderExecEmail({ employee: "Walker", what: summary.what, tldr: summary.tldr, sections: summary.sections, details: delivered }).text).toMatch(/os@joinwestpeek\.com/);
    expect(mails.length, "at most one email for the month").toBeLessThanOrEqual(1);
    expect(searches).toBeGreaterThanOrEqual(2);
    expect(renderMonthlyEmail("2026-11", [], [], [])).toMatch(/Nothing with a live citation this month/);
  });

  it("BOTH HALVES OR NOTHING: a customer search with no urls is asked once more, and if still empty after every extra pass NO email goes out and nothing goes on a desk", async () => {
    // 16 Sep 2026, 00:02Z: Scooter received "0 customer lead(s) and 4 press pitch(es)" because the
    // customer search answered without a url on any entry and the card emailed anyway.
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2026-12-01T14:00:00.000Z"));
    const noUrls = JSON.stringify({ results: [{ organisation: "U.S. Space Force", trigger: "a launch programme", approach: "Comms lead", angle: "n/a" }] });
    const customerPrompts: string[] = [];
    const runner: Parameters<typeof sweepOnce>[2] = {
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
    };
    const out = await sweepOnce(env, new Date("2026-12-01T14:05:00.000Z"), runner);
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("PROGRESSED");
    expect(customerPrompts.length, "asked once, then once more with the miss named").toBe(2);
    expect(customerPrompts[1]).toMatch(/Your previous answer was discarded[\s\S]*Rejected last time: nothing usable was returned/);
    let last = out;
    for (let n = 1; n <= MONTHLY_EXTRA_PASSES; n += 1) last = await sweepOnce(env, new Date(Date.parse("2026-12-01T14:05:00.000Z") + n * 25 * 3_600_000), runner);
    expect(last.outcome, last.summary).toBe("DONE");
    const mails = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all<{ payload_json: string }>()).results ?? [];
    expect(mails.length, "a half note must not be sent").toBe(0);
    const row = (await env.WP_OS_DB.prepare("SELECT state, block_who, description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; block_who: string | null; description: string }>())!;
    expect(row).toMatchObject({ state: "DONE", block_who: null });
    expect(row.description).toMatch(/so nothing was sent; next month's note searches afresh/);
    const desk = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE object_id = ?1 AND firm_user_id = 'fu_sequoia_taylor'").bind(opened.cardId).first<{ n: number }>())!.n;
    expect(desk, "nothing on Sequoia's desk").toBe(0);
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
    const runner: Parameters<typeof sweepOnce>[2] = {
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
    };
    const out = await sweepOnce(env, new Date("2027-01-01T14:05:00.000Z"), runner);
    expect(out.card?.id).toBe(opened.cardId);
    await expectThinMonth(out, runner, new Date("2027-01-01T14:05:00.000Z")); // fewer than six leads and two pitches: it goes, labelled, and the card stops by name (13 Nov 2026)
    // Each half is below its floor (one lead, one pitch), so each is searched once more, with one judgement per search.
    expect(judgePrompts.length, "one judgement per search go, on every pass").toBe(4 * (MONTHLY_EXTRA_PASSES + 1));
    expect(judgePrompts[0]).toMatch(/KEEP a lead only if ALL of these hold \(this month is 2027-01\)/);
    const delivered = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!.description;
    expect(delivered).toMatch(/1 lead, 1 pitch\b/);
    expect(delivered).toMatch(/1\. Example Nonprofit/);
    expect(delivered).not.toMatch(/\n\d+\. VK\n/);
    expect(delivered).not.toMatch(/B\. Guesser — GTM Letter/);
    expect(delivered).toMatch(/Left out on judgement .*VK — Russian company.*U\.S\. Space Force — a military.*B\. Guesser — hook is the positioning restated/);
  });

  it("a judge that cannot answer FAILS THE ATTEMPT (it no longer asks Scooter where to look): unjudged research is never sent", async () => {
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
    // 1 Oct 2026: a judging step that could not answer is the lane failing, not "no lead survived" — so it fails the ATTEMPT
    // (classified, retried, resumed when the setting changes) and asks Scooter nothing. What never changes: nothing unjudged is sent.
    expect(out.outcome).toBe("FAILED");
    const mails = (await env.WP_OS_DB.prepare("SELECT 1 FROM event_record WHERE object_id = ?1 AND event_type = 'deliverable.emailed_to_partner'").bind(opened.cardId).all()).results ?? [];
    expect(mails.length).toBe(0);
    const row = (await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string }>())!;
    expect(row.state).not.toBe("BLOCKED");
    // the lane's own words are what the sweep carries into its attempt record
    expect(out.summary).toMatch(/the judgement pass failed: provider 503/);
  });
});

describe("the finished email names what is still missing (0237, one list for every card)", () => {
  it("a Productions card with a missing item sends Scooter's email with the shared \"Still missing\" section", async () => {
    const LATER = new Date("2027-02-01T14:00:00.000Z");
    const { cardId } = await openProductionsCard(env, "productions_customer_ideas", LATER);
    // preview_first: the rendered email is held on the preview row, so its body can be read.
    await env.WP_OS_DB.prepare("UPDATE work_card SET preview_first = 1, missing_materials_json = ?2 WHERE id = ?1").bind(cardId, JSON.stringify([{ item: "the Productions showreel", where: "the customer pitch" }])).run();
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(cardId).first())! as unknown as Parameters<typeof runProductionsCard>[1];
    const out = await runProductionsCard(env, card, { search: async () => ({ ok: true, text: customerJson, detail: "ok" }), urlCheck, now: LATER });
    expect(out.finished, out.detail).toBe(true);
    const held = await env.WP_OS_DB.prepare("SELECT body_text FROM preview_approval WHERE work_card_id = ?1").bind(cardId).first<{ body_text: string }>();
    expect(held!.body_text).toContain("Still missing");
    expect(held!.body_text).toContain("the Productions showreel — for the customer pitch");
    expect(held!.body_text.indexOf("Still missing")).toBeLessThan(held!.body_text.indexOf("Your call"));
  });
});

describe("a reply to an earlier month's note steers the next month (2 Nov 2026)", () => {
  /*
   * Scooter replied to November's note with three targeting rules. Every monthly card is a new row,
   * so the reply sat in `work_steer` and December's run read nothing. Proven by what reaches the
   * search prompt, and negatively: with no reply on file, the interpreter is never called at all.
   */
  it("carries the partner's reply on this kind into the interpretation and the search prompt", async () => {
    await env.WP_OS_DB.prepare("DELETE FROM work_steer WHERE card_kind = 'PRODUCTIONS_MONTHLY'").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const run = async (when: string) => {
      const opened = await openProductionsCard(env, "productions_monthly", new Date(when));
      const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first())!;
      const interpreted: string[] = [];
      const searched: string[] = [];
      await runProductionsCard(env, card as never, {
        search: async (_e, _a, prompt) => { searched.push(prompt); return { ok: true, text: /journalists/.test(prompt) ? pressJson : customerJson, detail: "ok" }; },
        urlCheck,
        judge: keepAll,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: new Date(when),
        interpret: async (_e, _a, prompt) => {
          interpreted.push(prompt);
          return { ok: true, text: "UNDERSTOOD: target national orgs\nSTEER: only national organisations at or above TNTP's size", aiRunId: null, model: "fake", detail: "COMPLETED" };
        },
      });
      return { interpreted, searched };
    };

    const before = await run("2026-12-01T14:00:00.000Z");
    expect(before.interpreted, "no reply on file: no model call at all").toEqual([]);

    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED','DONE') AND kind = 'PRODUCTIONS_MONTHLY'").run();
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, thread_token, firm_scope) VALUES ('wst_t', 'PRODUCTIONS_MONTHLY', NULL, 'scooter@westpeek.ventures', 'Target national organisations whose impact has outgrown their branding, sized like TNTP.', 'tok', 'west-peek')",
    ).run();
    const after = await run("2027-01-01T14:00:00.000Z");
    expect(after.interpreted.join("\n")).toMatch(/outgrown their branding, sized like TNTP/);
    expect(after.searched.some((p) => /only national organisations at or above TNTP's size/.test(p)), "the steer reaches the search itself").toBe(true);
  });
});

describe("a month below the floor is researched again, never put on Sequoia's desk (owner, 14 Nov 2026)", () => {
  it("below the floor: nothing for Sequoia, the card retries the next day, and after the last pass Scooter gets what met the bar", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const start = new Date("2027-07-01T14:00:00.000Z");
    const opened = await openProductionsCard(env, "productions_monthly", start);
    const leads = JSON.stringify({ results: [{ organisation: "Thin Council", trigger: "launched a national plan", approach: "Head of Comms", url: "https://thin.example/plan" }] });
    const prompts: string[] = [];
    const tick = (at: Date) => sweepOnce(env, at, {
      productions: (e, card) => runProductionsCard(e, card, {
        search: async (_e, _a, prompt) => { prompts.push(prompt); return { ok: true, text: /journalists/.test(prompt) ? pressJson : leads, detail: "ok" }; },
        urlCheck: async () => true,
        judge: keepAll,
        pageText: async () => "Contact: a.writer@communityweekly.example",
        now: at,
        interpret: steersWith("Keep going as you are."),
      }),
    });
    const forSequoia = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE object_id = ?1 AND firm_user_id = 'fu_sequoia_taylor'").bind(opened.cardId).first<{ n: number }>())!.n;
    // A send attempt to Scooter (the test env has no transport, so "sent" is the attempt and its delivery record).
    const emails = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type IN ('deliverable.emailed_to_partner', 'deliverable.email_not_sent', 'productions.delivered')").bind(opened.cardId).first<{ n: number }>())!.n;
    const card = async () => (await env.WP_OS_DB.prepare("SELECT state, block_who, lease_until FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; block_who: string | null; lease_until: string | null }>())!;

    const first = await tick(new Date(start.getTime() + 5 * 60_000));
    expect(first.card?.id).toBe(opened.cardId);
    expect(first.outcome, first.summary).toBe("PROGRESSED");
    expect((await card()).state).not.toBe("BLOCKED");
    expect((await card()).block_who).toBeNull();
    expect(String((await card()).lease_until) > new Date(start.getTime() + 23 * 3_600_000).toISOString(), "it waits a day before the next pass").toBe(true);
    expect(await emails(), "nothing is sent below the floor before the last pass").toBe(0);
    expect(await forSequoia(), "nothing reaches Sequoia's desk").toBe(0);
    expect((await tick(new Date(start.getTime() + 2 * 3_600_000))).card, "not picked up again the same day").toBeNull();

    let last = first;
    for (let n = 1; n <= MONTHLY_EXTRA_PASSES; n += 1) last = await tick(new Date(start.getTime() + n * 25 * 3_600_000));
    expect(last.outcome, last.summary).toBe("DONE");
    expect(prompts.some((pr) => /find OTHERS, not these: Thin Council/.test(pr)), "a later pass asks for others").toBe(true);
    expect(await emails(), `after the last pass, what met the bar goes to Scooter: ${last.summary}`).toBeGreaterThanOrEqual(1);
    expect(last.summary).toMatch(/in July — 1 lead, \d+ pitch/);
    expect(await forSequoia(), "and still nothing for Sequoia").toBe(0);
    expect((await card()).block_who).toBeNull();
  });
});

describe("a first email to a writer names no money and asks for no call (risk rule, 14 Nov 2026)", () => {
  it("a pitch whose draft quotes prices or asks for a 20-minute conversation never reaches Scooter's note; a clean one does", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-06-01T14:00:00.000Z"));
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first<Parameters<typeof runProductionsCard>[1]>())!;
    const leads = JSON.stringify({ results: Array.from({ length: 6 }, (_, i) => ({ organisation: `Made-up Council ${i + 1}`, trigger: "launched a national plan", approach: "Head of Comms", angle: "keep it going", url: `https://council${i + 1}.example/plan` })) });
    const pitch = (w: string, draft: string) => ({ writer: w, outlet: `${w} Weekly`, why_this_writer: "Slot 5 (wildcard, earned by one recent piece). She wrote about communities.", hook: "hook", proof_url: `https://${w.toLowerCase()}.example/piece`, draft });
    const writers = JSON.stringify({ results: [
      pitch("Priced", "Hi — we publish what it costs: $2,500–$7,500 for a webinar."),
      pitch("Caller", "Hi — would you have time for a 20-minute conversation next week?"),
      pitch("Clean", "Hi — we publish what our work costs; happy to share what we have learned, and real numbers, if it is useful."),
      pitch("Plain", "Hi — your piece on communities was good; happy to share examples and numbers if it is useful for a follow-up."),
    ] });
    await runProductionsCard(env, card, {
      search: async (_e, _a, prompt) => ({ ok: true, text: /journalists/.test(prompt) ? writers : leads, detail: "ok" }),
      urlCheck: async () => true,
      judge: keepAll,
      pageText: async () => null,
      now: new Date("2027-06-01T14:05:00.000Z"),
      interpret: steersWith("Keep going as you are."),
    });
    const row = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ description: string }>())!;
    const note = row.description;
    expect(note).toMatch(/Clean — Clean Weekly/);
    expect(note).toMatch(/Plain — Plain Weekly/);
    expect(note, "a draft with prices is never put in front of Scooter to send").not.toMatch(/Priced — Priced Weekly|\$2,500/);
    expect(note, "a draft that asks for a call is never put in front of Scooter to send").not.toMatch(/Caller — Caller Weekly|20-minute conversation/);
    expect(note, "the brief's slot labels stay internal").not.toMatch(/Slot 5/);
  });
});

describe("the monthly note's floor: six leads and two pitches, or it says it is a thin month (owner, 13 Nov 2026)", () => {
  it("October (9 and 3) and November (6 and 2) pass; five leads, one pitch, or the 16 Sep note (0 and 4) do not", async () => {
    const { monthlyFloor } = await import("../src/worker/services/productions");
    expect(monthlyFloor(9, 3)).toEqual({ ok: true, misses: [] });
    expect(monthlyFloor(6, 2)).toEqual({ ok: true, misses: [] });
    expect(monthlyFloor(5, 2).misses).toEqual(["5 customer leads stood up, and a month needs 6"]);
    expect(monthlyFloor(6, 1).misses).toEqual(["1 press pitch stood up, and a month needs 2"]);
    expect(monthlyFloor(0, 4).ok).toBe(false);
  });

  const full = JSON.stringify({ results: Array.from({ length: 6 }, (_, i) => ({ organisation: `Made-up Association ${i + 1}`, trigger: "announced its annual conference", approach: "Head of Events", angle: "a community that outlives the event", url: `https://assoc${i + 1}.example/conference` })) });
  const twoWriters = JSON.stringify({ results: [1, 2].map((i) => ({ writer: `Writer ${i}`, outlet: `Outlet ${i}`, why_this_writer: "covers community programmes", hook: "Community is an operating advantage", proof_url: `https://outlet${i}.example/piece`, draft: "Hi —" })) });

  it("a month that reaches the floor is DONE in one search per half; a first answer below it is searched once more and the fuller one is used", async () => {
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-03-01T14:00:00.000Z"));
    const prompts: string[] = [];
    const out = await sweepOnce(env, new Date("2027-03-01T14:05:00.000Z"), {
      productions: (e, card) => runProductionsCard(e, card, {
        // The first customer answer is thin (one lead); the second go, told so, returns the full six.
        search: async (_e, _a, prompt) => { prompts.push(prompt); return { ok: true, text: /journalists/.test(prompt) ? twoWriters : prompts.filter((p) => !/journalists/.test(p)).length === 1 ? customerJson : full, detail: "ok" }; },
        urlCheck: async () => true,
        judge: keepAll,
        pageText: async () => "a page with no address",
        now: new Date("2027-03-01T14:05:00.000Z"),
        // Earlier tests left a standing reply for this kind of work; it is read, and changes nothing here.
        interpret: steersWith("Keep going as you are."),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    expect(prompts.some((p) => /Only [1-5] stood up and 6 are needed: find others, not these again/.test(p)), "the second go is told the first was thin").toBe(true);
    const card = (await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; description: string }>())!;
    expect(card.state).toBe("DONE");
    expect(card.description).toMatch(/6 leads, 2 pitches/);
    expect(card.description).not.toMatch(/THIN MONTH/);
  });

  it("Scooter's steer cannot turn the search into a letter to him: a prose reply is a failed go and the next route writes the list (wc_bd8b68cb, 14 Nov 2026)", async () => {
    const { vi } = await import("vitest");
    const { FREE_SEARCH_GROUNDED_MODELS } = await import("../src/worker/ai/providers/freeSearch");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-05-01T14:00:00.000Z"));
    // His reply, in substance: a redo, aimed somewhere new. Read correctly — the fault was what the search did with it.
    await env.WP_OS_DB.prepare("UPDATE work_card SET prompt = 'Redo this month: national organisations whose impact has outgrown their branding, and let me know what is realistic' WHERE id = ?1").bind(opened.cardId).run();
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first<Parameters<typeof runProductionsCard>[1]>())!;
    // The real shape of what the first free route wrote on 14 Nov: a status letter to Scooter, no list, no url field.
    const letter =
      "Scooter, I can have this month's redo of the customer and press lists finalized by the end of the day. I'm focusing on national " +
      "organisations whose impact has outgrown their branding, and I'll send the full list over as soon as it's ready.";
    const prompts: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("generativelanguage.googleapis.com")) return new Response(JSON.stringify({ error: { message: "down in this test" } }), { status: 503 });
      const model = decodeURIComponent(url.split("/models/")[1]!.split(":")[0]!);
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; contents: Array<{ parts: Array<{ text: string }> }> };
      const prompt = body.contents[0]!.parts[0]!.text;
      if (!body.tools) return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
      prompts.push(prompt);
      // The first grounded route always writes the letter; the next writes what was asked for.
      const text = model === FREE_SEARCH_GROUNDED_MODELS[0] ? letter : /journalists/.test(prompt) ? twoWriters : full;
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", groundingMetadata: { groundingChunks: [{ web: { uri: "https://assoc1.example/conference" } }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    // A firm whose searches leave for the live web at $0, as production's does (the test DB starts offline). Policy rows
    // are append-only, so the one in force before is appended again afterwards for the tests that follow.
    const prior = await env.WP_OS_DB.prepare("SELECT id FROM budget_policy WHERE firm_scope = 'west-peek' ORDER BY created_at DESC, rowid DESC LIMIT 1").first<{ id: string }>();
    await env.WP_OS_DB.prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES ('bp_letter_test', 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, 'FREE_ONLY', 0, 'fu_sequoia_taylor')`,
    ).run();
    let out: Awaited<ReturnType<typeof runProductionsCard>>;
    try {
      out = await runProductionsCard({ ...env, GEMINI_API_KEY: "g" } as Env, card, {
        urlCheck: async () => true,
        judge: keepAll,
        pageText: async () => null,
        now: new Date("2027-05-01T14:05:00.000Z"),
        interpret: steersWith("Redo this month's list for national organisations whose impact has outgrown their branding.", "only national organisations whose impact has outgrown their branding"),
      });
    } finally {
      vi.unstubAllGlobals();
      const cols = "firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by";
      await env.WP_OS_DB.prepare(
        prior
          ? `INSERT INTO budget_policy (id, ${cols}) SELECT 'bp_letter_test_after', ${cols} FROM budget_policy WHERE id = ?1`
          : `INSERT INTO budget_policy (id, ${cols}) VALUES ('bp_letter_test_after', 'west-peek', 'NORMAL', 'LOCAL', 500, 500, 1, 0, 'MODERATE', 0, 'fu_sequoia_taylor')`,
      ).bind(...(prior ? [prior.id] : [])).run();
    }
    const row = (await env.WP_OS_DB.prepare("SELECT state, block_reason, description FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; block_reason: string | null; description: string | null }>())!;
    expect(row.block_reason, out.detail).not.toBe("nothing_good_enough_to_send");
    expect(out.blocked, out.detail).toBe(false);
    expect(out.finished, out.detail).toBe(true);
    expect(row.description).toMatch(/6 leads, 2 pitches/);
    // His words reached the search as fenced material, and the brief's own output format is the last thing it read.
    const search = prompts.find((p) => /find 10 organisations/.test(p))!;
    expect(search).toMatch(/<<<PARTNER_DIRECTION[\s\S]*outgrown their branding[\s\S]*PARTNER_DIRECTION>>>[\s\S]*Return ONLY JSON/);
    expect(search.trimEnd()).toMatch(/REQUIRED OUTPUT FORMAT[^]*discarded unread\.$/);
  }, 60_000);

  it("what Scooter said could not be read: a failed go the sweep retries, never 'the brief is missing' (the November card)", async () => {
    const { openProductionsCard } = await import("../src/worker/services/productions");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const opened = await openProductionsCard(env, "productions_monthly", new Date("2027-04-01T14:00:00.000Z"));
    await env.WP_OS_DB.prepare("UPDATE work_card SET prompt = 'this reads like pitching virtual events, which is not the sales pitch' WHERE id = ?1").bind(opened.cardId).run();
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(opened.cardId).first<Parameters<typeof runProductionsCard>[1]>())!;
    let searches = 0;
    const out = await runProductionsCard(env, card, {
      search: async () => ((searches += 1), { ok: true, text: full, detail: "ok" }),
      urlCheck: async () => true,
      judge: keepAll,
      now: new Date("2027-04-01T14:05:00.000Z"),
      interpret: async () => ({ ok: true, text: "Sure, I will take that into account.", aiRunId: null, model: "fake-test-model", detail: "COMPLETED" }),
    });
    expect(out).toMatchObject({ finished: false, blocked: false });
    expect(out.detail).toMatch(/could not be read/);
    expect(searches).toBe(0);
    const after = (await env.WP_OS_DB.prepare("SELECT state, block_reason FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ state: string; block_reason: string | null }>())!;
    expect(after.state).not.toBe("BLOCKED");
    expect(after.block_reason).toBeNull();
  });
});
