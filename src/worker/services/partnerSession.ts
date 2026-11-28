/**
 * A PARTNER'S EMAIL, WORKED AS ONE SESSION (14 Nov 2026, "emailing the OS feels like typing to Claude").
 *
 * An email no fixed door claims used to sit on the chief of staff's desk for the general step loop: a model call per
 * step under the router's stopwatch (`attemptDeadlineMs`), fixed kinds, and a dead end for
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
 *     next ping; a report from an abandoned run is refused) and parks exactly one new run on the same card
 *     with his words above the brief, and he hears "Changed course: …".
 *   · OUTSIDERS STAY GATED. Every email here goes through `replyToRequester`, which sends to the two partner addresses
 *     only; the session itself has no tool that emails anyone.
 */
import { operatingStopped } from "./chiefControls";
import { ACTION_REQUIRED } from "../../shared/email/execEmail";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { abandonRun, parkRun, readRun } from "../ai/subscriptionSeats";
import { redactInputs } from "../ai/scrub";
import { committedLpNamedIn, committedLps } from "../ai/committedLps";
import { privateMaterialSentence } from "../../shared/intake/privateMaterial";
import { EMAILED_TASK_LIMITS } from "../../shared/intake/partnerAuthority";
import { partnerByEmail } from "../../shared/registry/partners";
import { chiefSessionFor } from "../../shared/work/chiefOfStaff";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { BLOCK_PROVIDERS, PARTNER_ANSWER_MAX, type BlockReason } from "../../shared/work/blocks";
import {
  LOCAL_JOB_RUN_KIND,
  PARTNER_SESSION_KIND,
  PARTNER_SESSION_PHASE,
  localJobKind,
  readPartnerSessionReport,
  type SessionAsk,
} from "../../shared/work/localJobs";
import { partnerEmailForCard, practicesForCard } from "./partnerConstraints";
import { recordProfileNotes } from "./partnerProfile";
import { alreadyTold, replyToRequester } from "./requestReply";
import type { FirmUserIdentity } from "../auth";
import { json, type RouteContext } from "../router";
import { createWorkCardInternal, WorkCardError } from "./workCards";
import { blockCard } from "./blocks";
import { actorFromIdentity, HOME_FIRM_SCOPE } from "./authorize";

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
  source: "EMAIL" | "PAGE" | "SCHEDULE";
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
export async function openPartnerSession(env: Env, input: { cardId: string; request: string; requestedBy: string; firmScope?: string; source?: PartnerSessionRow["source"]; employeeId?: string }): Promise<void> {
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare(
      `UPDATE work_card SET kind = ?2, next_action = ?3, owner_id = COALESCE(?4, owner_id),
                            owner_type = CASE WHEN ?4 IS NOT NULL THEN 'AI' ELSE owner_type END WHERE id = ?1`,
    ).bind(input.cardId, PARTNER_SESSION_KIND, "Waiting for the session on the Mac.", input.employeeId ?? null),
    env.WP_OS_DB.prepare(
      "INSERT OR IGNORE INTO partner_session (work_card_id, firm_scope, requested_by, request_text, source) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(input.cardId, input.firmScope ?? "west-peek", input.requestedBy.trim().toLowerCase(), input.request.slice(0, 100_000), input.source ?? "EMAIL"),
  ]);
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

/** The page and the schedule file the same card and hand it to the same sweep as email. */
export async function openChiefTurn(env: Env, identity: FirmUserIdentity, employeeId: string, source: "PAGE" | "SCHEDULE", request: string, firmScope: string) {
  const chief = chiefSessionFor(employeeId);
  if (!chief || (source === "PAGE" && chief.principal.firmUserId !== identity.id)) throw new WorkCardError(403, "forbidden");
  const seat = await env.WP_OS_DB.prepare("SELECT status FROM ai_employee WHERE id = ?1").bind(employeeId).first<{ status: string }>();
  if (seat?.status !== "ACTIVE") throw new WorkCardError(409, "inactive", `${chief.employee.name} is off.`);
  const card = await createWorkCardInternal(env, identity, {
    title: source === "PAGE" ? `Message to ${chief.employee.name}` : `${chief.employee.name} daily session`,
    firm_scope: firmScope,
    // A card remains outside the sweep until the request and its executable kind are filed together.
    next_action: "The session request is being filed.",
  });
  await openPartnerSession(env, { cardId: card.id, request, requestedBy: chief.principal.email, firmScope, source, employeeId });
  return card.id;
}

