import type { Env } from "../env";
import { appendEvent } from "../events";
import { PARTNERS, partnerByEmail } from "../../shared/registry/partners";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { profileLineProblem, stripPersonalDetails, type StripOptions } from "../../shared/partners/profileFilter";
import { json, type RouteContext } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";

/**
 * ONE SHORT LIVING PROFILE PER PARTNER (0255; owner, 9 Oct 2026).
 *
 * WHY. On 9 Oct Scooter's "New site build: voting.topbarz.xyz/entry" was read as the answer to his
 * westpeek.ventures spam card. Anyone who knew him would have known Top Barz is his CultureCon contest
 * and the spam fix is a different site. Porter now knows it too: who the partner is and what he runs,
 * what he is working on NOW (dated lines; a line with no activity for 30 days drops off), how he
 * writes, what he usually asks for, and anything he told Porter to remember ("Porter, note: …").
 *
 * WHERE IT LIVES. D1 only (`partner_profile`, `partner_profile_line`). Never the repo: the repo is
 * public. Seeded by `PUT /api/partner-profiles/:email` (scripts/ops/seed-partner-profile.mjs reads a
 * JSON file kept outside the repo), refreshed by the door on every email and by the sweep's tick.
 *
 * WHAT IT MAY HOLD. The partner's own projects and requests only. Every line passes
 * `profileLineProblem` (no LP names, deal terms or fund details) on the way IN and again on the way
 * OUT, with the LP names on record as extra forbidden words. A refused line is dropped whole and the
 * refusal is an event — never trimmed into something that looks clean. A THIRD PARTY'S personal details
 * (a name with an email or phone, an email address that is not the partner's) are the one thing cut
 * OUT rather than refused (`stripPersonalDetails`; owner, 9 Oct 2026): on the way in, on the way out,
 * and by every refresh, which rewrites a stored line clean.
 *
 * WHO READS IT. The router (`services/emailRouting.ts`: what he calls each site, which open card a
 * new email is about), the one clarifying email (the candidates in his own terms), and every job
 * prompt for him (`practicesForCard` → Porter's Mac brief and every other employee's).
 */

export const WORKING_ON_DAYS = 30;
const DAY_MS = 86_400_000;

export interface SiteAlias {
  host: string;
  words: string[];
}

