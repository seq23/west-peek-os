// Copied from: seq23/boss-os src/worker/boss/lib/operatingStop.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
// Copied from: seq23/boss-os src/worker/boss/agents/simoneSickDay.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
import { z } from "zod";
import { PARTNERS } from "../../shared/registry/partners";
import type { MailAuthority } from "../../shared/intake/partnerAuthority";
import type { Env } from "../env";
import { appendEvent, eventStatement } from "../events";
import { z as zv4 } from "zod/v4";
import { readStructured, structuredOutput } from "../ai/structuredOutput";
import { json, type RouteContext } from "../router";

const OWNER = PARTNERS.find((partner) => partner.firstName === "Sequoia")!;
const DAY = 86_400_000;
export const OPERATIONS_ENABLED = "(SELECT stopped FROM owner_operating_control WHERE id = 1) = 0";

export async function operatingStopped(env: Env): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(`SELECT ${OPERATIONS_ENABLED} AS enabled`).first<{ enabled: number }>();
  return row?.enabled !== 1;
}

async function setOperatingStop(env: Env, stopped: boolean, source: "email" | "page") {
  const db = env.WP_OS_DB;
  const event = eventStatement(env, {
    eventType: stopped ? "operations.stopped" : "operations.resumed",
    actorType: "firm_user", actorId: OWNER.firmUserId,
    objectType: "owner_operating_control", objectId: "1",
    payload: { source },
  });
  const statements = [
    db.prepare("UPDATE owner_operating_control SET stopped = ?1 WHERE id = 1").bind(stopped ? 1 : 0),
    event.statement,
  ];
  if (stopped) {
    // Invalidate a running Mac's lease even if the owner resumes between two of its pings.
    statements.push(db.prepare(`UPDATE subscription_seat_run
      SET status = 'ABANDONED', resolution = 'Paused by the owner', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status = 'CLAIMED'`));
  }
  await db.batch(statements);
}

const emailCover = z.object({
  operation: z.literal("cover_mailbox"),
  mailbox: z.literal(OWNER.email),
  until: z.string().datetime({ offset: true }).optional(),
}).strict();

/*
 * THE OWNER'S CONTROL, READ BY A MODEL (review of #618, 28 Nov 2026, F3).
 * Copied from: seq23/boss-os src/worker/boss/agents/simoneSickDay.ts @ 1ccba1bd (the reader shape and its hard stops).
 * Whether a short direct email from her asks to stop everything, resume, or have Wren cover her mailbox is MEANING, so
 * a model reads it from her own words, signature lines taken off first. Code keeps the hard stops: only her own direct,
 * authenticated, unquoted, unforwarded mail is read at all; a cover names her mailbox and ends within seven days
 * (none named: 72 hours); a reader that does not answer switches nothing on except the exact command (logged).
 */
export const OWNER_CONTROL_PURPOSE = "reading the owner's stop, resume or cover control";
const CONTROL_MAX_CHARS = 4_000;
export type ControlOperation = "STOP_EVERYTHING" | "RESUME" | "COVER_MAILBOX" | "NONE";
export interface ControlReading { operation: ControlOperation; mailbox: string | null; until: string | null; also: boolean }
export type ControlReader = (env: Env, input: { words: string; nowText: string }) => Promise<ControlReading | null>;

const CONTROL_OUTPUT = structuredOutput("owner_control", zv4.object({
  operation: zv4.enum(["STOP_EVERYTHING", "RESUME", "COVER_MAILBOX", "NONE"]),
  mailbox: zv4.string().nullable(),
  until: zv4.string().nullable(),
  also: zv4.boolean(),
}));

export function controlPrompt(words: string, nowText: string): string {
  return [
    "You read one email the owner of West Peek OS wrote to the firm's own mailbox. Decide only whether she is, now, giving one of these controls:",
    "STOP_EVERYTHING: pause every West Peek OS agent at once (all of them, not one job, one card or one email sequence).",
    "RESUME: turn every paused West Peek OS agent back on.",
    `COVER_MAILBOX: ask Wren, her chief of staff, to look after (read and handle) the mailbox ${OWNER.email} for a while.`,
    "NONE: anything else, including a question about these, a past or hypothetical ask, a stop for one job only, or words she is quoting.",
    'Answer with JSON only: {"operation": one of the four, "mailbox": the address she names or null, "until": the end she gave as ISO 8601 with an offset in her zone (America/Chicago; for a day with no time, 23:59 that day) or null, "also": true when the email asks for anything besides the control}.',
    `Now: ${nowText}`,
    "Her email:",
    words,
  ].join("\n");
}

