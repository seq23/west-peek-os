import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import { resolveFirmUser } from "../src/worker/auth";
import type { Env } from "../src/worker/env";
import { ACCESS_TEAM_DOMAIN, setAccessKeySourceForTests } from "../src/worker/accessJwt";

/**
 * The read-only browser identity, and the ways it must NOT work.
 *
 * This is the only principal in the system that is not a person, and it exists so the firm can look
 * at its own interfaces — every page sits behind Cloudflare Access, so a design reviewer who can
 * critique any founder's homepage could not open ours.
 *
 * It is an auth path, so what is asserted here is mostly what it CANNOT do. Every one of these
 * would be a real hole:
 *   * a wrong or absent client id resolving to anybody;
 *   * the agent outranking a signed-in partner;
 *   * the agent holding a role, which would make it an approver;
 *   * the agent reading privacy-sensitive material.
 */

let t: TestDb;
let env: Env;
const CLIENT_ID = "test-client-id.access";

/**
 * An Access assertion, the way Access actually delivers one: RS256-signed by a key the Worker
 * reads from the team's certs. Here the "team" is a key pair made for this file and handed to the
 * Worker through setAccessKeySourceForTests — the real certs are never fetched from a test.
 * Since 3 Nov 2026 the Worker VERIFIES the signature (src/worker/accessJwt.ts), so a forged or
 * unsigned assertion must resolve to nobody; those cases are below.
 */
