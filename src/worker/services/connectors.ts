import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize, privacyVisibilityClause } from "./authorize";

/**
 * External connector status + meeting prep queue (P22; GAP-16, GAP-17).
 *
 * P9 built the Network OS adapter contract and P7 built the meeting substrate. This module adds
 * the thing an operator actually needs to see: WHAT is connected, WHAT it would need, and WHAT
 * gate stands in front of it.
 *
 * Two rules the code enforces rather than describes:
 * - A check reports credential PRESENCE by name and never a value, and can only ever be
 *   LOCAL_FIXTURE here: nothing in this environment can reach an external system.
 * - Nothing in this module writes to Network OS, a calendar, a mailbox, a VDR, or an
 *   administrator. It is a read-only status surface over West Peek's own records.
 */

function credentialConfigured(env: Env, name: string | null): boolean {
  if (!name) return false;
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0;
}

export async function handleListConnectors(ctx: RouteContext): Promise<Response> {
  const connectors = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM connector ORDER BY kind, connector_key").all<{
      id: string;
      connector_key: string;
      name: string;
      kind: string;
      owns: string;
      direction: string;
      credential_name: string | null;
      scopes_json: string;
      consent_required: number;
      approval_gate: string;
      status: string;
      detail: string;
      last_checked_at: string | null;
    }>()
  ).results ?? [];

  // Network OS gets its live sync facts from the P9 substrate, not from a duplicate store.
  const contract = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM network_adapter_contract ORDER BY created_at DESC LIMIT 1",
  ).first<{ version: number; created_at: string }>();
  const cursors = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_sync_cursor").all()).results ?? [];
  const conflicts = await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM network_conflict WHERE status = 'OPEN'").first<{ n: number }>();
  const mappings = await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM network_external_mapping").first<{ n: number }>();

  return json({
    connectors: connectors.map((c) => ({
      ...c,
      credential_configured: credentialConfigured(ctx.env, c.credential_name),
      scopes: JSON.parse(c.scopes_json) as string[],
    })),
    network_os: {
      contract_declared: contract !== null,
      contract_version: contract?.version ?? null,
      sync_cursors: cursors,
      open_conflicts: conflicts?.n ?? 0,
      mapped_records: mappings?.n ?? 0,
      authority: "Network OS is authoritative for contacts, relationships, and touches. West Peek OS never overwrites it: writeback is a proposal behind the MP-reserved network_os.writeback receipt.",
    },
    rules: {
      credentials: "Status reports whether a secret NAME is populated. No secret value is read, returned, or logged.",
      checks: "Only LOCAL_FIXTURE checks are possible here. They verify configuration coherence, never reachability.",
      writes: "This surface performs no external writes of any kind.",
    },
  });
}

/**
 * Check a connector's configuration. LOCAL_FIXTURE only: it verifies that the credential name is
 * populated, that required scopes are declared, and that the gate in front of it is recorded.
 * It contacts nothing.
 */
export async function handleCheckConnector(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "connector.check", { objectType: "connector", objectId: ctx.params.key! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const connector = await ctx.env.WP_OS_DB.prepare("SELECT * FROM connector WHERE connector_key = ?1")
    .bind(ctx.params.key!)
    .first<{ id: string; connector_key: string; kind: string; credential_name: string | null; scopes_json: string; consent_required: number; approval_gate: string }>();
  if (!connector) return json({ error: "not_found" }, { status: 404 });

  const problems: string[] = [];
  if (!connector.credential_name) problems.push("no credential name is declared");
  else if (!credentialConfigured(ctx.env, connector.credential_name)) problems.push(`${connector.credential_name} is not populated in this environment`);
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(connector.scopes_json) as string[];
  } catch {
    scopes = [];
  }
  if (scopes.length === 0) problems.push("no scopes are declared");
  if (connector.consent_required === 1) problems.push("counterparty consent is required and is recorded per meeting, not per connector");

  // Network OS additionally needs its declared adapter contract before any pull is legitimate.
  if (connector.kind === "NETWORK_OS") {
    const contract = await ctx.env.WP_OS_DB.prepare("SELECT id FROM network_adapter_contract LIMIT 1").first();
    if (!contract) problems.push("no adapter contract has been declared (P9)");
  }

  const ok = problems.length === 0;
  const status = ok ? "CONFIGURED" : "NOT_CONFIGURED";
  const detail = ok
    ? "LOCAL_FIXTURE: configuration is coherent. This is NOT evidence that the external system is reachable — nothing was contacted."
    : `LOCAL_FIXTURE: ${problems.join("; ")}. Nothing was contacted.`;

  await ctx.env.WP_OS_DB.prepare("UPDATE connector SET status = ?2, detail = ?3, last_checked_at = ?4 WHERE id = ?1")
    .bind(connector.id, status, detail, new Date().toISOString())
    .run();
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO connector_check (id, connector_id, mode, ok, detail, checked_by) VALUES (?1, ?2, 'LOCAL_FIXTURE', ?3, ?4, ?5)",
  )
    .bind(`ccheck_${crypto.randomUUID()}`, connector.id, ok ? 1 : 0, detail, ctx.identity!.id)
    .run();

  return json({ connector_key: connector.connector_key, mode: "LOCAL_FIXTURE", ok, status, problems, detail }, { status: 201 });
}

