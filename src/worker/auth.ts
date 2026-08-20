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

/**
 * The firm's own browser, authenticated by an Access service token.
 *
 * WHY THIS EXISTS AT ALL. Every page this system serves sits behind Cloudflare Access, so the one
 * set of interfaces the firm could never look at was its own — a browser task pointed at
 * os.joinwestpeek.com got a login screen. That meant a design reviewer who can critique any
 * founder's homepage could not open ours, and every interface change was written by somebody who
 * had never seen it render.
 *
 * WHAT AUTHENTICATES, and the distinction matters. Access authenticates the token: a request
 * carrying these headers only reaches this Worker because Access already verified the client id
 * AND the client secret against its own store and let it through. Everything else is refused at the
 * edge and never arrives. So this function is not verifying a credential — it is mapping a caller
 * Access has already vouched for onto the weakest identity in the system.
 *
 * The id is still compared against the configured value rather than accepted blindly, so that
 * granting a SECOND service token access to this application does not silently hand it a firm
 * identity as well. One token, named here, is the browser.
 *
 * `timingSafeEqual` would be theatre: the comparison is against a value the caller already proved
 * to Access, and the string is not a secret this Worker is guarding.
 */
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const BROWSER_AGENT_EMAIL = "browser-agent@westpeek.ventures";

/**
 * The service token's client id, read out of the Access assertion.
 *
 * WHERE THE IDENTITY ACTUALLY IS. `CF-Access-Client-Id` is what a caller SENDS, and Access strips
 * it — the origin never sees it. What arrives is `Cf-Access-Jwt-Assertion`, a token Access signed
 * after it verified the client id and secret against its own store, and for a service token the
 * client id is the `common_name` claim. Two deploys were spent on the wrong header before the
 * health endpoint was made to list what actually arrives.
 *
 * WHY THE SIGNATURE IS NOT VERIFIED HERE, stated plainly because it is the kind of decision that
 * should be argued with rather than discovered:
 *
 *   This assertion is minted by Access and the request cannot reach this Worker without passing
 *   through Access — both the custom domain and the workers.dev hostname sit behind it, so there is
 *   no path on which a forged assertion could arrive. Verifying would mean fetching Cloudflare's
 *   JWKS on every request, which is an egress dependency and a per-request round trip in front of
 *   the whole application.
 *
 *   WHAT WOULD CHANGE THAT: the moment any route becomes reachable without Access — a public
 *   endpoint, a second hostname, a Worker route added outside the protected zone — this becomes
 *   forgeable and must verify against the JWKS. That is the trigger to watch for.
 *
 * The `aud` claim is checked as well, so an assertion minted for a DIFFERENT Access application in
 * this same account cannot be replayed here.
 */
const ACCESS_APP_AUD = "3ee619ef7997f1d25f57d7ffe87bb3f2f6b66b801c6a31937f8dc734b3189b63";

function serviceTokenClientId(request: Request): string | null {
  const jwt = request.headers.get(ACCESS_JWT_HEADER);
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as {
      common_name?: string;
      aud?: string | string[];
      exp?: number;
      type?: string;
    };

    // Expired assertions are refused even though Access would not have forwarded one.
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;

    // Minted for THIS application, not another one in the same account.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(ACCESS_APP_AUD)) return null;

    return typeof claims.common_name === "string" && claims.common_name.length > 0 ? claims.common_name : null;
  } catch {
    return null;
  }
}

function identityEmail(request: Request, env: Env): string | null {
  const header = env.WP_OS_ENV === "local" ? DEV_IDENTITY_HEADER : ACCESS_IDENTITY_HEADER;
  const value = request.headers.get(header);
  if (value) {
    const email = value.trim().toLowerCase();
    if (email.length > 0) return email;
  }

  /*
   * A HUMAN IDENTITY ALWAYS WINS. This is checked only after the header above is absent, so a
   * partner browsing normally is never downgraded to the agent — and a request cannot upgrade
   * itself by adding a header, because it would need a human email to be worth upgrading from.
   *
   * Inert unless the client id is configured. No secret bound, no agent.
   */
  const configured = env.CF_ACCESS_CLIENT_ID;
  if (typeof configured === "string" && configured.length > 0) {
    const presented = serviceTokenClientId(request);
    if (presented && presented === configured) return BROWSER_AGENT_EMAIL;
  }
  return null;
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
