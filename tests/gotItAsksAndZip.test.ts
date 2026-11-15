import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { QUESTIONS_LEAD, TAKEN_OVER_NEXT, gotItEmail, raiseUnacknowledgedMail, sendUnderstoodReplies, sentencesOf, understand, type SeatRead } from "../src/worker/services/partnerUnderstood";
import { TAKEN_OVER_PREFIX } from "../src/shared/work/takeover";
import { vi } from "vitest";
import { storeAttachments } from "../src/worker/services/requestMaterials";
import { unzipEntries } from "../src/worker/effects/zipEntries";
import { dryReadMessage } from "../src/worker/effects/inboundEmail";
import { parkRun } from "../src/worker/ai/subscriptionSeats";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { systemIdentity } from "../src/worker/services/dealIntake";

/**
 * THE GOT IT COUNTS WHAT HE ASKED, AND A ZIP IS ITS FILES (15 Nov 2026).
 *
 * The dry run of Scooter's dashboard email said "12 things you asked": a status remark ("… are in good shape") was an
 * ask, a wrapped line ("Attached is") was an ask, and his nine numbered changes were split mid-item. And his website
 * email's logo ZIP was filed as one opaque file. Pinned here, all synthetic:
 *   · a dashboard-shaped email (praise line, "Changes:", nine numbered changes with sub-bullets and wrapped lines, a
 *     clarify-first paragraph, an idea for later) reads as exactly nine asks plus ONE questions item, in his words,
 *     with no fragment, and no model is needed for it;
 *   · a ZIP's files are each filed on the card and named in the Got it, inflated by the platform, housekeeping skipped,
 *     the caps named;
 *   · the dry run builds the Got it through the live reader, and the model read's bookkeeping is gone afterwards.
 */

let t: TestDb;
let env: Env;
const store = new Map<string, Uint8Array>();

const DASHBOARD = [
  "Hey Porter!",
  "",
  "The Pipeline home and the new notification email are in good shape. Nice work on the",
  "layout.",
  "",
  "Changes:",
  "",
  "1. Keep this pipeline Productions-only. Filter out anything that came from the",
  "fund side.",
  "2. Rename \"New inquiries\" to \"Form submissions\".",
  "3. Start Discovery with a service picker:",
  "- Event production",
  "- Brand content",
  "- Livestream",
  "",
  "4. Rename \"Who is buying\" to \"Client\".",
  "5. Give me questions and space to type answers on each Discovery step.",
  "",
  "6. Carry the selected services into the Quote, one line each with its own price.",
  "7. Stop forcing per-day pricing across every service; let me choose flat or per day.",
  "8. When someone selects \"Virtual / livestream\", hide the venue fields.",
  "9. Remove \"Source\" from the deal card.",
  "",
  "Before building the remaining parts, let's clarify the difference between a Lead and a Deal. Is a Lead",
  "anything that came in, and a Deal only once we've sent a quote? Should a lost Deal go back to Leads?",
  "",
  "Transcript-assisted Discovery notes are an idea for later, not this build.",
].join("\n");

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function zipOf(files: Array<{ name: string; data: Buffer; stored?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.stored ? f.data : deflateRawSync(f.data);
    const method = f.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200_000, 1)]);
const COLORS = Buffer.from("orange #FF5A1F\nblack #000000\n".repeat(50));
const ASSETS_ZIP: Buffer = zipOf([
  { name: "logos/wp-productions.png", data: LOGO },
  { name: "brand/colors.txt", data: COLORS, stored: true },
  { name: "__MACOSX/logos/._wp-productions.png", data: Buffer.from("junk") },
  { name: "logos/", data: Buffer.alloc(0), stored: true },
]);

