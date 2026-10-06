import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { appendEvent } from "../events";
import { sendOrPreview } from "./previewApproval";
import { partnerByEmail } from "../../shared/registry/partners";
import { waitBullets } from "../../shared/work/porterWaits";
import type { DnsRecordAsked } from "../../shared/work/localJobs";

/**
 * A HOST OUTSIDE HER CLOUDFLARE ZONES (0253; owner, 6 Oct 2026: "topbarz.xyz was not a cloudflare
 * domain i owned and we needed to send scooter some DNS stuff — can porter do that too?").
 *
 * The Mac duty adds the custom domain to the repo's Pages project through the Cloudflare API and
 * READS BACK what Cloudflare requires — the project's own `subdomain` as the CNAME target and any
 * TXT from `validation_data` — never a guessed record. The report carries that as `dns`; this file:
 *
 *   1 · keeps one `web_property_dns` row per host + project;
 *   2 · emails the partner the record ONCE, in the three-part shape (`DNS_RECORD` in porterWaits)
 *       — NOT a block: the card goes on, the site is live on pages.dev meanwhile;
 *   3 · hands the open rows to the Mac's claimer every ~15 minutes (`/pending`), which asks
 *       Cloudflare for the domain's status and reports it (`/status`);
 *   4 · on `active`, emails "live at https://<host>" and closes the row; after 7 days still
 *       inactive, ONE plain reminder with the same record, then silence.
 *
 * A record email is REFUSED unless type, name and target are all present — `validate:open-repo-door`
 * holds `recordProblem` to that, and the test sends a record through the door and reads the email.
 */

export const DNS_RECHECK_MINUTES = 15;
export const DNS_WAIT_DAYS = 7;
export const PORTER = "Porter";

export interface DnsWaitRow {
  id: string;
  work_card_id: string | null;
  repo: string;
  host: string;
  project: string;
  record_type: string;
  record_name: string;
  record_target: string;
  txt_name: string | null;
  txt_value: string | null;
  status: string;
  requested_by: string;
  emailed_at: string | null;
  reminded_at: string | null;
  active_at: string | null;
  last_checked_at: string | null;
  firm_scope: string;
  created_at: string;
}

/** Why a record cannot be emailed, or null. A record with a hole in it is never sent as if it were whole. */
export function recordProblem(r: Pick<DnsRecordAsked, "host" | "record_type" | "record_name" | "record_target">): string | null {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(r.host ?? ""))) return "the host is not a hostname";
  if (!["CNAME", "A", "AAAA"].includes(String(r.record_type ?? ""))) return "the record type is not CNAME, A or AAAA";
  if (!String(r.record_name ?? "").trim()) return "the record has no name";
  if (!String(r.record_target ?? "").trim()) return "the record has no target";
  if (/\$\{|<[a-z-]+>|\bguess/i.test(`${r.record_name} ${r.record_target}`)) return "the record carries a placeholder, not a value read from Cloudflare";
  return null;
}

function fill(r: Pick<DnsWaitRow, "host" | "record_type" | "record_name" | "record_target" | "txt_name" | "txt_value" | "project">) {
  return { record: { host: r.host, type: r.record_type, name: r.record_name, target: r.record_target, txtName: r.txt_name, txtValue: r.txt_value, liveAt: `https://${r.project}.pages.dev` } };
}

