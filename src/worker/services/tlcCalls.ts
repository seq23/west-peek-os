import type { Env } from "../env";
import { SCOPE, createCalendarEvent, listCalendarEvents, serviceAccountToken } from "../effects/googleWorkspaceClient";
import { CALL_MINUTES, type Busy } from "../../shared/tlc/callSlots";
import { TLC_OWNER, brandDisplayName } from "../../shared/tlc/learningClub";

/**
 * HER CALENDAR, FOR A CALL A BRAND ASKED FOR (owner, 26 Oct 2026). Busy times are read from her live Google
 * calendar (the service account's delegated calendar read, as her) and from the meetings the OS already holds; when
 * the live read fails, the meetings alone stand in and the draft's note says so. Once she approves the confirmation,
 * the event goes on her calendar with the brand invited (`calendar.events`), which the meeting sync then picks up
 * for the prep email the evening before.
 */
export type BusyReader = (env: Env, from: Date, to: Date) => Promise<{ busy: Busy[]; note: string | null }>;
export type EventMaker = (env: Env, e: { summary: string; description: string; start: string; end: string; attendees: readonly string[] }) => Promise<{ id: string }>;

export const herBusy: BusyReader = async (env, from, to) => {
  const busy: Busy[] = [];
  const held = (await env.WP_OS_DB.prepare("SELECT scheduled_at FROM meeting WHERE status = 'SCHEDULED' AND scheduled_at >= ?1 AND scheduled_at <= ?2")
    .bind(from.toISOString(), to.toISOString()).all<{ scheduled_at: string }>().catch(() => ({ results: [] as Array<{ scheduled_at: string }> }))).results ?? [];
  for (const m of held) {
    const s = Date.parse(m.scheduled_at);
    if (Number.isFinite(s)) busy.push({ start: s, end: s + 60 * 60_000 });
  }
  let note: string | null = null;
  try {
    const token = await serviceAccountToken(env, [SCOPE.calendarRead], TLC_OWNER.email);
    for (const ev of await listCalendarEvents(token, from, to)) {
      const e = ev as { status?: string; transparency?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
      if (e.status === "cancelled" || e.transparency === "transparent" || !e.start?.dateTime || !e.end?.dateTime) continue;
      busy.push({ start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime) });
    }
  } catch (err) {
    note = `her live calendar could not be read (${err instanceof Error ? err.message : String(err)}), so only the meetings the OS holds were checked`;
  }
  return { busy, note };
};

export const makeEvent: EventMaker = async (env, e) => {
  const token = await serviceAccountToken(env, [SCOPE.calendarEvents], TLC_OWNER.email);
  return createCalendarEvent(token, e);
};

/** The calendar event for an agreed call: 30 minutes, the brand's contact invited, a Meet link. */
export function callEvent(brand: string, contactEmail: string, slot: string, topic: string | null): { summary: string; description: string; start: string; end: string; attendees: string[] } {
  const start = new Date(slot);
  return {
    summary: `${brandDisplayName(brand)} x West Peek: The Learning Club`,
    description: `A call ${brandDisplayName(brand)} asked for about The Learning Club${topic ? ` (${topic})` : ""}. Scheduled by Wynn on her approval.`,
    start: start.toISOString(),
    end: new Date(start.getTime() + CALL_MINUTES * 60_000).toISOString(),
    attendees: [contactEmail],
  };
}
