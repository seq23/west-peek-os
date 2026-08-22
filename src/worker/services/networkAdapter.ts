import { z } from "zod";
import type { Env } from "../env";
import { networkOsConfigured, pullSnapshot, type NetworkSnapshot } from "../effects/networkOsClient";
import type { RouteContext } from "../router";
import { json } from "../router";
import type { FirmUserIdentity } from "../auth";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { consumeApprovalCard } from "./approvals";
import { createWorkCardInternal } from "./workCards";

/**
 * Network OS integration (P9).
 *
 * Boundary law (D5 + plan §8/P9):
 * - Network OS is authoritative for contacts, relationship metadata, touches, and
 *   Gmail-derived relationship records. West Peek OS keeps firm work, approvals,
 *   canonical investment company mapping, and its own audit.
 * - There is NO direct cross-repo storage access. The only crossing is a client
 *   injected into these functions (`NetworkOsClient`); with none configured every
 *   live call fails closed as UNPROVEN — CREDENTIAL/INTEGRATION GATE.
 * - Inbound is READ-ONLY and idempotent by delivery key: a duplicate delivery is
 *   recorded as DUPLICATE_IGNORED and changes nothing.
 * - A divergence between an external value and the mapped internal value NEVER
 *   overwrites: it opens a network_conflict plus a resolver WORK CARD for a human.
 * - Outbound writeback is the MP-reserved `network_os.writeback`: it requires an
 *   approved receipt (consumed on use) and always leaves an append-only receipt.
 * - Adapter failure degrades to read-only: cursors record DEGRADED_READ_ONLY /
 *   FAILED with the reason, previously synced mappings stay readable, and West
 *   Peek OS keeps working.
 */

export class NetworkAdapterError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

/** Resources Network OS owns. WP OS never becomes their source of truth. */
export const NETWORK_RESOURCES = ["contact", "relationship", "touch", "gmail_thread"] as const;
export type NetworkResource = (typeof NETWORK_RESOURCES)[number];

/** Every clause the plan requires a declared adapter contract to state. */
export const REQUIRED_CONTRACT_CLAUSES = [
  "source_of_truth",
  "direction",
  "identity_keys",
  "freshness",
  "conflict_behavior",
  "idempotency",
  "retry_behavior",
  "audit_event",
  "failure_state",
] as const;

export interface NetworkRecord {
  external_id: string;
  identity_key: string;
  fields: Record<string, string | null>;
  /** Delivery key from the source system; the idempotency unit for inbound sync. */
  delivery_id?: string;
  provider_version?: string;
}

/**
 * The ONLY way to reach Network OS. Implementations live outside this service and
 * are injected; there is no default client, so an unconfigured deployment cannot
 * accidentally talk to a live system.
 */
export interface NetworkOsClient {
  pull(resource: NetworkResource, cursor: string | null): Promise<{ records: NetworkRecord[]; next_cursor: string | null; provider_version?: string }>;
  push(resource: NetworkResource, record: { external_id: string; fields: Record<string, unknown> }, idempotencyKey: string): Promise<{ ok: boolean; response: unknown }>;
}

function eventActor(actor: Actor): { actorType: "firm_user" | "ai_employee" | "system"; actorId: string } {
  return {
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
  };
}

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectType: string, objectId?: string, firmScope?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, { objectType, objectId, firmScope: firmScope ?? actor.firmScopes[0] ?? "west-peek" });
  if (authz.decision === "DENY") throw new NetworkAdapterError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new NetworkAdapterError(409, "approval_required", authz.reason);
}

// ── Declared contract ──

export interface ContractRow {
  id: string;
  version: number;
  declaration_json: string;
  active: number;
  firm_scope: string;
  declared_by: string;
  created_at: string;
}