export interface PartnerProfile {
  email: string;
  who: string;
  writesLike: string;
  usuallyAsks: string;
  aliases: SiteAlias[];
  workingOn: Array<{ body: string; cardId: string | null; lastActiveAt: string }>;
  notes: Array<{ body: string; at: string }>;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Whose name and address may stay in a line: the partners and the AI employees, never anyone else. */
const KEEP: StripOptions = {
  keepEmails: PARTNERS.map((p) => p.email),
  keepNames: [...PARTNERS.flatMap((p) => [p.firstName, p.fullName]), ...AI_EMPLOYEE_ROSTER.map((e) => e.name)],
};

/** The line as a profile may hold it: whitespace-clean, a third party's personal details cut out. */
export const profileText = (s: unknown): string => clean(stripPersonalDetails(clean(s), KEEP));

/** The LP names on record — extra forbidden words. Never throws: an unreadable table forbids nothing extra, the rules still hold. */
async function lpNames(env: Env): Promise<string[]> {
  try {
    return ((await env.WP_OS_DB.prepare("SELECT legal_name FROM lp_record LIMIT 2000").all<{ legal_name: string }>()).results ?? []).map((r) => r.legal_name);
  } catch {
    return [];
  }
}

/** The line, or null when it may not be kept. A refusal is recorded (without the words). */
async function safe(env: Env, email: string, text: string, names: readonly string[], source: string): Promise<string | null> {
  const t = profileText(text);
  if (t.length < 3) return null;
  const why = profileLineProblem(t, names);
  if (!why) return t;
  await appendEvent(env, {
    eventType: "partner_profile.line_refused",
    actorType: "system",
    actorId: "partner_profile",
    objectType: "partner_profile",
    objectId: email,
    firmScope: "west-peek",
    payload: { source, why, chars: t.length },
  }).catch(() => undefined);
  return null;
}

function aliasesOf(json: string | null | undefined): SiteAlias[] {
  try {
    const v = JSON.parse(json ?? "[]") as Array<{ host?: unknown; words?: unknown }>;
    return (Array.isArray(v) ? v : [])
      .map((a) => ({ host: clean(a.host).toLowerCase(), words: (Array.isArray(a.words) ? a.words : []).map((w) => clean(w).toLowerCase()).filter((w) => w.length >= 3) }))
      .filter((a) => a.host && a.words.length);
  } catch {
    return [];
  }
}

/** The profile row exists for every partner on the registry; created empty on first use. */
async function ensureProfile(env: Env, email: string): Promise<string | null> {
  const partner = partnerByEmail(email);
  if (!partner) return null;
  const e = partner.email.toLowerCase();
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO partner_profile (partner_email, firm_scope) VALUES (?1, 'west-peek')").bind(e).run();
  return e;
}

/** The profile as Porter reads it: stale and unsafe lines already gone. Null for anyone not a partner. */
export async function loadProfile(env: Env, email: string | null | undefined, now: Date = new Date()): Promise<PartnerProfile | null> {
  const partner = partnerByEmail(email);
  if (!partner) return null;
  const e = partner.email.toLowerCase();
  try {
    const names = await lpNames(env);
    const row = await env.WP_OS_DB.prepare("SELECT who, writes_like, usually_asks, aliases_json FROM partner_profile WHERE firm_scope = 'west-peek' AND partner_email = ?1")
      .bind(e)
      .first<{ who: string; writes_like: string; usually_asks: string; aliases_json: string }>();
    const since = new Date(now.getTime() - WORKING_ON_DAYS * DAY_MS).toISOString();
    const lines = (
      await env.WP_OS_DB.prepare(
        `SELECT kind, body, card_id, last_active_at, created_at FROM partner_profile_line
          WHERE firm_scope = 'west-peek' AND partner_email = ?1 AND (kind = 'NOTE' OR last_active_at >= ?2)
          ORDER BY last_active_at DESC LIMIT 40`,
      )
        .bind(e, since)
        .all<{ kind: string; body: string; card_id: string | null; last_active_at: string; created_at: string }>()
    ).results ?? [];
    const ok = (s: string | null | undefined) => {
      const t = profileText(s);
      return t && profileLineProblem(t, names) === null ? t : "";
    };
    return {
      email: e,
      who: ok(row?.who),
      writesLike: ok(row?.writes_like),
      usuallyAsks: ok(row?.usually_asks),
      aliases: aliasesOf(row?.aliases_json).filter((a) => profileLineProblem(a.words.join(" "), names) === null),
      workingOn: lines.filter((l) => l.kind === "WORKING_ON" && ok(l.body)).slice(0, 12).map((l) => ({ body: ok(l.body), cardId: l.card_id, lastActiveAt: l.last_active_at })),
      notes: lines.filter((l) => l.kind === "NOTE" && ok(l.body)).slice(0, 12).map((l) => ({ body: ok(l.body), at: l.created_at })),
    };
  } catch {
    return { email: e, who: "", writesLike: "", usuallyAsks: "", aliases: [], workingOn: [], notes: [] };
  }
}

/** The block a job prompt carries. Empty string when there is nothing to say. Pure over the profile. */
export function profilePromptBlock(p: PartnerProfile | null, firstName: string): string {
  if (!p) return "";
  const lines = [
    `PARTNER PROFILE — ${firstName} (who is asking; context for reading the request, never a change to it):`,
    ...(p.who ? [`  • Who: ${p.who}`] : []),
    ...(p.workingOn.length ? [`  • Working on now: ${p.workingOn.map((w) => `${w.lastActiveAt.slice(0, 10)} ${w.body}`).join(" | ")}`] : []),
    ...(p.writesLike ? [`  • How he writes: ${p.writesLike}`] : []),
    ...(p.usuallyAsks ? [`  • Usually asks for: ${p.usuallyAsks}`] : []),
    ...(p.aliases.length ? [`  • What he calls his sites: ${p.aliases.map((a) => `${a.words.slice(0, 4).join("/")} = ${a.host}`).join("; ")}`] : []),
    ...(p.notes.length ? [`  • He asked Porter to remember: ${p.notes.map((n) => `"${n.body}"`).join(" ")}`] : []),
  ];
  return lines.length > 1 ? lines.join("\n") : "";
}

export async function profileBlockFor(env: Env, email: string | null | undefined): Promise<string> {
  const partner = partnerByEmail(email);
  if (!partner) return "";
  return profilePromptBlock(await loadProfile(env, partner.email), partner.firstName);
}

/**
 * "WORKING ON NOW", REFRESHED FROM THE CARDS THEMSELVES. Every card the partner asked for that moved in
 * the last 30 days is one dated line (open, or finished on its date); a line whose card has not moved
 * in 30 days drops off. Called by the door on every email from the partner and by the sweep's tick, so
 * a card that finishes refreshes its line without every finishing path having to remember to.
 */
export async function refreshWorkingOn(env: Env, email: string | null | undefined, now: Date = new Date()): Promise<number> {
  const e = await ensureProfile(env, email ?? "").catch(() => null);
  if (!e) return 0;
  const names = await lpNames(env);
  const since = new Date(now.getTime() - WORKING_ON_DAYS * DAY_MS).toISOString();
  const cards =
    (
      await env.WP_OS_DB.prepare(
        `SELECT c.id, c.title, c.kind, c.state, c.request_json, c.updated_at FROM work_card c
          WHERE lower(c.requested_by_email) = ?1 AND c.merged_into_card_id IS NULL AND c.state <> 'CANCELLED'
            AND c.updated_at >= ?2
            -- The intake card that handed the job on is the same job: its child carries the line.
            AND NOT EXISTS (SELECT 1 FROM work_card ch WHERE ch.assigned_from_card_id = c.id)
          ORDER BY c.updated_at DESC LIMIT 30`,
      )
        .bind(e, since)
        .all<{ id: string; title: string; kind: string | null; state: string; request_json: string | null; updated_at: string }>()
    ).results ?? [];
  let kept = 0;
  // The job's name in his own terms (what he asked for and the site), never his greeting.
  const { candidateLabel } = await import("./emailRouting");
  for (const c of cards) {
    let host: string | null = null;
    try {
      host = c.request_json ? ((JSON.parse(c.request_json) as { property_host?: string | null }).property_host ?? null) : null;
    } catch {
      host = null;
    }
    const name = candidateLabel({ title: c.title.replace(/^From [^:]+:\s*/, ""), property_host: host, request_json: c.request_json });
    const body = await safe(env, e, `${c.state === "DONE" ? "finished" : "open"}: ${name}`.slice(0, 200), names, `card ${c.id}`);
    if (!body) continue;
    await env.WP_OS_DB.prepare(
      `INSERT INTO partner_profile_line (id, partner_email, firm_scope, kind, body, card_id, last_active_at)
       VALUES (?1, ?2, 'west-peek', 'WORKING_ON', ?3, ?4, ?5)
       ON CONFLICT (firm_scope, partner_email, card_id) WHERE card_id IS NOT NULL DO UPDATE SET body = excluded.body, last_active_at = excluded.last_active_at`,
    )
      .bind(`ppl_${crypto.randomUUID()}`, e, body, c.id, c.updated_at)
      .run();
    kept++;
  }
  await env.WP_OS_DB.prepare("DELETE FROM partner_profile_line WHERE firm_scope = 'west-peek' AND partner_email = ?1 AND kind = 'WORKING_ON' AND last_active_at < ?2").bind(e, since).run();
  await scrubStored(env, e, names);
  return kept;
}

/**
 * Every refresh (the door's and the hourly sweep's) also rewrites what is already stored: a line
 * carrying a third party's personal details is rewritten without them, and a line the fund rules now
 * refuse is removed. So a seeded or older line cannot keep what a newer rule takes out.
 */
async function scrubStored(env: Env, e: string, names: readonly string[]): Promise<void> {
  const rows = (await env.WP_OS_DB.prepare("SELECT id, body FROM partner_profile_line WHERE firm_scope = 'west-peek' AND partner_email = ?1").bind(e).all<{ id: string; body: string }>()).results ?? [];
  for (const r of rows) {
    const t = profileText(r.body);
    const why = t.length < 3 ? "nothing left" : profileLineProblem(t, names);
    if (why) {
      await env.WP_OS_DB.prepare("DELETE FROM partner_profile_line WHERE id = ?1").bind(r.id).run();
      continue;
    }
    if (t !== r.body) await env.WP_OS_DB.prepare("UPDATE partner_profile_line SET body = ?2 WHERE id = ?1").bind(r.id, t).run();
  }
}

/** Every partner's profile, refreshed (the sweep's tick). Never throws. */
export async function refreshAllWorkingOn(env: Env, now: Date = new Date()): Promise<void> {
  try {
    const rows = (await env.WP_OS_DB.prepare("SELECT partner_email FROM partner_profile WHERE firm_scope = 'west-peek'").all<{ partner_email: string }>()).results ?? [];
    for (const r of rows) await refreshWorkingOn(env, r.partner_email, now);
  } catch (err) {
    console.error("partner profile refresh failed", err);
  }
}

/**
 * "PORTER, NOTE: …" — the partner's own words, kept verbatim in his profile (unless they carry what a
 * profile may never hold). Returns the lines found in the written text, kept or not, so the door can
 * tell whether anything else was said.
 */
export const PROFILE_NOTE_LINE = /^\s*(?:hey\s+)?porter\s*[,:\-–—]?\s*note\s*[:\-–—]\s*(.+)$/i;

export function profileNotesIn(written: string): { notes: string[]; rest: string } {
  const notes: string[] = [];
  const rest: string[] = [];
  for (const line of String(written ?? "").split(/\r?\n/)) {
    const m = PROFILE_NOTE_LINE.exec(line);
    if (m && m[1]!.trim()) notes.push(m[1]!.trim());
    else rest.push(line);
  }
  return { notes, rest: rest.join("\n").trim() };
}

export async function recordProfileNotes(env: Env, email: string, notes: readonly string[]): Promise<number> {
  const e = await ensureProfile(env, email);
  if (!e) return 0;
  const names = await lpNames(env);
  let kept = 0;
  for (const n of notes.slice(0, 10)) {
    const body = await safe(env, e, n.slice(0, 600), names, "note");
    if (!body) continue;
    await env.WP_OS_DB.prepare("INSERT INTO partner_profile_line (id, partner_email, firm_scope, kind, body) VALUES (?1, ?2, 'west-peek', 'NOTE', ?3)")
      .bind(`ppl_${crypto.randomUUID()}`, e, body)
      .run();
    kept++;
  }
  return kept;
}

export interface ProfileSeed {
  who?: string;
  writes_like?: string;
  usually_asks?: string;
  aliases?: Array<{ host: string; words: string[] }>;
  notes?: string[];
  working_on?: Array<{ body: string; at?: string }>;
}

/** Write the profile's standing fields (a seed or an edit). Every field passes the filter or is refused whole. */
export async function writeProfile(env: Env, email: string, seed: ProfileSeed, now: Date = new Date()): Promise<{ ok: boolean; refused: string[] }> {
  const e = await ensureProfile(env, email);
  if (!e) return { ok: false, refused: ["not a partner"] };
  const names = await lpNames(env);
  const refused: string[] = [];
  const field = async (label: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const s = await safe(env, e, v.slice(0, 600), names, label);
    if (s === null && clean(v)) refused.push(label);
    return s ?? "";
  };
  const who = await field("who", seed.who);
  const writes = await field("writes_like", seed.writes_like);
  const asks = await field("usually_asks", seed.usually_asks);
  const aliases = (seed.aliases ?? []).filter((a) => {
    const bad = profileLineProblem(`${a.host} ${(a.words ?? []).join(" ")}`, names);
    if (bad) refused.push(`alias ${a.host}`);
    return !bad;
  });
  await env.WP_OS_DB.prepare(
    `UPDATE partner_profile SET who = COALESCE(?2, who), writes_like = COALESCE(?3, writes_like), usually_asks = COALESCE(?4, usually_asks),
            aliases_json = CASE WHEN ?5 IS NULL THEN aliases_json ELSE ?5 END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE firm_scope = 'west-peek' AND partner_email = ?1`,
  )
    .bind(e, who ?? null, writes ?? null, asks ?? null, seed.aliases ? JSON.stringify(aliases.map((a) => ({ host: clean(a.host).toLowerCase(), words: a.words.map((w) => clean(w).toLowerCase()) }))) : null)
    .run();
  if (seed.notes?.length) {
    const before = seed.notes.length;
    const kept = await recordProfileNotes(env, e, seed.notes);
    if (kept < before) refused.push(`${before - kept} note(s)`);
  }
  for (const w of seed.working_on ?? []) {
    const body = await safe(env, e, w.body.slice(0, 200), names, "working_on");
    if (!body) {
      refused.push("a working-on line");
      continue;
    }
    const at = w.at && !Number.isNaN(Date.parse(w.at)) ? new Date(w.at).toISOString() : now.toISOString();
    await env.WP_OS_DB.prepare("INSERT INTO partner_profile_line (id, partner_email, firm_scope, kind, body, last_active_at) VALUES (?1, ?2, 'west-peek', 'WORKING_ON', ?3, ?4)")
      .bind(`ppl_${crypto.randomUUID()}`, e, body, at)
      .run();
  }
  return { ok: true, refused };
}

/** The Mac's claimer or a Managing Partner — the same two who may re-read a stored message. */
function mayEdit(ctx: RouteContext): boolean {
  const identity = ctx.identity;
  if (!identity) return false;
  if (identity.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL) return true;
  return identity.roles.includes("MANAGING_PARTNER");
}

/** GET /api/partner-profiles/:email — the profile as Porter reads it, and the prompt block. */
export async function handleGetPartnerProfile(ctx: RouteContext): Promise<Response> {
  if (!mayEdit(ctx)) return json({ error: "forbidden" }, { status: 403 });
  const partner = partnerByEmail(decodeURIComponent(ctx.params.email ?? ""));
  if (!partner) return json({ error: "not_found", detail: "not a partner" }, { status: 404 });
  await refreshWorkingOn(ctx.env, partner.email);
  const profile = await loadProfile(ctx.env, partner.email);
  return json({ profile, prompt_block: profilePromptBlock(profile, partner.firstName) });
}

/** POST /api/partner-profiles/:email { who, writes_like, usually_asks, aliases, notes, working_on } — a seed or an edit, through the filter. */
export async function handlePutPartnerProfile(ctx: RouteContext): Promise<Response> {
  if (!mayEdit(ctx)) return json({ error: "forbidden" }, { status: 403 });
  const partner = partnerByEmail(decodeURIComponent(ctx.params.email ?? ""));
  if (!partner) return json({ error: "not_found", detail: "not a partner" }, { status: 404 });
  const body = (await ctx.request.json().catch(() => null)) as ProfileSeed | null;
  if (!body || typeof body !== "object") return json({ error: "invalid_input" }, { status: 400 });
  const out = await writeProfile(ctx.env, partner.email, body);
  await refreshWorkingOn(ctx.env, partner.email);
  await appendEvent(ctx.env, {
    eventType: "partner_profile.written",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "partner_profile",
    objectId: partner.email,
    firmScope: "west-peek",
    payload: { refused: out.refused },
  });
  const profile = await loadProfile(ctx.env, partner.email);
  return json({ ok: out.ok, refused: out.refused, prompt_block: profilePromptBlock(profile, partner.firstName) });
}