function mimeWithZip(words: string): string {
  const b = "zip-boundary";
  return [
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    "To: os@joinwestpeek.com",
    "Subject: Website items",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    words,
    "",
    `--${b}`,
    'Content-Type: application/zip; name="assets.zip"',
    'Content-Disposition: attachment; filename="assets.zip"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(ASSETS_ZIP).toString("base64").replace(/(.{76})/g, "$1\r\n"),
    `--${b}--`,
    "",
  ].join("\r\n");
}

const sent: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: {
      put: async (key: string, body: Uint8Array | ArrayBuffer | string) => { store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body)); return { key }; },
      get: async (key: string) => { const b = store.get(key); return b ? { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null; },
    } as never,
  } as Partial<Env>);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("the Got it counts what he asked, in his words", () => {
  it("a dashboard-shaped email is exactly its nine numbered changes plus one questions item: no praise, no fragment, whatever the reader says", async () => {
    let modelCalls = 0;
    const junk: SeatRead = async () => { modelCalls += 1; return { ok: true, text: "ASK: Attached is\nASK: in good shape", detail: "ok" }; };
    const out = await understand(env, { subject: "Re: Porter: dashboard", written: DASHBOARD, read: junk, employeeId: null, firmScope: "west-peek" });
    // Every email gets its first read (holds, files); a numbered email's asks still come from its structure, so a
    // reader that returns fragments and praise as asks changes nothing.
    expect(modelCalls, "the first read is asked once").toBe(1);
    expect(out.asks).toHaveLength(10);
    const nine = out.asks.slice(0, 9);
    expect(nine[0]).toBe("Keep this pipeline Productions-only. Filter out anything that came from the fund side.");
    expect(nine[2], "a numbered item keeps its sub-bullets, read as one sentence").toBe("Start Discovery with a service picker: Event production; Brand content; Livestream");
    expect(nine[8]).toBe('Remove "Source" from the deal card.');
    expect(out.asks[9]!.startsWith(QUESTIONS_LEAD), "his clarify-first questions are ONE item that says so").toBe(true);
    expect(out.asks[9]).toContain("Is a Lead anything that came in, and a Deal only once we've sent a quote? Should a lost Deal go back to Leads?");
    for (const a of out.asks) {
      expect(a.split(/\s+/).length, `no fragment: ${a}`).toBeGreaterThanOrEqual(3);
      expect(a, "no praise or status remark is an ask").not.toMatch(/good shape|Nice work/);
      // His words, unchanged: every ask (less the lead) is in what he wrote, once whitespace is collapsed.
      const words = a.startsWith(QUESTIONS_LEAD) ? a.slice(QUESTIONS_LEAD.length) : a;
      for (const piece of words.split(/; |: (?=Event)/)) expect(norm(DASHBOARD).includes(norm(piece)), `his words: ${piece}`).toBe(true);
    }
    expect(out.noted, "the idea for later is kept as noted, not asked").toEqual(["Transcript-assisted Discovery notes are an idea for later, not this build."]);
    const email = gotItEmail({ employee: "Porter", subject: "dashboard", asks: out.asks, next: out.next, unopened: [], noted: out.noted });
    expect(email.tldr).toMatch(/^Got it\. 10 things you asked/);
  });

  it("a list item's bullets then a new sentence read as one item, and a plain question is not called clarify-first", async () => {
    const text = ["1. Service categories, these six, in this order:", "- Content production", "- Web development", "Much less copy per box.", "2. Footer: keep the location line.", "", "What can you get done today? Tell me what's realistic."].join("\n");
    const out = await understand(env, { subject: "s", written: text, read: async () => ({ ok: false, text: "", detail: "" }), employeeId: null, firmScope: "west-peek" });
    expect(out.asks).toEqual([
      "Service categories, these six, in this order: Content production; Web development. Much less copy per box.",
      "Footer: keep the location line.",
      "Your questions: What can you get done today? Tell me what's realistic.",
    ]);
  });

  it("an unlisted email's sentences are whole: a wrapped line is never a fragment", () => {
    const asks = sentencesOf("Hey Porter!\n\nAttached is\nthe logo ZIP for the header. The site looks great.\n\nPlease swap the hero photo for the one in the ZIP.");
    expect(asks).toEqual(["Attached is the logo ZIP for the header.", "Please swap the hero photo for the one in the ZIP."]);
  });
});

