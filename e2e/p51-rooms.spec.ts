import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

/**
 * Rooms and Introductions (P51, docs/COMMUNITY.md).
 *
 * The assertions worth having here are about honesty rather than function: that an empty
 * Introductions page says a quiet month is normal, and that a sponsor cannot get an attendee list
 * even by asking the API directly. Both are places where the code could work perfectly and still
 * betray the community model.
 */

test("Events & Rooms explains itself and offers a proposal", async ({ page }) => {
  await signIn(page);
  // The nav label became "Events & Rooms" when the two tabs merged, and gotoSurface matches the
  // visible label exactly — so this spec had been navigating to a button that no longer existed.
  await gotoSurface(page, "Events & Rooms");
  await expect(page.getByTestId("how-this-works-rooms")).toBeVisible();
  await expect(page.getByTestId("propose-room")).toBeVisible();
  // Sponsors live on the same page: a Room and its funding are one decision.
  await expect(page.getByTestId("add-sponsor")).toBeVisible();
  // The record of what happened is the same page too, not a tab away.
  await expect(page.getByText("Every gathering on the record")).toBeVisible();
  /*
   * Operator: "declined proposals should go somewhere after they are declined. somewhere below
   * greyed out." The shelf is a section that renders even when it is empty — a shelf that appears
   * only once something is on it is a shelf nobody learns exists.
   */
  await expect(page.getByTestId("declined-proposals")).toBeVisible();
});

test("an empty Introductions page says that quiet is the normal state", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Introductions");
  // Without this the next person to read the page lowers the matching threshold to make it
  // "work", which is exactly how the feature turns into noise.
  await expect(page.getByTestId("no-matches")).toContainText("normal state");
  await expect(page.getByTestId("add-signal")).toBeVisible();
});

test("you can note what someone is looking for", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Introductions");
  const person = page.getByTestId("signal-person");
  await expect(person).toBeVisible();
  // A note carries a visible expiry; "looking for a job" is true for a season, not forever.
  await expect(page.getByText(/Notes expire after about four months/)).toBeVisible();
});

test("a sponsor cannot be handed the attendee list, even by asking the API", async ({ page }) => {
  await signIn(page);
  // Called from inside the page so it carries the same identity the app does — page.request is a
  // separate context and would only prove that unauthenticated callers get 401.
  const out = await page.evaluate(async () => {
    const res = await fetch("/api/events/evt_missing/attendee-export", {
      headers: { accept: "application/json", "x-wpos-dev-user": localStorage.getItem("wpos.devUser") ?? "" },
    });
    return { status: res.status, body: (await res.json()) as { detail: string } };
  });

  expect(out.status).toBe(403);
  // The refusal has to name the legitimate alternative, or someone works around it.
  expect(out.body.detail).toMatch(/aggregate counts/);
  expect(out.body.detail).toMatch(/never shared/);
});

test("a deal captures where the relationship started, at the moment it is created", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Investment");

  // Capture has to live in the create form. "Where did we meet them" is recoverable from memory
  // for about a week; make it a separate errand and it stays UNRECORDED forever.
  await expect(page.getByTestId("opportunity-origin")).toBeVisible();
  await expect(page.getByTestId("opportunity-known-since")).toBeVisible();
  // The default must be honest rather than a guess.
  await expect(page.getByTestId("opportunity-origin")).toHaveValue("UNRECORDED");
});

test("the provenance panel measures lead time, not engagement", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Investment");
  const panel = page.getByTestId("deal-provenance");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("how early it puts us in the room");
  // The community model rules engagement metrics out by name; this page must not grow them.
  await expect(panel).not.toContainText("engagement rate");
});
