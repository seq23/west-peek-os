import type { Env } from "../env";
import type { Actor } from "./authorize";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { partnerByEmail } from "../../shared/registry/partners";
import { partnersOwnWords } from "../../shared/intake/replyBody";
import { textBodyOf } from "../effects/mimeAttachments";
import { alreadyTold, recordNotice, threadRootFor } from "./requestReply";
import { sendOrPreview } from "./previewApproval";
import { FILES_NOT_OPENED } from "./voiceNotes";

/**
 * EMAILING THE OS FEELS LIKE TYPING TO CLAUDE — steps 1 and 7 (her ruling, 14 Nov 2026, west-peek-ventures brain).
 *
 * STEP 1 · "GOT IT", WITHIN FIVE MINUTES. Every partner email that opened or steered a card gets one reply on his
 * thread listing each thing he asked for, in his own words, and what happens next. The sweep runs every minute and
 * calls `sendUnderstoodReplies` before it works a card, so the wait is one tick plus one model call. The model call
 * is confidential (her Claude seat, then Codex; never a free lane, never paid). When no seat answers, the reply still
 * goes: his own sentences quoted, no model involved. The asks are stored in `partner_ask` (0306).
 *
 * STEP 7 · ONE COMPLETE FINAL REPLY. `asksAtDone` marks every stored ask DONE / IN_PROGRESS / NOT_DONE with a reason
 * (from the runner's own `{"asks":[…]}` report when it gave one, else one confidential read of what it finished
 * with). If any ask is still unmarked, the DONE is not sent and the card is put back to work with the missing asks
 * named. That is the tail's dropped-ask check, moved before the send.
 *
 * Only a partner address is ever written to: the authenticated sender recorded on the stored message, checked
 * against the registry again here, and `sendOrPreview` is the one lane.
 */

/** A message older than this when the sweep first sees it is history (a deploy, a re-read), never a fresh "Got it". */
export const UNDERSTOOD_WINDOW_MINUTES = 30;
/** Messages answered per tick: each may wait on a seat, and the sweep still has a card to work. */
export const UNDERSTOOD_PER_TICK = 2;
const MAX_ASKS = 12;

export type AskStatus = "DONE" | "IN_PROGRESS" | "NOT_DONE";
export type SeatRead = (env: Env, input: { prompt: string; firmScope: string; employeeId: string | null; purpose: string }) => Promise<{ ok: boolean; text: string; detail: string }>;

