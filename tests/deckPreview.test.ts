import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Slide } from "../src/shared/deck/definition";
import { checkSlides, isApproval, typedFigures } from "../src/shared/deck/preview";
import { threadReference } from "../src/shared/email/thread";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";

/**
 * THE DECK PREVIEW FLOW (owner's design, 26 Oct 2026), end to end against a real local D1:
 * records → preview (no PDF) → ONE email per round to both partners → a reply applied to the SAME
 * preview and answered on the thread → "approved" → the final PDF, current, in that partner's name.
 * Every company and person here is made up.
 */

let t: TestDb;
let env: Env;
const FUND = "fund_preview_test";
const sends: Array<{ to: string; subject: string; text: string; headers: Record<string, string> }> = [];

const SEQUOIA_FROM = "Sequoia Taylor <sequoia@westpeek.ventures>";
const GOOD_AUTH = "mx.cloudflare.net; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none";

const FAKE_PDF = "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF";
let printed: string | null = null;
let overflow: unknown[] = [];
const fakeLaunch = async () => ({
  newPage: async () => ({
    setViewport: async () => undefined,
    setContent: async (html: string) => { printed = html; },
    evaluate: async (fn: unknown) => (typeof fn === "string" ? overflow : undefined),
    pdf: async () => new TextEncoder().encode(FAKE_PDF).buffer,
  }),
  close: async () => undefined,
});

