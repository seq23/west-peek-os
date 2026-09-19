import { expect, test } from "@playwright/test";

/**
 * Sign-in, sign-out, and the state between them (P42).
 *
 * The defect this covers: sign-out was rendered only when a dev identity existed, so in production
 * — behind Cloudflare Access, the only real deployment — there was no way to sign out at all. And
 * signing out dropped you onto a login form nearly identical to the one you started at, giving no
 * confirmation anything had happened.
 */

test("signing out ends the session and says so", async ({ page }) => {
  await page.goto("/");

  // The sign-in surface carries the brand and explains why the page is empty.
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await expect(page.getByTestId("dev-login")).toContainText("West Peek OS");
  await expect(page.getByTestId("dev-login")).toContainText("knows who is asking");

  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // Sign out is offered whenever signed in — not only in dev mode.
  const out = page.getByTestId("sign-out");
  await expect(out).toBeVisible();

  // THE REAL SEQUENCE, pinned. Locally the session IS the dev identity in localStorage: sign-out
  // drops it, then asks /api/me again without it, and the 401 that comes back is what ends the
  // session on the page. So: the click, the 401, THEN the sentence — and the shell must survive
  // the reads Home's children send in between (they go out without an identity too; see the
  // fourth journey in this file for the day that emptied the whole page).
  const ended = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 401);
  await out.click();
  expect((await ended).status()).toBe(401);

  // A distinct landing page, so it is unmistakable that the session ended.
  await expect(page.getByTestId("signed-out-page")).toBeVisible();
  await expect(page.getByTestId("signed-out-page")).toContainText("You are signed out");
  await expect(page.getByTestId("identity-status")).not.toContainText("Scooter Taylor");
  // The shell is still there: the page was not blanked to get here.
  await expect(page.getByTestId("identity-status")).toBeVisible();
  await expect(page.getByTestId("surface-fault")).toHaveCount(0);

  // The identity is genuinely gone, not merely hidden: a reload must not restore it.
  await page.reload();
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await expect(page.getByTestId("identity-status")).not.toContainText("Scooter Taylor");
});

test("the signed-out page leads back in", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  // The session must have LANDED before it is ended. Clicking sign-out while the sign-in response
  // is still in flight lets the late response re-establish the session after sign-out has run, and
  // the signed-out page never appears — seen once in a full run on 18 Sep 2026, 145/146. The first
  // test in this file already sequences it this way; this one now holds the same line.
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("signed-out-page")).toBeVisible();

  await page.getByTestId("signed-out-signin").click();
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await page.getByTestId("dev-login-email").fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  // Signing back in as someone else must land as THAT person, not the previous session.
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");
});

test("no institutional state is visible signed out", async ({ page }) => {
  await page.goto("/");
  // The system's stated posture: nothing about the firm before it knows who is asking.
  await expect(page.getByTestId("home-page")).toHaveCount(0);
  await expect(page.getByTestId("page-purpose-home")).toHaveCount(0);
});

/**
 * THE SIGN-OUT RACE, MADE DETERMINISTIC (19 Sep 2026, CI on main, run 35457328146: 171/172).
 *
 * On a slow runner she pressed Sign out before Home's children had sent their first reads. Those
 * reads went out without an identity and came back 401 `{error}`; four children read fields off
 * that body as if it were the shape they asked for, one threw, and React unmounted the WHOLE tree:
 * no identity line, no Sign out, no signed-out page — `#root` empty. Two guarantees now:
 *   · `useApi` hands `data` only for a 2xx, so a refusal can never wear a page's shape;
 *   · `SurfaceBoundary` keeps a page that still throws inside its own place.
 * This journey forces both: every read Home's children make is answered 401 while she is signed
 * in, and one of them is then answered 200 with the wrong shape.
 */
test("a page that is refused, or that throws, does not take the session with it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Every read Home's children make, refused — the exact bodies the runner saw.
  await page.route(
    (u) => /^\/api\/(me\/connections|daily-intelligence(\/.*)?|deliverables|mp-home\/(seen|preferences))$/.test(u.pathname),
    (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized", detail: "no identity on the request" }) }),
  );
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await expect(page.getByTestId("home-page")).toBeVisible();
  // Nothing threw, nothing blanked: the identity line and Sign out are still on the page.
  expect(errors, "a refused read must never throw in render").toEqual([]);
  await expect(page.getByTestId("sign-out")).toBeVisible();
  await expect(page.getByTestId("surface-fault")).toHaveCount(0);

  // Now a read that SUCCEEDS with the wrong shape — the one thing `useApi` cannot guard.
  await page.unroute(() => true);
  await page.route((u) => u.pathname === "/api/deliverables", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ not: "the shape" }) }));
  await page.reload();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await expect(page.getByTestId("surface-fault")).toBeVisible();
  await expect(page.getByTestId("surface-fault")).toContainText("Home hit a fault");
  // The shell survived the page: she can still sign out, and the signed-out page still appears.
  await expect(page.getByTestId("sign-out")).toBeVisible();
  const ended = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 401);
  await page.getByTestId("sign-out").click();
  await ended;
  await expect(page.getByTestId("signed-out-page")).toBeVisible();
});
