import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { computeNextRun, isoWeekOf, occurrenceKey, runDueJobs, runJob, type ScheduledJobRow } from "../src/worker/services/jobs";
import {
  HIRE_ARCHETYPE,
  HIRE_CONTACT_RULE,
  HIRE_ROLE,
  HIRE_SEARCH_STEPS,
  buildHireJudgePrompt,
  buildHireSearchPrompt,
  canonicalProfileUrl,
  checkCandidatePages,
  openHireSearchCard,
  parseHireCandidates,
  rememberCandidates,
  renderHireNote,
  runHireSearchCard,
  hireFloor,
  HIRE_FLOOR,
  HIRE_SEARCH_ROUTES,
  type HireCandidate,
} from "../src/worker/services/productionsHire";
import { sweepOnce } from "../src/worker/services/workSweep";
import { JOB_FACTS, cadenceInWords } from "../src/shared/work/scheduledWork";
import { DELIVERABLE_KINDS, kindDef } from "../src/shared/deliverables/deliverable";
import { steersWith } from "./helpers/interpret";
import { lintExecEmail, renderExecEmail } from "../src/shared/email/execEmail";

/**
 * Walker's WEEKLY hire search for West Peek Productions (16 Sep 2026), proven offline.
 *
 * What must be true:
 *   · WEEKLY is a real schedule kind: the next Monday 14:00 is computed, the occurrence key is the
 *     ISO week, a second tick in the same week replays, Run it now mints a fresh key, next week is new.
 *   · Every candidate is on a page that answered — or, for LinkedIn's 999, a second page answered —
 *     and every survivor is judged against the archetype; a search that names nobody usable BLOCKS
 *     the card and emails nothing.
 *   · Candidates are remembered across weeks: a CONTACTED or PASSED one never returns; an unacted
 *     one is "seen before", not a fresh entry.
 *   · ONE email, through the exec-email door, to scooter@ and nobody else; a deliverable on his Home;
 *     Sequoia gets no notice. The OS contacts no candidate: the only outbound is to scooter@.
 *   · Scooter marks a candidate from Home; Sequoia cannot see the list.
 */

let t: TestDb;
let env: Env;

const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const MON_W39 = new Date("2026-09-21T14:00:30.000Z");
const MON_W40 = new Date("2026-09-28T14:00:30.000Z");
// The hire search runs Tuesdays 09:00 Central (0288, schedule rebalance 1 Nov 2026): 09:00 CDT is 14:00Z.
const TUE_W39 = new Date("2026-09-22T14:00:30.000Z");
const TUE_W40 = new Date("2026-09-29T14:00:30.000Z");

const searchJson = JSON.stringify({
  results: [
    // A LinkedIn profile (refuses automated reads) with a live team page behind it: kept, marked "refused".
    { name: "Jordan Example", title: "Senior Experiential Producer (freelance)", company: "Independent", city: "Brooklyn, NY", profile_url: "https://www.linkedin.com/in/jordan-example/", evidence_url: "https://agency.example/team/jordan", why: "Team page lists 12 brand activations produced end to end.\nBio says freelance since 2023 and names two sponsorship deals closed.", opening_line: "Your Nike House of Innovation build is the kind of thing we want more of.", fit: 8 },
    // A portfolio site that answers: kept, marked "live".
    { name: "Sam Sample", title: "Executive Producer", company: "Freelance", city: "Los Angeles, CA", profile_url: "https://samsample.example", why: "Portfolio shows brand partnerships sold and produced.", opening_line: "Loved the Coachella activation.", fit: 7 },
    // A third who stands up, so the week is a shortlist and not nearest misses (the floor, 13 Nov 2026).
    { name: "Avery Sample", title: "Senior Producer, Experiential (freelance)", company: "Independent", city: "Chicago, IL", profile_url: "https://averysample.example", why: "Own site lists sponsorships sold and produced for two festivals.", opening_line: "Your festival sponsor work.", fit: 6 },
    // A LinkedIn profile with no second page: dropped — nothing could be shown to exist.
    { name: "Only LinkedIn", title: "Producer", company: "x", city: "Austin, TX", profile_url: "https://linkedin.com/in/only-linkedin", why: "says freelance", opening_line: "hi", fit: 6 },
    // A dead page: dropped.
    { name: "Dead Link", title: "Producer", company: "x", city: "Chicago, IL", profile_url: "https://dead.example/p", evidence_url: "https://dead.example/e", why: "…", opening_line: "hi", fit: 5 },
    // No URL at all: discarded unread.
    { name: "No URL", title: "Producer", company: "x", city: "Miami, FL", why: "…", fit: 9 },
    // The judge will reject this one on seniority.
    { name: "Not Senior", title: "Associate Producer", company: "Big Agency", city: "New York, NY", profile_url: "https://notsenior.example", why: "three years of event coordination", opening_line: "hi", fit: 4 },
  ],
});

/** Statuses by URL: LinkedIn answers 999, dead.example answers nothing, everything else 200. */
const statusOf = async (url: string): Promise<number | null> => {
  if (url.includes("linkedin.com")) return 999;
  if (url.includes("dead.example")) return null;
  return 200;
};

