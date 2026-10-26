import type { Env } from "../env";
import { appendEvent } from "../events";
import { neverBounceCheck } from "../effects/neverBounceClient";
import { goalOf, isBettingCategory, monthWords, sponsorMixProblems, TLC_DRIP_DAYS, TLC_NO_BETTING_THROUGH } from "../../shared/tlc/learningClub";
import { brandKey } from "../../shared/tlc/mustPitch";
import { addressSendable, goalReached, orderProspects, progressLine, weekStartUtc, weeklyRoom, type AddressResult, type ProspectBand } from "../../shared/tlc/volume";

/**
 * MORE SPONSOR VOLUME (owner, 26 Oct 2026). The rules are in shared/tlc/volume.ts; this is where they touch the database.
 *
 *   · `addressCleared` — NeverBounce before any first email, once per address; a bounce marks the address for good.
 *   · `promoteProspects` — every drip pass: for each open club, nearest first, Wynn moves up to 10 new brands a week
 *     from Parker's list into the drip (through the one insert, `queueDeal`), unless the club's goal is met.
 *   · `outreachStopped` — a club whose agreed sponsor cash reached $25,000 gets no new pitch and no follow-up.
 *   · `clubProgress` — the weekly email's line per club.
 *
 * Nothing here sends anything: a promoted brand gets a draft through the drip, behind the brand-send gate and her approval.
 */

export interface ProspectRow {
  id: string;
  event_id: string;
  brand: string;
  band: ProspectBand;
  category: string | null;
  contact_name: string | null;
  contact_email: string;
  contact_source_url: string;
  why_fit: string | null;
  rank: number;
  deal_id: string | null;
  promoted_at: string | null;
  dropped_reason: string | null;
  firm_scope: string;
}

/** Agreed sponsor cash for one club: deals agreed, paid or delivered; a product partner's in-kind value never counts. */
export async function committedCashUsd(env: Env, eventId: string): Promise<number> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT COALESCE(SUM(cash_offer_usd), 0) AS usd FROM tlc_deal WHERE event_id = ?1 AND stage IN ('AGREED','PAID','DELIVERED') AND COALESCE(tier, '') != 'PRODUCT'",
  ).bind(eventId).first<{ usd: number }>();
  return row?.usd ?? 0;
}

/** Has this club reached its sponsor goal? Then its outreach stops: no new brand, no first pitch, no follow-up. */
export async function outreachStopped(env: Env, ev: { id: string; sponsor_goal_usd?: number | null }): Promise<boolean> {
  return goalReached(await committedCashUsd(env, ev.id), goalOf(ev).goalUsd);
}

export type AddressAnswer = { ok: true } | { ok: false; refused: AddressResult } | { ok: false; wait: string };

/**
 * MAY A FIRST EMAIL GO TO THIS ADDRESS? Only when NeverBounce called it valid and it never bounced. An address with no
 * answer yet is checked now (once; the answer is stored); when NeverBounce cannot be asked, the email waits.
 */
export async function addressCleared(env: Env, email: string, now: Date, fetchImpl: typeof fetch = fetch): Promise<AddressAnswer> {
  const key = email.trim().toLowerCase();
  const have = await env.WP_OS_DB.prepare("SELECT result FROM tlc_address_check WHERE email = ?1").bind(key).first<{ result: AddressResult }>();
  if (have) return addressSendable(have.result) ? { ok: true } : { ok: false, refused: have.result };
  const answer = await neverBounceCheck(env.WP_OS_NEVERBOUNCE_API_KEY, key, fetchImpl);
  if (!answer.ok) return { ok: false, wait: answer.detail };
  await env.WP_OS_DB.prepare("INSERT INTO tlc_address_check (email, result, source, checked_at) VALUES (?1, ?2, 'neverbounce', ?3) ON CONFLICT (email) DO NOTHING")
    .bind(key, answer.result, now.toISOString()).run();
  return addressSendable(answer.result) ? { ok: true } : { ok: false, refused: answer.result };
}

/** Did a real email to this address ever bounce? Then no email of any step goes to it again. */
export async function addressBounced(env: Env, email: string): Promise<boolean> {
  return Boolean(await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_address_check WHERE email = ?1 AND result = 'bounced'").bind(email.trim().toLowerCase()).first());
}

/**
 * THE CHECK FOR ONE DRIP EMAIL: a first email needs NeverBounce's valid; a follow-up (to an address we already wrote to)
 * needs only that the address never bounced — never a fresh paid check per follow-up.
 */
export async function dripAddressCheck(env: Env, email: string, step: number, now: Date): Promise<AddressAnswer> {
  if (step === 0) return addressCleared(env, email, now);
  return (await addressBounced(env, email)) ? { ok: false, refused: "bounced" } : { ok: true };
}

/** A real email to this address bounced: it is never written to again, for any club (her rule: never follow up to a bounce). */
export async function recordBounce(env: Env, email: string, now: Date): Promise<void> {
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_address_check (email, result, source, checked_at, detail) VALUES (?1, 'bounced', 'bounce', ?2, 'a sent email bounced') ON CONFLICT (email) DO UPDATE SET result = 'bounced', source = 'bounce', checked_at = excluded.checked_at, detail = excluded.detail",
  ).bind(email.trim().toLowerCase(), now.toISOString()).run();
}