/** Declare (and activate) a contract version. Missing clauses are refused. */
export async function declareContract(env: Env, actor: Actor, declaration: Record<string, unknown>): Promise<ContractRow> {
  await mustAuthorize(env, actor, "network_adapter_contract.declare", "network_adapter_contract");
  if (actor.type !== "HUMAN") throw new NetworkAdapterError(403, "forbidden", "an integration contract is declared by a human");
  const missing = REQUIRED_CONTRACT_CLAUSES.filter((clause) => {
    const value = declaration[clause];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
  if (missing.length > 0) {
    throw new NetworkAdapterError(400, "incomplete_contract", `adapter contract is missing required clauses: ${missing.join(", ")}`);
  }
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const latest = await env.WP_OS_DB.prepare("SELECT MAX(version) AS v FROM network_adapter_contract WHERE firm_scope = ?1").bind(firmScope).first<{ v: number | null }>();
  const version = (latest?.v ?? 0) + 1;
  const id = `nac_${crypto.randomUUID()}`;
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare("UPDATE network_adapter_contract SET active = 0 WHERE firm_scope = ?1").bind(firmScope),
    env.WP_OS_DB.prepare(
      "INSERT INTO network_adapter_contract (id, version, declaration_json, active, firm_scope, declared_by) VALUES (?1, ?2, ?3, 1, ?4, ?5)",
    ).bind(id, version, JSON.stringify(declaration), firmScope, actor.firmUserId!),
  ]);
  await appendEvent(env, {
    eventType: "network.contract_declared",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "network_adapter_contract",
    objectId: id,
    firmScope,
    payload: { version, resources: declaration.source_of_truth ?? null },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM network_adapter_contract WHERE id = ?1").bind(id).first<ContractRow>())!;
}

export async function activeContract(env: Env, firmScope: string): Promise<ContractRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM network_adapter_contract WHERE firm_scope = ?1 AND active = 1").bind(firmScope).first<ContractRow>();
}

// ── Cursors ──

async function upsertCursor(
  env: Env,
  firmScope: string,
  resource: string,
  patch: { cursor_value?: string | null; last_sync_at?: string; last_status: string; failure_reason?: string | null },
): Promise<void> {
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM network_sync_cursor WHERE resource = ?1 AND firm_scope = ?2").bind(resource, firmScope).first<{ id: string }>();
  if (existing) {
    await env.WP_OS_DB.prepare(
      `UPDATE network_sync_cursor
          SET cursor_value = COALESCE(?2, cursor_value), last_sync_at = COALESCE(?3, last_sync_at),
              last_status = ?4, failure_reason = ?5, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    )
      .bind(existing.id, patch.cursor_value ?? null, patch.last_sync_at ?? null, patch.last_status, patch.failure_reason ?? null)
      .run();
    return;
  }
  await env.WP_OS_DB.prepare(
    "INSERT INTO network_sync_cursor (id, resource, cursor_value, last_sync_at, last_status, failure_reason, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(`nsc_${crypto.randomUUID()}`, resource, patch.cursor_value ?? null, patch.last_sync_at ?? null, patch.last_status, patch.failure_reason ?? null, firmScope)
    .run();
}

// ── Receipts ──

async function recordReceipt(
  env: Env,
  input: {
    direction: "INBOUND" | "OUTBOUND";
    resource: string;
    external_id?: string | null;
    idempotency_key: string;
    request?: unknown;
    response?: unknown;
    status: "APPLIED" | "DUPLICATE_IGNORED" | "CONFLICT" | "FAILED" | "REFUSED";
    attempt?: number;
    failure_reason?: string | null;
    provider_version?: string | null;
    approval_card_id?: string | null;
    actor_id: string;
    firm_scope: string;
  },
): Promise<string> {
  const id = `nsr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO network_sync_receipt
       (id, direction, resource, external_id, idempotency_key, request_json, response_json, status, attempt, failure_reason, provider_version, approval_card_id, actor_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id,
      input.direction,
      input.resource,
      input.external_id ?? null,
      input.idempotency_key,
      JSON.stringify(input.request ?? {}),
      JSON.stringify(input.response ?? {}),
      input.status,
      input.attempt ?? 1,
      input.failure_reason ?? null,
      input.provider_version ?? null,
      input.approval_card_id ?? null,
      input.actor_id,
      input.firm_scope,
    )
    .run();
  return id;
}

async function receiptExists(env: Env, idempotencyKey: string, firmScope: string): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare("SELECT id FROM network_sync_receipt WHERE idempotency_key = ?1 AND firm_scope = ?2").bind(idempotencyKey, firmScope).first();
  return Boolean(row);
}

// ── Inbound pull (read-only, idempotent, conflict-safe) ──

export interface PullSummary {
  resource: string;
  applied: number;
  duplicates: number;
  conflicts: number;
  status: "OK" | "DEGRADED_READ_ONLY" | "FAILED";
  failure_reason?: string;
  cursor: string | null;
}

/**
 * Pull a resource through the declared adapter. Read-only by construction: it
 * writes mappings, conflicts, and receipts — never a Network OS record, and never
 * an overwrite of an internal value.
 */
/**
 * A FIXTURE PULL MUST NEVER MARK THE LIVE INTEGRATION HEALTHY.
 *
 * Production, read 21 Aug 2026: `network_sync_cursor` said `contact — OK`, while the receipts under
 * it read FAILED ("Network OS rejected the session"), REFUSED (adapter_unconfigured), FAILED again
 * — and `network_external_mapping` held zero rows. The three real attempts were on 17 Aug; the OK
 * was written at 00:57 the next day by a fixture run, which exercises the transform against records
 * posted in the request body and never touches Network OS at all.
 *
 * Both paths shared one cursor, so a test of the mapping code overwrote the record of a live
 * integration that has never once worked, and the only surface reporting on it went green. Nobody
 * looked again for three days.
 *
 * The cursor is a statement about the FAR END. A fixture has nothing to say about the far end, so
 * it now says nothing: it still writes its receipt, still records the event, still reports what it
 * applied, and leaves the cursor exactly as it found it.
 */
export async function pullResource(
  env: Env,
  identity: FirmUserIdentity,
  resource: NetworkResource,
  client: NetworkOsClient | null,
  opts: { isFixture?: boolean } = {},
): Promise<PullSummary> {
  const actor = actorFromIdentity(identity);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  await mustAuthorize(env, actor, "network_sync.pull", "network_sync_cursor", resource, firmScope);

  const contract = await activeContract(env, firmScope);
  if (!contract) throw new NetworkAdapterError(409, "no_active_contract", "declare and activate an adapter contract before syncing");

  if (!client) {
    // No configured client: fail closed, stay read-only, and say so on the cursor.
    if (!opts.isFixture) {
      await upsertCursor(env, firmScope, resource, { last_status: "DEGRADED_READ_ONLY", failure_reason: "adapter_unconfigured" });
    }
    await recordReceipt(env, {
      direction: "INBOUND",
      resource,
      idempotency_key: `pull:${resource}:unconfigured:${crypto.randomUUID()}`,
      status: "REFUSED",
      failure_reason: "adapter_unconfigured",
      actor_id: identity.id,
      firm_scope: firmScope,
    });
    throw new NetworkAdapterError(503, "adapter_unconfigured", "no Network OS client is configured (UNPROVEN — INTEGRATION/CREDENTIAL GATE)");
  }

  const cursorRow = await env.WP_OS_DB.prepare("SELECT cursor_value FROM network_sync_cursor WHERE resource = ?1 AND firm_scope = ?2")
    .bind(resource, firmScope)
    .first<{ cursor_value: string | null }>();

  let page: { records: NetworkRecord[]; next_cursor: string | null; provider_version?: string };
  try {
    page = await client.pull(resource, cursorRow?.cursor_value ?? null);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Bounded, visible failure: previously synced mappings stay readable.
    if (!opts.isFixture) {
      await upsertCursor(env, firmScope, resource, { last_status: "FAILED", failure_reason: reason });
    }
    await recordReceipt(env, {
      direction: "INBOUND",
      resource,
      idempotency_key: `pull:${resource}:failed:${crypto.randomUUID()}`,
      status: "FAILED",
      failure_reason: reason,
      actor_id: identity.id,
      firm_scope: firmScope,
    });
    await appendEvent(env, {
      eventType: "network.sync_failed",
      actorType: "firm_user",
      actorId: identity.id,
      objectType: "network_sync_cursor",
      objectId: resource,
      firmScope,
      payload: { resource, reason, degradation: "read_only" },
    });
    return { resource, applied: 0, duplicates: 0, conflicts: 0, status: "FAILED", failure_reason: reason, cursor: cursorRow?.cursor_value ?? null };
  }

  let applied = 0;
  let duplicates = 0;
  let conflicts = 0;

  for (const record of page.records) {
    const idempotencyKey = `pull:${resource}:${record.delivery_id ?? record.external_id}`;
    if (await receiptExists(env, idempotencyKey, firmScope)) {
      duplicates += 1;
      await recordReceipt(env, {
        direction: "INBOUND",
        resource,
        external_id: record.external_id,
        idempotency_key: `${idempotencyKey}:dup:${crypto.randomUUID()}`,
        status: "DUPLICATE_IGNORED",
        request: { delivery_id: record.delivery_id ?? null },
        actor_id: identity.id,
        firm_scope: firmScope,
      });
      continue;
    }

    const existing = await env.WP_OS_DB.prepare("SELECT * FROM network_external_mapping WHERE resource = ?1 AND external_id = ?2 AND firm_scope = ?3")
      .bind(resource, record.external_id, firmScope)
      .first<{ id: string; snapshot_json: string; internal_type: string | null; internal_id: string | null }>();

    let conflicted = false;
    if (existing) {
      const previous = JSON.parse(existing.snapshot_json) as Record<string, string | null>;
      for (const [field, value] of Object.entries(record.fields)) {
        const internalValue = previous[field];
        // A divergence from what WP OS last observed opens a resolver card. It is
        // never applied over the internal value.
        if (internalValue !== undefined && internalValue !== value) {
          conflicted = true;
          await openConflict(env, identity, {
            resource,
            external_id: record.external_id,
            field,
            external_value: value,
            internal_value: internalValue,
            firm_scope: firmScope,
          });
        }
      }
    }

    if (conflicted) {
      conflicts += 1;
      await recordReceipt(env, {
        direction: "INBOUND",
        resource,
        external_id: record.external_id,
        idempotency_key: idempotencyKey,
        status: "CONFLICT",
        request: { fields: record.fields },
        provider_version: record.provider_version ?? page.provider_version ?? null,
        actor_id: identity.id,
        firm_scope: firmScope,
      });
      continue;
    }

    if (existing) {
      await env.WP_OS_DB.prepare(
        "UPDATE network_external_mapping SET snapshot_json = ?2, identity_key = ?3, last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
        .bind(existing.id, JSON.stringify(record.fields), record.identity_key)
        .run();
    } else {
      await env.WP_OS_DB.prepare(
        "INSERT INTO network_external_mapping (id, resource, external_id, identity_key, snapshot_json, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
        .bind(`nem_${crypto.randomUUID()}`, resource, record.external_id, record.identity_key, JSON.stringify(record.fields), firmScope)
        .run();
    }
    applied += 1;
    await recordReceipt(env, {
      direction: "INBOUND",
      resource,
      external_id: record.external_id,
      idempotency_key: idempotencyKey,
      status: "APPLIED",
      request: { fields: record.fields },
      provider_version: record.provider_version ?? page.provider_version ?? null,
      actor_id: identity.id,
      firm_scope: firmScope,
    });
  }

  // The success case, guarded for the same reason as the failure cases above: a fixture that
  // transformed its own records correctly has proven nothing about Network OS.
  if (!opts.isFixture) {
    await upsertCursor(env, firmScope, resource, {
      cursor_value: page.next_cursor,
      last_sync_at: new Date().toISOString(),
      last_status: "OK",
      failure_reason: null,
    });
  }
  await appendEvent(env, {
    eventType: "network.sync_completed",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "network_sync_cursor",
    objectId: resource,
    firmScope,
    payload: { resource, applied, duplicates, conflicts },
  });
  return { resource, applied, duplicates, conflicts, status: "OK", cursor: page.next_cursor };
}

// ── Conflicts ──

async function openConflict(
  env: Env,
  identity: FirmUserIdentity,
  input: { resource: string; external_id: string; field: string; external_value: string | null; internal_value: string | null; firm_scope: string },
): Promise<string> {
  const open = await env.WP_OS_DB.prepare(
    "SELECT id FROM network_conflict WHERE resource = ?1 AND external_id = ?2 AND field = ?3 AND status = 'OPEN' AND firm_scope = ?4",
  )
    .bind(input.resource, input.external_id, input.field, input.firm_scope)
    .first<{ id: string }>();
  if (open) return open.id;

  const id = `ncf_${crypto.randomUUID()}`;
  // Every conflict gets a human resolver card — divergence is work, not a silent write.
  const card = await createWorkCardInternal(env, identity, {
    title: `Network OS conflict: ${input.resource} ${input.external_id} · ${input.field}`,
    description: `Network OS says "${input.external_value ?? "∅"}", West Peek OS last observed "${input.internal_value ?? "∅"}". Network OS remains authoritative for this record; resolve explicitly.`,
    priority: "HIGH",
    firm_scope: input.firm_scope,
    next_action: "Resolve the divergence (KEEP_EXTERNAL / KEEP_INTERNAL / MANUAL_MERGE)",
  });
  await env.WP_OS_DB.prepare(
    `INSERT INTO network_conflict (id, resource, external_id, field, external_value, internal_value, work_card_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, input.resource, input.external_id, input.field, input.external_value, input.internal_value, card.id, input.firm_scope)
    .run();
  await appendEvent(env, {
    eventType: "network.conflict_opened",
    actorType: "firm_user",
    actorId: identity.id,
    objectType: "network_conflict",
    objectId: id,
    firmScope: input.firm_scope,
    payload: { resource: input.resource, external_id: input.external_id, field: input.field, work_card_id: card.id },
  });
  return id;
}

export async function resolveConflict(
  env: Env,
  actor: Actor,
  conflictId: string,
  resolution: "KEEP_EXTERNAL" | "KEEP_INTERNAL" | "MANUAL_MERGE",
  note?: string,
) {
  const conflict = await env.WP_OS_DB.prepare("SELECT * FROM network_conflict WHERE id = ?1").bind(conflictId).first<{
    id: string;
    resource: string;
    external_id: string;
    field: string;
    external_value: string | null;
    status: string;
    firm_scope: string;
  }>();
  if (!conflict) throw new NetworkAdapterError(404, "not_found");
  if (actor.type !== "HUMAN") throw new NetworkAdapterError(403, "forbidden", "conflict resolution is human-reserved");
  await mustAuthorize(env, actor, "network_conflict.resolve", "network_conflict", conflictId, conflict.firm_scope);
  if (conflict.status !== "OPEN") throw new NetworkAdapterError(409, "already_resolved");

  await env.WP_OS_DB.prepare(
    "UPDATE network_conflict SET status = 'RESOLVED', resolution = ?2, resolution_note = ?3, resolved_by = ?4, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(conflictId, resolution, note ?? null, actor.firmUserId!)
    .run();

  // KEEP_EXTERNAL is the only path that updates the observed snapshot, and even
  // then it only records what Network OS (the owner) says.
  if (resolution === "KEEP_EXTERNAL") {
    const mapping = await env.WP_OS_DB.prepare("SELECT * FROM network_external_mapping WHERE resource = ?1 AND external_id = ?2 AND firm_scope = ?3")
      .bind(conflict.resource, conflict.external_id, conflict.firm_scope)
      .first<{ id: string; snapshot_json: string }>();
    if (mapping) {
      const snapshot = JSON.parse(mapping.snapshot_json) as Record<string, string | null>;
      snapshot[conflict.field] = conflict.external_value;
      await env.WP_OS_DB.prepare("UPDATE network_external_mapping SET snapshot_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
        .bind(mapping.id, JSON.stringify(snapshot))
        .run();
    }
  }
  await appendEvent(env, {
    eventType: "network.conflict_resolved",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "network_conflict",
    objectId: conflictId,
    firmScope: conflict.firm_scope,
    payload: { resolution, resource: conflict.resource, external_id: conflict.external_id, field: conflict.field },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM network_conflict WHERE id = ?1").bind(conflictId).first();
}

// ── Outbound writeback (MP-reserved, receipted, audited) ──

export async function writeBack(
  env: Env,
  actor: Actor,
  input: { resource: NetworkResource; external_id: string; fields: Record<string, unknown>; approval_receipt_id?: string },
  client: NetworkOsClient | null,
) {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(
    env,
    actor,
    "network_os.writeback",
    { objectType: "network_external_mapping", objectId: input.external_id, firmScope },
    { receiptId: input.approval_receipt_id },
  );
  if (authz.decision === "DENY") throw new NetworkAdapterError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") {
    await recordReceipt(env, {
      direction: "OUTBOUND",
      resource: input.resource,
      external_id: input.external_id,
      idempotency_key: `push:${input.resource}:${input.external_id}:refused:${crypto.randomUUID()}`,
      status: "REFUSED",
      failure_reason: "approval_required",
      actor_id: actor.firmUserId ?? "system",
      firm_scope: firmScope,
    });
    throw new NetworkAdapterError(409, "approval_required", authz.reason);
  }

  const idempotencyKey = `push:${input.resource}:${input.external_id}:${authz.receiptId}`;
  if (await receiptExists(env, idempotencyKey, firmScope)) {
    throw new NetworkAdapterError(409, "duplicate_writeback", "this writeback was already delivered under the same receipt");
  }

  if (!client) {
    await recordReceipt(env, {
      direction: "OUTBOUND",
      resource: input.resource,
      external_id: input.external_id,
      idempotency_key: idempotencyKey,
      status: "REFUSED",
      failure_reason: "adapter_unconfigured",
      approval_card_id: authz.receiptId ?? null,
      actor_id: actor.firmUserId!,
      firm_scope: firmScope,
    });
    throw new NetworkAdapterError(503, "adapter_unconfigured", "no Network OS client is configured (UNPROVEN — INTEGRATION/CREDENTIAL GATE)");
  }

  let response: { ok: boolean; response: unknown };
  try {
    response = await client.push(input.resource, { external_id: input.external_id, fields: input.fields }, idempotencyKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordReceipt(env, {
      direction: "OUTBOUND",
      resource: input.resource,
      external_id: input.external_id,
      idempotency_key: `${idempotencyKey}:failed:${crypto.randomUUID()}`,
      status: "FAILED",
      failure_reason: reason,
      approval_card_id: authz.receiptId ?? null,
      actor_id: actor.firmUserId!,
      firm_scope: firmScope,
    });
    // The receipt is NOT consumed on failure — the human authorization survives a retry.
    throw new NetworkAdapterError(502, "writeback_failed", reason);
  }

  const receiptRowId = await recordReceipt(env, {
    direction: "OUTBOUND",
    resource: input.resource,
    external_id: input.external_id,
    idempotency_key: idempotencyKey,
    status: "APPLIED",
    request: { fields: input.fields },
    response: response.response,
    approval_card_id: authz.receiptId ?? null,
    actor_id: actor.firmUserId!,
    firm_scope: firmScope,
  });
  await consumeApprovalCard(env, authz.receiptId!, { actorId: actor.firmUserId! });
  const { actorType, actorId } = eventActor(actor);
  await appendEvent(env, {
    eventType: "network.writeback_executed",
    actorType,
    actorId,
    objectType: "network_sync_receipt",
    objectId: receiptRowId,
    firmScope,
    payload: { resource: input.resource, external_id: input.external_id, approval_card_id: authz.receiptId ?? null },
  });
  return env.WP_OS_DB.prepare("SELECT * FROM network_sync_receipt WHERE id = ?1").bind(receiptRowId).first();
}

// ── HTTP handlers ──
// No client is wired into the HTTP layer: live integration is a named human gate,
// so every live call over HTTP answers 503 adapter_unconfigured by construction.

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof NetworkAdapterError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

/**
 * Resolved from configuration (P35).
 *
 * Until this was written it returned null unconditionally, so every live call answered 503
 * "adapter_unconfigured" by construction — which read like a credential gate and was actually an
 * unwritten client. It now returns a real read-only client once the three Network OS settings are
 * present, and still null (hence still 503, with a precise reason) when they are not.
 *
 * PULL ONLY. push() throws. Writeback to the firm's system of record is governed separately by
 * canon §12A.5 and must not ride in on a read integration.
 */
export function configuredClient(env: Env): NetworkOsClient | null {
  if (!networkOsConfigured(env)) return null;
  return {
    async pull(resource: NetworkResource) {
      const result = await pullSnapshot(env);
      if (!result.ok || !result.snapshot) throw new Error(result.detail);
      const rows = resourceRows(result.snapshot, resource);
      return {
        // Network OS returns a whole snapshot rather than a paged feed, so a cursor would be
        // fiction. One page, no next_cursor — honest about what the source actually offers.
        records: rows.map((row) => toNetworkRecord(resource, row)),
        next_cursor: null,
        provider_version: result.source ?? "network_os_snapshot",
      };
    },
    async push() {
      throw new Error("Network OS writeback is not enabled (canon §12A.5 governs it separately).");
    },
  };
}

/** Which snapshot tab backs each resource. */
function resourceRows(snapshot: NetworkSnapshot, resource: NetworkResource): Array<Record<string, unknown>> {
  switch (resource) {
    case "contact": return snapshot.contacts;
    case "relationship": return snapshot.relationship_touches;
    case "touch": return snapshot.relationship_touches;
    // gmail_thread has no tab in the snapshot; an empty page is honest, an error would imply the
    // resource is broken rather than simply not carried by this endpoint.
    default: return [];
  }
}

const ID_FIELD: Record<string, string> = {
  contact: "contact_id",
  relationship: "touch_id",
  touch: "touch_id",
};

/**
 * Flatten a Sheets row into the adapter's record shape. Every value is stringified because a
 * spreadsheet has no types — pretending otherwise here would push the ambiguity downstream into
 * identity resolution, where a number-shaped id and a string-shaped id stop matching.
 */
function toNetworkRecord(resource: NetworkResource, row: Record<string, unknown>): NetworkRecord {
  const idField = ID_FIELD[resource] ?? "contact_id";
  const externalId = String(row[idField] ?? "").trim();
  const fields: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(row)) {
    fields[k] = v === null || v === undefined || v === "" ? null : String(v);
  }
  return {
    external_id: externalId,
    // Email is the identity key where there is one: it is the field the firm actually dedupes
    // people on. Falling back to the row id keeps a record without an email syncable rather than
    // dropping it silently.
    identity_key: String(row.email ?? row.primary_email ?? externalId).trim().toLowerCase(),
    fields,
    delivery_id: `${externalId}:${String(row.updated_at ?? row.created_at ?? "")}`,
  };
}

/**
 * LOCAL-ONLY fixture client, mirroring the local dev-identity header: it exists so
 * the conflict-resolver journey can be exercised in a browser with NO live system.
 * Refused outside `WP_OS_ENV === "local"`, and every record it returns is stamped
 * `LOCAL_FIXTURE` on the receipt so a fixture sync can never be mistaken for
 * provider proof (the live integration stays UNPROVEN — INTEGRATION APPROVAL GATE).
 */
export function localFixtureClient(env: Env, records: NetworkRecord[]): NetworkOsClient | null {
  if (env.WP_OS_ENV !== "local") return null;
  return {
    async pull() {
      return { records, next_cursor: null, provider_version: "LOCAL_FIXTURE" };
    },
    async push() {
      throw new Error("local fixture client cannot write back");
    },
  };
}

const contractSchema = z.object({
  source_of_truth: z.record(z.unknown()),
  direction: z.string().trim().min(1),
  identity_keys: z.record(z.unknown()),
  freshness: z.string().trim().min(1),
  conflict_behavior: z.string().trim().min(1),
  idempotency: z.string().trim().min(1),
  retry_behavior: z.string().trim().min(1),
  audit_event: z.string().trim().min(1),
  failure_state: z.string().trim().min(1),
  notes: z.string().optional(),
});

export async function handleDeclareContract(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = contractSchema.partial().safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await declareContract(ctx.env, actorFromIdentity(ctx.identity!), parsed.data as Record<string, unknown>), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetContract(ctx: RouteContext): Promise<Response> {
  const scopes = ctx.identity!.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  const firmScope = scopes[0] ?? "west-peek";
  const contract = await activeContract(ctx.env, firmScope);
  const history = await ctx.env.WP_OS_DB.prepare("SELECT id, version, active, declared_by, created_at FROM network_adapter_contract WHERE firm_scope = ?1 ORDER BY version DESC")
    .bind(firmScope)
    .all();
  return json({
    active: contract,
    versions: history.results ?? [],
    required_clauses: REQUIRED_CONTRACT_CLAUSES,
    integration_state: "UNPROVEN — INTEGRATION APPROVAL GATE (no Network OS client configured)",
  });
}

const fixtureRecordSchema = z.object({
  external_id: z.string().trim().min(1),
  identity_key: z.string().trim().min(1),
  delivery_id: z.string().optional(),
  fields: z.record(z.union([z.string(), z.null()])),
});

export async function handlePullResource(ctx: RouteContext): Promise<Response> {
  const resource = ctx.params.resource as NetworkResource;
  if (!(NETWORK_RESOURCES as readonly string[]).includes(resource)) {
    return json({ error: "unknown_resource", detail: `resource must be one of ${NETWORK_RESOURCES.join(", ")}` }, { status: 400 });
  }
  const body = await parseJsonBody(ctx.request);
  const fixture = z.object({ fixture_records: z.array(fixtureRecordSchema).min(1) }).safeParse(body ?? {});
  // Local fixture path (see localFixtureClient): never available outside local mode.
  const client = fixture.success ? localFixtureClient(ctx.env, fixture.data.fixture_records) : configuredClient(ctx.env);
  try {
    const summary = await pullResource(ctx.env, ctx.identity!, resource, client, { isFixture: fixture.success });
    return json({ ...summary, provider: fixture.success ? "LOCAL_FIXTURE" : "LIVE" }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListSyncState(ctx: RouteContext): Promise<Response> {
  const cursors = await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_sync_cursor ORDER BY resource").all();
  const receipts = await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_sync_receipt ORDER BY created_at DESC, id LIMIT 200").all();
  return json({ cursors: cursors.results ?? [], receipts: receipts.results ?? [] });
}

export async function handleListMappings(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const resource = url.searchParams.get("resource");
  const rows = resource
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_external_mapping WHERE resource = ?1 ORDER BY last_seen_at DESC, id LIMIT 500").bind(resource).all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_external_mapping ORDER BY last_seen_at DESC, id LIMIT 500").all();
  return json({ mappings: rows.results ?? [] });
}

export async function handleListConflicts(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_conflict WHERE status = ?1 ORDER BY created_at DESC, id").bind(status).all()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM network_conflict ORDER BY created_at DESC, id LIMIT 500").all();
  return json({ conflicts: rows.results ?? [] });
}

const resolveSchema = z.object({ resolution: z.enum(["KEEP_EXTERNAL", "KEEP_INTERNAL", "MANUAL_MERGE"]), note: z.string().optional() });

export async function handleResolveConflict(ctx: RouteContext): Promise<Response> {
  const parsed = resolveSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await resolveConflict(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.resolution, parsed.data.note));
  } catch (err) {
    return errorResponse(err);
  }
}

const writebackSchema = z.object({
  resource: z.enum(NETWORK_RESOURCES),
  external_id: z.string().trim().min(1),
  fields: z.record(z.unknown()),
  approval_receipt_id: z.string().trim().min(1).optional(),
});

export async function handleWriteBack(ctx: RouteContext): Promise<Response> {
  const parsed = writebackSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await writeBack(ctx.env, actorFromIdentity(ctx.identity!), parsed.data, configuredClient(ctx.env)), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
