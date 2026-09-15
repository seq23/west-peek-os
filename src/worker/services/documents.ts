import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { privacyLabelSchema } from "../../shared/privacy";
import { DOCUMENT_TYPES, documentTypeLabel, normaliseDocumentType } from "../../shared/documents/types";

/**
 * Documents (P5, D16): governed binary storage. Binary content lives ONLY in the
 * R2 binding WP_OS_DOCUMENTS; D1 holds metadata/provenance (document +
 * document_version with SHA-256). Versions are immutable at the database layer
 * (migration 0005 triggers).
 *
 * Upload encoding: base64 JSON (`content_base64`) — the API is JSON-first and this
 * keeps upload exercisable from tests/e2e without multipart parsing. Downloads are
 * raw bytes from an authenticated route.
 *
 * Degraded mode (§3.5): when the R2 binding is absent, every document operation
 * fails VISIBLY with 503 documents_degraded — never silently.
 */

export class DocumentError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export interface DocumentRow {
  id: string;
  title: string;
  doc_type: string;
  privacy_label: string;
  firm_scope: string;
  current_version_id: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface DocumentVersionRow {
  id: string;
  document_id: string;
  version_no: number;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  created_by: string;
  firm_scope: string;
  created_at: string;
}

/** Uploads are base64 JSON; keep individual uploads modest (5 MiB decoded). */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(content: string): Uint8Array {
  try {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  } catch {
    throw new DocumentError(400, "invalid_base64", "content_base64 is not valid base64");
  }
}

function requireR2(env: Env): R2Bucket {
  if (typeof env.WP_OS_DOCUMENTS === "undefined") {
    throw new DocumentError(
      503,
      "documents_degraded",
      "document storage is unavailable: R2 binding WP_OS_DOCUMENTS is not configured (degraded mode, §3.5)",
    );
  }
  return env.WP_OS_DOCUMENTS;
}

export async function getDocument(env: Env, id: string): Promise<DocumentRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM document WHERE id = ?1").bind(id).first<DocumentRow>();
}

export async function getDocumentVersion(env: Env, id: string): Promise<DocumentVersionRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM document_version WHERE id = ?1").bind(id).first<DocumentVersionRow>();
}

export interface UploadDocumentInput {
  title: string;
  doc_type: string;
  privacy_label?: string;
  content_base64: string;
  content_type: string;
}

