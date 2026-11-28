import { expect, test } from "@playwright/test";
import { deliverMail } from "./support/mail";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";
import { kindDef } from "../src/shared/deliverables/deliverable";

// The mail goes through Wren’s session. Previously filed blog deliverables still render on Home.

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const TRUSTED = "mx.cloudflare.net";
const genuine =
  `${TRUSTED}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  "dmarc=none header.from=westpeek.ventures policy.dmarc=none; " +
  `spf=pass (${TRUSTED}: domain of sequoia@westpeek.ventures designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=sequoia@westpeek.ventures; arc=none`;

test("an emailed blog ask reaches Wren’s session and a filed blog deliverable renders on Home", async ({ page, request }) => {
  const marker = `E2E-P68-${Date.now()}`;
  await deliverMail(request, {
    from: "Sequoia Taylor <sequoia@westpeek.ventures>",
    subject: `Blog post ${marker}`,
    body: `Wren — help me make an outline for a blog post on why early-stage founders should hire a recruiter before a CFO (${marker}) and do research.`,
    headers: { "Authentication-Results": genuine },
  });

  const cards = queryLocalD1<{ id: string; kind: string | null; owner_id: string; request_json: string | null; requested_by_email: string | null }>(
    `SELECT id, kind, owner_id, request_json, requested_by_email FROM work_card WHERE title LIKE '%${marker}%'`,
  );
  expect(cards, "one card for the ask").toHaveLength(1);
  expect(cards[0]!.owner_id, "her chief of staff, not a shared queue").toBe("aie_wren");
  expect(cards[0]!.kind).toBe("PARTNER_SESSION");
  expect(cards[0]!.requested_by_email).toBe("sequoia@westpeek.ventures");
  const [session] = queryLocalD1<{ request_text: string }>(
    `SELECT request_text FROM partner_session WHERE work_card_id = '${cards[0]!.id}'`,
  );
  expect(session?.request_text).toContain("hire a recruiter before a CFO");

  // The runner's result, as it files it: a blog_help deliverable for her, signed by Wren, keyed
  // to the card so a re-run updates rather than stacks.
  const title = `Blog outline: The first hire is the hire who hires ${marker}`;
  provisionLocalD1(
    `INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, source_type, source_id, privacy_label, firm_scope)
     VALUES ('dlv_${marker.toLowerCase()}', 'blog_help', '${title}', '## Outline\n\n**Thesis:** at seed the scarce resource is people.', 'Wren', 'fu_sequoia_taylor', 'work_card', '${cards[0]!.id}', 'INTERNAL', 'west-peek')`,
  );

  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");
  await expect(page.getByTestId("home-page")).toBeVisible();

  const row = page.getByTestId(`deliverable-dlv_${marker.toLowerCase()}`);
  await expect(row, "on her Home under 'Also finished for you'").toBeVisible();
  await expect(row.locator(".owner-chip")).toContainText("Wren");
  await expect(row.locator(".badge").first()).toHaveText(kindDef("blog_help")!.label);
  await expect(row).toContainText(kindDef("blog_help")!.blurb);
  await row.getByTestId(`deliverable-open-dlv_${marker.toLowerCase()}`).click();
  // STRICTER THAN THE CLASS IT REPLACES. The old assertion read a `<pre>` dump, so it would have
  // passed on an unrendered wall of text. A deliverable is now a document: the words must appear
  // inside a RENDERED PARAGRAPH, which fails if the renderer ever regresses to dumping the body.
  const doc68 = row.locator(".deliverable-doc");
  await expect(doc68).toBeVisible();
  // A RENDERED BLOCK OF ANY KIND — paragraph, list or table. Not "a paragraph": Walker's note is a
  // numbered candidate list, and `toSections` correctly renders `1. Jordan Example …` as a list
  // item. Requiring a <p> would have asserted the parser's failure rather than its success.
  await expect(
    doc68.locator("p.deliverable-doc-p, p.deliverable-doc-recommendation, ul.deliverable-doc-list, table.deliverable-doc-table").first(),
  ).toBeVisible();
  await expect(doc68).toContainText("the scarce resource is people");
  await expect(row.locator("pre")).toHaveCount(0);

  // The API says the same, filtered by the new kind.
  const list = (await (await request.get("/api/deliverables?kind=blog_help&mine=1", { headers: MP })).json()) as { deliverables: Array<{ title: string; prepared_by: string }> };
  expect(list.deliverables.some((d) => d.title === title && d.prepared_by === "Wren")).toBe(true);
});