const APP_AUD = "3ee619ef7997f1d25f57d7ffe87bb3f2f6b66b801c6a31937f8dc734b3189b63";
const KID = "test-kid";
let teamKey: CryptoKeyPair;
let strangerKey: CryptoKeyPair;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function assertion(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; kid?: string; alg?: string } = {},
): Promise<string> {
  const head = `${b64json({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })}.${b64json(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? teamKey.privateKey, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

const base = () => ({ iss: ACCESS_TEAM_DOMAIN, aud: [APP_AUD], exp: Math.floor(Date.now() / 1000) + 3600 });
function agentJwt(commonName: string, over: Record<string, unknown> = {}, opts = {}): Promise<string> {
  return assertion({ ...base(), common_name: commonName, ...over }, opts);
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://test.local/api/me", { headers });
}

async function newKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  t = await createTestDb();
  // WP_OS_ENV is "local" in the test env, so the dev header is the human path here — the agent
  // path is deliberately independent of which human header is in use.
  env = makeTestEnv(t.db, { CF_ACCESS_CLIENT_ID: CLIENT_ID } as Partial<Env>);
  teamKey = await newKeyPair();
  strangerKey = await newKeyPair();
  const jwk = (await crypto.subtle.exportKey("jwk", teamKey.publicKey)) as JsonWebKey;
  setAccessKeySourceForTests(async () => [{ kid: KID, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }]);
});

afterAll(async () => {
  setAccessKeySourceForTests(null);
  await disposeTestDb(t);
});

describe("who the browser agent is", () => {
  it("resolves the read-only identity for the configured client id", async () => {
    const who = await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), env);
    expect(who?.id).toBe("fu_browser_agent");
  });

  it("holds no roles at all, which is the entire control", async () => {
    // Every reserved action, every approval and every activation checks for a role. An agent with
    // one would be an approver; an agent with none cannot decide anything, by the same machinery
    // that governs everyone else rather than by a special case.
    const who = await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), env);
    expect(who?.roles).toEqual([]);
    expect(who?.authorityScopes).toEqual([]);
  });

  it("is not a Managing Partner, so sensitive labels stay invisible to it", async () => {
    const who = await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), env);
    expect(who?.roles).not.toContain("MANAGING_PARTNER");
  });
});

describe("the ways it must not work", () => {
  it("refuses a client id that is not the configured one", async () => {
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt("someone-elses-token") }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt("") }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(`${CLIENT_ID}x`) }), env)).toBeNull();
  });

  it("does not exist at all when no client id is configured", async () => {
    // A deployment that never bound the secret must not have this capability lying around.
    const unbound = makeTestEnv(t.db);
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), unbound)).toBeNull();
  });

  it("never downgrades a signed-in human to the agent", async () => {
    // A partner browsing normally carries a human header. If the agent path could win, a request
    // could quietly lose its own identity — and its roles with it.
    const who = await resolveFirmUser(
      req({ "x-wpos-dev-user": "sequoia@westpeek.ventures", "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }),
      env,
    );
    expect(who?.id).toBe("fu_sequoia_taylor");
    expect(who?.roles).toContain("MANAGING_PARTNER");
  });

  it("cannot be reached without the assertion", async () => {
    expect(await resolveFirmUser(req(), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": "not-a-jwt" }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": "a.b" }), env)).toBeNull();
  });

  it("refuses an assertion minted for a different Access application", async () => {
    // Same account, different app. Without the aud check this would replay straight through.
    const other = req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, { aud: ["some-other-application"] }) });
    expect(await resolveFirmUser(other, env)).toBeNull();
  });

  it("refuses an expired assertion", async () => {
    const stale = req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, { exp: Math.floor(Date.now() / 1000) - 60 }) });
    expect(await resolveFirmUser(stale, env)).toBeNull();
  });

  it("resolves a verified human assertion to that human, never to the agent", async () => {
    // A person's assertion carries an email, not a common_name: it is that person.
    const human = req({ "Cf-Access-Jwt-Assertion": await assertion({ ...base(), email: "sequoia@westpeek.ventures" }) });
    expect((await resolveFirmUser(human, env))?.id).toBe("fu_sequoia_taylor");
  });

  it("refuses an assertion with neither an email nor a service-token name", async () => {
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await assertion(base()) }), env)).toBeNull();
  });
});

describe("a forged assertion resolves to nobody (signature verified, 3 Nov 2026)", () => {
  it("refuses the right claims with no valid signature", async () => {
    const real = await agentJwt(CLIENT_ID);
    const [h, c] = real.split(".");
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": `${h}.${c}.not-a-real-signature` }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": `${h}.${c}.${real.split(".")[2]!.slice(0, -4)}AAAA` }), env)).toBeNull();
  });

  it("refuses the right claims signed by a key that is not the team's", async () => {
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, {}, { key: strangerKey.privateKey }) }), env)).toBeNull();
    const human = await assertion({ ...base(), email: "sequoia@westpeek.ventures" }, { key: strangerKey.privateKey });
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": human }), env)).toBeNull();
  });

  it("refuses an unknown key id, another algorithm, and another issuer", async () => {
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, {}, { kid: "nobody" }) }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, {}, { alg: "none" }) }), env)).toBeNull();
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, { iss: "https://evil.cloudflareaccess.com" }) }), env)).toBeNull();
  });

  it("refuses an assertion with no expiry", async () => {
    expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID, { exp: undefined }) }), env)).toBeNull();
  });

  it("in a deployed environment, reads no identity header — only a verified assertion", async () => {
    const prod = makeTestEnv(t.db, { WP_OS_ENV: "production", CF_ACCESS_CLIENT_ID: CLIENT_ID } as Partial<Env>);
    expect(await resolveFirmUser(req({ "Cf-Access-Authenticated-User-Email": "sequoia@westpeek.ventures" }), prod)).toBeNull();
    expect(await resolveFirmUser(req({ "x-wpos-dev-user": "sequoia@westpeek.ventures" }), prod)).toBeNull();
    const human = req({ "Cf-Access-Jwt-Assertion": await assertion({ ...base(), email: "sequoia@westpeek.ventures" }) });
    expect((await resolveFirmUser(human, prod))?.id).toBe("fu_sequoia_taylor");
    expect((await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), prod))?.id).toBe("fu_browser_agent");
  });

  it("fails closed when the team's keys cannot be read", async () => {
    setAccessKeySourceForTests(async () => { throw new Error("certs down"); });
    try {
      expect(await resolveFirmUser(req({ "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }), env)).toBeNull();
    } finally {
      const jwk = (await crypto.subtle.exportKey("jwk", teamKey.publicKey)) as JsonWebKey;
      setAccessKeySourceForTests(async () => [{ kid: KID, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }]);
    }
  });
});

describe("what it is refused through the real routes", () => {
  let AGENT: Record<string, string> = {};
  beforeAll(async () => { AGENT = { "Cf-Access-Jwt-Assertion": await agentJwt(CLIENT_ID) }; });

  async function call(path: string, method = "GET", body?: unknown) {
    const res = await handleRequest(
      new Request(`https://test.local${path}`, {
        method,
        headers: body === undefined ? AGENT : { ...AGENT, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  it("can read a page, which is the whole point", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("fu_browser_agent");
  });

  it("cannot activate an employee", async () => {
    const res = await call("/api/ai/employees/aie_whitney/activate", "POST", {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot decide an approval", async () => {
    const res = await call("/api/approvals/ac_anything/decide", "POST", { decision: "approved" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot change the firm's spending policy", async () => {
    const res = await call("/api/ai/budget", "POST", {
      cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 999, per_run_cap_usd: 999,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot bring somebody out of retirement", async () => {
    const res = await call("/api/workforce/aie_priya/unretire", "POST", { reason: "because" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
