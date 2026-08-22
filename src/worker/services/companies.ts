import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { privacyLabelSchema, DEFAULT_PRIVACY_LABEL } from "../../shared/privacy";
import { actorFromIdentity, authorize, getApprovalCard, privacyVisibilityClause, type AuthorizationDecision } from "./authorize";
import { consumeApprovalCard } from "./approvals";

/**
 * Canonical-company identity service (D3: CanonicalCompany-first).
 *
 * Rules enforced here:
 * - Aliases NEVER create companies; they only resolve to an existing canonical company.
 * - Duplicate prevention at create time across all three entry points:
 *   exact canonical_name, exact alias, same (system, external_key) external identity.
 * - Merge is human-reserved and receipt-backed; reversal replays the receipt exactly.
 *   Sources are retired (status='MERGED'), never deleted.
 *
 * Authority (P3): merge AND reversal route through the authorize() choke point with
 * an approved approval card (identity_merge.execute, human-reserved register).
 * The caller presents the card id as `approval_receipt_id`; authorize() verifies
 * state=approved, action+object match, and approver role, and execution consumes
 * the card (approved → executed) so it can never be replayed.
 */

// ── Row shapes ──

export interface CompanyRow {
  id: string;
  canonical_name: string;
  legal_name: string | null;
  website: string | null;
  description: string | null;
  privacy_label: string;
  status: string;
  created_by: string;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

interface AliasRow {
  id: string;
  company_id: string;
  alias: string;
  alias_type: string;
  source: string | null;
  firm_scope: string;
  created_at: string;
}

interface ExternalIdentityRow {
  id: string;
  company_id: string;
  system: string;
  external_key: string;
  source: string | null;
  firm_scope: string;
  created_at: string;
}

interface CandidateRow {
  id: string;
  company_id_a: string;
  company_id_b: string;
  match_basis: string;
  score: number | null;
  status: string;
  proposed_by: string;
  firm_scope: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface MergeReceiptRow {
  id: string;
  source_company_id: string;
  target_company_id: string;
  actor_id: string;
  approved_by: string;
  moved_references_json: string;
  pre_merge_snapshot_json: string;
  pre_merge_hash: string;
  firm_scope: string;
  created_at: string;
}

/** One repointed foreign-key reference, recorded in the merge receipt. */
export interface MovedReference {
  table: string;
  row_id: string;
  column: string;
  old_value: string;
  new_value: string;
}

/**
 * Foreign-key columns a merge must repoint. This list is exhaustive for P2; any new
 * company-referencing table added by a later phase MUST extend it (and the merge
 * refuses unknowns by construction — every moved row is captured in the receipt).
 */
export const MERGE_REFERENCE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "company_alias", column: "company_id" },
  { table: "company_external_identity", column: "company_id" },
  { table: "organization_relationship", column: "company_id" },
  { table: "identity_resolution_candidate", column: "company_id_a" },
  { table: "identity_resolution_candidate", column: "company_id_b" },
];

// ── Validation ──

const aliasInputSchema = z.object({
  alias: z.string().trim().min(1),
  alias_type: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
});

const externalIdentityInputSchema = z.object({
  system: z.string().trim().min(1),
  external_key: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
});

const createCompanySchema = z.object({
  canonical_name: z.string().trim().min(1),
  /** What the company does — free text, because the thesis that defines sectors is edited often. */
  sector: z.string().trim().min(1).optional(),
  one_liner: z.string().trim().min(1).optional(),
  legal_name: z.string().trim().min(1).optional(),
  website: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  privacy_label: privacyLabelSchema.optional(),
  aliases: z.array(aliasInputSchema).optional(),
  external_identities: z.array(externalIdentityInputSchema).optional(),
});

const updateCompanySchema = z
  .object({
    legal_name: z.string().trim().min(1).nullable().optional(),
    website: z.string().trim().min(1).nullable().optional(),
    description: z.string().nullable().optional(),
    sector: z.string().trim().min(1).nullable().optional(),
    one_liner: z.string().trim().min(1).nullable().optional(),
    privacy_label: privacyLabelSchema.optional(),
    // Identity fields are explicitly NOT updatable here:
    canonical_name: z.never().optional(),
    status: z.never().optional(),
  })
  .strict();

