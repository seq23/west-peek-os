import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { consumeApprovalCard } from "./approvals";
import { addParticipant, importTranscript, transitionMeeting, type MeetingRow } from "./meetings";
import { ingestTranscript } from "./captureAdapter";
import { CALENDAR_SOURCES, calendarSource, type CalendarSource } from "../../shared/meetings/calendarSources";
import {
  conferenceRecordOf,
  entryFromApi,
  meetTranscriptText,
  participantFromApi,
  turnsFromMeet,
  type MeetParticipant,
} from "../../shared/meetings/meetTranscript";
import {
  GoogleWorkspaceError,
  MEET_EVENT_TYPES,
  SCOPE,
  ackPubsub,
  createMeetSubscription,
  getConferenceRecord,
  getSpace,
  isServiceAccountConfigured,
  listConferenceRecords,
  listMeetSubscriptions,
  listParticipants,
  listRecordings,
  listTranscriptEntries,
  listTranscripts,
  pullPubsub,
  renewMeetSubscription,
  serviceAccountToken,
} from "../effects/googleWorkspaceClient";

/**
 * Tier 2 — after the call (Phase Meet, 18 Sep 2026).
 *
 * WHAT HAPPENS WHEN A MEET CALL ENDS. Google generates a transcript (auto-transcription is the
 * firm's admin policy since 18 Sep 2026) and, if it was recorded, a recording, both into Drive.
 * This job hears about the ended conference two ways, drains both into ONE inbox row per
 * conference, and reads each row once:
 *
 *   1. Workspace Events → Pub/Sub, PULLED from inside the tick (the Worker is behind Cloudflare
 *      Access, so a push endpoint could never be reached; see `pullPubsub`).
 *   2. Polling `conferenceRecords` for every calendar meeting whose start time has passed and
 *      which has no inbox row yet — the path that works when no subscription exists, and the
 *      path that catches anything the subscription missed. A webhook that never arrives is
 *      silence, and silence looks like success; polling is what makes silence impossible.
 *
 * READING A ROW: participants (joined to transcript entries by resource name — never by guessing
 * a name), transcript entries, the recording's Drive file id (the bytes stay in Drive), then the
 * transcript goes through `captureAdapter.ingestTranscript` → `importTranscript`, the same two
 * gates every other transcript passes. Nothing here runs a model.
 *
 * ── CONSENT, AND WHY A JOB MAY RECORD IT ───────────────────────────────────────────────────────
 *
 * `recordConsent` is human-only, and rightly: an AI may never record that a person consented.
 * This module writes a GRANTED row anyway, for exactly one case, and here is the argument.
 *
 * Google Meet does not transcribe silently. When transcription or recording starts, every
 * participant sees a banner and hears an announcement, and the Meet interface shows the
 * indicator for the duration. A participant who remains in a call that has announced it is
 * being transcribed has been told, by the platform, in the room, before any words were captured
 * — which is the substance of what the live-capture prompt asks a partner to do out loud. The
 * consent row records THAT: basis `google_meet_announced`, granted_by "every participant who
 * remained after Meet announced transcription", recorded_by system. It is a record of something
 * that did happen, on the platform's evidence, not a checkbox carried forward.
 *
 * WHERE THIS DOES NOT APPLY, and the code refuses:
 *   · A transcript pasted or uploaded by hand — Fireflies, a Docs export, a file. The firm did
 *     not witness the announcement; `importFireflies` says so and writes no consent. The
 *     `platform` field that unlocks this path is not on any request schema (captureAdapter.ts).
 *   · A meeting whose source is not the calendar sync. Only a firm-hosted call under the firm's
 *     own auto-transcription policy qualifies; a Meet somebody else hosted is not the firm's
 *     announcement to rely on.
 *   · The RECORDING policy. Consent is one gate; the MP-reserved recording policy is the other,
 *     and it is satisfied here only by the firm-level decision in `meet_recording_policy`
 *     (migration 0203), never assumed. No policy → the import is REFUSED and the refusal is a
 *     row, exactly as for a pasted transcript.
 */

export class MeetIngestError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export const MEET_PROVIDER = "GOOGLE_MEET" as const;

export interface MeetIngestDeps {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Inbox rows processed per tick. Small: each is a handful of GETs and this tick has a budget. */
  maxRows?: number;
}

export interface InboxRow {
  id: string;
  conference_record: string;
  meeting_id: string | null;
  calendar_key: string | null;
  meeting_code: string | null;
  delivered_via: "poll" | "pubsub";
  event_type: string | null;
  conference_started_at: string | null;
  conference_ended_at: string | null;
  state: "RECEIVED" | "INGESTED" | "REFUSED" | "NO_TRANSCRIPT" | "NO_MEETING" | "FAILED";
  detail: string | null;
  attempts: number;
  transcript_import_id: string | null;
  transcript_ref: string | null;
  recording_ref: string | null;
  participants_json: string;
  turns: number;
  unattributed_turns: number;
  firm_scope: string;
  received_at: string;
  updated_at: string;
}

