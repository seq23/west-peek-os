import type { Env } from "../env";
import { appendEvent } from "../events";
import { backupOf, emailOwner, type TlcEventRow } from "./learningClub";
import { committedCashUsd } from "./tlcVolume";
import { COMMITTED_STAGES, dayWords, goNoGoOf } from "../../shared/tlc/goNoGo";
import { brandDisplayName, goalOf, monthWords } from "../../shared/tlc/learningClub";
import { isoWeekOf } from "./jobs";

/**
 * WYNN'S MONDAY ROUNDUP (owner's ask, 31 Oct 2026). One email a week, Monday from ROUNDUP_HOUR_UTC, to Sequoia only
 * (`emailOwner` sends to TLC_RECIPIENTS and nobody else — never Scooter). Calm and in plain words, what needs her first:
 *   1 · what is waiting on her, with the count and the approval email it is in;
 *   2 · anything stuck, and any club dropped at its go/no-go date or close to it;
 *   3 · each club: date, topic, backup, topic-switch deadline, go/no-go date; brands by stage; emailed against the
 *       ~35 target and the 5-a-week pace; replies; cash and in-kind committed against the goal.
 * A brand that asked for the teaser PDF is said as exactly that, never "said yes" (owner, 31 Oct 2026, Pinecone).
 * Nothing in it is a decision; she answers drafts in the approval email.
 */
export const ROUNDUP_HOUR_UTC = 14;
/** The brief's target: about 35 brands emailed per club over its selling window. */
export const TLC_EMAILED_TARGET = 35;
/** Her pace: five new brands per club per week (24 Oct 2026). */
export const TLC_WEEKLY_PACE = 5;

