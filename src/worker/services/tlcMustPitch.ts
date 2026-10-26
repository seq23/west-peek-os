import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json, type RouteContext } from "../router";
import { actorFromIdentity, authorize } from "./authorize";
import { PARTNERS } from "../../shared/registry/partners";
import { nextDripAt } from "../../shared/tlc/learningClub";
import { brandKey, CONTACT_EMAIL_RE, wayInWords } from "../../shared/tlc/mustPitch";

/*
 * BRANDS WE MUST PITCH (owner, 23 Oct 2026: "are we reaching out to anthropic i think that is important
 * and google?"). Migration 0266.
 *
 * Her list, per club month. Every Monday brand batch handles these FIRST, outside the five-per-club
 * cap. Each is searched for a named partnerships, events, community, startup-program or
 * developer-relations contact, and the address must pass `addressReadOffPage` — the same check the
 * model's own picks pass, unchanged. A brand that fails it is never dropped: it becomes a "Needs a
 * way in" item on the TLC panel and on Approvals, naming the pages checked. She may add a name and an
 * address herself; that skips the page check because she supplied it. Either way the brand then joins
 * `tlc_deal` through `queueDeal`, the one insert, and the drip, the gate and the per-email approval
 * are exactly what every other brand gets.
 */

export interface MustPitchRow {
  id: string;
  month: string;
  brand: string;
  reason: string;
  added_by: string;
  added_at: string;
  removed_by: string | null;
  removed_at: string | null;
  day0_subject: string | null;
  day0_body: string | null;
  day0_topic: string | null;
  day0_approved_by: string | null;
  day0_approved_at: string | null;
  owner_contacted_at: string | null;
  owner_contacted_note: string | null;
  firm_scope: string;
}

export type WayInState = "OPEN" | "CONTACT_ADDED" | "FOUND";
export interface WayInRow {
  brand_key: string;
  brand: string;
  firm_scope: string;
  state: WayInState;
  months_json: string;
  pages_checked_json: string;
  why: string | null;
  opened_at: string;
  checked_at: string;
  changed_at: string;
  hidden_at: string | null;
  hidden_by: string | null;
  contact_name: string | null;
  contact_email: string | null;
  note: string | null;
  supplied_by: string | null;
  supplied_at: string | null;
}

export interface MustPitchLogRow {
  id: string;
  brand: string;
  month: string | null;
  action: "ADDED" | "REMOVED" | "NO_ADDRESS" | "FOUND" | "CONTACT_ADDED" | "QUEUED";
  by_who: string;
  at: string;
  detail: string | null;
}

/** What the model returns for one must-pitch brand. */
export interface MustPitchFinding {
  brand: string;
  contact_name: string;
  contact_email: string;
  contact_source_url: string;
  pages_checked: string[];
}

/** The tlc_deal source of an address the owner typed in herself. Never a URL: nothing was read off a page. */
export const OWNER_SUPPLIED_SOURCE = "owner-supplied";

const isUrl = (u: string): boolean => /^https?:\/\/[^\s]+$/.test(u);
const parseList = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * THE ADDRESS IS READ OFF THE PAGE, not taken on the model's word. The one check every model-found brand
 * passes, must-pitch or not: a real address shape and a URL, the page answers, and the address is in
 * the page's text. Returns null when it passes, or the reason it did not.
 */
export async function addressReadOffPage(email: string, source: string, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>): Promise<string | null> {
  if (!CONTACT_EMAIL_RE.test(email) || !isUrl(source)) return "no address on a page";
  if (!(await check(source))) return "the source page did not answer";
  const text = (await pageText(source)) ?? "";
  if (!text.toLowerCase().includes(email)) return `${email} is not on ${source}`;
  return null;
}

/** The one insert into tlc_deal. Every brand starts at PROSPECT on drip step 0; the drip decides the rest. Its created_at is the pass's own clock, so a week's new brands are counted on it (tlcVolume). */
export async function queueDeal(
  env: Env,
  d: { eventId: string; brand: string; category: string | null; contactName: string | null; contactEmail: string; contactSourceUrl: string; whyFit: string | null; firmScope: string },
  now: Date,
): Promise<boolean> {
  const res = await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_deal (id, event_id, brand, category, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
  ).bind(`tld_${crypto.randomUUID()}`, d.eventId, d.brand, d.category, d.contactName, d.contactEmail.toLowerCase(), d.contactSourceUrl, d.whyFit, nextDripAt(0, null, now, null), d.firmScope, now.toISOString()).run();
  return (res.meta?.changes ?? 0) > 0;
}

