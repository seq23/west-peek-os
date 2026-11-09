import type { Env } from "../env";
import { appendEvent } from "../events";
import { TLC_BRAND_REPLY_NOTICE_OBJECT, TLC_OWNER, TLC_PRICING_NOTICE_OBJECT, brandDisplayName } from "../../shared/tlc/learningClub";
import { partnerByFirmUserId } from "../../shared/registry/partners";
import { docNameFor, replyPageUrl } from "../../shared/tlc/replyDoc";
import type { RenderedExecEmail } from "../../shared/email/execEmail";

/**
 * WYNN REMINDS ON AN UNANSWERED APPROVAL (owner, 9 Nov 2026; west-peek brain, Settled decisions). An approval email of
 * Wynn's that is still waiting gets a reminder 24 hours after the last email on its thread (Wynn's original, a redraft or
 * a reminder), then every 24 hours, until everyone it needs has answered or it is skipped:
 *   A · a round-1 brand reply (TLR-…, NOTIFIED): waits on Sequoia.
 *   B · a round-2 pricing draft (TLR-…, round PARTNERS): waits on whichever of Sequoia and Scooter has not answered.
 *   C · the newest weekly brands-to-approve batch (TLC-…): waits on Sequoia, for its drafts still pending review.
 * Only on a weekday, 9 AM to 5 PM in Chicago; a reminder due outside that goes at the next weekday 9 AM. Each goes on the
 * original email's thread (Re: its subject, In-Reply-To its token, the same ref), so a reply to it is read exactly like a
 * reply to the original. A new version email starts a new clock and a new count (the row is keyed by the email's time).
 * Reminders go to the partners only, through the one partner-email door: never to a brand.
 */
export const REMIND_EVERY_HOURS = 24;
export const REMIND_FROM_HOUR = 9;
export const REMIND_UNTIL_HOUR = 17;

const ctParts = (at: Date): { day: string; hour: number; weekday: string } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: String(p.weekday) };
};

/** A weekday, 9 AM to 5 PM, America/Chicago. */
export function inReminderWindow(now: Date): boolean {
  const ct = ctParts(now);
  return !["Sat", "Sun"].includes(ct.weekday) && ct.hour >= REMIND_FROM_HOUR && ct.hour < REMIND_UNTIL_HOUR;
}