export const CHIEF_MESSAGE_BYTES = 16_384;

export async function handleChiefMessages(ctx: RouteContext): Promise<Response> {
  const { identity, env, request } = ctx;
  const employeeId = ctx.params.id!;
  const chief = chiefSessionFor(employeeId);
  const firmScope = HOME_FIRM_SCOPE;
  if (!chief || !identity || chief.principal.firmUserId !== identity.id || !identity.roles.includes("MANAGING_PARTNER") ||
      !actorFromIdentity(identity).firmScopes.includes(firmScope)) {
    return json({ error: "not_found" }, { status: 404 });
  }
  if (request.method === "GET") {
    const rows = await env.WP_OS_DB.prepare(
      `SELECT c.id, c.state, c.created_at, s.source, s.request_text, s.report_json
         FROM partner_session s JOIN work_card c ON c.id = s.work_card_id
        WHERE c.owner_id = ?1 AND s.requested_by = ?2 AND s.firm_scope = ?3 AND s.source IN ('PAGE', 'SCHEDULE')
        ORDER BY c.created_at DESC, c.id DESC LIMIT 10`,
    ).bind(employeeId, chief.principal.email, firmScope).all<{ id: string; state: string; created_at: string; source: string; request_text: string; report_json: string | null }>();
    return json({ messages: (rows.results ?? []).map(({ report_json, ...row }) => ({ ...row, report: readPartnerSessionReport(report_json).report })) }, { headers: { "Cache-Control": "no-store" } });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body) {
    return json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const reader = request.body.getReader();
  const buffer = new Uint8Array(CHIEF_MESSAGE_BYTES);
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size + value.length > buffer.length) {
      await reader.cancel();
      return json({ error: "message_too_large", detail: "Keep the message under 16 KB." }, { status: 413 });
    }
    buffer.set(value, size);
    size += value.length;
  }
  let words = "";
  try {
    const body = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))) as { message?: unknown } | null;
    if (typeof body?.message === "string") words = body.message.trim();
  } catch { /* An unreadable body takes the same validation path as an empty message. */ }
  if (!words) return json({ error: "invalid_input", detail: "Write a message first." }, { status: 400 });
  try {
    const id = await openChiefTurn(env, identity, employeeId, "PAGE", words, firmScope);
    return json({ id }, { status: 202 });
  } catch (error) {
    if (error instanceof WorkCardError) return json({ error: error.code, detail: error.message }, { status: error.status });
    throw error;
  }
}

/**
 * PARK ONE SESSION RUN — the only place this kind parks. A LOCAL_JOB with the two-hour ceiling: the claimer's ping
 * keeps it alive, so there is no per-call deadline anywhere on its path.
 */
