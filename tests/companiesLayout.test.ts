import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The company card's head: the name takes the full row, the sector tag sits under it.
 *
 * Operator, 15 Sep 2026: a long sector tag ("Functional non-alcoholic beverage / CPG") sat on the
 * same flex row as the name, and the `.badge` rule is `white-space: nowrap`, so the badge kept its
 * width and "Sensori" was squeezed to one letter per line. A badge must never be able to shrink a
 * heading again — this reads the stylesheet the way `tests/roomsLayout.test.ts` does, so it fails
 * on the rule, not on a screenshot.
 */
const CSS = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/client/pages/CompaniesPage.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
  const m = CSS.match(new RegExp(`${selector.replace(/[.\s]/g, (c) => (c === "." ? "\\." : "\\s+"))}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
}

describe("company card head: name over sector, never side by side", () => {
  it("stacks the head as a column so nothing shares the name's row", () => {
    const head = rule(".company-card-head");
    expect(head).toMatch(/flex-direction:\s*column/);
    expect(head).not.toMatch(/justify-content:\s*space-between/);
  });

  it("lets the sector badge wrap instead of holding its width", () => {
    // The generic `.badge` is nowrap on purpose (status pills); the one under a company name is
    // the exception, because the name is the thing a reader came for.
    expect(rule(".badge")).toMatch(/white-space:\s*nowrap/);
    expect(rule(".company-card-head .badge")).toMatch(/white-space:\s*normal/);
  });

  it("keeps the name and the sector in the same head on every card", () => {
    const head = PAGE.slice(PAGE.indexOf('<header className="company-card-head">'), PAGE.indexOf("</header>"));
    expect(head).toContain("<h4>{c.canonical_name}</h4>");
    expect(head).toContain('<span className="badge">{c.sector}</span>');
  });
});
