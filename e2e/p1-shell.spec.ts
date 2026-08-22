import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { gotoSurface, openSystemAreaIfCollapsed } from "./support/nav";

/** Latest migration filename (without .sql) — derived so the pin cannot rot. */
function latestMigrationName(): string {
  const dir = fileURLToPath(new URL("../migrations", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return files[files.length - 1]!.replace(/\.sql$/, "");
}

/**
 * P1 browser/API journeys against local `wrangler dev`:
 * auth denial, dev-identity auth, open health endpoint, and the UI shell.
 * (P3 note: the shell now requires sign-in before rendering work surfaces;
 * the local-mode dev login provides the dev identity header.)
 */

test("unauthenticated /api/me is denied (401)", async ({ request }) => {
  const res = await request.get("/api/me");
  expect(res.status()).toBe(401);
});

test("dev identity header resolves Scooter Taylor (200)", async ({ request }) => {
  const res = await request.get("/api/me", {
    headers: { "x-wpos-dev-user": "scooter@westpeek.ventures" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.email).toBe("scooter@westpeek.ventures");
  expect(body.fullName).toBe("Scooter Taylor");
  expect(body.roles).toContain("MANAGING_PARTNER");
});

test("unknown identity is denied (401)", async ({ request }) => {
  const res = await request.get("/api/me", {
    headers: { "x-wpos-dev-user": "intruder@example.com" },
  });
  expect(res.status()).toBe(401);
});

test("/api/health answers unauthenticated with schema version and bindings", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.env).toBe("local");
  expect(body.d1.reachable).toBe(true);
  expect(body.d1.schemaVersion).toBe(latestMigrationName());
  expect(body.bindings.WP_OS_DB).toBe(true);
});

test("UI shell loads at / with nav, dev login, and the diagnostics health panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "West Peek OS" })).toBeVisible();
  // Two tiers since P26. Everyday work is on show without asking for it...
  //
  // "Today" and "Work cards" were here until the nav merge: Today folded into Home and the card
  // queue is now "Work", both resolved for old links by `MERGED_ROUTES` in App.tsx. The labels are
  // read from the live nav rather than retyped from memory — this loop had been asserting two
  // buttons that had not existed for days, and it is the first thing a reader of this suite sees.
  for (const label of ["Home", "Capture", "Work", "Approvals", "Help"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  // ...and administration is one disclosure away, not gone. Asserting both halves is the point:
  // the reorganisation is only correct if the advanced surfaces are still reachable.
  for (const label of ["Activity", "Governance", "Diagnostics"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeHidden();
  }
  await openSystemAreaIfCollapsed(page);
  for (const label of ["Activity", "Governance", "Diagnostics"]) {
    await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  }

  // Local mode: sign in with the dev identity header via the login form.
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  /*
   * Diagnostics reads the live system, and the applied schema version is one of the readings.
   *
   * It used to be a single `health-panel`; the surface is now a grid of one card per check, and the
   * database card carries the schema. Asserting the CARD rather than the old container keeps the
   * property this test exists for — the page states a measured fact rather than a configured one —
   * without pinning the layout that happens to carry it today.
   */
  await gotoSurface(page, "Diagnostics");
  await expect(page.getByTestId("health-database")).toContainText(latestMigrationName());
});
