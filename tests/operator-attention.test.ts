import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operatorAttention } from "../src/shared/setup/operatorAttention";

describe("Home's attention strip only reports what it can prove", () => {
  it("says nothing when there is nothing to say", () => {
    // An empty command surface is a correct outcome. Manufacturing an item to look useful is the
    // failure this asserts against.
    expect(operatorAttention({})).toEqual([]);
    expect(
      operatorAttention({ jobs: [], unactivatedRecommendations: [], aiProviderConfigured: true }),
    ).toEqual([]);
  });

  it("treats a dead-lettered job as blocking, because that work silently stopped", () => {
    const out = operatorAttention({
      jobs: [{ job_key: "j1", name: "Daily briefing", status: "ACTIVE", dead_letters: 2 }],
    });
    expect(out[0]!.severity).toBe("BLOCKING");
    expect(out[0]!.headline).toContain("dead-letter");
    expect(out[0]!.headline).toContain("will not retry");
    // Was "jobs" until Scheduled Work merged into Work, then "work-cards" — which is the API path
    // and has never been a route either. The assertion has now pinned a DEAD LINK twice running,
    // which is worse than no assertion: the router falls back to Home on an unknown key, so a link
    // that goes nowhere looks like a button that does nothing rather than like a failure. The route
    // list below is read out of App.tsx, so "work" cannot rot the same way.
    expect(out[0]!.link).toBe("work");
  });

  it("reports refusals and failures as degraded, not as silence", () => {
    const out = operatorAttention({
      jobs: [
        {
          job_key: "j2",
          name: "LP monitor",
          status: "ACTIVE",
          recent_runs: [{ status: "REFUSED" }],
        },
      ],
    });
    expect(out.map((i) => i.key)).toContain("jobs-refused");
    expect(out.find((i) => i.key === "jobs-refused")!.severity).toBe("DEGRADED");
  });

  it("calls out an employee who is active but cannot work", () => {
    const out = operatorAttention({
      blockedActiveEmployees: [{ name: "Wesley", reason: "every machine is paused" }],
    });
    expect(out[0]!.headline).toContain("active but cannot work");
    expect(out[0]!.link).toBe("employees");
  });

  it("orders by consequence: blocking before degraded before info", () => {
    const out = operatorAttention({
      jobs: [
        { job_key: "a", name: "A", status: "PAUSED", pause_reason: "operator" },
        { job_key: "b", name: "B", status: "ACTIVE", dead_letters: 1 },
        { job_key: "c", name: "C", status: "ACTIVE", recent_runs: [{ status: "FAILED" }] },
      ],
      unactivatedRecommendations: ["Wren"],
    });
    expect(out.map((i) => i.severity)).toEqual(["BLOCKING", "DEGRADED", "INFO", "INFO"]);
  });

  it("every item carries an action and a destination", () => {
    const out = operatorAttention({
      aiProviderConfigured: false,
      jobs: [{ job_key: "a", name: "A", status: "ACTIVE", dead_letters: 1 }],
      unactivatedRecommendations: ["Wren"],
      blockedActiveEmployees: [{ name: "Paige", reason: "machine paused" }],
    });
    expect(out.length).toBeGreaterThan(3);
    for (const i of out) {
      expect(i.action.length).toBeGreaterThan(10);
      expect(i.link.length).toBeGreaterThan(0);
      expect(i.headline.length).toBeGreaterThan(10);
    }
  });

  it("omits provider trouble when the caller does not know, rather than assuming failure", () => {
    // `undefined` means unknown. Only an explicit `false` is a finding.
    const out = operatorAttention({ aiProviderConfigured: undefined });
    expect(out.map((i) => i.key)).not.toContain("no-provider");
  });
});

/**
 * Every "Open" button goes somewhere.
 *
 * Three of these pointed at `jobs`, a route that stopped existing when Scheduled Work merged into
 * Work. The links were not updated, so the button rendered, looked live, and did nothing — the
 * worst kind of broken, because nothing reports it. Checked against App.tsx's actual route dispatch
 * rather than a list someone maintains by hand.
 */
describe("attention links point at real destinations", () => {
  const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const routes = new Set([...app.matchAll(/active === "([a-z0-9-]+)"/g)].map((m) => m[1]!));

  it("reads a real route list out of App.tsx", () => {
    // Guards the guard: a refactor that changed the dispatch shape would otherwise make this pass
    // over an empty set.
    expect(routes.size).toBeGreaterThan(20);
    expect(routes.has("work")).toBe(true);

    // Every destination a health check can name must be a real route too. Both dead links found
    // today — Home's "My open work" module and this label map — were API paths used as nav keys,
    // and neither failed: the router falls back to Home, so the button simply appeared inert.
    const destinations = [...app.matchAll(/const HEALTH_DESTINATION[^}]*}/gs)]
      .flatMap((m) => [...m[0].matchAll(/^\s*"?([a-z-]+)"?:/gm)].map((x) => x[1]!))
      .filter((k) => k !== "const");
    expect(destinations.length).toBeGreaterThan(3);
    expect(destinations.filter((d) => !routes.has(d))).toEqual([]);
  });

  it("has no attention item linking to a route that does not exist", () => {
    const src = readFileSync(new URL("../src/shared/setup/operatorAttention.ts", import.meta.url), "utf8");
    const links = [...src.matchAll(/link: "([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((l) => !routes.has(l))).toEqual([]);
  });
});
