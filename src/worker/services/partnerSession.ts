/**
 * A PARTNER'S EMAIL, WORKED AS ONE SESSION (14 Nov 2026, "emailing the OS feels like typing to Claude").
 *
 * An email no fixed door claims used to sit on the chief of staff's desk for the general step loop: a model call per
 * step under the router's stopwatch (`attemptDeadlineMs`, capped by `CLAIM_WAIT_MS`), fixed kinds, and a dead end for
 * anything that did not fit. It is now a PARTNER_SESSION card: one full Claude Code session on her Mac, parked as a
 * LOCAL_JOB run the claimer keeps alive with its one-minute ping, under a two-hour phase ceiling and nothing else.
 *
 *   · THE ROUTE is the one rule table's, on the Mac: HARD work, so Claude first, then Codex held for Claude's check;
 *     private work (a committed LP named, deal terms, "keep this private") waits for Claude. Never a free lane: the
 *     Mac has none, and this file never calls `runAi`.
 *   · MEMORY FIRST. The parked job carries the partner's standing practices, his holds and his profile
 *     (`practicesForCard`), and the duty puts them at the very top of the prompt.
 *   · THE CLEAR PARTS RUN; THE UNCLEAR WORDS ARE ASKED ABOUT (her ruling, 14 Nov 2026). The report is one line per
 *     ask. A QUESTION ask sends ONE email naming the unclear words with two or three options, and the card is not
 *     blocked: any IN_PROGRESS ask is parked again at once, so the clear work keeps going while he answers.
 *   · A CORRECTION REDIRECTS RUNNING WORK. His reply on the thread abandons the live run (the claimer stops it on its
 *     next ping; a report from an abandoned run is refused) and parks exactly one new run in the same working folder
 *     with his words above the brief, and he hears "Changed course: …".
 *   · OUTSIDERS STAY GATED. Every email here goes through `replyToRequester`, which sends to the two partner addresses
 *     only; the session itself has no tool that emails anyone.
 */
import type { Env } from "../env";
import { appendEvent } from "../events";
import { abandonRun, parkRun, readRun } from "../ai/subscriptionSeats";
import { committedLpNamedIn, committedLps } from "../ai/committedLps";
import { privateMaterialSentence } from "../../shared/intake/privateMaterial";
import { EMAILED_TASK_LIMITS } from "../../shared/intake/partnerAuthority";
import { partnerByEmail } from "../../shared/registry/partners";
import {
  LOCAL_JOB_RUN_KIND,
  PARTNER_SESSION_KIND,
  PARTNER_SESSION_PHASE,
  localJobKind,
  readPartnerSessionReport,
  type SessionAsk,
} from "../../shared/work/localJobs";
import { practicesForCard } from "./partnerConstraints";
import { recordProfileNotes } from "./partnerProfile";
import { replyToRequester } from "./requestReply";

/** A session is parked again at most this many times before it reports what it has (a loop is not work). */
export const MAX_SESSION_RUNS = 6;
/** How long a card whose only open asks are questions waits for his answer before the sweep looks again. */
export const QUESTION_WAIT_HOURS = 24;

export interface PartnerSessionRow {
  work_card_id: string;
  firm_scope: string;
  requested_by: string;
  request_text: string;
  current_run_id: string | null;
  applied_run_id: string | null;
  run_count: number;
  corrections_json: string;
  answers_json: string;
  report_json: string | null;
  asked_json: string;
}

interface SessionCard {
  id: string;
  title: string;
  kind: string | null;
  owner_id: string | null;
  state: string;
  work_attempts: number;
  firm_scope: string;
  requested_by_email?: string | null;
}

export interface SessionOutcome {
  finished: boolean;
  blocked: boolean;
  progressed: boolean;
  held?: boolean;
  waitUntil?: string;
  detail: string;
}

const list = (json: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
};

export async function readSession(env: Env, cardId: string): Promise<PartnerSessionRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM partner_session WHERE work_card_id = ?1").bind(cardId).first<PartnerSessionRow>();
}

