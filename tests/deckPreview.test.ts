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
const sends: Array<{ to: string; subject: string; text: string; headers: Record<string, string>; attachments: Array<{ filename: string; content: string; content_type?: string }> }> = [];
/** The mail provider refuses any message that carries a file (what a transport that cannot attach does). */
let refuseAttachments = false;
const SCOOTER_FROM = "Scooter Taylor <scooter@westpeek.ventures>";
const authFor = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none`;
let mailSeq = 0;
/** A fresh email from a partner, through the real door. */
async function partnerEmails(from: string, who: string, to: string, subject: string, body: string, attachPdf = false): Promise<void> {
  const { handleInboundEmail } = await import("../src/worker/effects/inboundEmail");
  const raw = attachPdf
    ? [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: multipart/mixed; boundary="b_deck"', "MIME-Version: 1.0", "", "--b_deck", "Content-Type: text/plain; charset=UTF-8", "", body, "", "--b_deck", 'Content-Type: application/pdf; name="Northwind deck.pdf"', 'Content-Disposition: attachment; filename="Northwind deck.pdf"', "Content-Transfer-Encoding: base64", "", btoa(FAKE_PDF), "", "--b_deck--", ""].join("\r\n")
    : [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "", body].join("\n");
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers({ from, to, subject, "authentication-results": authFor(who), "message-id": `<deck-start-${(mailSeq += 1)}@example.com>` });
  await handleInboundEmail({ from: `${who}@westpeek.ventures`, to, headers, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength }, env);
}
const count = async (sql: string) => (await env.WP_OS_DB.prepare(sql).first<{ n: number }>())!.n;

const SEQUOIA_FROM = "Sequoia Taylor <sequoia@westpeek.ventures>";
const GOOD_AUTH = "mx.cloudflare.net; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none";

const FAKE_PDF = "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF";
let printed: string | null = null;
let overflow: unknown[] = [];
/** A final PDF bigger than an email may carry. */
let bigPdf = false;
const fakeLaunch = async () => ({
  newPage: async () => ({
    setViewport: async () => undefined,
    setContent: async (html: string) => { printed = html; },
    evaluate: async (fn: unknown) => (typeof fn === "string" ? overflow : undefined),
    pdf: async () => (bigPdf ? new Uint8Array(11 * 1024 * 1024).fill(32).buffer : new TextEncoder().encode(FAKE_PDF).buffer),
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
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; headers?: Record<string, string>; attachments?: Array<{ filename: string; content: string; content_type?: string }> };
      if (refuseAttachments && b.attachments?.length) return new Response(JSON.stringify({ message: "attachments are not accepted" }), { status: 422 });
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text, headers: b.headers ?? {}, attachments: b.attachments ?? [] });
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

describe("the preview page", () => {
  it("scopes the deck's own styles to the slides, so the page's heading and header keep their own look", async () => {
    // Found on the first phone screenshot: the slide rules for header/h1 restyled the page's title.
    const { DECK_CSS } = await import("../src/shared/deck/render");
    expect(DECK_CSS).not.toMatch(/^\s*(?:header|h1|h2|footer|body|html|ul|li|p)\s*[{,]/m);
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

  it("one \"approved\" makes no PDF, a change in between resets it, and both partners' \"approved\" on the same slides makes exactly ONE PDF, attached and linked", async () => {
    const { recordReply, deckPreviewTick } = await import("../src/worker/services/deckPreview");
    const p = (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE state = 'OPEN'").first<{ id: string }>())!;
    const last = () => sends[sends.length - 1]!;
    const versions = () => count("SELECT COUNT(*) AS n FROM deck_version");
    const state = async () => (await env.WP_OS_DB.prepare("SELECT state FROM deck_preview WHERE id = ?1").bind(p.id).first<{ state: string }>())!.state;

    // ONE approval: recorded, answered once to both, no PDF, the round stays open.
    await recordReply(env, p.id, "Approved!", "sequoia@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await versions()).toBe(0);
    expect(await state()).toBe("OPEN");
    expect(last().to).toBe("scooter@westpeek.ventures,sequoia@westpeek.ventures");
    expect(last().text).toContain("Sequoia approved the deck as it is in the preview: https://os.joinwestpeek.com/api/deck/preview");
    expect(last().text).toContain("No PDF yet. I'll make the final PDF when Scooter also replies \"approved\" here.");
    // The same partner approving twice counts once.
    await recordReply(env, p.id, "approved", "sequoia@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await versions()).toBe(0);
    expect(last().text).toContain("Sequoia's \"approved\" is already counted.");

    // A CHANGE IN BETWEEN resets it: her approval was of the slides before the change.
    await recordReply(env, p.id, "page 2 should also say Lab nights", "scooter@westpeek.ventures");
    const editor = async ({ slides }: { slides: Slide[] }) => ({ slides: slides.map((x) => (x.key === "sourcing" ? { ...x, slots: [...x.slots, { kind: "text" as const, text: "Lab nights" }] } : x)), changes: ["page 2 now also says Lab nights"], cannot: [] });
    await deckPreviewTick(env, { editor, launch: fakeLaunch });
    expect(last().text).toContain("The deck changed after Sequoia approved, so both of you need to reply \"approved\" again.");
    expect(await count("SELECT COUNT(*) AS n FROM deck_preview_change WHERE kind = 'APPROVAL' AND state = 'DONE'")).toBe(0);
    await recordReply(env, p.id, "approved", "scooter@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await versions(), "Scooter alone, after the change, is still one approval").toBe(0);
    expect(last().text).toContain("I'll make the final PDF when Sequoia also replies \"approved\" here.");

    // BOTH, on the same slides. A layout that would cut a line refuses the PDF — a named wait, said once, retried every sweep.
    overflow = [{ page: 3, what: "Fund size", by: 12 }];
    await recordReply(env, p.id, "Approved!", "sequoia@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await versions()).toBe(0);
    expect(last().text).toMatch(/Scooter and Sequoia both approved the deck\. I couldn't make the PDF yet: page 3 would cut "Fund size"/);
    const told = sends.length;

    overflow = [];
    await deckPreviewTick(env, { launch: fakeLaunch });
    const v = await env.WP_OS_DB.prepare("SELECT * FROM deck_version").first<{ state: string; approved_by: string; origin: string; created_by: string; document_id: string | null; page_count: number; title: string; change_summary: string }>();
    // The decision carries the name of the partner who completed the pair; the record names both.
    expect(v).toMatchObject({ state: "CURRENT", approved_by: "fu_sequoia_taylor", origin: "BUILT", created_by: "Preston", page_count: 2, title: "West Peek Ventures Fund I — approved by Scooter and Sequoia" });
    expect(v!.change_summary).toContain("approved by Scooter Taylor and Sequoia Taylor by email");
    expect(v!.document_id).toBeTruthy();
    expect(printed).toContain("data:image/png;base64,");
    expect(printed).toContain("Lab nights");
    expect(await state()).toBe("FINAL");
    // ONE reply, to the two partners, with the PDF attached under its version number AND the link.
    expect(sends.length).toBe(told + 1);
    expect(last().to).toBe("scooter@westpeek.ventures,sequoia@westpeek.ventures");
    expect(last().text).toMatch(/Scooter and Sequoia both approved the deck, so I made the final PDF: v1, 2 pages\. It's attached/);
    expect(last().text).toContain(`Open it here: https://os.joinwestpeek.com/api/documents/${v!.document_id}/download`);
    expect(last().attachments).toEqual([{ filename: "West-Peek-Ventures-Fund-I-deck-v1.pdf", content: btoa(FAKE_PDF), content_type: "application/pdf" }]);
    // Exactly one PDF, however many sweeps follow.
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await versions()).toBe(1);
    expect(sends.length).toBe(told + 1);
  });

  it("more work after the final PDF puts the approved deck back in the link as the next round; a second \"approved\" changes nothing", async () => {
    const { recordReply, deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const final = (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE state = 'FINAL'").first<{ id: string; slides_json: string; final_note: string }>())!;
    const last = () => sends[sends.length - 1]!;

    // A second "approved" on the finished round: one answer with the PDF that exists (link only), nothing else.
    await recordReply(env, final.id, "approved", "scooter@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(last().text).toContain(`This deck is already approved and final: v1. Open it here: ${final.final_note}`);
    expect(last().attachments).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM deck_version")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM deck_preview")).toBe(1);

    // MORE WORK: a reply on the finished thread opens round 2 FROM THE APPROVED SLIDES, and its one email says so.
    await recordReply(env, final.id, "one more thing: page 2 should mention Pitch Lab", "scooter@westpeek.ventures");
    const before = sends.length;
    const editor = vi.fn(async ({ slides }: { slides: Slide[] }) => ({ slides: slides.map((x) => (x.key === "sourcing" ? { ...x, slots: [...x.slots, { kind: "text" as const, text: "Pitch Lab" }] } : x)), changes: ["page 2 now mentions Pitch Lab"], cannot: [] }));
    await deckPreviewTick(env, { editor, launch: fakeLaunch });
    const round2 = (await openPreview(env, FUND))!;
    expect(round2.round_no).toBe(2);
    expect(round2.slides_json, "starts from the approved deck, untouched").toBe(final.slides_json);
    expect(sends.length, "one email for the new round, to both").toBe(before + 1);
    expect(last().to).toBe("scooter@westpeek.ventures,sequoia@westpeek.ventures");
    expect(last().subject).toBe("Our Fund I deck: preview round 2");
    expect(last().text).toContain("Scooter asked for more work on our Fund I deck, so the approved deck (v1) is back in the preview: https://os.joinwestpeek.com/api/deck/preview");
    expect(last().text).toContain("Scooter asked:\n\"one more thing: page 2 should mention Pitch Lab\"");
    expect(last().text).toContain("v1 stays the current deck until this round is approved.");
    expect(last().text).toContain("When both of you have replied \"approved\", I'll make the next final PDF.");
    // His words travel with the round as its first request, and the current deck has not moved.
    expect(await env.WP_OS_DB.prepare("SELECT preview_id, state FROM deck_preview_change WHERE said LIKE 'one more thing%'").first()).toMatchObject({ preview_id: round2.id, state: "PENDING" });
    expect(await env.WP_OS_DB.prepare("SELECT version_no FROM deck_version WHERE state = 'CURRENT'").first()).toMatchObject({ version_no: 1 });

    // The next sweep does the work on round 2 and answers on ROUND 2's thread.
    await deckPreviewTick(env, { editor, launch: fakeLaunch });
    expect(editor).toHaveBeenCalledOnce();
    expect((await openPreview(env, FUND))!.slides_json).toContain("Pitch Lab");
    expect(last().headers["In-Reply-To"]).toBe(threadReference(round2.thread_token!));
    expect(last().text).toContain("What I changed:\n- page 2 now mentions Pitch Lab");

    // Both approve round 2. The provider refuses the file → the SAME reply goes with the link only, and the round still finishes.
    refuseAttachments = true;
    await recordReply(env, round2.id, "approved", "sequoia@westpeek.ventures");
    await recordReply(env, round2.id, "approved", "scooter@westpeek.ventures");
    await deckPreviewTick(env, { launch: fakeLaunch });
    refuseAttachments = false;
    expect(await env.WP_OS_DB.prepare("SELECT version_no, approved_by FROM deck_version WHERE state = 'CURRENT'").first()).toMatchObject({ version_no: 2, approved_by: "fu_scooter_taylor" });
    expect(await count("SELECT COUNT(*) AS n FROM deck_version")).toBe(2);
    expect(last().text).toContain("Sequoia and Scooter both approved the deck, so I made the final PDF: v2, 2 pages. I couldn't attach the file to this email, so please use the link.");
    expect(last().text).toMatch(/Open it here: https:\/\/os\.joinwestpeek\.com\/api\/documents\/.+\/download/);
    expect(last().attachments).toEqual([]);
  });

  it("the next records move starts round 3 from the final round's slides, with its own one email", async () => {
    const { deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const before = sends.length;
    await setPolicy("sleeve_policy_version", "sleeve_json", 2, { committed_usd: 32_000_000, estimated_fees_usd: 4_000_000, estimated_expenses_usd: 400_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] });
    await deckPreviewTick(env, { launch: fakeLaunch });
    const open = (await openPreview(env, FUND))!;
    expect(open.round_no).toBe(3);
    expect(open.slides_json).toContain("Rooms evenings");
    expect(open.slides_json).toContain("Pitch Lab");
    expect(sends.length).toBe(before + 1);
    expect(sends[sends.length - 1]!.subject).toBe("Our Fund I deck: preview round 3");
    expect(sends[sends.length - 1]!.text).toContain("Reply here with any changes in plain words, or with \"approved\". When both of you have replied \"approved\", I'll make the final PDF.");
  });
});

