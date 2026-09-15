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

/**
 * The request door (15 Sep 2026), and the chain behind it.
 *
 * Operator: "i need to be able to do that OR ask for a specific type of room." No model runs in
 * this suite, so the build cannot finish — which is exactly the state worth proving: her brief is on
 * the record the moment she asks, Parker's card is open and the card says which stage he is on
 * rather than a 502, and dismissing it puts the substance (who was to be invited, why we said no)
 * on the shelf and takes the card off his desk.
 */
test("asking Parker for a Room records the brief and opens his card before anything else, and the shelf keeps the substance", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Events & Rooms");
  await page.getByTestId("room-audience").fill("top Black lawyers on the rise");
  await page.getByTestId("room-month").fill("2026-10");
  await page.getByTestId("room-sponsors").fill("Harvey AI (harvey.ai)");
  await page.getByTestId("room-notes").fill("one legal sponsor at most");
  await page.getByTestId("request-room-submit").click();

  // The route queues and returns; the chain runs in the sweep. The page says so, and says the stage.
  await expect(page.getByTestId("rooms-message")).toContainText(/On Parker's desk/, { timeout: 30_000 });
  const card = page.locator('[data-testid^="packet-rpk_"]').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Room requested: top Black lawyers on the rise");
  await expect(card.getByTestId("packet-brief")).toContainText("Harvey AI (harvey.ai)");
  await expect(card.getByTestId("packet-brief")).toContainText("one legal sponsor at most");
  await expect(card.locator('[data-testid^="build-stage-"]')).toContainText(/Stage 1 of 6/);
  await expect(card.locator('[data-testid^="build-stage-"]')).toContainText("on Parker's desk");

  // The card is on Parker's desk, of the kind the sweep knows how to run.
  const cardRow = await page.evaluate(async () => {
    const res = await fetch("/api/rooms/packets", { headers: { accept: "application/json", "x-wpos-dev-user": localStorage.getItem("wpos.devUser") ?? "" } });
    const body = (await res.json()) as { packets: Array<{ work_card_id: string | null; build_stage: string; status: string }> };
    return body.packets[0]!;
  });
  expect(cardRow.status).toBe("DRAFT");
  expect(cardRow.build_stage).toBe("QUEUED");
  expect(cardRow.work_card_id).toBeTruthy();

  // Dismiss it with a reason; the shelf shows who was to be invited and why we said no.
  page.once("dialog", (d) => d.accept("wrong month for this crowd"));
  await card.locator('[data-testid^="decline-"]').click();
  const shelf = page.getByTestId("declined-proposals");
  await expect(shelf).toContainText("Room requested: top Black lawyers on the rise");
  await expect(shelf).toContainText("asked for by a partner");
  await expect(shelf).toContainText("Who was to be invited");
  await expect(shelf).toContainText("top Black lawyers on the rise");
  await expect(shelf).toContainText("wrong month for this crowd");
  await expect(shelf.locator('[data-testid^="again-"]').first()).toBeVisible();

  // "Propose again with changes" prefills the form from the declined Room.
  await shelf.locator('[data-testid^="again-"]').first().click();
  await expect(page.getByTestId("room-audience")).toHaveValue("top Black lawyers on the rise");
  await expect(page.getByTestId("room-notes")).toHaveValue(/Reworking/);
  await expect(page.getByTestId("request-room")).toContainText("again, with changes");
});

/*
 * Introductions is no longer its own destination.
 *
 * It sat in "Now" beside Approvals and Notifications — a group where something is always waiting —
 * while being a surface that is deliberately empty most months, so its presence read as a system
 * that had stopped working (App.tsx). It renders inside Community now. The route still resolves;
 * the nav button does not exist, which is why every spec that clicked it timed out rather than
 * failing on an assertion.
 */
const INTRODUCTIONS_LIVES_ON = "Community";

test("an empty Introductions page distinguishes 'nothing set up' from 'a quiet month'", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, INTRODUCTIONS_LIVES_ON);

  /*
   * This asserted "normal state" on any empty page. The page now tells three emptinesses apart, and
   * the reason is written into `IntroductionsPage.tsx`: "Nothing to suggest, that is the normal
   * state" is TRUE once there are people and notes to match on, and actively misleading before
   * that — "a page that says 'working as intended' to somebody staring at an unconfigured system
   * teaches them to distrust it."
   *
   * So the assertion follows the refinement rather than resisting it. On a firm with no community
   * members the slot must say THAT, and the reason it exists at all — the operator must never be
   * left to interpret a blank, because the next reader lowers the matching threshold to make the
   * page "work", which is exactly how the feature turns into noise.
   */
  const empty = page.getByTestId("no-matches");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("No people to match yet");
  await expect(empty).not.toContainText("normal state");
  await expect(page.getByTestId("add-signal")).toBeVisible();
});

test("you can note what someone is looking for", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, INTRODUCTIONS_LIVES_ON);
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

/*
 * There is no "Investment" destination any more.
 *
 * The pipeline and the deal record are ONE component on Dealflow (App.tsx: "picking a company on
 * the pipeline did not open its record — it scrolled you to a dropdown where you picked the same
 * company again"). `InvestmentPage` is still in App.tsx but nothing routes to it, so these two
 * tests had been clicking a button that no longer exists.
 */
test("a deal captures where the relationship started, at the moment it is created", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Dealflow");

  // Capture has to live in the create form. "Where did we meet them" is recoverable from memory
  // for about a week; make it a separate errand and it stays UNRECORDED forever.
  await page.getByTestId("dealflow-add-toggle").click();
  await expect(page.getByTestId("dealflow-add-form")).toBeVisible();
  await expect(page.getByTestId("dealflow-origin")).toBeVisible();
  // The default must be honest rather than a guess.
  await expect(page.getByTestId("dealflow-origin")).toHaveValue("UNRECORDED");
});

/*
 * REGRESSION, NOT A STALE ASSERTION — so it is written as the behaviour that should hold and marked
 * expected-to-fail rather than deleted.
 *
 * The old create form asked TWO provenance questions at the moment a deal was opened: how we met
 * them, and how long we had known them. The Dealflow form kept the first and dropped the second;
 * "known since" now only appears once you open the deal's terms (`deal-terms-known-since`) or add a
 * SECOND deal to a company (`deal-second-known-since`) — i.e. it became the separate errand this
 * test exists to prevent. `DealProvenance` measures lead time from exactly that field, so every
 * deal opened through the ordinary door contributes nothing to the panel below it.
 *
 * FIXED 22 Aug 2026 and the marker removed: the create form asks again, beside "how we met them",
 * because they are one thought — who introduced us, and how long ago. Blank by default and sent only
 * when given, since a defaulted date would claim every company was met on the day it was filed.
 */
test("a deal also captures HOW LONG we have known them, at the moment it is created", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await expect(page.getByTestId("dealflow-known-since")).toBeVisible();
});

test("the provenance panel measures lead time, not engagement", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Dealflow");
  const panel = page.getByTestId("deal-provenance");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("how early it puts us in the room");
  // The community model rules engagement metrics out by name; this page must not grow them.
  await expect(panel).not.toContainText("engagement rate");
});
