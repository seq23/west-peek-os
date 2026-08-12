import { expect, test } from "@playwright/test";

/**
 * P4 browser journey against local `wrangler dev`:
 * dev-header login as Scooter (MP) → run a mock-local AI task through the
 * governed boundary → the completed run + trace appears in the run list →
 * a credential-shaped input is blocked with a visible reason → toggle a
 * provider kill switch as MP (approval-receipt path, all logged).
 *
 * The seeded default firmwide policy is LOCKDOWN, so runs take the deterministic
 * local adapter — no external provider is ever contacted.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P4 AI journey: governed run, blocked run reason, provider kill switch", async ({ page, request }) => {
  const marker = `E2E AI run ${Date.now()}`;

  // Login (dev header, local mode).
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // AI page: run a mock-local task (LOCKDOWN default → local adapter).
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByTestId("ai-purpose").fill(marker);
  await page.getByTestId("ai-input").fill("Summarize the weekly portfolio notes for the command center.");
  await page.getByTestId("ai-run-submit").click();
  await expect(page.getByTestId("ai-message")).toContainText("COMPLETED");
  await expect(page.getByTestId("ai-message")).toContainText("trace trc_");

  // The completed run is listed with its trace id.
  const completedRun = page.locator('li[data-testid^="ai-run-"]').filter({ hasText: marker }).first();
  await expect(completedRun).toBeVisible();
  await expect(completedRun).toContainText("COMPLETED");
  await expect(completedRun).toContainText("mock-local");

  // A credential-shaped input is blocked with a visible reason — before any provider call.
  const blockedMarker = `E2E blocked ${Date.now()}`;
  await page.getByTestId("ai-purpose").fill(blockedMarker);
  await page.getByTestId("ai-input").fill("use this key sk-a1b2c3d4e5f6g7h8 for the call");
  await page.getByTestId("ai-run-submit").click();
  await expect(page.getByTestId("ai-message")).toContainText("EGRESS_BLOCKED");
  const blockedRun = page.locator('li[data-testid^="ai-run-"]').filter({ hasText: blockedMarker }).first();
  await expect(blockedRun).toContainText("EGRESS_BLOCKED");
  await expect(blockedRun).toContainText("credential_like_content");

  // Kill switch as MP: governed (approval receipt) and logged. Idempotent across
  // re-runs of this spec against the same local D1.
  const killButton = page.getByTestId("kill-switch-openai");
  if (await killButton.isVisible().catch(() => false)) {
    await killButton.click();
    await expect(page.getByTestId("ai-message")).toContainText("kill-switched");
  }
  await expect(page.getByTestId("provider-ks-openai")).toHaveText("yes");

  // The kill switch left an audit event on the spine.
  await expect
    .poll(async () => {
      const res = await request.get("/api/activity?limit=100", { headers: MP });
      const body = (await res.json()) as { events: Array<{ event_type: string; object_id: string }> };
      return body.events.some((e) => e.event_type === "provider.kill_switched" && e.object_id === "openai");
    })
    .toBe(true);

  // The run list is also served via the API with trace ids intact.
  const runs = await (await request.get("/api/ai/runs", { headers: MP })).json();
  const mine = (runs.runs as Array<{ purpose: string; trace_id: string; status: string }>).find((r) => r.purpose === marker);
  expect(mine?.status).toBe("COMPLETED");
  expect(mine?.trace_id).toMatch(/^trc_/);
});
