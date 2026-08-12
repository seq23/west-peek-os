import { expect, test } from "@playwright/test";

/**
 * P9 browser journey against local `wrangler dev` (plan §12.3 "Network OS conflict
 * resolver"): declare the adapter contract → a LIVE pull fails closed because no
 * client is configured (the integration is UNPROVEN) → a LOCAL FIXTURE pull seeds an
 * observation → a second fixture pull with a different value opens a conflict and a
 * resolver work card → a human resolves it explicitly.
 *
 * The fixture path is local-only and is labelled LOCAL_FIXTURE everywhere, so
 * nothing here can be mistaken for live Network OS proof.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("P9 Network OS journey: contract → live pull fails closed → fixture conflict → human resolution", async ({ page, request }) => {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Network OS", exact: true }).click();
  await expect(page.getByTestId("integration-state")).toContainText("UNPROVEN");

  await page.getByTestId("contract-declare").click();
  await expect(page.getByTestId("network-message")).toContainText("Contract declared ok");
  await expect(page.getByTestId("contract-active")).toContainText("conflict_behavior");

  // A LIVE pull has no configured client: it must fail closed, not pretend.
  await page.getByTestId("pull-live").click();
  await expect(page.getByTestId("network-message")).toContainText("Live pull refused: adapter_unconfigured");

  // Fixture pull #1 establishes the observed value.
  await page.getByTestId("fixture-owner").fill("Scooter");
  await page.getByTestId("fixture-pull").click();
  await expect(page.getByTestId("network-message")).toContainText("Fixture pull ok (LOCAL_FIXTURE)");
  await expect(page.getByTestId("cursor-contact")).toContainText("OK");
  await expect(page.getByTestId("no-conflicts")).toBeVisible();

  // Fixture pull #2 diverges → conflict + resolver card, never an overwrite.
  await page.getByTestId("fixture-owner").fill("Sequoia");
  await page.getByTestId("fixture-pull").click();
  const conflict = page.locator('li[data-testid^="conflict-"]').first();
  await expect(conflict).toContainText("relationship_owner");
  await expect(conflict).toContainText("Sequoia");
  await expect(conflict).toContainText("Scooter");
  await expect(conflict).toContainText("resolver card wc_");

  // The resolver card is real governed work.
  const workCardId = /wc_[0-9a-f-]+/.exec((await conflict.textContent()) ?? "")?.[0];
  expect(workCardId).toBeTruthy();
  const card = await request.get(`/api/work-cards/${workCardId}`, { headers: MP });
  expect(card.status()).toBe(200);
  expect((await card.json()).title).toContain("Network OS conflict");

  // A human resolves it explicitly; Network OS stays authoritative for the field.
  await conflict.locator('button[data-testid^="conflict-keep-external-"]').click();
  await expect(page.getByTestId("network-message")).toContainText("Conflict resolved ok");
  await expect(page.getByTestId("no-conflicts")).toBeVisible();

  const mappings = (await (await request.get("/api/network/mappings?resource=contact", { headers: MP })).json()) as {
    mappings: Array<{ external_id: string; snapshot_json: string }>;
  };
  const mapping = mappings.mappings.find((m) => m.external_id === "fixture_contact_1")!;
  expect(JSON.parse(mapping.snapshot_json).relationship_owner).toBe("Sequoia");
});