/** The brand never goes out to that address: the deal stops, and the listed brand (if any) is marked with why. */
export async function refuseAddress(env: Env, deal: { id: string; contact_email: string }, result: AddressResult, now: Date): Promise<string> {
  const why = `the address did not pass NeverBounce (${result}), so it is never written to`;
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'STOPPED', next_send_at = NULL, updated_at = ?2 WHERE id = ?1 AND first_sent_at IS NULL").bind(deal.id, now.toISOString()).run();
  await env.WP_OS_DB.prepare("UPDATE tlc_prospect SET dropped_reason = COALESCE(dropped_reason, ?2) WHERE deal_id = ?1").bind(deal.id, why).run();
  return why;
}

async function prospectsReady(env: Env, eventId: string): Promise<ProspectRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_prospect WHERE event_id = ?1 AND promoted_at IS NULL AND dropped_reason IS NULL").bind(eventId).all<ProspectRow>()).results ?? [];
}

/** How many listed brands a club still has ready to pitch (Wynn searches for more only when this runs low). */
export async function readyCount(env: Env, eventId: string): Promise<number> {
  return (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_prospect WHERE event_id = ?1 AND promoted_at IS NULL AND dropped_reason IS NULL").bind(eventId).first<{ n: number }>())?.n ?? 0;
}

/** New brands started for a club this ISO week, from any source (Parker's list, Wynn's own search, must-pitch). */
export async function startedThisWeek(env: Env, eventId: string, now: Date): Promise<number> {
  return (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_deal WHERE event_id = ?1 AND created_at >= ?2").bind(eventId, weekStartUtc(now)).first<{ n: number }>())?.n ?? 0;
}

export interface PromoteResult {
  promoted: string[];
  dropped: string[];
  waiting: string[];
  stopped: string[];
}

/**
 * WYNN'S TEN A WEEK. For each open club, nearest first: nothing when its goal is met; otherwise up to the week's room
 * of Parker's listed brands, Title candidates first, each through every earlier rule — her own contacts, a featured
 * partner's competitors, the betting and peptide rules, one brand per category per club, one live thread per address —
 * and NeverBounce. Each goes into the drip through `queueDeal`, the one insert, and is drafted for her approval there.
 */
export async function promoteProspects(
  env: Env,
  now: Date,
  firmScope = "west-peek",
  fetchImpl: typeof fetch = fetch,
): Promise<PromoteResult> {
  const out: PromoteResult = { promoted: [], dropped: [], waiting: [], stopped: [] };
  const { openEvents, categoryRival, CATEGORY_QUIET_DAYS } = await import("./learningClub");
  const { ownerContactedBrands, queueDeal } = await import("./tlcMustPitch");
  const mine = await ownerContactedBrands(env, firmScope);
  for (const ev of await openEvents(env, now, firmScope)) {
    if (await outreachStopped(env, ev)) {
      out.stopped.push(monthWords(ev.month));
      continue;
    }
    let room = weeklyRoom(await startedThisWeek(env, ev.id, now));
    if (room <= 0) continue;
    const cats = (() => {
      try { return JSON.parse(ev.sponsor_categories_json ?? "[]") as Array<{ category: string; bench?: boolean; excluded_brands?: string[] }>; } catch { return []; }
    })();
    const never = cats.flatMap((c) => c.excluded_brands ?? []).map((n) => n.toLowerCase());
    for (const p of orderProspects(await prospectsReady(env, ev.id))) {
      if (room <= 0) break;
      const drop = async (why: string) => {
        await env.WP_OS_DB.prepare("UPDATE tlc_prospect SET dropped_reason = ?2 WHERE id = ?1").bind(p.id, why).run();
        out.dropped.push(`${p.brand} (${monthWords(ev.month)}): ${why}`);
      };
      const brand = p.brand.toLowerCase();
      if (mine.has(brandKey(p.brand))) { await drop("Sequoia contacted them directly"); continue; }
      if (never.some((n) => brand.includes(n) || n.includes(brand))) { await drop("competes with a featured partner"); continue; }
      if (isBettingCategory(`${p.category ?? ""} ${p.brand}`) && ev.month <= TLC_NO_BETTING_THROUGH) { await drop("betting brands stay out of Q1 2027"); continue; }
      const mix = sponsorMixProblems(ev.month, [...cats, { category: p.category ?? "" }]);
      if (mix.length) { await drop(mix.join("; ")); continue; }
      const already = await env.WP_OS_DB.prepare("SELECT id FROM tlc_deal WHERE event_id = ?1 AND (lower(brand) = lower(?2) OR contact_email = lower(?3)) LIMIT 1").bind(ev.id, p.brand, p.contact_email).first<{ id: string }>();
      if (already) {
        await env.WP_OS_DB.prepare("UPDATE tlc_prospect SET dropped_reason = 'already in the drip for this club', deal_id = ?2 WHERE id = ?1").bind(p.id, already.id).run();
        continue;
      }
      // ONE BRAND PER CATEGORY PER CLUB AT A TIME (26 Oct 2026): not while a live brand holds it, nor two this week
      // (a brand promoted a moment ago is a queued, unsent brand in its category: the second check below).
      const cat = (p.category ?? "").trim().toLowerCase();
      if (cat && (await categoryRival(env, { id: "", event_id: ev.id, category: p.category, firm_scope: ev.firm_scope, created_at: now.toISOString() } as never, now))) continue;
      // A brand already queued in this category but not yet written to holds it too (it will be pitched first).
      if (cat && (await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_deal WHERE event_id = ?1 AND lower(trim(category)) = ?2 AND stage = 'PROSPECT' AND stop_reason IS NULL AND first_sent_at IS NULL LIMIT 1").bind(ev.id, cat).first())) continue;
      // ONE LIVE THREAD PER ADDRESS: the same inbox is never pitched for two clubs at once.
      const thread = await env.WP_OS_DB.prepare(
        `SELECT 1 FROM tlc_deal WHERE contact_email = lower(?1) AND stage NOT IN ('DECLINED','STOPPED')
            AND (stop_reason = 'REPLIED' OR (stop_reason IS NULL AND (drip_step < ?2 OR last_sent_at >= ?3))) LIMIT 1`,
      ).bind(p.contact_email, TLC_DRIP_DAYS.length, new Date(now.getTime() - CATEGORY_QUIET_DAYS * 86_400_000).toISOString()).first();
      if (thread) { out.waiting.push(`${p.brand} (${monthWords(ev.month)}): its inbox is already in a live thread`); continue; }
      const gone = await env.WP_OS_DB.prepare("SELECT stop_reason FROM tlc_deal WHERE contact_email = lower(?1) AND stop_reason IN ('UNSUBSCRIBED','DECLINED') LIMIT 1").bind(p.contact_email).first<{ stop_reason: string }>();
      if (gone) { await drop(`that address ${gone.stop_reason === "UNSUBSCRIBED" ? "asked us to stop" : "said no"}`); continue; }
      // NEVERBOUNCE BEFORE THE FIRST EMAIL.
      const addr = await addressCleared(env, p.contact_email, now, fetchImpl);
      if (!addr.ok) {
        if ("refused" in addr) await drop(`the address did not pass NeverBounce (${addr.refused})`);
        else out.waiting.push(`${p.brand} (${monthWords(ev.month)}): ${addr.wait}`);
        continue;
      }
      const queued = await queueDeal(env, { eventId: ev.id, brand: p.brand, category: p.category, contactName: p.contact_name, contactEmail: p.contact_email, contactSourceUrl: p.contact_source_url, whyFit: p.why_fit, firmScope: ev.firm_scope }, now);
      if (!queued) continue;
      const deal = await env.WP_OS_DB.prepare("SELECT id FROM tlc_deal WHERE event_id = ?1 AND contact_email = lower(?2)").bind(ev.id, p.contact_email).first<{ id: string }>();
      await env.WP_OS_DB.prepare("UPDATE tlc_prospect SET deal_id = ?2, promoted_at = ?3 WHERE id = ?1").bind(p.id, deal?.id ?? null, now.toISOString()).run();
      room -= 1;
      out.promoted.push(`${p.brand} (${monthWords(ev.month)})`);
    }
  }
  if (out.promoted.length || out.dropped.length) {
    await appendEvent(env, { eventType: "tlc.prospects_promoted", actorType: "ai_employee", actorId: "aie_wynn", objectType: "tlc_prospect", objectId: weekStartUtc(now).slice(0, 10), firmScope, payload: { promoted: out.promoted.length, dropped: out.dropped.length, waiting: out.waiting.length } });
  }
  return out;
}

/** Each open club's line for the weekly email: agreed cash against the goal, pitched / replied / yes, and what is ready. */
export async function clubProgress(env: Env, firmScope: string, now: Date): Promise<string[]> {
  const { openEvents } = await import("./learningClub");
  const lines: string[] = [];
  for (const ev of await openEvents(env, now, firmScope)) {
    const counts = await env.WP_OS_DB.prepare(
      `SELECT SUM(CASE WHEN first_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS pitched,
              SUM(CASE WHEN replied_at IS NOT NULL OR stop_reason = 'REPLIED' THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN yes_at IS NOT NULL OR stage IN ('AGREED','PAID','DELIVERED') THEN 1 ELSE 0 END) AS yes
         FROM tlc_deal WHERE event_id = ?1`,
    ).bind(ev.id).first<{ pitched: number | null; replied: number | null; yes: number | null }>();
    const committedUsd = await committedCashUsd(env, ev.id);
    const goalUsd = goalOf(ev).goalUsd;
    lines.push(progressLine({
      club: monthWords(ev.month),
      topic: ev.topic,
      committedUsd,
      goalUsd,
      pitched: counts?.pitched ?? 0,
      replied: counts?.replied ?? 0,
      yes: counts?.yes ?? 0,
      ready: await readyCount(env, ev.id),
      stopped: goalReached(committedUsd, goalUsd),
    }));
  }
  return lines;
}