const createCandidateSchema = z.object({
  company_id_a: z.string().min(1),
  company_id_b: z.string().min(1),
  match_basis: z.string().trim().min(1),
  score: z.number().min(0).max(1).optional(),
});

// ── Helpers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

async function getCompanyById(env: Env, id: string): Promise<CompanyRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM canonical_company WHERE id = ?1").bind(id).first<CompanyRow>();
}

async function companyView(env: Env, company: CompanyRow): Promise<Record<string, unknown>> {
  const aliases = await env.WP_OS_DB.prepare(
    "SELECT * FROM company_alias WHERE company_id = ?1 ORDER BY created_at, id",
  )
    .bind(company.id)
    .all<AliasRow>();
  const externalIdentities = await env.WP_OS_DB.prepare(
    "SELECT * FROM company_external_identity WHERE company_id = ?1 ORDER BY created_at, id",
  )
    .bind(company.id)
    .all<ExternalIdentityRow>();
  return { ...company, aliases: aliases.results ?? [], external_identities: externalIdentities.results ?? [] };
}

/** Find an existing company whose canonical_name matches (case-insensitive exact). */
async function findByCanonicalName(env: Env, name: string): Promise<CompanyRow | null> {
  return env.WP_OS_DB.prepare(
    "SELECT * FROM canonical_company WHERE lower(trim(canonical_name)) = ?1 LIMIT 1",
  )
    .bind(norm(name))
    .first<CompanyRow>();
}

/** Find an existing company carrying an alias that matches (case-insensitive exact). */
async function findByAlias(env: Env, alias: string): Promise<(AliasRow & { company?: CompanyRow | null }) | null> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM company_alias WHERE lower(trim(alias)) = ?1 LIMIT 1",
  )
    .bind(norm(alias))
    .first<AliasRow>();
  if (!row) return null;
  return { ...row, company: await getCompanyById(env, row.company_id) };
}

async function findByExternalIdentity(
  env: Env,
  system: string,
  externalKey: string,
): Promise<(ExternalIdentityRow & { company?: CompanyRow | null }) | null> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM company_external_identity WHERE system = ?1 AND external_key = ?2 LIMIT 1",
  )
    .bind(system, externalKey)
    .first<ExternalIdentityRow>();
  if (!row) return null;
  return { ...row, company: await getCompanyById(env, row.company_id) };
}

