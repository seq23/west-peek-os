import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { addParticipant, transitionMeeting } from "./meetings";
import { CALENDAR_SOURCES, type CalendarSource } from "../../shared/meetings/calendarSources";
import {
  eventFromCalendarApi,
  eventsFromIcs,
  planCalendarSync,
  registrableDomain,
  type CalendarMeetEvent,
  type ExistingSyncedMeeting,
  type KnownContacts,
  type PlannedAction,
} from "../../shared/meetings/calendarSync";
import {
  GoogleWorkspaceError,
  SCOPE,
  fetchIcs,
  isServiceAccountConfigured,
  listCalendarEvents,
  serviceAccountToken,
} from "../effects/googleWorkspaceClient";

/**
 * Tier 1 — the firm's calendar becomes meetings (Phase Meet, 18 Sep 2026).
 *
 * WHY THIS IS A JOB AND NOT A BUTTON. Every Meet call the firm holds already exists as a calendar
 * event with a Meet link, a time and an attendee list. Typing those into a form a second time is
 * the step nobody did, so meetings were recorded after the fact or not at all, and nothing could
 * read the transcript of a meeting the system had never heard of. The sync reads the calendar on
 * the hour and keeps one meeting per event.
 *
 * TWO DOORS, ONE LEDGER. The Calendar API under domain-wide delegation is the primary door. If it
 * fails — a token refused, the API disabled, a network fault — the private iCal URL in the vault
 * is read instead, and the ledger row says `last_via = 'ics'` so the fallback is a visible state
 * and not a silent one. The iCal door survives a password change; the delegation door survives a
 * rotated iCal URL. Neither door can duplicate what the other created (see the identity rule in
 * `shared/meetings/calendarSync.ts`).
 *
 * EVERY WRITE IS AUTHORISED. Creating goes through `calendar.sync`; adding a participant and
 * cancelling go through the meeting actions they already have. The sync actor is SYSTEM in the
 * calendar's own firm scope — which, after the owner's correction of 18 Sep 2026, is only ever
 * west-peek: this system does not read the spry.vc calendar for anything.
 */

export interface CalendarSyncDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Days behind and ahead of `now` to read. Behind matters: a call that ended yesterday still needs its meeting. */
  daysBack?: number;
  daysAhead?: number;
}

export interface CalendarSyncOutcome {
  calendarKey: string;
  via: "api" | "ics" | null;
  ok: boolean;
  detail: string;
  eventsSeen: number;
  created: number;
  updated: number;
  cancelled: number;
  skippedNoLink: number;
  unchanged: number;
  checkIt: number;
}

export async function knownContacts(env: Env, source: CalendarSource): Promise<KnownContacts> {
  const lpEmails = new Set<string>();
  const lpDomains = new Set<string>();
  const companyDomains = new Map<string, string>();

  // LP contacts: a person whose name an lp_contact_link carries, or whose organisation is an LP's
  // legal name. Neither table holds addresses directly — contacts are linked to Network OS by
  // design (D5) — so `person.email` is the join, and a contact this system has never seen an
  // address for simply is not recognised. The inference then says UNKNOWN_CHECK_IT, out loud.
  const lpPeople = await env.WP_OS_DB.prepare(
    `SELECT DISTINCT LOWER(p.email) AS email
       FROM person p
      WHERE p.email IS NOT NULL AND p.firm_scope = ?1
        AND (
          EXISTS (SELECT 1 FROM lp_contact_link l WHERE LOWER(l.contact_label) = LOWER(p.full_name))
          OR EXISTS (SELECT 1 FROM lp_record r WHERE p.organization IS NOT NULL AND LOWER(r.legal_name) = LOWER(p.organization))
        )`,
  ).bind(source.firmScope).all<{ email: string }>().catch(() => ({ results: [] as Array<{ email: string }> }));
  for (const r of lpPeople.results ?? []) if (r.email) lpEmails.add(r.email);

  const companies = await env.WP_OS_DB.prepare(
    "SELECT id, website FROM canonical_company WHERE website IS NOT NULL AND status = 'ACTIVE' AND firm_scope = ?1",
  ).bind(source.firmScope).all<{ id: string; website: string }>();
  for (const c of companies.results ?? []) {
    const d = registrableDomain(c.website);
    if (d && !companyDomains.has(d)) companyDomains.set(d, c.id);
  }
  return { firmDomains: source.firmDomains, lpEmails, lpDomains, companyDomains };
}

async function existingSynced(env: Env, source: CalendarSource): Promise<ExistingSyncedMeeting[]> {
  const rows = await env.WP_OS_DB.prepare(
    `SELECT id, google_event_id, title, scheduled_at, meet_link, meet_conference_id, status
       FROM meeting WHERE calendar_key = ?1 AND google_event_id IS NOT NULL`,
  ).bind(source.key).all<ExistingSyncedMeeting>();
  return rows.results ?? [];
}

