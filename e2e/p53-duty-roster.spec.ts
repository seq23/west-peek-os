import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * The duty rota: a default the firm ships with, and a change a partner can make by hand.
 *
 * Operator: "a default flow and one that i can change in the admin section — i should be able to
 * adj hours for an employee."
 *
 * WHAT IS WORTH PROVING IN A BROWSER, as opposed to in a unit test:
 *
 *  1. The day renders as four shifts, and the one running now is marked. A rota you have to work
 *     out from a list of hours is not a rota.
 *  2. A change is visibly A CHANGE. An override that blended into the defaults would be
 *     unreviewable — the whole design stores differences rather than copies, and the page has to
 *     say which is which or that distinction only exists in the database.
 *  3. "Put back to default" is ONE press and returns the day to exactly the code default. Two
 *     surfaces are involved (the shift card and the list of what you changed) and both must do it.
 *  4. The revert is keyed by WHO / WHAT KIND / WHICH SHIFT — a natural key. If a `dov_…` row id
 *     ever reaches the screen, the page has started depending on storage identity for something the
 *     operator is supposed to be able to say out loud, so this spec fails on seeing one.
 *  5. **Employees and AI controls agree about who is on duty.** This is the failure the design was
 *     built to prevent and the one only a browser test catches: two surfaces reading the same rota
 *     through different endpoints (`/api/ai/duty` and `/api/ai/employees/on-duty`) and disagreeing.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

/**
 * The hour the BROWSER will ask about.
 *
 * Both surfaces send the viewer's own hour, deliberately — "a Worker runs in UTC and the partner
 * does not, and a rota that is silently three hours out is worse than no rota" (DutyRosterPanel).
 * The test process and the browser share a clock, so asking the API with this hour describes
 * exactly the shift the page will render as running.
 */
const LOCAL_HOUR = new Date().getHours();

interface DutyPicture {
  now: { shift: string; label: string; onDuty: Array<{ name: string }> };
  day: Array<{ shift: string; label: string; onDuty: Array<{ name: string }> }>;
  employees: string[];
  overrides: unknown[];
}

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("the rota shows the day, a change reads as a change, and one press puts it back", async ({ page, request }) => {
  const duty = (await (await request.get(`/api/ai/duty?hour=${LOCAL_HOUR}`, { headers: MP })).json()) as DutyPicture;

  // Somebody employed who is NOT already covering the shift that is running — so putting them on it
  // is a real difference from the default rather than a no-op that would prove nothing.
  const onNow = new Set(duty.now.onDuty.map((a) => a.name));
  const recruit = duty.employees.find((name) => !onNow.has(name));
  expect(recruit, "the roster must hold somebody who is not already on the current shift").toBeTruthy();

  await signIn(page);
  await gotoSurface(page, "AI controls");

  const panel = page.getByTestId("duty-roster-control");
  await expect(panel).toBeVisible();
  // Four shifts, and the day is drawn as a day rather than as a list of people.
  await expect(page.getByTestId("duty-day").locator("article")).toHaveCount(duty.day.length);
  await expect(page.getByTestId(`duty-shift-${duty.now.label}`)).toContainText("Running now");
  // Nothing has been changed yet, and the page says so rather than showing an empty list.
  await expect(page.getByTestId("duty-overrides-empty")).toContainText("the firm's default");

  // ── Change it ────────────────────────────────────────────────────────────────────────────────
  await page.getByTestId("duty-shift-who").selectOption(recruit!);
  await page.getByTestId("duty-shift-which").selectOption(duty.now.shift);
  await page.getByTestId("duty-shift-onoff").selectOption("on");
  await page.getByTestId("duty-shift-reason").fill("E2E: covering the morning while Walker is out");
  await page.getByTestId("duty-shift-save").click();
  await expect(page.getByTestId("duty-message")).toContainText(recruit!);

  // They are on the shift, and the entry says a person put them there — a reason and a name, not a
  // silent promotion into the defaults.
  const entry = page.getByTestId(`duty-entry-${duty.now.label}-${recruit}`);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("Changed by");
  await expect(page.getByTestId(`duty-shift-${duty.now.label}`)).toContainText("changed by hand");

  // And it is listed as a difference, with the reason that was given for it.
  await expect(page.getByTestId(`duty-override-${recruit}`)).toContainText("covering the morning");

  /*
   * NO ROW IDS ON SCREEN. The revert is a natural key — who, what kind of change, which shift — so
   * a `dov_…` appearing anywhere on this panel means the page has started identifying a change by
   * where it happens to be stored.
   */
  expect(await panel.innerText()).not.toMatch(/dov_/);

  // ── The other surface agrees ──────────────────────────────────────────────────────────────────
  /*
   * Employees reads the rota through a different endpoint. If these two ever disagree, the firm has
   * two answers to "who is working right now" and no way to tell which is true.
   */
  await gotoSurface(page, "Employees");
  await expect(page.getByTestId("on-duty-list")).toContainText(recruit!);

  // ── One press puts it back ────────────────────────────────────────────────────────────────────
  await gotoSurface(page, "AI controls");
  await page.getByTestId(`duty-override-revert-${recruit}`).click();
  await expect(page.getByTestId("duty-message")).toContainText("back on the firm's default");

  // Exactly the code default again: no differences left, and they are off the shift.
  await expect(page.getByTestId("duty-overrides-empty")).toBeVisible();
  await expect(page.getByTestId(`duty-entry-${duty.now.label}-${recruit}`)).toHaveCount(0);
  await expect(page.getByTestId(`duty-shift-${duty.now.label}`)).toContainText("the firm's default");

  // And Employees agrees again.
  await gotoSurface(page, "Employees");
  await expect(page.getByTestId("on-duty-list")).not.toContainText(recruit!);
});

