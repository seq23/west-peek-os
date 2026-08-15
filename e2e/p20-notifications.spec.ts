import { expect, test } from "@playwright/test";
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
  await expect(page.getByTestId("notification-list")).toContainText("Journey approval for the notification centre");
  await expect(page.getByTestId("notifications-note")).toContainText("held notifications still appear here");

  const item = page.locator('li[data-testid^="notification-ntf_"]', { hasText: "Journey approval" }).first();
  await item.locator('[data-testid^="notification-ack-"]').click();
  await expect(page.getByTestId("notifications-message")).toContainText("recorded on the audit spine");
});

test("quiet hours can be set and are described honestly", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByTestId("notification-rules")).toContainText("CRITICAL notifications are never held");
  await expect(page.getByTestId("notification-rules")).toContainText("recorded UNAVAILABLE");

  await page.getByTestId("quiet-start").fill("22");
  await page.getByTestId("quiet-end").fill("6");
  await page.getByTestId("quiet-submit").click();
  await expect(page.getByTestId("notifications-message")).toContainText("Critical notifications are still delivered");
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
