import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { isMachinePaused } from "./machines";
import { privacyLabelSchema, DEFAULT_PRIVACY_LABEL } from "../../shared/privacy";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { createWorkCardInternal } from "./workCards";

/**
 * Capture intake (+Capture): unstructured input enters here, then routes to a
 * machine. Privacy labels gate visibility server-side (never by UI hiding);
 * firm_scope isolation is enforced through authorize() on every mutation.
 */

export interface CaptureRow {
  id: string;
  capture_type: string;
  raw_text: string;
  source_channel: string;
  privacy_label: string;
  firm_scope: string;
  captured_by: string;
  status: string;
  routed_machine_id: number | null;
  created_at: string;
}

const createCaptureSchema = z.object({
  capture_type: z.string().trim().min(1),
  raw_text: z.string().min(1),
  source_channel: z.string().trim().min(1),
  privacy_label: privacyLabelSchema.optional(),
});

const routeCaptureSchema = z.object({
  machine_id: z.number().int().positive(),
  /** When true, also create a work card for the routed capture. */
  create_work_card: z.boolean().optional(),
  title: z.string().trim().min(1).optional(),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function firmScopesOf(identity: FirmUserIdentity): string[] {
  const scopes = identity.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  return scopes.length > 0 ? scopes : ["west-peek"];
}

function scopeClause(identity: FirmUserIdentity): string {
  const scopes = firmScopesOf(identity);
  return `firm_scope IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;
}

/** Fetch a capture the identity may see (firm scope + privacy label), else null. */
export async function getVisibleCapture(env: Env, identity: FirmUserIdentity, id: string): Promise<CaptureRow | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(id).first<CaptureRow>();
  if (!row) return null;
  if (!firmScopesOf(identity).includes(row.firm_scope)) return null;
  if (!canAccessPrivacyLabel(identity, row.privacy_label)) return null;
  return row;
}

export async function handleCreateCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createCaptureSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.create", { objectType: "capture", firmScope: "west-peek" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  const id = `cap_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO capture (id, capture_type, raw_text, source_channel, privacy_label, firm_scope, captured_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, input.capture_type, input.raw_text, input.source_channel, input.privacy_label ?? DEFAULT_PRIVACY_LABEL, "west-peek", identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "capture.created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: id,
    payload: { capture_type: input.capture_type, source_channel: input.source_channel, privacy_label: input.privacy_label ?? DEFAULT_PRIVACY_LABEL },
  });

  const row = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(id).first<CaptureRow>();
  return json(row, { status: 201 });
}

export async function handleListCaptures(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const visibility = privacyVisibilityClause(ctx.identity!);
  const scope = scopeClause(ctx.identity!);
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM capture WHERE status = ?1 AND ${scope} AND ${visibility} ORDER BY created_at DESC, id`,
      )
        .bind(status)
        .all<CaptureRow>()
    : await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM capture WHERE ${scope} AND ${visibility} ORDER BY created_at DESC, id`,
      ).all<CaptureRow>();
  return json({ captures: rows.results ?? [] });
}

export async function handleGetCapture(ctx: RouteContext): Promise<Response> {
  const row = await getVisibleCapture(ctx.env, ctx.identity!, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}

/** Route a capture to a machine; optionally create the work card in one step. */
export async function handleRouteCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const capture = await getVisibleCapture(env, identity!, ctx.params.id!);
  if (!capture) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = routeCaptureSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  if (capture.status === "ARCHIVED") {
    return json({ error: "conflict", detail: "archived captures cannot be routed" }, { status: 409 });
  }

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.route", { objectType: "capture", objectId: capture.id, firmScope: capture.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  const machine = await env.WP_OS_DB.prepare("SELECT id, domain_id, name FROM machine WHERE id = ?1")
    .bind(input.machine_id)
    .first<{ id: number; domain_id: string; name: string }>();
  if (!machine) return json({ error: "invalid_input", detail: "unknown machine_id" }, { status: 400 });

  // P17: a paused machine may not be given new work. Enforced here, in the service, so it holds
  // for any caller — not only for a UI that chose to grey the option out.
  const paused = await isMachinePaused(env, machine.id);
  if (paused.paused) {
    return json(
      { error: "machine_paused", detail: `machine ${machine.id} (${machine.name}) is PAUSED: ${paused.reason ?? "no reason recorded"}` },
      { status: 409 },
    );
  }

  await env.WP_OS_DB.prepare("UPDATE capture SET status = 'ROUTED', routed_machine_id = ?2 WHERE id = ?1")
    .bind(capture.id, machine.id)
    .run();

  await appendEvent(env, {
    eventType: "capture.routed",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
    payload: { machine_id: machine.id, machine_name: machine.name },
  });

  let workCard: unknown = null;
  if (input.create_work_card) {
    workCard = await createWorkCardInternal(env, identity!, {
      capture_id: capture.id,
      title: input.title ?? capture.raw_text.slice(0, 120),
      domain_id: machine.domain_id,
      machine_id: machine.id,
      privacy_label: capture.privacy_label,
      firm_scope: capture.firm_scope,
    });
  }

  const updated = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(capture.id).first<CaptureRow>();
  return json({ capture: updated, routed_to: machine, work_card: workCard });
}