/** Her first-read ladder with the Mac seat last: the seat queue is paused while she is, and "resume" must still be read. */
const ladderReader: ControlReader = async (env, input) => {
  const { FIRST_READERS } = await import("./partnerUnderstood");
  const readers = [...FIRST_READERS.filter((r) => r.name !== "SEAT"), ...FIRST_READERS.filter((r) => r.name === "SEAT")];
  for (const r of readers) {
    const out = await r.read(env, { prompt: controlPrompt(input.words, input.nowText), firmScope: "west-peek", employeeId: null, purpose: OWNER_CONTROL_PURPOSE, output: CONTROL_OUTPUT })
      .catch(() => null);
    const read = out?.ok ? readStructured(CONTROL_OUTPUT, out.text) : null;
    if (read) return read;
  }
  return null;
};
let controlReader: ControlReader = ladderReader;
/** Tests swap in a fake model; null restores the ladder. */
export function setControlReader(reader: ControlReader | null): void { controlReader = reader ?? ladderReader; }

/** The exact command, the logged last resort when no reader answered. Pure. */
export function exactControl(written: string): "STOP_EVERYTHING" | "RESUME" | null {
  const words = written.trim().toLowerCase().replace(/[.!\s]+$/, "");
  return words === "stop everything" ? "STOP_EVERYTHING" : words === "resume" ? "RESUME" : null;
}

export type ControlOutcome = { applied: false } | { applied: true; operation: Exclude<ControlOperation, "NONE">; alsoAsks: boolean };

/** Controls come from a fresh, directly delivered owner email or a confirmed owner page action. */
export async function applyChiefControlEmail(
  env: Env,
  input: { authority: MailAuthority; words: string; direct: boolean },
  now = Date.now(),
): Promise<ControlOutcome> {
  if (!input.direct || !input.authority.isAssignment || input.authority.partnerAddress !== OWNER.email) return { applied: false };
  const { withoutSignatures } = await import("./emailRouting");
  const written = withoutSignatures(input.words).trim();
  if (!written || written.length > CONTROL_MAX_CHARS) return { applied: false };
  // A structured cover is exact syntax, never a scan of prose; it needs no reader.
  if (written.startsWith("{") && written.length <= 512) {
    let value: unknown;
    try { value = JSON.parse(written); } catch { value = null; }
    const parsed = emailCover.safeParse(value);
    if (parsed.success) {
      const until = parsed.data.until === undefined ? now + 3 * DAY : Date.parse(parsed.data.until);
      return await openCover(env, until, now) ? { applied: true, operation: "COVER_MAILBOX", alsoAsks: false } : { applied: false };
    }
  }
  const reading = await controlReader(env, { words: written, nowText: `${new Date(now).toISOString()} (${await centralTime(new Date(now).toISOString())})` }).catch(() => null);
  if (!reading) {
    const exact = exactControl(written);
    if (!exact) return { applied: false };
    await appendEvent(env, { eventType: "operations.control_exact_fallback", actorType: "system", actorId: "owner_control",
      objectType: "owner_operating_control", objectId: "1", payload: { operation: exact, why: "no reader answered" } });
    await setOperatingStop(env, exact === "STOP_EVERYTHING", "email");
    await confirmControl(env, exact, now);
    return { applied: true, operation: exact, alsoAsks: false };
  }
  const alsoAsks = reading.also !== false;
  if (reading.operation === "STOP_EVERYTHING" || reading.operation === "RESUME") {
    await setOperatingStop(env, reading.operation === "STOP_EVERYTHING", "email");
    await confirmControl(env, reading.operation, now);
    return { applied: true, operation: reading.operation, alsoAsks };
  }
  if (reading.operation !== "COVER_MAILBOX" || (reading.mailbox ?? "").trim().toLowerCase() !== OWNER.email) return { applied: false };
  // An end with no offset would be read as UTC, hours off in her zone: refused, never guessed.
  const untilText = (reading.until ?? "").trim();
  const until = untilText ? (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(untilText) ? Date.parse(untilText) : NaN) : now + 3 * DAY;
  if (!await openCover(env, until, now)) {
    await confirm(env, "cover not switched on", `I have not switched on ${OWNER.email} for Wren: tell me an end within seven days (by ${await centralTime(new Date(now + 7 * DAY).toISOString())}).`,
      [{ label: "What happened", bullets: ["The end you gave was missing an offset, in the past, or more than seven days away"] },
        { label: "To switch it on", bullets: ["Email the cover again with an end within seven days"] }]);
    return { applied: true, operation: "COVER_MAILBOX", alsoAsks };
  }
  return { applied: true, operation: "COVER_MAILBOX", alsoAsks };
}

