import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { carriesSecretValue, scrubSecretValues } from "../src/worker/effects/mimeAttachments";
import { sendViaResend } from "../src/worker/effects/resendClient";
import { OUTBOUND_ATTACHMENTS_MAX_BYTES } from "../src/worker/effects/emailTransport";
import { loadRegistry, registerFromEmail, recordRepoFacts } from "../src/worker/services/webPropertyRegistry";
import { readSecretLines, secretNameProblem, RESERVED_SECRET_NAMES } from "../src/worker/services/secretHandoff";
import { outboundFilesFor } from "../src/worker/services/workCardFiles";
import { recordDnsWaits, recordProblem } from "../src/worker/services/dnsWaits";
import { missingSecretsOf, readWebPropertyChange } from "../src/worker/services/webPropertyChange";
import { WEB_PROPERTIES, githubReposIn, hostsSentence, registrationsIn } from "../src/shared/intake/webPropertyChange";
import { PORTER_WAITS, PORTER_WAIT_KINDS, WAIT_TEXT_FORBIDDEN, waitDetail } from "../src/shared/work/porterWaits";
import { dueTimeIn } from "../src/shared/intake/dueTime";
import { blockCard } from "../src/worker/services/blocks";

/**
 * THE THREE DOORS OF 0253 (owner, 6 Oct 2026), proven end to end:
 *   · an open repo registry — a partner's email registers a GitHub repo and the job proceeds; the
 *     seeded hosts cannot be re-pointed by email;
 *   · secrets by email — `SECRET NAME=value` is stored encrypted, scrubbed from EVERY sink (D1 text
 *     columns, the .eml in R2, every outbound email), collected only by the Mac's claimer;
 *   · files to the partner — attached under the 10 MB cap, listed always;
 * plus the waits template (three parts, email-only), the DNS record email, and the deadline reader.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; attachments: Array<{ filename: string; content: string }> }> = [];
const SCOOTER = "scooter@westpeek.ventures";
const CLAIMER = { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com" };
const AUTH = `mx.cloudflare.net; spf=pass smtp.mailfrom=${SCOOTER}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const VALUE = "tv_live_9f8e7d6c5b4a3b2c1d";
const KEY_B64 = Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256)).toString("base64");

function mime(subject: string, body: string, encoding: "7bit" | "base64" = "7bit"): string {
  const payload = encoding === "base64" ? Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n") : body;
  return [
    `From: Scooter Taylor <${SCOOTER}>`,
    "To: os@joinwestpeek.com",
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@mail.gmail.com>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    "",
    payload,
    "--b1--",
    "",
  ].join("\r\n");
}

async function inbound(raw: string): Promise<void> {
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from: `Scooter Taylor <${SCOOTER}>`, to: "os@joinwestpeek.com", subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? "", "message-id": /^Message-ID: (.*)$/m.exec(raw)?.[1] ?? "", "authentication-results": AUTH });
  await handleInboundEmail({ from: SCOOTER, to: "os@joinwestpeek.com", headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}

async function everyTextColumn(): Promise<string> {
  const tables = (await env.WP_OS_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>()).results ?? [];
  const chunks: string[] = [];
  for (const { name } of tables) {
    const rows = await env.WP_OS_DB.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    chunks.push(JSON.stringify(rows.results ?? []));
  }
  return chunks.join("\n");
}

async function everyEml(): Promise<string[]> {
  const listed = await env.WP_OS_DOCUMENTS!.list({ prefix: "inbound-email/" });
  const out: string[] = [];
  for (const o of listed.objects) out.push(await (await env.WP_OS_DOCUMENTS!.get(o.key))!.text());
  return out;
}

async function cardCount(): Promise<number> {
  return (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: t.docs,
    WP_OS_SECRET_HANDOFF_KEY: KEY_B64,
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; attachments?: Array<{ filename: string; content: string }> };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, attachments: body.attachments ?? [] });
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

describe("the open repo registry (0253)", () => {
  it("is seeded by the migration with every WEB_PROPERTIES row, host → repo verbatim, and the Worker reads the table", async () => {
    const rows = (await env.WP_OS_DB.prepare("SELECT host, repo, site, seeded FROM web_property_registry WHERE seeded = 1 ORDER BY position").all<{ host: string; repo: string; site: string; seeded: number }>()).results ?? [];
    expect(rows.length, "at least six seeded rows").toBeGreaterThanOrEqual(6);
    expect(rows.map((r) => [r.host, r.repo, r.site])).toEqual(WEB_PROPERTIES.map((p) => [p.host, p.repo, p.site]));
    const registry = await loadRegistry(env);
    expect(registry.slice(0, rows.length).map((p) => p.host)).toEqual(rows.map((r) => r.host));
    expect(hostsSentence(registry)).toContain("joinwestpeek.com");
  });

  it("a seeded host → repo binding is immutable at the row (the trigger) and from an email (the door keeps it)", async () => {
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_registry SET repo = 'somewhere-else' WHERE host = 'joinwestpeek.com'").run()).rejects.toThrow(/immutable/);
    await expect(env.WP_OS_DB.prepare("DELETE FROM web_property_registry WHERE host = 'joinwestpeek.com'").run()).rejects.toThrow(/never deleted/);
    const out = await registerFromEmail(env, { registrations: [{ repo: "evil-repo", github_repo: "seq23/evil-repo", host: "joinwestpeek.com" }], requestedBy: SCOOTER, firmScope: "west-peek" });
    expect(out.registered).toEqual(["seq23/evil-repo"]);
    expect(out.kept, "the seeded host was not re-pointed").toContain("joinwestpeek.com");
    const bound = await env.WP_OS_DB.prepare("SELECT repo FROM web_property_registry WHERE host = 'joinwestpeek.com'").first<{ repo: string }>();
    expect(bound!.repo).toBe("join-west-peek-main");
    expect((await env.WP_OS_DB.prepare("SELECT host FROM web_property_registry WHERE repo = 'evil-repo'").first<{ host: string | null }>())!.host, "the new row has no host until its config says").toBeNull();
    await env.WP_OS_DB.prepare("DELETE FROM web_property_registry WHERE repo = 'evil-repo'").run();
  });

  it("reads a GitHub repo out of an email, by link or by owner/name for a known owner, from the written part only", () => {
    expect(githubReposIn("please work on https://github.com/seq23/topbarz-voting today").map((r) => r.github_repo)).toEqual(["seq23/topbarz-voting"]);
    expect(githubReposIn("the repo seq23/topbarz-voting (and sites/community is a folder, not a repo)").map((r) => r.github_repo)).toEqual(["seq23/topbarz-voting"]);
    expect(githubReposIn("someone/else is not a known owner")).toEqual([]);
    const regs = registrationsIn("Work on seq23/topbarz-voting at https://voting.topbarz.xyz please\n\n> On Monday Scooter wrote: https://github.com/seq23/quoted-repo", WEB_PROPERTIES);
    expect(regs).toEqual([{ repo: "topbarz-voting", github_repo: "seq23/topbarz-voting", host: "voting.topbarz.xyz" }]);
  });

  it("a partner's email naming a new repo REGISTERS it at the door and the job proceeds — never 'not a West Peek property'", async () => {
    const before = await cardCount();
    const sentBefore = sent.length;
    await inbound(mime("Top Barz voting site", "Hey Porter — please work on the voting site repo seq23/topbarz-voting (https://voting.topbarz.xyz): rename Beat 3 to Beat C and export the booth log to a CSV for me. Live by Monday morning please."));
    const row = await env.WP_OS_DB.prepare("SELECT * FROM web_property_registry WHERE repo = 'topbarz-voting'").first<{ host: string; github_repo: string; requested_by: string; seeded: number }>();
    expect(row, "the repo is registered").not.toBeNull();
    expect(row!.host).toBe("voting.topbarz.xyz");
    expect(row!.github_repo).toBe("seq23/topbarz-voting");
    expect(row!.requested_by).toBe(SCOOTER);
    expect(row!.seeded).toBe(0);
    const job = await env.WP_OS_DB.prepare("SELECT w.target_repo, w.property_host, c.priority, c.request_json FROM web_property_change w JOIN work_card c ON c.id = w.work_card_id WHERE w.target_repo = 'topbarz-voting'").first<{ target_repo: string; property_host: string; priority: string; request_json: string }>();
    expect(job, "a Porter job was opened for the new repo").not.toBeNull();
    expect(job!.property_host).toBe("voting.topbarz.xyz");
    expect(job!.priority, "'Live by Monday morning' set the priority").toMatch(/HIGH|URGENT/);
    expect(JSON.parse(job!.request_json).due.due_words).toMatch(/by Monday morning/i);
    expect(await cardCount()).toBeGreaterThan(before);
    const received = sent.slice(sentBefore).find((m) => m.to === SCOOTER && m.text.includes("Registered seq23/topbarz-voting"));
    expect(received, `RECEIVED went to Scooter and says the repo was registered (got: ${sent.slice(sentBefore).map((m) => m.subject).join(" | ")})`).toBeDefined();
    expect(received!.text).toContain("it is cloned on the Mac if it is not there yet");
    expect(hostsSentence(await loadRegistry(env))).toContain("voting.topbarz.xyz");
  });

  it("the duty's facts fill the row — secret NAMES and the partner's constraints — and a seeded row keeps its host", async () => {
    await recordRepoFacts(env, "topbarz-voting", { pagesHost: "topbarz-voting.pages.dev", secretNames: ["RESEND_API_KEY", "GIPHY_API_KEY"], constraints: ["Scooter's own track is never in the vote.", "Test data is preview-only."] });
    const row = await env.WP_OS_DB.prepare("SELECT secret_names_json, constraints_json, pages_host FROM web_property_registry WHERE repo = 'topbarz-voting'").first<{ secret_names_json: string; constraints_json: string; pages_host: string }>();
    expect(JSON.parse(row!.secret_names_json)).toEqual(["GIPHY_API_KEY", "RESEND_API_KEY"]);
    expect(JSON.parse(row!.constraints_json)).toHaveLength(2);
    expect(row!.pages_host).toBe("topbarz-voting.pages.dev");
    await recordRepoFacts(env, "join-west-peek-main", { host: "attacker.example" });
    expect((await env.WP_OS_DB.prepare("SELECT host FROM web_property_registry WHERE repo = 'join-west-peek-main' ORDER BY position LIMIT 1").first<{ host: string }>())!.host).toBe("westpeek.ventures");
    const api = await handleRequest(new Request("https://test.local/api/web-properties", { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    expect(api.status).toBe(200);
    expect(((await api.json()) as { properties: Array<{ repo: string }> }).properties.map((p) => p.repo)).toContain("topbarz-voting");
  });
});

describe("secrets by email (0253)", () => {
  it("names are validated: vendor-prefixed, never a reserved name or prefix", () => {
    expect(secretNameProblem("GIPHY_API_KEY")).toBeNull();
    expect(secretNameProblem("ANTHROPIC_API_KEY")).toMatch(/reserved/);
    expect(secretNameProblem("ANTHROPIC_BASE_URL")).toMatch(/reserved/);
    expect(secretNameProblem("PATH")).toMatch(/reserved/);
    expect(secretNameProblem("LD_PRELOAD")).toMatch(/reserved/);
    expect(secretNameProblem("CLAUDE_CODE_OAUTH_TOKEN")).toMatch(/reserved prefix/);
    expect(secretNameProblem("TOKEN")).toMatch(/vendor prefix/);
    expect(secretNameProblem("lowercase_key")).toMatch(/SCREAMING/);
    for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "PATH", "LD_PRELOAD"]) expect(RESERVED_SECRET_NAMES.has(n)).toBe(true);
    const read = readSecretLines("Hey Porter\nSECRET GIPHY_API_KEY=abc123def\nSECRET PATH=/evil\nthanks");
    expect(read.found).toEqual([{ name: "GIPHY_API_KEY", value: "abc123def" }]);
    expect(read.refused.map((r) => r.name)).toEqual(["PATH"]);
    expect(read.scrubbed).toContain("SECRET GIPHY_API_KEY=[secret redacted]");
    expect(read.scrubbed).not.toContain("abc123def");
    expect(read.values, "refused values are scrubbed too").toContain("/evil");
  });

  it("a MIME scrub removes the value from a 7bit body, a base64 body and the headers, and keeps the message readable", () => {
    const b64 = mime("keys", `SECRET TEST_VENDOR_KEY=${VALUE}\n`, "base64");
    expect(carriesSecretValue(b64, [VALUE]), "the base64 part decodes to the value").toBe(true);
    const clean = scrubSecretValues(b64, [VALUE]);
    expect(carriesSecretValue(clean, [VALUE])).toBe(false);
    expect(clean).toContain("[secret redacted]");
    expect(clean).toContain("X-WP-OS-Scrubbed");
    const plain = scrubSecretValues(mime(`about ${VALUE}`, `SECRET TEST_VENDOR_KEY=${VALUE}`), [VALUE]);
    expect(plain).not.toContain(VALUE);
  });

  it("an authenticated partner's SECRET line is stored ENCRYPTED, opens no card, is scrubbed from EVERY sink, and the partner hears 'Stored'", async () => {
    const before = await cardCount();
    const sentBefore = sent.length;
    await inbound(mime("keys for topbarz-voting", `Hey Porter\nSECRET TEST_VENDOR_KEY=${VALUE}\nthanks`, "base64"));
    expect(await cardCount(), "nothing but secrets opens no card").toBe(before);
    const row = await env.WP_OS_DB.prepare("SELECT * FROM secret_handoff WHERE name = 'TEST_VENDOR_KEY'").first<{ ciphertext: string; iv: string; repo: string | null; requested_by: string; expires_at: string }>();
    expect(row, "the hand-off row exists").not.toBeNull();
    expect(row!.ciphertext).not.toContain(VALUE);
    expect(row!.repo).toBe("topbarz-voting");
    expect(row!.requested_by).toBe(SCOOTER);
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.now());
    // EVERY SINK: every text column of every table, every .eml in R2, every outbound email.
    expect(await everyTextColumn(), "no D1 text column carries the value").not.toContain(VALUE);
    const emls = await everyEml();
    expect(emls.length).toBeGreaterThan(0);
    for (const e of emls) expect(carriesSecretValue(e, [VALUE]), "the stored .eml is scrubbed, decoded parts included").toBe(false);
    expect(emls.some((e) => e.includes("[secret redacted]"))).toBe(true);
    const after = sent.slice(sentBefore);
    expect(after.length, "the partner heard once").toBe(1);
    expect(after[0]!.to).toBe(SCOOTER);
    expect(after[0]!.subject).toMatch(/stored TEST_VENDOR_KEY for topbarz-voting/);
    expect(after[0]!.text).toMatch(/Stored TEST_VENDOR_KEY for topbarz-voting; it is never shown again/);
    for (const m of after) expect(m.text).not.toContain(VALUE);
  });

  it("a reserved name is refused by name, nothing is stored, the value is still scrubbed, and the partner is told", async () => {
    const sentBefore = sent.length;
    const evil = "sk-ant-evil-0000000000";
    await inbound(mime("a key", `SECRET ANTHROPIC_API_KEY=${evil}`));
    expect(await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM secret_handoff WHERE name = 'ANTHROPIC_API_KEY'").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await everyTextColumn()).not.toContain(evil);
    for (const e of await everyEml()) expect(carriesSecretValue(e, [evil])).toBe(false);
    const reply = sent.slice(sentBefore).find((m) => m.to === SCOOTER);
    expect(reply!.text).toMatch(/ANTHROPIC_API_KEY: ANTHROPIC_API_KEY is reserved/);
    expect(reply!.text).not.toContain(evil);
  });

  it("only the Mac's claimer collects a pending hand-off, decrypted once per call, and the Worker forgets it on 'stored'", async () => {
    const asPartner = await handleRequest(new Request("https://test.local/api/secret-handoffs/pending", { method: "POST", headers: { "x-wpos-dev-user": SCOOTER, "content-type": "application/json" }, body: "{}" }), env);
    expect(asPartner.status).toBe(403);
    const pending = await handleRequest(new Request("https://test.local/api/secret-handoffs/pending", { method: "POST", headers: { ...CLAIMER, "content-type": "application/json" }, body: "{}" }), env);
    expect(pending.status).toBe(200);
    const body = (await pending.json()) as { handoffs: Array<{ id: string; name: string; repo: string | null; value: string }> };
    const mine = body.handoffs.find((h) => h.name === "TEST_VENDOR_KEY")!;
    expect(mine.value, "the claimer gets the plaintext — the only place it exists").toBe(VALUE);
    expect(mine.repo).toBe("topbarz-voting");
    const stored = await handleRequest(new Request("https://test.local/api/secret-handoffs/stored", { method: "POST", headers: { ...CLAIMER, "content-type": "application/json" }, body: JSON.stringify({ id: mine.id }) }), env);
    expect(stored.status).toBe(200);
    expect(await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM secret_handoff WHERE id = ?1").bind(mine.id).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await everyTextColumn(), "the event spine names it, never carries it").not.toContain(VALUE);
  });

  it("an arriving key RESUMES the open job that waited for it — no second ask, no new card (owner, 6 Oct 2026)", async () => {
    const job = await env.WP_OS_DB.prepare("SELECT work_card_id FROM web_property_change WHERE target_repo = 'topbarz-voting' LIMIT 1").first<{ work_card_id: string }>();
    const id = job!.work_card_id;
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET missing_secrets_json = ?2 WHERE work_card_id = ?1").bind(id, JSON.stringify([{ name: "GIPHY_API_KEY", vendor_url: "https://developers.giphy.com/dashboard/", searched: ["GIPHY_API_KEY", "GIPHY_*"] }])).run();
    const c = (await env.WP_OS_DB.prepare("SELECT id, title, firm_scope, requested_by_email FROM work_card WHERE id = ?1").bind(id).first<{ id: string; title: string; firm_scope: string; requested_by_email: string }>())!;
    await blockCard(env, c as never, { reason: "a_question_for_you", trying: c.title, employee: "Porter", who: "SCOOTER", detail: waitDetail("MISSING_SECRET", { what: "GIPHY_API_KEY" }) });
    await env.WP_OS_DB.prepare("UPDATE work_card SET work_attempts = 3 WHERE id = ?1").bind(id).run();
    const before = await cardCount();
    await inbound(mime("giphy key", "Porter,\nSECRET GIPHY_API_KEY=gphy_live_1234567890abcdef\n"));
    expect(await cardCount(), "no new card").toBe(before);
    const card = await env.WP_OS_DB.prepare("SELECT state, block_answer, work_attempts FROM work_card WHERE id = ?1").bind(id).first<{ state: string; block_answer: string; work_attempts: number }>();
    expect(card!.state).toBe("OPEN");
    expect(card!.work_attempts).toBe(0);
    expect(card!.block_answer).toMatch(/^changes: the key GIPHY_API_KEY has arrived/);
    const row = (await readWebPropertyChange(env, id))!;
    expect(missingSecretsOf(row)).toEqual([]);
    expect(row.refresh_intent).toBe("CHANGES");
    expect(await everyTextColumn()).not.toContain("gphy_live_1234567890abcdef");
  });
});

describe("files to the partner (0253)", () => {
  let cardId = "";
  it("the claimer puts a file on the card; the DONE email attaches it under the cap and lists it by name", async () => {
    cardId = (await env.WP_OS_DB.prepare("SELECT work_card_id FROM web_property_change WHERE target_repo = 'topbarz-voting' LIMIT 1").first<{ work_card_id: string }>())!.work_card_id;
    const csv = "track,votes\nBeat C,12\n";
    const put = await handleRequest(new Request(`https://test.local/api/work-cards/${cardId}/files`, { method: "POST", headers: { ...CLAIMER, "content-type": "text/csv", "x-wp-filename": "booth-log.csv" }, body: csv }), env);
    expect(put.status).toBe(200);
    const asPartner = await handleRequest(new Request(`https://test.local/api/work-cards/${cardId}/files`, { method: "POST", headers: { "x-wpos-dev-user": SCOOTER, "content-type": "text/csv", "x-wp-filename": "x.csv" }, body: "a" }), env);
    expect(asPartner.status, "only the claimer puts files").toBe(403);
    const big = await handleRequest(new Request(`https://test.local/api/work-cards/${cardId}/files`, { method: "POST", headers: { ...CLAIMER, "content-type": "application/json", "x-wp-filename": "video.mp4", "x-wp-drive": "1" }, body: JSON.stringify({ drive_url: "https://drive.google.com/file/d/abc123/view", bytes: 40_000_000 }) }), env);
    expect(big.status).toBe(200);
    const out = await outboundFilesFor(env, cardId);
    expect(out.attachments.map((a) => a.filename)).toEqual(["booth-log.csv"]);
    expect(Buffer.from(out.attachments[0]!.content, "base64").toString("utf8")).toBe(csv);
    expect(out.section!.bullets).toEqual([expect.stringMatching(/^booth-log\.csv \(1 KB\) — attached$/), expect.stringMatching(/^video\.mp4 \(38\.1 MB\) — shared from Drive: https:\/\/drive\.google\.com/)]);
    const list = await handleRequest(new Request(`https://test.local/api/work-cards/${cardId}/files`, { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    expect(((await list.json()) as { files: Array<{ filename: string }> }).files.map((f) => f.filename)).toEqual(["booth-log.csv", "video.mp4"]);
  });

  it("the transport carries attachments to Resend and refuses a set over the 10 MB cap", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "re_x" }), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await sendViaResend(env, { to: SCOOTER, subject: "Porter: done", text: "TL;DR: done", attachments: [{ filename: "a.csv", content: Buffer.from("x,y").toString("base64"), contentType: "text/csv" }] }, fetchImpl);
    expect(ok.sent).toBe(true);
    expect((calls[0] as { attachments: Array<{ filename: string; content_type: string }> }).attachments).toEqual([{ filename: "a.csv", content: Buffer.from("x,y").toString("base64"), content_type: "text/csv" }]);
    const huge = Buffer.alloc(OUTBOUND_ATTACHMENTS_MAX_BYTES + 1024).toString("base64");
    await expect(sendViaResend(env, { to: SCOOTER, subject: "Porter: done", text: "TL;DR: done", attachments: [{ filename: "huge.bin", content: huge }] }, fetchImpl)).rejects.toThrow(/over the 10485760-byte cap/);
  });
});

describe("every wait Porter puts in front of a partner has three parts and clears by email (owner, 6 Oct 2026)", () => {
  it("every kind renders waiting / why / clear, and the clearing line never sends anyone into the OS", () => {
    expect(PORTER_WAIT_KINDS.length).toBeGreaterThanOrEqual(10);
    for (const kind of PORTER_WAIT_KINDS) {
      const w = PORTER_WAITS[kind]({ what: "x", why: "the reason, in a sentence", hosts: "a.com or b.com", searched: "A_KEY, A_*", at: "noon", record: { host: "voting.topbarz.xyz", type: "CNAME", name: "voting", target: "topbarz-voting.pages.dev", liveAt: "https://topbarz-voting.pages.dev" } });
      expect(w.waiting.trim().length, `${kind} waiting`).toBeGreaterThan(3);
      expect(w.why.trim().length, `${kind} why`).toBeGreaterThan(10);
      expect(w.clear.trim().length, `${kind} clear`).toBeGreaterThan(10);
      expect(w.clear, `${kind} clears by email or by itself`).toMatch(/\breply\b|\bemail\b|^nothing/i);
      const text = waitDetail(kind, { what: "x" });
      expect(text).toMatch(/^Waiting on: .+\. Why: .+\. To clear it by email: .+\.$/s);
      for (const re of WAIT_TEXT_FORBIDDEN) expect(text, `${kind} must not say ${re}`).not.toMatch(re);
    }
    expect(waitDetail("MISSING_SECRET", { what: "GIPHY_API_KEY", searched: "GIPHY_API_KEY, GIPHY_*" })).toContain('email "SECRET GIPHY_API_KEY=<value>" to os@joinwestpeek.com');
    expect(waitDetail("MAC_ASLEEP", { why: "due Mon 6 Oct, 9:00 AM CT" })).toContain("this job is due Mon 6 Oct");
  });
});

describe("a host outside her Cloudflare zones (0253)", () => {
  it("the record Cloudflare asked for is emailed with type, name and target; a placeholder is refused; 'active' emails live and closes", async () => {
    expect(recordProblem({ host: "voting.topbarz.xyz", record_type: "CNAME", record_name: "voting", record_target: "topbarz-voting.pages.dev" })).toBeNull();
    expect(recordProblem({ host: "voting.topbarz.xyz", record_type: "CNAME", record_name: "voting", record_target: "${project}.pages.dev" })).toMatch(/placeholder/);
    expect(recordProblem({ host: "voting.topbarz.xyz", record_type: "CNAME", record_name: "", record_target: "x.pages.dev" })).toMatch(/no name/);
    const sentBefore = sent.length;
    const told = await recordDnsWaits(env, {
      cardId: null,
      repo: "topbarz-voting",
      requestedBy: SCOOTER,
      firmScope: "west-peek",
      records: [
        { host: "voting.topbarz.xyz", project: "topbarz-voting", record_type: "CNAME", record_name: "voting", record_target: "topbarz-voting.pages.dev", status: "pending", on_zone: false },
        { host: "bad.topbarz.xyz", project: "topbarz-voting", record_type: "CNAME", record_name: "bad", record_target: "<target>", status: "pending", on_zone: false },
        { host: "pitch.joinwestpeek.com", project: "west-peek-pitch-lab", record_type: "CNAME", record_name: "pitch", record_target: "west-peek-pitch-lab.pages.dev", status: "active", on_zone: true },
      ],
    });
    expect(told).toEqual(["voting.topbarz.xyz"]);
    const mail = sent.slice(sentBefore);
    expect(mail.length, "one email: the real record; the placeholder refused; the zone host silent").toBe(1);
    expect(mail[0]!.text).toContain("To put the site on voting.topbarz.xyz: at your DNS provider add CNAME voting → topbarz-voting.pages.dev. Until then it is live at https://topbarz-voting.pages.dev.");
    expect(mail[0]!.text).toMatch(/Waiting on: a DNS record at your registrar for voting\.topbarz\.xyz/);
    expect(mail[0]!.text).toMatch(/To clear it by email: nothing to email — at your DNS provider add CNAME voting → topbarz-voting\.pages\.dev/);
    const row = await env.WP_OS_DB.prepare("SELECT id, emailed_at FROM web_property_dns WHERE host = 'voting.topbarz.xyz'").first<{ id: string; emailed_at: string | null }>();
    expect(row!.emailed_at).not.toBeNull();
    const pending = await handleRequest(new Request("https://test.local/api/dns-waits/pending", { method: "POST", headers: { ...CLAIMER, "content-type": "application/json" }, body: "{}" }), env);
    expect(((await pending.json()) as { waits: Array<{ host: string }> }).waits.map((w) => w.host), "not due again for 15 minutes").not.toContain("voting.topbarz.xyz");
    await env.WP_OS_DB.prepare("UPDATE web_property_dns SET last_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(row!.id).run();
    const due = await handleRequest(new Request("https://test.local/api/dns-waits/pending", { method: "POST", headers: { ...CLAIMER, "content-type": "application/json" }, body: "{}" }), env);
    expect(((await due.json()) as { waits: Array<{ host: string }> }).waits.map((w) => w.host)).toContain("voting.topbarz.xyz");
    const live = await handleRequest(new Request("https://test.local/api/dns-waits/status", { method: "POST", headers: { ...CLAIMER, "content-type": "application/json" }, body: JSON.stringify({ id: row!.id, status: "active" }) }), env);
    expect(((await live.json()) as { did: string }).did).toBe("live");
    expect(sent.at(-1)!.text).toContain("voting.topbarz.xyz is live: https://voting.topbarz.xyz now serves the site");
    expect((await env.WP_OS_DB.prepare("SELECT active_at FROM web_property_dns WHERE id = ?1").bind(row!.id).first<{ active_at: string | null }>())!.active_at).not.toBeNull();
  });
});

describe("a deadline in the partner's words (0253, addendum 3)", () => {
  it("reads 'by Monday morning', 'today', 'before doors' and 'as soon as you can' against the arrival time, in Chicago", () => {
    const wed = new Date("2026-10-07T15:00:00.000Z"); // Wed 10:00 CT
    const monday = dueTimeIn("Live by Monday morning please", wed)!;
    expect(monday.priority).toBe("HIGH");
    expect(monday.due_words).toMatch(/by Monday morning/);
    expect(monday.due_at).toBe("2026-10-12T14:00:00.000Z"); // Mon 09:00 CDT
    expect(dueTimeIn("need this today", wed)!.priority).toBe("URGENT");
    expect(dueTimeIn("before doors tonight", wed)!.due_at).toBe("2026-10-07T22:00:00.000Z");
    expect(dueTimeIn("as soon as you can", wed)!.priority).toBe("URGENT");
    expect(dueTimeIn("by Friday 5pm", wed)!.due_at).toBe("2026-10-09T22:00:00.000Z");
    expect(dueTimeIn("no rush, whenever", wed)).toBeNull();
  });
});
