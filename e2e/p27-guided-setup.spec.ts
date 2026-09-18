import { expect, test } from "@playwright/test";
import { gotoSurface, openWorkMachinery } from "./support/nav";

/**
 * P27 browser journey — guided setup, the recommended team, and employee→work dependencies.
 *
 * The properties under test are the governance ones, not the cosmetic ones. A setup wizard that
 * could activate an employee would be a way around the activation cap and the approval receipt, so
 * these assert that it cannot: it explains, it points at the governed surface, and it tells the
 * truth about whether each role can actually do work.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("a partially configured operator can discover setup and read the recommended team", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Set up");
  await expect(page.getByTestId("setup-page")).toBeVisible();

  // Slot usage is derived from the server, never declared locally.
  await expect(page.getByTestId("setup-slots")).toContainText("activation slots in use");

  // The recommendation is present, ranked, and each entry carries a reason and a priority.
  const list = page.getByTestId("setup-recommended");
  await expect(list).toBeVisible();
  // The role as the registry states it. "LP Relations Manager" was the old title.
  await expect(page.getByTestId("setup-rec-wesley")).toContainText("LP Relations");
  await expect(page.getByTestId("setup-rec-wesley")).toContainText("Answers:");
  await expect(page.getByTestId("setup-rec-willow")).toContainText("Compliance");
});

test("the cap's cost is shown rather than hidden", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Set up");

  /*
   * THE CAP IS STATED AGAINST ITS USAGE, AND ITS COST IS NAMED WHEN IT HAS ONE.
   *
   * This used to be unconditional — six stated priorities against five slots meant one was always
   * uncovered, and the page had to say which. Migration 0136 raised the cap to the whole roster, so
   * the recommended team now covers every priority and there is no trade-off to report. The rule
   * did not change: a cap that leaves a priority uncovered must NAME it and still list the role
   * that would have covered it. So the rule is asserted in the form it actually takes, both ways,
   * rather than asserting a consequence that no longer has a case.
   */
  await expect(page.getByTestId("setup-slots")).toContainText("activation slots in use");

  const uncovered = page.getByTestId("setup-uncovered");
  if ((await uncovered.count()) > 0) {
    await expect(uncovered).toContainText("not covered");
    await expect(uncovered).toContainText("trade-off, not an oversight");
    // The roles that WOULD have covered it are still shown rather than quietly dropped.
    await expect(page.getByTestId("setup-also-considered")).toBeVisible();
  } else {
    // Nothing is uncovered — and the page must not invent a trade-off it does not have.
    await expect(page.getByTestId("setup-also-considered")).toHaveCount(0);
  }
});

test("setup never activates anyone — it routes to the governed surface", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Set up");

  const page_ = page.getByTestId("setup-page");
  // No control on this page performs an activation.
  await expect(page_.getByRole("button", { name: /activate/i })).toHaveCount(0);
  /*
   * And it says where the governed step lives, naming the receipt requirement — on the roles that
   * are not employed yet. A role already ACTIVE reads "Already active — nothing to do", which is
   * the correct thing to say and carries no receipt sentence; since 0136 employed the whole roster
   * that is most of them, so the assertion targets whichever recommendation still has the step in
   * front of it rather than a name that happens to be switched off today.
   */
  const notYet = page.locator('[data-testid^="setup-rec-"]', { hasNotText: "Already active" }).first();
  if ((await notYet.count()) > 0) {
    await expect(notYet).toContainText("Managing Partner approval receipt");
  }

  // The contextual help states the same law.
  await page.getByTestId("how-this-works-toggle-setup").click();
  await expect(page.getByTestId("how-this-works-body-setup")).toContainText(
    "never activates anyone",
  );
});

test("each recommended role reports whether it can actually work, with a next action", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Set up");

  const readiness = page.getByTestId("setup-readiness-wesley");
  const unknown = page.getByTestId("setup-deps-unknown-wesley");

  // One of the two must render: either the dependency chain resolved, or the page admits it did
  // not. Silence about readiness is the failure this test exists to prevent.
  await expect(readiness.or(unknown)).toBeVisible();

  if (await readiness.isVisible()) {
    await expect(readiness).toContainText("Works through:");
    const state = page.getByTestId("setup-readiness-state-wesley");
    await expect(state).toHaveText(/Can work now|Blocked|Not activated/);

    // Whenever it is not ready, every blocker must carry an action — never a bare "blocked".
    if ((await state.textContent())?.trim() !== "Can work now") {
      const blockers = page.getByTestId("setup-blockers-wesley");
      await expect(blockers).toBeVisible();
      await expect(blockers.locator("li").first()).not.toHaveText(/^\s*$/);
    }
  }
});

test("setup is reachable from the everyday rail, not buried in system administration", async ({ page }) => {
  await signIn(page);
  // It must be a primary destination: visible without opening the More / System disclosure.
  await expect(page.getByRole("button", { name: "Set up", exact: true })).toBeVisible();
  await expect(page.getByTestId("nav-system-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("recurring work is proposed as PAUSED, with blockers that name the fix", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Set up");

  await expect(page.getByTestId("setup-jobs-law")).toContainText("PAUSED");
  await expect(page.getByTestId("setup-jobs-law")).toContainText("Nothing starts running on its own");

  const prep = page.getByTestId("setup-job-wednesday_mp_meeting_prep");
  await expect(prep).toContainText("Wednesday MP meeting preparation");
  await expect(prep).toContainText("Wren");

  // No control on this page creates or enables a job — creation stays on Scheduled Work.
  const setup = page.getByTestId("setup-page");
  await expect(setup.getByRole("button", { name: /switch on|enable|create job/i })).toHaveCount(0);

  // A blocked proposal must say what to do about it, never just "blocked".
  const blockers = page.getByTestId("setup-job-blockers-wednesday_mp_meeting_prep");
  if (await blockers.isVisible()) {
    await expect(blockers).toContainText(/approval receipt|not active|No AI provider/);
  }
});

test("Home answers 'what is blocked' or stays honestly silent", async ({ page }) => {
  await signIn(page);
  // Home is the default surface.
  const strip = page.getByTestId("home-attention");

  if (await strip.isVisible()) {
    // Every item must carry a headline, an action, and a way to get there.
    const first = strip.locator("li").first();
    await expect(first).not.toHaveText(/^\s*$/);
    await expect(first.getByRole("button", { name: "Open" })).toBeVisible();
    // Severity is stated, not implied by colour alone.
    await expect(first).toHaveText(/Blocked|Degraded|Setup/);
  } else {
    // Silence is a valid answer, but only when nothing is wrong — the strip must not be
    // suppressed while a dead-lettered job exists. Confirm via the jobs surface.
    await openWorkMachinery(page);
    const deadLetters = await page.getByText(/dead-letter/i).count();
    expect(deadLetters, "Home hid the attention strip while jobs report dead letters").toBe(0);
  }
});
