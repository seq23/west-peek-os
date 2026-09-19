/**
 * Turning a calendar into meetings — the pure half (Phase Meet, tier 1).
 *
 * No I/O here. The worker service reads the calendar (API under impersonation, or the private
 * iCal URL when the API path fails) and the database, hands both to these functions, and writes
 * what they return. That split is what lets `validate:calendar-sync` prove idempotency against a
 * fixture without a network, and what keeps the inference rule in one place.
 *
 * ONE MEETING PER EVENT. A calendar event is identified by (calendar_key, google_event_id). A
 * recurring series arrives expanded (`singleEvents=true`), so each occurrence has its own id and
 * its own meeting — which is right, because each occurrence is a separate call with its own
 * transcript. The iCal path builds the same id shape from UID + RECURRENCE-ID so the two doors
 * agree on identity and a switch between them cannot duplicate.
 *
 * THE TYPE IS INFERRED ONCE AND THEN A PERSON'S. The sync sets meeting_type on creation and never
 * again: a partner who corrects "FOUNDER" to "LP" must not have it flip back on the next hour's
 * sync. Title, time and attendees DO follow the calendar, because the calendar is where those are
 * edited.
 */

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  /** The calendar owner's own entry. */
  self: boolean;
}

/** A calendar event as either door reports it. */
export interface CalendarMeetEvent {
  /** Calendar API event id, or `${uid}` / `${uid}_${recurrenceId}` from iCal. */
  googleEventId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  meetLink: string | null;
  /** The Meet meeting code, "abc-defg-hjk". Null when the event carries no Meet link. */
  meetingCode: string | null;
  attendees: CalendarAttendee[];
  organizerEmail: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  htmlLink: string | null;
}

/** "https://meet.google.com/abc-defg-hjk?…" → "abc-defg-hjk". Null for anything else. */
export function meetingCodeFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const m = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i.exec(link);
  return m ? m[1]!.toLowerCase() : null;
}

/** Shape the Calendar API returns for one item, reduced to what the sync needs. */
export function eventFromCalendarApi(e: Record<string, any>): CalendarMeetEvent {
  const start = e.start ?? {};
  const end = e.end ?? {};
  const entry = (e.conferenceData?.entryPoints ?? []).find((p: any) => p?.entryPointType === "video")?.uri as string | undefined;
  const link = entry ?? (typeof e.hangoutLink === "string" ? e.hangoutLink : null) ?? null;
  const code = meetingCodeFromLink(link) ?? (typeof e.conferenceData?.conferenceId === "string" ? meetingCodeFromLink(`meet.google.com/${e.conferenceData.conferenceId}`) : null);
  return {
    googleEventId: String(e.id ?? ""),
    title: String(e.summary ?? "(no title)"),
    startsAt: start.dateTime ?? (start.date ? `${start.date}T00:00:00Z` : null),
    endsAt: end.dateTime ?? (end.date ? `${end.date}T00:00:00Z` : null),
    allDay: Boolean(start.date && !start.dateTime),
    meetLink: link,
    meetingCode: code,
    attendees: Array.isArray(e.attendees)
      ? e.attendees
          .filter((a: any) => typeof a?.email === "string" && a.email)
          .map((a: any) => ({ email: String(a.email).toLowerCase(), displayName: a.displayName ? String(a.displayName) : null, self: Boolean(a.self) }))
      : [],
    organizerEmail: e.organizer?.email ? String(e.organizer.email).toLowerCase() : null,
    status: e.status === "cancelled" ? "cancelled" : e.status === "tentative" ? "tentative" : "confirmed",
    htmlLink: typeof e.htmlLink === "string" ? e.htmlLink : null,
  };
}

// ── iCal (the fallback door) ─────────────────────────────────────────────────