// ── The firm-level recording policy (the reserved gate, decided once) ────────

export interface FirmRecordingPolicyRow {
  firm_scope: string;
  active: number;
  receipt_id: string | null;
  activated_by: string | null;
  activated_at: string | null;
  deactivated_by: string | null;
  deactivated_at: string | null;
  note: string | null;
}

export async function firmRecordingPolicy(env: Env, firmScope: string): Promise<FirmRecordingPolicyRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM meet_recording_policy WHERE firm_scope = ?1").bind(firmScope).first<FirmRecordingPolicyRow>();
}

/**
 * Turn the firm default on. Reserved: needs an approved `meet.recording_policy.firm_default`
 * receipt, consumed here so it cannot be replayed — the same shape as the per-meeting gate.
 */
export async function activateFirmRecordingPolicy(env: Env, actor: Actor, firmScope: string, receiptId: string | undefined, note?: string): Promise<FirmRecordingPolicyRow> {
  const authz = await authorize(env, actor, "meet.recording_policy.firm_default", { objectType: "meet_recording_policy", objectId: firmScope, firmScope }, { receiptId });
  if (authz.decision === "DENY") throw new MeetIngestError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new MeetIngestError(409, "approval_required", authz.reason);
  const current = await firmRecordingPolicy(env, firmScope);
  if (current?.active === 1) throw new MeetIngestError(409, "already_active", "the firm default is already on");
  const now = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    `INSERT INTO meet_recording_policy (firm_scope, active, receipt_id, activated_by, activated_at, note)
     VALUES (?1, 1, ?2, ?3, ?4, ?5)
     ON CONFLICT (firm_scope) DO UPDATE SET active = 1, receipt_id = excluded.receipt_id, activated_by = excluded.activated_by,
       activated_at = excluded.activated_at, deactivated_by = NULL, deactivated_at = NULL, note = excluded.note`,
  ).bind(firmScope, authz.receiptId ?? null, actor.firmUserId!, now, note ?? null).run();
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  await appendEvent(env, {
    eventType: "meet.recording_policy_firm_default_activated",
    actorType: "firm_user", actorId: actor.firmUserId!,
    objectType: "meet_recording_policy", objectId: firmScope, firmScope,
    payload: { receipt_id: authz.receiptId ?? null, note: note ?? null },
  });
  return (await firmRecordingPolicy(env, firmScope))!;
}

/**
 * Turning it OFF needs no receipt — closing a gate is the safe direction — but it is still an MP
 * act, authorised as `meeting.update` in scope and recorded on the spine.
 */
export async function deactivateFirmRecordingPolicy(env: Env, actor: Actor, firmScope: string, note?: string): Promise<FirmRecordingPolicyRow | null> {
  if (actor.type !== "HUMAN" || !actor.roles.includes("MANAGING_PARTNER")) throw new MeetIngestError(403, "forbidden", "only a Managing Partner turns the firm default off");
  await env.WP_OS_DB.prepare(
    "UPDATE meet_recording_policy SET active = 0, deactivated_by = ?2, deactivated_at = ?3, note = COALESCE(?4, note) WHERE firm_scope = ?1",
  ).bind(firmScope, actor.firmUserId!, new Date().toISOString(), note ?? null).run();
  await appendEvent(env, {
    eventType: "meet.recording_policy_firm_default_deactivated",
    actorType: "firm_user", actorId: actor.firmUserId!,
    objectType: "meet_recording_policy", objectId: firmScope, firmScope,
    payload: { note: note ?? null },
  });
  return firmRecordingPolicy(env, firmScope);
}

// ── Platform-announced consent ───────────────────────────────────────────────

export const PLATFORM_CONSENT_BASIS = "google_meet_announced";

/**
 * Write the two consent rows for a Meet-native transcript. See the module docstring for why this
 * is legitimate and where it is not. Refuses anything that is not a calendar-synced meeting.
 */
export async function recordPlatformAnnouncedConsent(env: Env, actor: Actor, meeting: MeetingRow, conferenceRecord: string): Promise<{ transcription: string; recording: string }> {
  if (meeting.source !== "google_calendar") {
    throw new MeetIngestError(409, "not_firm_hosted", "platform-announced consent applies only to a meeting the calendar sync created — a firm-hosted Meet under the firm's own transcription policy");
  }
  const authz = await authorize(env, actor, "meet.consent.platform_announced", { objectType: "consent_record", objectId: meeting.id, firmScope: meeting.firm_scope });
  if (authz.decision !== "ALLOW") throw new MeetIngestError(403, "forbidden", authz.reason);
  const ids: Record<string, string> = {};
  for (const type of ["TRANSCRIPTION", "RECORDING"] as const) {
    const id = `csr_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO consent_record (id, meeting_id, consent_type, state, basis, granted_by, recorded_by, firm_scope)
       VALUES (?1, ?2, ?3, 'GRANTED', ?4, ?5, 'system', ?6)`,
    )
      .bind(
        id, meeting.id, type,
        `${PLATFORM_CONSENT_BASIS}: Google Meet announced ${type.toLowerCase()} to every participant in ${conferenceRecord} and showed its indicator for the duration; participants remained`,
        "every participant who remained after Meet announced it",
        meeting.firm_scope,
      )
      .run();
    ids[type] = id;
    await appendEvent(env, {
      eventType: "meeting.consent_recorded",
      actorType: "system", actorId: "system",
      objectType: "consent_record", objectId: id, firmScope: meeting.firm_scope,
      payload: { meeting_id: meeting.id, consent_type: type, state: "GRANTED", basis: PLATFORM_CONSENT_BASIS, conference_record: conferenceRecord },
    });
  }
  return { transcription: ids.TRANSCRIPTION!, recording: ids.RECORDING! };
}

