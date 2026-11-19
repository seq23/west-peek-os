/**
 * scripts/deploy/production.mjs: a failing step prints the command's real error (its stderr and
 * exit code) and the script exits non-zero — never a blank reason, never "check manually" followed
 * by "✓ deployed and verified". The real npx / npm / curl are replaced by stubs on PATH, so nothing
 * reaches Cloudflare.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "..", "scripts", "deploy", "production.mjs");

function stubs(failing: "list" | "deploy" | "health"): string {
  const dir = mkdtempSync(join(tmpdir(), "wpos-deploy-"));
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write("npx", `case "$*" in
  *"migrations apply"*) echo "nothing to apply" ;;
  *"migrations list"*) ${failing === "list" ? 'echo "list refused: code 7403" >&2; exit 5' : 'echo "No migrations to apply"'} ;;
  *"deploy"*) ${failing === "deploy" ? 'echo "Uploaded"; echo "deploy refused: Cloudflare API code 10013" >&2; exit 7' : 'echo "Current Version ID: abc-123"'} ;;
esac`);
  write("npm", "exit 0");
  write("curl", failing === "health" ? 'echo "curl: (6) Could not resolve host" >&2; exit 6' : "printf 302");
  return dir;
}

describe("the production deploy script", () => {
  it.each([
    ["list", 5, "list refused: code 7403"],
    ["deploy", 7, "deploy refused: Cloudflare API code 10013"],
    ["health", 6, "Could not resolve host"],
  ] as const)("a failing %s step prints its real error and exits non-zero", (failing, code, reason) => {
    const dir = stubs(failing);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: "8d147e242033699dd37c6f5a451f48d2" },
    });
    expect(r.status).toBe(code);
    expect(r.stderr).toContain(reason);
    expect(r.stderr).toContain(`exit code ${code}`);
    expect(r.stdout).not.toContain("deployed and verified");
  });

  it("a clean run reaches the end and exits 0 (the stubs are not failing by accident)", () => {
    const dir = stubs("none" as never);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLOUDFLARE_ACCOUNT_ID: "8d147e242033699dd37c6f5a451f48d2" },
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("deployed and verified");
  });
});