describe("a ZIP is its files", () => {
  it("each file inside is inflated, filed on the card and named; housekeeping is skipped", async () => {
    const card = (await createWorkCardInternal(env, systemIdentity(), { title: "Porter: site zip", description: "x", owner_type: "AI", owner_id: "aie_porter", priority: "NORMAL", firm_scope: "west-peek", next_action: "x" })).id;
    const kept = await storeAttachments(env, { cardId: card, raw: mimeWithZip("Logos attached."), emlKey: "inbound-email/2026-11-15/zip.eml", firmScope: "west-peek", source: "REPLY" });
    expect(kept.stored).toEqual(["assets.zip", "assets.zip/logos/wp-productions.png", "assets.zip/brand/colors.txt"]);
    const rows = (await env.WP_OS_DB.prepare("SELECT filename, media_type, bytes, eml_key FROM request_attachment WHERE work_card_id = ?1 AND eml_key LIKE 'zip-file/%' ORDER BY filename").bind(card).all<{ filename: string; media_type: string; bytes: number; eml_key: string }>()).results!;
    expect(rows.map((r) => [r.filename, r.media_type, r.bytes])).toEqual([["assets.zip/brand/colors.txt", "text/plain", COLORS.length], ["assets.zip/logos/wp-productions.png", "image/png", LOGO.length]]);
    const logo = rows.find((r) => r.filename.endsWith(".png"))!;
    expect(Buffer.from(store.get(logo.eml_key)!).equals(LOGO), "the inflated bytes are the file, exactly").toBe(true);
    // A second read of the same message files nothing twice.
    await storeAttachments(env, { cardId: card, raw: mimeWithZip("Logos attached."), emlKey: "inbound-email/2026-11-15/zip.eml", firmScope: "west-peek", source: "REPLY" });
    expect(Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM request_attachment WHERE work_card_id = ?1").bind(card).first<{ n: number }>())!.n)).toBe(3);
    const email = gotItEmail({ employee: "Porter", subject: "site", asks: ["Use the logos."], next: "On it.", unopened: [], filed: kept.stored });
    expect(email.sections.find((s) => s.label === "Files on the card")!.bullets).toEqual(["assets.zip (2 files inside)"]);
    expect(email.details).toContain("**Inside assets.zip**\n• logos/wp-productions.png\n• brand/colors.txt");
  });

  it("past the caps, the files not taken are named with the reason", async () => {
    const read = await unzipEntries(new Uint8Array(ASSETS_ZIP), { maxFiles: 1 });
    expect(read.files.map((f) => f.name)).toEqual(["logos/wp-productions.png"]);
    expect(read.skipped).toEqual(["brand/colors.txt (only the first 1 files of an archive are taken)"]);
    expect((await unzipEntries(new Uint8Array([1, 2, 3]))).skipped[0]).toMatch(/could not be read/);
  });
});

describe("the dry run builds the Got it through the live reader, and leaves nothing behind", () => {
  it("the seat read's ai_run, seat run and scoreboard rows are removed; no business row changes", async () => {
    const tables = ["ai_run", "subscription_seat_run", "model_job_outcome", "ai_run_attribution", "ai_run_routing", "request_attachment", "work_steer", "inbound_email_seen", "notification", "partner_understood", "work_card"];
    const counts = async () => Promise.all(tables.map(async (tb) => Number((await env.WP_OS_DB.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).first<{ n: number }>())!.n)));
    const before = await counts();
    const objects = store.size;
    let runId = "";
    // What the real seat read writes on its way to her seat: its ai_run, its queued seat run, a scoreboard row.
    const seat: SeatRead = async (e) => {
      runId = `air_dry_${crypto.randomUUID()}`;
      await e.WP_OS_DB.prepare(
        "INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, status, input_hash, trace_id, firm_scope) VALUES (?1, 'the Got it reply', 'AI', 'aie_porter', 'INTERNAL', 'FRONTIER', 'NORMAL', 'COMPLETED', 'h', ?2, 'west-peek')",
      ).bind(runId, `tr_${runId}`).run();
      await parkRun(e, { seat: "claude_code" as never, purpose: "the Got it reply", prompt: "p", modelAccess: "PRIVATE_MODEL_ONLY", aiRunId: runId });
      await e.WP_OS_DB.prepare("INSERT INTO model_job_outcome (id, task_kind, provider_id, model, outcome, ai_run_id, firm_scope) VALUES (?1, 'judgement', 'claude_code', 'seat', 'SUCCEEDED', ?2, 'west-peek')").bind(`mjo_${runId}`, runId).run();
      return { ok: true, text: "ASK: please swap the hero photo for the one in the ZIP\nNEXT: On it.", detail: "ok", runId };
    };
    const out = await dryReadMessage(env, mimeWithZip("Logos attached; please swap the hero photo for the one in the ZIP and make the header taller."), { read: seat });
    expect(runId, "the live reader called her seat").not.toBe("");
    expect(out.asks_read_by).toBe("MODEL");
    expect(out.filed).toEqual(["assets.zip", "assets.zip/logos/wp-productions.png", "assets.zip/brand/colors.txt"]);
    expect(out.got_it!.sections[0]!.bullets).toEqual(['"please swap the hero photo for the one in the ZIP"']);
    expect(await counts(), "nothing left anywhere a sweep, alarm, scoreboard or usage report reads").toEqual(before);
    expect(store.size, "no stored object").toBe(objects);
  });
});

