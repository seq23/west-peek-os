/**
 * The ONE calendar West Peek OS reads (Phase Meet, 18 Sep 2026).
 *
 * OWNER CORRECTION, 18 Sep 2026, verbatim intent: "West Peek OS does NOT read the spry.vc calendar
 * for anything — Boss OS reads that one, never West Peek OS." The two businesses never blend. So
 * this registry holds exactly one calendar, the firm's, and `validate:calendar-sync` hard-fails if
 * a spry.vc address or the spry iCal key appears anywhere in the calendar or Meet code paths.
 *
 * WHY A REGISTRY FOR ONE ROW. The sync, the ingest, the Workspace Events subscription and the
 * validator all need to agree on which mailbox is impersonated, which firm scope its meetings
 * carry and which env name holds the fallback iCal URL. Four places each holding "sequoia@…" is
 * the defect class this repo already names; one row here is the fix. Adding a calendar is a
 * decision in a commit, never a row an admin path could add.
 */

import { partnerByName } from "../registry/partners";

export interface CalendarSource {
  /** Stable key stored on `meeting.calendar_key` and `google_calendar_sync.calendar_key`. */
  key: string;
  /** The mailbox impersonated through domain-wide delegation. Must be a partner on the firm domain. */
  subjectEmail: string;
  /** Every meeting from this calendar carries this scope. */
  firmScope: string;
  /** Addresses on these domains are the firm. Everybody else is outside it. */
  firmDomains: readonly string[];
  /** Env name of the private iCal URL — the fallback that survives a password change. */
  icsEnvName: "WP_OS_CAL_ICS_WESTPEEK";
}

export const CALENDAR_SOURCES: readonly CalendarSource[] = [
  {
    key: "westpeek",
    // Resolved from the partner registry — the one place that answers who the partners are
    // (`validate:partners` refuses a typed copy). Sequoia's calendar is the firm's calendar.
    subjectEmail: partnerByName("Sequoia")!.email,
    // The worker's HOME_FIRM_SCOPE, spelled here because shared code cannot import the worker.
    firmScope: "west-peek",
    firmDomains: ["westpeek.ventures", "joinwestpeek.com"],
    icsEnvName: "WP_OS_CAL_ICS_WESTPEEK",
  },
] as const;

export function calendarSource(key: string): CalendarSource | null {
  return CALENDAR_SOURCES.find((c) => c.key === key) ?? null;
}
