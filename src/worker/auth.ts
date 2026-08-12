import type { Env } from "./env";

/**
 * Runtime identity resolution (ADR-006).
 *
 * Private ingress (MFA, network posture) is the identity layer's job — Cloudflare Access
 * in deployed environments, which is operator configuration, NOT application code
 * (see docs/ENVIRONMENTS.md). This module enforces the app-level half: every request
 * must resolve to a known, ACTIVE firm_user record, or it is denied. Fail closed.
 *
 * Identity headers:
 * - WP_OS_ENV === "local": explicit dev identity header `x-wpos-dev-user: <email>`.
 * - otherwise: `Cf-Access-Authenticated-User-Email` set by Cloudflare Access.
 */
export interface FirmUserIdentity {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  authorityScopes: Array<{ scopeKey: string; scopeValue: string }>;
}

const DEV_IDENTITY_HEADER = "x-wpos-dev-user";
const ACCESS_IDENTITY_HEADER = "Cf-Access-Authenticated-User-Email";

function identityEmail(request: Request, env: Env): string | null {
  const header = env.WP_OS_ENV === "local" ? DEV_IDENTITY_HEADER : ACCESS_IDENTITY_HEADER;
  const value = request.headers.get(header);
  if (!value) return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : null;
}

interface FirmUserRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
}

/**
 * Resolve the authenticated FirmUser for a request, or null when the request carries
 * no usable identity or the email is unknown/inactive. Unknown email and missing
 * header both resolve to null → caller answers 401.
 */
export async function resolveFirmUser(request: Request, env: Env): Promise<FirmUserIdentity | null> {
  const email = identityEmail(request, env);
  if (!email) return null;

  const user = await env.WP_OS_DB.prepare(
    "SELECT id, email, full_name, status FROM firm_user WHERE lower(email) = ?1",
  )
    .bind(email)
    .first<FirmUserRow>();
  if (!user || user.status !== "ACTIVE") return null;

  const roles = await env.WP_OS_DB.prepare(
    `SELECT r.key AS key
       FROM firm_user_role fur
       JOIN role r ON r.id = fur.role_id
      WHERE fur.firm_user_id = ?1
      ORDER BY r.key`,
  )
    .bind(user.id)
    .all<{ key: string }>();

  const scopes = await env.WP_OS_DB.prepare(
    `SELECT scope_key, scope_value FROM authority_scope WHERE firm_user_id = ?1 ORDER BY scope_key, scope_value`,
  )
    .bind(user.id)
    .all<{ scope_key: string; scope_value: string }>();

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    status: user.status,
    roles: (roles.results ?? []).map((r) => r.key),
    authorityScopes: (scopes.results ?? []).map((s) => ({ scopeKey: s.scope_key, scopeValue: s.scope_value })),
  };
}
