import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import {
  parseActionabilityVerdict,
  runWebPropertyChangeCard,
  type ActionabilityClassifier,
} from "../src/worker/services/webPropertyChange";
import { recentBanterContext, type BanterReplyGenerator } from "../src/worker/services/banterReply";
import { EMPLOYEE_PERSONAS } from "../src/shared/registry/aiEmployeePersonas";
import { purgeNoActionCards } from "../src/worker/services/noActionPurge";
import type { SweepCard } from "../src/worker/services/workSweep";
import { parseQuestionAnswer, type QuestionAnswerer } from "../src/worker/services/questionRouting";

/**
 * ADDENDUM 10/11/11.1 (22 Sep 2026): banter and plain questions do not reach the Mac, and the
 * sender's own chief of staff banters back before a caught card resolves.
 *
 * THE REAL INCIDENT THIS GUARDS. Scooter replied to a thread with pure banter —
 * "'on our side' -- we're all one team :)" — and it opened a WEB_PROPERTY_CHANGE card that
 * dispatched a PLAN run to her Mac, which came back: "I can't find 'on our side' anywhere on
 * joinwestpeek.com. I searched every page." A wasted Claude Code invocation on nothing.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUvW1";

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  const deletes: string[] = [];
  return {
    store,
    deletes,
    put: async (key: string, body: ArrayBuffer | Uint8Array | string) => {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer, text: async () => new TextDecoder().decode(b) } : null;
    },
    delete: async (key: string) => {
      deletes.push(key);
      store.delete(key);
    },
  };
}
let bucket: ReturnType<typeof fakeBucket>;

async function card(id: string): Promise<Record<string, unknown> | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>();
}

async function liveJobFor(cardId: string) {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status IN ('QUEUED','CLAIMED')",
  )
    .bind(cardId)
    .first<Record<string, unknown>>();
}

async function eventsFor(cardId: string, eventType?: string) {
  const rows = await env.WP_OS_DB.prepare(
    eventType
      ? "SELECT * FROM event_record WHERE object_id = ?1 AND event_type = ?2 ORDER BY created_at"
      : "SELECT * FROM event_record WHERE object_id = ?1 ORDER BY created_at",
  )
    .bind(...(eventType ? [cardId, eventType] : [cardId]))
    .all<{ event_type: string; payload_json: string }>();
  return rows.results ?? [];
}

/** Opens a real WEB_PROPERTY_CHANGE card through the actual door, the way production does. */
async function openPropertyCard(subject: string, partnerAddress: string, chiefOfStaff: string, messageBody: string): Promise<string> {
  const raw = `${messageBody}\n\nPackage: https://drive.google.com/drive/folders/${FOLDER}?usp=sharing\nfor westpeek.ventures\n`;
  const chiefCardId = await openAssignmentCard(env, { subject, partnerAddress, chiefOfStaff, raw, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const chief = (await card(chiefCardId))!;
  const m = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String(chief.description));
  expect(m, "the door hands a property change on to Porter").not.toBeNull();
  return m![1]!;
}

function sweepCardFor(id: string, requestedByEmail: string): SweepCard {
  return { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: requestedByEmail };
}

function fixedClassifier(verdict: "ACTIONABLE_WORK" | "QUESTION_NEEDS_REPLY" | "BANTER_NO_ACTION", reason = "test-fixed"): ActionabilityClassifier {
  return async () => ({ verdict, reason, aiRunId: null });
}

const neverReply: BanterReplyGenerator = async () => ({ shouldReply: false, line: null, aiRunId: null });

/** Addendum 12: an explicit "nobody had a confident answer" fixture, rather than leaning on mockLocal's unparseable output. */
const noConfidentAnswer: QuestionAnswerer = async () => ({ confident: false, answer: null, reason: "test-fixed: not confident", aiRunId: null });
/** Addendum 12: a fixed confident answer, in Porter's own words, for exercising the auto-answer path deterministically. */
function confidentAnswer(answer: string, reason = "test-fixed: confident"): QuestionAnswerer {
  return async () => ({ confident: true, answer, reason, aiRunId: null });
}

beforeAll(async () => {
  t = await createTestDb();
  bucket = fakeBucket();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: bucket as never,
  } as Partial<Env>);
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

// ── Pure function: the bias is in the parser itself ─────────────────────────────────────────────

describe("parseActionabilityVerdict — the bias toward ACTIONABLE_WORK", () => {
  it("reads a clean model answer for each of the three verdicts", () => {
    expect(parseActionabilityVerdict("VERDICT: BANTER_NO_ACTION\nREASON: pure banter, nothing to do").verdict).toBe("BANTER_NO_ACTION");
    expect(parseActionabilityVerdict("VERDICT: QUESTION_NEEDS_REPLY\nREASON: a plain question").verdict).toBe("QUESTION_NEEDS_REPLY");
    expect(parseActionabilityVerdict("VERDICT: ACTIONABLE_WORK\nREASON: a real ask").verdict).toBe("ACTIONABLE_WORK");
  });

  it("defaults to ACTIONABLE_WORK on garbled, empty, or unparseable output — the ambiguous case", () => {
    expect(parseActionabilityVerdict("").verdict).toBe("ACTIONABLE_WORK");
    expect(parseActionabilityVerdict(null).verdict).toBe("ACTIONABLE_WORK");
    expect(parseActionabilityVerdict("I'm not totally sure what to make of this one, honestly.").verdict).toBe("ACTIONABLE_WORK");
    expect(parseActionabilityVerdict("[mock-local abc123] Deterministic local draft for purpose \"x\". No data left this system.").verdict).toBe("ACTIONABLE_WORK");
  });
});

// ── Routing: given a verdict, does the system do the right thing before the Mac ever sees it ────

describe("BANTER_NO_ACTION resolves without ever reaching the Mac", () => {
  let cardId = "";

  it("the banter-only message (the real incident, verbatim) never dispatches a PLAN run", async () => {
    cardId = await openPropertyCard("re: site", SCOOTER, "Walker", "'on our side' -- we're all one team :)");
    const before = (await card(cardId))!;
    expect(before.state).toBe("OPEN");

    const out = await runWebPropertyChangeCard(env, sweepCardFor(cardId, SCOOTER), fixedClassifier("BANTER_NO_ACTION", "pure banter, a joke about being one team"), neverReply);
    expect(out.autoResolved).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.finished).toBe(false);

    // THE ASSERTION THAT MATTERS: no Mac dispatch call happened.
    expect(await liveJobFor(cardId)).toBeNull();

    const after = (await card(cardId))!;
    expect(after.state).toBe("CANCELLED");
    expect(after.auto_resolution).toBe("NO_ACTION_NEEDED");
  });

  it("is a distinct outcome from a real DONE — queryable and distinguishable in the record", async () => {
    const row = (await card(cardId))!;
    expect(row.state).not.toBe("DONE");
    expect(row.auto_resolution).toBe("NO_ACTION_NEEDED");
    // A real finished card carries NO auto_resolution at all.
    const real = await env.WP_OS_DB.prepare("SELECT auto_resolution FROM work_card WHERE state = 'DONE' LIMIT 1").first<{ auto_resolution: string | null } | null>();
    if (real) expect(real.auto_resolution).toBeNull();
  });

  it("writes an event_record audit row with the classification reasoning, briefly", async () => {
    const events = await eventsFor(cardId, "work_card.auto_resolved_no_action");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload_json) as { reason: string };
    expect(payload.reason).toContain("pure banter");
  });

  it("is fully recoverable — reopenable through the existing put-back door, same as any DONE/CANCELLED card", async () => {
    const res = await handleRequest(
      new Request(`https://test.local/api/work-cards/${cardId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-wpos-dev-user": SCOOTER },
        body: JSON.stringify({ state: "OPEN" }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const row = (await card(cardId))!;
    expect(row.state).toBe("OPEN");
  });
});

describe("ACTIONABLE_WORK proceeds to the Mac exactly as today", () => {
  it("a real request, even casually worded, dispatches PLAN unchanged", async () => {
    const cardId = await openPropertyCard("broken link", SCOOTER, "Walker", "hey can you fix the broken link on the homepage lol");
    const out = await runWebPropertyChangeCard(env, sweepCardFor(cardId, SCOOTER), fixedClassifier("ACTIONABLE_WORK", "a real request to fix a broken link"), neverReply);
    expect(out.autoResolved ?? false).toBe(false);
    expect(out.blocked).toBe(false);
    // THE ASSERTION THAT MATTERS: the Mac dispatch path IS reached.
    const job = await liveJobFor(cardId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("QUEUED");
    const payload = JSON.parse(String(job!.job_json)) as { phase: string };
    expect(payload.phase).toBe("PLAN");
    const row = (await card(cardId))!;
    expect(row.state).not.toBe("CANCELLED");
    expect(row.auto_resolution).toBeNull();
  });

  it("an ambiguous/borderline message — a genuinely garbled model answer — defaults to actionable and is NOT auto-resolved", async () => {
    const cardId = await openPropertyCard("hmm", SEQUOIA, "Wren", "hmm, not sure about this one, what do you think");
    // Exercises the REAL parser (not a hand-picked verdict) against a model response that does not
    // cleanly say BANTER or QUESTION — exactly the "ambiguous, could be misread" case the bias rule
    // exists for.
    const ambiguousModelAnswer = "I could see this either way, it's genuinely unclear what they want here.";
    const classify: ActionabilityClassifier = async () => parseActionabilityVerdict(ambiguousModelAnswer) as { verdict: "ACTIONABLE_WORK"; reason: string; aiRunId: null };
    const out = await runWebPropertyChangeCard(env, sweepCardFor(cardId, SEQUOIA), async (e, i) => ({ ...(await classify(e, i)), aiRunId: null }), neverReply);
    expect(out.autoResolved ?? false).toBe(false);
    expect(await liveJobFor(cardId)).not.toBeNull();
    const row = (await card(cardId))!;
    expect(row.auto_resolution).toBeNull();
  });
});

describe("QUESTION_NEEDS_REPLY skips the Mac and reuses the existing needs-a-reply block", () => {
  it("a plain question (verbatim from wc_9374245b) blocks with a_question_for_you, never dispatching PLAN", async () => {
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "explain it like a sixth grader, what are you asking of me?");
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question, nothing to build"),
      neverReply,
      // Addendum 12: routing is tried first (Porter owns WEB_PROPERTY_CHANGE) and explicitly
      // declines here, so this test proves the escalation path on its own terms rather than
      // leaning on mockLocal's incidentally-unparseable output.
      noConfidentAnswer,
    );
    expect(out.blocked).toBe(true);
    expect(out.autoResolved ?? false).toBe(false);
    expect(out.questionAnswered ?? false).toBe(false);
    // THE ASSERTION THAT MATTERS: no Mac dispatch call happens for a question either.
    expect(await liveJobFor(cardId)).toBeNull();

    const row = (await card(cardId))!;
    expect(row.state).toBe("BLOCKED");
    expect(row.block_reason).toBe("a_question_for_you");
    expect(row.auto_resolution).toBeNull();
    expect(row.question_auto_answered_at).toBeNull();

    const events = await eventsFor(cardId, "work_card.classified_as_question");
    expect(events.length).toBe(1);
  });
});

// ── Addendum 12: a question tries its owner before it tries her ─────────────────────────────────

describe("QUESTION_NEEDS_REPLY tries the kind's owner first, and escalates only when unsure", () => {
  it("a not-confident answer (any reason) escalates to a_question_for_you exactly as before, with an audit event naming who was tried", async () => {
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "what does 'publish ready' actually mean here?");
    sent.length = 0;
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question about a term"),
      neverReply,
      noConfidentAnswer,
    );
    expect(out.blocked).toBe(true);
    expect(out.questionAnswered ?? false).toBe(false);
    expect(await liveJobFor(cardId)).toBeNull();
    // THE ASSERTION THAT MATTERS: nothing was sent — an unconfident answer never reaches the partner.
    expect(sent.length).toBe(0);

    const row = (await card(cardId))!;
    expect(row.state).toBe("BLOCKED");
    expect(row.block_reason).toBe("a_question_for_you");
    expect(row.question_auto_answered_at).toBeNull();
    // The block itself is honest that routing was tried and declined.
    expect(String(row.block_needed)).toContain("Porter looked at it first");

    const escalated = await eventsFor(cardId, "work_card.question_answer_escalated");
    expect(escalated.length).toBe(1);
    const payload = JSON.parse(escalated[0]!.payload_json) as { tried_employee: string; reason: string };
    expect(payload.tried_employee).toBe("Porter");
    expect(payload.reason).toBe("test-fixed: not confident");
  });

  it("a CONFIDENT answer resolves the card and never blocks or dispatches PLAN — and by default (the dial's own zero-row default is ON, 0228) it is filed for her to see first rather than sent straight out", async () => {
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "does the westpeek.ventures preview link expire?");
    sent.length = 0;
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question about how previews work"),
      neverReply,
      confidentAnswer("No — a Cloudflare Pages preview link stays live for as long as the branch does."),
    );
    expect(out.blocked).toBe(false);
    expect(out.finished).toBe(false);
    expect(out.questionAnswered).toBe(true);
    // THE ASSERTION THAT MATTERS, PART ONE: never reaches the Mac.
    expect(await liveJobFor(cardId)).toBeNull();

    const row = (await card(cardId))!;
    // THE ASSERTION THAT MATTERS, PART TWO: resolved, not left waiting on her as a BLOCKED card.
    expect(row.state).toBe("CANCELLED");
    expect(row.block_reason).toBeNull();
    expect(row.auto_resolution).toBeNull(); // never mislabelled as banter's NO_ACTION_NEEDED
    expect(row.question_auto_answered_at).not.toBeNull();

    // THE ASSERTION THAT MATTERS, PART THREE: the answer went through the normal send/preview
    // door, and the dial's default (ON, nobody has touched it yet) filed it for HER rather than
    // sending it to the partner — exactly the "tail every partner-facing email" default Addendum 8
    // decided. `filePreview` itself emails the owner (her) that something is waiting; that is the
    // one send this tick produces, and it must never go to the partner who asked the question.
    expect(sent.filter((s) => s.to === SCOOTER)).toEqual([]);
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(SEQUOIA);
    const previews = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM preview_approval WHERE work_card_id = ?1").bind(cardId).first<{ n: number }>();
    expect(previews?.n ?? 0).toBe(1);

    const answered = await eventsFor(cardId, "work_card.question_auto_answered");
    expect(answered.length).toBe(1);
    const payload = JSON.parse(answered[0]!.payload_json) as { employee: string; sent: boolean };
    expect(payload.employee).toBe("Porter");
    expect(payload.sent).toBe(false); // filed, not sent — that IS the correct outcome with the dial on
  });

  it("with the firm-wide dial explicitly OFF and the card's own tick unset, a CONFIDENT answer sends straight to the partner", async () => {
    // `email_preview_preference` is append-only/versioned (0228: UPDATE and DELETE are both
    // rejected by trigger) — the same shape `mp_home_preference` uses. A new version is how the
    // dial is ever moved, in tests exactly as in production; version 1 is free because nothing
    // earlier in this file has written to this table yet.
    await env.WP_OS_DB.prepare(
      "INSERT INTO email_preview_preference (id, version_no, preview_all_partner_emails, set_by, firm_scope) VALUES ('epp_test_off', 1, 0, 'fu_sequoia_taylor', 'west-peek')",
    ).run();
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "does the westpeek.ventures preview link expire?");
    sent.length = 0;
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question about how previews work"),
      neverReply,
      confidentAnswer("No — a Cloudflare Pages preview link stays live for as long as the branch does."),
    );
    expect(out.questionAnswered).toBe(true);

    const row = (await card(cardId))!;
    expect(row.state).toBe("CANCELLED");
    expect(row.question_auto_answered_at).not.toBeNull();

    // THE ASSERTION THAT MATTERS: once she has turned tailing off, the answer reaches the
    // partner directly — the whole point of the dial being hers to flip (Addendum 8).
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(SCOOTER);
    expect(sent[0]!.subject.startsWith("Porter: ")).toBe(true);
    expect(sent[0]!.text).toContain("Cloudflare Pages preview link stays live");

    const answered = await eventsFor(cardId, "work_card.question_auto_answered");
    expect(answered.length).toBe(1);
    const payload = JSON.parse(answered[0]!.payload_json) as { employee: string; sent: boolean };
    expect(payload.sent).toBe(true);
  });

  it("a wrong-answer-sent-instead-of-escalated regression would be caught: a confident answer with no answer text is treated as not confident", async () => {
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "what happens if the build fails twice?");
    sent.length = 0;
    // Simulates a malformed model reply — CONFIDENT: yes but nothing to actually send.
    const malformed: QuestionAnswerer = async () => ({ confident: true, answer: "", reason: "malformed", aiRunId: null });
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question"),
      neverReply,
      malformed,
    );
    expect(out.questionAnswered ?? false).toBe(false);
    expect(out.blocked).toBe(true);
    expect(sent.length).toBe(0);
    const row = (await card(cardId))!;
    expect(row.state).toBe("BLOCKED");
    expect(row.question_auto_answered_at).toBeNull();
  });

  it("respects the firm-wide preview dial (0228) when explicitly moved back to ON, not just its zero-row default: even a confident answer is filed for approval rather than sent straight out", async () => {
    // Version 2 — the previous test in this file already wrote version 1 (OFF), and the table
    // rejects UPDATE/DELETE, so moving the dial back to ON is a new version, exactly as production
    // does it.
    await env.WP_OS_DB.prepare(
      "INSERT INTO email_preview_preference (id, version_no, preview_all_partner_emails, set_by, firm_scope) VALUES ('epp_test_on', 2, 1, 'fu_sequoia_taylor', 'west-peek')",
    ).run();
    const cardId = await openPropertyCard("huh?", SCOOTER, "Walker", "is the tagline change already live?");
    sent.length = 0;
    const out = await runWebPropertyChangeCard(
      env,
      sweepCardFor(cardId, SCOOTER),
      fixedClassifier("QUESTION_NEEDS_REPLY", "a plain question about status"),
      neverReply,
      confidentAnswer("Not yet — it ships with the next build."),
    );
    expect(out.questionAnswered).toBe(true);
    // THE ASSERTION THAT MATTERS: the dial gated it — nothing sent straight to the partner. (The
    // one send this tick produces is `filePreview`'s own notice to her that something is waiting.)
    expect(sent.filter((s) => s.to === SCOOTER)).toEqual([]);
    const previews = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM preview_approval WHERE work_card_id = ?1").bind(cardId).first<{ n: number }>();
    expect(previews?.n ?? 0).toBe(1);
    const row = (await card(cardId))!;
    expect(row.state).toBe("CANCELLED");
    expect(row.question_auto_answered_at).not.toBeNull();
  });
});

describe("parseQuestionAnswer — the bias toward not confident", () => {
  it("reads a clean CONFIDENT: yes answer", () => {
    const out = parseQuestionAnswer("CONFIDENT: yes\nANSWER: The preview link stays live indefinitely.\nREASON: Documented in the build script.");
    expect(out.confident).toBe(true);
    expect(out.answer).toBe("The preview link stays live indefinitely.");
  });

  it("reads CONFIDENT: no as not confident, with the reason kept", () => {
    const out = parseQuestionAnswer("CONFIDENT: no\nREASON: I don't actually know this one.");
    expect(out.confident).toBe(false);
    expect(out.answer).toBeNull();
    expect(out.reason).toContain("don't actually know");
  });

  it("defaults to not confident on garbled, empty or unparseable output — the ambiguous case", () => {
    expect(parseQuestionAnswer("").confident).toBe(false);
    expect(parseQuestionAnswer(null).confident).toBe(false);
    expect(parseQuestionAnswer("I'm honestly not sure how to answer this one.").confident).toBe(false);
    expect(parseQuestionAnswer('[mock-local abc123] Deterministic local draft for purpose "x". No data left this system.').confident).toBe(false);
  });

  it("treats a confident answer with no answer text as not confident", () => {
    const out = parseQuestionAnswer("CONFIDENT: yes\nANSWER: \nREASON: forgot to write one");
    expect(out.confident).toBe(false);
    expect(out.answer).toBeNull();
  });
});

// ── Addendum 11 / 11.1: the chiefs of staff banter back, judgement-guided ────────────────────────

describe("the sender's own chief of staff banters back", () => {
  it("Walker replies to Scooter's banter, in his own voice, and the send bypasses preview_approval entirely", async () => {
    const cardId = await openPropertyCard("banter", SCOOTER, "Walker", "lol true, we're all one team here");
    let seenVoice = "";
    let seenEmployee = "";
    const capturing: BanterReplyGenerator = async (_e, input) => {
      seenVoice = input.voice;
      seenEmployee = input.employeeName;
      return { shouldReply: true, line: "Ha, fair — back to it.", aiRunId: null };
    };
    sent.length = 0;
    await runWebPropertyChangeCard(env, sweepCardFor(cardId, SCOOTER), fixedClassifier("BANTER_NO_ACTION"), capturing);

    expect(seenEmployee).toBe("Walker");
    expect(seenVoice).toBe(EMPLOYEE_PERSONAS.find((p) => p.name === "Walker")!.voice);

    // Sent, in Walker's name, from the house format's own subject convention.
    expect(sent.length).toBe(1);
    expect(sent[0]!.subject.startsWith("Walker: ")).toBe(true);
    expect(sent[0]!.to).toBe(SCOOTER);

    // THE ASSERTION THAT MATTERS: no preview_approval PENDING row for this send.
    const previews = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM preview_approval WHERE work_card_id = ?1").bind(cardId).first<{ n: number }>();
    expect(previews?.n ?? 0).toBe(0);
  });

  it("Wren replies to Sequoia's banter, with the scoped sarcasm exception on, and Walker's tone is untouched", async () => {
    const scooterCard = await openPropertyCard("banter", SCOOTER, "Walker", "haha nice one");
    let walkerSarcastic: boolean | null = null;
    await runWebPropertyChangeCard(env, sweepCardFor(scooterCard, SCOOTER), fixedClassifier("BANTER_NO_ACTION"), async (_e, input) => {
      walkerSarcastic = input.sarcastic;
      return { shouldReply: true, line: "noted", aiRunId: null };
    });
    expect(walkerSarcastic).toBe(false);

    const sequoiaCard = await openPropertyCard("banter", SEQUOIA, "Wren", "you know it :)");
    let wrenSarcastic: boolean | null = null;
    let wrenVoice = "";
    await runWebPropertyChangeCard(env, sweepCardFor(sequoiaCard, SEQUOIA), fixedClassifier("BANTER_NO_ACTION"), async (_e, input) => {
      wrenSarcastic = input.sarcastic;
      wrenVoice = input.voice;
      return { shouldReply: true, line: "sure, whatever you say", aiRunId: null };
    });
    expect(wrenSarcastic).toBe(true);
    // Her core voice is untouched — the sarcasm is a prompt-time exception, not a rewrite of it.
    expect(wrenVoice).toBe(EMPLOYEE_PERSONAS.find((p) => p.name === "Wren")!.voice);
  });

  it("a model that decides to let it go quiet sends nothing, and records why", async () => {
    const cardId = await openPropertyCard("banter", SCOOTER, "Walker", "😂😂😂");
    sent.length = 0; // Clear the door's own RECEIVED note — this test is about the banter reply only.
    await runWebPropertyChangeCard(env, sweepCardFor(cardId, SCOOTER), fixedClassifier("BANTER_NO_ACTION"), neverReply);
    expect(sent.length).toBe(0);
    const events = await eventsFor(cardId, "work_card.banter_reply_skipped");
    expect(events.length).toBe(1);
  });
});

describe("recentBanterContext — the deterministic fact a real work item resets", () => {
  it("says so when there is no history at all", async () => {
    const text = await recentBanterContext(env, { firmScope: "west-peek", senderEmail: "nobody-yet@westpeek.ventures", excludeCardId: "wc_none" });
    expect(text).toContain("first message on record");
  });

  it("reports a clean slate right after a real (non-banter) card — the reset", async () => {
    const sender = "reset-check@westpeek.ventures";
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, kind, state, created_by, requested_by_email, firm_scope, auto_resolution) VALUES ('wc_reset_real', 'a real one', ?1, 'OPEN', 'system', ?2, 'west-peek', NULL)",
    )
      .bind(WEB_PROPERTY_CHANGE_KIND, sender)
      .run();
    const text = await recentBanterContext(env, { firmScope: "west-peek", senderEmail: sender, excludeCardId: "wc_reset_check" });
    expect(text).toContain("clean slate");
  });

  it("counts consecutive banter cards in a row, deterministically — this IS the fact pacing is guided by", async () => {
    const sender = "streak-check@westpeek.ventures";
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await env.WP_OS_DB.prepare(
        "INSERT INTO work_card (id, title, kind, state, created_by, requested_by_email, firm_scope, auto_resolution, created_at) VALUES (?1, 'banter', ?2, 'CANCELLED', 'system', ?3, 'west-peek', 'NO_ACTION_NEEDED', ?4)",
      )
        .bind(`wc_streak_${i}`, WEB_PROPERTY_CHANGE_KIND, sender, new Date(base + i * 1000).toISOString())
        .run();
    }
    const text = await recentBanterContext(env, { firmScope: "west-peek", senderEmail: sender, excludeCardId: "wc_streak_check" });
    expect(text).toContain("3 messages");
    expect(text).toContain("in a row");
  });
});

describe("INTAKE_JUDGMENT_STANDARD reaches both intake-facing generation calls", () => {
  it("is referenced by the classification prompt (webPropertyChange.ts) and the banter-reply prompt (banterReply.ts) in source — not vibes, provably wired", () => {
    const classifySrc = readFileSync(fileURLToPath(new URL("../src/worker/services/webPropertyChange.ts", import.meta.url)), "utf8");
    const classifyBody = classifySrc.slice(classifySrc.indexOf("const defaultClassifyActionability"), classifySrc.indexOf("if (run.status !== \"COMPLETED\" || !run.output_text) {"));
    expect(classifyBody).toContain("INTAKE_JUDGMENT_STANDARD");

    const replySrc = readFileSync(fileURLToPath(new URL("../src/worker/services/banterReply.ts", import.meta.url)), "utf8");
    const replyBody = replySrc.slice(replySrc.indexOf("const defaultGenerateBanterReply"));
    expect(replyBody).toContain("INTAKE_JUDGMENT_STANDARD");
  });

  it("no hardcoded reply-pacing counter or fixed redirect string survives in the banter-reply path (Addendum 11.1)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/worker/services/banterReply.ts", import.meta.url)), "utf8");
    expect(src).not.toContain("BANTER_REDIRECT_LINE");
    expect(src).not.toContain("gotta get back to work");
  });
});

// ── Addendum 10: the stowed section and its 30-day purge ─────────────────────────────────────────

describe("Record's Stowed filter", () => {
  it("excludes a stowed card from ALL/DONE/CANCELLED and surfaces it only under its own named STOWED filter", async () => {
    const cardId = await openPropertyCard("stow me", SCOOTER, "Walker", "sounds good, thanks!");
    await runWebPropertyChangeCard(env, sweepCardFor(cardId, SCOOTER), fixedClassifier("BANTER_NO_ACTION"), neverReply);

    const all = await handleRequest(new Request("https://test.local/api/work-cards/record?limit=200", { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    const allBody = (await all.json()) as { rows: Array<{ id: string }> };
    expect(allBody.rows.some((r) => r.id === cardId)).toBe(false);

    const dropped = await handleRequest(new Request("https://test.local/api/work-cards/record?state=CANCELLED&limit=200", { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    const droppedBody = (await dropped.json()) as { rows: Array<{ id: string }> };
    expect(droppedBody.rows.some((r) => r.id === cardId), "a stowed card is not a Drop").toBe(false);

    const stowed = await handleRequest(new Request("https://test.local/api/work-cards/record?state=STOWED&limit=200", { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    expect(stowed.status).toBe(200);
    const stowedBody = (await stowed.json()) as { rows: Array<{ id: string; auto_resolution: string | null }> };
    const row = stowedBody.rows.find((r) => r.id === cardId);
    expect(row, "the stowed card is reachable under its own named filter").toBeTruthy();
    expect(row!.auto_resolution).toBe("NO_ACTION_NEEDED");
  });
});

describe("the 30-day purge", () => {
  it("purges only NO_ACTION_NEEDED cards past 30 days, deletes their stored raw email, keeps event_record, and leaves a reopened card alone", async () => {
    const now = new Date("2026-10-22T09:20:00.000Z");
    const old = new Date(now.getTime() - 31 * 24 * 3600_000).toISOString();
    const recent = new Date(now.getTime() - 5 * 24 * 3600_000).toISOString();

    // A. Old enough, still stowed — must be purged, blob and all.
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, kind, state, created_by, firm_scope, auto_resolution, created_at) VALUES ('wc_purge_old', 'old banter', ?1, 'CANCELLED', 'system', 'west-peek', 'NO_ACTION_NEEDED', ?2)",
    )
      .bind(WEB_PROPERTY_CHANGE_KIND, old)
      .run();
    await env.WP_OS_DB.prepare(
      "INSERT INTO inbound_message (id, message_id, r2_key, from_address, received_at, work_card_id, firm_scope) VALUES ('inm_purge_old', 'msg-old', 'inbound-email/old.eml', 'someone@x.com', ?1, 'wc_purge_old', 'west-peek')",
    )
      .bind(old)
      .run();
    await bucket.put("inbound-email/old.eml", "raw message");
    const { appendEvent } = await import("../src/worker/events");
    await appendEvent(env, {
      eventType: "work_card.auto_resolved_no_action",
      actorType: "ai_employee",
      actorId: "aie_porter",
      objectType: "work_card",
      objectId: "wc_purge_old",
      firmScope: "west-peek",
      payload: { reason: "pure banter" },
    });

    // B. Old, but not stowed at all — real finished work must never be purged.
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, kind, state, created_by, firm_scope, auto_resolution, created_at) VALUES ('wc_purge_real', 'real finished work', ?1, 'DONE', 'system', 'west-peek', NULL, ?2)",
    )
      .bind(WEB_PROPERTY_CHANGE_KIND, old)
      .run();

    // C. Old and stowed, but REOPENED — a dispute within the window must exclude it from the purge.
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, kind, state, created_by, firm_scope, auto_resolution, created_at) VALUES ('wc_purge_reopened', 'reopened banter', ?1, 'OPEN', 'system', 'west-peek', 'NO_ACTION_NEEDED', ?2)",
    )
      .bind(WEB_PROPERTY_CHANGE_KIND, old)
      .run();

    // D. Stowed, but still inside the 30-day window — must survive this run.
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, kind, state, created_by, firm_scope, auto_resolution, created_at) VALUES ('wc_purge_recent', 'recent banter', ?1, 'CANCELLED', 'system', 'west-peek', 'NO_ACTION_NEEDED', ?2)",
    )
      .bind(WEB_PROPERTY_CHANGE_KIND, recent)
      .run();

    const out = await purgeNoActionCards(env, now);
    expect(out.purged).toEqual(["wc_purge_old"]);
    expect(out.blobFailures).toEqual([]);

    expect(await card("wc_purge_old")).toBeNull();
    expect(bucket.deletes).toContain("inbound-email/old.eml");
    const inm = await env.WP_OS_DB.prepare("SELECT id FROM inbound_message WHERE id = 'inm_purge_old'").first();
    expect(inm).toBeNull();

    // event_record is NEVER touched — the permanent trace survives the card.
    const survivingEvents = await eventsFor("wc_purge_old", "work_card.auto_resolved_no_action");
    expect(survivingEvents.length).toBe(1);
    const purgedEvent = await eventsFor("wc_purge_old", "work_card.no_action_purged");
    expect(purgedEvent.length).toBe(1);

    // Untouched controls.
    expect(await card("wc_purge_real")).not.toBeNull();
    expect(await card("wc_purge_reopened")).not.toBeNull();
    expect(await card("wc_purge_recent")).not.toBeNull();
  });
});