function duplicateResponse(reason: string, existing: unknown): Response {
  return json({ error: "duplicate", reason, existing }, { status: 409 });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Companies ──

export async function handleCreateCompany(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createCompanySchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  // Duplicate prevention — entry point 1: exact canonical_name.
  const byName = await findByCanonicalName(env, input.canonical_name);
  if (byName) return duplicateResponse("canonical_name", await companyView(env, byName));

  // Duplicate prevention — entry point 2: exact alias (the new name itself may already
  // be an alias of an existing company, and no supplied alias may belong to another one).
  const byAlias = await findByAlias(env, input.canonical_name);
  if (byAlias?.company) return duplicateResponse("alias", await companyView(env, byAlias.company));
  for (const a of input.aliases ?? []) {
    const clashAlias = await findByAlias(env, a.alias);
    if (clashAlias?.company) return duplicateResponse("alias", await companyView(env, clashAlias.company));
    const clashName = await findByCanonicalName(env, a.alias);
    if (clashName) return duplicateResponse("alias", await companyView(env, clashName));
  }

  // Duplicate prevention — entry point 3: same (system, external_key) external identity.
  for (const ext of input.external_identities ?? []) {
    const clash = await findByExternalIdentity(env, ext.system, ext.external_key);
    if (clash?.company) return duplicateResponse("external_identity", await companyView(env, clash.company));
  }

  const id = `cc_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    env.WP_OS_DB.prepare(
      `INSERT INTO canonical_company (id, canonical_name, legal_name, website, description, privacy_label, created_by, sector, one_liner)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      id,
      input.canonical_name.trim(),
      input.legal_name ?? null,
      input.website ?? null,
      input.description ?? null,
      input.privacy_label ?? DEFAULT_PRIVACY_LABEL,
      identity!.id,
      input.sector ?? null,
      input.one_liner ?? null,
    ),
  ];
  for (const a of input.aliases ?? []) {
    statements.push(
      env.WP_OS_DB.prepare(
        "INSERT INTO company_alias (id, company_id, alias, alias_type, source) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(`ca_${crypto.randomUUID()}`, id, a.alias, a.alias_type ?? "COMMON", a.source ?? null),
    );
  }
  for (const ext of input.external_identities ?? []) {
    statements.push(
      env.WP_OS_DB.prepare(
        "INSERT INTO company_external_identity (id, company_id, system, external_key, source) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(`cei_${crypto.randomUUID()}`, id, ext.system, ext.external_key, ext.source ?? null),
    );
  }
  await env.WP_OS_DB.batch(statements);

  await appendEvent(env, {
    eventType: "identity.company_created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "canonical_company",
    objectId: id,
    payload: { canonical_name: input.canonical_name.trim() },
  });

  const company = await getCompanyById(env, id);
  return json(await companyView(env, company!), { status: 201 });
}

export async function handleListCompanies(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM canonical_company WHERE status = ?1 ORDER BY created_at, id",
      )
        .bind(status)
        .all<CompanyRow>()
    : await ctx.env.WP_OS_DB.prepare("SELECT * FROM canonical_company ORDER BY created_at, id").all<CompanyRow>();
  return json({ companies: rows.results ?? [] });
}

/**
 * Alias resolution: given a name string, resolve to the one canonical company or none.
 * Exact (case-insensitive) match against canonical_name first, then aliases.
 */
export async function handleResolveCompany(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const name = url.searchParams.get("name");
  if (!name || name.trim().length === 0) {
    return json({ error: "invalid_input", detail: "name query parameter is required" }, { status: 400 });
  }
  const byName = await findByCanonicalName(ctx.env, name);
  if (byName) return json({ match: await companyView(ctx.env, byName), matched_via: "canonical_name" });
  const byAlias = await findByAlias(ctx.env, name);
  if (byAlias?.company) {
    return json({ match: await companyView(ctx.env, byAlias.company), matched_via: "alias" });
  }
  return json({ match: null });
}

export async function handleGetCompany(ctx: RouteContext): Promise<Response> {
  const company = await getCompanyById(ctx.env, ctx.params.id!);
  if (!company) return json({ error: "not_found" }, { status: 404 });
  return json(await companyView(ctx.env, company));
}

/** Update non-identity fields only. canonical_name and status are rejected (400). */
/**
 * Editing a company — authorized, and on the record.
 *
 * WHAT WAS WRONG, and it is the reason item 9 could not be built on top of it: this route had NO
 * authorize() call and appended NO event. Anybody who could reach the API could change what the
 * firm records about a company, and nothing anywhere would say it had happened. In production all
 * three companies had been modified with no record of by whom.
 *
 * That made it the only entity in a CanonicalCompany-first model that could change without a
 * trace — in a system whose whole premise is that the company record is the thing everything else
 * hangs off.
 *
 * THE EVENT IS THE HISTORY. Every changed field is recorded with its old and new value, because
 * "somebody edited this company" is not a useful sentence: the question a partner asks months later
 * is "who changed the sector, and what was it before". Unchanged fields are not recorded — an event
 * that lists everything makes the one thing that moved impossible to find.
 */