async function setPolicy(table: string, column: string, v: number, doc: unknown): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO ${table} (id, fund_id, version_no, effective_from, ${column}, created_by, firm_scope) VALUES (?1, ?2, ?3, '2026-10-26', ?4, 'fu_sequoia_taylor', 'west-peek')`,
  ).bind(`pv_dp_${table}_${v}`, FUND, v, JSON.stringify(doc)).run();
}

function reply(written: string): string {
  return [`From: ${SEQUOIA_FROM}`, `To: ${INTAKE_MAILBOX}`, "Subject: Re: Our Fund I deck: a new way we'll finish it", "", written, "", "On Mon, Preston wrote:", "> Hi Scooter and Sequoia,"].join("\n");
}

const SLIDES: Slide[] = [
  { key: "cover", layout: "cover", headline: "“A FAKE COVER LINE.”", standfirst: "Somewhere · Elsewhere", slots: [{ kind: "figure", label: "As of", bind: "as_of_date" }] },
  { key: "sourcing", headline: "HOW DEALS REACH US.", slots: [{ kind: "text", text: "Member intros" }, { kind: "image", asset: "logo.png", alt: "logo", height: 60 }] },
  { key: "terms", headline: "FUND I TERMS.", slots: [{ kind: "table", rows: [["Fund size", { bind: "fund_size" }]] }] },
];

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_DOCUMENTS: t.docs } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; headers?: Record<string, string> };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text, headers: b.headers ?? {} });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("DELETE FROM fund").run();
  await env.WP_OS_DB.prepare("INSERT INTO fund (id, name, status, firm_scope) VALUES (?1, 'West Peek Ventures Fund I', 'ACTIVE', 'west-peek')").bind(FUND).run();
  await setPolicy("investment_mandate_version", "mandate_json", 1, { target_size_usd: 31_000_000, sectors: ["AI", "ED_TECH"] });
  await setPolicy("sleeve_policy_version", "sleeve_json", 1, { committed_usd: 31_000_000, estimated_fees_usd: 4_000_000, estimated_expenses_usd: 500_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] });
  await setPolicy("reserve_policy_version", "reserve_json", 1, { reserve_pct: 40 });
  await t.docs.put("deck-assets/logo.png", new Uint8Array([137, 80, 78, 71]));
  await env.WP_OS_DB.prepare("INSERT INTO deck_asset (name, r2_key, content_type, bytes, source) VALUES ('logo.png', 'deck-assets/logo.png', 'image/png', 4, 'test')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("what counts as an approval", () => {
  it("only a reply that leads with approving it", () => {
    for (const yes of ["approved", "Approved!", "approve it", "Looks good, approved.", "yes approved", "it's approved"]) expect(isApproval(yes), yes).toBe(true);
    for (const no of ["not approved yet", "page 4 should say approved by the IC", "once page 4 is fixed it's approved", "approved but change page 2", "Can you fix the cover?"]) expect(isApproval(no), no).toBe(false);
  });
});

describe("the slide guard", () => {
  it("refuses an unknown picture, a binding that is not a record, and an empty deck", () => {
    const known = new Set(["logo.png"]);
    expect(checkSlides(SLIDES, known).ok).toBe(true);
    expect(checkSlides([], known).ok).toBe(false);
    expect(checkSlides([{ ...SLIDES[1]!, slots: [{ kind: "image", asset: "made-up.png", alt: "" }] }], known).ok).toBe(false);
    expect(checkSlides([{ key: "x", headline: "X", slots: [{ kind: "figure", label: "x", bind: "irr_pct" }] }], known).ok).toBe(false);
  });

  it("finds money and percentages typed as prose", () => {
    expect(typedFigures([{ key: "x", headline: "WE RAISED $23M", slots: [{ kind: "text", text: "8% ownership" }] }])).toEqual(["$23M", "8%"]);
  });
});

describe("records → preview → one email → reply → same preview → approved → PDF", () => {
  it("builds the first preview held, sends nothing, and a release sends exactly ONE email to both partners", async () => {
    const { startOrUpdatePreview, sendRound, deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const { preview, created } = await startOrUpdatePreview(env, { reason: "first preview", changes: ["Cover line fixed", "Page 4 rewritten"], slides: SLIDES, kept: "the team photos", hold: true });
    expect(created).toBe(true);
    expect(preview.round_no).toBe(1);
    // HELD: the sweep sends nothing and no PDF version exists.
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(sends).toHaveLength(0);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n).toBe(0);

    await env.WP_OS_DB.prepare("UPDATE deck_preview SET hold = 0 WHERE id = ?1").bind(preview.id).run();
    const first = await sendRound(env, preview.id);
    expect(first.sent, first.reason).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe("scooter@westpeek.ventures,sequoia@westpeek.ventures");
    expect(sends[0]!.subject).toBe("Our Fund I deck: a new way we'll finish it");
    expect(sends[0]!.text).toContain("Hi Scooter and Sequoia,");
    expect(sends[0]!.text).toContain("2. You both look at it here: https://os.joinwestpeek.com/api/deck/preview");
    expect(sends[0]!.text).toContain("- Cover line fixed");
    expect(sends[0]!.text).toContain("Kept from earlier decks: the team photos");
    expect(sends[0]!.text.trim().endsWith("Preston\nWest Peek OS")).toBe(true);

    // ONE EMAIL PER ROUND: a second send, and the sweep, send nothing more.
    const second = await sendRound(env, preview.id);
    expect(second.sent).toBe(false);
    expect(second.reason).toMatch(/one email per round/);
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(sends).toHaveLength(1);
    // A thread row for EACH partner, so either one's reply finds this conversation.
    const threads = (await env.WP_OS_DB.prepare("SELECT to_address FROM email_thread WHERE object_type = 'deck_preview' ORDER BY to_address").all<{ to_address: string }>()).results;
    expect(threads.map((r) => r.to_address)).toEqual(["scooter@westpeek.ventures", "sequoia@westpeek.ventures"]);
    expect((await openPreview(env, FUND))!.thread_token).toBeTruthy();
  });

  it("a records move folds into the OPEN round (no second round, no PDF) and is said on the thread", async () => {
    const { deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    await setPolicy("investment_mandate_version", "mandate_json", 2, { target_size_usd: 32_000_000, sectors: ["AI", "ED_TECH"] });
    await deckPreviewTick(env, { launch: fakeLaunch });
    const rounds = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_preview").first<{ n: number }>();
    expect(rounds!.n).toBe(1);
    const open = (await openPreview(env, FUND))!;
    expect(open.what_changed_json).toMatch(/fund records changed \(mandate v1 → v2\)/);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.subject).toBe("Re: Our Fund I deck: a new way we'll finish it");
    expect(sends[1]!.headers["In-Reply-To"]).toBe(threadReference(open.thread_token!));
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n).toBe(0);
    // Steady: the same records do not move it again.
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(sends).toHaveLength(2);
  });

  it("a partner's reply on the thread updates the SAME preview and is answered on the thread", async () => {
    const { steerFromReply } = await import("../src/worker/services/emailThread");
    const { deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const before = (await openPreview(env, FUND))!;
    const steer = await steerFromReply(env, {
      fromHeader: SEQUOIA_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Our Fund I deck: a new way we'll finish it",
      raw: reply("page 2 should also say Rooms evenings"), inReplyTo: threadReference(before.thread_token!), references: null, emlKey: null,
    });
    expect(steer.steered, steer.reason).toBe(true);
    // Recorded at once, applied by the sweep — no model call inside the email handler.
    expect((await env.WP_OS_DB.prepare("SELECT state, kind, by_whom FROM deck_preview_change WHERE kind = 'REQUEST'").first())).toMatchObject({ state: "PENDING", kind: "REQUEST", by_whom: "Sequoia" });

    const editor = vi.fn(async ({ slides }: { slides: Slide[] }) => ({
      slides: slides.map((s) => (s.key === "sourcing" ? { ...s, slots: [...s.slots, { kind: "text" as const, text: "Rooms evenings" }] } : s)),
      changes: ["page 2 now also says Rooms evenings"],
      cannot: [],
    }));
    await deckPreviewTick(env, { editor, launch: fakeLaunch });
    expect(editor).toHaveBeenCalledOnce();
    const after = (await openPreview(env, FUND))!;
    expect(after.id, "the SAME preview, not a new one").toBe(before.id);
    expect(after.slides_json).toContain("Rooms evenings");
    expect(after.what_changed_json).toContain("page 2 now also says Rooms evenings");
    const answer = sends[sends.length - 1]!;
    expect(answer.subject).toBe("Re: Our Fund I deck: a new way we'll finish it");
    expect(answer.text).toContain("What I changed:\n- page 2 now also says Rooms evenings");
    expect((await env.WP_OS_DB.prepare("SELECT state FROM deck_preview_change WHERE kind = 'REQUEST'").first<{ state: string }>())!.state).toBe("DONE");
  });

  it("an edit that types a fund figure nobody asked for is refused, and the preview is left as it was", async () => {
    const { recordReply, deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const before = (await openPreview(env, FUND))!;
    await recordReply(env, before.id, "make the cover punchier", "scooter@westpeek.ventures");
    const editor = async ({ slides }: { slides: Slide[] }) => ({ slides: [{ ...slides[0]!, headline: "A $23M FUND WITH 8% OWNERSHIP" }, ...slides.slice(1)], changes: ["cover now punchier"], cannot: [] });
    await deckPreviewTick(env, { editor, launch: fakeLaunch });
    expect((await openPreview(env, FUND))!.slides_json).toBe(before.slides_json);
    expect(sends[sends.length - 1]!.text).toMatch(/What I couldn't do:\n- I did not save the edit because it typed figures nobody asked for \(\$23M, 8%\)/);
  });

  it("\"approved\" makes the final PDF: current, in that partner's name, the round FINAL, answered on the thread", async () => {
    const { recordReply, deckPreviewTick } = await import("../src/worker/services/deckPreview");
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE state = 'OPEN'").first<{ id: string }>())!;
    // A layout that would cut a line refuses the PDF — a named wait, said once, retried every sweep.
    overflow = [{ page: 3, what: "Fund size", by: 12 }];
    await recordReply(env, p.id, "Approved!", "sequoia@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n).toBe(0);
    expect(sends[sends.length - 1]!.text).toMatch(/couldn't make the PDF yet: page 3 would cut "Fund size"/);
    const told = sends.length;

    overflow = [];
    await deckPreviewTick(env, { launch: fakeLaunch });
    const v = await env.WP_OS_DB.prepare("SELECT * FROM deck_version").first<{ state: string; approved_by: string; origin: string; created_by: string; document_id: string | null; page_count: number }>();
    expect(v).toMatchObject({ state: "CURRENT", approved_by: "fu_sequoia_taylor", origin: "BUILT", created_by: "Preston", page_count: 2 });
    expect(v!.document_id).toBeTruthy();
    expect(printed).toContain("data:image/png;base64,");
    expect((await env.WP_OS_DB.prepare("SELECT state FROM deck_preview WHERE id = ?1").bind(p.id).first<{ state: string }>())!.state).toBe("FINAL");
    expect(sends.length).toBe(told + 1);
    expect(sends[sends.length - 1]!.text).toMatch(/Sequoia approved the deck, so I made the final PDF: v1, 2 pages/);

    // Once final, the round is closed: a late reply changes nothing and starts nothing.
    await recordReply(env, p.id, "one more thing on page 2", "scooter@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM deck_version").first<{ n: number }>())!.n).toBe(1);
  });

  it("the next records move starts round 2 from the final round's slides, with its own one email", async () => {
    const { deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const before = sends.length;
    await setPolicy("sleeve_policy_version", "sleeve_json", 2, { committed_usd: 32_000_000, estimated_fees_usd: 4_000_000, estimated_expenses_usd: 400_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] });
    await deckPreviewTick(env, { launch: fakeLaunch });
    const open = (await openPreview(env, FUND))!;
    expect(open.round_no).toBe(2);
    expect(open.slides_json).toContain("Rooms evenings");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]!.subject).toBe("Our Fund I deck: preview round 2");
  });
});
