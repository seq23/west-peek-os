/**
 * THE HEADER TITLE OF A PAGE THAT IS NOT IN THE NAV (23 Oct 2026). `#/outside-email` rendered under the
 * header "Home": the shell took its title from the nav, and a page reachable only by address fell back
 * to the nav's first item. Every key App.tsx routes outside the nav names its own title here, and which
 * nav page it sits under (for the small group line above the title). `tests/pageTitles.test.ts` reads
 * App.tsx's routable keys and fails on any key that would show another page's title.
 */
export const OFF_NAV_TITLES: Readonly<Record<string, { label: string; under: string }>> = {
  "outside-email": { label: "Outside email", under: "setup" },
  private: { label: "Private layer", under: "home" },
  "work-kind-rules": { label: "Standing rules", under: "work" },
  jobs: { label: "Jobs", under: "machines" },
  "browser-tasks": { label: "Browser tasks", under: "machines" },
  "market-map": { label: "Market mapping", under: "research" },
  introductions: { label: "Introductions", under: "community" },
  allocation: { label: "Fund strategy", under: "fund-strategy" },
  "follow-on": { label: "Fund strategy", under: "fund-strategy" },
};