describe("\"ready to work on the deck\" starts the round, with no model deciding it", () => {
  it("only the fund's own deck, said plainly: a founder's deck, a tag, a hedge or a question is left to Porter", async () => {
    const { fundDeckStart } = await import("../src/shared/deck/start");
    const start = (subject: string, body = "", hasAttachment = false) => fundDeckStart({ subject, body, hasAttachment });
    for (const [subject, body] of [
      ["Ready to work on the deck", ""], ["Deck", "Hi Wren,\nLet’s work on our deck.\nSequoia"], ["", "Walker, I'm ready to start the LP deck."], ["Start the deck", ""],
      ["Preston, please open the Fund I deck", ""], ["hello", "Can you reopen the pitch deck?"], ["Time to update our fund deck", ""], ["We are ready to finish the deck for LPs", ""],
    ] as const) expect(start(subject, body), `${subject} / ${body}`).not.toBeNull();
    for (const [subject, body, pdf] of [
      ["Ready to work on the deck", "Northwind's deck is attached", true], ["#wpdeck ready to work on the deck", "", false], ["Not ready to work on the deck yet", "", false],
      ["Deck", "I'm not ready to work on the deck.", false], ["Are we ready to work on the deck?", "", false], ["Let's work on the deck after the first close", "", false],
      ["Ready to work on the Northwind deck", "", false], ["Start the deck for Northwind", "", false], ["Let's review their deck", "", false],
      ["Re: Ready to work on the deck", "", false], ["Fwd: Start the deck", "", false], ["Deck", "", false], ["Lunch", "Did you see the deck Northwind sent?", false],
    ] as const) expect(start(subject, body, pdf), `${subject} / ${body}`).toBeNull();
    // What else they wrote is kept, minus the greeting, the start sentence and the sign-off.
    expect(start("Deck", "Wren, I'm ready to work on the deck. Page 3 should lead with the fund size.\n\nThanks,\nScooter")!.words).toBe("Page 3 should lead with the fund size.");
    expect(start("Ready to work on the deck", "Thanks,\nSequoia")!.words).toBe("");
  });

  it("a partner's email joins the open round (never a second one), then after the final PDF starts the next round from the approved deck", async () => {
    const { recordReply, deckPreviewTick, openPreview } = await import("../src/worker/services/deckPreview");
    const last = () => sends[sends.length - 1]!;
    const round3 = (await openPreview(env, FUND))!;
    const cards = await count("SELECT COUNT(*) AS n FROM work_card");

    // ROUND 3 IS OPEN AND EMAILED: Scooter's email starts nothing new. Both get the link again on that thread, and his words are a request.
    let before = sends.length;
    await partnerEmails(SCOOTER_FROM, "scooter", INTAKE_MAILBOX, "Ready to work on the deck", "Wren, I'm ready to work on the deck. Page 3 should lead with the fund size.\n\nThanks,\nScooter");
    expect(await count("SELECT COUNT(*) AS n FROM deck_preview")).toBe(3);
    expect(sends.length, "the asker never gets silence").toBe(before + 1);
    expect(last().to).toBe("scooter@westpeek.ventures,sequoia@westpeek.ventures");
    expect(last().headers["In-Reply-To"]).toBe(threadReference(round3.thread_token!));
    expect(last().text).toContain("Scooter asked to work on the deck. Round 3 is already open, so we carry on in the same preview: https://os.joinwestpeek.com/api/deck/preview");
    expect(last().text).toContain("Scooter asked:\n\"Page 3 should lead with the fund size.\"");
    expect(await env.WP_OS_DB.prepare("SELECT preview_id, state, by_whom FROM deck_preview_change WHERE said = 'Page 3 should lead with the fund size.'").first()).toMatchObject({ preview_id: round3.id, state: "PENDING", by_whom: "Scooter" });
    expect(await count("SELECT COUNT(*) AS n FROM work_card"), "no card, no Porter, no chief of staff in between").toBe(cards);

    // A founder's deck from the same partner, in the same words but with a PDF, is NOT a start: it goes where it always went.
    before = sends.length;
    await partnerEmails(SCOOTER_FROM, "scooter", INTAKE_MAILBOX, "Ready to work on the deck", "Northwind sent this, take a look.", true);
    expect(await count("SELECT COUNT(*) AS n FROM deck_preview_change WHERE kind = 'REQUEST' AND state = 'PENDING'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM work_card")).toBe(cards + 1);

    // Finish round 3. A PDF too big for the OS to file is a wait the partners hear about once, never a sweep that dies unsaid.
    await deckPreviewTick(env, { editor: async () => ({ changes: [], cannot: ["the fund size is a record; it already leads page 3"] }), launch: fakeLaunch });
    await recordReply(env, round3.id, "approved", "scooter@westpeek.ventures");
    await recordReply(env, round3.id, "approved", "sequoia@westpeek.ventures");
    bigPdf = true;
    await deckPreviewTick(env, { launch: fakeLaunch });
    bigPdf = false;
    expect(last().text).toContain("Scooter and Sequoia both approved the deck. I couldn't make the PDF yet: the PDF is too big for the OS to file (over 5 MB).");
    expect(await env.WP_OS_DB.prepare("SELECT version_no FROM deck_version WHERE state = 'CURRENT'").first()).toMatchObject({ version_no: 2 });
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(await env.WP_OS_DB.prepare("SELECT version_no FROM deck_version WHERE state = 'CURRENT'").first()).toMatchObject({ version_no: 3 });
    expect(last().attachments.map((a) => a.filename)).toEqual(["West-Peek-Ventures-Fund-I-deck-v3.pdf"]);

    // AFTER THE FINAL PDF, Sequoia writes to her chief of staff's address: round 4 starts from the approved deck, and the sweep emails both.
    before = sends.length;
    await partnerEmails(SEQUOIA_FROM, "sequoia", "wren@joinwestpeek.com", "Deck", "Hi Wren,\nLet's work on our deck.\nSequoia");
    const round4 = (await openPreview(env, FUND))!;
    expect(round4.round_no).toBe(4);
    expect(round4.slides_json).toBe((await env.WP_OS_DB.prepare("SELECT slides_json FROM deck_preview WHERE id = ?1").bind(round3.id).first<{ slides_json: string }>())!.slides_json);
    expect(sends.length, "the handler records; the sweep sends").toBe(before);
    await deckPreviewTick(env, { launch: fakeLaunch });
    expect(sends.length).toBe(before + 1);
    expect(last().subject).toBe("Our Fund I deck: preview round 4");
    expect(last().text).toContain("Sequoia asked for more work on our Fund I deck, so the approved deck (v3) is back in the preview: https://os.joinwestpeek.com/api/deck/preview");
    expect(last().text).not.toContain("asked:\n");
    expect(await env.WP_OS_DB.prepare("SELECT version_no FROM deck_version WHERE state = 'CURRENT'").first(), "v3 stays current until round 4 is approved").toMatchObject({ version_no: 3 });
  });
});
