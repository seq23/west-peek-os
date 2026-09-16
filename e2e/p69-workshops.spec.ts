import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { queryLocalD1 } from "./support/provision";
import { WORKSHOP_SERIES, WORKSHOP_WHERE } from "../src/shared/events/workshopPacket";

/**
 * P69 — Workshops on the Rooms page (16 Sep 2026).
 *
 * Operator: "monthly workshops in addition to Rooms … the same workflow as Rooms". The page has a
 * Workshops collection with its own empty state; the Ask-Parker form has a Room/Workshop switch;
 * switching to Workshop hides the city (virtual only) and, for a month the partners have set,
 * locks the topic to their title. Submitting lands a WORKSHOP draft under Workshops — a card on
 * Parker's desk, the same as a Room — and the shelf names its kind when it is dismissed.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");
}

test("the Workshops collection, the request switch, and a set month's locked title", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Events & Rooms");

  await expect(page.getByTestId("workshops-heading")).toHaveText("Workshops");
  await expect(page.getByTestId("workshops-empty")).toBeVisible();
  await expect(page.getByTestId("workshops-approved-empty")).toBeVisible();

  // The switch. A Room shows a city; a Workshop is virtual and does not.
  await expect(page.getByTestId("room-city")).toBeVisible();
  await page.getByTestId("request-kind-workshop").check();
  await expect(page.getByTestId("room-city")).toHaveCount(0);
  await expect(page.getByTestId("request-room")).toContainText(WORKSHOP_WHERE);

  // September is set: the topic is the partners' title, read-only, and the page says so.
  await page.getByTestId("room-month").fill("2026-09");
  const topic = page.getByTestId("room-audience");
  await expect(topic).toHaveValue(WORKSHOP_SERIES["2026-09"]!);
  await expect(topic).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("request-set-title")).toContainText("set by the partners");

  await page.getByTestId("request-room-submit").click();
  await expect(page.getByTestId("rooms-message")).toContainText("On Parker's desk");

  // Under Workshops, not under Rooms: a DRAFT with the set title, at the Workshop's first stage.
  const waiting = page.getByTestId("workshops-waiting");
  await expect(waiting).toContainText(`Workshop: ${WORKSHOP_SERIES["2026-09"]}`);
  await expect(page.getByTestId("rooms-waiting")).not.toContainText(WORKSHOP_SERIES["2026-09"]!);
  const rows = queryLocalD1<{ id: string; kind: string; title: string; work_card_id: string | null; status: string }>(
    `SELECT id, kind, title, work_card_id, status FROM evt_room_packet WHERE proposed_for_month = '2026-09' AND kind = 'WORKSHOP'`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("DRAFT");
  expect(rows[0]!.work_card_id, "a card on Parker's desk, like a Room").toBeTruthy();
  // QUEUED until the sweep's first tick: the card says so, and that it is Parker's to pick up.
  await expect(page.getByTestId(`build-stage-${rows[0]!.id}`)).toContainText("waiting for Parker to pick it up");
  await expect(page.getByTestId(`packet-${rows[0]!.id}`)).toContainText("Parker is building this Workshop");

  // An open month is the partner's own words, editable.
  await page.getByTestId("room-month").fill("2026-10");
  await expect(page.getByTestId("request-set-title")).toHaveCount(0);
  await expect(page.getByTestId("room-audience")).not.toHaveAttribute("readonly", "");

  // Dismissed like a Room; the shelf says it was a Workshop.
  page.once("dialog", (d) => d.accept("she will trigger September herself"));
  await page.getByTestId(`decline-${rows[0]!.id}`).click();
  await expect(page.getByTestId("workshops-empty")).toBeVisible();
  const shelf = page.getByTestId("declined-proposals");
  await shelf.locator("summary").click();
  await expect(page.getByTestId(`declined-${rows[0]!.id}`)).toContainText("Workshop proposed for September 2026");
});