async function log(env: Env, e: { brand: string; month?: string | null; action: MustPitchLogRow["action"]; by: string; at: string; detail?: string | null; firmScope: string }): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch_log (id, brand, month, action, by_who, at, detail, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(`tmpl_${crypto.randomUUID()}`, e.brand, e.month ?? null, e.action, e.by, e.at, e.detail ?? null, e.firmScope).run();
}

export async function liveMustPitch(env: Env, firmScope: string, months?: readonly string[]): Promise<MustPitchRow[]> {
  const rows = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_must_pitch WHERE firm_scope = ?1 AND removed_at IS NULL ORDER BY month, brand").bind(firmScope).all<MustPitchRow>()).results ?? [];
  return months ? rows.filter((r) => months.includes(r.month)) : rows;
}

export async function wayInRows(env: Env, firmScope: string): Promise<WayInRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_way_in WHERE firm_scope = ?1 ORDER BY changed_at DESC").bind(firmScope).all<WayInRow>()).results ?? [];
}

/** The brands that must be searched this week: on her list for an open month, no deal there yet, and no address of hers. */
export async function mustPitchToSearch(env: Env, events: ReadonlyArray<{ id: string; month: string }>, existing: ReadonlyArray<{ brand: string; event_id: string }>, firmScope: string): Promise<Array<{ brand: string; months: string[]; reasons: string[] }>> {
  const groups = await openGroups(env, events, existing, firmScope);
  const ways = new Map((await wayInRows(env, firmScope)).map((w) => [w.brand_key, w]));
  return groups.filter((g) => ways.get(g.key)?.state !== "CONTACT_ADDED").map((g) => ({ brand: g.brand, months: g.events.map((e) => e.month), reasons: g.reasons }));
}

/**
 * Brands she contacted herself (owner_contacted_at on any live entry). Wynn never searches, queues or
 * drips them, in any month: her own email went, and replies go to her.
 */
export async function ownerContactedBrands(env: Env, firmScope: string): Promise<Set<string>> {
  const rows = (await env.WP_OS_DB.prepare("SELECT brand FROM tlc_must_pitch WHERE firm_scope = ?1 AND removed_at IS NULL AND owner_contacted_at IS NOT NULL").bind(firmScope).all<{ brand: string }>()).results ?? [];
  return new Set(rows.map((r) => brandKey(r.brand)));
}

interface Group { key: string; brand: string; events: Array<{ id: string; month: string }>; reasons: string[] }