/** Make the card a partner session, with his words as the brief. Idempotent. */
export async function openPartnerSession(env: Env, input: { cardId: string; request: string; requestedBy: string; firmScope?: string }): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET kind = ?2, next_action = ?3 WHERE id = ?1",
  )
    .bind(input.cardId, PARTNER_SESSION_KIND, "Worked as one session on the Mac: every clear ask done, the unclear words asked about with options.")
    .run();
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO partner_session (work_card_id, firm_scope, requested_by, request_text) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(input.cardId, input.firmScope ?? "west-peek", input.requestedBy.trim().toLowerCase(), input.request.slice(0, 100_000))
    .run();
  await appendEvent(env, {
    eventType: "partner_session.opened",
    actorType: "system",
    actorId: "partner_session",
    objectType: "work_card",
    objectId: input.cardId,
    firmScope: input.firmScope ?? "west-peek",
    payload: { requested_by: input.requestedBy.trim().toLowerCase(), chars: input.request.length },
  });
}

/**
 * PARK ONE SESSION RUN — the only place this kind parks. A LOCAL_JOB with the two-hour ceiling: the claimer's ping
 * keeps it alive, so there is no per-call deadline anywhere on its path.
 */
export async function parkSession(env: Env, card: Pick<SessionCard, "id" | "title" | "firm_scope">, row: PartnerSessionRow, why: string): Promise<{ parked: true; runId: string } | { parked: false; reason: string }> {
  const spec = localJobKind(PARTNER_SESSION_KIND)!;
  const phase = spec.phases.SESSION!;
  const live = row.current_run_id ? await readRun(env, row.current_run_id) : null;
  if (live && (live.status === "QUEUED" || live.status === "CLAIMED")) return { parked: false, reason: `a session run is already live (${live.id})` };
  const { driveFilesFor } = await import("./driveShares");
  const { attachmentsFor } = await import("./requestMaterials");
  const earlier = (() => {
    try {
      return (JSON.parse(row.report_json ?? "null")?.asks ?? []) as SessionAsk[];
    } catch {
      return [];
    }
  })();
  const corrections = list(row.corrections_json);
  const answers = list(row.answers_json);
  const driveFiles = await driveFilesFor(env, card.id).catch(() => []);
  const payload = {
    card_kind: PARTNER_SESSION_KIND,
    phase: PARTNER_SESSION_PHASE,
    model: phase.model,
    max_seconds: phase.maxSeconds,
    prompt_file: spec.promptFile,
    script: spec.script,
    card: { id: card.id, title: card.title, requested_by: row.requested_by },
    // MEMORY FIRST (step 6): the standing practices, his holds and his profile, read fresh for every run.
    memory: await practicesForCard(env, card.id, card.firm_scope),
    request: row.request_text,
    corrections,
    answers,
    earlier_asks: earlier,
    limits: [...EMAILED_TASK_LIMITS],
    attachments: (await attachmentsFor(env, card.id).catch(() => [])).map((a) => ({ id: a.id, filename: a.filename, media_type: a.media_type, bytes: a.bytes, path: `/api/work-cards/${card.id}/attachments/${a.id}` })),
    drive_files: driveFiles,
    private_model_only: false,
    queue_max_seconds: spec.queueMaxSeconds,
  };
  // A COMMITTED LP NAMED ANYWHERE, OR "KEEP THIS PRIVATE", KEEPS IT ON CLAUDE. Unreadable records fail closed.
  const committed = await committedLps(env, card.firm_scope);
  const texts = [card.title, row.request_text, ...corrections, ...answers, ...driveFiles.map((f) => f.text ?? "")];
  payload.private_model_only = !committed.readable || committedLpNamedIn(texts, committed.names) !== null || privateMaterialSentence([row.request_text, ...corrections]) !== null;

  const runId = await parkRun(env, {
    seat: "claude_code",
    purpose: `Partner session: ${card.title.slice(0, 80)}`,
    prompt: `${phase.purpose} See job_json.`,
    modelAccess: "PUBLIC_MODEL_APPROVED",
    workCardId: card.id,
    aiEmployeeId: null,
    taskClass: "partner-session",
    firmScope: card.firm_scope,
    maxSeconds: phase.maxSeconds,
    runKind: LOCAL_JOB_RUN_KIND,
    jobJson: JSON.stringify(payload),
  });
  await env.WP_OS_DB.prepare(
    "UPDATE partner_session SET current_run_id = ?2, run_count = run_count + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_card_id = ?1",
  )
    .bind(card.id, runId)
    .run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', next_action = ?2, waiting_until = NULL, waiting_for = NULL WHERE id = ?1")
    .bind(card.id, `The session is queued for the Mac (${why}).`.slice(0, 900))
    .run();
  await appendEvent(env, {
    eventType: "partner_session.parked",
    actorType: "system",
    actorId: "partner_session",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { run_id: runId, why, private_model_only: payload.private_model_only, corrections: corrections.length, answers: answers.length },
  });
  return { parked: true, runId };
}

