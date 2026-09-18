import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { PREVIEW_WRITABLE_TABLES, previewDb, previewEnv, runPreview, PreviewError } from "../src/worker/services/preview";
import { executeExternalEffect } from "../src/worker/effects/executor";
import { applyPreviewBoundary, isPreviewEnv } from "../src/worker/effects/emailTransport";
import { runHireSearchCard } from "../src/worker/services/productionsHire";
import { PREVIEW_RECIPIENT } from "../src/shared/work/preview";
import type { PreviewContext } from "../src/shared/work/preview";
import type { SweepCard } from "../src/worker/services/workSweep";

/**
 * PREVIEW MODE, PROVEN OFFLINE (17 Sep 2026).
 *
 * The property that has to be structural is the negative one — a preview reaches NOBODY but Sequoia
 * — so most of this file is written as an attempt to get something out of the building. What must
 * be true:
 *
 *   · THE REAL WORK RUNS. The same runner the sweep calls, the same rendering, the same note.
 *   · THE RECIPIENT IS REPLACED, not filtered: whatever the work addressed, exactly one address
 *     receives it, with a header naming whose preview it is and who it was for.
 *   · NOTHING ELSE LEAVES. No request to any other host; the external-effect path — the one that can
 *     reach a founder or an LP — refuses outright and consumes no approval receipt.
 *   · IT DOES NOT CONSUME THE REAL RUN. No card closed, no candidate remembered, no deliverable
 *     filed, no notice raised.
 *   · IT STILL COSTS. The AI accounting tables are writable, deliberately.
 *   · AND THE NEGATIVE PROOF: with preview off, the very same run emails Scooter and writes it all.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const NOW = new Date("2026-09-17T15:00:00.000Z");

const searchJson = JSON.stringify({
  results: [
    {
      name: "Jordan Example",
      title: "Senior Experiential Producer (freelance)",
      company: "Independent",
      city: "Brooklyn, NY",
      profile_url: "https://www.linkedin.com/in/jordan-example/",
      evidence_url: "https://agency.example/team/jordan",
      why: "Team page lists 12 brand activations produced end to end.\nBio says freelance since 2023 and names two sponsorship deals closed.",
      opening_line: "Your Nike House of Innovation build is the kind of thing we want more of.",
      fit: 9,
    },
  ],
});

const judge = async () => ({
  ok: true,
  text: JSON.stringify({ verdicts: [{ name: "Jordan Example", keep: true, fit: 9, reason: "freelance, sells sponsorship" }] }),
  detail: "ok",
});

const statusOf = async (url: string) => (url.includes("linkedin.com") ? 999 : 200);

/** The real runner, with the two model calls and the liveness check injected. */
const hireRunner = (e: Env, card: SweepCard) =>
  runHireSearchCard(e, card, {
    search: async () => ({ ok: true, text: searchJson, detail: "ok" }),
    judge,
    urlStatus: statusOf,
    now: NOW,
  });