describe("a reply on a card a developer has taken over", () => {
  async function takenOverReply(label: string, receivedAt: string): Promise<{ cardId: string; inm: string }> {
    const card = await createWorkCardInternal(env, systemIdentity(), { title: `Porter: dashboard ${label}`, description: "x", owner_type: "AI", owner_id: "aie_porter", priority: "NORMAL", firm_scope: "west-peek", next_action: "x" });
    await env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), held_reason = ?2, requested_by_email = 'scooter@westpeek.ventures' WHERE id = ?1").bind(card.id, `${TAKEN_OVER_PREFIX} (Sequoia, 15 Nov).`).run();
    const key = `inbound-email/2026-11-15/takeover-${label}.eml`;
    store.set(key, new TextEncoder().encode(["From: Scooter Taylor <scooter@westpeek.ventures>", "Subject: Re: Porter: dashboard", "", DASHBOARD].join("\r\n")));
    const inm = `inm_takeover_${label}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope, work_card_id)
       VALUES (?1, ?2, ?3, 'Scooter Taylor <scooter@westpeek.ventures>', 'os@joinwestpeek.com', 'Re: Porter: dashboard', ?4, 100, ?5, 'west-peek', ?6)`,
    ).bind(inm, `takeover-${label}@mail.gmail.com`, key, receivedAt, JSON.stringify({ passed: true, partner: "scooter@westpeek.ventures" }), card.id).run();
    return { cardId: card.id, inm };
  }

  it("the Got it lists his asks but says honestly that nothing starts yet, and Sequoia's desk hears he replied", async () => {
    const { cardId } = await takenOverReply("honest", new Date().toISOString());
    const before = sent.length;
    // No reader is there (out), so the Got it comes from the OS's own read at once.
    await sendUnderstoodReplies(env, new Date(), async () => ({ ok: false, text: "", detail: "no reader", out: true }));
    const gotIt = sent.slice(before).filter((m) => m.to === "scooter@westpeek.ventures");
    expect(gotIt).toHaveLength(1);
    expect(gotIt[0]!.text).toContain(TAKEN_OVER_NEXT);
    expect(gotIt[0]!.text, "never a promise that work started").not.toMatch(/starting on it now/i);
    expect(gotIt[0]!.text).toContain("Rename");
    const desk = await env.WP_OS_DB.prepare("SELECT title, body FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND object_id = ?1").bind(cardId).all<{ title: string; body: string }>();
    expect(desk.results!.map((n) => n.title)).toEqual(["Scooter replied on a card a developer has taken over"]);
    expect(desk.results![0]!.body).toContain(cardId);
  });

  it("the five-minute no-Got-it alarm never fires for a reply on a taken-over card", async () => {
    const { inm } = await takenOverReply("quiet", new Date(Date.now() - 10 * 60_000).toISOString());
    await raiseUnacknowledgedMail(env, new Date());
    const alarm = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key = ?1").bind(`partner_email_no_got_it:${inm}`).first<{ n: number }>();
    expect(Number(alarm!.n)).toBe(0);
  });
});

