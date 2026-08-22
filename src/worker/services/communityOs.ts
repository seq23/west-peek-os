import { z } from "zod";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import type { Env } from "../env";
import { actorFromIdentity, authorize } from "./authorize";

/**
 * Community OS — an INTERPRETATION LAYER over the community population (P33, canon §14, §12A.4).
 *
 * WHAT THIS OWNS (§12A.4): segmentation, engagement read, and what someone's community behaviour
 * suggests for the firm — sourcing, portfolio support, programming, ambassador potential.
 *
 * WHAT IT DOES NOT OWN: the membership record. Canon §12A.2 gives person records, contact fields
 * and "community membership fields" to NETWORK OS. `display_name` here is a non-authoritative
 * cache so a row can be read before Network OS resolution; `membership_source` says which state it
 * is in. The first version of this module stored a roster and was wrong — a second source of truth
 * for who is a member, which §0E.4 forbids.
 *
 * HOW IT DIFFERS FROM RELATIONSHIP OS (§12A.3): Relationship OS reasons about ONE relationship —
 * the warm path, the next move, the promise made. Community OS reasons about the POPULATION —
 * which segment is going quiet, who behaves like a scout. Same people, different unit of analysis.
 *
 * Still scaffolding: no cohort analytics, no programming, no automated signal detection.
 *
 * DISAMBIGUATION for whoever reads this next: the `west-peek-community` repository is the marketing
 * website at joinwestpeek.com and is unrelated to this module. The audit conflated them on
 * 17 Aug 2026 and the operator corrected it; the note is here so the mistake is not repeated.
 */

export interface MemberRow {
  id: string;
  person_id: string | null;
  display_name: string;
  member_type: string;
  status: string;
  joined_at: string | null;
  notes: string | null;
  segment: string;
  engagement: string;
  signal_note: string | null;
  membership_source: string;
  firm_scope: string;
  created_at: string;
}

const memberSchema = z.object({
  display_name: z.string().min(1).max(160),
  person_id: z.string().max(80).nullish(),
  member_type: z.enum(["MEMBER", "FOUNDER", "OPERATOR", "INVESTOR", "ALUMNI"]).default("MEMBER"),
  status: z.enum(["PROSPECT", "ACTIVE", "LAPSED", "REMOVED"]).default("ACTIVE"),
  joined_at: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
  segment: z.enum(["UNSEGMENTED", "CORE", "CONTRIBUTOR", "AMBASSADOR", "SCOUT", "LAPSING", "OBSERVER"]).default("UNSEGMENTED"),
  engagement: z.enum(["UNKNOWN", "HIGH", "STEADY", "FADING", "DORMANT"]).default("UNKNOWN"),
  signal_note: z.string().max(1000).nullish(),
});

export async function handleListMembers(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM com_member ORDER BY status, display_name LIMIT 500",
  ).all<MemberRow>();
  const results = rows.results ?? [];
  return json({
    members: results,
    // Counts by status, computed here so the page does not have to re-derive them and drift.
    counts: results.reduce<Record<string, number>>((acc, m) => {
      acc[m.status] = (acc[m.status] ?? 0) + 1;
      return acc;
    }, {}),
  });
}