/** Her Claude seat, then Codex as its backup; never a free lane, never a paid one. */
export const confidentialSeatRead: SeatRead = async (env, input) => {
  try {
    const actor: Actor = { type: "AI", ...(input.employeeId ? { aiEmployeeId: input.employeeId } : {}), roles: [], firmScopes: [input.firmScope] } as Actor;
    const { run } = await runAi(env, {
      purpose: input.purpose,
      actor,
      inputs: [input.prompt],
      sensitivity: "INTERNAL" as never,
      budgetContext: { judgement: true, confidential: true, seatFirst: true, neverPaid: true, expectedOutputTokens: 500 },
      routing: { category: "OPERATIONS" },
    });
    return run.status === "COMPLETED" && run.output_text ? { ok: true, text: run.output_text, detail: "ok" } : { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  } catch (err) {
    return { ok: false, text: "", detail: err instanceof Error ? err.message : String(err) };
  }
};

const norm = (s: string): string => s.toLowerCase().replace(/[“”"'‘’`]/g, "").replace(/\s+/g, " ").trim().replace(/^[\s\-–—•*:.,;!?]+|[\s\-–—•*:.,;!?]+$/g, "");

/** His sentences, as written: the no-model "Got it" and the fallback when a read returns nothing usable. */
export function sentencesOf(words: string): string[] {
  return words
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.replace(/^[\s\-–—•*]+|\s+$/g, "").replace(/\s+/g, " "))
    .filter((s) => /[a-z]{2}/i.test(s) && s.length >= 4 && !/^(?:hi|hey|hello|thanks|thank you|cheers|best|regards)\b[^a-z]*\w*[,!.]?$/i.test(s))
    .slice(0, MAX_ASKS);
}

/** `ASK: …` lines kept only when they are his words (found in what he wrote); `NEXT: …`; `NONE` = nothing asked. */
export function parseUnderstood(text: string, written: string): { asks: string[]; next: string | null; none: boolean } {
  const body = norm(written);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const none = lines.some((l) => /^NONE\b/i.test(l)) && !lines.some((l) => /^ASK\s*:/i.test(l));
  const asks: string[] = [];
  for (const l of lines) {
    const m = /^ASK\s*:\s*(.+)$/i.exec(l);
    if (!m) continue;
    const ask = m[1]!.trim().replace(/^["“]|["”]$/g, "").trim();
    if (ask.length >= 3 && body.includes(norm(ask)) && !asks.some((a) => norm(a) === norm(ask))) asks.push(ask);
  }
  const next = lines.map((l) => /^NEXT\s*:\s*(.+)$/i.exec(l)?.[1]?.trim()).find(Boolean) ?? null;
  return { asks: asks.slice(0, MAX_ASKS), next: next ? next.slice(0, 280) : null, none };
}

function understoodPrompt(subject: string, written: string): string {
  return [
    "A Managing Partner of the firm just emailed the work below. List each separate thing he is asking for.",
    "Rules: copy his EXACT words for each ask (a phrase or sentence from his email, unchanged, no rewording, no summary).",
    "One line per ask: ASK: <his exact words>",
    "Then one line: NEXT: <what happens next, one plain sentence, no promises of dates, nothing about models or systems>",
    "If he asks for nothing (a thank-you, an FYI), answer exactly: NONE",
    "Nothing else in your answer.",
    "",
    `Subject: ${subject}`,
    "Email:",
    written.slice(0, 6000),
  ].join("\n");
}

interface Candidate {
  id: string;
  message_id: string | null;
  r2_key: string | null;
  subject: string | null;
  received_at: string;
  firm_scope: string;
  partner: string | null;
  card_id: string;
  title: string;
  owner_id: string | null;
  prompt: string | null;
  state: string;
  kind: string | null;
}

async function wordsOf(env: Env, row: Candidate): Promise<string> {
  // WHAT THE DOOR ACTUALLY READ (15 Nov 2026): a reply's steer carries his typed words AND each voice note's and linked
  // recording's transcript, so the Got it answers what was heard, never only what was typed.
  if (row.message_id) {
    const steer = await env.WP_OS_DB.prepare("SELECT body FROM work_steer WHERE message_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(row.message_id).first<{ body: string }>().catch(() => null);
    if (steer?.body?.trim()) return steer.body.trim();
  }
  let raw = "";
  try {
    raw = row.r2_key && env.WP_OS_DOCUMENTS ? ((await (await env.WP_OS_DOCUMENTS.get(row.r2_key))?.text()) ?? "") : "";
  } catch {
    raw = "";
  }
  const own = raw ? partnersOwnWords(textBodyOf(raw)).trim() : "";
  return own || (row.prompt ?? "").trim() || (row.subject ?? "").trim();
}

async function employeeName(env: Env, id: string | null): Promise<string> {
  if (!id) return "West Peek";
  const row = await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(id).first<{ name: string }>();
  return row?.name ?? "West Peek";
}

async function settle(env: Env, messageId: string, state: string, via: string | null, asks: number, detail: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE partner_understood SET state = ?2, via = ?3, asks = ?4, detail = ?5, sent_at = CASE WHEN ?2 = 'SENT' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE sent_at END WHERE inbound_message_id = ?1",
  )
    .bind(messageId, state, via, asks, detail.slice(0, 400))
    .run();
}

/**
 * STEP 1. Every authenticated partner email linked to a card in the last half hour, not yet answered, gets its one
 * "Got it". Returns how many were sent. Never throws into the sweep.
 */
export async function sendUnderstoodReplies(env: Env, now: Date, read: SeatRead = confidentialSeatRead): Promise<number> {
  const since = new Date(now.getTime() - UNDERSTOOD_WINDOW_MINUTES * 60_000).toISOString();
  const until = new Date(now.getTime() + 60_000).toISOString();
  let rows: Candidate[] = [];
  try {
    rows = (
      await env.WP_OS_DB.prepare(
        `SELECT m.id, m.message_id, m.r2_key, m.subject, m.received_at, m.firm_scope, lower(json_extract(m.mail_authority_json, '$.partner')) AS partner,
                c.id AS card_id, c.title, c.owner_id, c.prompt, c.state, c.kind
           FROM inbound_message m JOIN work_card c ON c.id = m.work_card_id
          WHERE m.received_at >= ?1 AND m.received_at <= ?2
            AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM partner_understood u WHERE u.inbound_message_id = m.id)
          ORDER BY m.received_at ASC
          LIMIT ?3`,
      )
        .bind(since, until, UNDERSTOOD_PER_TICK)
        .all<Candidate>()
    ).results ?? [];
  } catch (err) {
    console.error("reading partner emails to answer failed", err);
    return 0;
  }
  let sent = 0;
  for (const row of rows) {
    try {
      if (await answerOne(env, row, read)) sent += 1;
    } catch (err) {
      console.error("a partner's Got it failed", err);
      await settle(env, row.id, "NOT_SENT", null, 0, `failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
  return sent;
}

async function answerOne(env: Env, row: Candidate, read: SeatRead): Promise<boolean> {
  const partner = partnerByEmail(row.partner);
  // The claim: a second tick (or a racing one) finds the row and does nothing.
  const claimed = await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO partner_understood (inbound_message_id, work_card_id, partner_email, firm_scope) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(row.id, row.card_id, partner?.email ?? String(row.partner ?? ""), row.firm_scope)
    .run();
  if ((claimed.meta?.changes ?? 0) !== 1) return false;
  if (!partner) {
    await settle(env, row.id, "NOT_SENT", null, 0, "the sender is not on the partner registry; a Got it goes to partners only");
    return false;
  }

  const written = await wordsOf(env, row);
  const subject = (row.subject ?? "").trim() || row.title.replace(/^From [^:]+@[^:]+:\s*/i, "").trim() || row.title;
  const out = written ? await read(env, { prompt: understoodPrompt(subject, written), firmScope: row.firm_scope, employeeId: row.owner_id, purpose: "the Got it reply to a partner's email: his asks in his words" }) : { ok: false, text: "", detail: "no words to read" };
  const parsed = out.ok ? parseUnderstood(out.text, written) : null;
  if (parsed?.none) {
    await settle(env, row.id, "NOTHING_ASKED", "MODEL", 0, "he asked for nothing (a thank-you or an FYI)");
    return false;
  }
  const viaModel = Boolean(parsed && parsed.asks.length);
  const asks = viaModel ? parsed!.asks : sentencesOf(written);
  if (!asks.length) {
    await settle(env, row.id, "NOTHING_ASKED", viaModel ? "MODEL" : "FALLBACK", 0, "no words to quote");
    return false;
  }
  const seqBase = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM partner_ask WHERE work_card_id = ?1").bind(row.card_id).first<{ n: number }>())?.n ?? 0;
  for (let i = 0; i < asks.length; i += 1) {
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO partner_ask (id, work_card_id, inbound_message_id, seq, words, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(`pask_${crypto.randomUUID()}`, row.card_id, row.id, seqBase + i + 1, asks[i]!.slice(0, 1000), row.firm_scope)
      .run();
  }

  // A noise card the runner already dropped, or a door that already answered him since he wrote: no second email.
  if (row.state === "CANCELLED") {
    await settle(env, row.id, "NOT_SENT", viaModel ? "MODEL" : "FALLBACK", asks.length, "the card was closed as needing no action");
    return false;
  }
  const answered = await env.WP_OS_DB.prepare("SELECT 1 AS x FROM work_card_notice WHERE work_card_id = ?1 AND sent = 1 AND sent_at >= ?2 LIMIT 1").bind(row.card_id, row.received_at).first<{ x: number }>();
  if (answered) {
    await settle(env, row.id, "NOT_SENT", viaModel ? "MODEL" : "FALLBACK", asks.length, "the door already answered him on this card");
    return false;
  }
  const cause = `understood:${row.id}`;
  if (await alreadyTold(env, row.card_id, "RECEIVED", cause)) {
    await settle(env, row.id, "SENT", viaModel ? "MODEL" : "FALLBACK", asks.length, "already sent");
    return false;
  }

  const next = viaModel
    ? parsed!.next ?? "I'm starting on it now. The next email from me is the result, or one question if something is unclear."
    : "No model could read it just now, so these are your sentences as you wrote them. Work starts when the Mac is back; the next email from me is the result, or one question.";
  const unopened = await filesNotOpened(env, row.card_id, row.received_at);
  const who = await employeeName(env, row.owner_id);
  const email = gotItEmail({ employee: who, subject, asks, next, unopened });
  const replyOnThread = await threadRootFor(env, row.card_id);
  const result = await sendOrPreview(env, {
    to: partner.email,
    email,
    objectType: "work_card",
    objectId: row.card_id,
    workCardId: row.card_id,
    cardKind: row.kind ?? null,
    // A receipt is not finished work: it never waits in a preview lane and copies nobody.
    cardAsked: false,
    requestedByEmail: partner.email,
    firmScope: row.firm_scope,
    actorId: "partner_understood",
    replyOnThread,
    events: { sent: "partner_understood.sent", notSent: "partner_understood.not_sent" },
  });
  await recordNotice(env, { cardId: row.card_id, kind: "RECEIVED", cause, to: partner.email, messageId: result.threadToken ?? null, sent: result.sent, detail: result.reason, firmScope: row.firm_scope });
  await settle(env, row.id, result.sent ? "SENT" : "NOT_SENT", viaModel ? "MODEL" : "FALLBACK", asks.length, result.reason);
  await appendEvent(env, {
    eventType: "partner_understood.answered",
    actorType: "system",
    actorId: "partner_understood",
    objectType: "work_card",
    objectId: row.card_id,
    firmScope: row.firm_scope,
    payload: { inbound_message_id: row.id, sent: result.sent, via: viaModel ? "MODEL" : "FALLBACK", asks: asks.length, received_at: row.received_at, seat: out.ok ? "answered" : out.detail.slice(0, 200) },
  }).catch(() => undefined);
  return result.sent;
}

/** The "Got it" itself: his asks in his words, every file that could not be opened, what happens next. Pure. */
export function gotItEmail(input: { employee: string; subject: string; asks: readonly string[]; next: string; unopened: ReadonlyArray<{ filename: string; reason: string }> }) {
  const { asks, next, unopened } = input;
  return {
    employee: input.employee,
    what: `got it — ${input.subject.slice(0, 80)}`,
    tldr: `Got it. ${asks.length === 1 ? "One thing" : `${asks.length} things`} you asked, in your words, below. ${next}`,
    tldrBullets: [] as string[],
    sections: [
      { label: "What you asked", bullets: asks.map((a) => `"${a}"`) },
      // Read first, then answered: every file of his that could not be opened is named, never skipped in silence.
      ...(unopened.length ? [{ label: "What I could not open", bullets: unopened.map((f) => `${f.filename}: ${f.reason}`) }] : []),
      { label: "What happens next", bullets: [next, "Reply to this email to change anything; I read it before I go on."] },
    ],
    details: null,
  };
}

/** Every file of this message the door could not open (files, voice notes, Drive links), from the card's record. */
async function filesNotOpened(env: Env, cardId: string, receivedAt: string): Promise<Array<{ filename: string; reason: string }>> {
  const rows = (
    await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_type = 'work_card' AND object_id = ?1 AND event_type = ?2 AND created_at >= ?3 ORDER BY created_at")
      .bind(cardId, FILES_NOT_OPENED, receivedAt)
      .all<{ payload_json: string }>()
      .catch(() => ({ results: [] as Array<{ payload_json: string }> }))
  ).results ?? [];
  const out: Array<{ filename: string; reason: string }> = [];
  for (const r of rows) {
    try {
      for (const f of (JSON.parse(r.payload_json) as { files?: Array<{ filename: string; reason: string }> }).files ?? []) {
        if (!out.some((o) => o.filename === f.filename)) out.push(f);
      }
    } catch {
      /* a payload that is not JSON names nothing */
    }
  }
  return out.slice(0, 12);
}

/** Past this, a partner email with no acknowledgement is raised on Sequoia's desk (her rule: never silent). */
export const UNACKNOWLEDGED_MINUTES = 5;

/**
 * NEVER SILENT (15 Nov 2026). On the sweep, after the Got it lane. Three shapes, each raised once on Sequoia's desk:
 *   1 · a door that started and never finished (its claim still unfinished past the window): killed. Two of those on one
 *       message and it is handed to a Mac session instead of being read inline a third time.
 *   2 · a partner email placed on a card with no Got it past the window.
 *   3 · a message handed to a Mac session that has not finished it past the window (the Mac is asleep).
 * Returns how many were raised. Never throws into the sweep.
 */
export async function raiseUnacknowledgedMail(env: Env, now: Date = new Date()): Promise<number> {
  const { raiseUnreadMail, handOffUnreadableMail, headersOfRaw, INLINE_READ_ATTEMPTS } = await import("../effects/inboundEmail");
  const late = new Date(now.getTime() - UNACKNOWLEDGED_MINUTES * 60_000).toISOString();
  const day = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const hour = new Date(now.getTime() - 60 * 60_000).toISOString();
  let raised = 0;
  try {
    const died = (await env.WP_OS_DB.prepare(
      `SELECT s.message_id, s.attempts, m.r2_key, m.from_address, m.subject FROM inbound_email_seen s LEFT JOIN inbound_message m ON m.message_id = s.message_id
        WHERE s.handled = 0 AND s.seen_at < ?1 AND s.seen_at >= ?2 LIMIT 10`,
    ).bind(late, day).all<{ message_id: string; attempts: number; r2_key: string | null; from_address: string | null; subject: string | null }>()).results ?? [];
    for (const d of died) {
      if (d.attempts >= INLINE_READ_ATTEMPTS) {
        const claimed = await env.WP_OS_DB.prepare("UPDATE inbound_email_seen SET handled = 2 WHERE message_id = ?1 AND handled = 0").bind(d.message_id).run();
        if ((claimed.meta?.changes ?? 0) !== 1) continue;
        // Only the header block is read back (a ranged get): never the body.
        const head = d.r2_key && env.WP_OS_DOCUMENTS ? await (await env.WP_OS_DOCUMENTS.get(d.r2_key, { range: { offset: 0, length: 64 * 1024 } }))?.text() : null;
        await handOffUnreadableMail(env, { messageId: d.message_id, sender: d.from_address ?? "unknown", subject: d.subject ?? "", headers: headersOfRaw(head ?? "") });
      } else {
        await raiseUnreadMail(env, {
          dedupeKey: `inbound_email_door_died:${d.message_id}`,
          title: "An email's read was stopped before it finished",
          body: `From ${(d.from_address ?? "unknown").slice(0, 120)}, subject "${(d.subject ?? "").slice(0, 120)}". The Worker began reading it and was stopped; no "Got it" was sent. A redelivery reads it again${d.r2_key ? `; it is stored at ${d.r2_key}` : ""}.`,
          objectId: d.message_id,
        });
      }
      raised += 1;
    }
    const noGotIt = (await env.WP_OS_DB.prepare(
      `SELECT m.id, m.work_card_id, m.from_address, m.subject FROM inbound_message m
        WHERE m.work_card_id IS NOT NULL AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
          AND m.received_at < ?1 AND m.received_at >= ?2
          AND NOT EXISTS (SELECT 1 FROM partner_understood u WHERE u.inbound_message_id = m.id) LIMIT 10`,
    ).bind(late, hour).all<{ id: string; work_card_id: string; from_address: string; subject: string }>()).results ?? [];
    for (const m of noGotIt) {
      await raiseUnreadMail(env, {
        dedupeKey: `partner_email_no_got_it:${m.id}`,
        title: `No "Got it" went to a partner within ${UNACKNOWLEDGED_MINUTES} minutes`,
        body: `From ${m.from_address.slice(0, 120)}, subject "${m.subject.slice(0, 120)}", on card ${m.work_card_id}. It was read and placed on the card, but no Got it has gone.`,
        objectId: m.id,
      });
      raised += 1;
    }
    const macSlow = (await env.WP_OS_DB.prepare(
      `SELECT e.object_id AS message_id, json_extract(e.payload_json, '$.session_card') AS card FROM event_record e JOIN work_card c ON c.id = json_extract(e.payload_json, '$.session_card')
        WHERE e.event_type = 'inbound_email.handed_off' AND e.created_at < ?1 AND e.created_at >= ?2 AND c.state NOT IN ('DONE', 'CANCELLED') LIMIT 10`,
    ).bind(late, day).all<{ message_id: string; card: string }>()).results ?? [];
    for (const m of macSlow) {
      await raiseUnreadMail(env, {
        dedupeKey: `inbound_email_mac_slow:${m.message_id}`,
        title: "The Mac has not read an email it took over",
        body: `Session card ${m.card} was handed an email the Worker could not read, and it has not finished after ${UNACKNOWLEDGED_MINUTES} minutes. The Mac may be asleep; no "Got it" has gone.`,
        objectId: m.message_id,
      });
      raised += 1;
    }
  } catch (err) {
    console.error("raising unacknowledged mail failed", err);
  }
  return raised;
}

// ── STEP 7 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface AskRow { id: string; seq: number; words: string; status: AskStatus | null; why: string | null }

const STATUS_WORDS: Record<AskStatus, string> = { DONE: "Done", IN_PROGRESS: "In progress", NOT_DONE: "Not done" };

function statusOf(s: unknown): AskStatus | null {
  const v = String(s ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "DONE") return "DONE";
  if (v === "IN_PROGRESS" || v === "INPROGRESS" || v === "STARTED") return "IN_PROGRESS";
  if (v === "NOT_DONE" || v === "NOTDONE" || v === "NOT") return "NOT_DONE";
  return null;
}

/** The runner's own report, when it gave one: `{"asks":[{"words","status","why"}]}` anywhere in what it finished with. */
export function reportedAsks(detail: string): Array<{ words: string; status: AskStatus; why: string }> {
  const at = detail.indexOf('{"asks"');
  const start = at >= 0 ? at : detail.search(/\{\s*"asks"\s*:/);
  if (start < 0) return [];
  for (let end = detail.lastIndexOf("}"); end > start; end = detail.lastIndexOf("}", end - 1)) {
    try {
      const parsed = JSON.parse(detail.slice(start, end + 1)) as { asks?: Array<{ words?: string; status?: string; why?: string }> };
      return (parsed.asks ?? []).flatMap((a) => {
        const status = statusOf(a.status);
        return status && a.words && String(a.why ?? "").trim() ? [{ words: String(a.words), status, why: String(a.why).trim() }] : [];
      });
    } catch {
      // keep shortening until it parses
    }
  }
  return [];
}

function markPrompt(asks: AskRow[], detail: string): string {
  return [
    "A Managing Partner asked for the numbered things below. The work is finished; its report follows.",
    "For EACH number, say what happened, judged only from the report:",
    "<number> | DONE or IN_PROGRESS or NOT_DONE | <why, under 25 words, concrete>",
    "One line per number, every number, nothing else.",
    "",
    ...asks.map((a, i) => `${i + 1}. ${a.words}`),
    "",
    "Report:",
    detail.slice(0, 6000),
  ].join("\n");
}

async function mark(env: Env, id: string, status: AskStatus, why: string): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE partner_ask SET status = ?2, why = ?3, marked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(id, status, why.slice(0, 400)).run();
}

export type AsksAtDone =
  | { ok: true; section: { label: string; bullets: string[] } | null; counts: Record<AskStatus, number> }
  | { ok: false; missing: string[]; seatWait?: boolean };

/** How a card waiting for a seat to mark its asks before the DONE says so (`waiting_for`); the session runner reads it. */
export const MARKING_SEAT_WAIT = "Waiting for a seat to mark each ask before the final reply";

/**
 * STEP 7's GUARD. Null asks = nothing to do (`section: null`). Otherwise every ask is marked from the report, then
 * by one confidential read; any still unmarked → the DONE is refused and the card is put back to work.
 */
export async function asksAtDone(
  env: Env,
  card: { id: string; title: string; owner_id: string | null; firm_scope: string; requested_by_email?: string | null },
  detail: string,
  read: SeatRead = confidentialSeatRead,
): Promise<AsksAtDone> {
  const empty = { DONE: 0, IN_PROGRESS: 0, NOT_DONE: 0 };
  // The DONE that reaches a partner is the one that must be complete; a duty card nobody emailed has no reply to guard.
  if (!partnerByEmail(card.requested_by_email)) return { ok: true, section: null, counts: empty };
  const load = async (): Promise<AskRow[]> =>
    (await env.WP_OS_DB.prepare("SELECT id, seq, words, status, why FROM partner_ask WHERE work_card_id = ?1 ORDER BY seq").bind(card.id).all<AskRow>()).results ?? [];
  let asks = await load();
  if (!asks.length) return { ok: true, section: null, counts: empty };

  for (const r of reportedAsks(detail)) {
    const hit = asks.find((a) => !a.status && (norm(a.words) === norm(r.words) || norm(a.words).includes(norm(r.words)) || norm(r.words).includes(norm(a.words))));
    if (hit) {
      await mark(env, hit.id, r.status, r.why);
      hit.status = r.status;
      hit.why = r.why;
    }
  }
  let open = asks.filter((a) => !a.status);
  let seatDown: string | null = null;
  if (open.length) {
    const out = await read(env, { prompt: markPrompt(open, detail), firmScope: card.firm_scope, employeeId: card.owner_id, purpose: "marking each of a partner's asks before the final reply" });
    if (!out.ok) seatDown = out.detail || "no seat answered";
    if (out.ok) {
      for (const line of out.text.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s*[|.)]\s*([A-Z_ -]+?)\s*\|\s*(.+)$/i.exec(line);
        const ask = m ? open[Number(m[1]) - 1] : undefined;
        const status = m ? statusOf(m[2]) : null;
        if (ask && status && !ask.status && m![3]!.trim()) await mark(env, ask.id, status, m![3]!.trim());
      }
    }
    asks = await load();
    open = asks.filter((a) => !a.status);
  }
  if (open.length && seatDown) {
    /*
     * NO SEAT ANSWERED THE MARKING READ (15 Nov 2026). That is seat trouble, not unfinished work: the same wait #442 gives
     * every card whose seat is busy or asleep. The claim's attempt is handed back and the card tries the DONE again by
     * itself in SEAT_WAIT_MINUTES, so a seat outage can never spend the three attempts and end in a Blocked card or a
     * Blocked note to the partner. Nothing is emailed.
     */
    const missing = open.map((a) => a.words);
    const { SEAT_WAIT_MINUTES } = await import("./blocks");
    const until = new Date(Date.now() + SEAT_WAIT_MINUTES * 60_000).toISOString();
    const line = `${MARKING_SEAT_WAIT} (${seatDown.slice(0, 160)}), so the final reply tries again by itself in about ${SEAT_WAIT_MINUTES} minutes.`;
    await env.WP_OS_DB.prepare(
      `UPDATE work_card SET state = 'IN_PROGRESS', lease_until = ?2, waiting_until = ?2, waiting_for = ?3, next_action = ?3,
              work_attempts = MAX(COALESCE(work_attempts, 1) - 1, 0), work_last_failure = ?3, work_last_failure_at = ?4
        WHERE id = ?1`,
    )
      .bind(card.id, until, line.slice(0, 400), new Date().toISOString())
      .run();
    await appendEvent(env, {
      eventType: "work_card.waiting_for_seat",
      actorType: "system",
      actorId: "partner_understood",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { at: new Date().toISOString(), until, marking_asks: missing.length, detail: seatDown.slice(0, 240) },
    }).catch(() => undefined);
    return { ok: false, missing, seatWait: true };
  }
  if (open.length) {
    const missing = open.map((a) => a.words);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', lease_until = NULL, next_action = ?2 WHERE id = ?1")
      .bind(card.id, `Before this is finished, say for each of these whether it is done, in progress or not done, and why: ${missing.map((w) => `"${w}"`).join("; ")}`.slice(0, 1500))
      .run();
    await appendEvent(env, {
      eventType: "partner_asks.done_refused",
      actorType: "system",
      actorId: "partner_understood",
      objectType: "work_card",
      objectId: card.id,
      firmScope: card.firm_scope,
      payload: { missing, asks: asks.length },
    }).catch(() => undefined);
    return { ok: false, missing };
  }
  const counts = { ...empty };
  for (const a of asks) counts[a.status!] += 1;
  return {
    ok: true,
    counts,
    section: { label: "Each thing you asked", bullets: asks.map((a) => `${STATUS_WORDS[a.status!]}: "${a.words}" — ${a.why ?? ""}`.trim()) },
  };
}

/** The DONE email when the card has asks and no composed email of its own. */
export function doneEmailWithAsks(
  asked: string,
  detail: string,
  asks: { section: { label: string; bullets: string[] }; counts: Record<AskStatus, number> },
  cardId: string,
): { what: string; tldr: string; tldrBullets: string[]; sections: Array<{ label: string; bullets: string[] }>; details: string | null } {
  const c = asks.counts;
  const parts = [c.DONE ? `${c.DONE} done` : null, c.IN_PROGRESS ? `${c.IN_PROGRESS} in progress` : null, c.NOT_DONE ? `${c.NOT_DONE} not done` : null].filter(Boolean).join(", ");
  const found = detail.split(/\r?\n/).map((l) => l.replace(/^[\s•\-*]+/, "").trim()).filter((l) => l && !l.startsWith('{"asks"')).slice(0, 8);
  return {
    what: `done — ${asked}`,
    tldr: `Finished: ${parts}. Each thing you asked is marked below.`,
    tldrBullets: [],
    sections: [
      asks.section,
      { label: "What I found", bullets: found.length ? found : ["The findings are on the card."] },
      { label: "Your call", bullets: ["Nothing, unless you want it taken further — reply and say how.", `Everything done on it is on the card: https://os.joinwestpeek.com/#/work (card ${cardId})`] },
    ],
    details: detail,
  };
}
