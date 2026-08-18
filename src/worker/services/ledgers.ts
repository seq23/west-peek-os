import { json } from "../router";
import type { RouteContext } from "../router";

/**
 * The Decision Journal and the Evidence Ledger (P35, V1 #10 and #34).
 *
 * Both were "spine only" in the 17 Aug 2026 audit: the data existed, was append-only, was
 * governed, and had nowhere to be read. Decisions were recorded in four separate tables that
 * nobody could look at together, and claims carried full provenance that no page displayed.
 *
 * NEITHER OF THESE WRITES ANYTHING. They are queries. That is the entire point — a journal that
 * can edit its entries is not a journal, and every one of these source tables already rejects
 * UPDATE at the database layer (D15). Reading them through one surface changes nothing about how
 * they are written.
 *
 * WHY THE JOURNAL IS A UNION AND NOT A NEW TABLE. The obvious implementation is a `decision_journal`
 * table that everything writes to as well. That would be a second copy of a fact whose original is
 * already append-only — two records that can disagree, and a write path that can silently miss a
 * decision type. Reading the four sources directly means the journal cannot drift from what
 * actually happened, and a new decision table is a change here rather than a migration plus a
 * backfill.
 */

export interface JournalEntry {
  kind: "IC" | "APPROVAL" | "BUILD_VS_BUY" | "SOURCE_CONFLICT";
  id: string;
  decision: string;
  rationale: string | null;
  decided_by: string;
  decided_at: string;
  /** What the decision was about, so an entry is legible without opening it. */
  subject: string | null;
  /** Where to go to see it in full. */
  object_type: string;
  object_id: string;
}

/**
 * GET /api/decisions — every decision the firm has made, newest first.
 *
 * Four UNIONed sources. Each SELECT is written out rather than generated so the column mapping is
 * visible: these tables genuinely differ, and a clever abstraction over them would hide that
 * `ic_decision.decision` is APPROVE/REJECT/DEFER while `build_vs_buy_decision.decision` is
 * BUILD/BUY/DEFER.
 */
export async function handleListDecisions(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const kind = url.searchParams.get("kind");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM (
       SELECT 'IC' AS kind, d.id, d.decision, d.rationale,
              d.decided_by, d.created_at AS decided_at,
              c.canonical_name AS subject,
              'ic_packet' AS object_type, d.ic_packet_id AS object_id
         FROM ic_decision d
         LEFT JOIN ic_packet p ON p.id = d.ic_packet_id
         LEFT JOIN investment_opportunity o ON o.id = p.opportunity_id
         LEFT JOIN canonical_company c ON c.id = o.company_id

       UNION ALL
       SELECT 'APPROVAL', ad.id, ad.decision, ad.note,
              ad.decided_by, ad.created_at,
              ac.title,
              'approval_card', ad.approval_card_id
         FROM approval_decision ad
         LEFT JOIN approval_card ac ON ac.id = ad.approval_card_id

       UNION ALL
       SELECT 'BUILD_VS_BUY', b.id, b.decision, b.rationale,
              b.decided_by, b.created_at,
              cap.name,
              'capability', b.capability_id
         FROM build_vs_buy_decision b
         LEFT JOIN capability cap ON cap.id = b.capability_id

       UNION ALL
       SELECT 'SOURCE_CONFLICT', s.id, s.winning_source, s.rationale,
              s.decided_by, s.created_at,
              NULL,
              'source_conflict', s.source_conflict_id
         FROM source_resolution_decision s
     )
     WHERE (?1 IS NULL OR kind = ?1)
     ORDER BY decided_at DESC, id DESC
     LIMIT ?2`,
  )
    .bind(kind, limit)
    .all<JournalEntry>();

  const entries = rows.results ?? [];
  return json({
    entries,
    counts: entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {}),
    // Stated so nobody mistakes a filtered or truncated view for the whole history.
    truncated: entries.length === limit,
  });
}

/**
 * GET /api/evidence-ledger — every claim with its provenance.
 *
 * Canon §17.5 and the evidence model: a claim without a source is not evidence. This lists claims
 * WITH their source rows attached, so the ledger answers "how do we know this" rather than "what
 * do we believe".
 */
export async function handleEvidenceLedger(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 500);

  const claims = await ctx.env.WP_OS_DB.prepare(
    `SELECT c.id, c.claim_text, c.claim_status, c.confidence, c.company_id,
            comp.canonical_name AS company_name,
            c.created_at, c.superseded_by
       FROM diligence_claim c
       LEFT JOIN canonical_company comp ON comp.id = c.company_id
      WHERE (?1 IS NULL OR c.claim_status = ?1)
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?2`,
  )
    .bind(status, limit)
    .all<Record<string, unknown>>();

  const list = claims.results ?? [];
  const ids = list.map((c) => String(c.id));

  // One query for all sources rather than N+1. An empty IN () is invalid SQL, hence the guard.
  const sources = ids.length
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT claim_id, source_type, location, source_date, method, note, document_version_id
           FROM claim_source
          WHERE claim_id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all<Record<string, unknown>>()
    : { results: [] as Array<Record<string, unknown>> };

  const byClaim = new Map<string, Array<Record<string, unknown>>>();
  for (const s of sources.results ?? []) {
    const k = String(s.claim_id);
    if (!byClaim.has(k)) byClaim.set(k, []);
    byClaim.get(k)!.push(s);
  }

  return json({
    claims: list.map((c) => ({
      ...c,
      sources: byClaim.get(String(c.id)) ?? [],
      // The distinction the ledger exists to make visible. A claim with no source row is not a
      // weak claim, it is an unsupported assertion — and it should be obvious at a glance.
      unsourced: (byClaim.get(String(c.id)) ?? []).length === 0,
    })),
    truncated: list.length === limit,
  });
}

/**
 * GET /api/work-queues — what every AI employee is holding (V1 #35).
 *
 * Work cards grouped by owner. Canon promises "AI employee work queues"; the cards existed and
 * there was no way to see them per employee, which is the only view that answers "is anyone
 * actually doing this".
 */
export async function handleWorkQueues(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT w.id, w.title, w.state, w.owner_type, w.owner_id, w.due_at, w.next_action,
            e.name AS owner_name, e.role AS owner_role, e.status AS owner_status
       FROM work_card w
       LEFT JOIN ai_employee e ON e.id = w.owner_id AND w.owner_type = 'AI'
      WHERE w.state IN ('OPEN','IN_PROGRESS','BLOCKED')
      ORDER BY w.owner_type, COALESCE(e.name, w.owner_id), w.due_at`,
  ).all<Record<string, unknown>>();

  const cards = rows.results ?? [];
  const queues = new Map<string, { owner_type: string; owner_id: string | null; owner_name: string; cards: unknown[] }>();
  for (const c of cards) {
    const key = `${c.owner_type}:${c.owner_id ?? "none"}`;
    if (!queues.has(key)) {
      queues.set(key, {
        owner_type: String(c.owner_type),
        owner_id: c.owner_id ? String(c.owner_id) : null,
        owner_name: String(c.owner_name ?? (c.owner_type === "UNASSIGNED" ? "Unassigned" : c.owner_id ?? "Unknown")),
        cards: [],
      });
    }
    queues.get(key)!.cards.push(c);
  }

  return json({
    queues: Array.from(queues.values()),
    // A blocked card in someone's queue is the thing worth acting on, so it is counted separately
    // rather than buried in a total.
    blocked_count: cards.filter((c) => c.state === "BLOCKED").length,
    total_open: cards.length,
  });
}
