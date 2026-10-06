import type { Env } from "../env";
import { appendEvent } from "../events";
import { json, type RouteContext } from "../router";
import { propertyFromRegistration, WEB_PROPERTIES, type WebProperty, type WebPropertyRegistration } from "../../shared/intake/webPropertyChange";

/**
 * THE OPEN REPO REGISTRY (0253, owner 6 Oct 2026: "'registered west peek repos only' is a problem
 * … any new repo we request is allowed").
 *
 * `web_property_registry` is the one list of what Porter may work on. Migration 0253 seeded it from
 * the TypeScript array that used to BE the list, with `seeded = 1`, and a trigger refuses to re-point
 * a seeded host at another repo — so an email can add a property and can never move
 * joinwestpeek.com. A partner's authenticated email that names a GitHub repo (`owner/name` or a
 * github.com link) registers it here at the door and the job proceeds; registration is a step
 * inside the job, never a block and never "not a West Peek property".
 *
 * The TypeScript array stays as the DEFAULT for pure callers and the client's dropdown; the Worker
 * always reads this table. `validate:open-repo-door` holds the seed to the array.
 */

interface RegistryRow {
  id: string;
  host: string | null;
  repo: string;
  github_repo: string | null;
  site: string;
  words_json: string;
  aliases_json: string;
  pages_host: string | null;
  seeded: number;
  requested_by: string | null;
  secret_names_json: string;
  constraints_json: string;
  position: number;
  created_at: string;
}

function list(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function fromRow(r: RegistryRow): WebProperty {
  const aliases = list(r.aliases_json);
  const secretNames = list(r.secret_names_json);
  return {
    host: r.host ?? r.repo.toLowerCase(),
    repo: r.repo,
    site: r.site,
    words: list(r.words_json),
    ...(aliases.length ? { aliases } : {}),
    ...(r.pages_host ? { pagesHost: r.pages_host } : {}),
    ...(r.github_repo ? { githubRepo: r.github_repo } : {}),
    seeded: r.seeded === 1,
    secretNames,
    constraints: list(r.constraints_json),
  };
}

/** Every registered property, seeded rows first in their migration order, then the rest as they arrived. */
export async function loadRegistry(env: Env): Promise<WebProperty[]> {
  try {
    const rows = await env.WP_OS_DB.prepare("SELECT * FROM web_property_registry ORDER BY seeded DESC, position ASC, created_at ASC").all<RegistryRow>();
    const out = (rows.results ?? []).map(fromRow);
    // A database the migration has not reached yet still answers with the seed, never with nothing.
    return out.length ? out : [...WEB_PROPERTIES];
  } catch {
    return [...WEB_PROPERTIES];
  }
}

/** One row by its checkout name, or null. */
export async function registryEntryFor(env: Env, repo: string): Promise<WebProperty | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM web_property_registry WHERE repo = ?1 ORDER BY seeded DESC, position ASC LIMIT 1").bind(repo).first<RegistryRow>();
  return row ? fromRow(row) : null;
}

export interface RegisteredFromEmail {
  registered: string[];
  /** A name the email gave that is a SEEDED host or repo — kept as it was; the email cannot re-point it. */
  kept: string[];
}

/**
 * REGISTER WHAT AN AUTHENTICATED PARTNER NAMED. Idempotent: a repo already registered is left alone;
 * a host already bound (seeded or not) is never re-pointed — the new row goes in without the host and
 * the duty reads the real host from the repo's own config. `requested_by` is the authenticated
 * address, never anything in the message.
 */
