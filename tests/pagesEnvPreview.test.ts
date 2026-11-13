import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPagesEnv } from "../scripts/duties/web-property-change.mjs";

/**
 * 13 Nov 2026: a run logged "RESEND_API_KEY · already set" and "EMAIL_FROM · already set" for a site job. Both were
 * set in the Pages project's PRODUCTION environment only; the job's PREVIEW had neither, so the form on the preview
 * answered not_configured and no email went. Delivery variables are set and verified in the environment the preview
 * runs in as well, the proof says which, and a preview that just got one is built again and awaited.
 */
describe("delivery variables reach the preview environment, not only production", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("production already has both; preview has neither → both are set for preview, the proof names each environment, and the branch's preview is rebuilt and awaited", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const project = {
      success: true,
      result: {
        deployment_configs: {
          production: { env_vars: { EMAIL_FROM: { type: "plain_text", value: "West Peek <hello@joinwestpeek.com>" }, RESEND_API_KEY: { type: "secret_text" } } },
          preview: { env_vars: {} },
        },
      },
    };
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET";
      const body = init?.body instanceof FormData ? `form:branch=${String(init.body.get("branch"))}` : String(init?.body ?? "");
      calls.push({ method, url: String(url), body });
      if (method === "POST" && String(url).endsWith("/deployments")) return new Response(JSON.stringify({ success: true, result: { id: "dep1" } }));
      if (String(url).endsWith("/deployments/dep1")) {
        polls += 1;
        return new Response(JSON.stringify({ success: true, result: { latest_stage: polls < 2 ? { name: "build", status: "active" } : { name: "deploy", status: "success" } } }));
      }
      return new Response(JSON.stringify(project));
    });
    const secrets: string[] = [];
    const lines = await applyPagesEnv(
      [
        { project: "west-peek-productions", name: "EMAIL_FROM" },
        { project: "west-peek-productions", name: "RESEND_API_KEY" },
      ],
      { CLOUDFLARE_API_TOKEN: "t", RESEND_API_KEY: "never-printed" },
      null,
      null,
      {
        branch: "work/wpc-abc12345",
        rebuildWaitMs: 40,
        putSecret: async (entry, _env, environment) => {
          secrets.push(`${entry.name}@${environment}`);
          return { outcome: "set", why: null };
        },
      },
    );
    expect(lines).toEqual([
      "pages-env: west-peek-productions (production) · EMAIL_FROM · already set",
      "pages-env: west-peek-productions (preview) · EMAIL_FROM · set",
      "pages-env: west-peek-productions (production) · RESEND_API_KEY · already set",
      "pages-env: west-peek-productions (preview) · RESEND_API_KEY · set",
      "pages-env: west-peek-productions (preview) · rebuild · set (preview of work/wpc-abc12345 rebuilt with the new setting)",
    ]);
    expect(secrets, "the secret is put for preview only: production has it").toEqual(["RESEND_API_KEY@preview"]);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(Object.keys(JSON.parse(patches[0]!.body).deployment_configs), "the PATCH writes the preview environment").toEqual(["preview"]);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body), "the branch's preview is built again").toEqual(["form:branch=work/wpc-abc12345"]);
    expect(polls, "and awaited to its deploy").toBeGreaterThanOrEqual(2);
    expect(lines.join("\n")).not.toContain("never-printed");
  });

  it("nothing changed in preview → no rebuild", async () => {
    const both = { EMAIL_FROM: { type: "plain_text", value: "West Peek <hello@joinwestpeek.com>" } };
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
      if ((init?.method ?? "GET") === "POST") posts.push(String(url));
      return new Response(JSON.stringify({ success: true, result: { deployment_configs: { production: { env_vars: both }, preview: { env_vars: both } } } }));
    });
    const lines = await applyPagesEnv([{ project: "west-peek-productions", name: "EMAIL_FROM" }], { CLOUDFLARE_API_TOKEN: "t" }, null, null, { branch: "work/wpc-abc12345" });
    expect(lines).toEqual(["pages-env: west-peek-productions (production) · EMAIL_FROM · already set", "pages-env: west-peek-productions (preview) · EMAIL_FROM · already set"]);
    expect(posts).toEqual([]);
  });
});
