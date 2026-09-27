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
import { proposePerson } from "../effects/networkOsClient";

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
 * How the resolve describes what happened to the person, on the card and on the event.
 *
 * Exported so the tests pin the words rather than a paraphrase: the operator reads these on the
 * capture card, and a "queued" that quietly stops meaning "go and do it yourself" is the kind of
 * change that has to be visible.
 */
export const PROPOSED_VIA = "proposed to Network OS — awaiting their review";
export const ALREADY_PROPOSED_VIA = "already proposed to Network OS — awaiting their review";
export const REFUSAL_CARD_TITLE = "Network OS refused a captured person: ";
export const REFUSAL_CARD_NEXT_ACTION = "Press Propose on the Network page after fixing the cause, or add them in Network OS by hand";

/**
 * Ask whether this person is already known — in Network OS, or already on their way there.
 *
 * Two questions, in order:
 *   1. Is there a local `person` LINKED to a Network OS contact (the mapping carries their id)?
 *      Then they are in the system of record, and the capture resolves to them as NETWORK_OS.
 *   2. Is there an unlinked local person, written by an earlier capture, whom West Peek OS has
 *      already PROPOSED (a `network.person_proposed` event exists)? Then a second capture of them
 *      resolves to the same row — one person, one row, one proposal — and sends nothing more.
 *
 * Returns null when neither holds and the caller writes the person and proposes them. Deliberately
 * fail-soft: an unreachable Network OS must not block the operator from recording who they met,
 * and a person queued when they were really already known is a duplicate to merge later —
 * recoverable, unlike a lost record.
 */