/**
 * The meeting prep queue (GAP-17). Upcoming scheduled meetings with what actually exists for
 * each: a prep packet, consent, an activated recording policy, and a transcript. Every gate is
 * reported as a fact from the P7 substrate rather than as an intention.
 */
export async function handleMeetingPrepQueue(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "m.privacy_label");
  const now = new Date().toISOString();
  const meetings = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT m.id, m.title, m.meeting_type, m.scheduled_at, m.company_id, m.recording_enabled, c.canonical_name,
              (SELECT COUNT(*) FROM meeting_prep_packet p WHERE p.meeting_id = m.id) AS prep_packets,
              (SELECT COUNT(*) FROM consent_record cr WHERE cr.meeting_id = m.id AND cr.state = 'GRANTED') AS consents_granted,
              (SELECT COUNT(*) FROM transcript_import ti WHERE ti.meeting_id = m.id) AS transcripts,
              (SELECT COUNT(*) FROM meeting_participant mp WHERE mp.meeting_id = m.id) AS participants
         FROM meeting m
         LEFT JOIN canonical_company c ON c.id = m.company_id
        WHERE m.status = 'SCHEDULED' AND m.scheduled_at IS NOT NULL AND m.scheduled_at >= ?1 AND ${visibility}
        ORDER BY m.scheduled_at
        LIMIT 50`,
    )
      .bind(now)
      .all<{
        id: string;
        title: string;
        meeting_type: string;
        scheduled_at: string;
        company_id: string | null;
        canonical_name: string | null;
        recording_enabled: number;
        prep_packets: number;
        consents_granted: number;
        transcripts: number;
        participants: number;
      }>()
  ).results ?? [];

  const calendar = await ctx.env.WP_OS_DB.prepare("SELECT status, detail FROM connector WHERE connector_key = 'calendar'").first<{ status: string; detail: string }>();
  const transcription = await ctx.env.WP_OS_DB.prepare("SELECT status, detail FROM connector WHERE connector_key = 'transcription'").first<{ status: string; detail: string }>();

  return json({
    queue: meetings.map((m) => ({
      ...m,
      needs_prep: m.prep_packets === 0,
      recording_state:
        m.recording_enabled === 1
          ? m.consents_granted > 0
            ? "policy activated and consent granted"
            : "policy activated but NO consent granted — transcription is refused (P7)"
          : "no recording policy activated (MP/compliance-reserved)",
    })),
    calendar_connector: calendar,
    transcription_connector: transcription,
    note:
      "This queue is built from meetings recorded in West Peek OS. No calendar is connected, so it reflects what the firm entered, not an external diary.",
  });
}

/**
 * Each partner's own mailbox and calendar, and what is stopping them working.
 *
 * WHY THIS IS SEPARATE from the connector registry. That register is firm-scoped: it declares that
 * this firm intends to have email, what it owns, which approval gates apply. A mailbox belongs to a
 * person — Scooter connecting his calendar says nothing about Sequoia's — so the connection itself
 * is per firm_user, and a single firm-level "connected" flag would claim otherwise.
 *
 * IT REPORTS WHAT IS MISSING RATHER THAN JUST 'NOT CONFIGURED'. A partner clicking Connect and
 * getting a shrug is the failure this endpoint exists to prevent: the blocker is usually a
 * credential nobody has created yet, and only the operator can create it. Saying which one turns a
 * dead end into a task.
 */
export async function handlePartnerConnections(ctx: RouteContext): Promise<Response> {
  const me = ctx.identity!;

  // FIRM SENDING AND A PARTNER'S MAILBOX ARE DIFFERENT CAPABILITIES, and this endpoint used to
  // report only the second. Outbound email went live through Resend and Home still said email was
  // not connected — true of the mailbox, false of the thing the operator had just switched on, and
  // indistinguishable from nothing having worked.
  //
  // Sending is firm-level: the OS sends AS the firm, from one configured address, and every message
  // is human-approved. A mailbox is personal: reading your inbox and sending as you. One being live
  // says nothing about the other, so they are reported separately.
  const sendingFrom = ctx.env.WP_OS_EMAIL_FROM ?? null;
  const sendingOn = ctx.env.WP_OS_EMAIL_SEND === "enabled";
  const hasTransport = Boolean(ctx.env.RESEND_API_KEY) || Boolean(ctx.env.EMAIL);
  const sending = {
    live: sendingOn && hasTransport && Boolean(sendingFrom),
    from: sendingFrom,
    provider: ctx.env.EMAIL ? "cloudflare" : ctx.env.RESEND_API_KEY ? "resend" : null,
    detail:
      sendingOn && hasTransport && Boolean(sendingFrom)
        ? `Approved messages go out as ${sendingFrom}. Every one still needs a human decision first.`
        : !hasTransport
          ? "No transport is configured, so approved messages are recorded rather than sent."
          : !sendingFrom
            ? "No sending address is set, so approved messages are recorded rather than sent."
            : "Sending is switched off, so approved messages are recorded rather than sent.",
  };

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT c.connector_key, c.name, c.kind, c.direction, c.status AS registry_status,
            c.credential_name, c.consent_required, c.approval_gate,
            pc.id AS connection_id, pc.status AS connection_status, pc.account_label,
            pc.connected_at, pc.last_error, pc.scopes_json
       FROM connector c
       LEFT JOIN partner_connection pc
         ON pc.connector_key = c.connector_key AND pc.firm_user_id = ?1
      WHERE c.connector_key IN ('email', 'calendar')
      ORDER BY c.connector_key`,
  )
    .bind(me.id)
    .all<Record<string, unknown>>();

  // Which credentials the environment actually holds. Names only — a value never leaves the vault,
  // and this endpoint answers "can this work", not "what is the secret".
  const configured = new Set<string>();
  for (const [name, present] of [
    ["GOOGLE_OAUTH_CLIENT_ID", Boolean((ctx.env as unknown as Record<string, unknown>).GOOGLE_OAUTH_CLIENT_ID)],
    ["GOOGLE_OAUTH_CLIENT_SECRET", Boolean((ctx.env as unknown as Record<string, unknown>).GOOGLE_OAUTH_CLIENT_SECRET)],
  ] as const) {
    if (present) configured.add(name);
  }
  const googleReady = configured.has("GOOGLE_OAUTH_CLIENT_ID") && configured.has("GOOGLE_OAUTH_CLIENT_SECRET");

  const connections = (rows.results ?? []).map((r) => {
    const status = String(r.connection_status ?? "DISCONNECTED");
    return {
      connector_key: r.connector_key,
      name: r.name,
      direction: r.direction,
      status,
      account_label: r.account_label ?? null,
      connected_at: r.connected_at ?? null,
      last_error: r.last_error ?? null,
      /**
       * Can a partner press Connect and have anything happen?
       *
       * CALENDAR CAN; A MAILBOX CANNOT, and saying otherwise was a real defect: both rows offered a
       * Connect button, both ran the same Google flow, and that flow requests calendar scopes only.
       * Pressing Connect on the mailbox row therefore granted calendar access, marked CALENDAR
       * connected, and left the mailbox row exactly as it was — so the button did nothing, twice,
       * and looked broken rather than absent.
       */
      connectable: r.connector_key === "calendar" && googleReady,
      blocked_by:
        r.connector_key !== "calendar"
          ? "Reading your own inbox is not built. The firm can already SEND approved email without this — that is a separate thing and it is already on."
          : googleReady
            ? null
            : "Google OAuth is not configured for this firm — GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set.",
      what_it_unlocks:
        r.connector_key === "calendar"
          ? "Your morning brief opens with what you are walking into, and meeting prep happens without being asked for."
          : "Nothing yet. Sending approved email as the firm already works and needs no connection here.",
    };
  });

  return json({
    partner: { id: me.id, name: me.fullName, email: me.email },
    sending,
    connections,
    google_ready: googleReady,
    /** Stated so the screen never has to guess at the setup path. */
    setup:
      googleReady
        ? null
        : {
            what: "A Google Cloud OAuth client for West Peek, with Gmail and Calendar enabled.",
            then: "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET as Worker secrets.",
            note: "One client covers both partners; each still connects their own account separately.",
          },
  });
}
