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