/** Unfold RFC 5545 continuation lines and split into VEVENT property maps. */
function icsEvents(ics: string): Array<Map<string, { params: Record<string, string>; value: string }[]>> {
  const unfolded = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out: Array<Map<string, { params: Record<string, string>; value: string }[]>> = [];
  let current: Map<string, { params: Record<string, string>; value: string }[]> | null = null;
  for (const line of unfolded.split("\n")) {
    if (line === "BEGIN:VEVENT") {
      current = new Map();
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    const key = name!.toUpperCase();
    const list = current.get(key) ?? [];
    list.push({ params, value });
    current.set(key, list);
  }
  return out;
}

/** iCal date-time → ISO. Floating and TZID values are treated as UTC, which is the honest lossy reading. */
function icsTime(v: string | undefined): { iso: string | null; allDay: boolean } {
  if (!v) return { iso: null, allDay: false };
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) return { iso: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`, allDay: true };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(v);
  if (!m) return { iso: null, allDay: false };
  return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, allDay: false };
}

function icsUnescape(v: string): string {
  return v.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\\\/g, "\\");
}

/**
 * Read a private iCal feed into the same event shape the API produces.
 *
 * Google's iCal export does not expand recurrences; a series arrives as one VEVENT with an RRULE.
 * That one VEVENT becomes one meeting keyed by UID — the next API sync, if the API comes back,
 * keys occurrences by instance id instead, and the two cannot collide because the iCal id has no
 * `_YYYYMMDDTHHMMSSZ` suffix. A duplicate across doors is therefore impossible; a series read
 * through iCal is simply a single meeting until the API is reachable again, and the sync ledger
 * says which door served it.
 */
export function eventsFromIcs(ics: string): CalendarMeetEvent[] {
  const out: CalendarMeetEvent[] = [];
  for (const ev of icsEvents(ics)) {
    const first = (k: string) => ev.get(k)?.[0];
    const uid = first("UID")?.value;
    if (!uid) continue;
    const recurrenceId = first("RECURRENCE-ID")?.value;
    const description = icsUnescape(first("DESCRIPTION")?.value ?? "");
    const location = icsUnescape(first("LOCATION")?.value ?? "");
    const conf = ev.get("X-GOOGLE-CONFERENCE")?.[0]?.value ?? null;
    const link =
      conf ??
      (meetingCodeFromLink(location) ? location : null) ??
      (/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.exec(description)?.[0] ?? null);
    const start = icsTime(first("DTSTART")?.value);
    const end = icsTime(first("DTEND")?.value);
    const attendees: CalendarAttendee[] = (ev.get("ATTENDEE") ?? [])
      .map((a) => ({
        email: a.value.replace(/^mailto:/i, "").toLowerCase(),
        displayName: a.params.CN ?? null,
        self: false,
      }))
      .filter((a) => a.email.includes("@"));
    const organizer = first("ORGANIZER")?.value.replace(/^mailto:/i, "").toLowerCase() ?? null;
    const status = (first("STATUS")?.value ?? "CONFIRMED").toUpperCase();
    out.push({
      googleEventId: recurrenceId ? `${uid}_${recurrenceId}` : uid,
      title: icsUnescape(first("SUMMARY")?.value ?? "(no title)"),
      startsAt: start.iso,
      endsAt: end.iso,
      allDay: start.allDay,
      meetLink: link,
      meetingCode: meetingCodeFromLink(link),
      attendees,
      organizerEmail: organizer,
      status: status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
      htmlLink: null,
    });
  }
  return out;
}

// ── Inference ────────────────────────────────────────────────────────────────

export type MeetingTypeInference = "FIRM_ONLY" | "LP_CONTACT" | "COMPANY_DOMAIN" | "UNKNOWN_CHECK_IT";

/** What the worker knows about the outside world, gathered once per sync. */
export interface KnownContacts {
  firmDomains: readonly string[];
  /** Lower-case addresses of people the firm records as LP contacts. */
  lpEmails: ReadonlySet<string>;
  /** Lower-case domains of LP organisations, where an LP record carries one. */
  lpDomains: ReadonlySet<string>;
  /** Lower-case registrable domain → canonical_company.id, from canonical_company.website. */
  companyDomains: ReadonlyMap<string, string>;
}

export interface Inference {
  meetingType: "INTERNAL" | "LP" | "FOUNDER";
  inference: MeetingTypeInference;
  companyId: string | null;
  /** LP meetings are confidential by construction; everything else keeps the meeting default. */
  privacyLabel: "LP_PRIVATE" | "INTERNAL";
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/** "https://www.Acme.io/about" → "acme.io". Good enough to match an attendee's domain. */
export function registrableDomain(websiteOrDomain: string | null | undefined): string | null {
  if (!websiteOrDomain) return null;
  let host = websiteOrDomain.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split("/")[0]!.split(":")[0]!;
  host = host.replace(/^www\./, "");
  if (!host.includes(".")) return null;
  return host;
}

const FREEMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com"]);

/**
 * Only firm addresses → INTERNAL. A known LP contact → LP. A known company domain → FOUNDER,
 * linked to the company. Else FOUNDER, flagged "type inferred, check it".
 *
 * LP WINS OVER COMPANY when both match, because the cost of the two mistakes is asymmetric: an LP
 * call filed as a founder call would let its transcript reach a lane that may train on it.
 */
export function inferMeetingType(attendees: readonly CalendarAttendee[], known: KnownContacts): Inference {
  const emails = attendees.map((a) => a.email.toLowerCase()).filter(Boolean);
  const outside = emails.filter((e) => !known.firmDomains.includes(domainOf(e)));
  if (emails.length > 0 && outside.length === 0) {
    return { meetingType: "INTERNAL", inference: "FIRM_ONLY", companyId: null, privacyLabel: "INTERNAL" };
  }
  if (outside.some((e) => known.lpEmails.has(e) || (known.lpDomains.has(domainOf(e)) && !FREEMAIL.has(domainOf(e))))) {
    return { meetingType: "LP", inference: "LP_CONTACT", companyId: null, privacyLabel: "LP_PRIVATE" };
  }
  for (const e of outside) {
    const d = domainOf(e);
    if (FREEMAIL.has(d)) continue;
    const companyId = known.companyDomains.get(d);
    if (companyId) return { meetingType: "FOUNDER", inference: "COMPANY_DOMAIN", companyId, privacyLabel: "INTERNAL" };
  }
  return { meetingType: "FOUNDER", inference: "UNKNOWN_CHECK_IT", companyId: null, privacyLabel: "INTERNAL" };
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface ExistingSyncedMeeting {
  id: string;
  google_event_id: string;
  title: string;
  scheduled_at: string | null;
  meet_link: string | null;
  meet_conference_id: string | null;
  status: string;
}

export type PlannedAction =
  | { kind: "create"; event: CalendarMeetEvent; inference: Inference }
  | { kind: "update"; meetingId: string; event: CalendarMeetEvent; changed: string[] }
  | { kind: "cancel"; meetingId: string; event: CalendarMeetEvent }
  | { kind: "skip"; event: CalendarMeetEvent; reason: "no_meet_link" | "unchanged" | "cancelled_unknown" };

/**
 * Decide what the sync will write, given what the calendar says and what already exists.
 *
 * Pure and total: every event produces exactly one action, so a fixture can be checked event by
 * event and "did nothing" is a named skip rather than an absence.
 */
export function planCalendarSync(
  events: readonly CalendarMeetEvent[],
  existing: readonly ExistingSyncedMeeting[],
  known: KnownContacts,
): PlannedAction[] {
  const byEventId = new Map(existing.map((m) => [m.google_event_id, m]));
  const seen = new Set<string>();
  const out: PlannedAction[] = [];
  for (const event of events) {
    if (!event.googleEventId || seen.has(event.googleEventId)) continue;
    seen.add(event.googleEventId);
    const current = byEventId.get(event.googleEventId);
    if (event.status === "cancelled") {
      out.push(current && current.status !== "CANCELLED" ? { kind: "cancel", meetingId: current.id, event } : { kind: "skip", event, reason: "cancelled_unknown" });
      continue;
    }
    if (!event.meetingCode) {
      out.push({ kind: "skip", event, reason: "no_meet_link" });
      continue;
    }
    if (!current) {
      out.push({ kind: "create", event, inference: inferMeetingType(event.attendees, known) });
      continue;
    }
    const changed: string[] = [];
    if (current.title !== event.title) changed.push("title");
    if ((current.scheduled_at ?? null) !== (event.startsAt ?? null)) changed.push("scheduled_at");
    if ((current.meet_link ?? null) !== (event.meetLink ?? null)) changed.push("meet_link");
    if ((current.meet_conference_id ?? null) !== (event.meetingCode ?? null)) changed.push("meet_conference_id");
    out.push(changed.length > 0 ? { kind: "update", meetingId: current.id, event, changed } : { kind: "skip", event, reason: "unchanged" });
  }
  return out;
}
