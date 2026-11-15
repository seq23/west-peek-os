import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { classifyInbound } from "../src/worker/effects/inboundEmail";
import { isReplyMessage, splitQuoted, writtenAndQuoted } from "../src/shared/intake/replyBody";
import { mintThreadToken, threadHeaders, threadReference, threadTokensIn } from "../src/shared/email/thread";
import { standingSteer, startThread, steerFromReply } from "../src/worker/services/emailThread";
import { steerFor } from "../src/worker/services/instruction";
import { INTAKE_MAILBOX, triggersIn } from "../src/shared/intake/emailTriggers";
import type { Actor } from "../src/worker/services/authorize";

/**
 * A REPLY STEERS THE WORK, AND A QUOTE STEERS NOTHING (17 Sep 2026).
 *
 * Two independent things are proven here, and the first is a live bug rather than a new feature.
 *
 * 1 · THE QUOTED-TAG RE-TRIGGER. A partner sends "#wpdealflow Northwind", a funnel entry opens,
 *     and then he replies into that thread to say skip it. His client quotes the original, the
 *     quote still carries the tag, and the handler opened a SECOND funnel entry for the company he
 *     had just asked to drop. What fires must be what the person wrote.
 *
 * 2 · THE MATCH AND THE MODEL. A reply to one of Walker's notes has to reach the search it is about
 *     — matched on `References`, because `provider_message_id` is not the Message-ID a reply points
 *     at — and what he wrote has to reach a REASONING MODEL before the next search runs. The second
 *     half is the one that would have been silently inert: the weekly card is DONE before he
 *     replies, so a note on it would be read by nothing, ever.
 */

let t: TestDb;
let env: Env;

const SCOOTER_FROM = "Scooter Taylor <scooter@westpeek.ventures>";
const GOOD_AUTH =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=scooter@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=none";
const BAD_AUTH = "mx.cloudflare.net; spf=fail smtp.mailfrom=scooter@westpeek.ventures; dkim=none";

const ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_walker", roles: [], firmScopes: ["west-peek"] };

