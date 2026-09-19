import type { PageGuide } from "./types";
import { homeGuide } from "./home";
import { intentGuide } from "./intent";
import { captureGuide } from "./capture";
import { approvalsGuide } from "./approvals";
import { workGuide } from "./work";
import { notificationsGuide } from "./notifications";
import { thesisGuide } from "./thesis";
import { dealflowGuide } from "./dealflow";
import { companiesGuide } from "./companies";
import { meetingsGuide } from "./meetings";
import { secondariesGuide } from "./secondaries";
import { portfolioGuide } from "./portfolio";
import { fundStrategyGuide } from "./fundStrategy";
import { lpGuide } from "./lp";
import { roomsGuide } from "./rooms";
import { communityGuide } from "./community";
import { employeesGuide } from "./employees";
import { recordGuide } from "./record";
import { researchGuide } from "./research";
import { universityGuide } from "./university";
import { documentsGuide } from "./documents";

export type { GuideAct, GuideAuto, GuideBand, GuideLink, GuideStep, GuideWalkthrough, PageGuide } from "./types";

/**
 * Every page that has a guide, keyed by nav key.
 *
 * WHICH PAGES. Every room a person works in — Deals, Firm and Learn (the hosted pages), the three
 * Now surfaces, and the three pinned doors. Admin is machinery that reports on the system itself
 * and keeps its one-line purpose in `pagePurpose.ts`; `tests/pageGuide.test.ts` reads the nav out
 * of App.tsx and fails if a hosted page or a Now page is missing here.
 *
 * ONE SOURCE, THREE READERS. The purpose block at the top of each page (`pagePurpose.ts` derives
 * its entry from here), the host's answer to "how does this page work" (`pageChat.ts`), and the
 * page's section on the Help tab (`HelpCenterPage.tsx`) all read this registry. None of them may
 * carry its own copy.
 */
const ALL: readonly PageGuide[] = [
  homeGuide,
  intentGuide,
  captureGuide,
  approvalsGuide,
  workGuide,
  notificationsGuide,
  thesisGuide,
  dealflowGuide,
  companiesGuide,
  meetingsGuide,
  secondariesGuide,
  portfolioGuide,
  fundStrategyGuide,
  lpGuide,
  roomsGuide,
  communityGuide,
  employeesGuide,
  recordGuide,
  researchGuide,
  universityGuide,
  documentsGuide,
];

export const PAGE_GUIDES: Readonly<Record<string, PageGuide>> = Object.fromEntries(ALL.map((g) => [g.navKey, g]));

export function pageGuide(navKey: string): PageGuide | undefined {
  return PAGE_GUIDES[navKey];
}

/** Guides in nav order — the order the Help tab lists them. */
export function pageGuidesInOrder(navKeys: readonly string[]): PageGuide[] {
  const out: PageGuide[] = [];
  for (const k of navKeys) {
    const g = PAGE_GUIDES[k];
    if (g) out.push(g);
  }
  for (const g of ALL) if (!out.includes(g)) out.push(g);
  return out;
}