export async function registerFromEmail(
  env: Env,
  input: { registrations: readonly WebPropertyRegistration[]; requestedBy: string; firmScope: string },
): Promise<RegisteredFromEmail> {
  const out: RegisteredFromEmail = { registered: [], kept: [] };
  for (const reg of input.registrations) {
    const repo = reg.repo.trim();
    if (!repo || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) continue;
    const existing = await env.WP_OS_DB.prepare("SELECT id, seeded FROM web_property_registry WHERE lower(repo) = ?1 OR lower(github_repo) = ?2 LIMIT 1").bind(repo.toLowerCase(), reg.github_repo.toLowerCase()).first<{ id: string; seeded: number }>();
    if (existing) {
      out.kept.push(reg.github_repo);
      continue;
    }
    let host: string | null = reg.host ? reg.host.toLowerCase() : null;
    if (host) {
      const bound = await env.WP_OS_DB.prepare("SELECT repo FROM web_property_registry WHERE lower(host) = ?1 LIMIT 1").bind(host).first<{ repo: string }>();
      if (bound) {
        out.kept.push(host);
        host = null;
      }
    }
    const prop = propertyFromRegistration({ ...reg, host });
    const id = `wpr_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO web_property_registry (id, host, repo, github_repo, site, words_json, aliases_json, pages_host, seeded, requested_by, firm_scope, position)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', NULL, 0, ?7, ?8, 100)`,
    )
      .bind(id, host, repo, reg.github_repo, prop.site, JSON.stringify(prop.words), input.requestedBy.toLowerCase(), input.firmScope)
      .run();
    out.registered.push(reg.github_repo);
    await appendEvent(env, {
      eventType: "web_property_registry.registered",
      actorType: "firm_user",
      actorId: input.requestedBy.toLowerCase(),
      objectType: "web_property_registry",
      objectId: id,
      firmScope: input.firmScope,
      payload: { repo, github_repo: reg.github_repo, host, requested_by: input.requestedBy.toLowerCase() },
    });
  }
  return out;
}

/**
 * WHAT THE DUTY LEARNED FROM THE REPO ITSELF (never from the email): the host its deploy config
 * declares, the Pages project it previews under, and the secret NAMES its RUNBOOK lists plus the
 * vendor matches the vault held. A seeded row's host and repo are immutable (the trigger refuses);
 * its secret names may still be learned.
 */
export async function recordRepoFacts(
  env: Env,
  repo: string,
  facts: { host?: string | null; pagesHost?: string | null; secretNames?: readonly string[] | null; githubRepo?: string | null; constraints?: readonly string[] | null },
): Promise<void> {
  const row = await env.WP_OS_DB.prepare("SELECT id, host, seeded FROM web_property_registry WHERE repo = ?1 ORDER BY seeded DESC, position ASC LIMIT 1").bind(repo).first<{ id: string; host: string | null; seeded: number }>();
  if (!row) return;
  if (facts.secretNames) {
    const names = [...new Set(facts.secretNames.map((n) => String(n).trim()).filter((n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n)))].sort();
    await env.WP_OS_DB.prepare("UPDATE web_property_registry SET secret_names_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id, JSON.stringify(names)).run();
  }
  // The partner's standing constraints, from the package's README/PRD — a register that grows, never shrinks from a later read.
  if (facts.constraints && facts.constraints.length) {
    const have = list((await env.WP_OS_DB.prepare("SELECT constraints_json FROM web_property_registry WHERE id = ?1").bind(row.id).first<{ constraints_json: string }>())?.constraints_json);
    const merged = [...new Set([...have, ...facts.constraints.map((c) => String(c).trim()).filter((c) => c.length >= 8)])].slice(0, 80);
    await env.WP_OS_DB.prepare("UPDATE web_property_registry SET constraints_json = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id, JSON.stringify(merged)).run();
  }
  if (facts.pagesHost) {
    await env.WP_OS_DB.prepare("UPDATE web_property_registry SET pages_host = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id, facts.pagesHost).run();
  }
  if (facts.githubRepo && row.seeded !== 1) {
    await env.WP_OS_DB.prepare("UPDATE web_property_registry SET github_repo = COALESCE(github_repo, ?2), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(row.id, facts.githubRepo).run();
  }
  // The host, only for a row that has none yet and is not seeded — and only if nobody else holds it.
  if (facts.host && row.seeded !== 1 && !row.host) {
    const host = facts.host.toLowerCase();
    const taken = await env.WP_OS_DB.prepare("SELECT 1 AS x FROM web_property_registry WHERE lower(host) = ?1 LIMIT 1").bind(host).first<{ x: number }>();
    if (!taken) {
      await env.WP_OS_DB.prepare("UPDATE web_property_registry SET host = ?2, words_json = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
        .bind(row.id, host, JSON.stringify([...new Set([repo.toLowerCase(), `the ${repo.toLowerCase()} repo`, `${repo.toLowerCase()} repo`, `the ${host} site`, host])]))
        .run();
    }
  }
}

/** GET /api/web-properties — the registry, for the New Work Card dropdown. Names only. */
export async function handleListWebProperties(ctx: RouteContext): Promise<Response> {
  const rows = await loadRegistry(ctx.env);
  return json({ properties: rows.map((p) => ({ host: p.host, repo: p.repo, site: p.site, seeded: p.seeded === true, github_repo: p.githubRepo ?? null, secret_names: p.secretNames ?? [], constraints: p.constraints ?? [] })) });
}
