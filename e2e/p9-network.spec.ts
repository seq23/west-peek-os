import { expect, test } from "@playwright/test";

/**
 * P9 browser journey against local `wrangler dev` (plan §12.3 "Network OS conflict
 * resolver"): declare the adapter contract → a LIVE pull fails closed because no
 * client is configured (the integration is UNPROVEN) → a LOCAL FIXTURE pull seeds an
 * observation → Capture links a local person to that contact → a second fixture pull with a
 * different company opens a conflict and a resolver work card → a human resolves it explicitly.
 *
 * WHY CAPTURE IS IN THE MIDDLE (5 Oct 2026). Since #206 a conflict is a disagreement with a person
 * West Peek OS has LINKED, on a field the two share (networkAdapter.ts LINKED_FIELDS). This journey
 * used to diverge `relationship_owner` on an unlinked contact — Network OS editing its own record,
 * which is now observed and never disputed — so it could not reach a conflict at all (run
 * 36850533285). The link is made the way the product makes one: a capture resolved to a person whose
 * email matches the synced contact.
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

  // Both live in the Admin tier, which is collapsed by default — administration is not
  // everyday work. Open it the way an operator has to.
  await page.getByTestId("nav-system-toggle").click();
  await page.getByRole("button", { name: "Network OS", exact: true }).click();
  await expect(page.getByTestId("integration-state")).toContainText("UNPROVEN");

  await page.getByTestId("contract-declare").click();
  await expect(page.getByTestId("network-message")).toContainText("Contract declared ok");
  await expect(page.getByTestId("contract-active")).toContainText("conflict_behavior");

  // A LIVE pull has no configured client: it must fail closed, not pretend.
  await page.getByTestId("pull-live").click();
  await expect(page.getByTestId("network-message")).toContainText("Live pull refused: adapter_unconfigured");

  // Fixture pull #1 establishes the observed value.
  await page.getByTestId("fixture-company").fill("Northwind");
  await page.getByTestId("fixture-pull").click();
  await expect(page.getByTestId("network-message")).toContainText("Fixture pull ok (LOCAL_FIXTURE)");
  /*
   * A FIXTURE PULL DOES NOT MAKE THE SYNC LOOK HEALTHY, and the assertion is inverted deliberately.
   *
   * This line used to expect OK here — the fixture moved the cursor, so a run against local test
   * data made the surface say the firm was in sync with Network OS. `networkAdapter.ts` now guards
   * the cursor write behind `if (!opts.isFixture)`: "a fixture that transformed its own records
   * correctly has proven nothing about Network OS." So the cursor still carries the refusal from
   * the live pull above, which is the truth. Asserting OK would be asserting the lie back.
   */
  await expect(page.getByTestId("cursor-contact")).toContainText("DEGRADED_READ_ONLY");
  await expect(page.getByTestId("cursor-contact")).toContainText("adapter_unconfigured");
  await expect(page.getByTestId("no-conflicts")).toBeVisible();

  // A capture resolved to the person behind that contact links them: West Peek OS now holds an
  // opinion (the person's own organization, mirrored from the contact) that a later pull can dispute.
  const captured = await request.post("/api/captures", {
    headers: MP,
    data: { capture_type: "note", raw_text: `met the founder at founder@example.com ${Date.now()}`, source_channel: "web" },
  });
  expect(captured.status(), await captured.text()).toBe(201);
  const captureId = ((await captured.json()) as { id: string }).id;
  const resolved = await request.post(`/api/captures/${captureId}/resolve`, {
    headers: MP,
    data: { kind: "PERSON", name: "Fixture Founder", email: "founder@example.com" },
  });
  expect(resolved.status(), await resolved.text()).toBe(200);
  const linked = (await resolved.json()) as { person_id: string | null; person_source: string | null; matched_via: string };
  expect(linked.person_source, linked.matched_via).toBe("NETWORK_OS");
  expect(linked.matched_via).toContain("linked by email");
  expect(linked.person_id).toBeTruthy();

  // Fixture pull #2 diverges on the linked field → conflict + resolver card, never an overwrite.
  await page.getByTestId("fixture-company").fill("Southwind");
  await page.getByTestId("fixture-pull").click();
  const conflict = page.locator('li[data-testid^="conflict-"]').first();
  await expect(conflict).toContainText("company");
  await expect(conflict).toContainText("Southwind");
  await expect(conflict).toContainText("Northwind");
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
    mappings: Array<{ external_id: string; snapshot_json: string; internal_type: string | null; internal_id: string | null }>;
  };
  const mapping = mappings.mappings.find((m) => m.external_id === "fixture_contact_1")!;
  expect(JSON.parse(mapping.snapshot_json).company).toBe("Southwind");
  // Still linked to the person Capture tied it to: the resolution moved the field, not the link.
  expect(mapping.internal_type).toBe("person");
  expect(mapping.internal_id).toBe(linked.person_id);
});
