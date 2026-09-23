import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VAULT_INJECTED_VAR, claudeChildEnv, vaultNames, vaultRunEnv } from "../scripts/lib/vault-env.mjs";

/**
 * A MODEL NEVER SEES THE VAULT (23 Sep 2026). The Mac claimers run under `vault.mjs run --`; the
 * `claude` / `codex` child they start gets the ordinary environment minus exactly the names the
 * vault injected. Run end to end through a REAL child process: what `vault.mjs run` builds, what the
 * spawn sites pass (`claudeChildEnv(process.env)`, shared by Porter's jobs and the seat claimer), and what the child can actually read.
 */
describe("the model's child environment", () => {
  it("never holds a vault-injected key (including one vaulted after this was written), and keeps PATH, HOME, SSH_AUTH_SOCK and the rest", () => {
    const ordinary = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/Users/someone", SSH_AUTH_SOCK: "/private/tmp/agent.sock", LANG: "en_US.UTF-8", NODE_ENV: "test" };
    const vaulted = { RESEND_API_KEY: "re_planted", CLOUDFLARE_API_TOKEN: "cf_planted", KDP_ACCOUNT_PASSWORD: "kdp_planted", A_KEY_VAULTED_NEXT_YEAR: "new_planted", ANTHROPIC_API_KEY: "sk_planted" };
    // Her seat, never a key: API auth is withheld even when it did not come from the vault.
    const seatAuth = { ANTHROPIC_BASE_URL: "https://x_planted", CLAUDE_CODE_OAUTH_TOKEN: "o_planted" };
    const underVault = vaultRunEnv({ ...ordinary, ...seatAuth }, vaulted);
    expect(underVault[VAULT_INJECTED_VAR]).toBe(Object.keys(vaulted).sort().join(","));

    let told: string[] = [];
    // `new Set()`: only what THIS run injected counts, so the test does not depend on the Mac's own vault.
    const seen = JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { env: claudeChildEnv(underVault, (names) => (told = names), new Set()) }).toString()) as Record<string, string>;
    for (const name of [...Object.keys(vaulted), ...Object.keys(seatAuth), VAULT_INJECTED_VAR]) expect(seen, `${name} reached the model's child`).not.toHaveProperty(name);
    expect(Object.values(seen).some((v) => v.endsWith("_planted")), "a vaulted VALUE reached the child").toBe(false);
    expect(told, "the job log is told the NAMES withheld").toEqual([...Object.keys(vaulted), ...Object.keys(seatAuth)].sort());
    for (const [name, value] of Object.entries(ordinary)) expect(seen[name], `${name} must still reach the child`).toBe(value);

    // A claimer started by an OLDER vault.mjs carries no record of names: the vault's own manifest
    // (names only) and alias map still strip them, alias included.
    const dir = mkdtempSync(join(tmpdir(), "vault-names-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ keyNames: ["RESEND_API_KEY", "GSC_SERVICE_ACCOUNT_JSON"] }));
    writeFileSync(join(dir, "mapping.json"), JSON.stringify({ secret_aliases: { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: "GSC_SERVICE_ACCOUNT_JSON", NOT_IN_VAULT_ALIAS: "ABSENT" } }));
    const names = vaultNames(join(dir, "manifest.json"), join(dir, "mapping.json"));
    const old = claudeChildEnv({ ...ordinary, RESEND_API_KEY: "re_planted", WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: "{}", NOT_IN_VAULT_ALIAS: "kept" }, undefined, names);
    expect(Object.keys(old).sort()).toEqual([...Object.keys(ordinary), "NOT_IN_VAULT_ALIAS"].sort());
  });
});
