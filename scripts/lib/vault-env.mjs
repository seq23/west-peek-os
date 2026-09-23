/**
 * THE ENVIRONMENT A MODEL CHILD RUNS IN — HER SEAT, NEVER A KEY, AND NOTHING FROM THE VAULT.
 *
 * ONE function, `claudeChildEnv`, used by every place a Mac script starts a model (`claude` for
 * Porter's jobs, `claude`/`codex` for the subscription seats). Until 23 Sep 2026 each of those two
 * files kept its own copy of a hand-written strip list, and both failed open.
 *
 * 21 Sep 2026 — HER SEAT: `claude -p` prefers an API key in its environment over the subscription
 * login, so every ANTHROPIC_* and CLAUDE_* auth variable is removed wherever it came from.
 *
 * 23 Sep 2026 — NOTHING FROM THE VAULT: the claimers run under `vault.mjs run --`, which injects
 * every vaulted secret (Cloudflare token, Resend key, KDP and IMAP passwords, Access secrets, provider
 * keys), and the model inherited all of them. Now every name the vault injected is removed too. The
 * names come from the vault itself, never from a list here: `vault.mjs run` records the names it
 * injected in VAULT_INJECTED_VAR (names only, never a value), and the vault's own manifest and alias
 * map are read as well, so a claimer started by an older `vault.mjs` still strips them and a key
 * vaulted tomorrow is stripped tomorrow. The ordinary environment is untouched: PATH, HOME,
 * SSH_AUTH_SOCK, and the Keychain logins the model pushes and opens PRs with (gh via keyring, git
 * via osxkeychain) — nothing it needs lives in the vault.
 *
 * Whatever the SCRIPT does on the model's behalf (Drive fetch, ~/bin/land, the deploy, Pages config,
 * the claimer's own calls to the Worker) runs in the script's process with its full environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VAULT_INJECTED_VAR = "WP_OS_VAULT_INJECTED";
const MANIFEST = join(homedir(), ".west-peek-os", "vault", "manifest.json");
const MAPPING = fileURLToPath(new URL("../vault/cloudflare-mapping.json", import.meta.url));

/** The environment `vault.mjs run` gives its child: the secrets, and the list of their NAMES. */
export function vaultRunEnv(base, injected) {
  return { ...base, ...injected, [VAULT_INJECTED_VAR]: Object.keys(injected).sort().join(",") };
}

/** Every name the vault injects, from its own manifest (names only) and alias map. Empty if there is no vault. */
export function vaultNames(manifestPath = MANIFEST, mappingPath = MAPPING) {
  const names = new Set();
  try {
    if (existsSync(manifestPath)) for (const n of JSON.parse(readFileSync(manifestPath, "utf8")).keyNames ?? []) names.add(String(n));
  } catch {
    /* an unreadable manifest adds nothing; the run's own record still applies */
  }
  try {
    for (const [alias, target] of Object.entries(JSON.parse(readFileSync(mappingPath, "utf8")).secret_aliases ?? {})) if (names.has(target)) names.add(alias);
  } catch {
    /* no alias map: nothing to alias */
  }
  return names;
}

/**
 * `base` without any vault-injected name and without any ANTHROPIC_* / CLAUDE_* auth. `onStripped`
 * is told the NAMES removed (never a value), so the job log says what the model was not given.
 */
export function claudeChildEnv(base, onStripped, known = vaultNames()) {
  const vaulted = new Set([...known, ...String(base?.[VAULT_INJECTED_VAR] ?? "").split(",").filter(Boolean)]);
  const out = {};
  const stripped = [];
  for (const [k, v] of Object.entries(base ?? {})) {
    if (k === VAULT_INJECTED_VAR) continue;
    if (vaulted.has(k) || /^ANTHROPIC_/i.test(k) || /^CLAUDE_(API|AUTH|CODE_OAUTH|CODE_USE|CODE_API|OAUTH|TOKEN)/i.test(k)) {
      stripped.push(k);
      continue;
    }
    out[k] = v;
  }
  onStripped?.(stripped.sort());
  return out;
}

/** One line for a job log or a failure reason: which names the model was not given. Names only. */
export function strippedNote(names) {
  return names.length ? `withheld from the model's environment (vault / API auth, by design): ${names.join(", ")}` : "nothing was withheld from the model's environment";
}
