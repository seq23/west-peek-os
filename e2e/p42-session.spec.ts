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
  await out.click();

  // A distinct landing page, so it is unmistakable that the session ended.
  await expect(page.getByTestId("signed-out-page")).toBeVisible();
  await expect(page.getByTestId("signed-out-page")).toContainText("You are signed out");
  await expect(page.getByTestId("identity-status")).not.toContainText("Scooter Taylor");

  // The identity is genuinely gone, not merely hidden: a reload must not restore it.
  await page.reload();
  await expect(page.getByTestId("dev-login")).toBeVisible();
  await expect(page.getByTestId("identity-status")).not.toContainText("Scooter Taylor");
});

test("the signed-out page leads back in", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await page.getByTestId("sign-out").click();

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