describe("a long Got it keeps every ask and every file", () => {
  it("writes what the six-line cap hides under Details, so nothing promised there is missing", async () => {
    const { renderExecEmail, lintExecEmail } = await import("../src/shared/email/execEmail");
    const asks = "abcdefghij".split("").map((c) => `Ask ${c.repeat(3)} about the tracker.`);
    const filed = "abcdefghijklmnopqrstuvwx".split("").map((c) => `logo-${c.repeat(2)}.png`);
    const r = renderExecEmail(gotItEmail({ employee: "Porter", subject: "site", asks, next: "On it.", unopened: [], filed }));
    for (const line of [...asks, ...filed]) expect(r.text).toContain(line);
    expect(r.text).toContain("— Details —");
    expect(lintExecEmail(r.subject, r.text, "Porter")).toEqual([]);
    // A short one has no Details at all.
    const short = renderExecEmail(gotItEmail({ employee: "Porter", subject: "site", asks: ["One ask."], next: "On it.", unopened: [], filed: ["a.png"] }));
    expect(short.text).not.toContain("— Details —");
  });
});

describe("files on the Got it read as he sent them", () => {
  it("shows a ZIP as one line with its count, loose files first, and names what is inside only under Details", async () => {
    const { renderExecEmail } = await import("../src/shared/email/execEmail");
    const zip = "client logos.zip";
    const inside = "abcdefghijklmnopqrst".split("").map((c) => `${zip}/Logos/logo-${c.repeat(2)}.png`);
    const filed = [zip, ...inside, "mark.jpg", "headshot.png"];
    const r = renderExecEmail(gotItEmail({ employee: "Porter", subject: "site", asks: ["Use the logos."], next: "On it.", unopened: [], filed }));
    const [top, details] = r.text.split("— Details —");
    const files = top!.slice(top!.indexOf("**Files on the card**")).split("\n\n")[0]!.split("\n").slice(1);
    expect(files).toEqual(["• mark.jpg", "• headshot.png", `• ${zip} (**20** files inside)`]);
    expect(top).not.toContain("logo-aa.png");
    for (const f of inside) expect(details).toContain(f.slice(zip.length + 1));
  });

  it("names a voice note once, as heard, never also as a plain file", async () => {
    const { renderExecEmail } = await import("../src/shared/email/execEmail");
    const heard = "walkthrough.m4a: heard and transcribed (1059 words)";
    const r = renderExecEmail(gotItEmail({ employee: "Porter", subject: "site", asks: ["Rename it."], next: "On it.", unopened: [], filed: ["walkthrough.m4a"], noted: ["An idea for later.", heard] }));
    expect(r.text.split("walkthrough.m4a").length - 1).toBe(1);
    expect(r.text).toContain("• walkthrough.m4a: heard and transcribed (**1059** words)");
    expect(r.text).toContain('"An idea for later."');
  });
});
