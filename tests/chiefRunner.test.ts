import { describe, expect, it } from "vitest";
import { attachmentUrl, chiefChildEnvironment, chiefClaudeArgs, readChiefRunBudget } from "../scripts/duties/partner-session.mjs";

describe("chief runner", () => {
  it("limits the live runner to workspace files and drops ambient credentials", () => {
    const args = chiefClaudeArgs({ cwd: "/private/chief-fixture", job: { employee: { name: "Wren" } }, model: "sonnet" });
    expect(args[args.indexOf("--tools") + 1]?.split(",").sort()).toEqual(["Edit", "Read", "Write"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("--setting-sources=");
    expect(chiefChildEnvironment({ PATH: "/bin", HOME: "/tmp/test", GH_TOKEN: "fixture-only",
      SSH_AUTH_SOCK: "/test/auth.sock", CUSTOM_ACCESS_SECRET: "fixture-only" })).toEqual({ PATH: "/bin", HOME: "/tmp/test" });
  });

  it("only prepares an authenticated attachment request for its exact origin and card", () => {
    const host = "https://os.joinwestpeek.com";
    const route = "/api/work-cards/wc_fixture/attachments/att_fixture";
    expect(attachmentUrl(host, "wc_fixture", route).href).toBe(host + route);
    expect(() => attachmentUrl("https://os.joinwestpeek.com.example.org", "wc_fixture", route)).toThrow();
    expect(() => attachmentUrl(host, "wc_other", route)).toThrow();
    expect(() => attachmentUrl(host, "wc_fixture", `${route}/../../unrelated`)).toThrow();
    expect(() => attachmentUrl(host, "wc_fixture", "//example.org/attachment")).toThrow();
  });

  it("rejects a capped or unmeasured run before accepting its output", () => {
    const budget = readChiefRunBudget();
    const assistant = (id: string, input_tokens: number) =>
      ({ type: "assistant", message: { id, usage: { input_tokens, output_tokens: 10 } } });
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 3 };
    expect(budget(assistant("same", 550_000))).toBeNull();
    expect(budget(assistant("same", 550_000))).toBeNull();
    expect(budget(assistant("next", 500_000))).toBe("The session reached its token limit.");
    expect(readChiefRunBudget()({ ...result, usage: { input_tokens: 5, output_tokens: 4 } })).toBeNull();
    expect(readChiefRunBudget()(result)).toBe("The session did not report its usage.");
    expect(readChiefRunBudget()({ ...result, num_turns: 41 })).toBe("The session reached its turn limit.");
  });
});
