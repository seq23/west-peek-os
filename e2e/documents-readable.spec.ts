import { expect, test, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * Documents, formatted for the owner's consumption (23 Oct 2026), at a phone (390 px) and a laptop.
 *
 * She reads on both. The shelf must sit above the fold under a one-line "About this page ▾"; the
 * summary leads; groups are in plain words; a twice-filed weekly register shows once; a series
 * collapses to its latest with "Show N earlier ▾"; Markdown opens as a typeset document (headings,
 * a table, bold, a link that opens) with "·" intact; ✕ Close and ← Back return her to the same place
 * in the list; and archiving one document always asks first.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const MARK = `E2E-DOCS-${Date.now()}`;

const PLAYBOOK = [
  `# ${MARK} Club Playbook`,
  "",
  "The club meets **monthly** · six funded clubs – then a new angle. See [the site](https://example.com/club).",
  "",
  "## Tiers",
  "",
  "| Tier | Amount |",
  "|---|---|",
  "| Title | $25,000 |",
  "| Partner | $5,000 |",
  "",
  "- first",
  "- second",
  "",
  "<script>window.__pwned = true</script>",
].join("\n");

async function seed(page: Page): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const put = async (key: string, title: string, doc_type: string, body: string) => {
    const res = await page.request.post("/api/documents", { headers: MP, data: { title, doc_type, content_type: "text/markdown", content_base64: b64(body) } });
    expect(res.status(), await res.text()).toBe(201);
    ids[key] = ((await res.json()) as { id: string }).id;
  };
  await put("playbook", `${MARK} Club Playbook (version 2, 23 Oct 2026)`, "OTHER", PLAYBOOK);
  await put("register1", `${MARK} Fund — where our records and the deck disagree`, "REVIEW", "# Register\n\nOne item.");
  await put("register2", `${MARK} Fund — where our records and the deck disagree`, "REVIEW", "# Register\n\nOne item.");
  await put("prepOld", `${MARK}Partner — prep for the Wednesday sync, 2026-10-21`, "REVIEW", "# Prep\n\nOlder.");
  await put("prepNew", `${MARK}Partner — prep for the Wednesday sync, 2026-10-28`, "REVIEW", "# Prep\n\nNewer.");
  await put("web", `Change westpeek.ventures: "Hey! ${MARK} the agency took a look at the spam coming through the contact form and`, "BRIEF", "# Change\n\nDetails.");
  return ids;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");
  await gotoSurface(page, "Documents");
  await expect(page.getByTestId("documents-page")).toBeVisible();
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const { scroll, view } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(view);
}