async function openCover(env: Env, until: number, now: number): Promise<boolean> {
  if (!Number.isFinite(until) || until <= now || until > now + 7 * DAY) return false;
  const event = eventStatement(env, {
    eventType: "chief.mail_cover_opened",
    actorType: "firm_user", actorId: OWNER.firmUserId,
    objectType: "owner_operating_control", objectId: "1",
    payload: { until_ms: until },
  });
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare("UPDATE owner_operating_control SET wren_mail_until_ms = ?1 WHERE id = 1").bind(until),
    event.statement,
  ]);
  await confirm(env, "mailbox cover on", `Wren can read ${OWNER.email} until ${await centralTime(new Date(until).toISOString())}. It switches off by itself then.`,
    [{ label: "What this covers", bullets: [`Mail in ${OWNER.email} only; calendar and Drive are unchanged`] },
      { label: "To end it sooner", bullets: ["Reply with when it should end"] }]);
  return true;
}

/** "Sat, Nov 28, 9:41 AM Central": every time she reads is Central. */
async function centralTime(iso: string): Promise<string> {
  return (await import("./partnerProgress")).centralTime(iso);
}

/** Her confirmation, sent straight to her (the partner lane is not an agent, so it still goes while agents are paused). */
async function confirmControl(env: Env, operation: "STOP_EVERYTHING" | "RESUME", now: number): Promise<void> {
  const at = await centralTime(new Date(now).toISOString());
  if (operation === "STOP_EVERYTHING") {
    await confirm(env, "all agents paused", `Paused all West Peek OS agents at ${at}.`, [
      { label: "What stopped", bullets: ["Every agent, scheduled job, the work sweep and the Mac's sessions", "Mail that arrives now is kept and worked after you resume", "Unsubscribes, bounces and brand replies are still recorded, so nobody who opts out is mailed later"] },
      { label: "To resume", bullets: ["Email os@ the word resume, or use Resume on the Employees page"] },
    ]);
    return;
  }
  const held = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM operating_held_mail WHERE replayed_at IS NULL").first<{ n: number }>().catch(() => null))?.n ?? 0;
  await confirm(env, "agents resumed", `Resumed all West Peek OS agents at ${at}.`, [
    { label: "What happens now", bullets: [held ? `${held} email${held === 1 ? "" : "s"} held during the pause will be worked within about 15 minutes` : "No email was held during the pause", "Scheduled jobs and the work sweep pick up on their next run"] },
    { label: "To pause again", bullets: ["Email os@ stop everything, or use Pause on the Employees page"] },
  ]);
}

async function confirm(env: Env, what: string, tldr: string, sections: { label: string; bullets: string[] }[]): Promise<void> {
  const { sendPartnerEmail } = await import("./execEmail");
  const out = await sendPartnerEmail(env, {
    to: OWNER.email,
    email: { employee: "Wren", what, tldr, tldrBullets: [], sections, details: null },
    objectType: "owner_operating_control", objectId: "1", firmScope: "west-peek", actorId: "owner_control",
    events: { sent: "operations.control_confirmed", notSent: "operations.control_confirmation_not_sent" },
  }).catch((err: unknown) => ({ sent: false, reason: err instanceof Error ? err.message : String(err) }));
  if (!out.sent) console.warn("owner control confirmation not sent", out.reason);
}

/*
 * MAIL HELD IN A PAUSE IS WORKED AFTER IT (review of #618, F2). The door keeps every message in R2 before anything
 * reads it; while she is paused the key is held here, and the first ticks after "resume" put each one back through
 * the same door, once.
 */