export async function parkSession(env: Env, card: Pick<SessionCard, "id" | "title" | "firm_scope" | "owner_id">, row: PartnerSessionRow, why: string): Promise<{ parked: true; runId: string } | { parked: false; reason: string }> {
  if (await operatingStopped(env)) return { parked: false, reason: "The owner paused West Peek OS agents." };
  const chief = chiefSessionFor(card.owner_id);
  if (!chief || chief.principal.email !== row.requested_by) return { parked: false, reason: "The session has no verified request from this chief's partner." };
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
  const clean = (text: string) => redactInputs([text]).inputs[0]!;
  const corrections = list(row.corrections_json).map(clean);
  const answers = list(row.answers_json).map(clean);
  const driveFiles = (await driveFilesFor(env, card.id).catch(() => [])).map((file) =>
    ({ ...file, title: clean(file.title), text: file.text ? clean(file.text) : file.text }));
  const payload = {
    card_kind: PARTNER_SESSION_KIND,
    phase: PARTNER_SESSION_PHASE,
    model: phase.model,
    max_seconds: phase.maxSeconds,
    prompt_file: spec.promptFile,
    script: spec.script,
    card: { id: card.id, title: clean(card.title), requested_by: row.requested_by },
    // MEMORY FIRST (step 6): the standing practices, his holds and his profile, read fresh for every run.
    memory: await practicesForCard(env, card.id, card.firm_scope, chief.principal.email).then(clean),
    employee: { name: chief.employee.name, persona: personaPrompt(chief.employee.name, chief.employee.role) },
    source: row.source,
    request: clean(row.request_text),
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
    purpose: `${chief.employee.name} session: ${row.source.toLowerCase()}`,
    prompt: `${phase.purpose} See job_json.`,
    modelAccess: "PUBLIC_MODEL_APPROVED",
    workCardId: card.id,
    aiEmployeeId: card.owner_id,
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

/** Past this many questions the email gives his request's best reading per item for him to correct (her ruling). */
export const BEST_READING_OVER = 5;
/** A safety bound on one question email, never a cap on what is asked: past it the email says "and N more". */
export const QUESTION_EMAIL_BOUND = 40;

/**
 * THE QUESTION EMAIL (Sequoia, 15 Nov 2026): every unclear item is asked, none merged or dropped, each NUMBERED, quoting
 * his words and saying what is missing, so he can answer by number. Past BEST_READING_OVER items it says plainly the
 * request reads several ways and gives the best reading of each for him to correct, still every item. The clear work
 * is said to be going on meanwhile. Pure.
 */
export function questionEmail(all: readonly SessionAsk[], going: readonly SessionAsk[]) {
  // Every item is asked; past this safety bound the email says how many more there are, never drops them in silence.
  const questions = all.slice(0, QUESTION_EMAIL_BOUND);
  const beyond = all.length - questions.length;
  const n = all.length;
  const several = n > BEST_READING_OVER;
  return {
    what: `${ACTION_REQUIRED}${n === 1 ? `a question — "${questions[0]!.words.slice(0, 60)}"` : several ? `your request reads several ways — ${n} items` : `${n} questions, by number`}`,
    tldr: several
      ? `Your request reads several ways, so below is my best reading of each of the ${n} items. Reply with the number of any I got wrong and what you meant; everything else is being built meanwhile.`
      : `${n === 1 ? "One question" : `${n} questions`} before I finish ${n === 1 ? "that part" : "those parts"}. Reply with the number and your answer; everything else is being built meanwhile.`,
    tldrBullets: [] as string[],
    sections: [
      ...questions.map((q, i) => ({
        label: `${i + 1}. "${q.words.slice(0, 120)}"`,
        bullets: several
          ? [`What is missing: ${q.why || "which reading you meant"}`, `My best reading: ${q.options[0] ?? "as written"}`]
          : [`What is missing: ${q.why || "which reading you meant"}`, ...q.options.map((o, j) => `Option ${String.fromCharCode(65 + j)}: ${o}`)],
      })),
      ...(beyond > 0 ? [{ label: `And ${beyond} more`, bullets: [`${beyond} more items read several ways; they are on the card, and I will ask them next by number.`] }] : []),
      ...(going.length ? [{ label: "Still being built while you answer", bullets: going.map(askLine) }] : []),
    ],
    details: null,
  };
}

/**
 * THE ROUND A QUESTION EMAIL BELONGS TO: his newest email on the card (a correction or an answer that raises something
 * new starts a new round); the opening request when none is stored. One question email per round.
 */
async function questionRound(env: Env, cardId: string): Promise<string> {
  const latest = await env.WP_OS_DB.prepare(
    "SELECT id FROM inbound_message WHERE work_card_id = ?1 AND json_extract(mail_authority_json, '$.partner') IS NOT NULL ORDER BY received_at DESC LIMIT 1",
  ).bind(cardId).first<{ id: string }>().catch(() => null);
  return latest?.id ?? "request";
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
  if (await operatingStopped(env)) {
    return { finished: false, blocked: false, progressed: false, held: true, detail: "The owner paused West Peek OS agents." };
  }
  const card = (await sessionCard(env, sweepCard.id)) ?? sweepCard;
  let row = await readSession(env, card.id);
  if (!row) {
    // A card marked with the kind but never opened at the door: its description carries his words.
    const d = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(card.id).first<{ description: string | null }>();
    const requester = await partnerEmailForCard(env, card.id);
    await openPartnerSession(env, { cardId: card.id, request: d?.description ?? card.title, requestedBy: requester ?? "", firmScope: card.firm_scope, source: card.requested_by_email ? "EMAIL" : "PAGE" });
    row = (await readSession(env, card.id))!;
  }
  if (chiefSessionFor(card.owner_id)?.principal.email !== row.requested_by) {
    return stopSession(env, card, "the_brief_is_missing", "Open the session from the chief’s employee page or from their partner’s verified email.");
  }
  const held = (detail: string, minutes = 6): SessionOutcome => ({ finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + minutes * 60_000).toISOString(), detail });

  if (row.current_run_id) {
    const run = await readRun(env, row.current_run_id);
    if (run && (run.status === "QUEUED" || run.status === "CLAIMED")) {
      return held(run.status === "CLAIMED" ? `The session is running on ${run.claimed_by ?? "the Mac"}${run.progress_note ? ` — ${run.progress_note}` : ""}.` : "The session is queued for the Mac.");
    }
    if (run && row.applied_run_id !== run.id && run.status !== "ABANDONED") return applySessionRun(env, card, row, run, now);
    if (run && row.applied_run_id === run.id) {
      const report = JSON.parse(row.report_json ?? "{}") as { asks?: SessionAsk[]; reply?: string };
      const asks = report.asks ?? [];
      if (row.source === "EMAIL" && asks.some((a) => a.status === "QUESTION")) return held("Waiting for the partner’s answer to the question; the rest is done or running.", QUESTION_WAIT_HOURS * 60);
      if (asks.length && !asks.some((a) => a.status === "IN_PROGRESS")) {
        /*
         * THE WORK FINISHED AND THE FINAL REPLY WAS HELD BACK (plan step 7's guard, services/partnerUnderstood.ts). No seat
         * to mark his asks is a wait: the same finished report is offered again, never a new session. An ask the report
         * did not account for goes back to the session as the newest instruction, so the next run accounts for it.
         */
        const c = await env.WP_OS_DB.prepare("SELECT next_action, waiting_for FROM work_card WHERE id = ?1").bind(card.id).first<{ next_action: string | null; waiting_for: string | null }>();
        const { MARKING_SEAT_WAIT } = await import("./partnerUnderstood");
        const missing = (c?.next_action ?? "").startsWith("Before this is finished") && !(c?.waiting_for ?? "").startsWith(MARKING_SEAT_WAIT) ? c!.next_action! : null;
        if (!missing) return finish(env, card.id, report.reply, asks, row.source);
        await env.WP_OS_DB.prepare("UPDATE partner_session SET corrections_json = ?2 WHERE work_card_id = ?1").bind(card.id, JSON.stringify([missing, ...list(row.corrections_json)])).run();
        row = (await readSession(env, card.id))!;
      }
    }
  }
  if (row.run_count >= MAX_SESSION_RUNS) return finishWithWhatWeHave(env, card, row, "it ran as many times as a session may");
  const parked = await parkSession(env, card, row, row.run_count === 0 ? row.source.toLowerCase() : "picking the work back up");
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
  if (!report.asks?.some((ask) => ask.status === "DONE")) return stopSession(env, card, "stopped_part_way", `Stopped: ${why}.`);
  return finish(env, card.id, report.reply, report.asks, row.source);
}

async function applySessionRun(env: Env, card: SessionCard, row: PartnerSessionRow, run: { id: string; status: string; output_text: string | null; error: string | null }, now: Date): Promise<SessionOutcome> {
  await env.WP_OS_DB.prepare("UPDATE partner_session SET applied_run_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE work_card_id = ?1").bind(card.id, run.id).run();
  const read = run.status === "REPORTED" ? readPartnerSessionReport(run.output_text) : { report: null, problem: run.error ?? `the run ended ${run.status}` };
  if (!read.report) return { finished: false, blocked: false, progressed: false, detail: `The session did not finish: ${read.problem}` };
  const report = read.report;
  if (report.status === "failed") {
    if (report.waits_seconds) return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + report.waits_seconds * 1000).toISOString(), detail: "Waiting for a subscription to reset." };
    return { finished: false, blocked: false, progressed: false, detail: report.reason ?? "The session stopped before producing a report." };
  }
  await env.WP_OS_DB.prepare("UPDATE partner_session SET report_json = ?2 WHERE work_card_id = ?1").bind(card.id, JSON.stringify(report)).run();
  // MEMORY THE SESSION ASKED TO KEEP (step 6): every line passes the profile filter (no LP names, deal terms or fund details).
  if (report.remember.length && partnerByEmail(row.requested_by)) await recordProfileNotes(env, row.requested_by, report.remember);

  const questions = report.asks.filter((a) => a.status === "QUESTION");
  const going = report.asks.filter((a) => a.status === "IN_PROGRESS");
  if (questions.length && row.source === "EMAIL") {
    const asked = list(row.asked_json);
    const fresh = questions.filter((q) => !asked.includes(q.words));
    // ONE QUESTION EMAIL PER ROUND (Sequoia, 15 Nov 2026): every unclear item of this round in one numbered email on
    // his thread. The same email read again sends nothing more; his next email (a correction, or an answer raising
    // something new) is a new round.
    const cause = `session-question:${await questionRound(env, card.id)}`;
    if (fresh.length && !(await alreadyTold(env, card.id, "QUESTION", cause))) {
      const who = await whoWorks(env, card.owner_id);
      await replyToRequester(env, card, "BLOCKED", who, fresh.map((q) => `${q.words}: ${q.options.join(" / ")}`).join("\n"), { kind: "QUESTION", cause }, questionEmail(fresh, going));
      await env.WP_OS_DB.prepare("UPDATE partner_session SET asked_json = ?2 WHERE work_card_id = ?1").bind(card.id, JSON.stringify([...asked, ...fresh.map((q) => q.words)])).run();
    }
  }
  // THE CLEAR WORK KEEPS RUNNING while he answers: an IN_PROGRESS ask is parked again now, never held for the reply.
  if (going.length && row.run_count < MAX_SESSION_RUNS) {
    const fresh = (await readSession(env, card.id))!;
    const parked = await parkSession(env, card, fresh, "continuing the asks still in progress");
    if (parked.parked) return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + 6 * 60_000).toISOString(), detail: "Queued to continue the open requests." };
  }
  // Held for his answer only while a question he was actually sent is unanswered.
  const waitingOnHim = row.source === "EMAIL" && questions.length > 0 && list((await readSession(env, card.id))?.asked_json).length > list(row.answers_json).length;
  if (waitingOnHim) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', next_action = ?2 WHERE id = ?1").bind(card.id, `Waiting for his answer on: ${questions.map((q) => `"${q.words.slice(0, 60)}"`).join(", ")}`.slice(0, 900)).run();
    return { finished: false, blocked: false, progressed: true, held: true, waitUntil: new Date(now.getTime() + QUESTION_WAIT_HOURS * 3600_000).toISOString(), detail: report.asks.map(askLine).join("\n") };
  }
  if (!report.asks.some((ask) => ask.status === "DONE")) {
    return stopSession(env, card, "nothing_good_enough_to_send", row.source === "EMAIL" ? report.asks.map(askLine).join("\n") : "Read the session report for what is still open.");
  }
  return finish(env, card.id, report.reply, report.asks, row.source);
}

