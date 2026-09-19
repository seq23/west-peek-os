#!/usr/bin/env node
/**
 * probe-google.mjs — the live, read-only proof for Phase Meet. Run under the vault:
 *
 *   npm run vault:run -- node scripts/meet/probe-google.mjs            # read-only
 *   npm run vault:run -- node scripts/meet/probe-google.mjs --subscribe # also create/renew the events subscription
 *
 * Uses the SAME effects client the Worker uses (bundled from TypeScript), so what passes here is
 * what the job does. Prints counts, states and Google error CODES only — never a token, never a
 * key, never a resource body. A 401 `unauthorized_client` at the token endpoint is reported as
 * SCOPE_MISSING with the scope named, because that is the delegation grant, not the API.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "../validate/lib/load-ts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const g = await loadTs(path.join(ROOT, "src", "worker", "effects", "googleWorkspaceClient.ts"));
const { CALENDAR_SOURCES } = await loadTs(path.join(ROOT, "src", "shared", "meetings", "calendarSources.ts"));

const env = {
  WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: process.env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON ?? process.env.GSC_SERVICE_ACCOUNT_JSON,
  WP_OS_CAL_ICS_WESTPEEK: process.env.WP_OS_CAL_ICS_WESTPEEK ?? process.env.CAL_ICS_WESTPEEK,
};
const PROJECT = process.env.WP_OS_GCP_PROJECT_ID ?? "gsc-automation-493801";
const TOPIC = process.env.WP_OS_MEET_PUBSUB_TOPIC ?? `projects/${PROJECT}/topics/meet-events`;
const SUBSCRIPTION = process.env.WP_OS_MEET_PUBSUB_SUBSCRIPTION ?? `projects/${PROJECT}/subscriptions/meet-events-wpos`;
const subscribe = process.argv.includes("--subscribe");

const rows = [];
const row = (what, state, detail = "") => { rows.push([what, state, detail]); console.log(`${state.padEnd(14)} ${what}${detail ? ` — ${detail}` : ""}`); };
const fail = (err) => (err?.code === "scope_missing" ? `SCOPE_MISSING` : err?.code ? `FAILED:${err.code}` : "FAILED");

if (!g.isServiceAccountConfigured(env)) { row("service account", "NOT_CONFIGURED", "WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON / GSC_SERVICE_ACCOUNT_JSON absent"); process.exit(1); }
const source = CALENDAR_SOURCES[0];
row("calendar registry", "CONFIRMED", `${CALENDAR_SOURCES.length} calendar: ${source.subjectEmail} → firm_scope ${source.firmScope}`);

// Calendar under impersonation
try {
  const t = await g.serviceAccountToken(env, [g.SCOPE.calendarRead], source.subjectEmail);
  const items = await g.listCalendarEvents(t, new Date(Date.now() - 7 * 864e5), new Date(Date.now() + 21 * 864e5));
  const meet = items.filter((e) => e.hangoutLink || e.conferenceData?.conferenceId);
  row("calendar.readonly as the partner", "CONFIRMED", `${items.length} events −7d/+21d, ${meet.length} with a Meet link`);
} catch (err) { row("calendar.readonly as the partner", fail(err), err.message); }

// iCal fallback
try {
  if (!env.WP_OS_CAL_ICS_WESTPEEK) row("iCal fallback", "NOT_CONFIGURED", "CAL_ICS_WESTPEEK absent");
  else { const ics = await g.fetchIcs(env.WP_OS_CAL_ICS_WESTPEEK); row("iCal fallback", "CONFIRMED", `${(ics.match(/BEGIN:VEVENT/g) ?? []).length} VEVENTs`); }
} catch (err) { row("iCal fallback", fail(err), err.message); }

// Meet REST v2
let meetToken = null;
for (const [name, scope] of [["meetings.space.readonly", g.SCOPE.meetRead], ["meetings.space.created", g.SCOPE.meetCreated], ["meetings.space.settings", g.SCOPE.meetSettings]]) {
  try { await g.serviceAccountToken(env, [scope], source.subjectEmail); row(`delegated scope ${name}`, "CONFIRMED"); } catch (err) { row(`delegated scope ${name}`, fail(err), err.message); }
}
try {
  meetToken = await g.serviceAccountToken(env, [g.SCOPE.meetRead], source.subjectEmail);
  const records = await g.listConferenceRecords(meetToken, { pageSize: 25 });
  row("meet v2 conferenceRecords.list", "CONFIRMED", `${records.length} record(s) visible to the partner${records[0] ? `; latest ${records[0].startTime} → ${records[0].endTime ?? "(live)"}` : ""}`);
  const ended = records.find((r) => r.endTime);
  if (ended) {
    const [p, tr, rec] = await Promise.all([g.listParticipants(meetToken, ended.name), g.listTranscripts(meetToken, ended.name), g.listRecordings(meetToken, ended.name)]);
    row("meet v2 participants/transcripts/recordings on the latest ended call", "CONFIRMED", `${p.length} participant(s), ${tr.length} transcript(s) [${tr.map((t) => t.state).join(",")}], ${rec.length} recording(s)`);
    const ready = tr.find((t) => t.state === "FILE_GENERATED");
    if (ready) { const e = await g.listTranscriptEntries(meetToken, ready.name); row("meet v2 transcript entries", "CONFIRMED", `${e.length} entries, ${e.filter((x) => !x.participant).length} unattributed`); }
  } else row("meet v2 participants/transcripts on an ended call", "UNPROVEN", "no ended conference record visible yet — the first real call proves it");
} catch (err) { row("meet v2 conferenceRecords.list", fail(err), err.message); }

// Workspace Events
try {
  const t = await g.serviceAccountToken(env, [g.SCOPE.meetCreated, g.SCOPE.meetRead], source.subjectEmail);
  const subs = await g.listMeetSubscriptions(t);
  const ours = subs.find((s) => s.notificationEndpoint?.pubsubTopic === TOPIC);
  row("workspaceevents subscriptions.list", "CONFIRMED", `${subs.length} Meet subscription(s); ours: ${ours ? `${ours.name} ${ours.state} until ${ours.expireTime}` : "none"}`);
  if (subscribe && !ours) {
    const created = await g.createMeetSubscription(t, source.subjectEmail, TOPIC);
    row("workspaceevents subscriptions.create (user target → Pub/Sub)", "CONFIRMED", `${created.name} until ${created.expireTime ?? "?"}`);
  } else if (subscribe && ours) {
    const renewed = await g.renewMeetSubscription(t, ours.name, 24);
    row("workspaceevents subscriptions.patch (renew)", "CONFIRMED", `${renewed.name} until ${renewed.expireTime ?? "?"}`);
  }
} catch (err) { row(`workspaceevents ${subscribe ? "create/renew" : "list"}`, fail(err), err.message); }

// Pub/Sub, as the service account itself
try {
  const t = await g.serviceAccountToken(env, [g.SCOPE.pubsub], null);
  const msgs = await g.pullPubsub(t, SUBSCRIPTION, 1);
  row("pubsub pull on the firm's subscription (not acked)", "CONFIRMED", `${msgs.length} message(s) waiting`);
} catch (err) { row("pubsub pull", fail(err), err.message); }

const bad = rows.filter((r) => /^(FAILED|SCOPE_MISSING|NOT_CONFIGURED)/.test(r[1]));
console.log(`\n${rows.length} checks · ${bad.length} not confirmed`);
process.exit(bad.length > 0 ? 1 : 0);