/** Read the calendar through whichever door answers. Throws only when both are shut. */
export async function readCalendar(
  env: Env,
  source: CalendarSource,
  window: { from: Date; to: Date },
  fetchImpl: typeof fetch,
): Promise<{ via: "api" | "ics"; events: CalendarMeetEvent[]; apiFailure: string | null }> {
  let apiFailure: string | null = null;
  if (isServiceAccountConfigured(env)) {
    try {
      const token = await serviceAccountToken(env, [SCOPE.calendarRead], source.subjectEmail, fetchImpl);
      const items = await listCalendarEvents(token, window.from, window.to, fetchImpl);
      return { via: "api", events: items.map(eventFromCalendarApi), apiFailure: null };
    } catch (err) {
      apiFailure = err instanceof GoogleWorkspaceError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    }
  } else {
    apiFailure = "not_configured: WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not set";
  }
  const icsUrl = env[source.icsEnvName];
  if (!icsUrl) {
    throw new GoogleWorkspaceError("not_configured", 0, `Calendar API failed (${apiFailure}) and ${source.icsEnvName} is not set, so there is no second door`);
  }
  const ics = await fetchIcs(icsUrl, fetchImpl);
  const inWindow = eventsFromIcs(ics).filter((e) => {
    if (!e.startsAt) return true;
    const t = Date.parse(e.startsAt);
    return Number.isNaN(t) || (t >= window.from.getTime() && t <= window.to.getTime());
  });
  return { via: "ics", events: inWindow, apiFailure };
}

async function applyPlan(env: Env, actor: Actor, source: CalendarSource, plan: PlannedAction[], now: Date): Promise<Omit<CalendarSyncOutcome, "calendarKey" | "via" | "ok" | "detail" | "eventsSeen">> {
  let created = 0, updated = 0, cancelled = 0, skippedNoLink = 0, unchanged = 0, checkIt = 0;
  for (const action of plan) {
    if (action.kind === "skip") {
      if (action.reason === "no_meet_link") skippedNoLink += 1;
      else if (action.reason === "unchanged") unchanged += 1;
      continue;
    }
    if (action.kind === "cancel") {
      // A cancelled event is a cancelled meeting, through the same transition a person would use.
      await transitionMeeting(env, actor, action.meetingId, "CANCELLED").catch(() => undefined);
      cancelled += 1;
      continue;
    }
    if (action.kind === "update") {
      const authz = await authorize(env, actor, "calendar.sync", { objectType: "meeting", objectId: action.meetingId, firmScope: source.firmScope });
      if (authz.decision !== "ALLOW") throw new Error(`calendar.sync refused: ${authz.reason}`);
      await env.WP_OS_DB.prepare(
        "UPDATE meeting SET title = ?2, scheduled_at = ?3, meet_link = ?4, meet_conference_id = ?5 WHERE id = ?1 AND source = 'google_calendar'",
      ).bind(action.meetingId, action.event.title, action.event.startsAt, action.event.meetLink, action.event.meetingCode).run();
      await appendEvent(env, {
        eventType: "meeting.calendar_updated",
        actorType: "system", actorId: "system",
        objectType: "meeting", objectId: action.meetingId, firmScope: source.firmScope,
        payload: { calendar_key: source.key, google_event_id: action.event.googleEventId, changed: action.changed },
      });
      updated += 1;
      continue;
    }
    // create
    const authz = await authorize(env, actor, "calendar.sync", { objectType: "meeting", firmScope: source.firmScope });
    if (authz.decision !== "ALLOW") throw new Error(`calendar.sync refused: ${authz.reason}`);
    const { event, inference } = action;
    const id = `mtg_${crypto.randomUUID()}`;
    const started = event.startsAt ? Date.parse(event.startsAt) : NaN;
    const alreadyPast = !Number.isNaN(started) && started < now.getTime();
    await env.WP_OS_DB.prepare(
      `INSERT INTO meeting
         (id, company_id, title, meeting_type, scheduled_at, location, status, privacy_label, firm_scope, created_by,
          calendar_key, google_event_id, meet_conference_id, meet_link, source, type_inference)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'SCHEDULED', ?7, ?8, 'system', ?9, ?10, ?11, ?12, 'google_calendar', ?13)`,
    )
      .bind(
        id, inference.companyId, event.title, inference.meetingType, event.startsAt, event.meetLink,
        inference.privacyLabel, source.firmScope, source.key, event.googleEventId, event.meetingCode, event.meetLink, inference.inference,
      )
      .run();
    for (const a of event.attendees) {
      const firm = source.firmDomains.includes(a.email.slice(a.email.lastIndexOf("@") + 1));
      const firmUser = firm
        ? await env.WP_OS_DB.prepare("SELECT id FROM firm_user WHERE LOWER(email) = ?1").bind(a.email).first<{ id: string }>()
        : null;
      await addParticipant(env, actor, id, {
        participant_type: firmUser ? "FIRM_USER" : "EXTERNAL",
        firm_user_id: firmUser?.id,
        display_name: a.displayName ?? a.email,
        organization: firm ? undefined : a.email.slice(a.email.lastIndexOf("@") + 1),
        participant_role: a.email === event.organizerEmail ? "organizer" : undefined,
      });
    }
    await appendEvent(env, {
      eventType: "meeting.calendar_created",
      actorType: "system", actorId: "system",
      objectType: "meeting", objectId: id, firmScope: source.firmScope,
      payload: {
        calendar_key: source.key, google_event_id: event.googleEventId, meeting_code: event.meetingCode,
        meeting_type: inference.meetingType, type_inference: inference.inference, already_past: alreadyPast,
      },
    });
    created += 1;
    if (inference.inference === "UNKNOWN_CHECK_IT") checkIt += 1;
  }
  return { created, updated, cancelled, skippedNoLink, unchanged, checkIt };
}

