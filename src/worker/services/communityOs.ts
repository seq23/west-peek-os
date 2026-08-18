import { z } from "zod";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
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
