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
  // The square WP mark. The horizontal ventures wordmark would be the better shape, but it is not
  // actually deployed: every path serving it returns the site's SPA fallback — HTTP 200 carrying
  // index.html — which is precisely the trap the byte check below exists to catch. Swap this the
  // day the wordmark is genuinely reachable.
  logo_path: "https://westpeek.ventures/assets/images/WP_Logo_1080x1080.png",
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

  // The logo renders on a page shown BEFORE sign-in, so it must be fetchable by anyone. A broken
  // image on the login screen is worse than no logo, and it is the one asset nobody would think to
  // re-check after a site reorganisation.
  //
  // CHECKED BY ITS BYTES, NOT ITS STATUS. The first version of this guard accepted any 200 and
  // would have shipped a broken logo: every candidate path on westpeek.ventures returns 200 with
  // the SPA's index.html, because a single-page app answers an unknown path with its shell rather
  // than a 404. "It responded" is not "it is an image", and the difference is only visible in the
  // first few bytes.
  const logoRes = await fetch(DESIGN.logo_path).catch(() => null);
  if (!logoRes || !logoRes.ok) {
    console.error(`\nRefusing to continue: the logo is not publicly reachable (${DESIGN.logo_path}).`);
    process.exit(1);
  }
  const head = new Uint8Array((await logoRes.arrayBuffer()).slice(0, 12));
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46;
  const isWebp = head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  if (!isPng && !isJpeg && !isGif && !isWebp) {
    console.error(
      `\nRefusing to continue: ${DESIGN.logo_path} answered ${logoRes.status} but is not an image.\n` +
        `Content-Type says "${logoRes.headers.get("content-type") ?? "unknown"}" and the first bytes are ` +
        `${[...head.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}.\n` +
        "A single-page app answers an unknown path with its shell, so this is almost certainly the\n" +
        "site's index.html rather than a missing server.",
    );
    process.exit(1);
  }
  console.log(
    `\nLogo verified without auth: ${logoRes.status}, ` +
      `${isPng ? "PNG" : isJpeg ? "JPEG" : isGif ? "GIF" : "WebP"} by its bytes ` +
      `(served as ${logoRes.headers.get("content-type") ?? "unknown"}).`,
  );

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