export async function handleUpdateCompany(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const company = await getCompanyById(env, ctx.params.id!);
  if (!company) return json({ error: "not_found" }, { status: 404 });

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(env, actor, "company.update", {
    objectType: "canonical_company",
    objectId: company.id,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = await parseJsonBody(ctx.request);
  const parsed = updateCompanySchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "invalid_input", detail: "only non-identity fields (legal_name, website, description, sector, one_liner, privacy_label) are updatable", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  // Only what actually MOVED, with its previous value. An event listing every field makes the one
  // thing that changed impossible to find in it.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const before = company as unknown as Record<string, unknown>;
  for (const field of ["legal_name", "website", "description", "privacy_label", "sector", "one_liner"] as const) {
    if (input[field] !== undefined && input[field] !== before[field]) {
      sets.push(`${field} = ?${binds.length + 2}`);
      binds.push(input[field]);
      changes[field] = { from: before[field] ?? null, to: input[field] };
    }
  }
  if (sets.length === 0) return json({ error: "invalid_input", detail: "no updatable fields provided" }, { status: 400 });

  await env.WP_OS_DB.prepare(
    `UPDATE canonical_company SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    .bind(company.id, ...binds)
    .run();

  await appendEvent(env, {
    eventType: "company.updated",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "canonical_company",
    objectId: company.id,
    payload: { changes },
  });

  return json(await companyView(env, (await getCompanyById(env, company.id))!));
}

// ── Aliases ──

export async function handleAddAlias(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  const company = await getCompanyById(env, ctx.params.id!);
  if (!company) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = aliasInputSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  // An alias must never create ambiguity: it may not equal another company's
  // canonical name or an existing alias anywhere.
  const clashAlias = await findByAlias(env, input.alias);
  if (clashAlias) return duplicateResponse("alias", { alias: clashAlias, company_id: clashAlias.company_id });
  const clashName = await findByCanonicalName(env, input.alias);
  if (clashName) return duplicateResponse("alias", await companyView(env, clashName));

  const id = `ca_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO company_alias (id, company_id, alias, alias_type, source) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, company.id, input.alias, input.alias_type ?? "COMMON", input.source ?? null)
    .run();

  return json({ id, company_id: company.id, alias: input.alias }, { status: 201 });
}

export async function handleListAliases(ctx: RouteContext): Promise<Response> {
  const company = await getCompanyById(ctx.env, ctx.params.id!);
  if (!company) return json({ error: "not_found" }, { status: 404 });
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM company_alias WHERE company_id = ?1 ORDER BY created_at, id",
  )
    .bind(company.id)
    .all<AliasRow>();
  return json({ aliases: rows.results ?? [] });
}

// ── Identity resolution candidates ──

export async function handleCreateCandidate(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createCandidateSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  if (input.company_id_a === input.company_id_b) {
    return json({ error: "invalid_input", detail: "company_id_a and company_id_b must differ" }, { status: 400 });
  }
  const a = await getCompanyById(env, input.company_id_a);
  const b = await getCompanyById(env, input.company_id_b);
  if (!a || !b) return json({ error: "not_found", detail: "both companies must exist" }, { status: 404 });

  const id = `irc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO identity_resolution_candidate (id, company_id_a, company_id_b, match_basis, score, proposed_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, input.company_id_a, input.company_id_b, input.match_basis, input.score ?? null, identity!.id)
    .run();

  const row = await env.WP_OS_DB.prepare("SELECT * FROM identity_resolution_candidate WHERE id = ?1")
    .bind(id)
    .first<CandidateRow>();
  return json(row, { status: 201 });
}

export async function handleListCandidates(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM identity_resolution_candidate WHERE status = ?1 ORDER BY created_at, id",
      )
        .bind(status)
        .all<CandidateRow>()
    : await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM identity_resolution_candidate ORDER BY created_at, id",
      ).all<CandidateRow>();
  return json({ candidates: rows.results ?? [] });
}

/**
 * Accept or reject a candidate. Accepting marks review outcome ONLY — it never merges.
 * Merge is a separate human-reserved action (POST .../merge-into/...).
 */
async function resolveCandidate(ctx: RouteContext, outcome: "ACCEPTED" | "REJECTED"): Promise<Response> {
  const { env, identity } = ctx;
  const row = await env.WP_OS_DB.prepare("SELECT * FROM identity_resolution_candidate WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<CandidateRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  if (row.status !== "PENDING") {
    return json({ error: "conflict", detail: `candidate already ${row.status}` }, { status: 409 });
  }
  await env.WP_OS_DB.prepare(
    `UPDATE identity_resolution_candidate
        SET status = ?2, resolved_by = ?3, resolved_at = ?4
      WHERE id = ?1`,
  )
    .bind(row.id, outcome, identity!.id, new Date().toISOString())
    .run();
  const updated = await env.WP_OS_DB.prepare("SELECT * FROM identity_resolution_candidate WHERE id = ?1")
    .bind(row.id)
    .first<CandidateRow>();
  return json(updated);
}

export function handleAcceptCandidate(ctx: RouteContext): Promise<Response> {
  return resolveCandidate(ctx, "ACCEPTED");
}

export function handleRejectCandidate(ctx: RouteContext): Promise<Response> {
  return resolveCandidate(ctx, "REJECTED");
}

// ── Merge + reversal ──

/**
 * Gate a reserved execution path through the authorize() choke point.
 * Returns null when ALLOWED (receipt verified); otherwise the HTTP response to send.
 */
function authorizationGate(decision: AuthorizationDecision): Response | null {
  if (decision.decision === "ALLOW") return null;
  if (decision.decision === "DENY") {
    return json({ error: "forbidden", reason: decision.reason }, { status: 403 });
  }
  return json(
    { error: "approval_required", reason: decision.reason, requiredApproverRoles: decision.requiredApproverRoles },
    { status: 409 },
  );
}

/** Read the optional { approval_receipt_id } body (absent body is fine). */
async function receiptIdFrom(request: Request): Promise<string | undefined> {
  const body = await parseJsonBody(request);
  if (body && typeof body === "object" && "approval_receipt_id" in body) {
    const value = (body as { approval_receipt_id?: unknown }).approval_receipt_id;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Snapshot of every row the merge could touch, taken before any write. */
async function preMergeSnapshot(env: Env, sourceId: string, targetId: string): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  const companies = await env.WP_OS_DB.prepare(
    "SELECT * FROM canonical_company WHERE id IN (?1, ?2) ORDER BY id",
  )
    .bind(sourceId, targetId)
    .all<CompanyRow>();
  snapshot.canonical_company = companies.results ?? [];

  const tables = [...new Set(MERGE_REFERENCE_COLUMNS.map((r) => r.table))];
  for (const table of tables) {
    const columns = MERGE_REFERENCE_COLUMNS.filter((r) => r.table === table).map((r) => r.column);
    const where = columns.map((c) => `${c} IN (?1, ?2)`).join(" OR ");
    const rows = await env.WP_OS_DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`)
      .bind(sourceId, targetId)
      .all();
    snapshot[table] = rows.results ?? [];
  }
  return snapshot;
}