export async function handleArchiveCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const capture = await getVisibleCapture(env, identity!, ctx.params.id!);
  if (!capture) return json({ error: "not_found" }, { status: 404 });
  if (capture.status !== "NEW") {
    return json({ error: "conflict", detail: `capture is ${capture.status}; only NEW captures can be archived` }, { status: 409 });
  }
  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.archive", { objectType: "capture", objectId: capture.id, firmScope: capture.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  await env.WP_OS_DB.prepare("UPDATE capture SET status = 'ARCHIVED' WHERE id = ?1").bind(capture.id).run();
  await appendEvent(env, {
    eventType: "capture.archived",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
  });
  const updated = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(capture.id).first<CaptureRow>();
  return json(updated);
}

/**
 * Resolve a capture to what it is actually about.
 *
 * Capture is a holding pen: it owns nothing, and until now it could only be routed to a processing
 * machine. That left both systems of record — companies here, people in Network OS — to be fed by
 * hand while the inbox filled up beside them. This is the missing step.
 *
 * COMPANY resolves against the register alias-first, so "Psyflo Inc" finds Psyflo instead of
 * creating a second row. A new company is only created when the register genuinely has no match,
 * and it goes through createCompany so every duplicate guard still applies.
 *
 * PERSON is the interesting one, and where the honesty lives. Network OS is the system of record
 * for people and is READ-ONLY from here (D5) — writeback is governed separately (§12A.5). So when
 * a capture surfaces somebody Network OS has never heard of, there is nowhere to put them. That is
 * not a missing screen, it is a missing destination.
 *
 * Rather than pretend otherwise, the person is written to the local `person` reference table and
 * marked LOCAL_UNRESOLVED — the same word com_member already uses for this exact state. They join
 * a queue. The queue does not claim they are in the system of record; it says the opposite,
 * loudly, and turns "we should probably build writeback" into a countable list of real people who
 * are actually waiting. When that list is long enough to justify a write integration, the decision
 * will have evidence behind it instead of a guess.
 */