async function stopSession(env: Env, card: SessionCard, reason: BlockReason, detail: string): Promise<SessionOutcome> {
  const chief = chiefSessionFor(card.owner_id);
  const who = BLOCK_PROVIDERS.find((provider) => provider === chief?.principal.firstName.toUpperCase());
  const description = await blockCard(env, card, {
    reason, detail, who, trying: card.title, employee: chief?.employee.name ?? "Your chief of staff",
  });
  return { finished: false, blocked: true, progressed: false, detail: description };
}

/**
 * THE FINISHED SESSION: the card is DONE (this runner's own move, as every Mac-run kind's is) and the detail is his
 * answer followed by the report's own `{"asks":[{"words","status","why"}]}`, which the final reply's guard reads
 * directly (`reportedAsks`). A question never answered by the end is NOT_DONE, saying it waits on his answer.
 */
async function finish(env: Env, cardId: string, reply: string | undefined, asks: readonly SessionAsk[], source: PartnerSessionRow["source"]): Promise<SessionOutcome> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL, waiting_until = NULL, waiting_for = NULL WHERE id = ?1").bind(cardId).run();
  return { finished: true, blocked: false, progressed: false, detail: source === "EMAIL" ? `${(reply ?? "Finished.").trim()}\n\n${sessionAsksJson(asks)}` : "The session report is on the employee’s page." };
}