/** A reply exactly as Gmail writes one: the new words, then the attribution line, then the quote. */
function gmailReply(written: string, quotedOriginal: string): string {
  return [
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    `To: ${INTAKE_MAILBOX}`,
    "Subject: Re: Walker: hire search — 2 candidate(s) this week",
    "",
    written,
    "",
    "On Mon, 21 Sep 2026 at 10:02, Walker <walker@joinwestpeek.com> wrote:",
    ...quotedOriginal.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled" } as Partial<Env>);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a tag in a quote is not a tag the person typed", () => {
  it("fires ONCE, for the reply's intent, and not for the quote's", () => {
    const original = "#wpdealflow Northwind Robotics — seed\n\nDeck attached, worth a look.";
    const raw = gmailReply("actually skip this one, not for us", original);

    /*
     * THE BUG, REPRODUCED against the rule the handler used to apply: subject plus the WHOLE body.
     * Asserted against `triggersIn` directly rather than against a stubbed old `classifyInbound`,
     * so the negative proof survives this file being read a year from now.
     */
    expect(triggersIn(`Re: Walker: hire search\n${raw}`).map((t) => t.tag), "the bug: scanning the whole body fires on the quote").toEqual(["#wpdealflow"]);

    // WITH them — which is what the mail handler now passes — it does not.
    const asReply = classifyInbound({
      to: INTAKE_MAILBOX,
      from: "scooter@westpeek.ventures",
      subject: "Re: Walker: hire search",
      body: raw,
      inReplyTo: "<abc@mail.example>",
      references: "<abc@mail.example>",
    });
    expect(asReply.triggers, "nothing fires from the quoted original").toEqual([]);
    expect(asReply.unrouted).toBe(true);
    // And it is DIAGNOSABLE rather than mysterious: the event says what was in the quote only.
    expect(asReply.quotedOnly).toEqual(["#wpdealflow"]);
  });

  it("still fires for a tag the person typed in the same reply", () => {
    const raw = gmailReply("#wpupdate Northwind sent their March numbers, see below", "#wpdealflow Northwind Robotics — seed");
    const out = classifyInbound({
      to: INTAKE_MAILBOX,
      from: "scooter@westpeek.ventures",
      subject: "Re: Northwind",
      body: raw,
      references: "<abc@mail.example>",
    });
    expect(out.triggers, "what he wrote fires; what he quoted does not").toEqual(["#wpupdate"]);
    expect(out.quotedOnly).toEqual(["#wpdealflow"]);
  });

  it("LEAVES FORWARDS ALONE, because a forward's quoted text IS the payload", () => {
    /*
     * The mailbox's most common shape, stated in as many words in inboundEmail.ts: "most of the
     * emails to this inbox will be forwards and the important info will be in the original email
     * below". Narrowing the scan to written text for a forward would break deal intake for the
     * exact case it was built for — so `Re: Fwd:` is not a reply, whatever the headers say.
     */
    const forwarded = [
      "From: Scooter Taylor <scooter@westpeek.ventures>",
      "Subject: Fwd: Northwind Robotics",
      "",
      "worth a look",
      "",
      "---------- Forwarded message ----------",
      "From: Ada <ada@northwind.example>",
      "Subject: Northwind Robotics — seed",
      "",
      "#wpdealflow we are raising",
    ].join("\n");
    const out = classifyInbound({
      to: INTAKE_MAILBOX,
      from: "scooter@westpeek.ventures",
      subject: "Re: Fwd: Northwind Robotics",
      body: forwarded,
      references: "<abc@mail.example>",
    });
    expect(out.triggers, "a forward still routes from its forwarded body").toEqual(["#wpdealflow"]);
    expect(out.quotedOnly ?? []).toEqual([]);
  });

  it("knows a reply from a fresh message from a forward", () => {
    expect(isReplyMessage({ inReplyTo: "<a@b>" })).toBe(true);
    expect(isReplyMessage({ references: "<a@b>" })).toBe(true);
    expect(isReplyMessage({ subject: "Re: the thing" })).toBe(true);
    expect(isReplyMessage({ subject: "the thing" })).toBe(false);
    expect(isReplyMessage({ inReplyTo: "<a@b>", subject: "Fwd: the thing" }), "a forward is never a reply").toBe(false);
    expect(isReplyMessage({ inReplyTo: "<a@b>", subject: "Re: Fwd: the thing" })).toBe(false);
  });

  it("splits on every quoting convention that actually arrives, and keeps the quoted half", () => {
    for (const marker of [
      "On Mon, 21 Sep 2026 at 10:02, Walker <w@x.example> wrote:",
      "-----Original Message-----",
      "________________________________",
      "> the whole original",
      "Begin forwarded message:",
    ]) {
      const split = splitQuoted(`not this one\n\n${marker}\nthe original said #wpdealflow`);
      expect(split.written.trim(), marker).toBe("not this one");
      expect(split.hasQuote).toBe(true);
      expect(split.quoted, "the quoted half is kept, never discarded").toContain("#wpdealflow");
    }
    // Nothing to split is not a failure: the whole body is what they wrote.
    const plain = writtenAndQuoted("From: x\n\njust a sentence", { subject: "Re: x", inReplyTo: "<a@b>" });
    expect(plain.written.trim()).toBe("just a sentence");
    expect(plain.hasQuote).toBe(false);
  });
});

describe("a reply is matched to its conversation by References, never by a provider id", () => {
  it("carries a token out and recognises it coming back, in either header and at any depth", () => {
    const token = mintThreadToken();
    expect(token).toMatch(/^wpt_[0-9a-f]{32}$/);
    expect(threadHeaders(token)).toEqual({
      References: `<${token}@joinwestpeek.com>`,
      "In-Reply-To": `<${token}@joinwestpeek.com>`,
    });

    expect(threadTokensIn({ inReplyTo: threadReference(token) })).toEqual([token]);
    expect(threadTokensIn({ references: threadReference(token) })).toEqual([token]);
    // A long thread: References is chronological, so the NEWEST of our messages wins.
    const older = mintThreadToken();
    expect(
      threadTokensIn({ references: `<x@mail.example> ${threadReference(older)} <y@mail.example> ${threadReference(token)}` })[0],
    ).toBe(token);
    // An ordinary email carries none, and that is the "do nothing at all" case.
    expect(threadTokensIn({ references: "<x@mail.example> <y@mail.example>" })).toEqual([]);
  });

  it("stores what he WROTE against the KIND of work, and refuses an unauthenticated sender", async () => {
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: "wc_hire_w39",
      cardKind: "PRODUCTIONS_HIRE_SEARCH",
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search — 2 candidate(s) this week",
      firmScope: "west-peek",
    });

    const note = "1. Jordan Example — Senior Experiential Producer\n   Opening line for you: \"…\"\n#wpdealflow was never in here but pretend it was";
    const raw = gmailReply("stop showing me agency people, I want independents", note);

    // ── A SENDER THE RESOLVER DID NOT AUTHENTICATE STEERS NOTHING ────────────────────────────
    const forged = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: BAD_AUTH,
      subject: "Re: Walker: hire search",
      raw,
      inReplyTo: threadReference(token),
      references: null, emlKey: null,
    });
    expect(forged.steered).toBe(false);
    expect(forged.reason).toMatch(/not accepted as coming from a Managing Partner/);
    const nothingYet = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_steer").first<{ n: number }>();
    expect(nothingYet!.n).toBe(0);

    // ── AND THE REAL ONE ─────────────────────────────────────────────────────────────────────
    const ok = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: GOOD_AUTH,
      subject: "Re: Walker: hire search",
      raw,
      inReplyTo: threadReference(token),
      references: null, emlKey: null,
    });
    expect(ok.steered).toBe(true);
    expect(ok.thread!.card_kind).toBe("PRODUCTIONS_HIRE_SEARCH");
    expect(ok.written, "his words, and not one line of the note he was quoting").toBe(
      "stop showing me agency people, I want independents",
    );
    expect(ok.written).not.toMatch(/Jordan Example|Opening line/);

    const rows = (await env.WP_OS_DB.prepare("SELECT card_kind, said_by, body FROM work_steer").all<{ card_kind: string; said_by: string; body: string }>()).results!;
    expect(rows).toEqual([
      { card_kind: "PRODUCTIONS_HIRE_SEARCH", said_by: "scooter@westpeek.ventures", body: "stop showing me agency people, I want independents" },
    ]);

    // A token we have no record of is a person's problem, not a guess.
    const stranger = await steerFromReply(env, {
      fromHeader: SCOOTER_FROM,
      authenticationResults: GOOD_AUTH,
      subject: "Re: something",
      raw,
      inReplyTo: `<${mintThreadToken()}@joinwestpeek.com>`,
      references: null, emlKey: null,
    });
    expect(stranger.steered).toBe(false);
    expect(stranger.reason).toMatch(/does not have a record of/);
  });

  it("HIS WORDS REACH A REASONING MODEL before the next week's search runs", async () => {
    /*
     * THE ASSERTION THAT MATTERS, and the one that would otherwise have been assumed.
     *
     * `steerFor` reads notes on the card it is given. Next Monday's card is a NEW row with no notes
     * on it, so unless the standing steer is carried in as `extra`, everything above is stored,
     * acknowledged and read by nothing. This proves the words are in the prompt a model is handed.
     */
    const extra = await standingSteer(env, "PRODUCTIONS_HIRE_SEARCH");
    expect(extra, "the reply is carried to a card that did not exist when it arrived").toHaveLength(1);
    expect(extra[0]!.text).toBe("stop showing me agency people, I want independents");
    expect(extra[0]!.who).toMatch(/^Scooter Taylor \(replied \d{4}-\d{2}-\d{2}\)$/);

    /*
     * NEXT MONDAY'S CARD, OPENED AFTER the reply arrived — which is the whole point. The card he
     * replied to is closed; this row did not exist when he wrote. If the words do not reach here,
     * nothing he says ever changes a search.
     */
    const { openHireSearchCard } = await import("../src/worker/services/productionsHire");
    const nextWeek = await openHireSearchCard(env, new Date("2026-09-28T14:00:00.000Z"));
    expect(nextWeek.opened).toBe(true);
    const noNotes = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_note WHERE work_card_id = ?1").bind(nextWeek.cardId).first<{ n: number }>();
    expect(noNotes!.n, "and it carries no notes of its own").toBe(0);

    const prompts: string[] = [];
    const steer = await steerFor(
      env,
      ACTOR,
      {
        cardId: nextWeek.cardId,
        cardKind: "PRODUCTIONS_HIRE_SEARCH",
        title: nextWeek.title,
        employee: "Walker",
        chain: "the weekly hire search for West Peek Productions",
        steps: ["Run one live search", "Judge each candidate", "Send him one email"],
        firmScope: "west-peek",
        extra,
      },
      async (_e, _a, prompt) => {
        prompts.push(prompt);
        return {
          ok: true,
          // The interpreter's real answer shape: labelled lines, not JSON. See parseInterpretation.
          text: [
            "UNDERSTOOD: Only independent producers from now on — no agency staff.",
            "STEER: Exclude anybody whose current employer is an experiential agency.",
            "CANNOT: none",
          ].join("\n"),
          aiRunId: null,
          model: "test-model",
          detail: "COMPLETED",
        };
      },
    );

    expect(prompts, "a model was actually called").toHaveLength(1);
    expect(prompts[0], "what he wrote is in the prompt, verbatim").toContain(
      "stop showing me agency people, I want independents",
    );
    expect(prompts[0], "and so is who said it").toContain("Scooter Taylor");
    expect(steer.cannot).toEqual([]);
    expect(steer.text, "and the interpretation reaches every stage of the search").toContain(
      "Exclude anybody whose current employer is an experiential agency",
    );
    // What the note will say back to him, so the promise "I will say back what I understood it to
    // mean" is one he can see kept.
    expect(steer.interpretation!.understood).toMatch(/Only independent producers/);
  });

  it("AND THE RUNNER ACTUALLY PASSES IT: next Monday's search prompt carries what he replied", async () => {
    /*
     * THE GUARD THAT CATCHES THE ONE-LINE REGRESSION.
     *
     * `validate:instructions` proves every chain calls `steerFor`. It cannot see whether the hire
     * search hands it the STANDING steer, and without that the reply is stored, interpreted on a
     * card nobody reads, and never reaches a search — the whole path inert while every other check
     * still passes. Proven negatively on 17 Sep 2026 by replacing `standingSteer(...)` with `[]`:
     * nothing else in the repo failed. This does.
     */
    const { runHireSearchCard, openHireSearchCard } = await import("../src/worker/services/productionsHire");
    // A week later again, so the interpretation is not served from the previous test's cache: the
    // point is that a card opened long after the reply still reaches a model with his words.
    const opened = await openHireSearchCard(env, new Date("2026-10-05T14:00:00.000Z"));
    const card = await env.WP_OS_DB.prepare(
      "SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email FROM work_card WHERE id = ?1",
    ).bind(opened.cardId).first<{ id: string; title: string; kind: string; owner_id: string; state: string; work_attempts: number; firm_scope: string; requested_by_email: string | null }>();

    const searchPrompts: string[] = [];
    const interpreted: string[] = [];
    await runHireSearchCard(env, card!, {
      now: new Date("2026-10-05T14:05:00.000Z"),
      urlStatus: async () => 200,
      search: async (_e, _a, prompt) => {
        searchPrompts.push(prompt);
        return { ok: false, text: "", detail: "stopped here on purpose — the prompt is the assertion" };
      },
      judge: async () => ({ ok: false, text: "", detail: "not reached" }),
      interpret: async (_e, _a, prompt) => {
        interpreted.push(prompt);
        return {
          ok: true,
          text: [
            "UNDERSTOOD: Only independent producers — no agency staff.",
            "STEER: Exclude anybody whose current employer is an experiential agency.",
            "CANNOT: none",
          ].join("\n"),
          aiRunId: null,
          model: "test-model",
          detail: "COMPLETED",
        };
      },
    });

    expect(interpreted, "the interpreter was called for next week's card").toHaveLength(1);
    expect(interpreted[0], "his reply is what it was asked to read").toContain(
      "stop showing me agency people, I want independents",
    );
    expect(searchPrompts.length, "the search ran").toBeGreaterThan(0);
    expect(searchPrompts[0], "and the steer is at the top of the search prompt").toContain(
      "Exclude anybody whose current employer is an experiential agency",
    );
  });
});