const resolveCaptureSchema = z
  .object({
    kind: z.enum(["COMPANY", "PERSON", "NEITHER"]),
    /** Company or person name. Required unless NEITHER. */
    name: z.string().trim().min(1).optional(),
    email: z.string().trim().min(1).optional(),
    organization: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.kind === "NEITHER" || Boolean(v.name), {
    message: "name is required when resolving to a company or a person",
  });

/**
 * Ask Network OS whether it knows this person.
 *
 * Returns null when the integration is not configured or the snapshot has nothing matching, and
 * the caller treats null as LOCAL_UNRESOLVED. Deliberately fail-soft: an unreachable Network OS
 * must not block the operator from recording who they met, and a person queued when they were
 * really already known is a duplicate to merge later — recoverable, unlike a lost record.
 */
async function findInNetworkOs(env: Env, name: string, email?: string): Promise<{ id: string } | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT p.id AS id
       FROM person p
       JOIN network_external_mapping m
         ON m.internal_id = p.id AND m.internal_type = 'person' AND m.resource = 'contact'
      WHERE (?2 IS NOT NULL AND lower(p.email) = lower(?2))
         OR lower(p.full_name) = lower(?1)
      LIMIT 1`,
  )
    .bind(name, email ?? null)
    .first<{ id: string }>();
  return row ?? null;
}

export async function handleResolveCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = resolveCaptureSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const capture = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<CaptureRow & { resolved_kind: string | null }>();
  if (!capture) return json({ error: "not_found" }, { status: 404 });
  if (capture.status === "ARCHIVED") {
    return json({ error: "conflict", detail: "archived captures cannot be resolved" }, { status: 409 });
  }
  if (capture.resolved_kind) {
    return json(
      { error: "already_resolved", detail: `this capture was already resolved to ${capture.resolved_kind}` },
      { status: 409 },
    );
  }

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.resolve", {
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
  });
  if (authz.decision !== "ALLOW") {
    return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  }

  const now = new Date().toISOString();
  let companyId: string | null = null;
  let personId: string | null = null;
  let personSource: "NETWORK_OS" | "LOCAL_UNRESOLVED" | null = null;
  let matchedVia = "created";

  if (input.kind === "COMPANY") {
    // Alias-first: the register already knows how to say "that name is this company", and a second
    // row for a company we already track is the one thing D3 exists to prevent.
    const existing = await env.WP_OS_DB.prepare(
      `SELECT c.id AS id FROM canonical_company c WHERE lower(trim(c.canonical_name)) = lower(trim(?1))
       UNION
       SELECT a.company_id AS id FROM company_alias a WHERE lower(trim(a.alias)) = lower(trim(?1))
       LIMIT 1`,
    )
      .bind(input.name!)
      .first<{ id: string }>();

    if (existing) {
      companyId = existing.id;
      matchedVia = "existing register entry";
    } else {
      companyId = `cc_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare(
        `INSERT INTO canonical_company (id, canonical_name, privacy_label, firm_scope, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(companyId, input.name!, capture.privacy_label, capture.firm_scope, actor.firmUserId ?? "system")
        .run();
    }
  } else if (input.kind === "PERSON") {
    const known = await findInNetworkOs(env, input.name!, input.email);
    if (known) {
      personId = known.id;
      personSource = "NETWORK_OS";
      matchedVia = "Network OS";
    } else {
      // Nowhere to put them in the system of record, so they are written here and QUEUED.
      personId = `per_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare(
        `INSERT INTO person (id, full_name, email, organization, source, privacy_label, firm_scope)
         VALUES (?1, ?2, ?3, ?4, 'capture', ?5, ?6)`,
      )
        .bind(
          personId,
          input.name!,
          input.email ?? null,
          input.organization ?? null,
          capture.privacy_label,
          capture.firm_scope,
        )
        .run();
      personSource = "LOCAL_UNRESOLVED";
      matchedVia = "not in Network OS — queued";
    }
  }

  await env.WP_OS_DB.prepare(
    `UPDATE capture
        SET resolved_kind = ?2, resolved_company_id = ?3, resolved_person_id = ?4,
            person_source = ?5, resolved_at = ?6, resolution_note = ?7
      WHERE id = ?1`,
  )
    .bind(capture.id, input.kind, companyId, personId, personSource, now, input.note ?? null)
    .run();

  await appendEvent(env, {
    eventType: "capture.resolved",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
    payload: { kind: input.kind, company_id: companyId, person_id: personId, person_source: personSource, matched_via: matchedVia },
  });

  return json({
    capture_id: capture.id,
    kind: input.kind,
    company_id: companyId,
    person_id: personId,
    person_source: personSource,
    matched_via: matchedVia,
    /** Stated so the screen never has to explain the model in its own words. */
    what_this_means:
      personSource === "LOCAL_UNRESOLVED"
        ? "Network OS does not know this person, and West Peek OS cannot write to it. They are recorded here and added to the unresolved queue — this system is not claiming they are in the system of record."
        : input.kind === "PERSON"
          ? "Matched to the person Network OS already holds. Network OS stays the system of record."
          : matchedVia === "existing register entry"
            ? "Matched an existing company rather than creating a second record for it."
            : "A new company record was created; it is now the canonical identity for this name.",
  });
}

/**
 * People this firm has met who are not in the system of record.
 *
 * The queue exists because Network OS is read-only from here. It is deliberately a plain list with
 * nothing clever about it: its job is to be visible, to be short enough to act on, and to make the
 * case for writeback out of real people rather than a hunch.
 */
export async function handleUnresolvedPeople(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT c.id AS capture_id, c.resolved_at, c.resolution_note, c.raw_text,
            p.id AS person_id, p.full_name, p.email, p.organization
       FROM capture c
       JOIN person p ON p.id = c.resolved_person_id
      WHERE c.person_source = 'LOCAL_UNRESOLVED' AND c.firm_scope = ?1
      ORDER BY c.resolved_at DESC
      LIMIT 200`,
  )
    .bind("west-peek")
    .all();

  const people = rows.results ?? [];
  return json({
    people,
    count: people.length,
    why:
      "Network OS is the system of record for people, and West Peek OS reads it without writing to " +
      "it. These are people the firm has met who are not in it yet. Nothing here claims otherwise.",
    next_step:
      people.length === 0
        ? "Nothing waiting."
        : `Add these ${people.length} to Network OS, or use this list as the case for building a write path.`,
  });
}
