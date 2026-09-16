import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { tinyPdfBase64 } from "./support/mail";

/**
 * THE CURRENT DECK HAS A HOME, AND A NEW VERSION FINDS ITS WAY THERE.
 *
 * Operator, 15 Sep 2026: "where the fuck is the section for the current deck to stay?!", "why when
 * i upload the current deck does it go to fund strategy with a dff title name?!", "i archived v14
 * accidentally b/c nothing in documents had the title name v14", "v14 in fund strategy for me to
 * approve should have a nice preview", "i should be able to archive ALL documents as 1 function".
 * Walked here as she would walk it: upload on Documents → see it as v1 waiting → preview it on
 * Fund strategy → approve → it is the current deck on both pages → v2 arrives → cannot be archived
 * → archive-everything leaves the deck alone → an archived note can be restored.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

test("a deck uploaded on Documents becomes a numbered version, is previewed and approved on Fund strategy, and has one home on both pages", async ({ page, request }) => {
  // A fund with the figures a deck version snapshots.
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name: "West Peek Ventures Fund I" } })).json()) as { id: string };
  for (const [kind, policy] of [
    ["mandate", { target_size_usd: 30_000_000, sectors: ["AI"], target_positions: 25, check_size_usd: { min: 250_000, max: 1_000_000 }, management_fee_pct: 2, carried_interest_pct: 20 }],
    ["sleeve", { estimated_fees_usd: 6_000_000, estimated_expenses_usd: 600_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70 }, { key: "SECONDARY_PURCHASE", target_pct: 30 }] }],
    ["reserve", { reserve_pct: 40 }],
  ] as const) {
    expect((await request.post(`/api/funds/${fund.id}/policies/${kind}`, { headers: MP, data: { version_no: 1, effective_from: "2026-01-01", policy } })).status()).toBe(201);
  }

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");

  // 1 · Upload the deck on Documents as "The LP deck". The title fills from the file; the type is a list.
  await gotoSurface(page, "Documents");
  await page.getByTestId("doc-type").selectOption("DECK");
  await expect(page.getByTestId("doc-type-means")).toContainText("waits on your approval on Fund strategy");
  await page.getByTestId("doc-file").setInputFiles({ name: "Fund I — as it is in Canva.pdf", mimeType: "application/pdf", buffer: Buffer.from(tinyPdfBase64(), "base64") });
  await expect(page.getByTestId("doc-title")).toHaveValue("Fund I — as it is in Canva");
  await page.getByTestId("doc-submit").click();
  await expect(page.getByTestId("doc-message")).toContainText("Recorded as v1 of the deck");
  // It is on the shelf with everything else, under "The LP deck", says v1 and says it is waiting —
  // no special section (operator, 15 Sep 2026), but never lost among notes either.
  const deckShelf = page.getByTestId("document-list");
  await expect(page.getByTestId("documents-deck")).toHaveCount(0);
  await expect(deckShelf).toContainText("The LP deck");
  await expect(deckShelf).toContainText("v1");
  await expect(deckShelf).toContainText("Fund I — as it is in Canva");
  await expect(deckShelf.getByTestId(/^document-deck-state-/)).toContainText("waiting on your decision");
  await expect(deckShelf.getByRole("button", { name: /^View here$/ }).first()).toBeVisible();

  // 2 · On Fund strategy it waits, previews in place, and approving makes it the current deck.
  await deckShelf.getByRole("button", { name: "Decide on Fund strategy" }).click();
  await expect(page.getByTestId("fund-strategy-page")).toBeVisible();
  await expect(page.getByTestId("deck-proposed")).toContainText("Fund I — as it is in Canva");
  const proposedPreview = page.getByTestId("deck-proposed").getByRole("button", { name: /Preview v1 here/ });
  await proposedPreview.click();
  await expect(page.getByTestId("document-preview")).toBeVisible();
  await page.getByTestId(/^deck-approve-/).click();
  await expect(page.getByTestId("deck-current-badge")).toContainText("v1");
  await expect(page.getByTestId("deck-current")).toContainText("Fund I — as it is in Canva");
  await expect(page.getByTestId("deck-panel")).toContainText("The current deck — what the firm sends");
  // The current deck previews in place too (the preview she opened follows the document, so it is
  // already open under its new home).
  await expect(page.getByTestId("deck-open-preview")).toBeVisible();
  await expect(page.getByTestId("document-preview")).toBeVisible();

  // 3 · A second version arrives through the other door; both pages agree on what it is.
  await page.getByTestId("deck-upload").setInputFiles({ name: "Fund I — rebuilt.pdf", mimeType: "application/pdf", buffer: Buffer.from(tinyPdfBase64(), "base64") });
  await expect(page.getByTestId("deck-proposed")).toContainText("v2");
  await gotoSurface(page, "Documents");
  const docs = (await (await request.get("/api/documents", { headers: MP })).json()) as { documents: Array<{ id: string; deck: { version_no: number; state: string; title: string } | null }> };
  const v1 = docs.documents.find((d) => d.deck?.version_no === 1)!;
  const v2 = docs.documents.find((d) => d.deck?.version_no === 2)!;
  // Each row is named exactly as Fund strategy names the version, wears its state as a badge, and
  // the current one leads the one waiting.
  expect(v2.deck!.title).toBe("Fund I — rebuilt");
  await expect(page.getByTestId(`document-${v1.id}`)).toContainText("Fund I — as it is in Canva");
  await expect(page.getByTestId(`document-deck-state-${v1.id}`)).toHaveText("current");
  await expect(page.getByTestId(`document-${v2.id}`)).toContainText("Fund I — rebuilt");
  await expect(page.getByTestId(`document-deck-state-${v2.id}`)).toHaveText("waiting on your decision");
  const v1Top = (await page.getByTestId(`document-${v1.id}`).boundingBox())!.y;
  const v2Top = (await page.getByTestId(`document-${v2.id}`).boundingBox())!.y;
  expect(v1Top, "the current deck leads the shelf; the one waiting comes next").toBeLessThan(v2Top);
  // Neither the current deck nor the one waiting offers Archive — they are retired on Fund strategy.
  await expect(page.getByTestId(`document-${v1.id}`).getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(page.getByTestId(`document-${v2.id}`).getByRole("button", { name: "Archive" })).toHaveCount(0);
  const refused = await request.post(`/api/documents/${v2.id}/archive`, { headers: MP, data: { reason: "duplicate" } });
  expect(refused.status(), "v14 was archived by accident; a version waiting on a decision cannot be").toBe(409);

  // 4 · Everything else can go in one act; the deck stays; an archived note comes back.
  await page.getByTestId("doc-type").selectOption("DILIGENCE_NOTE");
  await page.getByTestId("doc-file").setInputFiles({ name: "Sensori call notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await page.getByTestId("doc-submit").click();
  await expect(page.getByTestId("doc-message")).toContainText("Uploaded doc_");
  await expect(page.getByTestId("document-list")).toContainText("Diligence note");
  page.once("dialog", (d) => d.accept("clearing the shelf"));
  await page.getByTestId("doc-archive-all").click();
  await expect(page.getByTestId("doc-message")).toContainText("Kept: v1 (the deck the firm sends), v2 (waiting on your decision)");
  await expect(page.getByTestId("document-list")).toContainText("v1");
  await page.getByTestId("documents-archived").locator("summary").click();
  await page.getByTestId(/^doc-restore-/).first().click();
  await expect(page.getByTestId("doc-message")).toContainText("Back on the shelf");
  await expect(page.getByTestId("document-list")).toContainText("Sensori call notes");
});