export async function handleMergeCompanies(ctx: RouteContext): Promise<Response> {
  const { env, identity, params } = ctx;
  const approvalReceiptId = await receiptIdFrom(ctx.request);

  const sourceId = params.sourceId!;
  const targetId = params.targetId!;
  if (sourceId === targetId) {
    return json({ error: "invalid_input", detail: "source and target must differ" }, { status: 400 });
  }
  const source = await getCompanyById(env, sourceId);
  const target = await getCompanyById(env, targetId);
  if (!source || !target) return json({ error: "not_found" }, { status: 404 });

  // THE choke point (P3): identity_merge.execute is human-reserved. ALLOW requires
  // an approved approval card for action identity_merge.execute on the source company.
  const actor = actorFromIdentity(identity!);
  const authz = await authorize(
    env,
    actor,
    "identity_merge.execute",
    { objectType: "canonical_company", objectId: sourceId, firmScope: source.firm_scope },
    { receiptId: approvalReceiptId },
  );
  const gated = authorizationGate(authz);
  if (gated) return gated;
  const approvalCard = (await getApprovalCard(env, authz.receiptId!))!;

  // Refuse unsafe merges rather than proceed: a MERGED source has no live identity to
  // move (double merge), and a MERGED target would orphan the receipt chain.
  if (source.status === "MERGED") {
    return json({ error: "conflict", detail: "source company is already MERGED" }, { status: 409 });
  }
  if (target.status === "MERGED") {
    return json({ error: "conflict", detail: "target company is MERGED; merging into it is unsafe" }, { status: 409 });
  }

  // 1. Pre-merge snapshot + SHA-256 (Web Crypto) — captured before any write.
  const snapshot = await preMergeSnapshot(env, sourceId, targetId);
  const snapshotJson = JSON.stringify(snapshot);
  const hash = await sha256Hex(snapshotJson);

  // 2. Enumerate every reference row pointing at the source, with full old/new detail.
  const moved: MovedReference[] = [];
  for (const { table, column } of MERGE_REFERENCE_COLUMNS) {
    const rows = await env.WP_OS_DB.prepare(`SELECT id, ${column} AS ref_value FROM ${table} WHERE ${column} = ?1`)
      .bind(sourceId)
      .all<{ id: string; ref_value: string }>();
    for (const row of rows.results ?? []) {
      moved.push({ table, row_id: row.id, column, old_value: sourceId, new_value: targetId });
    }
  }

  // 3. Apply atomically: repoint references, retire the source (never delete), write receipt.
  const receiptId = `imr_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = moved.map((m) =>
    env.WP_OS_DB.prepare(`UPDATE ${m.table} SET ${m.column} = ?2 WHERE id = ?1`).bind(m.row_id, targetId),
  );
  statements.push(
    env.WP_OS_DB.prepare(
      `UPDATE canonical_company
          SET status = 'MERGED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?1`,
    ).bind(sourceId),
  );
  statements.push(
    env.WP_OS_DB.prepare(
      `INSERT INTO identity_merge_receipt
         (id, source_company_id, target_company_id, actor_id, approved_by,
          moved_references_json, pre_merge_snapshot_json, pre_merge_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(receiptId, sourceId, targetId, identity!.id, approvalCard.decided_by, JSON.stringify(moved), snapshotJson, hash),
  );
  await env.WP_OS_DB.batch(statements);

  // Consume the authorization receipt (approved → executed): it can never be replayed.
  await consumeApprovalCard(env, approvalCard.id, { actorId: identity!.id });

  await appendEvent(env, {
    eventType: "identity.company_merged",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "canonical_company",
    objectId: sourceId,
    payload: { source_company_id: sourceId, target_company_id: targetId, merge_receipt_id: receiptId, moved_count: moved.length, approval_card_id: approvalCard.id },
  });

  const receipt = await env.WP_OS_DB.prepare("SELECT * FROM identity_merge_receipt WHERE id = ?1")
    .bind(receiptId)
    .first<MergeReceiptRow>();
  return json({ receipt, moved_references: moved }, { status: 201 });
}

export async function handleReverseMerge(ctx: RouteContext): Promise<Response> {
  const { env, identity, params } = ctx;
  const receiptIdParam = await receiptIdFrom(ctx.request);

  const receipt = await env.WP_OS_DB.prepare("SELECT * FROM identity_merge_receipt WHERE id = ?1")
    .bind(params.receiptId!)
    .first<MergeReceiptRow>();
  if (!receipt) return json({ error: "not_found" }, { status: 404 });

  // THE choke point (P3): reversal carries the same reserved authority as merge
  // (identity_merge.execute, ADR-009), with the merge receipt as the governed object.
  const actor = actorFromIdentity(identity!);
  const authz = await authorize(
    env,
    actor,
    "identity_merge.execute",
    { objectType: "identity_merge_receipt", objectId: receipt.id, firmScope: receipt.firm_scope },
    { receiptId: receiptIdParam },
  );
  const gated = authorizationGate(authz);
  if (gated) return gated;
  const approvalCard = (await getApprovalCard(env, authz.receiptId!))!;

  const already = await env.WP_OS_DB.prepare(
    "SELECT id FROM identity_split_receipt WHERE merge_receipt_id = ?1 LIMIT 1",
  )
    .bind(receipt.id)
    .first<{ id: string }>();
  if (already) {
    return json({ error: "conflict", detail: "merge already reversed", split_receipt_id: already.id }, { status: 409 });
  }

  const moved = JSON.parse(receipt.moved_references_json) as MovedReference[];
  const snapshot = JSON.parse(receipt.pre_merge_snapshot_json) as { canonical_company?: CompanyRow[] };
  const preSource = (snapshot.canonical_company ?? []).find((c) => c.id === receipt.source_company_id);
  if (!preSource) {
    // Receipt provenance incomplete — refuse rather than guess.
    return json({ error: "conflict", detail: "receipt snapshot lacks source company; reversal unsafe" }, { status: 409 });
  }

  // Verify FIRST, change nothing unless every moved reference still sits at its
  // post-merge value; otherwise exact restoration cannot be proven → refuse.
  const conflicts: Array<MovedReference & { current_value: string | null }> = [];
  for (const m of moved) {
    const row = await env.WP_OS_DB.prepare(`SELECT ${m.column} AS ref_value FROM ${m.table} WHERE id = ?1`)
      .bind(m.row_id)
      .first<{ ref_value: string }>();
    if (!row || row.ref_value !== m.new_value) {
      conflicts.push({ ...m, current_value: row?.ref_value ?? null });
    }
  }
  if (conflicts.length > 0) {
    return json(
      { error: "conflict", detail: "references changed since merge; exact reversal cannot be proven", conflicts },
      { status: 409 },
    );
  }

  // Replay the receipt: restore every moved reference to its pre-merge value and
  // reactivate the source company exactly as snapshotted (status + updated_at).
  const restored = moved.map((m) => ({ ...m, restored_value: m.old_value }));
  const splitId = `isr_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = moved.map((m) =>
    env.WP_OS_DB.prepare(`UPDATE ${m.table} SET ${m.column} = ?2 WHERE id = ?1`).bind(m.row_id, m.old_value),
  );
  statements.push(
    env.WP_OS_DB.prepare("UPDATE canonical_company SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(
      receipt.source_company_id,
      preSource.status,
      preSource.updated_at,
    ),
  );
  statements.push(
    env.WP_OS_DB.prepare(
      `INSERT INTO identity_split_receipt (id, merge_receipt_id, restored_company_id, actor_id, restored_references_json)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(splitId, receipt.id, receipt.source_company_id, identity!.id, JSON.stringify(restored)),
  );
  await env.WP_OS_DB.batch(statements);

  // Consume the authorization receipt (approved → executed): it can never be replayed.
  await consumeApprovalCard(env, approvalCard.id, { actorId: identity!.id });

  await appendEvent(env, {
    eventType: "identity.company_split",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "canonical_company",
    objectId: receipt.source_company_id,
    payload: { merge_receipt_id: receipt.id, split_receipt_id: splitId, restored_count: restored.length, approval_card_id: approvalCard.id },
  });

  const split = await env.WP_OS_DB.prepare("SELECT * FROM identity_split_receipt WHERE id = ?1")
    .bind(splitId)
    .first();
  return json({ split_receipt: split, restored_references: restored }, { status: 201 });
}

/**
 * The register as something you can scan.
 *
 * WHY NOT JUST /api/companies. That returns identity rows — name, status, created — which is
 * correct for the identity spine and useless for eyeballing: a partner looking at the list cannot
 * tell an ed-tech company from a beverage brand without opening each one. This joins the two facts
 * that make a company legible at a glance, which live elsewhere: what stage its deal is at, and how
 * much of the fund is in it.
 *
 * MONEY IS READ FROM THE DEAL, and honestly. An opportunity's price and quantity multiply into an
 * amount — but Sensori's are placeholders, so the amount is returned WITH a flag saying the
 * arithmetic rests on stand-ins. A number that cannot be trusted is worse than no number when
 * nothing on screen says which it is.
 */
export async function handleCompanyRegister(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "c.privacy_label");

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT c.id, c.canonical_name, c.sector, c.one_liner, c.website, c.status, c.created_at,
            (SELECT o.status FROM investment_opportunity o
              WHERE o.company_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS deal_status,
            (SELECT o.price_per_share * o.quantity FROM investment_opportunity o
              WHERE o.company_id = c.id AND o.price_per_share IS NOT NULL AND o.quantity IS NOT NULL
              ORDER BY o.created_at DESC LIMIT 1) AS amount_usd,
            (SELECT o.placeholder_fields FROM investment_opportunity o
              WHERE o.company_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS placeholder_fields,
            (SELECT o.relationship_origin FROM investment_opportunity o
              WHERE o.company_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS origin,
            (SELECT COUNT(*) FROM meeting m WHERE m.company_id = c.id) AS meetings
       FROM canonical_company c
      WHERE ${visibility} AND c.status <> 'MERGED'
      ORDER BY c.canonical_name
      LIMIT 500`,
  ).all<Record<string, unknown>>();

  const companies: Array<Record<string, unknown>> = (rows.results ?? []).map((r) => {
    let provisional: string[] = [];
    try {
      provisional = JSON.parse(String(r.placeholder_fields ?? "[]")) as string[];
    } catch {
      provisional = [];
    }
    return {
      ...r,
      placeholder_fields: undefined,
      // The amount is arithmetic over values that may be stand-ins. Say so rather than showing a
      // confident number nobody can tell is invented.
      amount_is_provisional: provisional.length > 0,
    };
  });

  const sectors = [...new Set(companies.map((c) => c.sector).filter(Boolean))].sort();
  return json({ companies, sectors, count: companies.length });
}

// ── What has been done to this company ──

/**
 * The record of every change to a company, read back.
 *
 * Operator, item 9: "History button does nothing" and "need an edit trail". There was no history to
 * show — `handleUpdateCompany` appended no event, so nothing was ever written to read back. The
 * button was not broken; the trail did not exist.
 *
 * EVERYTHING ABOUT THE COMPANY, not only edits to it. A partner asking "what has happened with
 * Sensori" means the deal moving, the deck arriving, the pass, and the sector being corrected — all
 * of it. Splitting those across four surfaces is how a person ends up reconstructing a timeline by
 * memory.
 */
export async function handleCompanyHistory(ctx: RouteContext): Promise<Response> {
  const company = await getCompanyById(ctx.env, ctx.params.id!);
  if (!company) return json({ error: "not_found" }, { status: 404 });

  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT e.id, e.event_type, e.actor_type, e.actor_id, e.created_at, e.payload_json,
              COALESCE(u.full_name, e.actor_id) AS actor_name
         FROM event_record e
         LEFT JOIN firm_user u ON u.id = e.actor_id
        WHERE (e.object_type = 'canonical_company' AND e.object_id = ?1)
           OR (e.object_type = 'investment_opportunity' AND e.object_id IN (
                 SELECT id FROM investment_opportunity WHERE company_id = ?1))
        ORDER BY e.created_at DESC
        LIMIT 200`,
    )
      .bind(company.id)
      .all<{
        id: string;
        event_type: string;
        actor_type: string;
        actor_id: string;
        actor_name: string;
        created_at: string;
        payload_json: string;
      }>()
  ).results ?? [];

  return json({
    company: company.canonical_name,
    entries: rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      /*
       * A field-by-field line for an edit, because "somebody edited this company" is not a useful
       * sentence. The question a partner asks months later is "who changed the sector, and what was
       * it before" — so the answer is written out rather than left as JSON for them to read.
       */
      const changes = payload.changes as Record<string, { from: unknown; to: unknown }> | undefined;
      const said =
        r.event_type === "company.updated" && changes
          ? Object.entries(changes)
              .map(([f, c]) => `${f.split("_").join(" ")}: ${c.from ?? "(blank)"} → ${c.to ?? "(blank)"}`)
              .join("; ")
          : null;
      return {
        id: r.id,
        at: r.created_at,
        by: r.actor_type === "ai_employee" ? `${r.actor_id} (AI)` : r.actor_name,
        what: r.event_type,
        said,
      };
    }),
  });
}