async function email(env: Env, row: DnsWaitRow, kind: "RECORD" | "REMINDER" | "LIVE"): Promise<boolean> {
  const to = row.requested_by.toLowerCase();
  if (!partnerByEmail(to)) return false;
  const bullets = waitBullets("DNS_RECORD", fill(row));
  const what = kind === "LIVE" ? `live at ${row.host}` : kind === "REMINDER" ? `still waiting on DNS for ${row.host}` : `one DNS record for ${row.host}`;
  const tldr =
    kind === "LIVE"
      ? `${row.host} is live: https://${row.host} now serves the site. Nothing needed from you.`
      : kind === "REMINDER"
        ? `Seven days on, ${row.host} still has no DNS record pointing at the site; it is live at https://${row.project}.pages.dev meanwhile. The record is below — same as before.`
        : `To put the site on ${row.host}: at your DNS provider add ${row.record_type} ${row.record_name} → ${row.record_target}${row.txt_name && row.txt_value ? ` and TXT ${row.txt_name} → ${row.txt_value}` : ""}. Until then it is live at https://${row.project}.pages.dev.`;
  const sections =
    kind === "LIVE"
      ? [
          { label: "What happened", bullets: [`Cloudflare reports the custom domain ${row.host} active on the Pages project ${row.project}.`] },
          { label: "Your call", bullets: ["Nothing — this closes the DNS item on the card."] },
        ]
      : [
          { label: "The record", bullets: [`${row.record_type} ${row.record_name} → ${row.record_target}`, ...(row.txt_name && row.txt_value ? [`TXT ${row.txt_name} → ${row.txt_value}`] : []), `Read from Cloudflare's own answer for project ${row.project}; nothing here is guessed.`] },
          { label: "Where things stand", bullets },
          { label: "Your call", bullets: [`Add the record at the registrar that holds ${row.host.split(".").slice(-2).join(".")}. No reply is needed; I check every ${DNS_RECHECK_MINUTES} minutes for ${DNS_WAIT_DAYS} days and email when it is live.`] },
        ];
  try {
    const out = await sendOrPreview(env, {
      to,
      email: { employee: PORTER, what, tldr, sections },
      objectType: "web_property_dns",
      objectId: row.id,
      firmScope: row.firm_scope,
      actorId: "dns_waits",
      cardKind: null,
      cardAsked: null,
      tickedByFirmUserId: null,
      requestedByEmail: to,
      what,
      ...(row.work_card_id ? { workCardId: row.work_card_id } : {}),
    });
    return out.sent || out.previewed;
  } catch {
    return false;
  }
}

/**
 * RECORD WHAT THE DUTY READ BACK, and email each NEW host's record once. A host on one of the
 * firm's zones (`on_zone`) is recorded as already handled and never emailed. Returns the hosts
 * emailed this call.
 */
