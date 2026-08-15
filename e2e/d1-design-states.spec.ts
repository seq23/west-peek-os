import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * D1–D5 design overhaul — surface-state coverage.
 *
 * These exist because the design pass's own verification ran entirely as a Managing Partner, and
 * that hid a real defect: read as an INVESTMENT_TEAM member with no governance updates issued, the
 * Governance surface rendered **zero characters** — no form, no list rows, no empty state. An
 * operator could not tell "you may not do this" from "this is broken".
 *
 * The rule these lock in is the design system's own (docs/WEST_PEEK_DESIGN_SYSTEM.md §7): an empty
 * slot is a stated fact, never a gap the reader has to interpret.
 */

const MEMBER_EMAIL = "d1-design-member@westpeek.ventures";

test.beforeAll(() => {
  // A second identity WITHOUT the Managing Partner role, in the same local D1 the dev server
  // serves — the same provisioning pattern p3-governed-work.spec.ts uses.
  execSync(
    `npx wrangler d1 execute WP_OS_DB --local --command "INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_d1_design_member', '${MEMBER_EMAIL}', 'D1 Design Member', 'ACTIVE'); INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_d1_design_member', 'role_investment_team');"`,
    { stdio: "pipe" },
  );
});

async function signInAs(page: import("@playwright/test").Page, email: string): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill(email);
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

test("no surface renders an ambiguous blank for a reader who holds no Managing Partner role", async ({ page }) => {
  await signInAs(page, MEMBER_EMAIL);

  // Governance is the surface that failed: its only control is MP-reserved, so a member sees the
  // list alone — and the list was empty and unexplained.
  await gotoSurface(page, "Governance");
  await expect(page.getByTestId("governance-page")).toBeVisible();
  await expect(page.getByTestId("governance-reserved")).toContainText("reserved for a Managing Partner");
  await expect(page.getByTestId("governance-empty")).toContainText("No governance updates have been issued");

  // The surface must carry real, readable text — not chrome with a void under it.
  const chars = await page.evaluate(() => (document.querySelector(".surface-body") as HTMLElement)?.innerText.trim().length ?? 0);
  expect(chars, "Governance rendered nothing under its header").toBeGreaterThan(80);

  // Reporting had the same shape: an empty period list with nothing to explain it.
  await gotoSurface(page, "Reporting");
  await expect(page.getByTestId("period-list-empty")).toContainText("No reporting periods open");
});

test("a decision the reader may not make says who may, instead of showing a dead button", async ({ page, request }) => {
  // Raise a real MP-reserved card so there is something to be refused.
  const card = await request.post("/api/approvals", {
    headers: { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" },
    data: {
      action_key: "governance.policy_change",
      object_type: "provider_registry",
      object_id: "anthropic",
      title: "Design-state probe: a card this reader may not decide",
      submit: true,
    },
  });
  expect(card.status()).toBe(201);
  const cardId = (await card.json()).id as string;

  await signInAs(page, MEMBER_EMAIL);
  await gotoSurface(page, "Approvals");

  const decide = page.getByTestId(`approve-${cardId}`);
  await expect(decide).toBeVisible();
  await expect(decide).toBeDisabled();
  await expect(page.getByTestId(`decision-blocked-${cardId}`)).toContainText("MANAGING_PARTNER");
  await expect(page.getByTestId(`decision-blocked-${cardId}`)).toContainText("INVESTMENT_TEAM");
});

test("the one orange action, the focus ring, and the hover state all clear WCAG AA", async ({ page }) => {
  await signInAs(page, "scooter@westpeek.ventures");
  await gotoSurface(page, "Approvals");

  /** WCAG 2.1 relative luminance, then the ratio — the same arithmetic the design audit used. */
  const contrast = (fg: number[], bg: number[]): number => {
    const lum = (c: number[]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0);
    };
    const a = lum(fg);
    const b = lum(bg);
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  };
  const parse = (v: string): number[] => (/rgba?\(([^)]+)\)/.exec(v)?.[1] ?? "0,0,0").split(",").map((n) => parseFloat(n));

  const primary = page.locator(".surface-body button.btn-primary").first();
  await expect(primary).toBeVisible();

  const resting = await primary.evaluate((n) => {
    const s = getComputedStyle(n);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(contrast(parse(resting.color), parse(resting.background)), "resting primary action").toBeGreaterThanOrEqual(4.5);

  // Hover is a real state with a real contrast obligation. It was 4.46:1 before this check existed.
  await primary.hover();
  await page.waitForTimeout(200);
  const hovered = await primary.evaluate((n) => {
    const s = getComputedStyle(n);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(contrast(parse(hovered.color), parse(hovered.background)), "hovered primary action").toBeGreaterThanOrEqual(4.5);

  // The focus ring is the brand orange, painted instantly, on the element the keyboard reaches.
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, transition: s.transitionProperty };
  });
  expect(ring).not.toBeNull();
  expect(ring!.style).toBe("solid");
  expect(ring!.color).toBe("rgb(240, 90, 26)");
  expect(ring!.transition, "a focus ring must never fade in").not.toContain("outline");
});
