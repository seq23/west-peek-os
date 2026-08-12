import { expect, test } from "@playwright/test";

/**
 * P5 browser journey against local `wrangler dev`:
 * dev-header login as Scooter (MP) → upload a small document → create a company
 * → manually add a sourced claim → add a conflicting claim → deterministic
 * detection proposes a contradiction → open it → it appears in the company
 * evidence summary (un-hidable) → resolve it (human disposition) → the Activity
 * spine shows the typed events.
 *
 * Runs fully offline: local D1 + local R2 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P5 evidence journey: document upload → conflicting claims → contradiction → resolve → spine events", async ({ page, request }) => {
  const marker = `E2E-P5-${Date.now()}`;

  // Login (dev header, local mode).
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // Upload a small document (R2 round-trip; SHA-256 recorded).
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByTestId("doc-title").fill(`${marker} note`);
  await page.getByTestId("doc-file").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from(`ARR: $4.2M (2025)\nBurn: $180k/mo (2025)`) });
  await page.getByTestId("doc-submit").click();
  await expect(page.getByTestId("doc-message")).toContainText("Uploaded doc_");
  await expect(page.getByTestId("doc-message")).toContainText("sha256");

  // Create a company and open its evidence surface.
  await page.getByRole("button", { name: "Companies", exact: true }).click();
  await page.getByTestId("company-create-name").fill(`${marker} Co`);
  await page.getByTestId("company-create-submit").click();
  await expect(page.getByTestId("company-message")).toContainText("Created");
  await page.locator('button[data-testid^="company-open-"]', { hasText: `${marker} Co` }).click();
  await expect(page.getByTestId("company-detail")).toBeVisible();

  // Manually add a claim with source provenance.
  await page.getByTestId("claim-text").fill(`${marker}: ARR is $4M`);
  await page.getByTestId("claim-metric-key").fill("arr");
  await page.getByTestId("claim-metric-value").fill("$4M");
  await page.getByTestId("claim-submit").click();
  await expect(page.getByTestId("claim-message")).toContainText("UNVERIFIED");

  // Add a conflicting claim (same metric, different value).
  await page.getByTestId("claim-text").fill(`${marker}: ARR is $6M`);
  await page.getByTestId("claim-metric-key").fill("arr");
  await page.getByTestId("claim-metric-value").fill("$6M");
  await page.getByTestId("claim-submit").click();
  await expect(page.getByTestId("claim-message")).toContainText("UNVERIFIED");

  // Deterministic detection proposes the contradiction; a human opens it.
  await page.getByTestId("detect-contradictions").click();
  await expect(page.getByTestId("candidate-0")).toContainText("VALUE");
  await page.getByTestId("open-contradiction-0").click();
  await expect(page.getByTestId("claim-message")).toContainText("Contradiction ctr_");

  // The contradiction is visible in the evidence summary (material, unresolved).
  const summaryItem = page.locator('li[data-testid^="summary-contradiction-"]').first();
  await expect(summaryItem).toBeVisible();
  await expect(summaryItem).toContainText("HIGH");
  await expect(summaryItem).toContainText("OPEN");

  // Resolve it (human disposition with evidence note).
  await page.locator('select[data-testid^="resolve-disposition-"]').first().selectOption("RESOLVED");
  await page.locator('input[data-testid^="resolve-note-"]').first().fill("Confirmed $4M with founder; $6M was aspirational.");
  await page.locator('button[data-testid^="resolve-submit-"]').first().click();
  await expect(page.getByTestId("no-material-contradictions")).toBeVisible();

  // The contradictions register shows the disposition.
  await page.getByRole("button", { name: "Contradictions", exact: true }).click();
  const resolved = page.locator('li[data-testid^="contradiction-"]', { hasText: "arr" }).first();
  await expect(resolved).toContainText("RESOLVED");
  await expect(resolved).toContainText("fu_scooter_taylor");

  // The Activity spine shows the typed P5 events.
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByTestId("activity-event-document.uploaded").first()).toBeVisible();
  await expect(page.getByTestId("activity-event-claim.created").first()).toBeVisible();
  await expect(page.getByTestId("activity-event-contradiction.created").first()).toBeVisible();
  await expect(page.getByTestId("activity-event-contradiction.resolved").first()).toBeVisible();

  // The evidence summary is also served via the API with the claims by status.
  const companiesRes = await request.get("/api/companies", { headers: MP });
  const companies = (await companiesRes.json()) as { companies: Array<{ id: string; canonical_name: string }> };
  const mine = companies.companies.find((c) => c.canonical_name === `${marker} Co`);
  expect(mine).toBeTruthy();
  const summaryRes = await request.get(`/api/companies/${mine!.id}/evidence-summary`, { headers: MP });
  const summary = (await summaryRes.json()) as { claims_by_status: Record<string, number>; unresolved_material_contradictions: unknown[] };
  expect(summary.claims_by_status.UNVERIFIED).toBe(2);
  expect(summary.unresolved_material_contradictions).toHaveLength(0); // resolved above
});