/** One line per ask, for the card and the final email. */
export function askLine(a: SessionAsk): string {
  const tag = a.status === "DONE" ? "Done" : a.status === "IN_PROGRESS" ? "In progress" : a.status === "QUESTION" ? "Question" : "Not done";
  return `${tag}: ${a.words}${a.why ? ` — ${a.why}` : ""}`;
}

/** The QUESTION email: the unclear words first, then two or three replies he can send, the clear work said to be going on. */
export function questionEmail(questions: readonly SessionAsk[], going: readonly SessionAsk[]) {
  return {
    what: `a question — ${questions.length === 1 ? `"${questions[0]!.words.slice(0, 60)}"` : `${questions.length} things I could read two ways`}`,
    tldr:
      questions.length === 1
        ? `I wasn't sure what you meant by "${questions[0]!.words.slice(0, 120)}". Reply with one of the options below, or your own words.`
        : `${questions.length} things you wrote could mean more than one thing. Reply with an option for each, or your own words.`,
    tldrBullets: [] as string[],
    sections: [
      ...questions.map((q, i) => ({
        label: `${questions.length > 1 ? `${i + 1}. ` : ""}"${q.words.slice(0, 120)}"`,
        bullets: [...(q.why ? [q.why] : []), ...q.options.map((o, j) => `Option ${String.fromCharCode(65 + j)}: ${o}`)],
      })),
      ...(going.length ? [{ label: "Still going while you answer", bullets: going.map(askLine) }] : []),
    ],
    details: null,
  };
}

async function sessionCard(env: Env, cardId: string): Promise<SessionCard | null> {
  return env.WP_OS_DB.prepare("SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<SessionCard>();
}

async function whoWorks(env: Env, ownerId: string | null): Promise<string> {
  if (!ownerId) return "Your chief of staff";
  return (await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(ownerId).first<{ name: string }>())?.name ?? "Your chief of staff";
}

/** The sweep's runner for a PARTNER_SESSION card. Never calls a model: it parks, holds, or reads what came back. */
export async function runPartnerSessionCard(env: Env, sweepCard: SessionCard, now: Date = new Date()): Promise<SessionOutcome> {
  const card = (await sessionCard(env, sweepCard.id)) ?? sweepCard;
  let row = await readSession(env, card.id);
  if (!row) {
    // A card marked with the kind but never opened at the door: its description carries his words.
    const d = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(card.id).first<{ description: string | null }>();
    await openPartnerSession(env, { cardId: card.id, request: d?.description ?? card.title, requestedBy: card.requested_by_email ?? "", firmScope: card.firm_scope });
    row = (await readSession(env, card.id))!;
  }
  const held = (detail: string, minutes = 6): SessionOutcome => ({ finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + minutes * 60_000).toISOString(), detail });

  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run && (run.status === "QUEUED" || run.status === "CLAIMED")) {
      return held(run.status === "CLAIMED" ? `The session is running on ${run.claimed_by ?? "the Mac"}${run.progress_note ? ` — ${run.progress_note}` : ""}.` : "The session is queued for the Mac.");
    }
    if (run && row.applied_run_id !== run.id && run.status !== "ABANDONED") return applySessionRun(env, card, row, run, now);
    if (run && row.applied_run_id === run.id) {
      const asks = (JSON.parse(row.report_json ?? "{}")?.asks ?? []) as SessionAsk[];
      if (asks.some((a) => a.status === "QUESTION")) return held("Waiting for his answer to the question; the rest is done or running.", QUESTION_WAIT_HOURS * 60);
    }
  }
  if (row.run_count >= MAX_SESSION_RUNS) return finishWithWhatWeHave(env, card, row, "it ran as many times as a session may");
  const parked = await parkSession(env, card, row, row.run_count === 0 ? "the partner's email" : "picking the work back up");
  if (!parked.parked) return held(parked.reason);
  return held("The session is queued for the Mac.");
}

