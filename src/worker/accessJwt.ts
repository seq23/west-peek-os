/**
 * Cloudflare Access assertions, VERIFIED (security sweep, 3 Nov 2026).
 *
 * Every identity this Worker accepts outside local dev comes from `Cf-Access-Jwt-Assertion`, and
 * only after its RS256 signature checks out against the team's published keys, its issuer is the
 * team, its `aud` names one of OUR Access applications and it has not expired. Before this, the
 * assertion was base64-decoded and trusted, and the human email was read from
 * `Cf-Access-Authenticated-User-Email` — safe only while Access fronted every hostname. A
 * measured probe showed Cloudflare passes a client-supplied `Cf-Access-Jwt-Assertion` straight
 * through on a hostname with no Access application, so any route, hostname or preview URL that
 * ever escaped Access would have accepted a forged identity. Now nothing does: no valid signature,
 * no identity — fail closed.
 *
 * KEYS. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs, held in isolate memory for an
 * hour and re-read early (at most once a minute) when an assertion names a key id we do not hold,
 * which is how a key rotation is picked up. A certs fetch that fails leaves the old keys in place;
 * with none at all, every assertion is refused.
 */

export const ACCESS_TEAM_DOMAIN = "https://seq-taylor.cloudflareaccess.com";
const CERTS_URL = `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const KEYS_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFETCH_FLOOR_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;

export interface AccessClaims {
  aud?: string | string[];
  email?: string;
  common_name?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  type?: string;
  sub?: string;
}

export interface AccessJwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

type KeySource = () => Promise<AccessJwk[]>;

async function fetchCerts(): Promise<AccessJwk[]> {
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Access certs answered ${res.status}`);
  const body = (await res.json()) as { keys?: AccessJwk[] };
  return Array.isArray(body.keys) ? body.keys : [];
}

let source: KeySource = fetchCerts;
let held: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
let lastAttempt = 0;

/** Tests hand in their own key set (the real one is never fetched from a test). Null restores it. */
export function setAccessKeySourceForTests(fn: KeySource | null): void {
  source = fn ?? fetchCerts;
  held = null;
  lastAttempt = 0;
}

async function refresh(now: number): Promise<void> {
  lastAttempt = now;
  try {
    const jwks = await source();
    const keys = new Map<string, CryptoKey>();
    for (const jwk of jwks) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.n || !jwk.e) continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    }
    if (keys.size > 0) held = { keys, fetchedAt: now };
  } catch (err) {
    console.error("Access certs could not be read; keeping the keys already held", err instanceof Error ? err.message : String(err));
  }
}

async function keyFor(kid: string, now: number): Promise<CryptoKey | null> {
  const stale = !held || now - held.fetchedAt > KEYS_TTL_MS;
  const unknown = !held || !held.keys.has(kid);
  if (stale || (unknown && now - lastAttempt > UNKNOWN_KID_REFETCH_FLOOR_MS)) await refresh(now);
  return held?.keys.get(kid) ?? null;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;
}

/**
 * The verified claims of an Access assertion, or null. `audiences` are the AUD tags of the Access
 * applications in front of THIS Worker; an empty list accepts nothing.
 */
export async function verifyAccessAssertion(
  token: string | null,
  audiences: readonly string[],
  now: number = Date.now(),
): Promise<AccessClaims | null> {
  if (!token || audiences.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
    signature = b64urlBytes(parts[2]!);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !claims || typeof claims !== "object") return null;

  const key = await keyFor(header.kid, now);
  if (!key) return null;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  if (claims.iss !== ACCESS_TEAM_DOMAIN) return null;
  const nowS = now / 1000;
  if (typeof claims.exp !== "number" || claims.exp <= nowS) return null;
  if (typeof claims.nbf === "number" && claims.nbf > nowS + CLOCK_SKEW_S) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) return null;
  return claims;
}