/** "Saturday 7 Nov" in her clock. */
export function dayWords(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "long", day: "numeric", month: "short" }).format(new Date(iso)).replace(",", "");
}
/** "5 days" / "20 hours". */
export function waitedWords(fromIso: string, now: Date): string {
  const h = Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 3_600_000));
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  return `${h} hour${h === 1 ? "" : "s"}`;
}
const firstName = (id: string): string => partnerByFirmUserId(id)?.firstName ?? id;
const names = (ids: readonly string[]): string => ids.map(firstName).join(" and ");
const idList = (json: string | null | undefined): string[] => { try { const v = JSON.parse(json ?? "null"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const inputsOf = (json: string | null | undefined): Record<string, { approved: boolean }> => { try { const v = JSON.parse(json ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const reSubject = (s: string): string => (/^re:/i.test(s) ? s : `Re: ${s}`);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One reminder's words: plain text and the same lines as HTML. */
export function reminderEmail(subject: string, lines: readonly string[]): RenderedExecEmail {
  const text = `${lines.join("\n\n")}\n`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:600px">${lines.map((l) => `<p style="margin:0 0 12px">${esc(l).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>')}</p>`).join("")}</div>`;
  return { subject: reSubject(subject), text, html };
}

const nth = (n: number): string => `Reminder ${n}`;

interface Due {
  ref: string;
  forSentAt: string;
  objectType: string;
  to: string[];
  thread: { token: string; subject: string } | null;
  render: (n: number) => RenderedExecEmail;
  label: string;
}

/** A: round-1 replies and B: round-2 pricing drafts still waiting for an answer. */
async function brandReplyItems(env: Env, firmScope: string, now: Date): Promise<Due[]> {
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT r.id, r.kind, r.draft_body, r.round, r.inputs_json, r.approved_by_json, r.received_at, r.notice_ref, d.brand, d.contact_name,
            n.sent_at AS notice_sent_at, n.approvers_json
       FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id JOIN tlc_brand_reply_notice n ON n.ref = r.notice_ref
      WHERE r.firm_scope = ?1 AND r.state = 'NOTIFIED'`,
  ).bind(firmScope).all<{ id: string; kind: string | null; draft_body: string; round: string | null; inputs_json: string | null; approved_by_json: string | null; received_at: string; notice_ref: string; brand: string; contact_name: string | null; notice_sent_at: string; approvers_json: string | null }>()).results ?? [];
  const out: Due[] = [];
  for (const r of rows) {
    const needed = idList(r.approvers_json).length ? idList(r.approvers_json) : [TLC_OWNER.firmUserId];
    const inputs = inputsOf(r.inputs_json);
    const approvedIds = needed.filter((id) => inputs[id]?.approved || idList(r.approved_by_json).includes(id));
    // Whoever has not answered this email yet. (A partner who sent notes has answered: Wynn waits on the other.)
    const waiting = needed.filter((id) => !inputs[id] && !approvedIds.includes(id));
    if (waiting.length === 0) continue;
    const to = waiting.map((id) => (partnerByFirmUserId(id)?.email ?? "").toLowerCase()).filter(Boolean);
    if (to.length === 0) continue;
    const partners = needed.length > 1;
    const objectType = partners ? TLC_PRICING_NOTICE_OBJECT : TLC_BRAND_REPLY_NOTICE_OBJECT;
    const thread = await env.WP_OS_DB.prepare(`SELECT token, subject FROM email_thread WHERE object_id = ?1 AND object_type IN (?2, ?3) ORDER BY created_at DESC LIMIT 1`)
      .bind(r.notice_ref, TLC_PRICING_NOTICE_OBJECT, TLC_BRAND_REPLY_NOTICE_OBJECT).first<{ token: string; subject: string }>();
    const brand = brandDisplayName(r.brand);
    const doc = docNameFor(r.kind, r.kind === "PROPOSAL" || r.kind === "CONFIRM" || /\$\s?\d/.test(r.draft_body)).toLowerCase();
    const who = partners
      ? approvedIds.length
        ? `${names(approvedIds)} approved; waiting on ${waiting.length === 1 ? "you" : names(waiting)}. Nothing goes to ${brand} until you have both approved.`
        : `Nobody has approved yet: waiting on ${names(waiting)}. Nothing goes to ${brand} until you have both approved.`
      : `Waiting on you. Nothing goes to ${brand} until you approve.`;
    out.push({
      ref: r.notice_ref, forSentAt: r.notice_sent_at, objectType, to, thread, label: `${brand} ${doc}`,
      render: (n) => reminderEmail(thread?.subject ?? `${brand} ${doc} · ready for your OK · ${r.notice_ref}`, [
        `${nth(n)}: our ${doc} to ${brand} is still waiting for your OK. Wynn sent it to you ${dayWords(r.notice_sent_at)}.`,
        who,
        `${brand} has waited ${waitedWords(r.received_at, now)} since their last email (${dayWords(r.received_at)}).`,
        `Reply "approved", "skip", or your changes, on this thread.${waiting.length > 1 ? " Each of you replies." : ""}`,
        `The draft is in Wynn's email earlier on this thread; the whole ${brand} story is here: ${replyPageUrl(r.brand)}`,
        `Ref ${r.notice_ref}`,
      ]),
    });
  }
  return out;
}

/** C: the newest weekly batch, if any of its drafts are still waiting for her. A newer batch replaces an older one. */
async function batchItem(env: Env, firmScope: string): Promise<Due[]> {
  const notice = await env.WP_OS_DB.prepare("SELECT ref, root_ref, items_json, created_at FROM tlc_draft_notice WHERE firm_scope = ?1 ORDER BY created_at DESC LIMIT 1")
    .bind(firmScope).first<{ ref: string; root_ref: string | null; items_json: string; created_at: string }>();
  if (!notice) return [];
  const items = (() => { try { return JSON.parse(notice.items_json) as Array<{ kind?: string; message_id: string; card_id: string }>; } catch { return []; } })();
  let waiting = 0;
  for (const it of items) {
    const live = it.kind === "pitch"
      ? await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_pitch_followup f JOIN approval_card a ON a.id = f.approval_card_id WHERE f.deal_id = ?1 AND f.approval_card_id = ?2 AND f.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'").bind(it.message_id, it.card_id).first()
      : await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.id = ?1 AND m.approval_card_id = ?2 AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'").bind(it.message_id, it.card_id).first();
    if (live) waiting += 1;
  }
  if (waiting === 0) return [];
  const root = notice.root_ref ?? notice.ref;
  const thread = await env.WP_OS_DB.prepare("SELECT token, subject FROM email_thread WHERE object_type = 'tlc_drip' AND object_id = ?1 ORDER BY created_at LIMIT 1").bind(root).first<{ token: string; subject: string }>();
  const rootRow = root === notice.ref ? notice : await env.WP_OS_DB.prepare("SELECT created_at FROM tlc_draft_notice WHERE ref = ?1").bind(root).first<{ created_at: string }>();
  const batchDay = dayWords(rootRow?.created_at ?? notice.created_at);
  return [{
    ref: notice.ref, forSentAt: notice.created_at, objectType: "tlc_drip", to: [TLC_OWNER.email.toLowerCase()], thread, label: `the brand batch (${waiting} waiting)`,
    render: (n) => reminderEmail(thread?.subject ?? `Wynn: TLC: this week's brands · ${root}`, [
      `${nth(n)}: ${waiting} brand email${waiting === 1 ? " is" : "s are"} still waiting for you from ${batchDay}'s batch.`,
      "Nothing goes to a brand until you approve it.",
      `Reply "approve all", or "approve 1, 3" · "skip 2" · "change 2: what to change", on this thread. The numbers are the ones in Wynn's list earlier on this thread.`,
      `Ref ${notice.ref}`,
    ]),
  }];
}

export interface ReminderDeps { send?: (env: Env, input: { to: string[]; objectType: string; objectId: string; laidOut: RenderedExecEmail; replyOnThread: string | null; firmScope: string }) => Promise<boolean> }

async function defaultSend(env: Env, input: { to: string[]; objectType: string; objectId: string; laidOut: RenderedExecEmail; replyOnThread: string | null; firmScope: string }): Promise<boolean> {
  const { emailOwner } = await import("./learningClub");
  const [first, ...rest] = input.to;
  const sent = await emailOwner(env, {
    employee: "Wynn", to: [first!], ...(rest.length ? { cc: rest } : {}),
    email: { what: input.laidOut.subject, tldr: input.laidOut.text.split("\n")[0]!, sections: [], laidOut: input.laidOut },
    objectType: input.objectType, objectId: input.objectId, cardId: null, cardKind: null, firmScope: input.firmScope, replyOnThread: input.replyOnThread,
  });
  return sent.length > 0;
}

/** Every reminder that is due, in one pass, so a day's reminders arrive together. Returns one line for the run summary. */
export async function sendApprovalReminders(env: Env, now: Date, firmScope = "west-peek", deps: ReminderDeps = {}): Promise<string> {
  const items = [...await brandReplyItems(env, firmScope, now), ...await batchItem(env, firmScope)];
  if (items.length === 0) return "reminders: nothing waiting for an answer";
  if (!inReminderWindow(now)) return `reminders: ${items.length} waiting; outside 9 AM to 5 PM on a weekday in Chicago, they go at the next weekday 9 AM`;
  const day = ctParts(now).day;
  const cutoff = new Date(now.getTime() - REMIND_EVERY_HOURS * 3_600_000).toISOString();
  const sent: string[] = [];
  const notDue: string[] = [];
  const failed: string[] = [];
  for (const it of items) {
    if (it.forSentAt > cutoff) { notDue.push(it.label); continue; }
    const before = await env.WP_OS_DB.prepare("SELECT reminder_count, last_reminded_at, last_day FROM tlc_approval_reminder WHERE ref = ?1 AND for_sent_at = ?2").bind(it.ref, it.forSentAt)
      .first<{ reminder_count: number; last_reminded_at: string; last_day: string }>();
    if (before && (before.last_reminded_at > cutoff || before.last_day === day)) { notDue.push(it.label); continue; }
    // THE CLAIM: one reminder per thread per day, whatever a re-delivered or overlapping tick does.
    const claim = await env.WP_OS_DB.prepare(
      `INSERT INTO tlc_approval_reminder (ref, for_sent_at, reminder_count, last_reminded_at, last_day, sent_to_json) VALUES (?1, ?2, 1, ?3, ?4, ?5)
       ON CONFLICT(ref, for_sent_at) DO UPDATE SET reminder_count = reminder_count + 1, last_reminded_at = excluded.last_reminded_at, last_day = excluded.last_day, sent_to_json = excluded.sent_to_json
       WHERE tlc_approval_reminder.last_day <> excluded.last_day AND tlc_approval_reminder.last_reminded_at <= ?6`,
    ).bind(it.ref, it.forSentAt, now.toISOString(), day, JSON.stringify(it.to), cutoff).run();
    if ((claim.meta?.changes ?? 0) === 0) { notDue.push(it.label); continue; }
    const n = (before?.reminder_count ?? 0) + 1;
    const laidOut = it.render(n);
    const ok = await (deps.send ?? defaultSend)(env, { to: it.to, objectType: it.objectType, objectId: `${it.ref}:reminder:${n}`, laidOut, replyOnThread: it.thread?.token ?? null, firmScope }).catch(() => false);
    if (!ok) {
      // Not sent: the claim is given back, so the next tick tries again.
      if (before) await env.WP_OS_DB.prepare("UPDATE tlc_approval_reminder SET reminder_count = ?3, last_reminded_at = ?4, last_day = ?5 WHERE ref = ?1 AND for_sent_at = ?2").bind(it.ref, it.forSentAt, before.reminder_count, before.last_reminded_at, before.last_day).run();
      else await env.WP_OS_DB.prepare("DELETE FROM tlc_approval_reminder WHERE ref = ?1 AND for_sent_at = ?2").bind(it.ref, it.forSentAt).run();
      failed.push(it.label);
      continue;
    }
    await appendEvent(env, { eventType: "tlc.approval_reminder", actorType: "ai_employee", actorId: "aie_wynn", objectType: it.objectType, objectId: it.ref, firmScope, payload: { n, to: it.to, for_sent_at: it.forSentAt } });
    sent.push(`${nth(n).toLowerCase()} for ${it.label} (${it.ref}) to ${it.to.join(", ")}`);
  }
  return [
    `reminders: ${sent.length} sent${sent.length ? `: ${sent.join("; ")}` : ""}`,
    notDue.length ? `${notDue.length} not due yet` : "",
    failed.length ? `NAMED STOP [REMINDER_NOT_SENT] ${failed.join(", ")}: the email door refused it; the next tick tries again` : "",
  ].filter(Boolean).join("; ");
}