async function openGroups(env: Env, events: ReadonlyArray<{ id: string; month: string }>, existing: ReadonlyArray<{ brand: string; event_id: string }>, firmScope: string): Promise<Group[]> {
  const rows = await liveMustPitch(env, firmScope, events.map((e) => e.month));
  const groups = new Map<string, Group>();
  const mine = await ownerContactedBrands(env, firmScope);
  for (const r of rows) {
    if (mine.has(brandKey(r.brand))) continue;
    const ev = events.find((e) => e.month === r.month);
    if (!ev) continue;
    if (existing.some((d) => d.event_id === ev.id && brandKey(d.brand) === brandKey(r.brand))) continue;
    const key = brandKey(r.brand);
    const g = groups.get(key) ?? { key, brand: r.brand, events: [], reasons: [] };
    g.events.push(ev);
    g.reasons.push(`${r.month}: ${r.reason}`);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * MUST-PITCH FIRST. Called by the brand batch before it looks at any of the model's own picks. Every brand
 * on her list for an open month ends this call in exactly one of three places: queued (an address read off
 * a live page, or hers), or a "Needs a way in" item. Never dropped.
 */
export async function handleMustPitch(
  env: Env,
  input: { events: ReadonlyArray<{ id: string; month: string }>; existing: ReadonlyArray<{ brand: string; event_id: string }>; findings: readonly MustPitchFinding[]; firmScope: string; now: Date; onlyBrands?: ReadonlySet<string> },
  check: (u: string) => Promise<boolean>,
  pageText: (u: string) => Promise<string | null>,
): Promise<{ queued: string[]; wayIn: string[]; changed: number }> {
  const { firmScope, now } = input;
  const at = now.toISOString();
  const queued: string[] = [];
  const wayIn: string[] = [];
  let changed = 0;
  const ways = new Map((await wayInRows(env, firmScope)).map((w) => [w.brand_key, w]));
  for (const g of await openGroups(env, input.events, input.existing, firmScope)) {
    // The brand batch works one club per tick and hands each must-pitch brand to exactly one of them.
    if (input.onlyBrands && !input.onlyBrands.has(g.key)) continue;
    const way = ways.get(g.key);
    const months = g.events.map((e) => e.month).sort();
    // Her own address: no page check, because she supplied it. Only months added after she gave it reach here.
    if (way?.state === "CONTACT_ADDED" && way.contact_email) {
      for (const ev of g.events) {
        if (await queueDeal(env, { eventId: ev.id, brand: g.brand, category: null, contactName: way.contact_name, contactEmail: way.contact_email, contactSourceUrl: `${OWNER_SUPPLIED_SOURCE}:${way.supplied_by ?? "a partner"}`, whyFit: way.note, firmScope }, now)) {
          await log(env, { brand: g.brand, month: ev.month, action: "QUEUED", by: "Wynn", at, detail: "with the contact you added", firmScope });
        }
      }
      queued.push(`${g.brand} (${months.join(", ")}, your contact)`);
      continue;
    }
    const f = input.findings.find((x) => brandKey(x.brand) === g.key);
    const email = (f?.contact_email ?? "").trim().toLowerCase();
    const source = (f?.contact_source_url ?? "").trim();
    const why = f ? await addressReadOffPage(email, source, check, pageText) : "Wynn found no contact for it";
    if (why === null) {
      for (const ev of g.events) {
        await queueDeal(env, { eventId: ev.id, brand: g.brand, category: null, contactName: f!.contact_name.trim() || null, contactEmail: email, contactSourceUrl: source, whyFit: g.reasons.join(" ") || null, firmScope }, now);
      }
      await log(env, { brand: g.brand, month: months.join(","), action: "FOUND", by: "Wynn", at, detail: `${email} on ${source}`, firmScope });
      if (way) await env.WP_OS_DB.prepare("UPDATE tlc_way_in SET state = 'FOUND', checked_at = ?3, changed_at = ?3, why = NULL WHERE firm_scope = ?1 AND brand_key = ?2").bind(firmScope, g.key, at).run();
      queued.push(`${g.brand} (${months.join(", ")})`);
      continue;
    }
    // NO ADDRESS PASSED: a "Needs a way in" item, never a silent drop.
    const pages = [...new Set([...(f?.pages_checked ?? []), source].map((p) => p.trim()).filter(isUrl))].slice(0, 8);
    if (!way) {
      await env.WP_OS_DB.prepare(
        "INSERT INTO tlc_way_in (brand_key, brand, firm_scope, state, months_json, pages_checked_json, why, opened_at, checked_at, changed_at) VALUES (?1, ?2, ?3, 'OPEN', ?4, ?5, ?6, ?7, ?7, ?7)",
      ).bind(g.key, g.brand, firmScope, JSON.stringify(months), JSON.stringify(pages), why, at).run();
      await log(env, { brand: g.brand, month: months.join(","), action: "NO_ADDRESS", by: "Wynn", at, detail: why, firmScope });
      changed += 1;
    } else {
      // Re-checked weekly. It RESURFACES only when something changes (a month added or gone, or it was
      // closed and is open again) — a new list of pages Wynn happened to look at is not news.
      const moved = way.state !== "OPEN" || JSON.stringify(parseList(way.months_json).sort()) !== JSON.stringify(months);
      await env.WP_OS_DB.prepare(
        `UPDATE tlc_way_in SET state = 'OPEN', months_json = ?3, pages_checked_json = ?4, why = ?5, checked_at = ?6${moved ? ", changed_at = ?6" : ""} WHERE firm_scope = ?1 AND brand_key = ?2`,
      ).bind(firmScope, g.key, JSON.stringify(months), JSON.stringify(pages), why, at).run();
      if (moved) changed += 1;
      if (moved) await log(env, { brand: g.brand, month: months.join(","), action: "NO_ADDRESS", by: "Wynn", at, detail: why, firmScope });
    }
    wayIn.push(wayInWords({ brand: g.brand, months, pages }));
  }
  return { queued, wayIn, changed };
}

/**
 * Her approved first email for this brand and club, or null. Only while the club still runs the topic it
 * was written for: after a backup switch the generated email 1 is used, and it still waits for her approval.
 */
export async function approvedDayZeroFor(env: Env, brand: string, month: string, topic: string, firmScope: string): Promise<{ subject: string; body: string } | null> {
  const row = (await liveMustPitch(env, firmScope, [month])).find((r) => brandKey(r.brand) === brandKey(brand) && r.day0_subject && r.day0_body);
  if (!row) return null;
  if (row.day0_topic && !topic.toLowerCase().includes(row.day0_topic.toLowerCase())) return null;
  return { subject: row.day0_subject!, body: row.day0_body! };
}

/** The months-and-pages view of one item, in the panel's words. */
export function wayInView(w: WayInRow) {
  const months = parseList(w.months_json);
  const pages = parseList(w.pages_checked_json);
  return {
    brand_key: w.brand_key,
    brand: w.brand,
    state: w.state,
    months,
    pages,
    why: w.why,
    words: wayInWords({ brand: w.brand, months, pages }),
    opened_at: w.opened_at,
    checked_at: w.checked_at,
    changed_at: w.changed_at,
    hidden_at: w.hidden_at,
    contact_name: w.contact_name,
    contact_email: w.contact_email,
    note: w.note,
    supplied_by: w.supplied_by,
    supplied_at: w.supplied_at,
    // On Approvals while it is open, unless she hid it and nothing has changed since.
    on_approvals: w.state === "OPEN" && (!w.hidden_at || w.changed_at > w.hidden_at),
  };
}

// ── Routes (partners) ───────────────────────────────────────────────────────────────────────────

function partnerOf(ctx: RouteContext): (typeof PARTNERS)[number] | null {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return null;
  return PARTNERS.find((p) => p.firmUserId === actor.firmUserId) ?? null;
}

async function canRead(ctx: RouteContext): Promise<Response | null> {
  const authz = await authorize(ctx.env, actorFromIdentity(ctx.identity!), "sponsor.manage", { objectType: "sponsor_prospect", firmScope: "west-peek" });
  return authz.decision === "ALLOW" ? null : json({ error: "forbidden", detail: authz.reason }, { status: 403 });
}

async function overview(env: Env, firmScope = "west-peek") {
  const all = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_must_pitch WHERE firm_scope = ?1 ORDER BY month, brand").bind(firmScope).all<MustPitchRow>()).results ?? [];
  const ways = (await wayInRows(env, firmScope)).map(wayInView);
  const history = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_must_pitch_log WHERE firm_scope = ?1 ORDER BY at DESC, id DESC LIMIT 40").bind(firmScope).all<MustPitchLogRow>()).results ?? [];
  return { must_pitch: all.filter((r) => !r.removed_at), removed: all.filter((r) => r.removed_at), way_in: ways, history };
}

/** GET /api/tlc/must-pitch — her list, the "Needs a way in" items, and every change with who and when. */
export async function handleMustPitchOverview(ctx: RouteContext): Promise<Response> {
  const no = await canRead(ctx);
  if (no) return no;
  return json(await overview(ctx.env));
}

const addSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  brand: z.string().trim().min(2).max(80),
  reason: z.string().trim().min(2).max(200),
});

