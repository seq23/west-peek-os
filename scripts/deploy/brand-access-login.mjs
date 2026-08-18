#!/usr/bin/env node
/**
 * Brand the Cloudflare Access login page — the first thing anyone sees of West Peek OS.
 *
 * WHY A SCRIPT AND NOT A CLICK. The dashboard can do this in a minute, and for a one-off that
 * would be fine. It is not a one-off: the values come from WEST_PEEK_BRAND_SYSTEM.md, which is
 * marked CANONICAL / LOCKED and says any change to the palette needs owner approval and an update
 * in every West Peek repo. A script keeps the login page and that file the same decision, so a
 * palette change is one edit and one run rather than something somebody remembers to redo by hand
 * in a console six months later.
 *
 * WHY IT IS NOT RUN AUTOMATICALLY. It needs an API token with Zero Trust write scope, which the
 * wrangler OAuth token on a developer machine does not carry (that one has workers, d1 and pages
 * and stops there). It also changes something every member of the firm sees, so it is deliberately
 * a decision somebody takes rather than a side effect of a deploy.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… node scripts/deploy/brand-access-login.mjs            # show the plan
 *   CLOUDFLARE_API_TOKEN=… node scripts/deploy/brand-access-login.mjs --apply    # write it
 *
 * The token needs: Account → Access: Organizations → Edit.
 * Create at https://dash.cloudflare.com/profile/api-tokens (Custom token).
 */

const ACCOUNT_ID = "8d147e242033699dd37c6f5a451f48d2";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/organizations`;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const APPLY = process.argv.includes("--apply");

/**
 * Straight from WEST_PEEK_BRAND_SYSTEM.md.
 *
 * Warm off-white ground with near-black type, which is what the brand file prescribes for page
 * backgrounds and high-authority text, and what the Fund I deck cover already looks like. Orange
 * is deliberately absent: it is an accent that must "guide attention rather than wash entire
 * pages", and Access offers no accent slot — only a background — so using it here would be exactly
 * the large orange fill the brand rule prohibits.
 *
 * The logo is the approved asset from the west-peek-community repository, served publicly from
 * westpeek.ventures. It has to be reachable WITHOUT authentication: this page renders before
 * anyone has signed in, so an asset behind Access would render as a broken image on the very
 * screen that exists to let people through.
 */
const DESIGN = {
  background_color: "#F7F2EA",
  text_color: "#050505",
  logo_path: "https://westpeek.ventures/assets/images/ventures-logo.png",
  header_text: "West Peek Ventures",
  footer_text: "Private and confidential. Access is limited to the firm.",
};

async function cf(method, body) {
  const res = await fetch(API, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ success: false, errors: [{ message: "unparseable response" }] }));
  return { status: res.status, data };
}

async function main() {
  if (!TOKEN) {
    console.error(
      "Refusing to run: CLOUDFLARE_API_TOKEN is not set.\n" +
        "Create a Custom token with Account → Access: Organizations → Edit at\n" +
        "https://dash.cloudflare.com/profile/api-tokens, then re-run.",
    );
    process.exit(2);
  }

  const current = await cf("GET");
  if (!current.data.success) {
    console.error(
      `Could not read the Access organisation (HTTP ${current.status}).\n` +
        JSON.stringify(current.data.errors ?? current.data, null, 2) +
        "\n\nAn authentication error here almost always means the token lacks\n" +
        "Access: Organizations scope rather than that it is wrong.",
    );
    process.exit(1);
  }

  const org = current.data.result ?? {};
  const before = org.login_design ?? {};
  console.log(`Organisation: ${org.name ?? "(unnamed)"}  ·  ${org.auth_domain ?? "(no auth domain)"}\n`);
  console.log("Current login page:");
  console.log(JSON.stringify(before, null, 2) || "(nothing set)");
  console.log("\nWould set:");
  console.log(JSON.stringify(DESIGN, null, 2));

  // The logo renders on a page shown BEFORE sign-in, so it has to be fetchable by anyone. A broken
  // image on the login screen is worse than no logo, and it is the one asset nobody would think to
  // re-check after a site reorganisation.
  const logo = await fetch(DESIGN.logo_path, { method: "HEAD" }).catch(() => null);
  if (!logo || !logo.ok) {
    console.error(`\nRefusing to continue: the logo is not publicly reachable (${DESIGN.logo_path}).`);
    process.exit(1);
  }
  console.log(`\nLogo reachable without auth: ${logo.status} ${logo.headers.get("content-type") ?? ""}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write it.");
    return;
  }

  const updated = await cf("PUT", { ...org, login_design: { ...before, ...DESIGN } });
  if (!updated.data.success) {
    console.error(`\nNot applied (HTTP ${updated.status}).`);
    console.error(JSON.stringify(updated.data.errors ?? updated.data, null, 2));
    process.exit(1);
  }
  console.log("\nApplied. Open the Access login page in a private window to see it.");
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