/** The asks as the final reply's guard reads them. Pure. */
export function sessionAsksJson(asks: readonly SessionAsk[]): string {
  return JSON.stringify({
    asks: asks.map((a) => ({
      words: a.words,
      status: a.status === "QUESTION" ? "NOT_DONE" : a.status,
      why: a.status === "QUESTION" ? `waiting on your answer: ${a.why || "which of the options you meant"}` : a.why || (a.status === "DONE" ? "done in this session" : "no reason given"),
    })),
  });
}

/**
 * HIS REPLY REDIRECTS THE SESSION (step 5). A correction while a run is live abandons it with his words as the reason
 * (the claimer's next ping is refused and it stops the job) and parks exactly one new run on the same card,
 * his words above the brief, and he hears "Changed course: …". A reply while no run is live (his answer to a
 * question he has not answered) is kept as an answer and restarts the session with it, without a "Changed course". Returns what happened, or null when the card is not a live session.
 */
export async function redirectSession(env: Env, cardId: string, words: string, from: string, onThread: string | null = null): Promise<{ abandoned: string | null; runId: string | null; note: boolean } | null> {
  const card = await sessionCard(env, cardId);
  const row = await readSession(env, cardId);
  if (!card || !row || card.kind !== PARTNER_SESSION_KIND || ["DONE", "CANCELLED"].includes(card.state)) return null;
  if (partnerByEmail(from)?.email !== row.requested_by || chiefSessionFor(card.owner_id)?.principal.email !== row.requested_by) return null;
  // His whole reply, at the same cap the block door keeps (a long brief keeps its last lines).
  const said = words.trim().slice(0, PARTNER_ANSWER_MAX);
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
  if (row.source === "EMAIL" && abandoned && runId && !answering) {
    const who = await whoWorks(env, card.owner_id);
    const out = await replyToRequester(env, card, "BLOCKED", who, `Changed course: ${said}`, { kind: "RECEIVED", cause: `changed-course:${runId}` }, {
      what: `changed course — ${said.replace(/\s+/g, " ").slice(0, 60)}`,
      tldr: `Changed course: ${said.replace(/\s+/g, " ").slice(0, 300)}. I stopped what I was doing and started again with this on top; nothing from before the change goes out.`,
      tldrBullets: [],
      // Two labelled sections: the format check refuses an email with one, so this note never left before 20 Nov 2026.
      sections: [
        { label: "What you asked", bullets: [said.replace(/\s+/g, " ").slice(0, 300)] },
        { label: "What happens next", bullets: ["The work restarts with your correction above everything else.", "You hear back when it is done, or sooner if a word could mean two things."] },
      ],
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
