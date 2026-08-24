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

/*
 * ── FIXED 22 AUG 2026: QUIET HOURS WERE SET, STORED, DESCRIBED — AND NEVER APPLIED ─────────────
 *
 * `notify()` reads `notification_preference` only when `input.firmUserId` is set, and SIX of the ten
 * call sites never set it — approvals (all three), portfolio alerts, dead-lettered jobs, LP chasers
 * and employee lifecycle. A notification with no `firm_user_id` is a firm-wide row: it reads
 * perfectly well on the page, and it has nobody whose preferences could be consulted. So `pref` was
 * null for the kinds the operator sees MOST, the quiet-hours branch was never reached for them, and
 * they were written `DELIVERED_IN_APP` whatever she had asked for.
 *
 * That took the whole preference surface with it, not just quiet hours: the per-kind switches and
 * the minimum-severity rule live in the same unreachable branch. She asked for the timezone half in
 * her own words — "i could be traveling on diff time zone so let me select time zone for quiet
 * hours" — and the named zone, the DST correctness and the crossing-midnight arithmetic were all
 * there and all correct. Nothing called them.
 *
 * THE FIX IS ADDRESSING, NOT A NEW RULE. `notifyPartners()` writes a notice meant for the partners
 * ONCE PER PARTNER, keyed by the recipient so each gets exactly one and neither gets two. Each
 * partner's own quiet hours then apply, in their own timezone — which is the entire point of a
 * setting that follows you when you travel. Reading `firm_user` through the ROLE JOIN rather than a
 * name list, because a notification needs an id and the registry holds names: the sixth instance of
 * that divergence in this codebase.
 *
 * One claim was also trimmed rather than fixed, because it was larger than the truth: the page said
 * quiet hours "hold everything back". Nothing is removed from the notification centre by holding —
 * a held notice is still there to read — and no push service, VAPID key or subscription exists in
 * this environment, so the only channel that could actually interrupt her is UNAVAILABLE at every
 * hour. The copy now says what it does.
 */
test("quiet hours actually hold something back, and say so on the record", async ({ page, request }) => {
  /*
   * THE TEST ABOVE SETS QUIET HOURS AND NEVER PROVES THEY BIND.
   *
   * It selects two dropdowns, presses Save, and asserts the page acknowledged the press. All of that
   * is real and none of it says a notification raised inside the window is treated differently from
   * one raised outside it — which is the entire feature. A preference that displays and does not
   * bind is the same class of defect as a budget that displays and does not bind, and this surface
   * had exactly that shape.
   *
   * THE WINDOW IS BUILT AROUND NOW, in the reader's own zone. Quiet hours are stored as a named
   * timezone precisely so "9 PM" means 9 PM where the partner is, so the hour is read from the page
   * rather than assumed to be UTC — a spec that hardcoded a window would pass or fail depending on
   * what time the suite happened to run.
   */
  await signIn(page);
  await gotoSurface(page, "Notifications");
  await openDisclosure(page, "notifications-settings");

  const hour = await page.evaluate(() => new Date().getHours());
  await page.getByTestId("quiet-start").selectOption(String(hour));
  await page.getByTestId("quiet-end").selectOption(String((hour + 2) % 24));
  await page.getByTestId("quiet-submit").click();
  await expect(page.getByTestId("quiet-saved")).toBeVisible();

  const headers = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };
  const marker = `E2E-QUIET-${Date.now()}`;
  try {
    const card = await request.post("/api/approvals", {
      headers,
      data: {
        action_key: "governance.policy_change",
        object_type: "provider_registry",
        object_id: "anthropic",
        title: `${marker} raised inside the quiet window`,
        submit: true,
      },
    });
    expect(card.status(), await card.text()).toBe(201);

    /*
     * HELD, AND THE RECORD SAYS WHY. Not dropped — the row is in the centre either way, because a
     * notification that vanishes during quiet hours is one the partner never learns about at all.
     * What changes is the delivery, and the delivery states its own reason.
     */
    const raised = (await (await request.get("/api/notifications", { headers })).json()) as {
      notifications: Array<{ id: string; title: string; delivery_status: string }>;
    };
    const held = raised.notifications.find((n) => n.title.includes(marker));
    expect(held, "a held notification is still in the centre — quiet hours delay, they do not delete").toBeTruthy();
    expect(held!.delivery_status, "raised inside the window, it is held rather than pushed").toBe("HELD_QUIET_HOURS");

    const deliveries = (await (await request.get(`/api/notifications/${held!.id}/deliveries`, { headers })).json()) as {
      deliveries: Array<{ channel: string; status: string; detail: string | null }>;
    };
    expect(deliveries.deliveries.length, "the attempt is on the record, not inferred").toBeGreaterThan(0);
    expect(
      deliveries.deliveries.map((d) => `${d.status} ${d.detail ?? ""}`).join(" "),
      "the reason it was held is written down where somebody can read it",
    ).toContain("quiet hours");
  } finally {
    /*
     * PUT THE PARTNER'S PREFERENCES BACK. Every spec after this one drives the same database, and
     * leaving the firm inside a quiet window would hold THEIR notifications for a reason that has
     * nothing to do with them — the README's own warning about switching something off for
     * everything that follows.
     */
    await request.post("/api/notifications/preferences", {
      headers,
      data: { quiet_hours: {}, kinds: {}, push_enabled: false },
    });
  }
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