async function writeLedger(env: Env, source: CalendarSource, out: Partial<CalendarSyncOutcome> & { ok: boolean; detail: string; via: "api" | "ics" | null }, now: Date): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO google_calendar_sync (calendar_key, subject_email, firm_scope, last_synced_at, last_status, last_detail, last_via, events_seen, meetings_created, meetings_updated, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?4)
     ON CONFLICT (calendar_key) DO UPDATE SET
       subject_email = excluded.subject_email, firm_scope = excluded.firm_scope, last_synced_at = excluded.last_synced_at,
       last_status = excluded.last_status, last_detail = excluded.last_detail, last_via = excluded.last_via,
       events_seen = excluded.events_seen, meetings_created = meetings_created + excluded.meetings_created,
       meetings_updated = meetings_updated + excluded.meetings_updated, updated_at = excluded.updated_at`,
  )
    .bind(source.key, source.subjectEmail, source.firmScope, now.toISOString(), out.ok ? "OK" : "FAILED", out.detail.slice(0, 1000), out.via, out.eventsSeen ?? 0, out.created ?? 0, out.updated ?? 0)
    .run();
}

/** Sync one calendar. Never throws: a failed door is a FAILED ledger row and a FAILED outcome. */
export async function syncCalendar(env: Env, source: CalendarSource, deps: CalendarSyncDeps = {}): Promise<CalendarSyncOutcome> {
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const window = {
    from: new Date(now.getTime() - (deps.daysBack ?? 7) * 86_400_000),
    to: new Date(now.getTime() + (deps.daysAhead ?? 21) * 86_400_000),
  };
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [source.firmScope] };
  let read: Awaited<ReturnType<typeof readCalendar>>;
  try {
    read = await readCalendar(env, source, window, fetchImpl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await writeLedger(env, source, { ok: false, detail, via: null }, now);
    return { calendarKey: source.key, via: null, ok: false, detail, eventsSeen: 0, created: 0, updated: 0, cancelled: 0, skippedNoLink: 0, unchanged: 0, checkIt: 0 };
  }
  const plan = planCalendarSync(read.events, await existingSynced(env, source), await knownContacts(env, source));
  const applied = await applyPlan(env, actor, source, plan, now);
  const detail =
    `${read.via === "ics" ? `via iCal (API failed: ${read.apiFailure}); ` : ""}` +
    `${read.events.length} event(s) read, ${applied.created} created, ${applied.updated} updated, ${applied.cancelled} cancelled, ` +
    `${applied.unchanged} unchanged, ${applied.skippedNoLink} without a Meet link` +
    `${applied.checkIt > 0 ? `; ${applied.checkIt} typed by guess — check the card` : ""}`;
  const outcome: CalendarSyncOutcome = { calendarKey: source.key, via: read.via, ok: true, detail, eventsSeen: read.events.length, ...applied };
  await writeLedger(env, source, outcome, now);
  return outcome;
}

/** The job body: every registered calendar, which after 18 Sep 2026 is one. */
export async function runCalendarSync(env: Env, deps: CalendarSyncDeps = {}): Promise<CalendarSyncOutcome[]> {
  const out: CalendarSyncOutcome[] = [];
  for (const source of CALENDAR_SOURCES) out.push(await syncCalendar(env, source, deps));
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** POST /api/meet/calendar/sync — run it now. Same body as the tick; a person pressing it gets the same ledger row. */
export async function handleRunCalendarSync(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "calendar.sync", { objectType: "meeting" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const results = await runCalendarSync(ctx.env);
  return json({ results }, { status: results.every((r) => r.ok) ? 200 : 502 });
}

/** GET /api/meet/calendar — the ledger: which door served, when, and what it saw. */
export async function handleCalendarLedger(ctx: RouteContext): Promise<Response> {
  const rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM google_calendar_sync ORDER BY calendar_key").all()).results ?? [];
  const registered = CALENDAR_SOURCES.map((s) => ({ calendar_key: s.key, subject_email: s.subjectEmail, firm_scope: s.firmScope }));
  return json({
    configured: isServiceAccountConfigured(ctx.env),
    ics_fallback_configured: CALENDAR_SOURCES.map((s) => ({ calendar_key: s.key, configured: Boolean(ctx.env[s.icsEnvName]) })),
    registered,
    ledger: rows,
  });
}