/** A judge that rejects "Not Senior" and keeps the rest with its own fit. */
const judge = async (_e: unknown, _a: unknown, prompt: string) => {
  const start = prompt.indexOf("CANDIDATES:\n");
  const end = prompt.lastIndexOf("Return ONLY JSON");
  const body = JSON.parse(prompt.slice(start + "CANDIDATES:\n".length, end)) as Array<{ name: string; fit: number }>;
  return {
    ok: true,
    text: JSON.stringify({ verdicts: body.map((b) => (b.name === "Not Senior" ? { name: b.name, keep: false, fit: 2, reason: "three years, not eight" } : { name: b.name, keep: true, fit: b.fit + 1, reason: "fits the archetype" })) }),
    detail: "ok",
  };
};

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_walker'").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("WEEKLY is a real schedule kind", () => {
  it("computes the next Monday 14:00 UTC — today if it has not passed, next week once it has", () => {
    const job = { schedule_kind: "WEEKLY", interval_minutes: null, daily_at_utc: "14:00", day_of_week: 1 } as const;
    expect(computeNextRun(job, new Date("2026-09-16T10:00:00.000Z"))).toBe("2026-09-21T14:00:00.000Z"); // a Wednesday
    expect(computeNextRun(job, new Date("2026-09-21T13:59:00.000Z"))).toBe("2026-09-21T14:00:00.000Z"); // Monday, before
    expect(computeNextRun(job, new Date("2026-09-21T14:00:00.000Z"))).toBe("2026-09-28T14:00:00.000Z"); // Monday, on the dot
    expect(computeNextRun(job, new Date("2026-09-27T23:59:00.000Z"))).toBe("2026-09-28T14:00:00.000Z"); // Sunday
    expect(computeNextRun({ ...job, day_of_week: 0 }, new Date("2026-09-21T14:00:00.000Z"))).toBe("2026-09-27T14:00:00.000Z"); // Sunday = 0
  });

  it("keys a WEEKLY occurrence by the ISO week, so Monday and the following Sunday share a key and the next Monday does not", () => {
    const job = { job_key: "k", schedule_kind: "WEEKLY", interval_minutes: null, daily_at_utc: "14:00", day_of_week: 1 } as unknown as ScheduledJobRow;
    expect(occurrenceKey(job, new Date("2026-09-21T14:00:00.000Z"))).toBe("k:2026-W39");
    expect(occurrenceKey(job, new Date("2026-09-27T23:00:00.000Z"))).toBe("k:2026-W39");
    expect(occurrenceKey(job, new Date("2026-09-28T14:00:00.000Z"))).toBe("k:2026-W40");
    // ISO year boundaries: 2026 has 53 weeks; 1 Jan 2027 is still 2026-W53; 30 Dec 2024 is 2025-W01.
    expect(isoWeekOf(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeekOf(new Date("2024-12-30T12:00:00.000Z"))).toBe("2025-W01");
    expect(isoWeekOf(new Date("2026-09-16T12:00:00.000Z"))).toBe("2026-W38");
  });

  it("0172 seeded productions_hire_search WEEKLY; 0288 moved it to Tuesday 09:00 on her clock (America/Chicago), ACTIVE, due on a Tuesday", async () => {
    const row = await t.db.prepare("SELECT schedule_kind, day_of_week, daily_at_utc, daily_at_tz, next_run_at, status, target_id, created_at FROM scheduled_job WHERE job_key = 'productions_hire_search'")
      .first<{ schedule_kind: string; day_of_week: number; daily_at_utc: string; daily_at_tz: string; next_run_at: string; status: string; target_id: string; created_at: string }>();
    expect(row).toMatchObject({ schedule_kind: "WEEKLY", day_of_week: 2, daily_at_utc: "09:00", daily_at_tz: "America/Chicago", status: "ACTIVE", target_id: "aie_walker" });
    expect(row!.next_run_at).toMatch(/T15:00:00\.000Z$/); // 09:00 CST, the migration's winter literal
    expect(new Date(row!.next_run_at).getUTCDay(), "a Tuesday").toBe(2);
    // Measured from when the migration ran (created_at), not from the wall clock: the test DB is a
    // copy of a migrated template cached by migration hash, so a template built last week seeded
    // last week's "next Monday" correctly, and a wall-clock comparison failed every Monday after
    // 14:00 UTC (12 Oct 2026). Strictly after the seed, and no more than one week after it.
    const seeded = Date.parse(row!.created_at);
    const due = Date.parse(row!.next_run_at);
    expect(due > seeded, `due on the NEXT Monday after the seed, not in the past: ${row!.next_run_at} vs ${row!.created_at}`).toBe(true);
    expect(due - seeded, "the first Monday 14:00 after the seed, never a later one").toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  it("refuses a WEEKLY job without its day at the schema, and a day outside 0–6", async () => {
    await expect(
      t.db.prepare("INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, created_by) VALUES ('sj_bad_w1','bad_weekly','x','EMPLOYEE_TASK','WEEKLY','14:00','SYSTEM','test')").run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      t.db.prepare("INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_week, target_kind, created_by) VALUES ('sj_bad_w2','bad_weekly2','x','EMPLOYEE_TASK','WEEKLY','14:00',7,'SYSTEM','test')").run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("a second cron tick in the same week replays; Run it now mints a fresh key; next week is new", async () => {
    const ran = await runJob(env, MP_ACTOR, "productions_hire_search", { trigger: "SCHEDULED", now: TUE_W39 });
    expect(ran.replayed).toBe(false);
    expect(ran.run.status, String(ran.run.outcome_summary)).toBe("SUCCEEDED");
    expect(String(ran.run.idempotency_key)).toBe("productions_hire_search:2026-W39");
    expect(String(ran.run.outcome_summary)).toMatch(/Opened "Walker: West Peek Productions hire search \(2026-W39\)" on Walker's desk/);
    const after = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'productions_hire_search'").first<{ next_run_at: string }>();
    expect(after!.next_run_at).toBe("2026-09-29T14:00:00.000Z");

    // The same week, days later, with the clock wrongly put back: still one occurrence.
    await t.db.prepare("UPDATE scheduled_job SET next_run_at = ?1 WHERE job_key = 'productions_hire_search'").bind("2026-09-24T00:00:00.000Z").run();
    const again = await runJob(env, MP_ACTOR, "productions_hire_search", { trigger: "SCHEDULED", now: new Date("2026-09-24T14:05:00.000Z") });
    expect(again.replayed, "a second tick in the week must not open a second card").toBe(true);
    const runs = await t.db.prepare("SELECT COUNT(*) AS n FROM job_run WHERE job_id = 'sjb_productions_hire_search' AND trigger_kind = 'SCHEDULED'").first<{ n: number }>();
    expect(runs!.n).toBe(1);
    const repaired = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'productions_hire_search'").first<{ next_run_at: string }>();
    expect(repaired!.next_run_at).toBe("2026-09-29T14:00:00.000Z");

    // A person asking gets a fresh occurrence, same week; the card is week-unique so nothing new opens.
    const byHand = await runJob(env, MP_ACTOR, "productions_hire_search", { trigger: "MANUAL", now: new Date("2026-09-24T14:06:00.000Z") });
    expect(byHand.replayed).toBe(false);
    expect(String(byHand.run.idempotency_key)).toMatch(/^productions_hire_search:manual:/);
    expect(String(byHand.run.outcome_summary)).toMatch(/already open or done/);
    const cards = await t.db.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'PRODUCTIONS_HIRE_SEARCH' AND state != 'CANCELLED'").first<{ n: number }>();
    expect(cards!.n).toBe(1);

    // Next Tuesday is a new occurrence and a new card.
    const next = await runJob(env, MP_ACTOR, "productions_hire_search", { trigger: "SCHEDULED", now: TUE_W40 });
    expect(next.replayed).toBe(false);
    expect(String(next.run.idempotency_key)).toBe("productions_hire_search:2026-W40");
    expect(String(next.run.outcome_summary)).toMatch(/\(2026-W40\)/);
    // Tidy: the W40 card is cancelled so the runner tests below work W39's then their own.
    await t.db.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE title LIKE '%(2026-W40)%'").run();
  });

  it("is picked up by the tick when due", async () => {
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED' WHERE status = 'ACTIVE' AND job_key <> 'productions_hire_search'").run();
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET next_run_at = ?1 WHERE job_key = 'productions_hire_search'").bind("2026-10-05T14:00:00.000Z").run();
    const results = await runDueJobs(env, new Date("2026-10-05T14:00:40.000Z"));
    const run = results.find((r) => r.job_key === "productions_hire_search");
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.summary).toMatch(/\(2026-W41\)/);
    await t.db.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE title LIKE '%(2026-W41)%'").run();
    await env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'ACTIVE' WHERE status = 'PAUSED' AND pause_reason IS NULL").run();
  });
});

describe("what Walker is told", () => {
  it("carries a written archetype, the sources, the boundary, and the no-invention rules", () => {
    expect(HIRE_ROLE).toBe("senior experiential producer, freelance");
    expect(HIRE_ARCHETYPE).toMatch(/written from the title; the reference\s+profile did not render publicly/);
    expect(HIRE_ARCHETYPE).toMatch(/BRINGS IN BRAND DEALS/);
    const prompt = buildHireSearchPrompt("2026-W39");
    expect(prompt).toContain("Scooter's OWN agency");
    expect(prompt).toMatch(/linkedin\.com\/in\//);
    expect(prompt).toMatch(/agency team pages/);
    expect(prompt).toMatch(/speaker lists/);
    expect(prompt).toMatch(/award lists/);
    expect(prompt).toMatch(/Never construct or guess a URL/);
    expect(prompt).toMatch(/Never read behind a login/);
    expect(prompt).toMatch(/Never invent a person/);
    const judgePrompt = buildHireJudgePrompt("2026-W39", parseHireCandidates(searchJson));
    expect(judgePrompt).toMatch(/You are the JUDGE, not the researcher/);
    expect(judgePrompt).toMatch(/Freelance, independent, or plainly open to freelance/);
    expect(judgePrompt).toMatch(/SALES experience is claimed from a page/);
  });

  /*
   * THE FIX FOR 22 SEP 2026: A DECLARED STEP, NOT A SEPARATE LOOKUP.
   *
   * Sequoia told Walker, via `work_steer`, to always attempt a legitimate contact-email lookup for
   * reported candidates. `steerFor` correctly checked that against `HIRE_SEARCH_STEPS` — the job's
   * own declared capability list — found nothing covering it, and correctly blocked
   * (`wc_hire_followup_20260922`). That model call is not faked here; what IS provable in code is
   * the contract the real model reads: the step is now declared, in the same terse voice as every
   * other step, and it reaches the actual search-grounded call Walker already makes — not a new one.
   */
  it("now declares the contact-lookup capability she asked for, wired into the SAME search call — not a second lookup mechanism", () => {
    expect(HIRE_SEARCH_STEPS.some((s) => s === HIRE_CONTACT_RULE)).toBe(true);
    expect(HIRE_CONTACT_RULE).toMatch(/self-published contact method/);
    expect(HIRE_CONTACT_RULE).toMatch(/self-provided email/);
    expect(HIRE_CONTACT_RULE).toMatch(/[Nn]ever a scraped third-party data-broker guess/);
    expect(HIRE_CONTACT_RULE).toMatch(/never a pattern-guessed address/);
    expect(HIRE_CONTACT_RULE).toMatch(/never anything requiring a login/);
    expect(HIRE_CONTACT_RULE).toMatch(/[Ss]ay plainly when none is found/);
    // The RULES and the JSON schema of the search prompt — the call with real web-search grounding
    // (defaultSearch, SEARCH_MODEL) — carry it, not the judge (which has no search capability).
    const prompt = buildHireSearchPrompt("2026-W39");
    expect(prompt).toContain(HIRE_CONTACT_RULE);
    expect(prompt).toMatch(/"email":null,"contact_url":"https:\/\/…"/);
  });

  it("is a deliverable kind that files and lands on Home", () => {
    expect(DELIVERABLE_KINDS).toContain("productions_hire_search");
    expect(kindDef("productions_hire_search")).toMatchObject({ label: "Hire search", page: "home", file: true });
  });
});

describe("what survives the search", () => {
  it("parses only entries with a profile URL, normalises the URL, and keeps one per person", () => {
    const parsed = parseHireCandidates(searchJson);
    expect(parsed.map((c) => c.name)).toEqual(["Jordan Example", "Sam Sample", "Avery Sample", "Only LinkedIn", "Dead Link", "Not Senior"]);
    expect(parsed[0]!.profileUrl).toBe("https://linkedin.com/in/jordan-example");
    expect(canonicalProfileUrl("http://WWW.LinkedIn.com/in/x/?trk=abc#top")).toBe("https://linkedin.com/in/x");
    const twice = parseHireCandidates(JSON.stringify({ results: [{ name: "A", profile_url: "https://a.example/" }, { name: "A again", profile_url: "https://www.a.example" }] }));
    expect(twice).toHaveLength(1);
  });

  it("keeps a page that answered, keeps a LinkedIn 999 only with a live second page, and drops the rest with the reason", async () => {
    const out = await checkCandidatePages(parseHireCandidates(searchJson), statusOf);
    expect(out.kept.map((c) => [c.name, c.profileCheck])).toEqual([["Jordan Example", "refused"], ["Sam Sample", "live"], ["Avery Sample", "live"], ["Not Senior", "live"]]);
    expect(out.dropped.map((d) => d.name).sort()).toEqual(["Dead Link", "Only LinkedIn"]);
    expect(out.dropped.find((d) => d.name === "Only LinkedIn")!.reason).toMatch(/refused an automated read \(999\) and no second page/);
    expect(out.dropped.find((d) => d.name === "Dead Link")!.reason).toMatch(/did not answer/);
  });
});

describe("the contact method a candidate may carry", () => {
  it("keeps an email only alongside the page it was read from, and discards an unbacked or malformed one", () => {
    const raw = JSON.stringify({
      results: [
        { name: "Has Both", profile_url: "https://a.example/x", email: "has@both.example", contact_url: "https://a.example/about" },
        { name: "No Page", profile_url: "https://b.example/x", email: "no@page.example" },
        { name: "Bad Address", profile_url: "https://c.example/x", email: "not-an-email", contact_url: "https://c.example/about" },
        { name: "None Found", profile_url: "https://d.example/x" },
      ],
    });
    const parsed = parseHireCandidates(raw);
    expect(parsed.find((c) => c.name === "Has Both")).toMatchObject({ email: "has@both.example", contactUrl: "https://a.example/about" });
    expect(parsed.find((c) => c.name === "No Page")!.email, "an address with no page is a guess").toBeNull();
    expect(parsed.find((c) => c.name === "Bad Address")!.email, "not a valid-looking address").toBeNull();
    expect(parsed.find((c) => c.name === "None Found")).toMatchObject({ email: null, contactUrl: null });
  });

  it("says it plainly in the note — the page it came from, or that none was found", () => {
    const [jordan, sam] = parseHireCandidates(searchJson);
    const withEmail: HireCandidate = { ...jordan!, email: "jordan@jordanexample.example", contactUrl: "https://jordanexample.example/about" };
    const withoutEmail: HireCandidate = { ...sam!, email: null, contactUrl: null };
    const text = renderHireNote("2026-W39", [withEmail, withoutEmail], [], [], []);
    expect(text).toContain("Contact: jordan@jordanexample.example — from https://jordanexample.example/about");
    expect(text).toContain("Contact: no public contact method found");
  });

  it("persists a found contact method across weeks; a week that resurfaces the same person with no email does not erase what is already known", async () => {
    const url = "https://contactpersist.example/x";
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate WHERE url IN (?1, ?2)").bind(url, "https://contactpersist.example/other").run();
    const base: Omit<HireCandidate, "email" | "contactUrl"> = {
      name: "Contact Persist", title: "Producer", company: "Freelance", city: "NY", profileUrl: url, evidenceUrl: null, why: "why", openingLine: "hi", fit: 7,
    };
    const week1 = await rememberCandidates(env, [{ ...base, email: "found@contactpersist.example", contactUrl: "https://contactpersist.example/about" }], "2026-W50", "wc_persist_1", new Date("2026-12-14T00:00:00.000Z"));
    expect(week1.fresh).toHaveLength(1);
    const afterWeek1 = await env.WP_OS_DB.prepare("SELECT email, contact_url AS contactUrl FROM productions_candidate WHERE url = ?1").bind(url).first<{ email: string; contactUrl: string }>();
    expect(afterWeek1).toEqual({ email: "found@contactpersist.example", contactUrl: "https://contactpersist.example/about" });

    // Week 2: the same person resurfaces with no email this time, alongside a genuinely fresh
    // candidate so the write actually runs (a batch with nothing fresh writes nothing at all).
    const other: HireCandidate = { ...base, name: "Other Fresh", profileUrl: "https://contactpersist.example/other", email: null, contactUrl: null };
    await rememberCandidates(env, [{ ...base, email: null, contactUrl: null }, other], "2026-W51", "wc_persist_2", new Date("2026-12-21T00:00:00.000Z"));
    const afterWeek2 = await env.WP_OS_DB.prepare("SELECT email, contact_url AS contactUrl FROM productions_candidate WHERE url = ?1").bind(url).first<{ email: string; contactUrl: string }>();
    expect(afterWeek2, "a page-backed contact already on file must not be erased by a week that found nothing new").toEqual({ email: "found@contactpersist.example", contactUrl: "https://contactpersist.example/about" });

    // This describe runs before "the weekly card on Walker's desk", which asserts an exact,
    // otherwise-clean set of rows in productions_candidate — leave the table as this block found it.
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate WHERE url IN (?1, ?2)").bind(url, "https://contactpersist.example/other").run();
  });
});

describe("the weekly card on Walker's desk", () => {
  it("is worked by the sweep: search, check, judge, remember, deliverable on Scooter's Home, ONE email to scooter@ — and Sequoia is not told", async () => {
    // W39's card is open from the schedule test above.
    const open = await openHireSearchCard(env, MON_W39);
    expect(open.opened).toBe(false);
    const cardId = open.cardId;
    const searches: string[] = [];
    const out = await sweepOnce(env, new Date("2026-09-21T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, {
        search: async (_e, _a, prompt) => { searches.push(prompt); return { ok: true, text: searchJson, detail: "ok" }; },
        judge,
        urlStatus: statusOf,
        now: new Date("2026-09-21T14:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    expect(searches).toHaveLength(1);

    // ONE email, to Scooter, through the exec-email door: the busy-executive subject.
    const mails = (await env.WP_OS_DB.prepare("SELECT event_type, payload_json FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(cardId).all<{ event_type: string; payload_json: string }>()).results!;
    expect(mails).toHaveLength(1);
    const payload = JSON.parse(mails[0]!.payload_json) as { to: string; subject: string };
    expect(payload.to).toBe("scooter@westpeek.ventures");
    expect(payload.subject).toBe("Walker: hire search — 3 candidate(s) this week");

    // The deliverable: on Scooter's Home under Walker, with the note as its body.
    const dlv = await env.WP_OS_DB.prepare("SELECT id, kind, prepared_by, prepared_for, title, body FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(cardId).first<{ id: string; kind: string; prepared_by: string; prepared_for: string; title: string; body: string }>();
    expect(dlv).toMatchObject({ kind: "productions_hire_search", prepared_by: "Walker", prepared_for: "fu_scooter_taylor" });
    expect(dlv!.title).toBe("Hire search 2026-W39: 3 candidate(s) for senior experiential producer, freelance");
    expect(dlv!.body).toMatch(/1\. Jordan Example — Senior Experiential Producer \(freelance\), Independent · Brooklyn, NY · fit 9\/10/);
    expect(dlv!.body).toMatch(/refused an automated read — LinkedIn's standard answer; open it to confirm\. The page that answered: https:\/\/agency\.example\/team\/jordan/);
    expect(dlv!.body).toMatch(/2\. Sam Sample — Executive Producer, Freelance · Los Angeles, CA · fit 8\/10/);
    expect(dlv!.body).toMatch(/Opening line for you: "Loved the Coachella activation\."/);
    expect(dlv!.body).toMatch(/Left out because the page did not answer when checked: .*Dead Link/);
    expect(dlv!.body).toMatch(/Left out on judgement .*Not Senior — three years, not eight/);
    /*
     * THE NOTE ASKS FOR NOTHING (17 Sep 2026). This used to assert the presence of a paragraph
     * headed "HOW TO MARK THEM: on your Home page…". The operator removed the chore, so the
     * assertion is inverted AND widened: it is not enough that one paragraph went — nothing in the
     * note may ask the recipient to mark, press, tick or maintain anything, and the invitation that
     * replaced it must actually be there, in Walker's voice, with the reply path named.
     */
    expect(dlv!.body, "no marking verbs anywhere in the note").not.toMatch(/HOW TO MARK|\bmark (?:each|them|it)\b|press Contacted|Contacted or Passed/i);
    // No section 2 in the first week — nobody has been reported before. The heading it would carry
    // is pinned in the dedupe test below; what matters here is that the OLD heading and its
    // "not yet marked" framing cannot appear at all.
    expect(dlv!.body).not.toMatch(/SEEN BEFORE, STILL OPEN|not yet marked/);
    expect(dlv!.body).toMatch(/Just hit reply if you want to steer me/);
    expect(dlv!.body).toMatch(/If you would rather not\s*reply at all, do nothing/);
    expect(dlv!.body).toMatch(/nothing is sent to a candidate from here/);

    // The summary above the note renders clean through the formatter and names the top pick.
    const { hireSummary } = await import("../src/worker/services/productionsHire");
    const rows = (await env.WP_OS_DB.prepare("SELECT name, title, company, city, url AS profileUrl, evidence_url AS evidenceUrl, email, contact_url AS contactUrl, why, opening_line AS openingLine, fit_score AS fit FROM productions_candidate WHERE last_card_id = ?1 ORDER BY fit_score DESC").bind(cardId).all<{ name: string; title: string; company: string; city: string; profileUrl: string; evidenceUrl: string | null; email: string | null; contactUrl: string | null; why: string; openingLine: string; fit: number }>()).results!;
    const summary = hireSummary("2026-W39", rows, [], [], []);
    const rendered = renderExecEmail({ employee: "Walker", ...summary, details: dlv!.body });
    expect(lintExecEmail(rendered.subject, rendered.text, "Walker")).toEqual([]);
    expect(rendered.text).toMatch(/\*\*TL;DR:\*\* \*\*3\*\* new candidate\(s\) .* top pick \*\*Jordan Example\*\*/);

    // Scooter is told quietly; Sequoia is not.
    const notices = (await env.WP_OS_DB.prepare("SELECT firm_user_id FROM notification WHERE object_type IN ('work_card','deliverable') AND object_id IN (?1, ?2)").bind(cardId, dlv!.id).all<{ firm_user_id: string | null }>()).results!;
    expect(notices.length).toBeGreaterThan(0);
    expect(new Set(notices.map((n) => n.firm_user_id))).toEqual(new Set(["fu_scooter_taylor"]));

    // Remembered: the three kept, NEW, keyed by the normalised URL, this week, this card; and the one the judge turned
    // down, PASSED, off the card's list, so it can never come back as new.
    const remembered = (await env.WP_OS_DB.prepare("SELECT url, status, week, last_card_id FROM productions_candidate ORDER BY name").all<{ url: string; status: string; week: string; last_card_id: string }>()).results!;
    expect(remembered).toEqual([
      { url: "https://averysample.example", status: "NEW", week: "2026-W39", last_card_id: cardId },
      { url: "https://linkedin.com/in/jordan-example", status: "NEW", week: "2026-W39", last_card_id: cardId },
      { url: "https://notsenior.example", status: "PASSED", week: "2026-W39", last_card_id: null },
      { url: "https://samsample.example", status: "NEW", week: "2026-W39", last_card_id: cardId },
    ]);

    const done = await env.WP_OS_DB.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(cardId).first<{ state: string; description: string }>();
    expect(done!.state).toBe("DONE");
    expect(done!.description).toMatch(/Deliverable dlv_/);
  });

  it("carries a found contact method end to end: search prompt → parse → note → the row remembered", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate WHERE url = 'https://withcontact.example/x'").run();
    const opened = await openHireSearchCard(env, new Date("2026-11-09T14:00:00.000Z"));
    const withContact = JSON.stringify({
      results: [
        { name: "With Contact", title: "Executive Producer", company: "Freelance", city: "Denver, CO", profile_url: "https://withcontact.example/x", why: "Site lists sponsorship deals sold for three festivals.", opening_line: "hi", fit: 8, email: "with@contact.example", contact_url: "https://withcontact.example/about" },
        { name: "Beside One", title: "Executive Producer", company: "Freelance", city: "Denver, CO", profile_url: "https://besideone.example", why: "Site lists sponsorship deals sold for a conference.", opening_line: "hi", fit: 7 },
        { name: "Beside Two", title: "Executive Producer", company: "Freelance", city: "Denver, CO", profile_url: "https://besidetwo.example", why: "Site lists brand partnerships sold for a tour.", opening_line: "hi", fit: 7 },
      ],
    });
    const out = await sweepOnce(env, new Date("2026-11-09T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, { search: async () => ({ ok: true, text: withContact, detail: "ok" }), judge, urlStatus: statusOf, now: new Date("2026-11-09T14:05:00.000Z") }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    const dlv = await env.WP_OS_DB.prepare("SELECT body FROM deliverable WHERE source_id = ?1").bind(opened.cardId).first<{ body: string }>();
    expect(dlv!.body).toMatch(/Contact: with@contact\.example — from https:\/\/withcontact\.example\/about/);
    const row = await env.WP_OS_DB.prepare("SELECT email, contact_url AS contactUrl FROM productions_candidate WHERE url = ?1").bind("https://withcontact.example/x").first<{ email: string; contactUrl: string }>();
    expect(row).toEqual({ email: "with@contact.example", contactUrl: "https://withcontact.example/about" });
  });

  it("THE ONLY OUTBOUND IS TO scooter@: with a real transport stubbed, one send, to him, and no request to any candidate page beyond a status check", async () => {
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const opened = await openHireSearchCard(env, new Date("2026-10-12T14:00:00.000Z"));
    const sends: Array<{ to: string[]; subject: string }> = [];
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      fetched.push(u);
      if (u.includes("api.resend.com")) { sends.push(JSON.parse(String(init?.body)) as { to: string[]; subject: string }); return new Response(JSON.stringify({ id: "re_hire" }), { status: 200 }); }
      throw new Error(`unexpected fetch ${u}`);
    });
    const withMail = { ...env, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    const out = await sweepOnce(withMail, new Date("2026-10-12T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, { search: async () => ({ ok: true, text: searchJson, detail: "ok" }), judge, urlStatus: statusOf, now: new Date("2026-10-12T14:05:00.000Z") }),
    });
    vi.unstubAllGlobals();
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual(["scooter@westpeek.ventures"]);
    expect(sends[0]!.subject).toMatch(/^Walker: hire search/);
    // Every request that left: the one transport call. The status checks were injected, so no
    // candidate page was fetched here — and nothing, ever, is POSTed to a candidate.
    expect(fetched.filter((u) => !u.includes("api.resend.com"))).toEqual([]);
  });

  it("DEDUPE ACROSS WEEKS: a historical CONTACTED row never returns and is never mentioned; one already reported is 'still on the table'; a new one is new", async () => {
    /*
     * A ROW WRITTEN BY THE RETIRED BUTTONS, set directly (17 Sep 2026). The route that used to
     * write this is gone — see the test below, which proves it is gone rather than merely unused —
     * so the fixture writes what history holds. The contract being pinned is BOTH halves: such a
     * name stays out of the note for ever, AND the note never talks about "acting on" anybody,
     * because that vocabulary described a control Scooter no longer has.
     */
    await env.WP_OS_DB.prepare(
      "UPDATE productions_candidate SET status = 'CONTACTED', status_changed_at = '2026-10-13T00:00:00.000Z', status_changed_by = 'fu_scooter_taylor' WHERE url = 'https://linkedin.com/in/jordan-example'",
    ).run();

    // The next week's search finds the same three plus three new ones.
    const nextWeek = JSON.stringify({ results: [
      ...(JSON.parse(searchJson) as { results: unknown[] }).results,
      { name: "New Person", title: "Senior Producer, Experiential (freelance)", company: "Independent", city: "Atlanta, GA", profile_url: "https://newperson.example", why: "Site lists sponsorship deals sold for three festivals.", opening_line: "Your Essence Fest build.", fit: 7 },
      { name: "Newer Person", title: "Executive Producer (freelance)", company: "Independent", city: "Atlanta, GA", profile_url: "https://newerperson.example", why: "Site lists brand partnerships sold for a tour.", opening_line: "Your tour build.", fit: 6 },
      { name: "Newest Person", title: "Executive Producer (freelance)", company: "Independent", city: "Atlanta, GA", profile_url: "https://newestperson.example", why: "Site lists sponsorships sold for a summit.", opening_line: "Your summit build.", fit: 6 },
    ] });
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const opened = await openHireSearchCard(env, new Date("2026-10-19T14:00:00.000Z"));
    const out = await sweepOnce(env, new Date("2026-10-19T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, { search: async () => ({ ok: true, text: nextWeek, detail: "ok" }), judge, urlStatus: statusOf, now: new Date("2026-10-19T14:05:00.000Z") }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    const dlv = await env.WP_OS_DB.prepare("SELECT body, title FROM deliverable WHERE source_id = ?1").bind(opened.cardId).first<{ body: string; title: string }>();
    expect(dlv!.title).toMatch(/^Hire search 2026-W43: 3 candidate\(s\)/);
    expect(dlv!.body).toMatch(/1\. New Person/);
    expect(dlv!.body).not.toMatch(/\d\. Jordan Example/);
    expect(dlv!.body).not.toMatch(/\d\. Sam Sample/);
    expect(dlv!.body).toMatch(/STILL ON THE TABLE[\s\S]*- Sam Sample — Executive Producer · first seen 2026-10-12/);
    expect(dlv!.body, "no upkeep is implied by the section that lists them").toMatch(/Nothing to do with these/);
    // The retired name is left out SILENTLY. Naming him would report a status nothing can set.
    expect(dlv!.body).not.toMatch(/Jordan Example/);
    // "Nobody has been contacted from here" is Walker stating the boundary and stays. What must be
    // gone is the vocabulary of a status Scooter set: acted on, marked contacted, marked passed.
    expect(dlv!.body).not.toMatch(/already acted on|\(contacted\)|\(passed\)|marked Contacted|marked Passed/i);
    const rows = (await env.WP_OS_DB.prepare("SELECT name, status, week FROM productions_candidate ORDER BY name").all<{ name: string; status: string; week: string }>()).results!;
    expect(rows).toEqual([
      { name: "Avery Sample", status: "SEEN", week: "2026-W43" },
      { name: "Jordan Example", status: "CONTACTED", week: "2026-W42" },
      { name: "New Person", status: "NEW", week: "2026-W43" },
      { name: "Newer Person", status: "NEW", week: "2026-W43" },
      { name: "Newest Person", status: "NEW", week: "2026-W43" },
      // The judge's reject is on file from the first week it was turned down, so it can never return as new.
      { name: "Not Senior", status: "PASSED", week: "2026-W42" },
      { name: "Sam Sample", status: "SEEN", week: "2026-W43" },
    ]);

    // A third week with nothing new: BLOCKED with the reason, nothing emailed.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const third = await openHireSearchCard(env, new Date("2026-10-26T14:00:00.000Z"));
    const again = await sweepOnce(env, new Date("2026-10-26T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, { search: async () => ({ ok: true, text: nextWeek, detail: "ok" }), judge, urlStatus: statusOf, now: new Date("2026-10-26T14:05:00.000Z") }),
    });
    expect(again.card?.id).toBe(third.cardId);
    expect(again.outcome).toBe("BLOCKED");
    // 0254 (R7 for every kind): three parts — the summary leads with what is waiting; the stopped sentence is the "Why" on the card.
    expect(again.summary).toMatch(/is blocked: Waiting on: /);
    const row = await env.WP_OS_DB.prepare("SELECT next_action, block_who FROM work_card WHERE id = ?1").bind(third.cardId).first<{ next_action: string; block_who: string }>();
    expect(row!.next_action).toMatch(/ Why: Everything Walker found this time you have already seen/);
    expect(row!.next_action).toMatch(/every name this week was already in an earlier note \(5 of them\)/i);
    expect(row!.next_action, "even the block asks for nothing but a reply").toMatch(/[Rr]eply to last week's note in plain words/);
    expect(row!.block_who, "Walker's Productions work is Scooter's desk").toBe("SCOOTER");
    const mails = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(third.cardId).first<{ n: number }>();
    expect(mails!.n).toBe(0);
  });

  it("blocks with the reason and emails nothing when nothing survives; the second search is told what was wrong", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const opened = await openHireSearchCard(env, new Date("2026-11-02T14:00:00.000Z"));
    const prompts: string[] = [];
    const out = await sweepOnce(env, new Date("2026-11-02T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, {
        search: async (_e, _a, prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify({ results: [{ name: "Nobody", profile_url: "https://dead.example/x" }] }), detail: "ok" }; },
        judge,
        urlStatus: statusOf,
        now: new Date("2026-11-02T14:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome).toBe("BLOCKED");
    expect(prompts, "one go per route").toHaveLength(HIRE_SEARCH_ROUTES);
    expect(prompts[1]).toMatch(/Your previous answer was discarded: every page was dead or unreadable: Nobody/);
    expect(out.summary).toMatch(/is blocked: Waiting on: /);
    const stoppedRow = await env.WP_OS_DB.prepare("SELECT next_action FROM work_card WHERE id = ?1").bind(opened.cardId).first<{ next_action: string }>();
    expect(stoppedRow!.next_action, "the plain sentence is the Why, whole").toMatch(/ Why: Walker looked and found nothing solid enough to put in front of you/);
    const mails = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(opened.cardId).first<{ n: number }>();
    expect(mails!.n).toBe(0);
  });
});

describe("the candidates behind a note are information, not a queue", () => {
  it("lists them for Scooter, 404s for Sequoia — and the route that used to set a status is GONE, not merely unused", async () => {
    const dlv = await env.WP_OS_DB.prepare("SELECT id FROM deliverable WHERE kind = 'productions_hire_search' ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
    const mine = await handleRequest(req(`/api/productions/candidates?deliverable=${dlv!.id}`, SCOOTER), env);
    expect(mine.status).toBe(200);
    const list = (await mine.json()) as { candidates: Array<{ name: string; status: string }> };
    expect(list.candidates.map((c) => c.name).sort()).toEqual(["Avery Sample", "New Person", "Newer Person", "Newest Person", "Sam Sample"]);

    const hers = await handleRequest(req(`/api/productions/candidates?deliverable=${dlv!.id}`, SEQUOIA), env);
    expect(hers.status, "the list is Scooter's; for anyone else it does not exist").toBe(404);

    /*
     * THE MARKING ROUTE IS REMOVED, AND THIS IS THE ASSERTION THAT SAYS SO (17 Sep 2026).
     *
     * Deleting a UI button is not deleting a control: an endpoint that still accepts a status would
     * let a partner — or anything holding a session — silently change what next week's search
     * returns, with nothing on any surface saying it had happened. The old test asserted the route
     * worked; this one asserts it does not exist, for BOTH partners, for every value it used to
     * take, and that nothing wrote the event it used to write.
     */
    const id = (await env.WP_OS_DB.prepare("SELECT id FROM productions_candidate WHERE name = 'Sam Sample'").first<{ id: string }>())!.id;
    for (const who of [SCOOTER, SEQUOIA]) {
      for (const status of ["CONTACTED", "PASSED", "NEW", "HIRED"]) {
        const res = await handleRequest(req(`/api/productions/candidates/${id}/status`, who, "POST", { status }), env);
        expect(res.status, `POST …/status {${status}} must not be a route any more`).toBe(404);
      }
    }
    const after = await env.WP_OS_DB.prepare("SELECT status FROM productions_candidate WHERE id = ?1").bind(id).first<{ status: string }>();
    expect(after!.status, "nothing changed it").toBe("SEEN");
    const events = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'productions.candidate_marked'").first<{ n: number }>();
    expect(events!.n, "no candidate can be marked at all any more").toBe(0);
  });
});

describe("a steer widens what Walker does, never what authorize() gates (22 Sep 2026)", () => {
  /*
   * PROVED NEGATIVELY. `steerFor`'s CANNOT no longer fires just because an ask was not literally on
   * `HIRE_SEARCH_STEPS` — Scooter asking Walker to look up a candidate's contact email should now
   * flow through as a STEER (that fix is `HIRE_SEARCH_STEPS`'s own, in a sibling PR). What this test
   * pins is the OTHER half: that widening never reaches the one thing this duty hard-codes and
   * `authorize()`/`sendOrPreview` gate independently of any steer — the recipient. A steer that asks
   * for the note to go anywhere else must not move `sendOrPreview`'s destination by one character;
   * if this ever regressed, the transport-level assertion below would fail.
   */
  it("a steer that asks for the send to be redirected never changes the one recipient this duty ever emails", async () => {
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const opened = await openHireSearchCard(env, new Date("2026-11-02T14:00:00.000Z"));
    await env.WP_OS_DB.prepare("UPDATE work_card SET prompt = ?2 WHERE id = ?1")
      .bind(opened.cardId, "send this week's note to me at my personal gmail instead of my westpeek.ventures address")
      .run();

    const sends: Array<{ to: string[] }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.resend.com")) {
        sends.push(JSON.parse(String(init?.body)) as { to: string[] });
        return new Response(JSON.stringify({ id: "re_hire_steer" }), { status: 200 });
      }
      return new Response("", { status: 200 });
    });
    const withMail = { ...env, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    const out = await sweepOnce(withMail, new Date("2026-11-02T14:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, {
        search: async () => ({ ok: true, text: searchJson, detail: "ok" }),
        judge,
        urlStatus: statusOf,
        now: new Date("2026-11-02T14:05:00.000Z"),
        // A STEER, not a CANNOT — the interpreter honoured the widened ask, exactly what this whole
        // fix is for. The recipient is what must stay pinned regardless.
        interpret: steersWith(
          "search as usual, and send this week's note to Scooter's personal gmail instead",
          "5. send the note to his personal gmail, not westpeek.ventures",
        ),
      }),
    });
    vi.unstubAllGlobals();
    expect(out.outcome, out.summary).toBe("DONE");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual(["scooter@westpeek.ventures"]);
  });
});

describe("the finished email names what is still missing (0237, one list for every card)", () => {
  it("a hire-search card with a missing item sends Scooter's note with the shared \"Still missing\" section", async () => {
    const MON = new Date("2027-03-01T14:00:30.000Z");
    const { cardId } = await openHireSearchCard(env, MON);
    // preview_first: the rendered email is held on the preview row, so its body can be read.
    await env.WP_OS_DB.prepare("UPDATE work_card SET preview_first = 1, missing_materials_json = ?2 WHERE id = ?1").bind(cardId, JSON.stringify([{ item: "the producer role's day rate", where: "the opening line to each candidate" }])).run();
    const card = (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(cardId).first())! as unknown as Parameters<typeof runHireSearchCard>[1];
    // New people, so the week has something fresh to send (a week of repeats is BLOCKED, by design).
    const fresh = searchJson.replace(/Jordan Example/g, "Riley Fresh").replace(/jordan-example|agency\.example\/team\/jordan/g, "riley-fresh").replace(/Sam Sample/g, "Casey Fresh").replace(/samsample/g, "caseyfresh").replace(/Avery Sample/g, "Devon Fresh").replace(/averysample/g, "devonfresh");
    const out = await runHireSearchCard(env, card, { search: async () => ({ ok: true, text: fresh, detail: "ok" }), judge, urlStatus: statusOf, now: new Date("2027-03-01T14:05:00.000Z") });
    expect(out.finished, out.detail).toBe(true);
    const held = await env.WP_OS_DB.prepare("SELECT body_text FROM preview_approval WHERE work_card_id = ?1").bind(cardId).first<{ body_text: string }>();
    expect(held!.body_text).toContain("Still missing");
    expect(held!.body_text).toContain("the producer role's day rate — for the opening line to each candidate");
  });
});

describe("the note reaches his inbox or the card says it did not", () => {
  it("A NOTE WHOSE EMAIL DID NOT GO IS NOT DONE: the same note is sent again without a second search, and after the last go the card stops by name (13 Nov 2026, the 2026-W45 card)", async () => {
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const at = new Date("2026-11-03T15:02:00.000Z");
    const opened = await openHireSearchCard(env, at);
    let mailWorks = false;
    const sends: Array<{ to: string[]; subject: string }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes("api.resend.com")) throw new Error(`unexpected fetch ${u}`);
      // What the email service answered every send for four days: the firm's key refused.
      if (!mailWorks) return new Response(JSON.stringify({ message: "API key is invalid" }), { status: 401 });
      sends.push(JSON.parse(String(init?.body)) as { to: string[]; subject: string });
      return new Response(JSON.stringify({ id: "re_hire_later" }), { status: 200 });
    });
    const withMail = { ...env, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
    let searches = 0;
    const runners = {
      productionsHire: (e: Env, card: Parameters<typeof runHireSearchCard>[1]) =>
        runHireSearchCard(e, card, { search: async () => ((searches += 1), { ok: true, text: searchJson, detail: "ok" }), judge, urlStatus: statusOf, now: at }),
    };
    const cardRow = async () => (await env.WP_OS_DB.prepare("SELECT state, block_reason, block_who, block_needed FROM work_card WHERE id = ?1").bind(opened.cardId).first<Record<string, string | null>>())!;
    const go = async (minutes: number) => {
      await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(opened.cardId).run();
      return sweepOnce(withMail, new Date(at.getTime() + minutes * 60_000), runners);
    };
    try {
      const first = await go(3);
      expect(first.card?.id).toBe(opened.cardId);
      expect(first.outcome, "a note that did not reach him is not DONE").toBe("FAILED");
      expect((await cardRow()).state).not.toBe("DONE");
      const remembered = async () => Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM productions_candidate").first<{ n: number }>())?.n);
      const known = await remembered();
      expect(known).toBeGreaterThan(0);
      // The second go sends the SAME note again: no second search, nobody remembered twice.
      expect((await go(9)).outcome).toBe("FAILED");
      expect(searches).toBe(1);
      // The last go: a named stop, on who can repair the sending, the same day.
      expect((await go(15)).outcome).toBe("BLOCKED");
      const blocked = await cardRow();
      expect(blocked).toMatchObject({ state: "BLOCKED", block_reason: "stopped_part_way", block_who: "SEQUOIA" });
      expect(String(blocked.block_needed)).toMatch(/email to him did not go after 3 tries: the email service refused the firm's sending key/);
      expect(sends).toHaveLength(0);
      // Sending repaired and the card tried again: ONE email, the note written on the first go, still no second search.
      mailWorks = true;
      await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', work_attempts = 0, block_reason = NULL WHERE id = ?1").bind(opened.cardId).run();
      const last = await go(60);
      expect(last.outcome, last.summary).toBe("DONE");
      expect(sends.filter((m) => /^Walker: hire search/.test(m.subject))).toHaveLength(1);
      expect(searches).toBe(1);
      expect(await remembered()).toBe(known);
      expect((await cardRow()).state).toBe("DONE");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the floor: a shortlist, or the nearest misses by that name (owner, 13 Nov 2026)", () => {
  const person = (n: number, over: Partial<HireCandidate>): HireCandidate => ({
    name: `Person ${n}`, title: "Freelance Senior Experiential Producer", company: "Freelance", city: "Exampleville, United States",
    profileUrl: `https://person${n}.example`, evidenceUrl: `https://person${n}.example/about`, why: "", openingLine: "", fit: 0, email: null, contactUrl: null, profileCheck: "live", ...over,
  });
  // 2026-W46 as it was delivered, names, employers and addresses replaced: six kept at fit 4 to 5, each by a judge whose
  // own reason said the selling was not on any page.
  const W46 = [
    person(1, { fit: 5, why: "A trade profile shows he freelanced six years before founding his own shop and still freelances for three consumer brands.", judgeReason: "Kept because Scooter approved the shortlist as it stands. He freelances for three brands, all backed by a trade profile. Gaps: no page shows sponsorship sales, the profile link is his company site, and he is partly an owner selling his platform." }),
    person(2, { fit: 5, why: "Her own site says independent senior producer, ten years across commercial and experiential production.", judgeReason: "Kept because Scooter approved the shortlist. Gap: nothing shows brand-deal or sponsorship sales, so she is a proven deliverer but not a proven deal-bringer.", email: "hello@person2.example", contactUrl: "https://person2.example/contact" }),
    person(3, { fit: 5, why: "Her own site says freelance, contract and fractional, with multi-million-dollar programmes for three technology companies.", judgeReason: "Kept because Scooter approved the shortlist. Gaps: her years of experience are not stated and nothing shows sponsorship sales.", email: "hello@person3.example", contactUrl: "https://person3.example/contact" }),
    person(4, { fit: 4, why: "Her portfolio shows 14+ years in experiential marketing and large-scale event production.", judgeReason: "Kept because Scooter approved the shortlist. Gaps: she runs her own shop and does not say she takes freelance work, and nothing shows sponsorship sales." }),
    person(5, { fit: 4, why: "The About page names her as founder producing branded experiences; a second page offers freelance producing to agencies.", judgeReason: "Kept because Scooter approved the shortlist. Gaps: no brands or agencies are named, nothing shows sales, the profile link is her company site.", email: "hello@person5.example", contactUrl: "https://person5.example/contact" }),
    person(6, { fit: 4, why: "A directory listing, self-reported, shows 21 years on brand experiences and mobile tours, freelance since 2005.", judgeReason: "Kept because Scooter approved the shortlist. Gaps: all of this is self-reported on a directory listing, nothing shows sponsorship sales." }),
  ];
  // The 22 Sep 2026 note Scooter called "overall now this is good", the same way: six at fit 6 to 9, selling on the page.
  const STANDARD = [
    person(11, { fit: 9, why: "Her profile headline says senior experiential producer and freelance production, and the page names large-scale brand sponsorship activations and mobile tours." }),
    person(12, { fit: 8, why: "His headline matches freelance brand-activation production and partnership development; the page says he excels in sponsorship and contract negotiations." }),
    person(13, { fit: 8, why: "Her headline shows freelance senior experiential production, and the page lists sponsorship and sports activation management." }),
    person(14, { fit: 8, why: "Her page shows freelance experiential production and names pop-up environments, toured events and sponsorship activation." }),
    person(15, { fit: 7, why: "Her headline identifies a freelance senior producer for conferences and brand experiences; the page mentions sponsorship programs." }),
    person(16, { fit: 6, why: "Her page shows freelance event and experiential production with brand partnerships named for two festivals." }),
  ];

  it("the 2026-W46 note fails it on every count that made it worse; the 22 Sep standard passes it", () => {
    const w46 = hireFloor(W46);
    expect(w46.ok).toBe(false);
    expect(w46.good).toBe(0);
    expect(w46.misses[0]).toBe(`0 of 6 met the standard; a shortlist needs at least ${HIRE_FLOOR.kept}`);
    expect(w46.misses.join(" | ")).toMatch(/Person 1: fit 5\/10, below 6; no page shows them selling sponsorships or brand deals; the judge kept them while its own reason says the evidence is missing/);
    expect(w46.misses).toHaveLength(7);
    expect(hireFloor(STANDARD)).toEqual({ ok: true, misses: [], good: 6 });
    // Each rule by itself, on the standard: two people, a low fit, a keep the judge argued against, a repeat, an unsourced address.
    expect(hireFloor(STANDARD.slice(0, 2)).ok).toBe(false);
    expect(hireFloor([...STANDARD.slice(0, 3), { ...STANDARD[3]!, fit: 5 }]).misses).toEqual(["Person 14: fit 5/10, below 6"]);
    expect(hireFloor([...STANDARD.slice(0, 3), { ...STANDARD[3]!, judgeReason: "Strong producer. Gap: no page shows sponsorship sales." }]).ok).toBe(false);
    expect(hireFloor(STANDARD, new Set([STANDARD[0]!.profileUrl])).misses).toEqual(["Person 11: already shown or turned down in an earlier week"]);
    expect(hireFloor([...STANDARD.slice(0, 3), { ...STANDARD[3]!, email: "x@person14.example", contactUrl: null }]).ok).toBe(false);
    expect(hireFloor([...STANDARD.slice(0, 3), { ...STANDARD[3]!, evidenceUrl: null, profileCheck: "refused" }]).ok, "selling claimed with no page that answered").toBe(false);
  });

  const asJson = (people: readonly HireCandidate[]): string =>
    JSON.stringify({ results: people.map((c) => ({ name: c.name, title: c.title, company: c.company, city: c.city, profile_url: c.profileUrl, evidence_url: c.evidenceUrl, why: c.why, opening_line: "hi", fit: c.fit })) });
  /** A judge that keeps everyone at the searcher's fit, with the reason the fixture carries. */
  const judgeAsWritten = (people: readonly HireCandidate[], seen: string[] = []) => async (_e: unknown, _a: unknown, prompt: string) => {
    seen.push(prompt);
    const body = JSON.parse(prompt.slice(prompt.indexOf("CANDIDATES:\n") + "CANDIDATES:\n".length, prompt.lastIndexOf("Return ONLY JSON"))) as Array<{ name: string; fit: number }>;
    return { ok: true, text: JSON.stringify({ verdicts: body.map((b) => ({ name: b.name, keep: true, fit: b.fit, reason: people.find((p) => p.name === b.name)?.judgeReason ?? "page-backed selling and senior freelance production" })) }), detail: "ok" };
  };
  const fresh = async (at: string) => {
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    return openHireSearchCard(env, new Date(at));
  };
  const cardOf = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Parameters<typeof runHireSearchCard>[1] & Record<string, unknown>>())!;

  it("a result below the floor goes to the next route; the first that reaches it is the shortlist, and the miss is held against the run that wrote it", async () => {
    const opened = await fresh("2026-11-17T15:00:00.000Z");
    await env.WP_OS_DB.prepare(
      `INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, provider_id, model, status, input_hash, trace_id, firm_scope, task_kind)
       VALUES ('air_floor_1', 'Walker: West Peek Productions hire search', 'SYSTEM', 'work_sweep', 'PUBLIC', 'STANDARD', 'NORMAL', 'prov_free_search', 'free-search/grounded', 'COMPLETED', 'h', 'trc_floor_1', 'west-peek', 'search')`,
    ).run();
    const prompts: string[] = [];
    const answers = [asJson(W46), asJson(STANDARD)];
    const out = await sweepOnce(env, new Date("2026-11-17T15:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, {
        search: async (_e, _a, prompt) => { prompts.push(prompt); return { ok: true, text: answers[prompts.length - 1]!, detail: "ok", ...(prompts.length === 1 ? { runId: "air_floor_1" } : {}) }; },
        judge: judgeAsWritten([...W46, ...STANDARD]),
        urlStatus: statusOf,
        now: new Date("2026-11-17T15:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(out.outcome, out.summary).toBe("DONE");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/Your previous answer was discarded: the result did not reach the standard: 0 of 6 met the standard/);
    const dlv = await env.WP_OS_DB.prepare("SELECT title, body FROM deliverable WHERE source_id = ?1").bind(opened.cardId).first<{ title: string; body: string }>();
    expect(dlv!.title).toBe("Hire search 2026-W47: 6 candidate(s) for senior experiential producer, freelance");
    expect(dlv!.body).toMatch(/1\. Person 11 /);
    expect(dlv!.body).not.toMatch(/NEAREST MISSES|\d\. Person [1-6] /);
    // The miss is on the record the router re-ranks from: that route is not asked for this kind of work again today.
    const held = await env.WP_OS_DB.prepare("SELECT outcome, task_kind FROM model_job_outcome WHERE ai_run_id = 'air_floor_1'").first<{ outcome: string; task_kind: string }>();
    expect(held).toEqual({ outcome: "REJECTED", task_kind: "search" });
  });

  it("no route reaches the floor: Scooter gets ONE note that calls itself nearest misses, never a shortlist, and the card stops by name on Sequoia that day", async () => {
    const opened = await fresh("2026-11-24T15:00:00.000Z");
    let searches = 0;
    const out = await sweepOnce(env, new Date("2026-11-24T15:05:00.000Z"), {
      productionsHire: (e, card) => runHireSearchCard(e, card, {
        search: async () => ((searches += 1), { ok: true, text: asJson(W46), detail: "ok" }),
        judge: judgeAsWritten(W46),
        urlStatus: statusOf,
        now: new Date("2026-11-24T15:05:00.000Z"),
      }),
    });
    expect(out.card?.id).toBe(opened.cardId);
    expect(searches, "every route had its go").toBe(HIRE_SEARCH_ROUTES);
    expect(out.outcome).toBe("BLOCKED");
    const card = await cardOf(opened.cardId);
    expect(card).toMatchObject({ state: "BLOCKED", block_reason: "nothing_good_enough_to_send", block_who: "SEQUOIA" });
    expect(String(card.block_needed)).toMatch(/did not reach its standard on any route \(0 of 6 met the standard; a shortlist needs at least 3\)\. The nearest misses are on Scooter's Home, labelled as that, not a shortlist/);
    const dlv = await env.WP_OS_DB.prepare("SELECT title, body FROM deliverable WHERE source_id = ?1").bind(opened.cardId).first<{ title: string; body: string }>();
    expect(dlv!.title).toBe("Hire search 2026-W48: nearest misses (6), not a shortlist, for senior experiential producer, freelance");
    expect(dlv!.body).toMatch(/did NOT reach the standard, so this is not a shortlist: these 6 are the NEAREST MISSES/);
    expect(dlv!.body).toMatch(/What was missing:\n- 0 of 6 met the standard/);
    expect(dlv!.body).toMatch(/═══ 1 · NEAREST MISSES THIS WEEK ═══/);
    expect(dlv!.body).not.toMatch(/NEW THIS WEEK|new candidate\(s\)/);
    const mails = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type LIKE 'deliverable.%'").bind(opened.cardId).all<{ payload_json: string }>()).results!;
    expect(mails).toHaveLength(1);
    expect((JSON.parse(mails[0]!.payload_json) as { subject: string }).subject).toBe("Walker: hire search — nearest misses this week, not a shortlist");
  });

  it("his steer reaches the SEARCH and never the JUDGE; a person the judge turned down is on file and never judged or shown again", async () => {
    const opened = await fresh("2026-12-01T15:00:00.000Z");
    const searchPrompts: string[] = [];
    const judgePrompts: string[] = [];
    const rejecting = async (_e: unknown, _a: unknown, prompt: string) => {
      judgePrompts.push(prompt);
      const body = JSON.parse(prompt.slice(prompt.indexOf("CANDIDATES:\n") + "CANDIDATES:\n".length, prompt.lastIndexOf("Return ONLY JSON"))) as Array<{ name: string; fit: number }>;
      return { ok: true, text: JSON.stringify({ verdicts: body.map((b) => (b.name === "Person 16" ? { name: b.name, keep: false, fit: 3, reason: "an agency owner selling services" } : { name: b.name, keep: true, fit: b.fit, reason: "page-backed selling" })) }), detail: "ok" };
    };
    const run = (at: string, text: string) => async (e: Env, card: Parameters<typeof runHireSearchCard>[1]) =>
      runHireSearchCard(e, card, {
        search: async (_e, _a, prompt) => { searchPrompts.push(prompt); return { ok: true, text, detail: "ok" }; },
        judge: rejecting,
        urlStatus: statusOf,
        now: new Date(at),
        interpret: steersWith("He approves of the shortlist and wants more people with a music background.", "Prefer candidates with a music background; he approved last week's shortlist."),
      });
    await env.WP_OS_DB.prepare("UPDATE work_card SET prompt = 'this is good, more music people' WHERE id = ?1").bind(opened.cardId).run();
    const first = await sweepOnce(env, new Date("2026-12-01T15:05:00.000Z"), { productionsHire: run("2026-12-01T15:05:00.000Z", asJson(STANDARD)) });
    expect(first.outcome, first.summary).toBe("DONE");
    expect(searchPrompts[0]).toMatch(/music background/);
    expect(judgePrompts).toHaveLength(1);
    expect(judgePrompts[0], "the judge reads the written KEEP/DROP rules and nothing he said").not.toMatch(/music background|approved last week's shortlist/);
    expect(judgePrompts[0]).toMatch(/KEEP a candidate only if ALL of these hold/);
    expect(await env.WP_OS_DB.prepare("SELECT status, week FROM productions_candidate WHERE url = 'https://person16.example'").first()).toEqual({ status: "PASSED", week: "2026-W49" });

    // The next week the search returns the reject again beside three new people: not judged, not listed, not new.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").run();
    const next = await openHireSearchCard(env, new Date("2026-12-08T15:00:00.000Z"));
    const week2 = [STANDARD[5]!, person(21, { fit: 7, why: "Page names sponsorships sold for a tour." }), person(22, { fit: 7, why: "Page names brand partnerships sold." }), person(23, { fit: 6, why: "Page names sponsorship sales for a summit." })];
    const second = await sweepOnce(env, new Date("2026-12-08T15:05:00.000Z"), { productionsHire: run("2026-12-08T15:05:00.000Z", asJson(week2)) });
    expect(second.card?.id).toBe(next.cardId);
    expect(second.outcome, second.summary).toBe("DONE");
    expect(judgePrompts[1]).not.toMatch(/Person 16/);
    const dlv = await env.WP_OS_DB.prepare("SELECT title, body FROM deliverable WHERE source_id = ?1").bind(next.cardId).first<{ title: string; body: string }>();
    expect(dlv!.title).toMatch(/: 3 candidate\(s\)/);
    expect(dlv!.body).not.toMatch(/Person 16/);
  });

  it("a steer that could not be read is a failed go the sweep tries again, never 'the brief is missing' on Scooter (the 2026-W44 card)", async () => {
    const opened = await fresh("2026-12-15T15:00:00.000Z");
    await env.WP_OS_DB.prepare("UPDATE work_card SET prompt = 'more music people' WHERE id = ?1").bind(opened.cardId).run();
    let searches = 0;
    const out = await runHireSearchCard(env, await cardOf(opened.cardId), {
      search: async () => ((searches += 1), { ok: true, text: asJson(STANDARD), detail: "ok" }),
      judge: judgeAsWritten(STANDARD),
      urlStatus: statusOf,
      now: new Date("2026-12-15T15:05:00.000Z"),
      interpret: async () => ({ ok: false, text: "", detail: "provider_failure:subscription_seat_unavailable:the seat was awake but returned nothing within 2 minutes", aiRunId: null, model: null }) as never,
    });
    expect(out).toMatchObject({ finished: false, blocked: false });
    expect(out.detail).toMatch(/could not be read: .*subscription_seat_unavailable/);
    expect(searches).toBe(0);
    const card = await cardOf(opened.cardId);
    expect(card.state).not.toBe("BLOCKED");
    expect(card.block_reason ?? null).toBeNull();
  });
});