// ── The inbox ────────────────────────────────────────────────────────────────

async function upsertInbox(
  env: Env,
  row: { conference_record: string; meeting_id: string | null; calendar_key: string | null; meeting_code: string | null; delivered_via: "poll" | "pubsub"; event_type: string | null; started: string | null; ended: string | null; firm_scope: string },
): Promise<{ inserted: boolean }> {
  const existing = await env.WP_OS_DB.prepare("SELECT id, meeting_id FROM meet_event_inbox WHERE conference_record = ?1").bind(row.conference_record).first<{ id: string; meeting_id: string | null }>();
  if (existing) {
    // A second hearing about the same conference is bookkeeping, not a second row.
    await env.WP_OS_DB.prepare(
      `UPDATE meet_event_inbox SET meeting_id = COALESCE(meeting_id, ?2), meeting_code = COALESCE(meeting_code, ?3), calendar_key = COALESCE(calendar_key, ?4),
         conference_started_at = COALESCE(conference_started_at, ?5), conference_ended_at = COALESCE(conference_ended_at, ?6),
         event_type = COALESCE(?7, event_type), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?1`,
    ).bind(existing.id, row.meeting_id, row.meeting_code, row.calendar_key, row.started, row.ended, row.event_type).run();
    return { inserted: false };
  }
  await env.WP_OS_DB.prepare(
    `INSERT INTO meet_event_inbox (id, conference_record, meeting_id, calendar_key, meeting_code, delivered_via, event_type, conference_started_at, conference_ended_at, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(`mei_${crypto.randomUUID()}`, row.conference_record, row.meeting_id, row.calendar_key, row.meeting_code, row.delivered_via, row.event_type, row.started, row.ended, row.firm_scope).run();
  return { inserted: true };
}

async function setInbox(env: Env, id: string, patch: Partial<InboxRow>): Promise<void> {
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const sets = cols.map((c, i) => `${c} = ?${i + 2}`).join(", ");
  await env.WP_OS_DB.prepare(`UPDATE meet_event_inbox SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`)
    .bind(id, ...cols.map((c) => (patch as Record<string, unknown>)[c] ?? null))
    .run();
}

/** The calendar meeting a conference belongs to: same meeting code, nearest scheduled time before the conference started. */
async function meetingForConference(env: Env, meetingCode: string, startedAt: string | null): Promise<MeetingRow | null> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT * FROM meeting WHERE meet_conference_id = ?1 AND source = 'google_calendar' AND archived_at IS NULL ORDER BY scheduled_at DESC",
  ).bind(meetingCode).all<MeetingRow>();
  const candidates = rows.results ?? [];
  if (candidates.length === 0) return null;
  if (!startedAt) return candidates[0]!;
  const t = Date.parse(startedAt);
  // A recurring space serves many occurrences. The occurrence is the one scheduled within a few
  // hours of when the conference actually began; failing that, the most recent one before it.
  const within = candidates.filter((m) => m.scheduled_at && Math.abs(Date.parse(m.scheduled_at) - t) <= 6 * 3_600_000);
  if (within.length > 0) return within.sort((a, b) => Math.abs(Date.parse(a.scheduled_at!) - t) - Math.abs(Date.parse(b.scheduled_at!) - t))[0]!;
  return candidates.find((m) => m.scheduled_at && Date.parse(m.scheduled_at) <= t) ?? candidates[0]!;
}

// ── Hearing about ended conferences ─────────────────────────────────────────

interface Heard {
  pubsub: { pulled: number; inserted: number; detail: string | null };
  poll: { meetingsChecked: number; inserted: number; detail: string | null };
  subscription: { state: "ACTIVE" | "SCOPE_MISSING" | "FAILED" | "NONE"; detail: string | null };
}

async function drainPubsub(env: Env, fetchImpl: typeof fetch): Promise<Heard["pubsub"]> {
  const sub = env.WP_OS_MEET_PUBSUB_SUBSCRIPTION;
  if (!sub) return { pulled: 0, inserted: 0, detail: "no Pub/Sub subscription configured (WP_OS_MEET_PUBSUB_SUBSCRIPTION); polling only" };
  try {
    const token = await serviceAccountToken(env, [SCOPE.pubsub], null, fetchImpl);
    const messages = await pullPubsub(token, sub, 50, fetchImpl);
    let inserted = 0;
    for (const m of messages) {
      const subject = m.attributes["ce-subject"] ?? m.attributes["ce-source"] ?? "";
      const resource = typeof m.data.conferenceRecord === "object" && m.data.conferenceRecord
        ? String((m.data.conferenceRecord as { name?: string }).name ?? "")
        : typeof m.data.transcript === "object" && m.data.transcript
          ? String((m.data.transcript as { name?: string }).name ?? "")
          : typeof m.data.recording === "object" && m.data.recording
            ? String((m.data.recording as { name?: string }).name ?? "")
            : "";
      const record = conferenceRecordOf(resource) ?? conferenceRecordOf(subject.replace(/^\/\/meet\.googleapis\.com\//, ""));
      if (!record) continue;
      const r = await upsertInbox(env, {
        conference_record: record, meeting_id: null, calendar_key: null, meeting_code: null,
        delivered_via: "pubsub", event_type: m.attributes["ce-type"] ?? null, started: null, ended: null,
        firm_scope: CALENDAR_SOURCES[0]!.firmScope,
      });
      if (r.inserted) inserted += 1;
    }
    await ackPubsub(token, sub, messages.map((m) => m.ackId), fetchImpl);
    return { pulled: messages.length, inserted, detail: null };
  } catch (err) {
    return { pulled: 0, inserted: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function pollEnded(env: Env, source: CalendarSource, now: Date, fetchImpl: typeof fetch): Promise<Heard["poll"]> {
  // Meetings that should have ended: scheduled in the last 7 days and at least 10 minutes ago.
  const candidates = await env.WP_OS_DB.prepare(
    `SELECT m.* FROM meeting m
      WHERE m.calendar_key = ?1 AND m.source = 'google_calendar' AND m.meet_conference_id IS NOT NULL
        AND m.status <> 'CANCELLED' AND m.archived_at IS NULL
        AND m.scheduled_at IS NOT NULL AND m.scheduled_at <= ?2 AND m.scheduled_at >= ?3
        AND NOT EXISTS (SELECT 1 FROM meet_event_inbox i WHERE i.meeting_id = m.id AND i.state IN ('INGESTED','NO_TRANSCRIPT','REFUSED'))
      ORDER BY m.scheduled_at DESC LIMIT 25`,
  )
    .bind(source.key, new Date(now.getTime() - 10 * 60_000).toISOString(), new Date(now.getTime() - 7 * 86_400_000).toISOString())
    .all<MeetingRow>();
  const meetings = candidates.results ?? [];
  if (meetings.length === 0) return { meetingsChecked: 0, inserted: 0, detail: "no calendar meeting has ended in the last 7 days without being read" };
  let token: string;
  try {
    token = await serviceAccountToken(env, [SCOPE.meetRead], source.subjectEmail, fetchImpl);
  } catch (err) {
    return { meetingsChecked: 0, inserted: 0, detail: err instanceof Error ? err.message : String(err) };
  }
  let inserted = 0;
  const codes = new Set<string>();
  for (const m of meetings) {
    const code = m.meet_conference_id!;
    if (codes.has(code)) continue;
    codes.add(code);
    let records;
    try {
      records = await listConferenceRecords(token, { meetingCode: code, startedAfter: new Date(now.getTime() - 8 * 86_400_000) }, fetchImpl);
    } catch (err) {
      return { meetingsChecked: codes.size, inserted, detail: err instanceof Error ? err.message : String(err) };
    }
    for (const rec of records) {
      if (!rec.endTime) continue; // still live
      const meeting = await meetingForConference(env, code, rec.startTime ?? null);
      const r = await upsertInbox(env, {
        conference_record: rec.name, meeting_id: meeting?.id ?? null, calendar_key: source.key, meeting_code: code,
        delivered_via: "poll", event_type: MEET_EVENT_TYPES[0], started: rec.startTime ?? null, ended: rec.endTime ?? null, firm_scope: source.firmScope,
      });
      if (r.inserted) inserted += 1;
    }
  }
  return { meetingsChecked: codes.size, inserted, detail: null };
}

/**
 * Keep one Workspace Events subscription alive per Meet SPACE the calendar knows.
 *
 * Per space because that is what Google permits under this grant (see `createMeetSubscription`).
 * The spaces are the distinct meeting codes on calendar meetings from yesterday to three weeks
 * out — a recurring series is one space, so the set is small. Each is created or renewed before
 * it lapses; a missing grant is a named state (`SCOPE_MISSING`) on the ledger, never an exception
 * that kills the tick — polling still runs, so a space without a live subscription is a visible
 * gap rather than a silent one. The calendar ledger carries the aggregate.
 */
async function ensureSubscriptions(env: Env, source: CalendarSource, now: Date, fetchImpl: typeof fetch): Promise<Heard["subscription"]> {
  const topic = env.WP_OS_MEET_PUBSUB_TOPIC;
  const aggregate = async (state: Heard["subscription"]["state"], detail: string | null) => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO google_calendar_sync (calendar_key, subject_email, firm_scope, subscription_state, subscription_detail, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (calendar_key) DO UPDATE SET subscription_state = excluded.subscription_state, subscription_detail = excluded.subscription_detail, updated_at = excluded.updated_at`,
    ).bind(source.key, source.subjectEmail, source.firmScope, state, detail, now.toISOString()).run();
    return { state, detail };
  };
  if (!topic) return aggregate("NONE", "no Pub/Sub topic configured (WP_OS_MEET_PUBSUB_TOPIC); polling only");

  const codes = ((await env.WP_OS_DB.prepare(
    `SELECT DISTINCT meet_conference_id AS code FROM meeting
      WHERE calendar_key = ?1 AND source = 'google_calendar' AND meet_conference_id IS NOT NULL AND status <> 'CANCELLED' AND archived_at IS NULL
        AND scheduled_at >= ?2 AND scheduled_at <= ?3 ORDER BY scheduled_at DESC LIMIT 40`,
  ).bind(source.key, new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + 21 * 86_400_000).toISOString()).all<{ code: string }>()).results ?? []).map((r) => r.code);
  if (codes.length === 0) return aggregate("NONE", "no calendar meeting with a Meet link between yesterday and three weeks out");

  const writeSpace = async (code: string, patch: { space_name?: string | null; subscription_name?: string | null; expires_at?: string | null; state: string; detail: string | null }) => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO meet_space_subscription (meeting_code, space_name, subscription_name, expires_at, state, detail, calendar_key, firm_scope, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (meeting_code) DO UPDATE SET space_name = COALESCE(excluded.space_name, space_name), subscription_name = COALESCE(excluded.subscription_name, subscription_name),
         expires_at = COALESCE(excluded.expires_at, expires_at), state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
    ).bind(code, patch.space_name ?? null, patch.subscription_name ?? null, patch.expires_at ?? null, patch.state, patch.detail, source.key, source.firmScope, now.toISOString()).run();
  };

  let token: string;
  try {
    token = await serviceAccountToken(env, [SCOPE.meetCreated, SCOPE.meetRead], source.subjectEmail, fetchImpl);
  } catch (err) {
    const scopeMissing = err instanceof GoogleWorkspaceError && err.code === "scope_missing";
    const detail = err instanceof Error ? err.message : String(err);
    for (const code of codes) await writeSpace(code, { state: scopeMissing ? "SCOPE_MISSING" : "FAILED", detail });
    return aggregate(scopeMissing ? "SCOPE_MISSING" : "FAILED", detail);
  }
  let existing: Awaited<ReturnType<typeof listMeetSubscriptions>> = [];
  try {
    existing = await listMeetSubscriptions(token, fetchImpl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return aggregate("FAILED", `could not list subscriptions: ${detail}`);
  }
  const RENEW_WITHIN_MS = 24 * 3_600_000;
  let active = 0;
  const failures: string[] = [];
  for (const code of codes) {
    const known = await env.WP_OS_DB.prepare("SELECT space_name, subscription_name, expires_at, state FROM meet_space_subscription WHERE meeting_code = ?1").bind(code).first<{ space_name: string | null; subscription_name: string | null; expires_at: string | null; state: string }>();
    if (known?.state === "ACTIVE" && known.expires_at && Date.parse(known.expires_at) - now.getTime() > RENEW_WITHIN_MS) {
      active += 1;
      continue;
    }
    try {
      const spaceName = known?.space_name ?? (await getSpace(token, `spaces/${code}`, fetchImpl)).name;
      const target = `//meet.googleapis.com/${spaceName}`;
      const live = existing.find((s) => s.targetResource === target && s.notificationEndpoint?.pubsubTopic === topic && s.state !== "DELETED");
      if (live && live.expireTime && Date.parse(live.expireTime) - now.getTime() > RENEW_WITHIN_MS) {
        await writeSpace(code, { space_name: spaceName, subscription_name: live.name, expires_at: live.expireTime, state: "ACTIVE", detail: null });
      } else if (live) {
        const renewed = await renewMeetSubscription(token, live.name, 7 * 24, fetchImpl);
        await writeSpace(code, { space_name: spaceName, subscription_name: renewed.name, expires_at: renewed.expireTime ?? null, state: "ACTIVE", detail: "renewed" });
      } else {
        const created = await createMeetSubscription(token, spaceName, topic, fetchImpl);
        await writeSpace(code, { space_name: spaceName, subscription_name: created.name, expires_at: created.expireTime ?? null, state: "ACTIVE", detail: "created" });
      }
      active += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await writeSpace(code, { state: "FAILED", detail });
      failures.push(`${code}: ${detail}`);
    }
  }
  if (failures.length > 0) return aggregate(active > 0 ? "ACTIVE" : "FAILED", `${active}/${codes.length} space(s) subscribed; ${failures.join("; ")}`);
  return aggregate("ACTIVE", `${active}/${codes.length} space(s) subscribed`);
}