export async function holdMailForResume(env: Env, emlKey: string, routeAs: unknown): Promise<void> {
  await env.WP_OS_DB.prepare(`INSERT INTO operating_held_mail (eml_key, route_as_json) VALUES (?1, ?2)
    ON CONFLICT(eml_key) DO UPDATE SET replayed_at = NULL, outcome = NULL, route_as_json = excluded.route_as_json`)
    .bind(emlKey, routeAs === undefined || routeAs === null ? null : JSON.stringify(routeAs)).run();
  await appendEvent(env, { eventType: "operations.mail_held", actorType: "system", actorId: "inbound_email",
    objectType: "inbound_email", objectId: emlKey.slice(0, 200), payload: { why: "agents paused by the owner" } });
}

export const HELD_MAIL_PER_TICK = 5;

/** Puts held messages back through the door after a resume. Never runs while paused. */
export async function replayHeldMail(env: Env, limit = HELD_MAIL_PER_TICK): Promise<Array<{ job_key: string; status: string; summary: string }>> {
  if (await operatingStopped(env)) return [];
  const rows = (await env.WP_OS_DB.prepare("SELECT eml_key, route_as_json FROM operating_held_mail WHERE replayed_at IS NULL ORDER BY held_at ASC LIMIT ?1")
    .bind(limit).all<{ eml_key: string; route_as_json: string | null }>().catch(() => ({ results: [] as { eml_key: string; route_as_json: string | null }[] }))).results ?? [];
  const out: Array<{ job_key: string; status: string; summary: string }> = [];
  for (const row of rows) {
    // Claimed atomically, so two ticks never work one message twice.
    const claim = await env.WP_OS_DB.prepare("UPDATE operating_held_mail SET replayed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE eml_key = ?1 AND replayed_at IS NULL")
      .bind(row.eml_key).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;
    const { replayStoredMessage, raiseUnreadMail } = await import("../effects/inboundEmail");
    let outcome: string;
    try {
      outcome = await replayStoredMessage(env, row.eml_key, row.route_as_json ? JSON.parse(row.route_as_json) : null) ? "WORKED" : "NOT_FOUND";
    } catch (err) {
      outcome = `FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
    }
    if (outcome !== "WORKED") {
      await raiseUnreadMail(env, { dedupeKey: `held_mail:${row.eml_key}`, title: "An email held during the pause could not be worked",
        body: `Stored as ${row.eml_key}: ${outcome}. Open it in the mailbox.`, objectId: row.eml_key });
    }
    await env.WP_OS_DB.prepare("UPDATE operating_held_mail SET outcome = ?2 WHERE eml_key = ?1").bind(row.eml_key, outcome).run();
    out.push({ job_key: "held_mail_replay", status: outcome === "WORKED" ? "SUCCEEDED" : "FAILED", summary: `${row.eml_key}: ${outcome}` });
  }
  return out;
}

/** The extra switch only applies to Wren's access to the owner's mailbox. */
export async function chiefCoverageAllows(
  env: Env, chiefId: string, service: string, account: string, now = Date.now(),
): Promise<boolean> {
  if (chiefId !== "aie_wren" || service !== "mail" || account.trim().toLowerCase() !== OWNER.email) return true;
  const row = await env.WP_OS_DB.prepare("SELECT wren_mail_until_ms FROM owner_operating_control WHERE id = 1")
    .first<{ wren_mail_until_ms: number | null }>();
  return typeof row?.wren_mail_until_ms === "number" && row.wren_mail_until_ms > now;
}

export async function handleOperatingControl({ identity, request, env }: RouteContext): Promise<Response> {
  if (identity?.id !== OWNER.firmUserId || !identity.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "not_found" }, { status: 404 });
  }
  const reply = (stopped: boolean) => json({ stopped }, { headers: { "Cache-Control": "no-store" } });
  if (request.method === "GET") return reply(await operatingStopped(env));
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body) {
    return json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const bytes = new Uint8Array(64);
  const reader = request.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > bytes.length) {
      await reader.cancel();
      return json({ error: "body_too_large" }, { status: 413 });
    }
    bytes.set(value, size);
    size += value.length;
  }
  let command: unknown;
  try { command = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); } catch { /* invalid command */ }
  if (command !== "pause-confirmed" && command !== "resume") {
    return json({ error: "confirmation_required" }, { status: 400 });
  }
  const stopped = command === "pause-confirmed";
  await setOperatingStop(env, stopped, "page");
  return reply(stopped);
}