test("the shift card itself offers the way back, not only the list of changes", async ({ page, request }) => {
  const duty = (await (await request.get(`/api/ai/duty?hour=${LOCAL_HOUR}`, { headers: MP })).json()) as DutyPicture;
  const onNow = new Set(duty.now.onDuty.map((a) => a.name));
  const recruit = duty.employees.find((name) => !onNow.has(name))!;

  await signIn(page);
  await gotoSurface(page, "AI controls");
  await page.getByTestId("duty-shift-who").selectOption(recruit);
  await page.getByTestId("duty-shift-which").selectOption(duty.now.shift);
  await page.getByTestId("duty-shift-onoff").selectOption("on");
  await page.getByTestId("duty-shift-reason").fill("E2E: reverting from the shift card itself");
  await page.getByTestId("duty-shift-save").click();

  /*
   * Reverting from where you are looking. Somebody who notices a change while reading the day
   * should not have to scroll to a second list to undo it — that is how a change nobody meant to
   * keep survives, and it is the reason this control is duplicated onto the entry.
   */
  await page.getByTestId(`duty-revert-${duty.now.label}-${recruit}`).click();
  await expect(page.getByTestId("duty-overrides-empty")).toBeVisible();
  await expect(page.getByTestId(`duty-entry-${duty.now.label}-${recruit}`)).toHaveCount(0);
});

/*
 * ── 4 · THE ROTA IS THE OPERATOR'S TO CHANGE ────────────────────────────────────────────────────
 *
 * Operator: "i want a default flow and one that i can change in the admin section — i should be
 * able to adj hours for an employee." The design decision being protected here is that the DATABASE
 * STORES ONLY DIFFERENCES from the code default. A table that copied the roster would drift from
 * the registry within a month, so an override is a row and reverting is deleting it.
 */
test("a partner gives one employee their own hours, and the default is left alone", async ({ page, request }) => {
  await signIn(page);
  await gotoSurface(page, "AI controls");

  const panel = page.getByTestId("duty-roster-control");
  await expect(panel).toBeVisible();
  // WHO IS ON RIGHT NOW, in a sentence — the rota exists to answer that and nothing else.
  await expect(page.getByTestId("duty-now-line")).toBeVisible();
  // And the WHOLE day, not just this moment: four shifts, with the current one marked. A rota a
  // partner cannot see ahead of is one she cannot disagree with, which is half its purpose.
  await expect(page.getByTestId("duty-day")).toBeVisible();
  await expect(page.getByTestId("duty-day").locator("article")).toHaveCount(4);
  // The rule is stated from the one place it is declared, rather than restated by the page.
  await expect(panel).toContainText("stored as a difference from that default");

  const form = page.getByTestId("duty-hours-form");
  const who = page.getByTestId("duty-hours-who");
  const name = (await who.locator("option").nth(1).getAttribute("value"))!;
  expect(name, "the roster must offer somebody to adjust").toBeTruthy();

  await who.selectOption(name);
  await page.getByTestId("duty-hours-from").selectOption("9");
  await page.getByTestId("duty-hours-to").selectOption("18");
  // A REASON IS PART OF THE CHANGE. A rota that changed for reasons nobody wrote down cannot be
  // reviewed later, which is the same rule that governs every other authority change here.
  await page.getByTestId("duty-hours-reason").fill("E2E: covering the London morning");
  await form.getByTestId("duty-hours-save").click();

  await expect(page.getByTestId("duty-message")).toContainText(name);

  // IT SHOWS AS A CHANGE YOU MADE, not as the way things have always been — the page can tell the
  // difference between the default and an override precisely because only differences are stored.
  const overrides = page.getByTestId("duty-overrides");
  await expect(overrides).toBeVisible();
  await expect(overrides).toContainText(name);
  await expect(overrides).toContainText("covering the London morning");

  const stored = (await (await request.get("/api/ai/duty", { headers: MP })).json()) as {
    overrides: Array<{ kind: string; employee_name: string; reason: string; set_by?: string }>;
  };
  const mine = stored.overrides.find((o) => o.employee_name === name && o.kind === "HOURS");
  expect(mine, "an override must be findable as a row of its own").toBeTruthy();
  expect(mine!.reason).toContain("London morning");
});