/** POST /api/tlc/must-pitch — a partner adds a brand to one club's list, with a one-line reason. */
export async function handleMustPitchAdd(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner changes the must-pitch list" }, { status: 403 });
  const parsed = addSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "pick a month, write the brand's name, and one line on why" }, { status: 400 });
  const { month, brand, reason } = parsed.data;
  const dupe = await ctx.env.WP_OS_DB.prepare("SELECT 1 FROM tlc_must_pitch WHERE firm_scope = 'west-peek' AND month = ?1 AND lower(brand) = ?2 AND removed_at IS NULL").bind(month, brandKey(brand)).first();
  if (dupe) return json({ error: "conflict", detail: `${brand} is already on the list for that month` }, { status: 409 });
  const at = new Date().toISOString();
  const id = `tmp_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare("INSERT INTO tlc_must_pitch (id, month, brand, reason, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, month, brand, reason, partner.firstName, at).run();
  await log(ctx.env, { brand, month, action: "ADDED", by: partner.firstName, at, detail: reason, firmScope: "west-peek" });
  await appendEvent(ctx.env, { eventType: "tlc.must_pitch.add", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_must_pitch", objectId: id, payload: { month } });
  return json({ ok: true, ...(await overview(ctx.env)) });
}

/** POST /api/tlc/must-pitch/:id/remove — the row stays, marked with who removed it and when. */
export async function handleMustPitchRemove(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner changes the must-pitch list" }, { status: 403 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_must_pitch WHERE id = ?1 AND removed_at IS NULL").bind(ctx.params.id).first<MustPitchRow>();
  if (!row) return json({ error: "not_found", detail: "that brand is not on the list" }, { status: 404 });
  const at = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare("UPDATE tlc_must_pitch SET removed_by = ?2, removed_at = ?3 WHERE id = ?1").bind(row.id, partner.firstName, at).run();
  await log(ctx.env, { brand: row.brand, month: row.month, action: "REMOVED", by: partner.firstName, at, firmScope: row.firm_scope });
  await appendEvent(ctx.env, { eventType: "tlc.must_pitch.remove", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_must_pitch", objectId: row.id, payload: { month: row.month } });
  return json({ ok: true, ...(await overview(ctx.env)) });
}

const contactSchema = z.object({
  contact_name: z.string().trim().min(2).max(120),
  contact_email: z.string().trim().toLowerCase().regex(CONTACT_EMAIL_RE).max(200),
  note: z.string().trim().max(600).optional(),
});

/**
 * POST /api/tlc/way-in/:key/contact — she adds a name and an address. It skips the page check because she
 * supplied it, and queues the brand at once for every open month on her list. The send path is unchanged:
 * the drip, the gate and the per-email approval all still stand.
 */
export async function handleWayInContact(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner adds a contact" }, { status: 403 });
  const parsed = contactSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "write the person's name and their email address" }, { status: 400 });
  const env = ctx.env;
  const way = await env.WP_OS_DB.prepare("SELECT * FROM tlc_way_in WHERE firm_scope = 'west-peek' AND brand_key = ?1").bind(decodeURIComponent(ctx.params.key ?? "")).first<WayInRow>();
  if (!way) return json({ error: "not_found", detail: "no item for that brand" }, { status: 404 });
  const now = new Date();
  const at = now.toISOString();
  const { contact_name, contact_email, note } = parsed.data;
  await env.WP_OS_DB.prepare(
    "UPDATE tlc_way_in SET state = 'CONTACT_ADDED', contact_name = ?3, contact_email = ?4, note = ?5, supplied_by = ?6, supplied_at = ?7, changed_at = ?7 WHERE firm_scope = ?1 AND brand_key = ?2",
  ).bind(way.firm_scope, way.brand_key, contact_name, contact_email, note ?? null, partner.firstName, at).run();
  await log(env, { brand: way.brand, action: "CONTACT_ADDED", by: partner.firstName, at, detail: note ?? null, firmScope: way.firm_scope });
  const events = (await env.WP_OS_DB.prepare("SELECT id, month FROM tlc_event WHERE firm_scope = ?1 AND status NOT IN ('DONE','CANCELLED')").bind(way.firm_scope).all<{ id: string; month: string }>()).results ?? [];
  const existing = events.length ? ((await env.WP_OS_DB.prepare(`SELECT brand, event_id FROM tlc_deal WHERE event_id IN (${events.map(() => "?").join(",")})`).bind(...events.map((e) => e.id)).all<{ brand: string; event_id: string }>()).results ?? []) : [];
  const queued: string[] = [];
  for (const g of (await openGroups(env, events, existing, way.firm_scope)).filter((x) => x.key === way.brand_key)) {
    for (const ev of g.events) {
      if (await queueDeal(env, { eventId: ev.id, brand: way.brand, category: null, contactName: contact_name, contactEmail: contact_email, contactSourceUrl: `${OWNER_SUPPLIED_SOURCE}:${partner.firstName}`, whyFit: note ?? null, firmScope: way.firm_scope }, now)) {
        queued.push(ev.month);
        await log(env, { brand: way.brand, month: ev.month, action: "QUEUED", by: partner.firstName, at, detail: "with the contact you added", firmScope: way.firm_scope });
      }
    }
  }
  await appendEvent(env, { eventType: "tlc.way_in.contact", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_way_in", objectId: way.brand_key, payload: { queued } });
  return json({ ok: true, queued, ...(await overview(env)) });
}

/** POST /api/tlc/way-in/:key/hide — off Approvals until something changes. It stays on the TLC panel. */
export async function handleWayInHide(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner hides an item" }, { status: 403 });
  // hidden_at holds the changed_at of the version she hid, so "changed since" is one comparison on one clock.
  const res = await ctx.env.WP_OS_DB.prepare("UPDATE tlc_way_in SET hidden_at = changed_at, hidden_by = ?2 WHERE firm_scope = 'west-peek' AND brand_key = ?1").bind(decodeURIComponent(ctx.params.key ?? ""), partner.firstName).run();
  if (!res.meta.changes) return json({ error: "not_found", detail: "no item for that brand" }, { status: 404 });
  return json({ ok: true, ...(await overview(ctx.env)) });
}
