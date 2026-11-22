import type { Env } from "../env";
import { appendEvent } from "../events";
import { sendOrPreview } from "./previewApproval";
import { partnerByEmail } from "../../shared/registry/partners";
import { DNS_RECHECK_MINUTES, DNS_WAIT_DAYS, waitBullets } from "../../shared/work/porterWaits";
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
 *   3 · re-checks every open row on the Worker's cron every DNS_RECHECK_MINUTES, day and night
 *       (`sweepDnsWaits`): public DNS carries the record and https://<host> answers;
 *   4 · on `active`, emails "live at https://<host>" and closes the row; after 7 days still
 *       inactive, ONE plain reminder with the same record, then silence.
 *
 * A record email is REFUSED unless type, name and target are all present — `validate:open-repo-door`
 * holds `recordProblem` to that, and the test sends a record through the door and reads the email.
 */

export { DNS_RECHECK_MINUTES, DNS_WAIT_DAYS };
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
          { label: "Your call", bullets: [`Add the record at the registrar that holds ${row.host.split(".").slice(-2).join(".")}. No reply is needed; I check every ${DNS_RECHECK_MINUTES} minutes, day and night, for ${DNS_WAIT_DAYS} days and email when it is live.`] },
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

const DOH = "https://cloudflare-dns.com/dns-query";

/** What public DNS answers for the host, lower-case and without the trailing dot; null when the resolver could not be asked. */
async function resolved(host: string, type: string, fetchImpl: typeof fetch): Promise<string[] | null> {
  try {
    const res = await fetchImpl(`${DOH}?name=${encodeURIComponent(host)}&type=${encodeURIComponent(type)}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { Status?: number; Answer?: Array<{ data?: string }> };
    return (body.Answer ?? []).map((a) => String(a.data ?? "").replace(/\.$/, "").toLowerCase());
  } catch {
    return null;
  }
}

/**
 * IS IT LIVE, READ WITHOUT THE MAC (22 Nov 2026). Public DNS must carry the exact record we emailed (a host pointed
 * somewhere else is never "live" for us), and https://<host> must answer: Pages serves the custom domain only once it
 * has validated it and issued the certificate, so a working https answer on the right record is Cloudflare's "active".
 * "pending" = the record is not there yet; "record_seen" = it is, Pages has not finished; "unknown" = a resolver or
 * network fault, said as a fault and never as live.
 */
export async function dnsLiveStatus(row: Pick<DnsWaitRow, "host" | "record_type" | "record_target">, fetchImpl: typeof fetch = fetch): Promise<"active" | "pending" | "record_seen" | "unknown"> {
  const answers = await resolved(row.host, row.record_type, fetchImpl);
  if (!answers) return "unknown";
  if (!answers.includes(row.record_target.replace(/\.$/, "").toLowerCase())) return "pending";
  try {
    const res = await fetchImpl(`https://${row.host}/`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return res.status < 400 ? "active" : "record_seen";
  } catch {
    return "record_seen";
  }
}

/** One check's answer, applied: "live" emails and closes; past the wait window, one reminder; otherwise a stamp. */
export async function applyDnsStatus(env: Env, row: DnsWaitRow, status: string, now: Date = new Date()): Promise<"checked" | "live" | "reminded"> {
  const at = now.toISOString();
  await env.WP_OS_DB.prepare("UPDATE web_property_dns SET status = ?2, last_checked_at = ?3, updated_at = ?3 WHERE id = ?1").bind(row.id, status, at).run();
  if (status === "active" && !row.active_at) {
    // Claimed before the email: two ticks that race send "live" once.
    const claimed = await env.WP_OS_DB.prepare("UPDATE web_property_dns SET active_at = ?2 WHERE id = ?1 AND active_at IS NULL").bind(row.id, at).run();
    if ((claimed.meta?.changes ?? 0) === 0) return "checked";
    await email(env, { ...row, status }, "LIVE");
    await appendEvent(env, { eventType: "web_property_dns.active", actorType: "system", actorId: "dns_waits", objectType: "web_property_dns", objectId: row.id, firmScope: row.firm_scope, payload: { host: row.host, project: row.project } });
    return "live";
  }
  if (!row.reminded_at && now.getTime() - Date.parse(row.created_at) > DNS_WAIT_DAYS * 86_400_000) {
    const claimed = await env.WP_OS_DB.prepare("UPDATE web_property_dns SET reminded_at = ?2 WHERE id = ?1 AND reminded_at IS NULL").bind(row.id, at).run();
    if ((claimed.meta?.changes ?? 0) === 0) return "checked";
    await email(env, { ...row, status }, "REMINDER");
    return "reminded";
  }
  return "checked";
}

/**
 * THE RE-CHECK, ON THE WORKER'S CRON (22 Nov 2026). It used to ride the Mac claimer's heartbeat, which since #572 runs
 * only 10:00-21:59 CT, so "every 15 minutes" was false all night. Every row not checked in DNS_RECHECK_MINUTES is
 * checked now, day or night. After the reminder the check goes on (a late record still goes live) but nothing more is
 * emailed. Returns what it did, one entry per row.
 */
export async function sweepDnsWaits(env: Env, now: Date, fetchImpl: typeof fetch = fetch): Promise<Array<{ host: string; status: string; did: string }>> {
  const due = new Date(now.getTime() - DNS_RECHECK_MINUTES * 60_000).toISOString();
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT * FROM web_property_dns
          WHERE active_at IS NULL AND status != 'on_zone' AND (last_checked_at IS NULL OR last_checked_at <= ?1)
          ORDER BY last_checked_at ASC LIMIT 20`,
      )
        .bind(due)
        .all<DnsWaitRow>()
    ).results ?? [];
  const out: Array<{ host: string; status: string; did: string }> = [];
  for (const row of rows) {
    const status = await dnsLiveStatus(row, fetchImpl);
    out.push({ host: row.host, status, did: await applyDnsStatus(env, row, status, now) });
  }
  return out;
}
