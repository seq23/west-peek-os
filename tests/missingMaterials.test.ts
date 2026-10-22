import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * THE MODEL IS REPLACED, NOTHING ELSE IS. Every other line of the general loop, the sweep, the
 * thread door and the email lane runs for real; `runAi` answers from a queue and records what it
 * was shown, so the test can read the prompt the employee actually received.
 */
const shown: string[] = [];
const replies: string[] = [];
vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return {
    ...actual,
    runAi: async (_env: unknown, input: { purpose: string; inputs: string[] }) => {
      shown.push(input.inputs.join("\n"));
      const text = /checking whether a partner's email/.test(input.purpose) ? "VERDICT: ACTIONABLE_WORK\nREASON: a real request" : (replies.shift() ?? '{"action":"note","finding":"(no scripted reply)"}');
      return { run: { id: `run_${shown.length}`, status: "COMPLETED", output_text: text, failure_reason: null } };
    },
  };
});

import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce } from "../src/worker/services/workSweep";
import { reportRun, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { steerFor } from "../src/worker/services/instruction";
import { steersWith } from "./helpers/interpret";
import { HOW_TO_SEND_MATERIALS, missingMaterialsSection, readMissingMaterials } from "../src/shared/work/missingMaterials";
import { attachmentsFor, storeAttachments, missingFor } from "../src/worker/services/requestMaterials";
import { readWebPropertyChange } from "../src/worker/services/webPropertyChange";
import type { LocalJobPayload } from "../src/shared/work/localJobs";
import { buildStepPrompt, parseDecision } from "../src/shared/work/employeeLoop";

/**
 * MISSING MATERIALS AND A REPLY'S FILES, FOR EVERY EMPLOYEE (owner, 23 Sep 2026, migration 0237).
 *
 * Her question: "is he going to send me a list of missing materials and ask me to upload them?" —
 * and then: "all agents do it this way, not just Porter". Proven on a NON-Porter card (Wren's
 * general loop, and a steered chain) and on Porter's web lane:
 *
 *   · THE ASK: a blocked run lists the files it needs; the email asks for each, says where it goes,
 *     and says how to send it (the Drive folder, or attached to a reply).
 *   · A REPLY'S FILES ARE KEPT on the card and reach the card's NEXT run, whatever its kind.
 *   · THE FINISH: the finished (or preview) email names only what is STILL missing.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SEQUOIA}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

let clock = Date.now();
async function tickFor(id: string) {
  for (let i = 0; i < 8; i++) {
    clock += 3 * 60_000;
    const out = await sweepOnce(env, new Date(clock));
    if (out.card?.id === id) return out;
  }
  throw new Error(`the sweep never reached ${id}`);
}
const card = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
const tokenFor = async (id: string) => (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;

/** A Gmail-shaped reply: the words, and optionally a file, above the quoted original. */
function replyMime(words: string, file?: { name: string; type: string }): string {
  return [
    `From: Sequoia Taylor <${SEQUOIA}>`,
    "To: os@joinwestpeek.com",
    "Subject: Re: blocked",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    words,
    "",
    "On Wed, 23 Sep 2026 at 09:00, Wren <os@westpeek.ventures> wrote:",
    "> the question",
    "",
    ...(file ? ["--b1", `Content-Type: ${file.type}; name="${file.name}"`, `Content-Disposition: attachment; filename="${file.name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(`bytes of ${file.name}`).toString("base64")] : []),
    "--b1--",
    "",
  ].join("\r\n");
}

async function reply(cardId: string, words: string, file?: { name: string; type: string }) {
  return steerFromReply(env, {
    fromHeader: `<${SEQUOIA}>`,
    authenticationResults: GOOD_AUTH,
    subject: "Re: blocked",
    raw: replyMime(words, file),
    inReplyTo: threadReference(await tokenFor(cardId)),
    references: null,
    emlKey: `inbound-email/reply-${crypto.randomUUID()}.eml`,
  });
}

/** Every email that reached her, or is waiting for her approval before it goes. */
async function mailFor(cardId: string): Promise<string[]> {
  const held = (await env.WP_OS_DB.prepare("SELECT body_text FROM preview_approval WHERE work_card_id = ?1 ORDER BY created_at").bind(cardId).all<{ body_text: string }>()).results ?? [];
  return [...sent.filter((m) => m.to === SEQUOIA).map((m) => m.text), ...held.map((h) => h.body_text)];
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

describe("the shared section: one list, one renderer", () => {
  it("asks for each item, says where it goes and how to send it; names what is still missing at the end; says nothing when nothing is missing", () => {
    const items = readMissingMaterials([{ item: "the fund logo (SVG)", where: "the one-pager header" }, { item: "" , where: "x" }, "Q3 letter"]);
    expect(items).toEqual([{ item: "the fund logo (SVG)", where: "the one-pager header" }, { item: "Q3 letter", where: "where the work needs it" }]);
    const ask = missingMaterialsSection(items, "ASK")!;
    expect(ask.label).toBe("Missing materials — please send these");
    expect(ask.bullets[0]).toBe("the fund logo (SVG) — for the one-pager header");
    expect(ask.bullets).toContain(HOW_TO_SEND_MATERIALS);
    expect(HOW_TO_SEND_MATERIALS).toMatch(/Drive folder/);
    expect(HOW_TO_SEND_MATERIALS).toMatch(/attach it to your reply/);
    expect(missingMaterialsSection(items, "STILL")!.label).toBe("Still missing");
    expect(missingMaterialsSection([], "ASK"), "a card with no gap renders exactly as before").toBeNull();
  });

  it("the general loop tells an employee to list the files it needs, and reads them back from a blocked or finished decision", () => {
    const prompt = buildStepPrompt({ title: "t", next_action: null, description: null, employee_name: "Wren", employee_role: "Chief of Staff", allows_browser: false, prompt: null, guidance: "", history: [], materials: "FILES THE PARTNER SENT (kept on the card; each opens by name on the card):\n  • logo.svg" }, 3);
    expect(prompt).toMatch(/FILES THE PARTNER SENT/);
    expect(prompt).toMatch(/also list each in\s+missing with where it goes/);
    expect(parseDecision('{"action":"blocked","needs":"the logo","missing":[{"item":"logo","where":"header"}]}')!.missing).toEqual([{ item: "logo", where: "header" }]);
    expect(parseDecision('{"action":"done","finding":"ok","missing":[]}')!.missing, "an empty list is nothing missing").toBeUndefined();
  });
});

describe("a NON-Porter card: Wren's general loop asks for the files, keeps the reply's file, and finishes naming only what is still missing", () => {
  let id = "";

  it("a blocked run records what it needs, and the email asks for each item with where it goes and how to send it", async () => {
    id = await openAssignmentCard(env, { subject: "LP one-pager", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Wren, put together a one-pager on the fund for Thursday's LP meeting.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    expect((await card(id)).kind, "an ordinary assignment, worked by the general loop").toBeNull();
    replies.push('{"action":"blocked","needs":"I need the fund logo and the Q3 letter to build this.","missing":[{"item":"the fund logo (SVG)","where":"the one-pager header"},{"item":"the Q3 LP letter (PDF)","where":"the performance section"}]}');
    const out = await tickFor(id);
    expect(out.outcome).toBe("BLOCKED");
    expect(await missingFor(env, id)).toHaveLength(2);
    const mail = (await mailFor(id)).join("\n\n");
    expect(mail).toMatch(/Missing materials — please send these/);
    expect(mail).toMatch(/• the fund logo \(SVG\) — for the one-pager header/);
    expect(mail).toMatch(/• the Q3 LP letter \(PDF\) — for the performance section/);
    expect(mail).toContain(HOW_TO_SEND_MATERIALS);
  });

  it("her reply's file is kept on the card (source REPLY) and reaches the next run's prompt by name", async () => {
    const r = await reply(id, "Logo attached — the letter is coming.", { name: "west-peek-logo.svg", type: "image/svg+xml" });
    expect(r.steered).toBe(true);
    expect(r.attached).toEqual(["west-peek-logo.svg"]);
    const files = await attachmentsFor(env, id);
    expect(files.map((f) => [f.filename, f.source])).toEqual([["west-peek-logo.svg", "REPLY"]]);
    expect(String((await card(id)).description)).toMatch(/ATTACHED WITH A REPLY from sequoia@westpeek\.ventures: west-peek-logo\.svg/);
    const before = shown.length;
    replies.push('{"action":"done","finding":"One-pager drafted with the logo; the performance section waits on the Q3 letter.","missing":[{"item":"the Q3 LP letter (PDF)","where":"the performance section"}]}');
    await tickFor(id);
    const prompt = shown.slice(before).join("\n");
    expect(prompt).toMatch(/FILES THE PARTNER SENT/);
    expect(prompt).toMatch(/west-peek-logo\.svg \(image\/svg\+xml, \d+ bytes\) — sent with a reply/);
  });

  it("the finished email names ONLY what is still missing — the logo that arrived is not asked for again", async () => {
    expect((await card(id)).state).toBe("DONE");
    expect(await missingFor(env, id)).toEqual([{ item: "the Q3 LP letter (PDF)", where: "the performance section" }]);
    const mails = await mailFor(id);
    const done = mails[mails.length - 1]!;
    expect(done).toMatch(/Still missing/);
    expect(done).toMatch(/the Q3 LP letter \(PDF\) — for the performance section/);
    expect(done).not.toMatch(/fund logo \(SVG\) — for/);
  });

  it("a reply that is ONLY a file still reaches the card, and says what it carried", async () => {
    const other = await openAssignmentCard(env, { subject: "Deck check", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Wren, check the deck numbers against the model.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    replies.push('{"action":"blocked","needs":"Send me the model.","missing":[{"item":"the fund model (XLSX)","where":"the numbers check"}]}');
    await tickFor(other);
    const r = await reply(other, "", { name: "fund-model.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(r.steered).toBe(true);
    expect(r.answered, "the file is the answer to 'send me the model'").toBe(true);
    expect(r.written).toBe("Attached: fund-model.xlsx");
    expect((await attachmentsFor(env, other)).map((f) => f.filename)).toEqual(["fund-model.xlsx"]);
    // Any file sent AS an attachment is kept, not only images and PDFs — a .csv (text/*) too.
    const csv = await reply(other, "and the list", { name: "speakers.csv", type: "text/csv" });
    expect(csv.attached).toEqual(["speakers.csv"]);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(other).run();
  });
});

describe("a steered chain (any kind that calls steerFor) is handed the card's files too", () => {
  it("a file on the card rides on the steer text; a card with none keeps the steer exactly as it was", async () => {
    const withFile = await openAssignmentCard(env, { subject: "Room packet", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Parker, the room packet for October.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    await env.WP_OS_DB.prepare("INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key, firm_scope, source) VALUES ('ratt_t1', ?1, 'speaker-list.csv', 'text/csv', 42, 'inbound-email/x.eml', 'west-peek', 'REPLY')").bind(withFile).run();
    const actor = { type: "AI" as const, aiEmployeeId: "aie_parker", roles: [], firmScopes: ["west-peek"] };
    const req = (cardId: string) => ({ cardId, cardKind: "ROOM_PACKET", title: "Room packet", employee: "Parker", chain: "Parker's Room packet", steps: ["brief", "packet"], firmScope: "west-peek" });
    const steer = await steerFor(env, actor as never, req(withFile), steersWith("the October packet", "keep it short"));
    expect(steer.text).toMatch(/speaker-list\.csv \(text\/csv, 42 bytes\) — sent with a reply/);
    const bare = await openAssignmentCard(env, { subject: "Room packet 2", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Parker, the room packet for November.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const steer2 = await steerFor(env, actor as never, req(bare), steersWith("x"));
    expect(steer2.text).not.toMatch(/FILES THE PARTNER SENT/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id IN (?1, ?2)").bind(withFile, bare).run();
  });
});

describe("a file is on a card once per stored message (27 Sep 2026: image0.jpeg listed twice in a BUILD brief)", () => {
  it("the same .eml stored against the same card a second time (a replay, or the matcher after a merge) adds no row; a different message with the same file name does", async () => {
    const id = await openAssignmentCard(env, { subject: "Flyer swap", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Porter, swap the flyer.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const raw = replyMime("the photo", { name: "image0.jpeg", type: "image/jpeg" });
    const first = await storeAttachments(env, { cardId: id, raw, emlKey: "inbound-email/2026-09-27/same.eml", firmScope: "west-peek", source: "REQUEST" });
    const again = await storeAttachments(env, { cardId: id, raw, emlKey: "inbound-email/2026-09-27/same.eml", firmScope: "west-peek", source: "REPLY" });
    expect(first.stored).toEqual(["image0.jpeg"]);
    expect(again.stored, "the file is on the card, so it is still named").toEqual(["image0.jpeg"]);
    expect((await attachmentsFor(env, id)).map((f) => [f.filename, f.eml_key, f.source]), "one row, the first one").toEqual([["image0.jpeg", "inbound-email/2026-09-27/same.eml", "REQUEST"]]);
    // A second message carrying a file of the same name is a second file.
    await storeAttachments(env, { cardId: id, raw, emlKey: "inbound-email/2026-09-27/other.eml", firmScope: "west-peek", source: "REPLY" });
    expect((await attachmentsFor(env, id)).map((f) => f.eml_key)).toEqual(["inbound-email/2026-09-27/same.eml", "inbound-email/2026-09-27/other.eml"]);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});

describe("Porter's web lane: the plan asks for the materials, a reply's file reaches BUILD, the preview names what is still missing", () => {
  let id = "";

  async function macReports(report: Record<string, unknown>) {
    const run = await env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED'").bind(id).first<SeatRunRow>();
    expect(run).not.toBeNull();
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2 WHERE id = ?1").bind(run!.id, new Date().toISOString()).run();
    expect((await reportRun(env, { runId: run!.id, deviceId: "mac", outputText: JSON.stringify(report) })).accepted).toBe(true);
  }
  const payload = async (): Promise<LocalJobPayload> =>
    JSON.parse((await env.WP_OS_DB.prepare("SELECT job_json FROM subscription_seat_run WHERE work_card_id = ?1 AND status = 'QUEUED'").bind(id).first<{ job_json: string }>())!.job_json) as LocalJobPayload;

  it("the plan email carries the Missing materials section: each item, where it goes, and how to send it", async () => {
    const chief = await openAssignmentCard(env, { subject: "Community podcast page", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Porter, add the podcast page to the community site from https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr. Preview first.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chief)).description))![1]!;
    await tickFor(id);
    await macReports({
      phase: "PLAN",
      status: "ok",
      document: "# Plan: podcast page\n\nFive episode cards from the package; two headshots are not in the folder.",
      decided: ["episode cards from the manifest"],
      asks: [],
      publish_ready: false,
      placeholders: ["Ep 6 headshot", "Ep 7 headshot"],
      missing_materials: [
        { item: "Ep 6 guest headshot (JPG)", where: "the Ep 6 card on /podcast" },
        { item: "Ep 7 guest headshot (JPG)", where: "the Ep 7 card on /podcast" },
      ],
      assets: ["Ep 1/headshot.jpg", "Brand/maax-bold.otf"],
    });
    // Nothing to decide (no asks) → approved by the request and BUILD parked at filing; the plan
    // email is the FYI (27 Sep 2026). Stricter than the old pin, which asserted a block here.
    expect((await tickFor(id)).outcome).toBe("PROGRESSED");
    expect((await readWebPropertyChange(env, id))!.plan_approved_by).toMatch(/^request:/);
    // 23 Sep 2026 (owner: "i should have the option to continue without them and just get
    // placeholders"): the plan email lists them as OPTIONAL, one line each, and says so; the TL;DR
    // says the preview is built with placeholders for them. Never "please send these".
    const plan = (await mailFor(id)).at(-1)!;
    expect(plan).toMatch(/^\*\*TL;DR:\*\* Going ahead with these and started the build, with placeholders for the \*{0,2}2\*{0,2} missing items\. Reply \*\*changes: …\*\* to steer\. Nothing goes live until you approve the preview\./);
    expect(plan).toMatch(/\*\*Missing items \(optional\)\*\*\n• Ep \*{0,2}6\*{0,2} guest headshot \(JPG\)\n• Ep \*{0,2}7\*{0,2} guest headshot \(JPG\)\n• You don't need these to continue\. I'll use placeholders; add them to Drive or attach them to any reply and I'll rebuild\./);
    expect(plan).not.toMatch(/please send these/i);
    expect(plan).not.toContain(HOW_TO_SEND_MATERIALS);
    expect(JSON.parse((await readWebPropertyChange(env, id))!.assets_json)).toEqual(["Ep 1/headshot.jpg", "Brand/maax-bold.otf"]);
  });

  it("a files-only reply while BUILD is queued reaches that job: the queued payload is refreshed with the reply's file and the plan's assets (27 Sep 2026)", async () => {
    const parkedBefore = await payload();
    expect(parkedBefore.attachments.map((a) => a.filename), "parked at filing, before the file arrived").not.toContain("ep6-headshot.jpg");
    const files = await reply(id, "", { name: "ep6-headshot.jpg", type: "image/jpeg" });
    expect(files.attached).toEqual(["ep6-headshot.jpg"]);
    const next = await tickFor(id);
    // The plan was approved by the request, never by the files; the job is still the Mac's to claim.
    expect((await readWebPropertyChange(env, id))!.plan_approved_by).toMatch(/^request:/);
    expect(next.summary).toMatch(/BUILD is queued/);
    const job = await payload();
    expect(job.phase).toBe("BUILD");
    expect(job.attachments.map((a) => a.filename), "the reply's file reaches the next phase").toContain("ep6-headshot.jpg");
    expect(job.attachments.find((a) => a.filename === "ep6-headshot.jpg")!.path).toMatch(new RegExp(`^/api/work-cards/${id}/attachments/ratt_`));
    expect(job.plan!.assets).toEqual(["Ep 1/headshot.jpg", "Brand/maax-bold.otf"]);
    expect(job.drive.folder_id, "BUILD carries the folder so the Mac re-maps it").toBe("1AbCdEfGhIjKlMnOpQr");
  });

  it("after the rebuild the preview email names ONLY what is still missing", async () => {
    await macReports({ phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/400", pr_number: 400, check_state: "GREEN", proof: "validate green", missing_materials: [{ item: "Ep 7 guest headshot (JPG)", where: "the Ep 7 card on /podcast" }] });
    const before = (await mailFor(id)).length;
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const preview = (await mailFor(id)).slice(before).join("\n\n");
    expect(preview).toMatch(/^\*\*TL;DR:\*\* Preview ready, with \*{0,2}1\*{0,2} placeholder\. Reply with one of these:/);
    // What is still showing as a placeholder, and — separately — what this build filled in.
    expect(preview).toMatch(/\*\*Still missing \(optional\)\*\*\n• Ep \*{0,2}7\*{0,2} guest headshot \(JPG\)\n/);
    expect(preview).toMatch(/\*\*Filled in since the plan\*\*\n• Ep \*{0,2}6\*{0,2} guest headshot \(JPG\)\n/);
    expect(preview.split("**Still missing (optional)**")[1], "the Ep 6 headshot arrived by reply and is not named as missing again").not.toMatch(/Ep \*{0,2}6\*{0,2} guest headshot/);
    expect(JSON.parse((await readWebPropertyChange(env, id))!.placeholders_json)).toEqual(["Ep 7 guest headshot (JPG)"]);
  });
});
