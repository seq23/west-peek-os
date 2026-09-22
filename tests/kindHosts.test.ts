import { describe, expect, it } from "vitest";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
import { KIND_HOSTS, kindHost } from "../src/shared/work/kindHosts";
import { WEB_PROPERTY_CHANGE_KIND, LOCAL_JOB_KINDS } from "../src/shared/work/localJobs";

/**
 * Every registered kind has a real, employed owner — the same discipline `pageHosts.test.ts`
 * already holds pages to, applied to `work_card.kind` (Addendum 12, 22 Sep 2026).
 */
describe("every registered work-card kind has a real host", () => {
  it("names only employees who are really on the roster", () => {
    const names = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
    const unknown = Object.entries(KIND_HOSTS)
      .filter(([, h]) => !names.has(h.employee))
      .map(([kind, h]) => `${kind} → ${h.employee}`);
    expect(unknown).toEqual([]);
  });

  it("never hosts a kind with a retired employee", () => {
    const retired = new Set(AI_EMPLOYEE_ROSTER.filter((e) => e.status === "RETIRED").map((e) => e.name));
    expect(Object.entries(KIND_HOSTS).filter(([, h]) => retired.has(h.employee))).toEqual([]);
  });

  it("gives every host a reason in the operator's words, not a schema fragment", () => {
    for (const [kind, host] of Object.entries(KIND_HOSTS)) {
      expect(host.because.length, kind).toBeGreaterThan(20);
      expect(host.because, kind).not.toMatch(/_[a-z]|firm_scope|action_key/);
    }
  });

  it("registers WEB_PROPERTY_CHANGE to Porter — Addendum 12's own example", () => {
    expect(KIND_HOSTS[WEB_PROPERTY_CHANGE_KIND]?.employee).toBe("Porter");
  });

  it("registers no kind that the LOCAL_JOB registry does not also know", () => {
    // Not every local-job kind needs a host, but a host for a kind that isn't a real
    // `work_card.kind` value anywhere is a typo, not a feature.
    const localKinds = new Set(LOCAL_JOB_KINDS.map((k) => k.kind));
    const strayHosts = Object.keys(KIND_HOSTS).filter((k) => !localKinds.has(k) && k !== WEB_PROPERTY_CHANGE_KIND);
    expect(strayHosts).toEqual([]);
  });
});

describe("kindHost()", () => {
  it("resolves the registered owner against the live roster", () => {
    const host = kindHost(WEB_PROPERTY_CHANGE_KIND);
    expect(host?.name).toBe("Porter");
    expect(host?.role.length).toBeGreaterThan(0);
    expect(host?.because.length).toBeGreaterThan(0);
  });

  it("returns null for a kind with no registered owner", () => {
    expect(kindHost("ARTIFACT")).toBeNull();
    expect(kindHost("BLOG_HELP")).toBeNull();
  });

  it("returns null for null, undefined or an unknown kind", () => {
    expect(kindHost(null)).toBeNull();
    expect(kindHost(undefined)).toBeNull();
    expect(kindHost("NOT_A_REAL_KIND")).toBeNull();
  });
});
