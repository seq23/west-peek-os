import { expect, test } from "@playwright/test";
import { gotoSurface, openDisclosure } from "./support/nav";
import { openNavIfCollapsed } from "./support/nav";

/**
 * P20 browser journey — notifications + mobile/PWA surface (GAP-19, GAP-20).
 *
 * Journey: sign in → the status bar shows unread exceptions and the connection state → submit an
 * approval, which raises a notification → read and acknowledge it → set quiet hours → the manifest
 * and service worker are served → the shell is usable at a phone width.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("an approval raises a notification the operator can read and acknowledge", async ({ page, request }) => {
  await signIn(page);
  await expect(page.getByTestId("status-bar")).toBeVisible();
  await expect(page.getByTestId("status-connection")).toContainText("online");

  const headers = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };
  const card = await request.post("/api/approvals", {
    headers,
    data: {
      action_key: "governance.policy_change",
      object_type: "provider_registry",
      object_id: "anthropic",
      title: "Journey approval for the notification centre",
      submit: true,
    },
  });
  expect(card.status()).toBe(201);

  await page.getByTestId("status-notifications").click();
  await expect(page.getByTestId("notifications-page")).toBeVisible();
  /*
   * The centre sorts by what it wants FROM you. An approval waiting on a decision is "Needs you";
   * "Worth knowing" and "Handled" are the other two lists. There is no single `notification-list`
   * any more, and asserting the right list is stronger than asserting the page: a decision filed
   * under "worth knowing" is a decision nobody makes.
   */
  await expect(page.getByTestId("notifications-needs-you")).toContainText("Journey approval for the notification centre");
  // Dismiss and Take responsibility are different acts, and the page says so where the buttons are.
  await expect(page.getByTestId("notifications-ack-explainer")).toContainText("puts");

  const item = page.locator('li[data-testid^="notification-ntf_"]', { hasText: "Journey approval" }).first();
  await item.locator('[data-testid^="notification-ack-"]').click();
  // The confirmation says what acknowledging COSTS you — your name and the time against it —
  // rather than naming the table it landed in.
  await expect(page.getByTestId("notifications-message")).toContainText("Your name and the time are on the record");
});

test("quiet hours can be set and are described honestly", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Notifications");
  // Quiet hours and the rules that survive them live behind the settings disclosure — in the DOM
  // and invisible until it is opened, which is why this used to time out on `quiet-start`.
  await openDisclosure(page, "notifications-settings");
  await expect(page.getByTestId("notification-rules")).toContainText("CRITICAL notifications are never held");
  await expect(page.getByTestId("notification-rules")).toContainText("recorded UNAVAILABLE");

  // Two dropdowns reading as a sentence — "Hold everything from … until …" — rather than two boxes
  // and a unit nobody thinks in. So they are SELECTED, not typed into.
  await page.getByTestId("quiet-start").selectOption("22");
  await page.getByTestId("quiet-end").selectOption("6");
  /*
   * The window is described in the operator's own terms before she saves it, and pressing Save now
   * says so — "previously pressing Save did nothing visible at all". Both are asserted: the honesty
   * about what quiet hours do NOT hold back, and that the control acknowledges the press.
   */
  await expect(page.getByTestId("quiet-hours-plain")).toContainText("Anything critical still comes through");
  await page.getByTestId("quiet-submit").click();
  await expect(page.getByTestId("quiet-saved")).toBeVisible();
});

test("the app is installable and works at a phone width", async ({ page, request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).display).toBe("standalone");

  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("Institutional state is never served from cache");

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  // The primary surfaces stay reachable one-handed: the nav becomes a grouped full-height sheet
  // opened from the top bar, and every destination inside it is still a real visible button.
  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await openNavIfCollapsed(page);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Approvals", exact: true })).toBeVisible();

  // The sheet's own toggle and its rows clear the 44px one-handed target floor.
  for (const target of [toggle, page.getByRole("button", { name: "Approvals", exact: true })]) {
    const box = (await target.boundingBox())!;
    expect(box.height, "one-handed targets must clear the 44px floor").toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "Approvals", exact: true }).click();
  await expect(page.getByTestId("approvals-page")).toBeVisible();
  // Choosing a destination is the whole interaction: the sheet closes behind it.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
