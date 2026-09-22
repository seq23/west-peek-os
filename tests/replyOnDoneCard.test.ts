import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { startThread, steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { containsGenuineQuestion } from "../src/shared/intake/genuineQuestion";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import type { QuestionAnswerer } from "../src/worker/services/questionRouting";

/**
 * A REPLY THAT LANDS ON A CARD THAT IS ALREADY DONE (22 Sep 2026).
 *
 * THE REAL INCIDENT. Scooter replied to Walker's weekly hire-search deliverable — a DONE card,
 * `PRODUCTIONS_HIRE_SEARCH` — with two things in one message: a genuine QUESTION ("What's her
 * email, do you have it, this first candidate?") and a steering INSTRUCTION ("broaden future
 * searches to prefer candidates with a music background"). A historical mail-parsing bug lost his
 * words that day (fixed separately); tracing what the CURRENT system does with a reply like his
 * found a second, still-open bug: `steerFromReply`'s two branches assumed the card was still being
 * worked — `BLOCKED` (answer it) or `OPEN`/`IN_PROGRESS` (leave a note the next step reads). A DONE
 * card is neither. The steering half correctly reached `work_steer` either way (it always has,
 * unconditionally, keyed by kind rather than by card). The question half went nowhere: no error, no
 * card, nothing a person would ever see.
 *
 * THIS FILE PROVES THE THREE SHAPES THE BRIEF NAMES, DISTINCTLY: pure steering (unchanged, existing
 * behaviour, no note or notice), a genuine question alone (escalated — surfaced, never silent), and
 * both in the same message at once (Scooter's exact case: filed AND surfaced, not one or the other).
 */

let t: TestDb;
let env: Env;

const SCOOTER_FROM = "Scooter Taylor <scooter@westpeek.ventures>";
const GOOD_AUTH =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=scooter@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none";

/** A reply exactly as Gmail writes one: the new words, then the attribution line, then the quote. */
function gmailReply(written: string, quotedOriginal: string, subject: string): string {
  return [
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    `To: ${INTAKE_MAILBOX}`,
    `Subject: Re: ${subject}`,
    "",
    written,
    "",
    "On Mon, 21 Sep 2026 at 10:02, Walker <walker@joinwestpeek.com> wrote:",
    ...quotedOriginal.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}

async function doneCard(id: string, title: string, kind: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card
       (id, title, description, kind, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by)
     VALUES (?1, ?2, 'x', ?3, 'AI', 'aie_walker', 'DONE', 'NORMAL', 'INTERNAL', 'west-peek', 'scooter@westpeek.ventures', 'test')`,
  )
    .bind(id, title, kind)
    .run();
}

async function noteFor(cardId: string): Promise<Array<{ body: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at").bind(cardId).all<{ body: string }>()
  ).results ?? [];
}

async function steerRowsFor(kind: string): Promise<Array<{ body: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT body FROM work_steer WHERE card_kind = ?1 ORDER BY created_at").bind(kind).all<{ body: string }>()
  ).results ?? [];
}

async function notificationsFor(cardId: string): Promise<Array<{ title: string; body: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT title, body FROM notification WHERE object_id = ?1 ORDER BY created_at").bind(cardId).all<{ title: string; body: string }>()
  ).results ?? [];
}

const sent: Array<{ to: string; subject: string; text: string }> = [];

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("containsGenuineQuestion — biased toward yes, never a silent drop", () => {
  it("a plain instruction with no question mark and no interrogative opener is not a question", () => {
    expect(containsGenuineQuestion("broaden future searches to prefer candidates with a music background")).toBe(false);
    expect(containsGenuineQuestion("Yes he can open.")).toBe(false);
    expect(containsGenuineQuestion("")).toBe(false);
  });

  it("a literal question mark anywhere is enough on its own", () => {
    expect(containsGenuineQuestion("What's her email, do you have it, this first candidate?")).toBe(true);
    expect(containsGenuineQuestion("stop showing me agency people, I want independents, ok?")).toBe(true);
  });

  it("an interrogative opener with no punctuation at all still reads as a question — a hurried phone reply", () => {
    expect(containsGenuineQuestion("whats her email do you have it")).toBe(true);
    expect(containsGenuineQuestion("can you send the folder link")).toBe(true);
  });
});

describe("a reply on a DONE card — pure steering only (must not regress)", () => {
  const KIND = "PRODUCTIONS_HIRE_SEARCH";
  const CARD_ID = "wc_done_steer_only";

  it("files work_steer and does nothing else — no note, no notification, no send", async () => {
    await doneCard(CARD_ID, "Walker: hire search — 2 candidate(s) this week", KIND);
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: CARD_ID,
      cardKind: KIND,
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search — 2 candidate(s) this week",
      firmScope: "west-peek",
    });
    const raw = gmailReply(
      "stop showing me agency people, I want independents",
      "1. Jordan Example — Senior Experiential Producer",
      "Walker: hire search — 2 candidate(s) this week",
    );

    const out = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: GOOD_AUTH,
      subject: "Re: Walker: hire search — 2 candidate(s) this week",
      raw,
      inReplyTo: threadReference(token),
      references: null,
      emlKey: null,
    });
    expect(out.steered).toBe(true);
    expect(out.written).toBe("stop showing me agency people, I want independents");

    const steer = await steerRowsFor(KIND);
    expect(steer, "the steering instruction is filed against the KIND, as it always was").toEqual([
      { body: "stop showing me agency people, I want independents" },
    ]);
    expect(await noteFor(CARD_ID), "pure steering leaves no note on the DONE card — nothing more to do").toEqual([]);
    expect(await notificationsFor(CARD_ID), "and nothing is surfaced to a human").toEqual([]);
  });
});

describe("a reply on a DONE card — a genuine question, no steering content", () => {
  const KIND = "PRODUCTIONS_HIRE_SEARCH"; // unregistered in kindHosts.ts — escalates deterministically, no model call
  const CARD_ID = "wc_done_question_only";

  it("is not silently dropped: escalated with a distinctly labelled note and a notification", async () => {
    await doneCard(CARD_ID, "Walker: hire search — 1 candidate this week", KIND);
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: CARD_ID,
      cardKind: KIND,
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search — 1 candidate this week",
      firmScope: "west-peek",
    });
    const raw = gmailReply(
      "What's her email, do you have it, this first candidate?",
      "1. Taylor Example — Producer",
      "Walker: hire search — 1 candidate this week",
    );

    const out = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: GOOD_AUTH,
      subject: "Re: Walker: hire search — 1 candidate this week",
      raw,
      inReplyTo: threadReference(token),
      references: null,
      emlKey: "inbound-email/test/question-only.eml",
    });
    expect(out.steered).toBe(true);

    // The question rode alone — work_steer still files it (unconditional, as before) — but the
    // point under test is what happens NEXT, which the old code never did at all.
    const notes = await noteFor(CARD_ID);
    expect(notes.length, "surfaced on the card, never silent").toBe(1);
    expect(notes[0]!.body).toMatch(/^\[QUESTION AFTER DONE/);
    expect(notes[0]!.body).toMatch(/What's her email/);

    // `notifyPartners` addresses EACH Managing Partner individually — the same fan-out every other
    // firm-wide notice in this repo already uses (`announceOutcome`'s BLOCKED path, block escalation
    // nags, …) — so two rows, one per partner, is the correct shape here, not a duplicate.
    const notices = await notificationsFor(CARD_ID);
    expect(notices.length, "surfaced somewhere a human actually sees, not just on the card's own thread — to BOTH partners").toBe(2);
    for (const n of notices) {
      expect(n.title).toMatch(/already done/);
      expect(n.body).toMatch(/already DONE and stays that way/);
      expect(n.body, "clearly distinct from an active block on a live card").toMatch(/will not reopen on its own/);
    }

    const escalated = await env.WP_OS_DB
      .prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.question_after_done_escalated'")
      .bind(CARD_ID)
      .first<{ payload_json: string }>();
    expect(escalated, "an audit trail exists naming who was tried and why").toBeTruthy();
    const payload = JSON.parse(escalated!.payload_json) as { reason: string };
    expect(payload.reason).toContain("no owning employee is registered");

    // The card itself is untouched — still DONE, never quietly reopened into looking unfinished.
    const row = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(CARD_ID).first<{ state: string }>();
    expect(row!.state).toBe("DONE");
  });
});

describe("a reply on a DONE card — steering AND a question together (Scooter's real case)", () => {
  const KIND = "PRODUCTIONS_HIRE_SEARCH";
  const CARD_ID = "wc_done_both";

  it("files the steering instruction AND surfaces the question — both, not one or the other", async () => {
    await doneCard(CARD_ID, "Walker: hire search — 2 candidate(s) this week", KIND);
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: CARD_ID,
      cardKind: KIND,
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search — 2 candidate(s) this week",
      firmScope: "west-peek",
    });
    const written =
      "What's her email, do you have it, this first candidate? Also, going forward prefer candidates with a music background.";
    const raw = gmailReply(written, "1. Jordan Example — Senior Experiential Producer", "Walker: hire search — 2 candidate(s) this week");

    const out = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: GOOD_AUTH,
      subject: "Re: Walker: hire search — 2 candidate(s) this week",
      raw,
      inReplyTo: threadReference(token),
      references: null,
      emlKey: null,
    });
    expect(out.steered).toBe(true);
    expect(out.written).toBe(written);

    // BOTH REACHED: the whole written text — steering and question together — is filed for future
    // runs of this KIND to read (`standingSteer`, unaffected by this change) ...
    const steer = await steerRowsFor(KIND);
    expect(steer.some((r) => r.body === written)).toBe(true);

    // ... AND the question inside it is separately surfaced, because the standing-steer file is
    // read by a FUTURE card of this kind, never by a human today.
    const notes = await noteFor(CARD_ID);
    expect(notes.length).toBe(1);
    expect(notes[0]!.body).toMatch(/^\[QUESTION AFTER DONE/);
    expect(notes[0]!.body).toMatch(/What's her email/);
    expect(notes[0]!.body).toMatch(/music background/); // the whole message, steering included, is kept as context

    const notices = await notificationsFor(CARD_ID);
    expect(notices.length, "one per Managing Partner").toBe(2);
  });
});

describe("a confident answer, when the card's kind has a registered, ACTIVE owner", () => {
  const KIND = "WEB_PROPERTY_CHANGE";
  const CARD_ID = "wc_done_confident";

  it("answers directly through the normal send/preview door, and never leaves an escalation note", async () => {
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_porter'").run();
    await doneCard(CARD_ID, "Porter: footer links", KIND);
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: CARD_ID,
      cardKind: KIND,
      employee: "Porter",
      to: "scooter@westpeek.ventures",
      subject: "Porter: footer links",
      firmScope: "west-peek",
    });
    const raw = gmailReply("does the preview link expire?", "Landed the footer links.", "Porter: footer links");

    const confidentAnswer: QuestionAnswerer = async () => ({
      confident: true,
      answer: "No — a Cloudflare Pages preview link stays live for as long as the branch does.",
      reason: "documented in the build script",
      aiRunId: null,
    });

    const out = await steerFromReply(
      env,
      {
        fromHeader: SCOOTER_FROM,
        authenticationResults: GOOD_AUTH,
        subject: "Re: Porter: footer links",
        raw,
        inReplyTo: threadReference(token),
        references: null,
        emlKey: null,
      },
      { answerQuestion: confidentAnswer },
    );
    expect(out.steered).toBe(true);

    const notes = await noteFor(CARD_ID);
    expect(notes.length, "no escalation note — it was answered, not punted").toBe(1);
    expect(notes[0]!.body).toMatch(/^\[Answered after DONE\]/);
    expect(notes[0]!.body).toMatch(/Cloudflare Pages preview link/);
    // Never the "needs a reply from you" escalation shape.
    expect(notes[0]!.body).not.toMatch(/QUESTION AFTER DONE/);

    expect(await notificationsFor(CARD_ID), "a confident answer does not also ring a notification").toEqual([]);

    const answered = await env.WP_OS_DB
      .prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.question_after_done_answered'")
      .bind(CARD_ID)
      .first<{ payload_json: string }>();
    expect(answered).toBeTruthy();
    const payload = JSON.parse(answered!.payload_json) as { employee: string };
    expect(payload.employee).toBe("Porter");

    const row = await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(CARD_ID).first<{ state: string }>();
    expect(row!.state, "still DONE — answering a later question never reopens a finished card").toBe("DONE");

    // THE NORMAL SEND/PREVIEW DOOR WAS ACTUALLY USED, not merely claimed. The firm-wide preview
    // dial defaults ON (zero-row default), so the answer is filed for her rather than sent to
    // Scooter directly, and `filePreview` emails her that something is waiting — exactly the
    // Addendum 8 gate every other employee send already respects.
    expect(sent.length, "the preview-dial's own 'waiting on you' ping went out").toBe(1);
    expect(sent[0]!.to).toBe("sequoia@westpeek.ventures");
    const previews = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM preview_approval WHERE work_card_id = ?1").bind(CARD_ID).first<{ n: number }>();
    expect(previews?.n ?? 0, "the real answer itself is filed, waiting for her Send it").toBe(1);
  });
});