interface DealRow {
  id: string; brand: string; stage: string; first_sent_at: string | null; replied_at: string | null; stop_reason: string | null;
  yes_at: string | null; tier: string | null; cash_offer_usd: number | null; in_kind_value_usd: number | null; drip_step: number;
  samples_sent_at: string | null; pending_step: number | null; pending_since: string | null;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const names = (rows: DealRow[], max = 6) => {
  const n = [...new Set(rows.map((r) => brandDisplayName(r.brand)))];
  return n.length > max ? `${n.slice(0, max).join(", ")} and ${n.length - max} more` : n.join(", ");
};

/** Where one brand stands, in her words. */
export function brandStageWords(d: Pick<DealRow, "stage" | "first_sent_at" | "stop_reason" | "yes_at" | "samples_sent_at" | "pending_step">): string {
  if ((COMMITTED_STAGES as readonly string[]).includes(d.stage)) return "signed on";
  if (d.stage === "DECLINED") return "said no";
  if (d.stage === "STOPPED") return "stopped";
  if (d.stage === "CALL" || d.stage === "WAITING_ON_OWNERS") return "a call is set";
  if (d.yes_at) return d.samples_sent_at ? `asked for the teaser, PDF sent ${day(d.samples_sent_at)}` : "asked for the teaser";
  if (d.stop_reason === "REPLIED") return "replied";
  if (d.first_sent_at) return d.pending_step !== null ? "emailed, follow-up waiting for you" : "emailed, no reply yet";
  return d.pending_step !== null ? "first email waiting for you" : "queued";
}

export async function buildRoundup(env: Env, now: Date, firmScope = "west-peek"): Promise<{ tldr: string; sections: Array<{ label: string; bullets: string[] }>; waiting: number; noticeRef: string | null }> {
  const db = env.WP_OS_DB;
  const clubs = ((await db.prepare("SELECT * FROM tlc_event WHERE firm_scope = ?1 AND (status IN ('TOPIC_READY','GO','ESCALATED') OR dropped_at >= ?2) ORDER BY month").bind(firmScope, new Date(now.getTime() - 8 * 86_400_000).toISOString()).all<TlcEventRow>()).results ?? [])
    .filter((e) => e.dropped_at || Date.parse(e.event_date) > now.getTime());
  const { unlistedDrafts } = await import("./tlcDraftNotice");
  const pending = (await db.prepare(
    `SELECT COUNT(*) AS n FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'`,
  ).bind(firmScope).first<{ n: number }>())?.n ?? 0;
  const unlisted = (await unlistedDrafts(env, firmScope)).length;
  const notice = await db.prepare("SELECT ref, created_at FROM tlc_draft_notice WHERE firm_scope = ?1 ORDER BY created_at DESC LIMIT 1").bind(firmScope).first<{ ref: string; created_at: string }>();
  const firstSent = (await db.prepare("SELECT MIN(sent_at) AS at FROM tlc_drip_message WHERE state = 'SENT'").first<{ at: string | null }>())?.at ?? null;
  const weeks = firstSent ? Math.floor((now.getTime() - Date.parse(firstSent)) / (7 * 86_400_000)) + 1 : 0;
  const paceDue = Math.min(TLC_EMAILED_TARGET, weeks * TLC_WEEKLY_PACE);

  const yours: string[] = [];
  if (pending > 0) {
    yours.push(`${pending} brand email${pending === 1 ? " is" : "s are"} waiting for your approval.${notice && unlisted === 0 ? ` They are all in the email "TLC: this week's brands … · ${notice.ref}" (${day(notice.created_at)}). Reply "approve all" there.` : " A new approval email with all of them goes to you within the day."}`);
  }
  const stuck: string[] = [];
  const failed = (await db.prepare("SELECT d.brand FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE d.firm_scope = ?1 AND m.state = 'FAILED'").bind(firmScope).all<{ brand: string }>()).results ?? [];
  if (failed.length) stuck.push(`${failed.length} approved email${failed.length === 1 ? "" : "s"} did not send: ${[...new Set(failed.map((f) => brandDisplayName(f.brand)))].join(", ")}. Wynn retries them.`);
  const ways = (await db.prepare("SELECT brand FROM tlc_way_in WHERE firm_scope = ?1 AND state = 'OPEN'").bind(firmScope).all<{ brand: string }>()).results ?? [];
  if (ways.length) stuck.push(`Must-pitch brands with no address yet: ${ways.map((w) => w.brand).join(", ")}. Wynn tries NeverBounce-checked inboxes each week; add a contact on the TLC page if you have one.`);

  const clubSections: Array<{ label: string; bullets: string[] }> = [];
  for (const ev of clubs) {
    const label = `${monthWords(ev.month)}: ${ev.topic ?? "no topic yet"}`;
    if (ev.dropped_at) {
      stuck.push(`${monthWords(ev.month)} was dropped on ${dayWords(ev.dropped_at)}: no sponsor had committed in writing by its go/no-go date. Its topic is back on the ideas list.`);
      continue;
    }
    const deals = (await db.prepare(
      `SELECT d.id, d.brand, d.stage, d.first_sent_at, d.replied_at, d.stop_reason, d.yes_at, d.tier, d.cash_offer_usd, d.in_kind_value_usd, d.drip_step,
              (SELECT sent_at FROM tlc_samples s WHERE s.deal_id = d.id AND s.state = 'SENT') AS samples_sent_at,
              (SELECT m.step FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = d.id AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review' LIMIT 1) AS pending_step,
              (SELECT m.created_at FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.deal_id = d.id AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review' LIMIT 1) AS pending_since
         FROM tlc_deal d WHERE d.event_id = ?1`,
    ).bind(ev.id).all<DealRow>()).results ?? [];
    const brandsEmailed = new Set(deals.filter((d) => d.first_sent_at).map((d) => d.brand.toLowerCase())).size;
    const byWords = new Map<string, DealRow[]>();
    for (const d of deals) {
      const w = brandStageWords(d);
      byWords.set(w, [...(byWords.get(w) ?? []), d]);
    }
    const order = ["signed on", "a call is set", "asked for the teaser", "replied", "emailed, follow-up waiting for you", "emailed, no reply yet", "first email waiting for you", "queued", "said no", "stopped"];
    const stageLines = [...byWords.entries()]
      .sort((a, b) => order.findIndex((o) => a[0].startsWith(o)) - order.findIndex((o) => b[0].startsWith(o)))
      .map(([w, rows]) => (rows.length <= 3 || w.startsWith("asked") || w === "signed on" || w === "a call is set" ? `${names(rows)}: ${w}` : `${rows.length} brands ${w}`));
    const replies = deals.filter((d) => d.replied_at || d.stop_reason === "REPLIED").length;
    const cash = await committedCashUsd(env, ev.id);
    const inKind = deals.filter((d) => (COMMITTED_STAGES as readonly string[]).includes(d.stage)).reduce((s, d) => s + (d.in_kind_value_usd ?? 0), 0);
    const goal = goalOf(ev).goalUsd;
    const backup = backupOf(ev);
    const gng = goNoGoOf(ev);
    const daysToGng = Math.ceil((Date.parse(`${gng}T00:00:00Z`) - now.getTime()) / 86_400_000);
    if (cash + inKind === 0 && daysToGng <= 21 && daysToGng >= 0) stuck.push(`${monthWords(ev.month)}: no sponsor has committed yet, and its go/no-go date is ${dayWords(gng)} (${daysToGng} days). With none by then, the club is dropped.`);
    const overdue = deals.filter((d) => d.pending_step !== null && d.pending_step > 0 && d.pending_since && now.getTime() - Date.parse(d.pending_since) > 2 * 86_400_000);
    if (overdue.length) stuck.push(`${monthWords(ev.month)}: ${overdue.length} follow-up${overdue.length === 1 ? " is" : "s are"} overdue, waiting for your approval (${names(overdue)}).`);
    clubSections.push({
      label,
      bullets: [
        `${dayWords(ev.event_date)}. Backup topic: ${backup?.topic ?? "none"}.`,
        `Topic switch by ${ev.switch_deadline ? dayWords(ev.switch_deadline) : "no date set"}. Go/no-go ${dayWords(gng)}.`,
        `Emailed ${brandsEmailed} of about ${TLC_EMAILED_TARGET} brands; the pace of ${TLC_WEEKLY_PACE} a week puts it at ${paceDue} by now. ${replies} repl${replies === 1 ? "y" : "ies"}.`,
        `Committed: ${usd(cash)} cash and ${usd(inKind)} in kind, of the ${usd(goal)} goal.`,
        ...stageLines,
      ],
    });
  }
  const sections = [
    { label: "Waiting on you", bullets: yours.length ? yours : ["Nothing. All clear."] },
    ...(stuck.length ? [{ label: "Stuck or coming up", bullets: stuck }] : []),
    ...clubSections,
  ];
  const tldr = pending > 0
    ? `${pending} brand email${pending === 1 ? "" : "s"} waiting for your approval; everything else is below, club by club.`
    : "Nothing is waiting on you this week. Where each club stands is below.";
  return { tldr, sections, waiting: pending, noticeRef: notice?.ref ?? null };
}

/** Monday's roundup, once per ISO week, from the drip pass. Returns what it did. */
export async function sendWeeklyRoundup(env: Env, now: Date, firmScope = "west-peek", opts: { force?: boolean } = {}): Promise<string> {
  if (!opts.force && (now.getUTCDay() !== 1 || now.getUTCHours() < ROUNDUP_HOUR_UTC)) return "not Monday morning yet";
  const week = isoWeekOf(now);
  const claim = await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_roundup (week, firm_scope, sent_at) VALUES (?1, ?2, ?3)").bind(week, firmScope, now.toISOString()).run();
  if ((claim.meta?.changes ?? 0) === 0) return `this week's roundup (${week}) already went`;
  const r = await buildRoundup(env, now, firmScope);
  const sent = await emailOwner(env, {
    employee: "Wynn",
    email: { what: `TLC roundup, week of ${dayWords(now.toISOString())}`, tldr: r.tldr, sections: r.sections },
    objectType: "tlc_roundup",
    objectId: week,
    cardId: null,
    cardKind: null,
    firmScope,
  }).catch(() => [] as string[]);
  if (sent.length === 0) {
    await env.WP_OS_DB.prepare("DELETE FROM tlc_roundup WHERE week = ?1 AND firm_scope = ?2").bind(week, firmScope).run();
    return "the roundup could not be sent; the next pass tries again";
  }
  await env.WP_OS_DB.prepare("UPDATE tlc_roundup SET summary = ?3 WHERE week = ?1 AND firm_scope = ?2").bind(week, firmScope, r.tldr).run();
  await appendEvent(env, { eventType: "tlc.roundup_sent", actorType: "ai_employee", actorId: "aie_wynn", objectType: "tlc_roundup", objectId: week, firmScope, payload: { waiting: r.waiting, notice: r.noticeRef, to: sent } });
  return `roundup ${week} sent to ${sent.join(", ")}`;
}