function mailEnv(base: Env): Env {
  return { ...base, RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
}

interface Sent {
  url: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

/** Every request that left, and every message with it. Anything unexpected throws by design. */
function captureFetch(sent: Sent[], other: string[]): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
      sent.push({ url: u, ...body });
      return new Response(JSON.stringify({ id: "re_preview" }), { status: 200 });
    }
    other.push(u);
    return new Response("", { status: 200 });
  });
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the send boundary", () => {
  it("replaces the recipient list — it does not filter it — for every shape of address", () => {
    const ctx: PreviewContext = {
      id: "prv_1",
      requestedBy: "fu_sequoia_taylor",
      requestedByEmail: "sequoia@westpeek.ventures",
      target: { kind: "JOB", key: "productions_hire_search" },
      what: "Walker's weekly hire search",
      startedAt: NOW.toISOString(),
    };
    const { env: previewed } = previewEnv(env, ctx);
    expect(isPreviewEnv(previewed)).toBe(true);
    expect(isPreviewEnv(env), "the real env is never mutated").toBe(false);

    /*
     * THE ADVERSARIAL CASE. A preview of something addressed to a founder, a journalist and an LP at
     * once must reach none of them. Not "be refused" — REDIRECTED, so she still sees what they would
     * have got. There is no input for which this returns anybody but Sequoia.
     */
    for (const to of [
      "scooter@westpeek.ventures",
      "founder@somestartup.example",
      ["founder@somestartup.example", "reporter@paper.example", "lp@family-office.example"],
      [],
    ] as Array<string | string[]>) {
      const out = applyPreviewBoundary(previewed, { to, subject: "Walker: hire search", text: "the note" });
      expect(out.to, `addressed to ${JSON.stringify(to)}`).toEqual([PREVIEW_RECIPIENT]);
      expect(out.subject).toBe("[PREVIEW] Walker: hire search");
    }

    const headed = applyPreviewBoundary(previewed, {
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search",
      text: "the note",
    });
    expect(headed.text).toMatch(/PREVIEW — this is not a live send\. Requested by sequoia@westpeek\.ventures\./);
    expect(headed.text, "names who would normally receive it, by name").toMatch(/Normally goes to: Scooter Taylor/);
    expect(headed.text, "says it cost real money, where she reads it").toMatch(/counts against the firm's caps/);
    expect(headed.text).toMatch(/scheduled run still has all its work to do/);
    expect(headed.text.endsWith("the note")).toBe(true);

    // Outside preview the payload is returned untouched — the boundary is inert on a live send.
    const live = applyPreviewBoundary(env, { to: "scooter@westpeek.ventures", subject: "Walker: hire search", text: "the note" });
    expect(live.to).toBe("scooter@westpeek.ventures");
    expect(live.subject).toBe("Walker: hire search");
  });

  it("blocks every write except the accounting tables, and records what it blocked", async () => {
    const state = { suppressed: [] as Array<{ table: string; verb: string }> };
    const db = previewDb(env.WP_OS_DB, state);

    // A read is real.
    const read = await db.prepare("SELECT id FROM firm_user WHERE id = 'fu_scooter_taylor'").first<{ id: string }>();
    expect(read?.id).toBe("fu_scooter_taylor");

    // A write to a table that is not on the list does nothing at all.
    await db.prepare("INSERT INTO productions_candidate (id, url, name, title, company, city, why, opening_line, fit_score, first_seen, last_seen, week, firm_scope) VALUES ('pcd_x','https://x.example','X','t','c','ct','w','o',5,'2026-09-17','2026-09-17','2026-W38','west-peek')").bind().run();
    await db.prepare("UPDATE work_card SET state = 'DONE' WHERE id = 'anything'").run();
    const leaked = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM productions_candidate WHERE id = 'pcd_x'").first<{ n: number }>();
    expect(leaked!.n, "the suppressed insert reached the database").toBe(0);
    expect(state.suppressed).toEqual([
      { table: "productions_candidate", verb: "insert" },
      { table: "work_card", verb: "update" },
    ]);

    /*
     * AND THE DELIBERATE EXCEPTION. A preview is a real run: the money is real, so the accounting is
     * real. This is the one family of writes that must go through, and it is asserted rather than
     * assumed — an exemption nobody checks is an exemption that silently becomes a block.
     */
    expect(PREVIEW_WRITABLE_TABLES).toContain("ai_run");
    await db.prepare(
      "INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, status, cost_estimate_json, input_hash, trace_id, firm_scope) VALUES ('air_prev','preview','SYSTEM','test','PUBLIC','LOCAL','NORMAL','COMPLETED','{}','h','t','west-peek')",
    ).run();
    const counted = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM ai_run WHERE id = 'air_prev'").first<{ n: number }>();
    expect(counted!.n, "a preview's model spend is recorded like any other").toBe(1);
    await env.WP_OS_DB.prepare("DELETE FROM ai_run WHERE id = 'air_prev'").run();
  });
});