async function storeVersion(
  env: Env,
  actor: Actor,
  documentId: string,
  versionNo: number,
  bytes: Uint8Array,
  contentType: string,
  firmScope: string,
): Promise<DocumentVersionRow> {
  const bucket = requireR2(env);
  const sha256 = await sha256Hex(bytes);
  const versionId = `dver_${crypto.randomUUID()}`;
  const r2Key = `${firmScope}/${documentId}/v${versionNo}-${sha256}`;
  await bucket.put(r2Key, bytes);
  await env.WP_OS_DB.prepare(
    `INSERT INTO document_version (id, document_id, version_no, r2_key, sha256, size_bytes, content_type, created_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(versionId, documentId, versionNo, r2Key, sha256, bytes.byteLength, contentType, actor.firmUserId ?? "system", firmScope)
    .run();
  return (await getDocumentVersion(env, versionId))!;
}

/** Upload a new document (version 1). R2 put + metadata + SHA-256 version row. */
export async function uploadDocument(env: Env, actor: Actor, input: UploadDocumentInput): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "document.upload", { objectType: "document", firmScope });
  if (authz.decision === "DENY") throw new DocumentError(403, "forbidden", authz.reason);

  const bytes = decodeBase64(input.content_base64);
  if (bytes.byteLength === 0) throw new DocumentError(400, "empty_content", "document content is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new DocumentError(413, "too_large", `document exceeds the ${MAX_UPLOAD_BYTES}-byte upload limit`);
  }

  const docId = `doc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO document (id, title, doc_type, privacy_label, firm_scope, current_version_id, uploaded_by)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`,
  )
    .bind(docId, input.title, input.doc_type, input.privacy_label ?? "INTERNAL", firmScope, actor.firmUserId ?? "system")
    .run();
  const version = await storeVersion(env, actor, docId, 1, bytes, input.content_type, firmScope);
  await env.WP_OS_DB.prepare("UPDATE document SET current_version_id = ?2 WHERE id = ?1").bind(docId, version.id).run();

  await appendEvent(env, {
    eventType: "document.uploaded",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "document",
    objectId: docId,
    firmScope,
    payload: { title: input.title, doc_type: input.doc_type, version_id: version.id, sha256: version.sha256, size_bytes: version.size_bytes },
  });
  return { document: (await getDocument(env, docId))!, version };
}

/** Add a new version to an existing document; prior versions remain readable. */
export async function addDocumentVersion(
  env: Env,
  actor: Actor,
  documentId: string,
  input: Pick<UploadDocumentInput, "content_base64" | "content_type">,
): Promise<DocumentVersionRow> {
  const doc = await getDocument(env, documentId);
  if (!doc) throw new DocumentError(404, "not_found");
  const authz = await authorize(env, actor, "document.upload", { objectType: "document", objectId: documentId, firmScope: doc.firm_scope });
  if (authz.decision === "DENY") throw new DocumentError(403, "forbidden", authz.reason);

  const bytes = decodeBase64(input.content_base64);
  if (bytes.byteLength === 0) throw new DocumentError(400, "empty_content", "document content is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new DocumentError(413, "too_large", `document exceeds the ${MAX_UPLOAD_BYTES}-byte upload limit`);
  }

  const latest = await env.WP_OS_DB.prepare("SELECT MAX(version_no) AS max_v FROM document_version WHERE document_id = ?1")
    .bind(documentId)
    .first<{ max_v: number }>();
  const version = await storeVersion(env, actor, documentId, (latest?.max_v ?? 0) + 1, bytes, input.content_type, doc.firm_scope);
  await env.WP_OS_DB.prepare("UPDATE document SET current_version_id = ?2 WHERE id = ?1").bind(documentId, version.id).run();

  await appendEvent(env, {
    eventType: "document.version_added",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "document",
    objectId: documentId,
    firmScope: doc.firm_scope,
    payload: { version_id: version.id, version_no: version.version_no, sha256: version.sha256, size_bytes: version.size_bytes },
  });
  return version;
}

// ── HTTP handlers ──

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * POST /api/documents/archive-all — everything on the shelf, off it, in one act. Operator, 15 Sep
 * 2026: "i should be able to archive ALL documents as 1 function". The current deck and a version
 * waiting on a decision stay: they are retired on Fund strategy, not here. One reason, every row,
 * every row on the spine.
 */
export async function handleArchiveAllDocuments(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "document.archive", { objectType: "document", objectId: "all" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const body = (await ctx.request.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    return json({ error: "reason_required", detail: "Say why in a few words. It goes on every document you take off the shelf." }, { status: 400 });
  }
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT d.id, d.title, dv.version_no, dv.state FROM document d LEFT JOIN deck_version dv ON dv.document_id = d.id AND dv.state IN ('CURRENT','PROPOSED')
        WHERE ${visibility} AND d.archived_at IS NULL`,
    ).all<{ id: string; title: string; version_no: number | null; state: string | null }>()
  ).results ?? [];
  const kept = rows.filter((r) => r.version_no !== null);
  const going = rows.filter((r) => r.version_no === null);
  for (const doc of going) {
    await ctx.env.WP_OS_DB.prepare(
      `UPDATE document SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?2, archive_reason = ?3 WHERE id = ?1 AND archived_at IS NULL`,
    )
      .bind(doc.id, actor.firmUserId ?? "system", reason.slice(0, 400))
      .run();
    await appendEvent(ctx.env, {
      eventType: "document.archived",
      actorType: "firm_user",
      actorId: actor.firmUserId ?? "system",
      objectType: "document",
      objectId: doc.id,
      firmScope: actor.firmScopes[0] ?? "west-peek",
      payload: { title: doc.title, reason: reason.slice(0, 400), via: "archive_all" },
    });
  }
  return json({
    archived: going.length,
    kept: kept.map((k) => ({ id: k.id, title: k.title, version_no: k.version_no, state: k.state })),
    note:
      `${going.length} taken off the shelf.` +
      (kept.length ? ` Kept: ${kept.map((k) => `v${k.version_no} (${k.state === "CURRENT" ? "the deck the firm sends" : "waiting on your decision"})`).join(", ")}.` : ""),
  });
}