test("phone (390 px): summary and shelf above the fold, plain groups, one register a week, series collapsed, a readable document, back to the same place", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ids = await seed(page);
  await signIn(page);

  // The intro is one line; its contents are kept behind it.
  const about = page.getByTestId("about-this-page");
  await expect(about.locator("summary")).toHaveText("About this page ▾");
  await expect(page.getByTestId("page-purpose-documents")).toBeHidden();
  await about.locator("summary").click();
  await expect(page.getByTestId("page-purpose-documents")).toBeVisible();
  await about.locator("summary").click();

  // Summary first, and the shelf starts above the fold.
  await expect(page.getByTestId("documents-this-week")).toHaveText(/^\d+ to read this week$/);
  const summaryTop = (await page.getByTestId("documents-summary").boundingBox())!.y;
  const shelfTop = (await page.getByTestId("document-list").boundingBox())!.y;
  expect(summaryTop).toBeLessThan(shelfTop);
  expect(shelfTop, "the shelf starts below the fold on a phone").toBeLessThan(844);
  await noSidewaysScroll(page);

  // Plain-word groups, never type codes.
  const list = page.getByTestId("document-list");
  await expect(page.getByTestId("docs-group-playbooks")).toContainText("Playbooks & plans");
  await expect(page.getByTestId("docs-group-reviews")).toContainText("Weekly reviews & sync prep");
  await expect(page.getByTestId("docs-group-website")).toContainText("Website changes");
  await expect(list.locator("h4", { hasText: /^Brief\b|^Review\b/ })).toHaveCount(0);

  // The register filed twice the same day shows once, and says both copies are kept.
  await expect(list.getByText(`${MARK} Fund — where our records and the deck disagree`, { exact: true })).toHaveCount(1);
  await expect(list).toContainText("filed 2 times that day, all kept");

  // A series collapses to its latest; the earlier one is one tap away.
  await expect(page.getByTestId(`document-${ids.prepNew}`)).toBeVisible();
  await expect(page.getByTestId(`document-${ids.prepOld}`)).toHaveCount(0);
  await page.getByTestId(`docs-earlier-${ids.prepNew}`).click();
  await expect(page.getByTestId(`document-${ids.prepOld}`)).toBeVisible();
  await expect(page.getByTestId(`docs-earlier-${ids.prepNew}`)).toHaveText(/Hide the 1 earlier/);

  // An email-snippet title reads as a plain one; the stored title is shown on open.
  await expect(page.getByTestId(`document-${ids.web}`)).toContainText("Website change on westpeek.ventures:");
  await expect(page.getByTestId(`document-${ids.web}`)).not.toContainText("Hey!");

  // Search and the filter pull-down narrow the shelf.
  await page.getByTestId("docs-search").fill(`${MARK} playbook`);
  await expect(page.getByTestId("docs-group-playbooks")).toBeVisible();
  await expect(page.getByTestId("docs-group-reviews")).toHaveCount(0);
  await page.getByTestId("docs-search").fill("");
  await page.getByTestId("docs-filter").selectOption("website");
  await expect(page.getByTestId("docs-group-website")).toBeVisible();
  await expect(page.getByTestId("docs-group-playbooks")).toHaveCount(0);
  await page.getByTestId("docs-filter").selectOption("all");

  // Open the playbook from the middle of the list; the list must not move underneath.
  const row = page.getByTestId(`document-${ids.playbook}`);
  await row.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await page.getByTestId(`view-${ids.playbook}`).click();
  const viewer = page.getByTestId("document-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId("document-viewer-close").first()).toHaveText("✕ Close");
  await expect(page.getByTestId("document-viewer-back").first()).toHaveText("← Back to the list");

  // Markdown, typeset: real headings, a table, bold, a link that opens; no raw markup; "·" intact.
  const md = viewer.getByTestId("document-markdown");
  await expect(md.locator("h4", { hasText: `${MARK} Club Playbook` })).toBeVisible();
  await expect(md.locator("h4", { hasText: "Tiers" })).toBeVisible();
  await expect(md.locator("table th")).toHaveText(["Tier", "Amount"]);
  await expect(md.locator("strong")).toHaveText("monthly");
  await expect(md.locator('a[href="https://example.com/club"]')).toHaveAttribute("target", "_blank");
  const text = await md.innerText();
  expect(text).toContain("· six funded clubs – then");
  expect(text).not.toContain("Â");
  expect(text).not.toMatch(/\*\*|\|---|^# /m);
  // A script in a document is shown as words and never runs.
  expect(text).toContain("<script>");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await noSidewaysScroll(page);

  // Archiving one document asks first.
  await page.getByTestId("doc-archive-ask").click();
  await expect(page.getByTestId(`doc-archive-${ids.playbook}`)).toBeDisabled();
  await page.getByText("No, keep it").click();

  // ✕ Close puts her back exactly where she was.
  await page.getByTestId("document-viewer-close").first().click();
  await expect(viewer).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(row).toBeInViewport();

  // ← Back does the same, and the stored title is on show inside.
  await page.getByTestId(`view-${ids.web}`).click();
  await expect(page.getByTestId("document-viewer-original")).toContainText(`Filed as: Change westpeek.ventures: "Hey! ${MARK}`);
  await page.getByTestId("document-viewer-back").first().click();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByTestId(`document-${ids.web}`)).toBeInViewport();
});

test("laptop: the document reads at a comfortable measure and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 860 });
  const ids = await seed(page);
  await signIn(page);
  await noSidewaysScroll(page);
  await page.getByTestId(`view-${ids.playbook}`).click();
  const md = page.getByTestId("document-viewer").getByTestId("document-markdown");
  await expect(md.locator("table")).toBeVisible();
  const { width, fontPx, family } = await md.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, fontPx: parseFloat(cs.fontSize), family: cs.fontFamily };
  });
  expect(fontPx).toBeGreaterThanOrEqual(16);
  // About 70 characters a line: no wider than ~75ch of this font, and not cramped either.
  expect(width / fontPx).toBeLessThanOrEqual(75 * 0.62);
  expect(width).toBeGreaterThan(400);
  expect(family.toLowerCase()).toMatch(/serif|charter|georgia/);
  await noSidewaysScroll(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("document-viewer")).toHaveCount(0);
});
