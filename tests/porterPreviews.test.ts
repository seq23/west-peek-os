import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce } from "../src/worker/services/workSweep";
import { reportRun, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { parkPhase, readWebPropertyChange, rulesFor, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";

/**
 * A PREVIEW AT EVERY STOPPING POINT, AND THE APPROVAL BINDS TO THE LATEST ONE (owner, 23 Sep 2026;
 * migration 0240).
 *
 * "porter should be sending us a preview link before the missing items applied and after" — then,
 * worried about waste: no polling; only her reply (or "I added missing items") re-checks the
 * folder, and a rebuild happens only if the material set actually changed. "publish" with new
 * materials lands without another preview; a stale "approved" never lands a superseded build.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const FOLDER = "1PrEvIeWsAtEvErYsToP";
let clock = Date.now();

async function tickFor(id: string) {
  for (let i = 0; i < 8; i++) {
    clock += 3 * 60_000;
    const out = await sweepOnce(env, new Date(clock));
    if (out.card?.id === id) return out;
  }
  throw new Error(`the sweep never reached ${id}`);
}
const row = async (id: string) => (await readWebPropertyChange(env, id))!;
const card = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
const liveJob = (id: string) =>
  env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status IN ('QUEUED','CLAIMED') ORDER BY created_at DESC LIMIT 1").bind(id).first<SeatRunRow>();
async function macReports(id: string, report: Record<string, unknown>) {
  const run = await env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED'").bind(id).first<SeatRunRow>();
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2 WHERE id = ?1").bind(run!.id, new Date().toISOString()).run();
  expect((await reportRun(env, { runId: run!.id, deviceId: "mac", outputText: JSON.stringify(report) })).accepted).toBe(true);
  return JSON.parse(run!.job_json!) as { phase: string; refresh?: boolean; materials_fingerprint?: string | null };
}
async function token(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;
}
async function reply(who: string, id: string, written: string) {
  const raw = [`From: ${who}`, "To: os@joinwestpeek.com", "Subject: Re: Porter", "", written, "", "On Wed, Porter wrote:", "> Preview ready"].join("\n");
  return steerFromReply(env, { fromHeader: `<${who}>`, authenticationResults: GOOD_AUTH(who), subject: "Re: Porter", raw, inReplyTo: threadReference(await token(id)), references: null, emlKey: null });
}
async function post(path: string, who: string) {
  const res = await handleRequest(new Request(`https://test.local${path}`, { method: "POST", headers: { "x-wpos-dev-user": who, "content-type": "application/json" }, body: "{}" }), env);
  return { status: res.status, body: (await res.json()) as { ok?: boolean; said?: string; detail?: string; message_id?: string | null } };
}

/** A community-site card of Sequoia's, planned with two placeholders, approved, built green: waiting on preview 1. */
async function atFirstPreview(subject: string, build: Record<string, unknown> = {}): Promise<string> {
  const chief = await openAssignmentCard(env, { subject, partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `Porter, ${subject} on the community site — https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 5)}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chief)).description))![1]!;
  await tickFor(id);
  // One ask WITHOUT a recommendation, so the plan still blocks and "approved" still clears it (since
  // 27 Sep 2026 a plan whose every ask carries a recommendation is approved by the request).
  await macReports(id, { phase: "PLAN", status: "ok", document: `# joinwestpeek.com — ${subject} (PLAN)\n\nbody`, decided: [], asks: [{ question: "Orange?", recommended: "#c45a3c" }, { question: "Which Sengo logo — the black or the white?" }], publish_ready: false, placeholders: ["Sengo logo", "Ep 4 link"] });
  expect((await tickFor(id)).outcome).toBe("BLOCKED");
  expect((await reply(SEQUOIA, id, "approved")).answered).toBe(true);
  expect((await tickFor(id)).summary).toMatch(/BUILD queued/);
  await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/501", pr_number: 501, branch: `work/wpc-${id.slice(3, 11)}`, check_state: "GREEN", preview_url: "https://1a2b3c4d.west-peek-community.pages.dev", materials: "30:aaaa0001", ...build });
  expect((await tickFor(id)).outcome, "preview 1: built with placeholders straight after the plan").toBe("BLOCKED");
  return id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("preview 1 comes straight after the plan, with placeholders, and nothing polls while it waits", () => {
  let id = "";
  it("the first preview email goes out with the branch alias and the placeholders still showing", async () => {
    id = await atFirstPreview("gallery page");
    const r = await row(id);
    expect(r.phase).toBe("BUILD");
    expect(r.materials_fingerprint).toBe("30:aaaa0001");
    const mail = sent.filter((m) => m.to === SEQUOIA && /: Preview ready$/.test(m.subject));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.text).toMatch(new RegExp(`https://work-wpc-${id.slice(3, 11)}\\.west-peek-community\\.pages\\.dev\\n`));
    expect(mail[0]!.text).toMatch(/\*\*Still missing \(optional\)\*\*\n• Sengo logo\n• Ep \*{0,2}4\*{0,2} link\n/);
  });

  it("NO SWEEP PATH RE-MAPS DRIVE for a card waiting on a preview: tick after tick, nothing is parked for the Mac", async () => {
    for (let i = 0; i < 5; i++) {
      clock += 60 * 60_000;
      await sweepOnce(env, new Date(clock));
    }
    expect(await liveJob(id), "only her reply or the button starts a materials check").toBeNull();
    expect((await card(id)).state).toBe("BLOCKED");
  });
});

/**
 * THE PREVIEW LINKS THE PAGES THAT CHANGED (9 Oct 2026). Scooter's "New preview ready" email for
 * voting.topbarz.xyz linked only https://work-wpc-739461bd.topbarz-voting.pages.dev — the root — when
 * the pages that changed were /entry and /rules. The Mac now reports the PR's changed files; the email
 * and the card's preview line carry the root plus one link per changed public page.
 */
describe("the preview email links each changed page, not only the root", () => {
  it("public/entry.html and public/rules/index.html become /entry and /rules links; functions/* links nothing", async () => {
    const before = sent.length;
    const id = await atFirstPreview("contest pages", {
      changed_files: ["public/entry.html", "public/rules/index.html", "functions/api/entry.ts", "public/styles.css"],
    });
    const root = `https://work-wpc-${id.slice(3, 11)}.west-peek-community.pages.dev`;
    const mail = sent.slice(before).filter((m) => m.to === SEQUOIA && /: Preview ready$/.test(m.subject));
    expect(mail).toHaveLength(1);
    const text = mail[0]!.text;
    expect(text, "the root-only link is gone").not.toMatch(new RegExp(`${root.replace(/\./g, "\\.")}\\n`));
    expect(text).toContain(`${root} — changed pages: ${root}/entry · ${root}/rules`);
    expect(text).not.toContain(`${root}/api`);
    expect(text).not.toContain(`${root}/styles`);
    expect(String((await card(id)).description)).toContain(`${root}/entry`);
    expect(JSON.parse(String((await row(id)).changed_pages_json))).toEqual(["/entry", "/rules"]);
  });
});

describe("\"publish\" with new materials: filled in and published without another preview (her option 3)", () => {
  it("a changed material set rebuilds and lands on green; no second preview email; the approval is hers and binds to the rebuild", async () => {
    const id = await atFirstPreview("pitch page");
    const before = sent.length;
    expect((await reply(SEQUOIA, id, "publish")).answered).toBe(true);
    const check = await tickFor(id);
    expect(check.summary).toMatch(/A materials check after the preview; BUILD queued/);
    const queued = await row(id);
    expect(queued.publish_approved_by).toBe("fu_sequoia_taylor");
    expect(queued.land_approved_at).toBe(queued.publish_approved_at);
    expect(queued.refresh_intent).toBe("PUBLISH");
    // Not before the rebuild: the preview she looked at never lands on a "publish".
    const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
    const c = await card(id);
    const sweepCard = { id, title: String(c.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SEQUOIA };
    const early = await parkPhase(env, sweepCard, queued, "LAND", rules);
    expect(early.parked).toBe(false);
    expect((early as { reason: string }).reason).toMatch(/no build with the new materials has gone green since/);
    const job = await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/501", pr_number: 501, branch: `work/wpc-${id.slice(3, 11)}`, check_state: "GREEN", preview_url: "https://5e6f7a8b.west-peek-community.pages.dev", materials: "31:bbbb0002", missing_materials: [{ item: "Ep 4 link", where: "episodes" }] });
    expect(job.refresh, "the Mac was asked to check the materials first").toBe(true);
    expect(job.materials_fingerprint).toBe("30:aaaa0001");
    const landing = await tickFor(id);
    expect(landing.summary).toMatch(/landing is queued for the Mac \(published with the new materials/);
    expect((await row(id)).phase).toBe("LAND");
    expect(sent.slice(before).filter((m) => m.to === SEQUOIA && /preview ready/i.test(m.subject)), "no second preview").toHaveLength(0);
    expect(String((await card(id)).description)).toMatch(/Filled in by this build: Sengo logo\./);
  });

  it("an UNCHANGED material set lands nothing: the publish approval is withdrawn and she is told, once", async () => {
    const id = await atFirstPreview("workshops page");
    const before = sent.length;
    await reply(SEQUOIA, id, "publish");
    await tickFor(id);
    await macReports(id, { phase: "BUILD", status: "unchanged", materials: "30:aaaa0001" });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const r = await row(id);
    expect(r.land_approved_at).toBeNull();
    expect(r.publish_approved_at).toBeNull();
    expect(r.phase).toBe("BUILD");
    expect(await liveJob(id)).toBeNull();
    const told = sent.slice(before).filter((m) => m.to === SEQUOIA);
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toMatch(/: Nothing new found$/);
    expect(told[0]!.text).toMatch(/^\*\*TL;DR:\*\* I didn't find anything new in the folder or attached; reply "approved" to publish as is\./);
  });

  it("the other partner's \"publish\" is a note, not a rebuild and not an approval", async () => {
    const id = await atFirstPreview("history page");
    const out = await reply(SCOOTER, id, "publish");
    expect(out.answered).toBe(false);
    expect((await row(id)).publish_approved_at).toBeNull();
    expect(await liveJob(id)).toBeNull();
  });
});

describe("\"decision N: …\" settles one decision after the fact — recorded, never a rebuild", () => {
  it("the answer is on the card, the same preview waits, and the next preview email lists it as solved", async () => {
    const id = await atFirstPreview("fonts page");
    const before = sent.length;
    expect((await reply(SEQUOIA, id, "decision 1: #c45a3c everywhere — the brand guide confirms it")).answered).toBe(true);
    const out = await tickFor(id);
    expect(out.outcome).toBe("BLOCKED");
    expect(await liveJob(id), "no rebuild for a decision the preview already reflects").toBeNull();
    const answers = JSON.parse((await row(id)).answers_json) as string[];
    expect(answers.at(-1)).toMatch(/^1\. #c45a3c everywhere \(solved: Sequoia confirmed the brand guide confirms it \([A-Z][a-z]{2} \d{1,2}\)\)$/);
    expect(sent.slice(before).filter((m) => m.to === SEQUOIA), "no email for a recorded decision").toHaveLength(0);
    const resent = await post(`/api/work-cards/${id}/resend-preview`, SEQUOIA);
    expect(resent.body.ok).toBe(true);
    // The settled decision reads as what was chosen; how it was settled stays on the card.
    expect(sent.at(-1)!.text).toMatch(/\*\*Decided so far\*\*\n• Orange: #c45a3c everywhere\n/);
  });
});

describe("a stale approval never lands", () => {
  it("an \"approved\" older than the latest preview is refused by the Worker's gate and by the row", async () => {
    const id = await atFirstPreview("about page");
    const r = await row(id);
    const stale: WebPropertyChangeRow = { ...r, land_approved_at: new Date(Date.parse(r.preview_emailed_at!) - 60_000).toISOString() };
    const c = await card(id);
    const gate = await parkPhase(env, { id, title: String(c.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SEQUOIA }, stale, "LAND", await rulesFor(env, WEB_PROPERTY_CHANGE_KIND));
    expect(gate.parked).toBe(false);
    expect((gate as { reason: string }).reason).toMatch(/predates the latest preview/);
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET land_approved_at = ?2 WHERE work_card_id = ?1").bind(id, stale.land_approved_at).run();
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'abc' WHERE work_card_id = ?1").bind(id).run()).rejects.toThrow(/stale approval cannot land/);
    // The same approval AFTER the preview is admitted by the row.
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET land_approved_at = ?2 WHERE work_card_id = ?1").bind(id, new Date(Date.parse(r.preview_emailed_at!) + 60_000).toISOString()).run();
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'abc' WHERE work_card_id = ?1").bind(id).run();
    expect((await row(id)).merge_sha).toBe("abc");
  });
});

describe("\"I added missing items\" (her label, exactly) and the preview re-sent in the new template", () => {
  it("only the partner who asked can press it; at a preview it starts ONE materials check; at the plan it approves nothing", async () => {
    const id = await atFirstPreview("team page");
    expect((await post(`/api/work-cards/${id}/materials-added`, SCOOTER)).status, "Scooter did not ask for this one").toBe(403);
    const pressed = await post(`/api/work-cards/${id}/materials-added`, SEQUOIA);
    expect(pressed.status).toBe(200);
    expect(pressed.body.said).toMatch(/^I added missing items — noted\./);
    const check = await tickFor(id);
    expect(check.summary).toMatch(/A materials check after the preview; BUILD queued/);
    expect((await row(id)).refresh_intent).toBe("PREVIEW");

    const chief = await openAssignmentCard(env, { subject: "events page", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `Porter, events page on the community site — https://drive.google.com/drive/folders/${FOLDER}evnts`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const planId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chief)).description))![1]!;
    await tickFor(planId);
    await macReports(planId, { phase: "PLAN", status: "ok", document: "# Plan: events page", decided: [], asks: [{ question: "Dates?", recommended: "as listed" }, { question: "Which venue photo?" }], publish_ready: false, placeholders: ["Ep 6 flyer"] });
    await tickFor(planId);
    expect((await post(`/api/work-cards/${planId}/materials-added`, SEQUOIA)).status).toBe(200);
    expect((await row(planId)).plan_approved_at, "the button is never a plan approval").toBeNull();
    expect((await card(planId)).state).toBe("BLOCKED");
  });

  it("resend-preview: the waiting preview again in the current template, same link, once per preview, requester only", async () => {
    const id = await atFirstPreview("podcast page");
    expect((await post(`/api/work-cards/${id}/resend-preview`, SCOOTER)).status).toBe(403);
    const before = sent.length;
    const first = await post(`/api/work-cards/${id}/resend-preview`, SEQUOIA);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.message_id).toMatch(/^wpt_[0-9a-f]{32}$/);
    const mail = sent.slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toMatch(/: Preview ready$/);
    expect(mail[0]!.text).toMatch(/^\*\*TL;DR:\*\* Preview ready, with \*\*2\*\* placeholders\. Reply with one of these:\n• \*\*approved\*\*/);
    expect(mail[0]!.text).toMatch(new RegExp(`https://work-wpc-${id.slice(3, 11)}\\.west-peek-community\\.pages\\.dev\\n`));
    const again = await post(`/api/work-cards/${id}/resend-preview`, SEQUOIA);
    expect(again.body.ok, "a double press sends nothing twice").toBe(false);
    expect(sent.length).toBe(before + 1);
    const notices = (await env.WP_OS_DB.prepare("SELECT kind, cause FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' ORDER BY sent_at").bind(id).all<{ kind: string; cause: string }>()).results!;
    expect(notices.map((n) => n.cause.startsWith("resend:"))).toEqual([false, true]);
  });
});
