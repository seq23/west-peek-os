import { expect, test } from "@playwright/test";
import { gotoSurface, openDisclosure } from "./support/nav";

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
  // WHAT IT IS, chosen from a list — the free-text box defaulting to `diligence_note` is gone.
  await page.getByTestId("doc-type").selectOption("DILIGENCE_NOTE");
  await expect(page.getByTestId("doc-type-means")).toContainText("Something you learned about a company");
  await page.getByTestId("doc-file").setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from(`ARR: $4.2M (2025)\nBurn: $180k/mo (2025)`) });
  await page.getByTestId("doc-submit").click();
  await expect(page.getByTestId("doc-message")).toContainText("Uploaded doc_");
  await expect(page.getByTestId("doc-message")).toContainText("sha256");

  // Create a company and open its evidence surface.
  /*
   * The evidence workbench — creating a company, its claims, verification, contradictions — folded
   * into the `company-identity` disclosure under the register. Everything inside a closed
   * `<details>` is in the DOM and invisible, so this used to time out on a control that was there
   * the whole time, behind a shut lid.
   */
  await gotoSurface(page, "Companies");
  await openDisclosure(page, "company-identity");
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
  // The candidate names the KIND of disagreement in words ("value"), not the enum, and quotes
  // both figures — which is the part a partner has to read before opening it.
  await expect(page.getByTestId("candidate-0")).toContainText("value");
  await expect(page.getByTestId("candidate-0")).toContainText("$4M");
  await page.getByTestId("open-contradiction-0").click();
  await expect(page.getByTestId("claim-message")).toContainText("Contradiction ctr_");

  // The contradiction is visible in the evidence summary (material, unresolved).
  const summaryItem = page.locator('li[data-testid^="summary-contradiction-"]').first();
  await expect(summaryItem).toBeVisible();
  // Lower-cased on the page — the materiality and the state are spoken, not shouted. Same facts.
  await expect(summaryItem).toContainText("high");
  await expect(summaryItem).toContainText("open");

  // Resolve it (human disposition with evidence note).
  await page.locator('select[data-testid^="resolve-disposition-"]').first().selectOption("RESOLVED");
  await page.locator('input[data-testid^="resolve-note-"]').first().fill("Confirmed $4M with founder; $6M was aspirational.");
  await page.locator('button[data-testid^="resolve-submit-"]').first().click();
  await expect(page.getByTestId("no-material-contradictions")).toBeVisible();

  // The contradictions register shows the disposition.
  // Both live in the Admin tier, which is collapsed by default — administration is not
  // everyday work. Open it the way an operator has to.
  await page.getByTestId("nav-system-toggle").click();
  await page.getByRole("button", { name: "Contradictions", exact: true }).click();
  const resolved = page.locator('li[data-testid^="contradiction-"]', { hasText: "arr" }).first();
  await expect(resolved).toContainText("resolved");
  await expect(resolved).toContainText("fu_scooter_taylor");

  // The Activity spine shows the typed P5 events.
  await gotoSurface(page, "Activity");
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

/**
 * A badge can never shrink a company's name again.
 *
 * Operator, 15 Sep 2026: on the register, "Sensori" rendered one letter per line because its
 * sector tag ("Functional non-alcoholic beverage / CPG") shared the name's flex row and refused to
 * wrap. At ~1000px the grid is three cards wide — the width where it happened. The name must take
 * the full row and stay on one or two lines; the tag sits under it.
 */
test("a long sector tag sits under the company name and cannot squeeze it", async ({ page, request }) => {
  const marker = `E2E-P5-WIDE-${Date.now()}`;
  const created = await request.post("/api/companies", {
    headers: MP,
    data: { canonical_name: `${marker} Sensori`, sector: "Functional non-alcoholic beverage / CPG and adjacent categories" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await gotoSurface(page, "Companies");

  const card = page.getByTestId(`company-${id}`);
  await expect(card).toBeVisible();
  const name = card.locator(".company-card-head h4");
  const badge = card.locator(".company-card-head .badge");
  const cardBox = (await card.boundingBox())!;
  const nameBox = (await name.boundingBox())!;
  const badgeBox = (await badge.boundingBox())!;
  const nameLineHeight = await name.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  // The name owns most of the card's width and is at most two lines tall — never a column of letters.
  expect(nameBox.width).toBeGreaterThan(cardBox.width * 0.6);
  expect(nameBox.height).toBeLessThanOrEqual(nameLineHeight * 2 + 2);
  // The tag is below the name, not beside it.
  expect(badgeBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
});
