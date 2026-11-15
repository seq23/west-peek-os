import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendPartnerEmail } from "./execEmail";
import type { Partner } from "../../shared/registry/partners";
import { partnerByEmail } from "../../shared/registry/partners";

/**
 * A PARTNER IS NEVER LEFT IN SILENCE ON A LONG JOB (15 Nov 2026, wc_bd8b68cb). Scooter asked Walker at 19:46Z to check
 * 59 past clients "today"; the run that took his reply sat behind seat timeouts for six hours and he heard nothing
 * until the note. Now a reply that starts a run gets one short note on his own thread, "started, expect it by …",
 * and, if the card is still not finished then, one more saying it is taking longer and the new time. Never more:
 * the block email, the preview and the finished note are their own messages.
 */

/** How long a run a reply started is promised to take, and how much later the second promise is. */
export const STARTED_EXPECT_HOURS = 2;
export const SLIPPED_EXTRA_HOURS = 2;

const STARTED = "work_card.partner_told_started";
const SLIPPED = "work_card.partner_told_slipped";

/** "about 9:30 pm Central, Sat 14 Nov". Pure. */
export function centralTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " Central";
}

async function employeeOf(env: Env, cardId: string): Promise<{ name: string; title: string; kind: string | null; firm_scope: string; state: string } | null> {
  const card = await env.WP_OS_DB.prepare("SELECT title, kind, owner_id, firm_scope, state FROM work_card WHERE id = ?1").bind(cardId).first<{ title: string; kind: string | null; owner_id: string | null; firm_scope: string; state: string }>();
  if (!card) return null;
  const name = (await env.WP_OS_DB.prepare("SELECT name FROM ai_employee WHERE id = ?1").bind(card.owner_id).first<{ name: string }>().catch(() => null))?.name ?? "Walker";
  return { name, title: card.title.replace(/^From [^:]+@[^:]+:\s*/i, "").replace(/^\w+:\s*/, "").slice(0, 50), kind: card.kind, firm_scope: card.firm_scope, state: card.state };
}

async function send(env: Env, cardId: string, to: Partner, line: string, thread: string | null, tail: string): Promise<boolean> {
  const e = await employeeOf(env, cardId);
  if (!e) return false;
  const out = await sendPartnerEmail(env, {
    to: to.email,
    email: { employee: e.name, what: `${e.title} — ${tail}`.slice(0, 60), tldr: line, sections: [{ label: "Where it stands", bullets: [line] }], details: null },
    objectType: "work_card",
    objectId: cardId,
    firmScope: e.firm_scope,
    actorId: to.firmUserId,
    cardKind: e.kind,
    replyOnThread: thread,
    events: { sent: "work_card.progress_emailed", notSent: "work_card.progress_not_sent" },
  }).catch(() => ({ sent: false }));
  return out.sent;
}

/** His reply started a run: one note on his thread, once per email. */
export async function tellStarted(env: Env, input: { cardId: string; partnerEmail: string; thread: string | null; messageId: string | null; now?: Date }): Promise<boolean> {
  const partner = partnerByEmail(input.partnerEmail);
  if (!partner) return false;
  const key = input.messageId ?? `${input.cardId}:${(input.now ?? new Date()).toISOString().slice(0, 13)}`;
  const told = await env.WP_OS_DB.prepare(`SELECT 1 FROM event_record WHERE event_type = '${STARTED}' AND object_id = ?1 AND json_extract(payload_json, '$.key') = ?2`).bind(input.cardId, key).first();
  if (told) return false;
  const expectBy = new Date((input.now ?? new Date()).getTime() + STARTED_EXPECT_HOURS * 3_600_000).toISOString();
  const sent = await send(env, input.cardId, partner, `Got your reply and I've started on it. Expect it by about ${centralTime(expectBy)}; if it runs later I'll tell you here.`, input.thread, "started");
  await appendEvent(env, { eventType: STARTED, actorType: "system", actorId: "partner_progress", objectType: "work_card", objectId: input.cardId, firmScope: "west-peek", payload: { key, to: partner.email, expect_by: expectBy, thread: input.thread, sent } });
  return sent;
}

/** A promised time passed with the card still running: one more note each, with the new time. Read by the sweep. */
export async function tellSlipped(env: Env, now: Date): Promise<number> {
  const due = (await env.WP_OS_DB.prepare(
    `SELECT e.id, e.object_id AS card_id, e.payload_json
       FROM event_record e JOIN work_card c ON c.id = e.object_id
      WHERE e.event_type = '${STARTED}'
        AND json_extract(e.payload_json, '$.expect_by') < ?1 AND json_extract(e.payload_json, '$.expect_by') > ?2
        AND c.state IN ('OPEN', 'IN_PROGRESS')
        AND NOT EXISTS (SELECT 1 FROM event_record s WHERE s.event_type = '${SLIPPED}' AND json_extract(s.payload_json, '$.started') = e.id)
      LIMIT 5`,
  ).bind(now.toISOString(), new Date(now.getTime() - 3 * 86_400_000).toISOString()).all<{ id: string; card_id: string; payload_json: string }>()).results ?? [];
  let told = 0;
  for (const row of due) {
    const p = JSON.parse(row.payload_json) as { to?: string; thread?: string | null };
    const partner = partnerByEmail(p.to ?? "");
    if (!partner) continue;
    const newBy = new Date(now.getTime() + SLIPPED_EXTRA_HOURS * 3_600_000).toISOString();
    const sent = await send(env, row.card_id, partner, `This is taking longer than I said. I'm still on it; new time about ${centralTime(newBy)}.`, p.thread ?? null, "taking longer");
    await appendEvent(env, { eventType: SLIPPED, actorType: "system", actorId: "partner_progress", objectType: "work_card", objectId: row.card_id, firmScope: "west-peek", payload: { started: row.id, new_by: newBy, sent } });
    if (sent) told += 1;
  }
  return told;
}