async function findInNetworkOs(
  env: Env,
  name: string,
  email: string | undefined,
  firmScope: string,
): Promise<{ id: string; via: "network_os" | "proposed" } | null> {
  const linked = await env.WP_OS_DB.prepare(
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
  if (linked) return { id: linked.id, via: "network_os" };

  // Matched by the email if one was typed, else by the exact name — the same two keys the link-back
  // on sync uses, so a person this finds is one the sync will later link.
  const proposed = await env.WP_OS_DB.prepare(
    `SELECT p.id AS id
       FROM person p
      WHERE p.source = 'capture' AND p.firm_scope = ?3
        AND NOT EXISTS (
          SELECT 1 FROM network_external_mapping m
           WHERE m.internal_type = 'person' AND m.internal_id = p.id
        )
        AND EXISTS (
          SELECT 1 FROM event_record e
           WHERE e.event_type = 'network.person_proposed' AND e.object_id = p.id
        )
        AND ((?2 IS NOT NULL AND lower(p.email) = lower(?2))
             OR lower(trim(p.full_name)) = lower(trim(?1)))
      ORDER BY p.created_at ASC
      LIMIT 1`,
  )
    .bind(name, email ?? null, firmScope)
    .first<{ id: string }>();
  return proposed ? { id: proposed.id, via: "proposed" } : null;
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
  /** Set only when THIS resolve wrote a new local person and handed them to Network OS. */
  let proposal: ProposalOutcome | null = null;

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
    const known = await findInNetworkOs(env, input.name!, input.email, capture.firm_scope);
    if (known?.via === "network_os") {
      personId = known.id;
      personSource = "NETWORK_OS";
      matchedVia = "Network OS";
    } else if (known) {
      // Proposed from an earlier capture and still awaiting Network OS's review: the same row,
      // and nothing is sent twice. The link-back on sync flips every capture of them together.
      personId = known.id;
      personSource = "LOCAL_UNRESOLVED";
      matchedVia = ALREADY_PROPOSED_VIA;
    } else {
      // Not in the system of record. They are written here, and HANDED TO NETWORK OS by this same
      // resolve — the far end's intake queue is where a human decides whether they become a
      // contact, and the next sync links this row to the contact once someone there says yes.
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

  // The hand-off runs AFTER the capture points at the person, because the proposal reads the
  // capture's own words for context and the refusal card is filed against this capture.
  if (input.kind === "PERSON" && personSource === "LOCAL_UNRESOLVED" && matchedVia === "not in Network OS — queued") {
    proposal = await proposeCapturedPerson(env, identity!, capture.id);
    matchedVia =
      proposal.status === "proposed"
        ? PROPOSED_VIA
        : proposal.status === "refused"
          ? `not in Network OS — proposal refused: ${proposal.detail}`
          : `not in Network OS — queued (${proposal.detail})`;
  }

  await appendEvent(env, {
    eventType: "capture.resolved",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
    payload: {
      kind: input.kind,
      company_id: companyId,
      person_id: personId,
      person_source: personSource,
      matched_via: matchedVia,
      proposal: proposal ? { status: proposal.status, work_card_id: proposal.work_card_id } : null,
    },
  });

  return json({
    capture_id: capture.id,
    kind: input.kind,
    company_id: companyId,
    person_id: personId,
    person_source: personSource,
    matched_via: matchedVia,
    proposal,
    /** Stated so the screen never has to explain the model in its own words. */
    what_this_means: whatResolvingMeans({ kind: input.kind, personSource, matchedVia, proposal }),
  });
}

/**
 * The sentence under the resolve. Every branch says where the person now IS, and the only branch
 * that sends the operator anywhere is the one where the hand-off did not happen.
 */
function whatResolvingMeans(r: {
  kind: "COMPANY" | "PERSON" | "NEITHER";
  personSource: "NETWORK_OS" | "LOCAL_UNRESOLVED" | null;
  matchedVia: string;
  proposal: ProposalOutcome | null;
}): string {
  if (r.kind === "PERSON") {
    if (r.personSource === "NETWORK_OS") return "Matched to the person Network OS already holds. Network OS stays the system of record.";
    if (r.matchedVia === ALREADY_PROPOSED_VIA) {
      return (
        "This person was already proposed to Network OS from an earlier capture and is awaiting their review. " +
        "This capture resolved to that same record — no second record and no second proposal. When someone " +
        "there accepts them, every capture of them links to the contact on the next sync."
      );
    }
    if (r.proposal?.status === "proposed") {
      return (
        "Network OS did not know this person. They are now in Network OS's review queue; when someone there " +
        "accepts them, this record links to the contact on the next sync."
      );
    }
    if (r.proposal?.status === "refused") {
      return (
        `Network OS did not know this person, and the hand-off was refused: ${r.proposal.detail} ` +
        "They are recorded here and added to the unresolved queue — this system is not claiming they are in " +
        "the system of record. A HIGH work card carries the refusal: press Send to Network OS on the Network " +
        "page after fixing the cause, or add them in Network OS by hand."
      );
    }
    return (
      `Network OS does not know this person, and they were not handed over: ${r.proposal?.detail ?? "no proposal was made"} ` +
      "They are recorded here and added to the unresolved queue — this system is not claiming they are in the " +
      "system of record. Someone who may propose can send them from the Network page."
    );
  }
  if (r.kind === "COMPANY") {
    return r.matchedVia === "existing register entry"
      ? "Matched an existing company rather than creating a second record for it."
      : "A new company record was created; it is now the canonical identity for this name.";
  }
  return "Recorded as neither a company nor a person; nothing was created anywhere.";
}

/**
 * People this firm has met who are not in the system of record yet.
 *
 * Two kinds sit here, told apart on each row: people PROPOSED and awaiting Network OS's review
 * (`proposed`, no button — the next sync links them and they leave), and people whose hand-off
 * was refused or never made (`last_refusal` names the reason, and the button retries). Both are
 * derived from the event spine, so the list and the trail can never disagree about who has gone.
 */
export async function handleUnresolvedPeople(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT c.id AS capture_id, c.resolved_at, c.resolution_note, c.raw_text,
            p.id AS person_id, p.full_name, p.email, p.organization,
            EXISTS (
              SELECT 1 FROM event_record e
               WHERE e.event_type = 'network.person_proposed' AND e.object_id = p.id
            ) AS proposed,
            (SELECT e.payload_json FROM event_record e
              WHERE e.event_type = 'network.person_proposal_failed' AND e.object_id = p.id
              ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS last_failure_json
       FROM capture c
       JOIN person p ON p.id = c.resolved_person_id
      WHERE c.person_source = 'LOCAL_UNRESOLVED' AND c.firm_scope = ?1
      ORDER BY c.resolved_at DESC
      LIMIT 200`,
  )
    .bind("west-peek")
    .all<{
      capture_id: string;
      resolved_at: string;
      resolution_note: string | null;
      raw_text: string;
      person_id: string;
      full_name: string;
      email: string | null;
      organization: string | null;
      proposed: number;
      last_failure_json: string | null;
    }>();

  const people = (rows.results ?? []).map(({ proposed, last_failure_json, ...row }) => {
    let lastRefusal: string | null = null;
    if (!proposed && last_failure_json) {
      try {
        const payload = JSON.parse(last_failure_json) as { reason?: unknown };
        lastRefusal = typeof payload.reason === "string" ? payload.reason : null;
      } catch {
        lastRefusal = null;
      }
    }
    return { ...row, proposed: proposed === 1, last_refusal: lastRefusal };
  });
  const awaitingReview = people.filter((p) => p.proposed).length;
  const toSend = people.length - awaitingReview;
  return json({
    people,
    count: people.length,
    to_send: toSend,
    awaiting_review: awaitingReview,
    why:
      "Network OS is the system of record for people, and West Peek OS never writes a contact into it. " +
      "These are people the firm has met who are not in it yet: resolving a capture proposes them to " +
      "Network OS's review queue by itself, and the next sync after someone there accepts them links " +
      "the record here. Nothing on this list claims otherwise.",
    next_step:
      people.length === 0
        ? "Nothing waiting."
        : toSend > 0
          ? `Send ${toSend} to Network OS's review queue, one press each; ${awaitingReview} already sent are awaiting their review.`
          : `${awaitingReview} awaiting Network OS's review. They link here on the next sync after they are accepted.`,
  });
}

// ── Sending a person the other way ─────────────────────────────────────────────

export interface ProposalOutcome {
  /**
   * proposed — Network OS's intake queue has them; `network.person_proposed` written.
   * refused — Network OS (or its configuration) said no; `network.person_proposal_failed` written
   *           and a HIGH work card opened (`work_card_id`) so a person sees it.
   * already_proposed — a proposal event already exists; nothing sent.
   * not_permitted — the actor may not propose (an AI, or a role outside the restriction).
   * not_found — no captured person on that capture in this firm.
   */
  status: "proposed" | "refused" | "already_proposed" | "not_permitted" | "not_found";
  detail: string;
  work_card_id: string | null;
  person_id: string | null;
  name: string | null;
}

/**
 * Propose a captured person to Network OS — ONE implementation, reached two ways.
 *
 * Operator, 21 Aug 2026: "the capture tab needs to integrate also with network OS and allow new
 * people to go the other way and go into the network OS database."
 *
 * Until 27 Sep 2026 this was only behind the "Send to Network OS" button on the Network page, and
 * production told the story: five captures, all archived unresolved, zero proposals ever sent.
 * The resolve now calls this itself the moment it writes a person Network OS does not know
 * (`handleResolveCapture`), and the button (`handleProposePersonToNetwork`) is the RETRY for a
 * proposal that was refused. The resolving human is the actor in both cases.
 *
 * PROPOSES, NEVER WRITES. It posts to Network OS's intake queue, where a human there decides whether
 * the person becomes a contact. That is why it is authorized under `network_os.propose_person`
 * (RESTRICTED: named human roles act at once, an AI actor is refused) rather than the MP-reserved
 * `network_os.writeback`: the far end holds the veto, and an approval card in front of every
 * captured business card would be ceremony with no content on the one surface that has to be fast.
 *
 * NOT SENT TWICE, AND NOT BY A NEW COLUMN. The obvious move was to stamp `person_source`, but that
 * column carries `CHECK (person_source IN ('NETWORK_OS','LOCAL_UNRESOLVED'))` — a third value would
 * have thrown on the first press in production while passing every local test that did not exercise
 * the constraint. The event spine already answers this: `network.person_proposed` is written on
 * success, so "already sent" is derived from the record of it having been sent.
 *
 * A REFUSAL IS VISIBLE. The far end saying no — or the integration being unconfigured — is a fact
 * about the integration, not about the person, so the resolve still succeeds. The refusal is written
 * to the spine AND opens ONE HIGH work card naming the person and the reason; a second refusal for
 * the same person joins that card rather than opening another (`createWorkCardInternal` dedupes on
 * a live card with the same capture or the same title).
 */
export async function proposeCapturedPerson(env: Env, actor: FirmUserIdentity, captureId: string): Promise<ProposalOutcome> {
  const who = actorFromIdentity(actor);
  const firmScope = who.firmScopes[0] ?? "west-peek";

  const row = await env.WP_OS_DB.prepare(
    `SELECT c.id AS capture_id, c.raw_text, c.person_source,
            p.id AS person_id, p.full_name, p.email, p.organization
       FROM capture c
       JOIN person p ON p.id = c.resolved_person_id
      WHERE c.id = ?1 AND c.firm_scope = ?2`,
  )
    .bind(captureId, firmScope)
    .first<{
      capture_id: string;
      raw_text: string | null;
      person_source: string;
      person_id: string;
      full_name: string;
      email: string | null;
      organization: string | null;
    }>();

  if (!row) {
    return { status: "not_found", detail: "no captured person on that capture", work_card_id: null, person_id: null, name: null };
  }
  const alreadySent = await env.WP_OS_DB.prepare(
    "SELECT id FROM event_record WHERE event_type = 'network.person_proposed' AND object_id = ?1 LIMIT 1",
  )
    .bind(row.person_id)
    .first();
  if (alreadySent) {
    return {
      status: "already_proposed",
      detail: `${row.full_name} has already been sent to Network OS.`,
      work_card_id: null,
      person_id: row.person_id,
      name: row.full_name,
    };
  }

  if (who.type !== "HUMAN") {
    return { status: "not_permitted", detail: "only a person may propose somebody to Network OS", work_card_id: null, person_id: row.person_id, name: row.full_name };
  }
  const authz = await authorize(env, who, "network_os.propose_person", {
    objectType: "person",
    objectId: row.person_id,
    firmScope,
  });
  if (authz.decision !== "ALLOW") {
    return { status: "not_permitted", detail: authz.reason, work_card_id: null, person_id: row.person_id, name: row.full_name };
  }

  const result = await proposePerson(env, {
    name: row.full_name,
    email: row.email,
    company: row.organization,
    // The capture's own words are the best context anybody will ever write about this person, and a
    // reviewer in Network OS reading "met at the AI infra dinner" can act on it. Bounded, because
    // the far end parses free text and a wall of it helps nobody.
    context: row.raw_text ? row.raw_text.slice(0, 500) : null,
  });

  if (!result.ok) {
    // Recorded, not swallowed. A refusal by the far end is a fact about the integration and the
    // operator should be able to see it happened rather than press the button again and wonder.
    await appendEvent(env, {
      eventType: "network.person_proposal_failed",
      actorType: "firm_user",
      actorId: who.firmUserId!,
      objectType: "person",
      objectId: row.person_id,
      firmScope,
      payload: { capture_id: row.capture_id, reason: result.detail },
    });
    // …and carried to a person. One card per person: a second refusal joins the open one.
    const card = await createWorkCardInternal(env, actor, {
      capture_id: row.capture_id,
      title: `${REFUSAL_CARD_TITLE}${row.full_name}`,
      description:
        `West Peek OS proposed ${row.full_name}${row.email ? ` (${row.email})` : ""} to Network OS's intake queue and was refused: ${result.detail} ` +
        "They are recorded here as LOCAL_UNRESOLVED; Network OS still does not know them.",
      priority: "HIGH",
      firm_scope: firmScope,
      next_action: REFUSAL_CARD_NEXT_ACTION,
    });
    return { status: "refused", detail: result.detail, work_card_id: card.id, person_id: row.person_id, name: row.full_name };
  }

  await appendEvent(env, {
    eventType: "network.person_proposed",
    actorType: "firm_user",
    actorId: who.firmUserId!,
    objectType: "person",
    objectId: row.person_id,
    firmScope,
    payload: { capture_id: row.capture_id, name: row.full_name },
  });

  return {
    status: "proposed",
    detail: `${row.full_name} is in Network OS's review queue. Somebody there decides whether they become a contact.`,
    work_card_id: null,
    person_id: row.person_id,
    name: row.full_name,
  };
}

/** The button on the Network page: the retry. Same implementation as the resolve's hand-off. */
export async function handleProposePersonToNetwork(ctx: RouteContext): Promise<Response> {
  const outcome = await proposeCapturedPerson(ctx.env, ctx.identity!, ctx.params.id!);
  switch (outcome.status) {
    case "proposed":
      return json({ ok: true, name: outcome.name, detail: outcome.detail });
    case "already_proposed":
      return json({ error: "already_proposed", detail: outcome.detail }, { status: 409 });
    case "not_permitted":
      return json({ error: "forbidden", detail: outcome.detail }, { status: 403 });
    case "not_found":
      return json({ error: "not_found", detail: outcome.detail }, { status: 404 });
    case "refused":
      return json({ error: "propose_failed", detail: outcome.detail, work_card_id: outcome.work_card_id }, { status: 502 });
  }
}
