import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEAT_ATTACHMENT_EXPIRE_DAYS, SEAT_ATTACHMENT_PREFIX } from "../src/worker/ai/seatAttachments";
// @ts-expect-error a plain .mjs deploy helper, no types
import { applySeatLifecycle, SEAT_LIFECYCLE, withSeatRule } from "../scripts/deploy/seatLifecycle.mjs";

/**
 * THE SEAT-FILES EXPIRY RULE (22 Nov 2026, olp_m81kzkvq02y98ger): prefix-scoped, 2 days, one number everywhere, applied
 * by the deploy touching only itself, and a refusal is UNVERIFIED, never ok.
 */
type Rule = { id: string; enabled: boolean; conditions: { prefix: string }; deleteObjectsTransition?: { condition: { type: string; maxAge: number } } };
const OTHER: Rule = { id: "keep-me", enabled: true, conditions: { prefix: "decks/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 999 * 86400 } } };
const OLD_SEVEN: Rule = { id: "seat-attachments-expire", enabled: true, conditions: { prefix: "seat-attachments/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * 86400 } } };

function fakeApi(start: Rule[], opts: { refuseWrite?: boolean; refuseRead?: number; dropOthers?: boolean } = {}) {
  let rules = [...start];
  const puts: Rule[][] = [];
  const fetchImpl = async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      if (opts.refuseWrite) return new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
      const sent = JSON.parse(init.body!).rules as Rule[];
      puts.push(sent);
      rules = opts.dropOthers ? sent.filter((r) => r.id === SEAT_LIFECYCLE.rule.id) : sent;
      return new Response(JSON.stringify({ success: true, result: {} }));
    }
    if (opts.refuseRead) return new Response(JSON.stringify({ success: false, errors: [{ message: "no" }] }), { status: opts.refuseRead });
    return new Response(JSON.stringify({ success: true, result: { rules } }));
  };
  return { fetchImpl, puts, rules: () => rules };
}

describe("the rule itself", () => {
  it("expires ONLY the seat folder, after 2 days, and every place that names the days reads the same number", () => {
    expect(SEAT_LIFECYCLE.rule.conditions).toEqual({ prefix: "seat-attachments/" });
    expect(SEAT_LIFECYCLE.rule.conditions.prefix).toBe(SEAT_ATTACHMENT_PREFIX);
    expect(SEAT_LIFECYCLE.bucket).toBe("west-peek-os-documents");
    expect(SEAT_ATTACHMENT_EXPIRE_DAYS).toBe(2);
    const ops = readFileSync(new URL("../docs/OPERATIONS.md", import.meta.url), "utf8");
    const section = ops.slice(ops.indexOf("## Seat files in R2"), ops.indexOf("## Tests"));
    const said = [...section.matchAll(/after (\d+) days|--expire-days (\d+)|within (\d+) days/g)].map((m) => Number(m[1] ?? m[2] ?? m[3]));
    expect(said.length, "the docs name the days").toBeGreaterThanOrEqual(2);
    expect(new Set(said), "the docs say the rule's days, everywhere").toEqual(new Set([SEAT_ATTACHMENT_EXPIRE_DAYS]));
  });

  it("a rule with any other prefix (or none, which would expire the whole bucket) is refused before it is sent", () => {
    expect(() => withSeatRule([], { ...SEAT_LIFECYCLE.rule, conditions: { prefix: "" } })).toThrow(/refusing/);
    expect(() => withSeatRule([], { ...SEAT_LIFECYCLE.rule, conditions: {} })).toThrow(/refusing/);
    expect(() => withSeatRule([], { ...SEAT_LIFECYCLE.rule, conditions: { prefix: "seat" } })).toThrow(/refusing/);
  });
});

describe("the deploy step", () => {
  it("replaces the old 7-day rule by id and puts every other rule back exactly as it was", async () => {
    const api = fakeApi([OTHER, OLD_SEVEN]);
    const out = await applySeatLifecycle({ account: "acct", token: "tok", fetchImpl: api.fetchImpl });
    expect(out.state).toBe("ok");
    expect(out.line).toMatch(/expires after 2 days \(written\)/);
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0]!.find((r) => r.id === "keep-me")).toEqual(OTHER);
    expect(api.puts[0]!.filter((r) => r.id === "seat-attachments-expire")).toEqual([SEAT_LIFECYCLE.rule]);
  });

  it("a rule already in place is not rewritten", async () => {
    const api = fakeApi([OTHER, SEAT_LIFECYCLE.rule]);
    const out = await applySeatLifecycle({ account: "acct", token: "tok", fetchImpl: api.fetchImpl });
    expect(out.state).toBe("ok");
    expect(api.puts).toHaveLength(0);
  });

  it("OUTAGE: a refused write, a refused read, no token, or another rule lost on the way is UNVERIFIED, never ok", async () => {
    for (const [name, api, token] of [
      ["write refused", fakeApi([OLD_SEVEN], { refuseWrite: true }), "tok"],
      ["read refused", fakeApi([], { refuseRead: 403 }), "tok"],
      ["no token", fakeApi([]), ""],
      ["another rule dropped", fakeApi([OTHER, OLD_SEVEN], { dropOthers: true }), "tok"],
    ] as const) {
      const out = await applySeatLifecycle({ account: "acct", token, fetchImpl: api.fetchImpl });
      expect(out.state, name).toBe("unverified");
      expect(out.line, name).toMatch(/UNVERIFIED|not checked/);
    }
  });
});