export async function handleUpsertMember(ctx: RouteContext): Promise<Response> {
  const parsed = memberSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  const scope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(ctx.env, actor, "community.manage", { objectType: "com_member", firmScope: scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const id = `cmm_${crypto.randomUUID()}`;
  const d = parsed.data;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO com_member (id, person_id, display_name, member_type, status, joined_at, notes,
                             segment, engagement, signal_note, membership_source, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (firm_scope, display_name) DO UPDATE SET
       member_type = excluded.member_type,
       status      = excluded.status,
       joined_at   = COALESCE(excluded.joined_at, com_member.joined_at),
       notes       = COALESCE(excluded.notes, com_member.notes),
       segment     = excluded.segment,
       engagement  = excluded.engagement,
       signal_note = COALESCE(excluded.signal_note, com_member.signal_note),
       person_id   = COALESCE(excluded.person_id, com_member.person_id)`,
  )
    .bind(id, d.person_id ?? null, d.display_name, d.member_type, d.status, d.joined_at ?? null, d.notes ?? null,
          d.segment, d.engagement, d.signal_note ?? null,
          // Resolved to a canonical person means the membership came from Network OS; otherwise
          // this row is an interpretation of somebody we have not reconciled yet, and says so.
          d.person_id ? "NETWORK_OS" : "LOCAL_UNRESOLVED",
          scope, actor.firmUserId ?? "system")
    .run();

  await appendEvent(ctx.env, {
    eventType: "community.member_upserted",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "com_member",
    objectId: id,
    firmScope: scope,
    payload: { display_name: d.display_name, status: d.status },
  });

  const row = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM com_member WHERE firm_scope = ?1 AND display_name = ?2",
  )
    .bind(scope, d.display_name)
    .first<MemberRow>();
  return json(row, { status: 201 });
}

// ── The birds-eye view ─────────────────────────────────────────────────────────

/**
 * What the community IS, as a population.
 *
 * Operator, 21 Aug 2026, on what this tab is for: "introduction and algorithmic matching and a
 * birds eye view of what our community is like" — and, on what should happen when Network OS holds
 * five thousand people: "should it mirror all those names or only just be the algorithmic page?"
 *
 * IT DOES NOT MIRROR. Network OS owns the roster and this app reads a SHAPE off it. A copy of five
 * thousand contacts would be a second database that drifts, and a five-thousand-row list is not a
 * surface anybody makes a decision on. What only this app can say is what the population means to
 * the fund, which is what this returns.
 *
 * COUNTED IN SQL, ON PURPOSE. The Worker runs on a 10 ms CPU budget; `JSON.parse` across five
 * thousand snapshot rows would spend it and fail exactly when the community finally got big enough
 * to be interesting. `json_extract` pushes the work into D1, so this stays a handful of GROUP BY
 * queries whether the community is thirty people or fifty thousand.
 *
 * The categories are NOT invented here. Network OS's `ContactRecord.person_type` already carries
 * investor / founder / operator / lawyer / service_provider / media / general — the operator's own
 * four categories and then some — so this reads that field rather than imposing a second taxonomy
 * that would immediately disagree with it.
 */

const CONTACT_MAPPINGS = "FROM network_external_mapping WHERE resource = 'contact' AND firm_scope = ?1";

export interface PopulationSlice {
  key: string;
  count: number;
  /** Rounded to one decimal; the page should never do arithmetic on a total it did not compute. */
  pct: number;
}

function slices(rows: Array<{ k: string | null; n: number }>, total: number): PopulationSlice[] {
  return rows
    .map((r) => ({
      key: (r.k ?? "unknown").toLowerCase(),
      count: r.n,
      pct: total > 0 ? Math.round((r.n / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

export async function communityPopulation(env: Env, firmScope: string) {
  const totalRow = await env.WP_OS_DB.prepare(`SELECT COUNT(*) AS n ${CONTACT_MAPPINGS}`)
    .bind(firmScope)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const byType = (
    await env.WP_OS_DB.prepare(
      `SELECT json_extract(snapshot_json, '$.person_type') AS k, COUNT(*) AS n ${CONTACT_MAPPINGS} GROUP BY k`,
    )
      .bind(firmScope)
      .all<{ k: string | null; n: number }>()
  ).results ?? [];

  const dealFlow = (
    await env.WP_OS_DB.prepare(
      `SELECT json_extract(snapshot_json, '$.deal_flow_prospect') AS k, COUNT(*) AS n ${CONTACT_MAPPINGS} GROUP BY k`,
    )
      .bind(firmScope)
      .all<{ k: string | null; n: number }>()
  ).results ?? [];

  /*
   * Touch recency, bucketed in SQL against the row's own last_touch_date.
   *
   * This is the number that actually changes a decision: a community is not a headcount, it is how
   * many of those people have heard from the firm recently. A cohort going quiet is the finding
   * this page exists to surface, and it cannot be seen in a roster.
   */
  const recency = (
    await env.WP_OS_DB.prepare(
      `SELECT CASE
                WHEN json_extract(snapshot_json, '$.last_touch_date') IS NULL THEN 'never'
                WHEN julianday('now') - julianday(json_extract(snapshot_json, '$.last_touch_date')) <= 90 THEN 'recent'
                WHEN julianday('now') - julianday(json_extract(snapshot_json, '$.last_touch_date')) <= 365 THEN 'fading'
                ELSE 'cold'
              END AS k,
              COUNT(*) AS n
         ${CONTACT_MAPPINGS}
        GROUP BY k`,
    )
      .bind(firmScope)
      .all<{ k: string | null; n: number }>()
  ).results ?? [];

  // How much of the population the firm has actually formed a view on. Joined on the Network OS
  // identity key, which is the only thing about a person this app owns a link to.
  const readRow = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n
       FROM com_member c
       JOIN network_external_mapping m
         ON m.resource = 'contact'
        AND m.firm_scope = c.firm_scope
        AND lower(m.identity_key) = lower(c.display_name)
      WHERE c.firm_scope = ?1`,
  )
    .bind(firmScope)
    .first<{ n: number }>();

  const cursor = await env.WP_OS_DB.prepare(
    "SELECT last_status, last_sync_at, failure_reason FROM network_sync_cursor WHERE resource = 'contact' AND firm_scope = ?1",
  )
    .bind(firmScope)
    .first<{ last_status: string; last_sync_at: string | null; failure_reason: string | null }>();

  /*
   * How far a long-running load has got.
   *
   * Operator, 21 Aug 2026: "it doesnt have to load our entire community the same day it can work at
   * whatever pace and let us know when its done give us a progress bar." The pull writes its
   * position into `cursor_value` as it walks the far end's table; this reads it back so the page can
   * say "1,250 of 5,000 read" instead of showing a number that grows for hours with no explanation.
   */
  let loading: { done: number; total: number } | null = null;
  if (cursor?.last_status === "IN_PROGRESS") {
    try {
      const parsed = JSON.parse(
        (
          await env.WP_OS_DB.prepare(
            "SELECT cursor_value FROM network_sync_cursor WHERE resource = 'contact' AND firm_scope = ?1",
          )
            .bind(firmScope)
            .first<{ cursor_value: string | null }>()
        )?.cursor_value ?? "null",
      ) as { offset?: number; total?: number } | null;
      if (parsed && typeof parsed.offset === "number" && typeof parsed.total === "number") {
        loading = { done: parsed.offset, total: parsed.total };
      }
    } catch {
      // A cursor we cannot read is not a reason to fail the page; it just means no bar.
    }
  }

  return {
    total,
    loading,
    by_type: slices(byType, total),
    deal_flow: slices(dealFlow, total),
    touch_recency: slices(recency, total),
    firm_has_a_view_on: readRow?.n ?? 0,
    // The page must be able to tell "the community is empty" from "the sync never landed". Those
    // look identical without this and only one of them is anybody's problem.
    source: cursor
      ? { last_status: cursor.last_status, last_sync_at: cursor.last_sync_at, failure_reason: cursor.failure_reason }
      : { last_status: "NEVER_SYNCED", last_sync_at: null, failure_reason: null },
  };
}

export async function handleCommunityPopulation(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  return json(await communityPopulation(ctx.env, firmScope));
}