describe("a preview of Monday's hire search", () => {
  it("does the real work, reaches ONLY Sequoia, touches nothing on Scooter's desk — and nothing else leaves the building", async () => {
    const withMail = mailEnv(env);
    const sent: Sent[] = [];
    const other: string[] = [];
    captureFetch(sent, other);

    const out = await runPreview(
      withMail,
      { id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures" },
      { kind: "JOB", key: "productions_hire_search" },
      NOW,
      { productionsHire: hireRunner },
    );
    vi.unstubAllGlobals();

    expect(out.finished, out.detail).toBe(true);
    expect(out.sentTo).toBe("sequoia@westpeek.ventures");

    // ── ONE message, to ONE address, and that address is hers ────────────────────────────────
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["sequoia@westpeek.ventures"]);
    expect(sent[0]!.to, "Scooter must not receive a rehearsal of his own note").not.toContain("scooter@westpeek.ventures");
    expect(sent[0]!.subject).toMatch(/^\[PREVIEW\] Walker: hire search/);
    expect(sent[0]!.text).toMatch(/Normally goes to: Scooter Taylor/);
    expect(sent[0]!.text).toMatch(/counts against the firm's caps/);
    // THE REAL WORK: the actual note, the actual candidate, the actual page that answered.
    expect(sent[0]!.text).toMatch(/Jordan Example/);
    expect(sent[0]!.text).toMatch(/refused an automated read/);
    expect(sent[0]!.text).toMatch(/Just hit reply if you want to steer me/);

    // ── NOTHING ELSE LEFT ────────────────────────────────────────────────────────────────────
    expect(other, "a preview made a request to a host that is not the mail transport").toEqual([]);

    // ── NOTHING ON SCOOTER'S DESK MOVED ──────────────────────────────────────────────────────
    const candidates = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM productions_candidate").first<{ n: number }>();
    expect(candidates!.n, "a preview must not leave Monday's dedupe already spent").toBe(0);
    const cards = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'PRODUCTIONS_HIRE_SEARCH'").first<{ n: number }>();
    expect(cards!.n, "no card was opened, so Monday's card is still Monday's to open").toBe(0);
    const deliverables = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deliverable WHERE kind = 'productions_hire_search'").first<{ n: number }>();
    expect(deliverables!.n, "nothing was filed on his Home").toBe(0);
    // Seeded notices from migrations exist; what must not exist is one ABOUT this work.
    const notices = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'productions_hire%' OR object_type = 'deliverable'",
    ).first<{ n: number }>();
    expect(notices!.n, "he was not rung about a rehearsal").toBe(0);

    // What it would have written is reported rather than merely not done.
    const blocked = new Set(out.suppressed.map((s) => s.table));
    for (const table of ["work_card", "deliverable", "notification", "event_record", "productions_candidate", "email_thread"]) {
      expect(blocked, `the real run writes ${table}; the preview must not`).toContain(table);
    }
    for (const table of PREVIEW_WRITABLE_TABLES) {
      expect(blocked, `${table} records what a model call cost and must go through`).not.toContain(table);
    }

    // The preview itself IS on the spine — Rule 0: a run that records nothing cannot be told from
    // one that never happened.
    const spine = (await env.WP_OS_DB.prepare("SELECT event_type FROM event_record WHERE event_type LIKE 'preview.%' ORDER BY event_type").all<{ event_type: string }>()).results!;
    expect(spine.map((e) => e.event_type)).toEqual(["preview.finished", "preview.started"]);
  });

  it("NEGATIVE PROOF: the identical run, not in preview, emails Scooter and writes everything", async () => {
    const withMail = mailEnv(env);
    const sent: Sent[] = [];
    const other: string[] = [];
    captureFetch(sent, other);

    const { openHireSearchCard } = await import("../src/worker/services/productionsHire");
    const opened = await openHireSearchCard(withMail, NOW);
    const card = await withMail.WP_OS_DB.prepare(
      "SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email FROM work_card WHERE id = ?1",
    ).bind(opened.cardId).first<SweepCard>();
    const live = await hireRunner(withMail, card!);
    vi.unstubAllGlobals();

    expect(live.finished, live.detail).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to, "the live run goes to Scooter, which is what the preview proved it does not").toEqual(["scooter@westpeek.ventures"]);
    expect(sent[0]!.subject).not.toMatch(/PREVIEW/);
    expect(sent[0]!.text).not.toMatch(/this is not a live send/);

    const candidates = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM productions_candidate").first<{ n: number }>();
    expect(candidates!.n, "the live run DOES remember the candidate").toBe(1);
    const dlv = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deliverable WHERE kind = 'productions_hire_search'").first<{ n: number }>();
    expect(dlv!.n, "the live run DOES file it on his Home").toBe(1);
  });

  it("refuses the external-effect path outright, and consumes no approval receipt", async () => {
    const ctx: PreviewContext = {
      id: "prv_2",
      requestedBy: "fu_sequoia_taylor",
      requestedByEmail: "sequoia@westpeek.ventures",
      target: { kind: "JOB", key: "productions_hire_search" },
      what: "anything",
      startedAt: NOW.toISOString(),
    };
    const { env: previewed } = previewEnv(env, ctx);
    /*
     * REFUSED BEFORE THE ROW IS EVEN READ. The request id below does not exist, and the refusal is
     * still `preview_cannot_send` rather than `not_found` — which is the assertion that the stop is
     * unconditional rather than a branch somewhere inside the effect machinery.
     */
    await expect(
      executeExternalEffect(previewed, { type: "HUMAN", firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] }, "eff_anything", "apc_anything"),
    ).rejects.toMatchObject({ code: "preview_cannot_send" });
    const consumed = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'effect.executed'").first<{ n: number }>();
    expect(consumed!.n, "no receipt was consumed by a preview").toBe(0);
  });
});

describe("who may ask for one", () => {
  it("is a partner and nobody else; an unknown job says so rather than pretending", async () => {
    await expect(
      runPreview(env, { id: "fu_somebody_else", email: "x@y.example" }, { kind: "JOB", key: "productions_hire_search" }, NOW),
    ).rejects.toBeInstanceOf(PreviewError);

    const res = await handleRequest(
      new Request("https://test.local/api/preview", {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ kind: "JOB", key: "employee_work_sweep" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/does not open a work card/);

    // Scooter is a partner too: previews are not one person's feature.
    const his = await handleRequest(
      new Request("https://test.local/api/preview", {
        method: "POST",
        headers: { ...SCOOTER, "content-type": "application/json" },
        body: JSON.stringify({ kind: "CARD", key: "wc_does_not_exist" }),
      }),
      env,
    );
    expect(his.status).toBe(404);
  });
});