// ── Reading one conference ───────────────────────────────────────────────────

export interface ReadOutcome {
  state: InboxRow["state"];
  detail: string;
}

/**
 * Read one inbox row end to end. Idempotent: a row already INGESTED is returned untouched, and the
 * inbox UNIQUE on conference_record means the same conference cannot be read twice.
 */
export async function readConference(env: Env, row: InboxRow, deps: MeetIngestDeps = {}): Promise<ReadOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  if (row.state === "INGESTED") return { state: "INGESTED", detail: "already read" };
  await setInbox(env, row.id, { attempts: row.attempts + 1 });

  const source = calendarSource(row.calendar_key ?? CALENDAR_SOURCES[0]!.key) ?? CALENDAR_SOURCES[0]!;
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [source.firmScope] };

  let token: string;
  try {
    token = await serviceAccountToken(env, [SCOPE.meetRead], source.subjectEmail, fetchImpl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await setInbox(env, row.id, { state: "FAILED", detail });
    return { state: "FAILED", detail };
  }

  try {
    // 1. The conference itself, and the meeting it belongs to.
    const record = await getConferenceRecord(token, row.conference_record, fetchImpl);
    let meetingCode = row.meeting_code;
    if (!meetingCode && record.space) meetingCode = (await getSpace(token, record.space, fetchImpl)).meetingCode ?? null;
    const meeting = row.meeting_id
      ? await env.WP_OS_DB.prepare("SELECT * FROM meeting WHERE id = ?1").bind(row.meeting_id).first<MeetingRow>()
      : meetingCode ? await meetingForConference(env, meetingCode, record.startTime ?? null) : null;
    if (!meeting) {
      const detail = `no calendar meeting carries Meet code ${meetingCode ?? "(unknown)"}; the calendar sync has not seen this call`;
      await setInbox(env, row.id, { state: "NO_MEETING", detail, meeting_code: meetingCode, conference_started_at: record.startTime ?? null, conference_ended_at: record.endTime ?? null });
      return { state: "NO_MEETING", detail };
    }
    if (!record.endTime) {
      const detail = "the conference is still in progress";
      await setInbox(env, row.id, { detail, meeting_id: meeting.id, meeting_code: meetingCode });
      return { state: "RECEIVED", detail };
    }

    // 2. Who was there.
    const participants: MeetParticipant[] = (await listParticipants(token, row.conference_record, fetchImpl)).map(participantFromApi);
    const existingNames = new Set(
      ((await env.WP_OS_DB.prepare("SELECT display_name FROM meeting_participant WHERE meeting_id = ?1").bind(meeting.id).all<{ display_name: string }>()).results ?? []).map((p) => p.display_name.toLowerCase()),
    );
    for (const p of participants) {
      if (!p.displayName || existingNames.has(p.displayName.toLowerCase())) continue;
      await addParticipant(env, actor, meeting.id, { participant_type: "EXTERNAL", display_name: p.displayName, participant_role: p.kind === "PHONE" ? "phone" : p.kind === "ANONYMOUS" ? "guest" : undefined });
      existingNames.add(p.displayName.toLowerCase());
    }

    // 3. The recording pointer. The bytes stay in Drive.
    const recordings = await listRecordings(token, row.conference_record, fetchImpl).catch(() => []);
    const recordingRef = recordings.find((r) => r.state === "FILE_GENERATED" && r.driveDestination?.file)?.driveDestination?.file ?? null;

    // 4. The transcript. Not generated yet is RECEIVED (retried); never generated is NO_TRANSCRIPT.
    const transcripts = await listTranscripts(token, row.conference_record, fetchImpl);
    const ready = transcripts.find((t) => t.state === "FILE_GENERATED");
    if (!ready) {
      const endedAgoMs = now.getTime() - Date.parse(record.endTime);
      const patch = { meeting_id: meeting.id, meeting_code: meetingCode, recording_ref: recordingRef, participants_json: JSON.stringify(participants.map((p) => p.displayName)), conference_started_at: record.startTime ?? null, conference_ended_at: record.endTime };
      if (transcripts.length === 0 && endedAgoMs > 24 * 3_600_000) {
        const detail = "the call ended more than a day ago and Meet generated no transcript — transcription was not on for it";
        await setInbox(env, row.id, { ...patch, state: "NO_TRANSCRIPT", detail });
        if (recordingRef) await env.WP_OS_DB.prepare("UPDATE meeting SET recording_ref = ?2 WHERE id = ?1").bind(meeting.id, recordingRef).run();
        return { state: "NO_TRANSCRIPT", detail };
      }
      const detail = transcripts.length === 0 ? "no transcript yet; Meet generates it a few minutes after the call ends" : `transcript ${transcripts[0]!.state ?? "pending"}; not yet a file`;
      await setInbox(env, row.id, { ...patch, detail });
      return { state: "RECEIVED", detail };
    }
    const entries = (await listTranscriptEntries(token, ready.name, fetchImpl)).map(entryFromApi);
    const turns = turnsFromMeet(entries, participants);
    const transcriptRef = ready.docsDestination?.document ?? null;

    // 5. The two gates: firm-level recording policy, then platform-announced consent.
    const policy = await firmRecordingPolicy(env, meeting.firm_scope);
    if (policy?.active === 1 && meeting.recording_enabled !== 1) {
      await env.WP_OS_DB.prepare("UPDATE meeting SET recording_enabled = 1, recording_policy_receipt_id = ?2 WHERE id = ?1").bind(meeting.id, policy.receipt_id).run();
      await appendEvent(env, {
        eventType: "meeting.recording_policy_activated",
        actorType: "system", actorId: "system",
        objectType: "meeting", objectId: meeting.id, firmScope: meeting.firm_scope,
        payload: { receipt_id: policy.receipt_id, via: "meet_recording_policy.firm_default" },
      });
      meeting.recording_enabled = 1;
    }
    if (meeting.recording_enabled === 1) await recordPlatformAnnouncedConsent(env, actor, meeting, row.conference_record);

    // 6. Through the governed import. A refusal is a REFUSED transcript_import row and a REFUSED inbox row.
    let importId: string;
    try {
      const out = await ingestTranscript(
        env, actor, meeting.id,
        { source: "PROVIDER", text: turns.turns.length > 0 ? meetTranscriptText(turns.turns) : "(Meet generated a transcript with no entries)", platform: MEET_PROVIDER },
        importTranscript as never,
      );
      importId = out.transcript_import_id;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const detail =
        e.code === "recording_policy_not_activated"
          ? "refused: the firm's Meet recording default is off (POST /api/meet/recording-policy with an approved meet.recording_policy.firm_default receipt turns it on)"
          : `refused: ${e.code ?? "error"} — ${e.message ?? ""}`;
      await setInbox(env, row.id, { state: "REFUSED", detail, meeting_id: meeting.id, meeting_code: meetingCode, transcript_ref: transcriptRef, recording_ref: recordingRef, turns: turns.turns.length, unattributed_turns: turns.unattributed, participants_json: JSON.stringify(participants.map((p) => p.displayName)), conference_started_at: record.startTime ?? null, conference_ended_at: record.endTime });
      return { state: "REFUSED", detail };
    }

    // 7. The meeting was held. Pointers on the meeting; the row says what was read.
    await env.WP_OS_DB.prepare("UPDATE meeting SET recording_ref = COALESCE(?2, recording_ref), transcript_ref = COALESCE(?3, transcript_ref) WHERE id = ?1").bind(meeting.id, recordingRef, transcriptRef).run();
    if (meeting.status === "SCHEDULED") await transitionMeeting(env, actor, meeting.id, "HELD", record.startTime ?? undefined);
    const detail = `${turns.turns.length} turn(s)${turns.unattributed > 0 ? `, ${turns.unattributed} not attributed by Meet` : ""}; ${participants.length} participant(s)${recordingRef ? "; recording in Drive" : ""}`;
    await setInbox(env, row.id, {
      state: "INGESTED", detail, meeting_id: meeting.id, meeting_code: meetingCode, transcript_import_id: importId, transcript_ref: transcriptRef, recording_ref: recordingRef,
      turns: turns.turns.length, unattributed_turns: turns.unattributed, participants_json: JSON.stringify(participants.map((p) => p.displayName)),
      conference_started_at: record.startTime ?? null, conference_ended_at: record.endTime,
    });
    await appendEvent(env, {
      eventType: "meet.conference_ingested",
      actorType: "system", actorId: "system",
      objectType: "meeting", objectId: meeting.id, firmScope: meeting.firm_scope,
      payload: { conference_record: row.conference_record, transcript_import_id: importId, turns: turns.turns.length, unattributed: turns.unattributed, recording_ref: recordingRef, transcript_ref: transcriptRef, delivered_via: row.delivered_via },
    });
    return { state: "INGESTED", detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await setInbox(env, row.id, { state: "FAILED", detail });
    return { state: "FAILED", detail };
  }
}

// ── The job body ─────────────────────────────────────────────────────────────

export interface MeetIngestOutcome {
  ok: boolean;
  summary: string;
  heard: Heard;
  read: Array<{ conference_record: string; state: InboxRow["state"]; detail: string }>;
}

export async function runMeetIngest(env: Env, deps: MeetIngestDeps = {}): Promise<MeetIngestOutcome> {
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const source = CALENDAR_SOURCES[0]!;
  if (!isServiceAccountConfigured(env)) {
    return {
      ok: false,
      summary: "not configured: WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not set, so no Meet call can be read",
      heard: { pubsub: { pulled: 0, inserted: 0, detail: "not configured" }, poll: { meetingsChecked: 0, inserted: 0, detail: "not configured" }, subscription: { state: "NONE", detail: "not configured" } },
      read: [],
    };
  }
  const subscription = await ensureSubscriptions(env, source, now, fetchImpl);
  const pubsub = await drainPubsub(env, fetchImpl);
  const poll = await pollEnded(env, source, now, fetchImpl);

  /*
   * A ROW REFUSED FOR WANT OF THE FIRM DEFAULT IS READ ONCE THE DEFAULT IS ON. The refusal stays
   * on transcript_import as the record of what happened the first time; the second reading writes
   * its own IMPORTED row. Any other refusal — consent, a missing meeting — stays refused: those are
   * facts about the call, not about a switch somebody has since flipped.
   */
  const due = (await env.WP_OS_DB.prepare(
    `SELECT i.* FROM meet_event_inbox i
      WHERE i.attempts < 48
        AND (
          i.state IN ('RECEIVED','FAILED')
          OR (i.state = 'REFUSED' AND i.detail LIKE 'refused: the firm%'
              AND EXISTS (SELECT 1 FROM meet_recording_policy p WHERE p.firm_scope = i.firm_scope AND p.active = 1))
        )
      ORDER BY i.received_at ASC LIMIT ?1`,
  ).bind(deps.maxRows ?? 5).all<InboxRow>()).results ?? [];
  const read: MeetIngestOutcome["read"] = [];
  for (const row of due) {
    const out = await readConference(env, row, deps);
    read.push({ conference_record: row.conference_record, state: out.state, detail: out.detail });
  }
  const counts = (s: InboxRow["state"]) => read.filter((r) => r.state === s).length;
  const heardDetail = [
    subscription.state === "ACTIVE" ? "events subscribed" : `events ${subscription.state.toLowerCase()}${subscription.detail ? ` (${subscription.detail})` : ""}`,
    pubsub.detail ? `pubsub: ${pubsub.detail}` : `pubsub ${pubsub.pulled} message(s)`,
    poll.detail && poll.meetingsChecked === 0 && poll.inserted === 0 ? `poll: ${poll.detail}` : `polled ${poll.meetingsChecked} meeting code(s)`,
  ].join(" · ");
  const summary =
    read.length === 0
      ? `nothing to read — ${heardDetail}`
      : `${counts("INGESTED")} ingested · ${counts("RECEIVED")} waiting for a transcript · ${counts("NO_TRANSCRIPT")} without one · ${counts("REFUSED")} refused · ${counts("NO_MEETING")} unmatched · ${counts("FAILED")} failed — ${heardDetail}`;
  const ok = counts("FAILED") === 0 && !(poll.detail && poll.meetingsChecked === 0 && poll.inserted === 0 && !/^no calendar meeting/.test(poll.detail));
  return { ok, summary, heard: { pubsub, poll, subscription }, read };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const policySchema = z.object({
  action: z.enum(["activate", "deactivate"]),
  approval_receipt_id: z.string().optional(),
  note: z.string().max(500).optional(),
});

/** POST /api/meet/recording-policy — the one reserved decision, turned on with a receipt or off by an MP. */
export async function handleFirmRecordingPolicy(ctx: RouteContext): Promise<Response> {
  const parsed = policySchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  try {
    const row = parsed.data.action === "activate"
      ? await activateFirmRecordingPolicy(ctx.env, actor, firmScope, parsed.data.approval_receipt_id, parsed.data.note)
      : await deactivateFirmRecordingPolicy(ctx.env, actor, firmScope, parsed.data.note);
    return json(row ?? { firm_scope: firmScope, active: 0 });
  } catch (err) {
    if (err instanceof MeetIngestError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

/** GET /api/meet/status — policy, subscription, inbox counts. What a partner reads to know the door is open. */
export async function handleMeetStatus(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const policy = await firmRecordingPolicy(ctx.env, firmScope);
  const ledger = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM google_calendar_sync ORDER BY calendar_key").all()).results ?? [];
  const inbox = (await ctx.env.WP_OS_DB.prepare("SELECT state, COUNT(*) AS n FROM meet_event_inbox GROUP BY state").all<{ state: string; n: number }>()).results ?? [];
  return json({
    configured: isServiceAccountConfigured(ctx.env),
    pubsub: { topic: ctx.env.WP_OS_MEET_PUBSUB_TOPIC ?? null, subscription: ctx.env.WP_OS_MEET_PUBSUB_SUBSCRIPTION ?? null },
    recording_policy: policy ?? { firm_scope: firmScope, active: 0 },
    calendars: ledger,
    inbox: Object.fromEntries(inbox.map((r) => [r.state, r.n])),
  });
}

/** GET /api/meet/inbox — every conference heard about, newest first. */
export async function handleMeetInbox(ctx: RouteContext): Promise<Response> {
  const rows = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM meet_event_inbox ORDER BY received_at DESC LIMIT 200").all<InboxRow>()).results ?? [];
  return json({ inbox: rows });
}

/** POST /api/meet/ingest — run the ingest now. Same body as the tick. */
export async function handleRunMeetIngest(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "meet.ingest", { objectType: "meet_event_inbox" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const out = await runMeetIngest(ctx.env);
  return json(out, { status: out.ok ? 200 : 502 });
}