/** POST /api/documents/:id/restore — back on the shelf, with the trail kept on the spine. */
export async function handleRestoreDocument(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "document.archive", { objectType: "document", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  const doc = await ctx.env.WP_OS_DB.prepare("SELECT * FROM document WHERE id = ?1").bind(ctx.params.id!).first<DocumentRow & { archived_at: string | null; archive_reason: string | null }>();
  if (!doc) return json({ error: "not_found" }, { status: 404 });
  if (!doc.archived_at) return json({ error: "not_archived", detail: "This is already on the shelf." }, { status: 409 });
  await ctx.env.WP_OS_DB.prepare("UPDATE document SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?1").bind(doc.id).run();
  await appendEvent(ctx.env, {
    eventType: "document.restored",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "document",
    objectId: doc.id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { title: doc.title, had_been_archived_for: doc.archive_reason },
  });
  return json({ id: doc.id, archived: false, note: "Back on the shelf." });
}

/** Pages in a PDF, counted from its object table; null when the bytes are not a PDF. */
export function countPdfPages(base64: string): number | null {
  try {
    const bytes = atob(base64);
    if (!bytes.startsWith("%PDF")) return null;
    const n = (bytes.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof DocumentError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const uploadSchema = z.object({
  title: z.string().trim().min(1),
  doc_type: z.string().trim().min(1),
  privacy_label: privacyLabelSchema.optional(),
  content_base64: z.string().min(1),
  content_type: z.string().trim().min(1),
  /**
   * What this file is about, attached in the same call that stores it.
   *
   * Optional, and a separate route exists for attaching later — but offered here because the moment
   * somebody has the deck in their hand is the moment they know which company it belongs to. Making
   * them upload first and attach second is how a document ends up on a general shelf with a title
   * somebody typed as its only clue.
   */
  about: z
    .object({
      object_type: z.enum(["canonical_company", "investment_opportunity", "lp_record", "event"]),
      object_id: z.string().trim().min(1),
      role: z.enum(["DECK", "MEMO", "FINANCIALS", "LEGAL", "OTHER"]).default("OTHER"),
      note: z.string().trim().max(500).optional(),
    })
    .optional(),
});

const versionSchema = z.object({
  content_base64: z.string().min(1),
  content_type: z.string().trim().min(1),
});

export async function handleUploadDocument(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const actor = actorFromIdentity(ctx.identity!);
    const docType = normaliseDocumentType(parsed.data.doc_type);
    /*
     * A DECK UPLOADED HERE IS A DECK VERSION, NOT A LOOSE FILE. Operator, 15 Sep 2026: she uploaded
     * the current Canva deck on Documents, it was filed as a `diligence_note` with the title she
     * typed, and Fund strategy went on pointing at a version from a week earlier — "where is the
     * section for the current deck to stay?!". One door: whichever page a deck comes in through,
     * it lands on the record as vN and waits on her decision on Fund strategy.
     */
    if (docType === "DECK") {
      const { recordDeckVersion, theFund } = await import("./deck");
      const fund = await theFund(ctx.env);
      const row = await recordDeckVersion(ctx.env, actor, {
        fundId: fund.id,
        title: parsed.data.title,
        origin: "UPLOADED",
        createdBy: ctx.identity!.fullName,
        createdByType: "HUMAN",
        pdfBase64: parsed.data.content_base64,
        pageCount: countPdfPages(parsed.data.content_base64),
      });
      const document = await getDocument(ctx.env, row.document_id!);
      return json(
        {
          ...document,
          deck_version: { id: row.id, version_no: row.version_no, state: row.state },
          note: `Recorded as v${row.version_no} of the deck. It is not the deck the firm sends until you approve it on Fund strategy.`,
        },
        { status: 201 },
      );
    }
    const { document, version } = await uploadDocument(ctx.env, actor, { ...parsed.data, doc_type: docType });
    let link: string | null = null;
    if (parsed.data.about) {
      link = await linkDocument(ctx.env, actor, document.id, parsed.data.about);
    }
    return json({ ...document, version, ...(link ? { link_id: link } : {}) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAddDocumentVersion(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = versionSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const version = await addDocumentVersion(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data);
    return json(version, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListDocuments(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  // ARCHIVED IS OFF THE SHELF. `?archived=1` shows what was taken off it and by whom — the half of
  // removal-with-a-trail that a hard delete cannot offer. (Phrased without a quoted SQL keyword on
  // purpose: validate:sql scans string literals, and the previous wording read as a statement.)
  const wantArchived = new URL(ctx.request.url).searchParams.get("archived") === "1";
  const shelf = wantArchived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT d.*, dv.version_no AS deck_version_no, dv.state AS deck_state, dv.id AS deck_version_id
       FROM document d
       LEFT JOIN deck_version dv ON dv.document_id = d.id
      WHERE ${visibility} AND ${shelf}
      ORDER BY d.created_at DESC, d.id LIMIT 200`,
  ).all<DocumentRow & { deck_version_no: number | null; deck_state: string | null; deck_version_id: string | null }>();
  // SAID IN WORDS, AND SAID WHICH VERSION. "i should know which one is v14 in documents" — every
  // deck row carries its version number and state; every row carries its type as a label.
  const documents = (rows.results ?? []).map((d) => ({
    ...d,
    type_label: documentTypeLabel(d.doc_type),
    deck: d.deck_version_no
      ? { version_no: d.deck_version_no, state: d.deck_state, id: d.deck_version_id }
      : null,
  }));
  return json({
    documents,
    types: DOCUMENT_TYPES,
    archived: wantArchived,
    note: wantArchived
      ? "Archived documents. Nothing was destroyed — each one records who took it off the shelf and why."
      : "The shelf. Archived documents are kept and readable at ?archived=1.",
  });
}

/**
 * Take a document off the shelf.
 *
 * NOT A DELETE, and the difference is the point. The event spine is append-only, deliverables
 * reference documents by id, and the bytes live in R2 — destroying the row would break those
 * references and erase the history the operator asked to keep. So the document leaves every list
 * and the record of its removal survives: who, when, and why.
 *
 * A reason is required. "Deleted by Sequoia" answers nothing six months later; "duplicate of the
 * 19 Aug review" answers it completely, and the cost of asking is one sentence.
 */
export async function handleArchiveDocument(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "document.archive", { objectType: "document", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = (await ctx.request.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) {
    return json(
      { error: "reason_required", detail: "Say why in a few words. Six months from now the reason is the only part that still helps." },
      { status: 400 },
    );
  }

  const doc = await ctx.env.WP_OS_DB.prepare("SELECT * FROM document WHERE id = ?1").bind(ctx.params.id!).first<DocumentRow>();
  if (!doc) return json({ error: "not_found" }, { status: 404 });
  if ((doc as unknown as { archived_at: string | null }).archived_at) {
    return json({ error: "already_archived", detail: "This is already off the shelf." }, { status: 409 });
  }
  // THE DECK THE FIRM SENDS, AND ONE WAITING ON A DECISION, CANNOT BE ARCHIVED FROM HERE. She
  // archived v14 "accidentally b/c nothing in documents had the title name v14"; a version is
  // retired by being superseded or sent back on Fund strategy, never by vanishing off the shelf.
  const live = await ctx.env.WP_OS_DB.prepare("SELECT version_no, state FROM deck_version WHERE document_id = ?1 AND state IN ('CURRENT','PROPOSED')")
    .bind(doc.id)
    .first<{ version_no: number; state: string }>();
  if (live) {
    return json(
      {
        error: "deck_version_live",
        detail:
          live.state === "CURRENT"
            ? `This is v${live.version_no}, the deck the firm sends. It leaves the shelf only when another version replaces it on Fund strategy.`
            : `This is v${live.version_no}, waiting on your decision on Fund strategy. Approve it or send it back there; it is not archived from here.`,
      },
      { status: 409 },
    );
  }

  await ctx.env.WP_OS_DB.prepare(
    `UPDATE document
        SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), archived_by = ?2, archive_reason = ?3
      WHERE id = ?1`,
  )
    .bind(doc.id, actor.firmUserId ?? "system", reason.slice(0, 400))
    .run();

  await appendEvent(ctx.env, {
    eventType: "document.archived",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "document",
    objectId: doc.id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { title: doc.title, reason: reason.slice(0, 400) },
  });

  return json({
    id: doc.id,
    archived: true,
    note: "Off the shelf. Nothing was destroyed — it is readable under archived documents, with your reason attached.",
  });
}

export async function handleGetDocument(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const doc = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM document WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<DocumentRow>();
  if (!doc) return json({ error: "not_found" }, { status: 404 });
  const versions = await ctx.env.WP_OS_DB.prepare("SELECT * FROM document_version WHERE document_id = ?1 ORDER BY version_no")
    .bind(doc.id)
    .all<DocumentVersionRow>();
  return json({ ...doc, versions: versions.results ?? [] });
}

/** Authenticated byte download; `?version=N` selects a non-current version. */
export async function handleDownloadDocument(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "privacy_label");
  const doc = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM document WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<DocumentRow>();
  if (!doc) return json({ error: "not_found" }, { status: 404 });

  const url = new URL(ctx.request.url);
  const versionParam = url.searchParams.get("version");
  const version = versionParam
    ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM document_version WHERE document_id = ?1 AND version_no = ?2")
        .bind(doc.id, Number(versionParam))
        .first<DocumentVersionRow>()
    : doc.current_version_id
      ? await getDocumentVersion(ctx.env, doc.current_version_id)
      : null;
  if (!version) return json({ error: "version_not_found" }, { status: 404 });

  try {
    const bucket = requireR2(ctx.env);
    const object = await bucket.get(version.r2_key);
    if (!object) {
      return json({ error: "content_missing", detail: "version row exists but R2 object is absent" }, { status: 503 });
    }
    const bytes = await object.arrayBuffer();
    return new Response(bytes, {
      headers: {
        "content-type": version.content_type,
        "x-content-sha256": version.sha256,
        "x-document-version": String(version.version_no),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}


// ── What a document is about ──

/**
 * Record that a stored document concerns a company, a deal, an LP or an event.
 *
 * A LINK AND NOT A COLUMN, because one document legitimately concerns more than one thing — a
 * sector report covers four companies, a data-room artifact belongs to an LP and a fund — and a
 * `company_id` on the document forces a choice that is wrong for those.
 *
 * The version is deliberately not pinned. Versions are immutable and the link is to the DOCUMENT,
 * so "the deck for this deal" follows it forward when the founder sends v2 — which is what anybody
 * means by it. Pinning would make the link go stale the moment the deck improved.
 */
export async function linkDocument(
  env: Env,
  actor: Actor,
  documentId: string,
  about: { object_type: string; object_id: string; role?: string; note?: string },
): Promise<string> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "document.link", {
    objectType: "document",
    objectId: documentId,
    firmScope,
  });
  if (authz.decision !== "ALLOW") throw new DocumentError(403, "forbidden", authz.reason ?? "not allowed");

  const id = `dl_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO document_link (id, document_id, object_type, object_id, role, note, firm_scope, linked_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, documentId, about.object_type, about.object_id, about.role ?? "OTHER", about.note ?? null, firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();

  await appendEvent(env, {
    eventType: "document.linked",
    actorType: actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: about.object_type,
    objectId: about.object_id,
    firmScope,
    payload: { document_id: documentId, role: about.role ?? "OTHER" },
  });
  return id;
}

const linkSchema = z.object({
  object_type: z.enum(["canonical_company", "investment_opportunity", "lp_record", "event"]),
  object_id: z.string().trim().min(1),
  role: z.enum(["DECK", "MEMO", "FINANCIALS", "LEGAL", "OTHER"]).default("OTHER"),
  note: z.string().trim().max(500).optional(),
});

export async function handleLinkDocument(ctx: RouteContext): Promise<Response> {
  const parsed = linkSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const id = await linkDocument(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data);
    return json({ id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Everything attached to one thing — what a deal page asks for. */
export async function handleListLinkedDocuments(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const objectType = url.searchParams.get("object_type");
  const objectId = url.searchParams.get("object_id");
  if (!objectType || !objectId) {
    return json({ error: "invalid_input", detail: "object_type and object_id are required" }, { status: 400 });
  }
  const rows = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT l.id AS link_id, l.role, l.note, l.created_at,
              d.id AS document_id, d.title, d.doc_type, d.current_version_id
         FROM document_link l
         JOIN document d ON d.id = l.document_id
        WHERE l.object_type = ?1 AND l.object_id = ?2
        ORDER BY l.created_at DESC`,
    )
      .bind(objectType, objectId)
      .all()
  ).results ?? [];
  return json({ documents: rows });
}
