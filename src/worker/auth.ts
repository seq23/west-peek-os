import type { Env } from "./env";
import { verifyAccessAssertion } from "./accessJwt";

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
 * - otherwise: the `email` (person) or `common_name` (service token) claim of a VERIFIED
 *   `Cf-Access-Jwt-Assertion` (src/worker/accessJwt.ts). No valid assertion, no identity.
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
 * The claimer on the owner's Mac (migration 0187). A SECOND service token, named separately for
 * the reason the paragraph above gives: granting a token access to this Access application must
 * not hand it whichever firm identity happens to be first in this file.
 *
 * ITS OWN IDENTITY, NOT THE BROWSER AGENT'S. Two agents doing different jobs behind one email
 * makes the audit log unreadable and means revoking one revokes the other. The claimer is a
 * distinct `firm_user` row seeded by 0187, with no authority scopes and no roles — it needs none:
 * the only three routes it may call check for it by name, and every run it serves was already
 * authorised as somebody else's work before it was parked.
 *
 * NOT A PER-PERSON LANE. The owner has approved Scooter's work running on her subscription, so the
 * claimer is the FIRM's agent and takes whatever the firm parked. There is deliberately no partner
 * identity anywhere in this path.
 */
export const SUBSCRIPTION_CLAIMER_EMAIL = "subscription-claimer@joinwestpeek.com";

/**
 * The AUD tags of the Access applications in front of this Worker (read from the Access API,
 * 3 Nov 2026): "west-peek-os - Cloudflare Workers" (the Worker destination: os.joinwestpeek.com)
 * and the one on west-peek-os.seq-taylor.workers.dev. An assertion minted for any OTHER application
 * in this account is refused, so it cannot be replayed here.
 */
export const ACCESS_APP_AUDS: readonly string[] = [
  "3ee619ef7997f1d25f57d7ffe87bb3f2f6b66b801c6a31937f8dc734b3189b63",
  "7ef8eead547605d2360d07e30ec390f8f41b78b5606939a595f171b8f893e89e",
];

async function identityEmail(request: Request, env: Env): Promise<string | null> {
  // Local dev only: the explicit dev header. Never read in any deployed environment.
  if (env.WP_OS_ENV === "local") {
    const value = request.headers.get(DEV_IDENTITY_HEADER);
    const email = value ? value.trim().toLowerCase() : "";
    if (email.length > 0) return email;
  }

  /*
   * Everything else comes from a VERIFIED Access assertion (src/worker/accessJwt.ts): signature,
   * issuer, our aud, not expired. `Cf-Access-Authenticated-User-Email` is no longer read: the
   * signed `email` claim is the same fact without trusting a header.
   */
  const claims = await verifyAccessAssertion(request.headers.get(ACCESS_JWT_HEADER), ACCESS_APP_AUDS);
  if (!claims) return null;

  // A HUMAN IDENTITY ALWAYS WINS: an assertion that names a person is that person, never an agent.
  const human = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (human.length > 0) return human;

  // A service token: its client id is the `common_name` claim. Inert unless configured.
  const name = typeof claims.common_name === "string" ? claims.common_name : "";
  if (name.length === 0) return null;
  const configured = env.CF_ACCESS_CLIENT_ID;
  if (typeof configured === "string" && configured.length > 0 && name === configured) return BROWSER_AGENT_EMAIL;

  /*
   * The Claude Code claimer, on the same terms and by the same mechanism. Inert unless its own
   * client id is configured — no token, no agent — and checked after the browser agent so the two
   * can never collide on a shared value.
   */
  const claimerId = env.WP_OS_CLAIMER_CLIENT_ID;
  if (typeof claimerId === "string" && claimerId.length > 0 && name === claimerId) return SUBSCRIPTION_CLAIMER_EMAIL;
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
  const email = await identityEmail(request, env);
  if (!email) return null;

  const user = await env.WP_OS_DB.prepare(
    "SELECT id, email, full_name, status FROM firm_user WHERE lower(email) = ?1",
  )
    .bind(email)
    .first<FirmUserRow>();
  if (!user || user.status !== "ACTIVE") return null;
  return identityForFirmUser(env, user);
}

/**
 * The identity a firm user has, from their row — what a request resolves, rebuilt for work that
 * runs later on their behalf. The artifact producer (services/artifacts.ts) runs a partner's build
 * on the clock, after her request has ended, and reads the record with HER visibility clause
 * rather than the system's: a build she asked for may show her nothing she could not open herself.
 */
export async function identityForFirmUserId(env: Env, firmUserId: string): Promise<FirmUserIdentity | null> {
  const user = await env.WP_OS_DB.prepare("SELECT id, email, full_name, status FROM firm_user WHERE id = ?1").bind(firmUserId).first<FirmUserRow>();
  if (!user || user.status !== "ACTIVE") return null;
  return identityForFirmUser(env, user);
}

async function identityForFirmUser(env: Env, user: FirmUserRow): Promise<FirmUserIdentity> {
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