async function finishWithWhatWeHave(env: Env, card: SessionCard, row: PartnerSessionRow, why: string): Promise<SessionOutcome> {
  let report: { asks?: SessionAsk[]; reply?: string } = {};
  try {
    report = JSON.parse(row.report_json ?? "{}");
  } catch {
    report = {};
  }
  const asks = report.asks ?? [];
  const detail = [report.reply ?? `Stopped: ${why}.`, ...asks.map(askLine)].join("\n");
  return { finished: true, blocked: false, progressed: false, detail };
}

async function applySessionRun(env: Env, card: SessionCard, row: PartnerSessionRow, run: { id: string; status: string; output_text: string | null; error: string | null }, now: Date): Promise<SessionOutcome> {
  await env.WP_OS_DB.prepare("UPDATE partner_session SET applied_run_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_card_id = ?1").bind(card.id, run.id).run();
  const read = run.status === "REPORTED" ? readPartnerSessionReport(run.output_text) : { report: null, problem: run.error ?? `the run ended ${run.status}` };
  if (!read.report) return { finished: false, blocked: false, progressed: false, detail: `The session did not finish: ${read.problem}` };
  const report = read.report;
  if (report.status === "failed") {
    if (report.waits_seconds) return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + report.waits_seconds * 1000).toISOString(), detail: `Waiting for a plan to reset: ${report.reason ?? ""}` };
    return { finished: false, blocked: false, progressed: false, detail: `The session stopped: ${report.reason}` };
  }
  await env.WP_OS_DB.prepare("UPDATE partner_session SET report_json = ?2 WHERE work_card_id = ?1").bind(card.id, JSON.stringify(report)).run();
  // MEMORY THE SESSION ASKED TO KEEP (step 6): every line passes the profile filter (no LP names, deal terms or fund details).
  if (report.remember.length && partnerByEmail(row.requested_by)) await recordProfileNotes(env, row.requested_by, report.remember);

  const questions = report.asks.filter((a) => a.status === "QUESTION");
  const going = report.asks.filter((a) => a.status === "IN_PROGRESS");
  if (questions.length) {
    const asked = list(row.asked_json);
    const fresh = questions.filter((q) => !asked.includes(q.words));
    if (fresh.length) {
      const who = await whoWorks(env, card.owner_id);
      await replyToRequester(env, card, "BLOCKED", who, fresh.map((q) => `${q.words}: ${q.options.join(" / ")}`).join("\n"), { kind: "QUESTION", cause: `session-question:${run.id}` }, questionEmail(fresh, going));
      await env.WP_OS_DB.prepare("UPDATE partner_session SET asked_json = ?2 WHERE work_card_id = ?1").bind(card.id, JSON.stringify([...asked, ...fresh.map((q) => q.words)])).run();
    }
  }
  // THE CLEAR WORK KEEPS RUNNING while he answers: an IN_PROGRESS ask is parked again now, never held for the reply.
  if (going.length && row.run_count < MAX_SESSION_RUNS) {
    const fresh = (await readSession(env, card.id))!;
    const parked = await parkSession(env, card, fresh, "continuing the asks still in progress");
    if (parked.parked) return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + 6 * 60_000).toISOString(), detail: report.asks.map(askLine).join("\n") };
  }
  if (questions.length) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', next_action = ?2 WHERE id = ?1").bind(card.id, `Waiting for his answer on: ${questions.map((q) => `"${q.words.slice(0, 60)}"`).join(", ")}`.slice(0, 900)).run();
    return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + QUESTION_WAIT_HOURS * 3600_000).toISOString(), detail: report.asks.map(askLine).join("\n") };
  }
  return { finished: true, blocked: false, progressed: false, detail: [report.reply ?? "Finished.", "", ...report.asks.map(askLine)].join("\n").trim() };
}