export async function recordDnsWaits(env: Env, input: { cardId: string | null; repo: string; requestedBy: string | null; firmScope: string; records: readonly DnsRecordAsked[] }): Promise<string[]> {
  const told: string[] = [];
  for (const r of input.records) {
    const host = String(r.host ?? "").toLowerCase();
    const problem = recordProblem(r);
    if (problem) {
      await appendEvent(env, { eventType: "web_property_dns.refused", actorType: "system", actorId: "dns_waits", objectType: "web_property_dns", objectId: `${host}:${r.project}`, firmScope: input.firmScope, payload: { host, project: r.project, problem } });
      continue;
    }
    const existing = await env.WP_OS_DB.prepare("SELECT * FROM web_property_dns WHERE host = ?1 AND project = ?2").bind(host, r.project).first<DnsWaitRow>();
    const now = new Date().toISOString();
    if (existing) {
      await env.WP_OS_DB.prepare("UPDATE web_property_dns SET status = ?2, record_name = ?3, record_target = ?4, txt_name = ?5, txt_value = ?6, last_checked_at = ?7, updated_at = ?7, active_at = CASE WHEN ?2 = 'active' THEN COALESCE(active_at, ?7) ELSE active_at END WHERE id = ?1")
        .bind(existing.id, r.status, r.record_name, r.record_target, r.txt_name ?? null, r.txt_value ?? null, now)
        .run();
      continue;
    }
    const id = `wdns_${crypto.randomUUID()}`;
    const active = r.on_zone || r.status === "active";
    await env.WP_OS_DB.prepare(
      `INSERT INTO web_property_dns (id, work_card_id, repo, host, project, record_type, record_name, record_target, txt_name, txt_value, status, requested_by, firm_scope, last_checked_at, active_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
      .bind(id, input.cardId, input.repo, host, r.project, r.record_type, r.record_name, r.record_target, r.txt_name ?? null, r.txt_value ?? null, r.on_zone ? "on_zone" : r.status, (input.requestedBy ?? "").toLowerCase(), input.firmScope, now, active ? now : null)
      .run();
    await appendEvent(env, { eventType: "web_property_dns.recorded", actorType: "system", actorId: "dns_waits", objectType: "web_property_dns", objectId: id, firmScope: input.firmScope, payload: { host, project: r.project, record: `${r.record_type} ${r.record_name} → ${r.record_target}`, on_zone: r.on_zone, status: r.status } });
    if (active) continue;
    const row = await env.WP_OS_DB.prepare("SELECT * FROM web_property_dns WHERE id = ?1").bind(id).first<DnsWaitRow>();
    if (row && (await email(env, row, "RECORD"))) {
      await env.WP_OS_DB.prepare("UPDATE web_property_dns SET emailed_at = ?2 WHERE id = ?1").bind(id, now).run();
      told.push(host);
    }
  }
  return told;
}

function isClaimer(ctx: RouteContext): boolean {
  return ctx.identity?.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL;
}

/** POST /api/dns-waits/pending — the claimer only: open rows due for a check (every 15 min, for 7 days + the reminder). */
export async function handlePendingDnsWaits(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer checks DNS waits." }, { status: 403 });
  const due = new Date(Date.now() - DNS_RECHECK_MINUTES * 60_000).toISOString();
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, host, project, status, created_at, reminded_at FROM web_property_dns
      WHERE active_at IS NULL AND status != 'on_zone' AND (last_checked_at IS NULL OR last_checked_at < ?1)
        AND (reminded_at IS NULL OR last_checked_at < ?1)
      ORDER BY created_at ASC LIMIT 20`,
  )
    .bind(due)
    .all<{ id: string; host: string; project: string; status: string; created_at: string; reminded_at: string | null }>();
  // After the reminder the check continues (a late record still goes live), but nothing more is emailed.
  return json({ waits: rows.results ?? [] });
}

/** POST /api/dns-waits/status { id, status } — the claimer reports Cloudflare's word; the Worker emails and closes. */
export async function handleDnsWaitStatus(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer checks DNS waits." }, { status: 403 });
  const body = (await ctx.request.json().catch(() => ({}))) as { id?: string; status?: string };
  const id = String(body.id ?? "").trim();
  const status = String(body.status ?? "").trim().toLowerCase().slice(0, 40) || "unknown";
  if (!id) return json({ error: "invalid_input", detail: "id is required" }, { status: 400 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM web_property_dns WHERE id = ?1").bind(id).first<DnsWaitRow>();
  if (!row) return json({ error: "not_found", detail: "no such wait" }, { status: 404 });
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare("UPDATE web_property_dns SET status = ?2, last_checked_at = ?3, updated_at = ?3 WHERE id = ?1").bind(id, status, now).run();
  let did = "checked";
  if (status === "active" && !row.active_at) {
    await ctx.env.WP_OS_DB.prepare("UPDATE web_property_dns SET active_at = ?2 WHERE id = ?1").bind(id, now).run();
    await email(ctx.env, { ...row, status }, "LIVE");
    await appendEvent(ctx.env, { eventType: "web_property_dns.active", actorType: "system", actorId: "dns_waits", objectType: "web_property_dns", objectId: id, firmScope: row.firm_scope, payload: { host: row.host, project: row.project } });
    did = "live";
  } else if (!row.reminded_at && Date.now() - Date.parse(row.created_at) > DNS_WAIT_DAYS * 86_400_000) {
    await ctx.env.WP_OS_DB.prepare("UPDATE web_property_dns SET reminded_at = ?2 WHERE id = ?1").bind(id, now).run();
    await email(ctx.env, { ...row, status }, "REMINDER");
    did = "reminded";
  }
  return json({ ok: true, did, host: row.host, status });
}
