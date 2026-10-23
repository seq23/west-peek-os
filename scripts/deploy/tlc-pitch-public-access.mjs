#!/usr/bin/env node
/**
 * THE BRAND PITCH IS PUBLIC, AND ONLY IT (22 Oct 2026; hostile review B2: "the brand can't open the
 * link"). All of os.joinwestpeek.com sits behind Cloudflare Access, so a brand opening the pitch
 * link met a staff login. This adds ONE self-hosted Access application for exactly the path
 * `os.joinwestpeek.com/api/tlc-pitch` with a single Bypass/Everyone policy. A more specific path
 * application takes precedence over the host-wide one, so that path alone opens without a login;
 * every other path stays exactly as it is.
 *
 * What the Worker serves there (`handleTlcPitchPublic`): a 128-bit per-month token is the
 * credential, the page is read-only, carries nothing internal, and an unknown token is a bare 404.
 *
 * Idempotent: finds the application by domain first and changes nothing if it exists. Read-only
 * without --apply.
 *
 * Usage (values injected, never typed):
 *   npm run vault:run -- node scripts/deploy/tlc-pitch-public-access.mjs [--apply]
 * The token needs: Account → Access: Apps and Policies → Edit.
 */
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT_ID || !TOKEN) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set. Run under `npm run vault:run --`.");
  process.exit(2);
}
const DOMAIN = "os.joinwestpeek.com/api/tlc-pitch";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps`;
const APPLY = process.argv.includes("--apply");
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const list = await fetch(API, { headers });
const body = await list.json().catch(() => ({}));
if (!list.ok || !body.success) {
  console.error(`Could not read Access applications (HTTP ${list.status}): ${JSON.stringify(body.errors ?? []).slice(0, 300)}`);
  process.exit(1);
}
const apps = body.result ?? [];
console.log(`Access applications: ${apps.length}; on os.joinwestpeek.com: ${apps.filter((a) => String(a.domain).startsWith("os.joinwestpeek.com")).map((a) => a.domain).join(", ")}`);
const existing = apps.find((a) => a.domain === DOMAIN);
if (existing) {
  console.log(`Already in place: "${existing.name}" (${existing.domain}). Nothing to change.`);
  process.exit(0);
}
if (!APPLY) {
  console.log(`Would create a Bypass/Everyone application for ${DOMAIN}. Re-run with --apply.`);
  process.exit(0);
}
const created = await fetch(API, {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: "West Peek OS: public TLC brand pitch",
    domain: DOMAIN,
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    policies: [{ name: "Anyone may read a brand pitch", decision: "bypass", include: [{ everyone: {} }], precedence: 1 }],
  }),
});
const out = await created.json().catch(() => ({}));
if (!created.ok || !out.success) {
  console.error(`Not created (HTTP ${created.status}): ${JSON.stringify(out.errors ?? []).slice(0, 400)}`);
  process.exit(1);
}
console.log(`Created "${out.result.name}" for ${out.result.domain}.`);