/**
 * HIS REPLY REDIRECTS THE SESSION (step 5). A correction while a run is live abandons it with his words as the reason
 * (the claimer's next ping is refused and it stops the job) and parks exactly one new run in the same working folder,
 * his words above the brief, and he hears "Changed course: …". A reply while no run is live (his answer to a
 * question he has not answered) is kept as an answer and restarts the session with it, without a "Changed course". Returns what happened, or null when the card is not a live session.
 */
export async function redirectSession(env: Env, cardId: string, words: string, from: string, onThread: string | null = null): Promise<{ abandoned: string | null; runId: string | null; note: boolean } | null> {
  const card = await sessionCard(env, cardId);
  const row = await readSession(env, cardId);
  if (!card || !row || card.kind !== PARTNER_SESSION_KIND || ["DONE", "CANCELLED"].includes(card.state)) return null;
  const said = words.trim().slice(0, 4000);
  if (!said) return null;
  const live = row.current_run_id ? await readRun(env, row.current_run_id) : null;
  let abandoned: string | null = null;
  if (live && (live.status === "QUEUED" || live.status === "CLAIMED")) {
    if (await abandonRun(env, live.id, `Changed course by ${from}: ${said}`.slice(0, 900))) abandoned = live.id;
  }
  // An answer to a question he has not answered yet joins the answers; anything else is a correction, above the brief, newest first.
  const answering = list(row.asked_json).length > list(row.answers_json).length;
  if (answering) {
    await env.WP_OS_DB.prepare("UPDATE partner_session SET answers_json = ?2, run_count = 0 WHERE work_card_id = ?1").bind(cardId, JSON.stringify([...list(row.answers_json), said])).run();
  } else {
    await env.WP_OS_DB.prepare("UPDATE partner_session SET corrections_json = ?2, run_count = 0 WHERE work_card_id = ?1").bind(cardId, JSON.stringify([said, ...list(row.corrections_json)])).run();
  }
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', lease_until = NULL WHERE id = ?1").bind(cardId).run();
  const fresh = (await readSession(env, cardId))!;
  const parked = await parkSession(env, card, fresh, answering ? "his answer" : "his correction");
  const runId = parked.parked ? parked.runId : null;
  let note = false;
  if (abandoned && runId && !answering) {
    const who = await whoWorks(env, card.owner_id);
    const out = await replyToRequester(env, card, "BLOCKED", who, `Changed course: ${said}`, { kind: "RECEIVED", cause: `changed-course:${runId}` }, {
      what: `changed course — ${said.replace(/\s+/g, " ").slice(0, 60)}`,
      tldr: `Changed course: ${said.replace(/\s+/g, " ").slice(0, 300)}. I stopped what I was doing and started again with this on top; nothing from before the change goes out.`,
      tldrBullets: [],
      sections: [{ label: "What happens next", bullets: ["The work restarts with your correction above everything else.", "You hear back when it is done, or sooner if a word could mean two things."] }],
      details: null,
    });
    note = out.sent;
  }
  await appendEvent(env, {
    eventType: "partner_session.redirected",
    actorType: "firm_user",
    actorId: partnerByEmail(from)?.firmUserId ?? "unknown",
    objectType: "work_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { abandoned, run_id: runId, kind: answering ? "ANSWER" : "CORRECTION", on_thread: onThread, said: said.slice(0, 200) },
  });
  return { abandoned, runId, note };
}
