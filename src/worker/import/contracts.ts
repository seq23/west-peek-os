import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Import contracts (P2) — TYPED CONTRACTS ONLY.
 *
 * These schemas define what a future live import from Network OS (person/contact
 * references, D5) and VentureDeals/secondaries (opportunities, D6) must look like.
 * NO live or destructive import exists: the only consumer is the DRY-RUN endpoint,
 * which reports what WOULD be created or conflict and persists NOTHING. Executing a
 * real import requires explicit human approval (approved plan §P2; see
 * docs/IMPORT_CONTRACTS.md).
 */

/** (a) Network OS person/contact reference import — firm-side reference rows only. */
export const networkOsPersonImportSchema = z.object({
  source_system: z.literal("network_os"),
  external_key: z.string().trim().min(1),
  full_name: z.string().trim().min(1),
  email: z.string().trim().email().optional(),
  organization: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  privacy_label: privacyLabelSchema.optional(),
});
export type NetworkOsPersonImport = z.infer<typeof networkOsPersonImportSchema>;

/** (b) VentureDeals/secondaries opportunity import (opportunity objects land in P6). */
export const ventureDealsOpportunityImportSchema = z.object({
  source_system: z.literal("venturedeals"),
  external_key: z.string().trim().min(1),
  company: z.object({
    canonical_name: z.string().trim().min(1),
    legal_name: z.string().trim().min(1).optional(),
    website: z.string().trim().min(1).optional(),
    aliases: z.array(z.string().trim().min(1)).optional(),
    external_identities: z
      .array(z.object({ system: z.string().trim().min(1), external_key: z.string().trim().min(1) }))
      .optional(),
  }),
  opportunity: z.object({
    name: z.string().trim().min(1),
    opportunity_type: z.enum(["EARLY_STAGE", "FOLLOW_ON", "SECONDARY"]),
    source: z.string().trim().min(1).optional(),
    received_at: z.string().trim().min(1).optional(),
    notes: z.string().optional(),
  }),
});
export type VentureDealsOpportunityImport = z.infer<typeof ventureDealsOpportunityImportSchema>;

export const dryRunImportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("network_os_person"), records: z.array(networkOsPersonImportSchema).min(1).max(500) }),
  z.object({
    kind: z.literal("venturedeals_opportunity"),
    records: z.array(ventureDealsOpportunityImportSchema).min(1).max(500),
  }),
]);

interface DryRunFinding {
  index: number;
  outcome: "would_create" | "conflict";
  detail: string;
  existing_id?: string;
}

/**
 * POST /api/import/dry-run — validates the contract payload and reports what WOULD
 * happen per record. Persists nothing: no INSERT is executed on this path.
 */
export async function handleDryRunImport(ctx: RouteContext): Promise<Response> {
  const { env } = ctx;
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: "invalid_input", detail: "body must be JSON" }, { status: 400 });
  }
  const parsed = dryRunImportSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const findings: DryRunFinding[] = [];

  if (parsed.data.kind === "network_os_person") {
    for (const [index, record] of parsed.data.records.entries()) {
      let conflict: { id: string } | null = null;
      if (record.email) {
        conflict = await env.WP_OS_DB.prepare(
          "SELECT id FROM person WHERE lower(trim(email)) = ?1 LIMIT 1",
        )
          .bind(record.email.trim().toLowerCase())
          .first<{ id: string }>();
      }
      if (conflict) {
        findings.push({
          index,
          outcome: "conflict",
          detail: `person with email ${record.email} already exists`,
          existing_id: conflict.id,
        });
      } else {
        findings.push({ index, outcome: "would_create", detail: `person "${record.full_name}" (reference only)` });
      }
    }
  } else {
    for (const [index, record] of parsed.data.records.entries()) {
      const company = record.company;
      // Resolution order mirrors create-time duplicate prevention: external identity,
      // then exact canonical name, then exact alias.
      let existingId: string | null = null;
      let matchedVia: string | null = null;
      for (const ext of company.external_identities ?? []) {
        const row = await env.WP_OS_DB.prepare(
          "SELECT company_id FROM company_external_identity WHERE system = ?1 AND external_key = ?2 LIMIT 1",
        )
          .bind(ext.system, ext.external_key)
          .first<{ company_id: string }>();
        if (row) {
          existingId = row.company_id;
          matchedVia = "external_identity";
          break;
        }
      }
      if (!existingId) {
        const row = await env.WP_OS_DB.prepare(
          "SELECT id FROM canonical_company WHERE lower(trim(canonical_name)) = ?1 LIMIT 1",
        )
          .bind(company.canonical_name.trim().toLowerCase())
          .first<{ id: string }>();
        if (row) {
          existingId = row.id;
          matchedVia = "canonical_name";
        }
      }
      if (!existingId) {
        const row = await env.WP_OS_DB.prepare(
          "SELECT company_id FROM company_alias WHERE lower(trim(alias)) = ?1 LIMIT 1",
        )
          .bind(company.canonical_name.trim().toLowerCase())
          .first<{ company_id: string }>();
        if (row) {
          existingId = row.company_id;
          matchedVia = "alias";
        }
      }

      if (existingId) {
        findings.push({
          index,
          outcome: "conflict",
          detail: `company "${company.canonical_name}" resolves to existing canonical company via ${matchedVia}; opportunity objects are P6 scope`,
          existing_id: existingId,
        });
      } else {
        findings.push({
          index,
          outcome: "would_create",
          detail: `company "${company.canonical_name}" would be created; opportunity objects are P6 scope`,
        });
      }
    }
  }

  return json({
    dry_run: true,
    persisted: false,
    kind: parsed.data.kind,
    record_count: parsed.data.records.length,
    findings,
  });
}