describe("one email is filed once, and only his own new words reach a model (wc_bd8b68cb, 15 Nov 2026)", () => {
  const NAMES = Array.from({ length: 59 }, (_, i) => `- Example Organisation ${i + 1}${i % 7 === 0 ? " (also 2021)" : ""}`);
  const HIS_WORDS = ["Hey Walker!", "", "Can you check these past clients against the criteria and flag which ones fit?", "", ...NAMES, "", "Let me know which ones fit and I'll take it from there."].join("\n");
  /** Gmail's real shape on 14 Nov: a sign-off, then an attribution WRAPPED over two lines, then the quote. */
  const raw = [
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    `To: ${INTAKE_MAILBOX}`,
    "Subject: Re: Walker: West Peek Productions in November",
    "",
    HIS_WORDS,
    "",
    "Best,",
    "Scooter",
    "",
    "On Fri, Nov 13, 2026 at 11:32 PM Walker · West Peek <walker@joinwestpeek.com>",
    "wrote:",
    "",
    "> Here is November: 4 leads and 2 pitches.",
    "> ---------- Forwarded message ---------",
    "> earlier history",
  ].join("\n");

  it("a second read of the same Message-ID files nothing more; his words are stored verbatim, every name kept, nothing quoted", async () => {
    const { token } = await startThread(env, {
      objectType: "work_card",
      objectId: "wc_productions_month_test",
      cardKind: "PRODUCTIONS_ONCE_TEST",
      employee: "Walker",
      to: "scooter@westpeek.ventures",
      subject: "Walker: West Peek Productions in November",
      firmScope: "west-peek",
    });
    const read = (messageId: string) =>
      steerFromReply(env, { fromHeader: SCOOTER_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Walker: West Peek Productions in November", raw, inReplyTo: threadReference(token), references: null, emlKey: null, messageId });
    for (let k = 0; k < 4; k++) expect((await read("CAOWoBQ-same-reply@mail.gmail.com")).steered).toBe(true);
    const rows = (await env.WP_OS_DB.prepare("SELECT body FROM work_steer WHERE card_kind = 'PRODUCTIONS_ONCE_TEST'").all<{ body: string }>()).results!;
    expect(rows, "four reads of one email, one steer").toHaveLength(1);
    expect(rows[0]!.body, "his own words, verbatim: no sign-off, no wrapped attribution, no quote").toBe(HIS_WORDS);
    for (const n of NAMES) expect(rows[0]!.body).toContain(n);
    // A different email on the same thread is a new steer.
    await read("CAOWoBQ-a-second-reply@mail.gmail.com");
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_steer WHERE card_kind = 'PRODUCTIONS_ONCE_TEST'").first<{ n: number }>())!.n).toBe(2);
  });

  it("a reply filed before this fix, with the quoted history still on it, reaches the model as his words only", async () => {
    const legacy = `${HIS_WORDS}\n\nBest,\nScooter\n\nOn Fri, Nov 13, 2026 at 11:32 PM Walker · West Peek <walker@joinwestpeek.com>\nwrote:`;
    await env.WP_OS_DB.prepare("INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, thread_token, firm_scope) VALUES ('wst_legacy_quoted', 'PRODUCTIONS_LEGACY_TEST', NULL, 'scooter@westpeek.ventures', ?1, 'tok_legacy', 'west-peek')")
      .bind(legacy).run();
    const pieces = await standingSteer(env, "PRODUCTIONS_LEGACY_TEST");
    expect(pieces.map((p) => p.text)).toEqual([HIS_WORDS]);
  });
});

describe("a voice note on a partner's reply is his words (wc_c548d043, 15 Nov 2026)", () => {
  const AUDIO = btoa("not really audio, but bytes a phone attached");
  const mime = (boundary: string) => [
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    `To: ${INTAKE_MAILBOX}`,
    "Subject: Re: Porter: New preview ready",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Recording attached.",
    "",
    `--${boundary}`,
    'Content-Type: audio/mp4; name="New Recording 4.m4a"',
    'Content-Disposition: attachment; filename="New Recording 4.m4a"',
    "Content-Transfer-Encoding: base64",
    "",
    AUDIO,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  async function thread(kind: string): Promise<string> {
    return (await startThread(env, { objectType: "work_card", objectId: `wc_voice_${kind}`, cardKind: kind, employee: "Porter", to: "scooter@westpeek.ventures", subject: "Porter: New preview ready", firmScope: "west-peek" })).token;
  }

  it("the recording is transcribed on the platform's no-training route and its words are the steer", async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const AI = { run: async (model: string, input: Record<string, unknown>) => { calls.push({ model, input }); return { results: { channels: [{ alternatives: [{ transcript: "Make the hero say Community as a Service, and move the pricing below the case studies." }] }] } }; } };
    const token = await thread("VOICE_HEARD_TEST");
    const out = await steerFromReply({ ...env, AI } as Env, { fromHeader: SCOOTER_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Porter: New preview ready", raw: mime("b1"), inReplyTo: threadReference(token), references: null, emlKey: null, messageId: "voice-heard@mail.gmail.com" });
    expect(out.steered).toBe(true);
    expect(calls, "one recording, one transcription").toHaveLength(1);
    expect(calls[0]!.input.mip_opt_out, "never anybody's training data").toBe(true);
    expect((calls[0]!.input.audio as { contentType: string }).contentType).toBe("audio/mp4");
    const body = (await env.WP_OS_DB.prepare("SELECT body FROM work_steer WHERE card_kind = 'VOICE_HEARD_TEST'").first<{ body: string }>())!.body;
    expect(body).toContain("Recording attached.");
    expect(body, "his spoken words, verbatim").toContain("Make the hero say Community as a Service, and move the pricing below the case studies.");
  });

  it("with no route that may hear it, the recording is a named stop on the record, never silence", async () => {
    const token = await thread("VOICE_UNHEARD_TEST");
    const noAi = { ...env, AI: undefined } as Env;
    await steerFromReply(noAi, { fromHeader: SCOOTER_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Porter: New preview ready", raw: mime("b2"), inReplyTo: threadReference(token), references: null, emlKey: null, messageId: "voice-unheard@mail.gmail.com" });
    const stop = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.voice_note_not_transcribed' AND object_id = 'wc_voice_VOICE_UNHEARD_TEST'").first<{ payload_json: string }>();
    expect(stop, "a named stop").not.toBeNull();
    expect(stop!.payload_json).toContain("New Recording 4.m4a");
    const told = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE object_id = 'wc_voice_VOICE_UNHEARD_TEST' AND firm_user_id = 'fu_sequoia_taylor'").first<{ n: number }>();
    expect(Number(told!.n), "on Sequoia's desk").toBeGreaterThan(0);
  });
});

describe("a partner is never left in silence on a long job (wc_bd8b68cb, 15 Nov 2026)", () => {
  it("a reply that starts a run is told when to expect it, once per email, and told once more if that time passes", async () => {
    const { tellSlipped } = await import("../src/worker/services/partnerProgress");
    const cardId = "wc_progress_test";
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, kind, owner_type, owner_id, state, firm_scope, created_by) VALUES (?1, 'Walker: West Peek Productions this month (2099-02)', 'PROGRESS_TEST', 'AI', 'aie_walker', 'OPEN', 'west-peek', 'system:test')").bind(cardId).run();
    const { token } = await startThread(env, { objectType: "work_card", objectId: cardId, cardKind: "PROGRESS_TEST", employee: "Walker", to: "scooter@westpeek.ventures", subject: "Walker: November", firmScope: "west-peek" });
    const reply = (messageId: string) => steerFromReply(env, { fromHeader: SCOOTER_FROM, authenticationResults: GOOD_AUTH, subject: "Re: Walker: November", raw: gmailReply("Can you check these 59 past clients today?", "the note"), inReplyTo: threadReference(token), references: null, emlKey: null, messageId });
    const count = async (type: string) => Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type = ?2").bind(cardId, type).first<{ n: number }>())!.n);
    await reply("progress-1@mail.gmail.com");
    await reply("progress-1@mail.gmail.com");
    expect(await count("work_card.partner_told_started"), "one note for the email he sent, however often it is read").toBe(1);
    const started = JSON.parse((await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.partner_told_started'").bind(cardId).first<{ payload_json: string }>())!.payload_json) as { expect_by: string; thread: string };
    expect(started.thread, "on his own thread").toBe(token);
    // Before the promised time nothing more is said; after it, once.
    await tellSlipped(env, new Date(Date.parse(started.expect_by) - 60_000));
    expect(await count("work_card.partner_told_slipped")).toBe(0);
    await tellSlipped(env, new Date(Date.parse(started.expect_by) + 60_000));
    await tellSlipped(env, new Date(Date.parse(started.expect_by) + 120_000));
    expect(await count("work_card.partner_told_slipped"), "one 'taking longer' note, never a stream").toBe(1);
    // A finished card is not chased.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(cardId).run();
  });
});
