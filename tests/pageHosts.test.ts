import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
import { MACHINE_REGISTRY } from "../src/shared/registry/machines";
import {
  HOSTED_NAV_GROUPS,
  OWN_CHIEF_OF_STAFF,
  PAGE_HOSTS,
  employeesHostingNothing,
  pageHost,
} from "../src/shared/help/pageHosts";

/**
 * Every surface has somebody responsible for it.
 *
 * Read against App.tsx's real nav, exactly as the page-purpose coverage test is, so a page added
 * without a host fails here rather than shipping as work nobody owns. An unowned page is worse than
 * an unexplained one: the operator's question is "is anyone actually on this?", and a surface with
 * no answer is how thirty employees came to have one run between them.
 */

const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const NAV_KEYS = [...APP.matchAll(/\{ key: "([a-z0-9-]+)", label: "/g)].map((m) => m[1]!);
const ROUTE_KEYS = [...APP.matchAll(/active === "([a-z0-9-]+)"/g)].map((m) => m[1]!);

/**
 * Nav keys by the group they sit in, read out of App.tsx's NAV_GROUPS.
 *
 * The rule under test is not "every page has a host" — it is the operator's: Deals, Firm and Learn
 * are rooms somebody runs, and Admin is machinery that reports on the system itself. A colleague's
 * face over a spend table implies a judgement nobody is making.
 */
function navKeysByGroup(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const chunks = APP.split(/group: "/).slice(1);
  for (const chunk of chunks) {
    const group = chunk.slice(0, chunk.indexOf('"'));
    // Stop at the end of this group's literal so items are not stolen from the next one.
    const body = chunk.split(/\n  \},/)[0]!;
    out.set(group, [...body.matchAll(/\{ key: "([a-z0-9-]+)", label: "/g)].map((m) => m[1]!));
  }
  return out;
}
const BY_GROUP = navKeysByGroup();
const HOSTED_KEYS = HOSTED_NAV_GROUPS.flatMap((g) => BY_GROUP.get(g) ?? []);
const UNHOSTED_KEYS = NAV_KEYS.filter((k) => !HOSTED_KEYS.includes(k));

describe("every surface has a host", () => {
  it("reads a real nav out of App.tsx", () => {
    // Guards the guard: a refactor of the nav literal would otherwise let this suite pass over an
    // empty list and report green while watching nothing.
    expect(NAV_KEYS.length).toBeGreaterThan(20);
    expect(NAV_KEYS).toContain("home");
  });

  it("reads real groups out of App.tsx, not an empty map", () => {
    // Guards the guard again: if the NAV_GROUPS literal is refactored, this whole rule would
    // otherwise pass over nothing and report green.
    for (const group of HOSTED_NAV_GROUPS) {
      expect(BY_GROUP.get(group)?.length, group).toBeGreaterThan(2);
    }
    expect(BY_GROUP.get("Admin")?.length).toBeGreaterThan(5);
  });

  it("assigns a host to every page in Deals, Firm and Learn", () => {
    expect(HOSTED_KEYS.filter((k) => !PAGE_HOSTS[k])).toEqual([]);
  });

  it("gives no host to Admin or to the personal surfaces", () => {
    // Admin is machinery, and Home, Today and Notifications are already signed by their deliverer.
    expect(UNHOSTED_KEYS.filter((k) => PAGE_HOSTS[k])).toEqual([]);
  });

  it("keeps no host for a page that no longer exists", () => {
    expect(Object.keys(PAGE_HOSTS).filter((k) => !ROUTE_KEYS.includes(k))).toEqual([]);
  });

  it("names only employees who are really on the roster", () => {
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    const unknown = Object.entries(PAGE_HOSTS)
      .filter(([, h]) => h.employee !== OWN_CHIEF_OF_STAFF && !names.has(h.employee))
      .map(([k, h]) => `${k} → ${h.employee}`);
    expect(unknown).toEqual([]);
  });

  it("never hosts a page with a retired employee", () => {
    // Rooms credited Wynn, who is RETIRED in production. A retired seat over a live page is the
    // same lie as an inactive one, and harder to notice.
    const retired = new Set(AI_EMPLOYEE_ROSTER.filter((e) => e.status === "RETIRED").map((e) => e.name));
    expect(Object.entries(PAGE_HOSTS).filter(([, h]) => retired.has(h.employee))).toEqual([]);
  });

  it("gives every host a reason in the operator's words, not the schema's", () => {
    for (const [key, host] of Object.entries(PAGE_HOSTS)) {
      expect(host.because.length, key).toBeGreaterThan(20);
      expect(host.because, key).toMatch(/\.$/);
      expect(host.because, key).not.toMatch(/_[a-z]|firm_scope|action_key/);
    }
  });
});

describe("a host resolves to a real person with real machines", () => {
  it("joins to the roster rather than copying it", () => {
    const host = pageHost("university")!;
    expect(host.name).toBe("Whitney");
    // Role and biography must come from the ROSTER — that is what "joins rather than copies" means,
    // and it is the thing worth guarding. Asserting a literal word out of `because` was guarding the
    // opposite: `because` is written in pageHosts.ts, so pinning a word in it only broke the suite
    // when somebody improved the sentence, which is what happened.
    const entry = AI_EMPLOYEE_ROSTER.find((e) => e.name === "Whitney")!;
    expect(host.role).toBe(entry.role);
    expect(host.bio).toBe(entry.bio);
    expect(host.because).toBe(PAGE_HOSTS.university!.because);
  });

  it("never names a machine its host does not actually sit on", () => {
    /*
     * The guard for a mismatch that had already shipped silently. Three pages hosted to somebody who
     * held no method for the page's own subject: Thesis to a seat without the mandate machine, Deal
     * Math to a seat without the deal-math machine, Documents to a seat without a document machine.
     * Nothing failed — the page chat simply prompted the host with the wrong disciplines, or with
     * none, and read as an employee who did not know their own job.
     */
    const wrong: string[] = [];
    for (const [key, assigned] of Object.entries(PAGE_HOSTS)) {
      if (!assigned.machineKeys) continue;
      const host = pageHost(key, "Sequoia Taylor");
      if (!host) continue;
      const entry = AI_EMPLOYEE_ROSTER.find((e) => e.name === host.name);
      const held = new Set(entry?.primaryMachineKeys ?? []);
      for (const m of assigned.machineKeys) {
        if (!held.has(m)) wrong.push(`${key}: ${host.name} does not sit on ${m}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("prompts a host with the page's own methods, not their entire remit", () => {
    // Asking Wyatt about a market used to arrive with his cap-table and opportunity-radar methods
    // attached — seventeen skills for a research question. An employee told to follow five unrelated
    // disciplines at once follows none of them well, so this is worse advice rather than fuller.
    const research = pageHost("research")!;
    const companies = pageHost("companies")!;
    expect(research.machineKeys).toEqual(["research_intelligence"]);
    expect(research.machineKeys.length).toBeLessThan(companies.machineKeys.length);
  });

  it("carries the machines that seat is responsible for, which is the link to the back end", () => {
    const host = pageHost("portfolio")!;
    expect(host.machineKeys.length).toBeGreaterThan(0);
    const known = new Set(MACHINE_REGISTRY.map((m) => m.key));
    for (const key of host.machineKeys) expect(known.has(key), key).toBe(true);
  });

  it("every assigned machine key exists in the machine registry", () => {
    const known = new Set(MACHINE_REGISTRY.map((m) => m.key));
    const bad: string[] = [];
    for (const key of Object.keys(PAGE_HOSTS)) {
      const host = pageHost(key, "Sequoia Taylor");
      for (const m of host?.machineKeys ?? []) if (!known.has(m)) bad.push(`${key} → ${m}`);
    }
    expect(bad).toEqual([]);
  });

  it("does not host the personal surfaces, which are already signed by their deliverer", () => {
    expect(pageHost("home", "Sequoia Taylor")).toBeNull();
    expect(pageHost("diagnostics")).toBeNull();
  });

  it("returns null for a page it does not know, instead of inventing an owner", () => {
    expect(pageHost("not-a-page")).toBeNull();
  });
});

describe("who hosts nothing", () => {
  it("reports unhosted seats as an input to the cull, without judging them", () => {
    const idle = employeesHostingNothing();
    // Recorded rather than asserted empty: not every employee needs a page, and the operator
    // decides what that means. This exists so the list is visible when they do.
    expect(Array.isArray(idle)).toBe(true);
    for (const name of idle) {
      expect(AI_EMPLOYEE_ROSTER.some((e) => e.name === name)).toBe(true);
    }
  });
});
