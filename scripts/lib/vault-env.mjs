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

// ── The vault is checked first (0253; owner, 6 Oct 2026: "we have many api keys in the vault and any
// job should always check the vault first") ────────────────────────────────────────────────────────

/** The vendor a secret name belongs to: its first token ("RESEND_API_KEY" → "RESEND"). Empty for a bare word. */
export function vendorPrefixOf(name) {
  const m = /^([A-Z][A-Z0-9]*)_/.exec(String(name ?? "").trim());
  return m ? m[1] : "";
}

/**
 * LOOK THE VAULT UP BY NAME, THEN BY VENDOR — names only, never a value. `wanted` is what the repo's
 * RUNBOOK lists under `## Secrets` (or what its source reads as `env.X`); every exact name present is
 * `found`; for each wanted name that is absent, any vault entry sharing its vendor prefix is offered
 * under `by_vendor` (a repo wanting GIPHY_KEY gets the vault's GIPHY_API_KEY); what is left is
 * `missing`. `searched` records every name and prefix looked for, so a report that names a missing
 * secret can prove the vault was checked.
 */
export function vaultLookup(wanted, names = vaultNames()) {
  const have = new Set([...names]);
  const want = [...new Set((Array.isArray(wanted) ? wanted : []).map((n) => String(n).trim()).filter((n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n)))];
  const found = want.filter((n) => have.has(n));
  const by_vendor = {};
  const missing = [];
  const searched = [...want];
  for (const n of want) {
    if (have.has(n)) continue;
    const vendor = vendorPrefixOf(n);
    if (vendor) {
      searched.push(`${vendor}_*`);
      const matches = [...have].filter((h) => h.startsWith(`${vendor}_`)).sort();
      if (matches.length) {
        by_vendor[n] = matches;
        continue;
      }
    }
    missing.push(n);
  }
  // Everything the job may inject: the exact names, plus every vendor match.
  const allowed = [...new Set([...found, ...Object.values(by_vendor).flat()])].sort();
  return { searched: [...new Set(searched)], found, by_vendor, missing, allowed };
}

/**
 * THE ENVIRONMENT A REPO'S OWN SCRIPT RUNS IN (0253): the model's environment (no vault names, no
 * API auth) plus exactly the vault names the registry allows for that repo, copied from the
 * script's own vault-injected environment. A name not in `allowed` is never passed, whatever the
 * script asks for; a name allowed but absent from the vault is simply absent.
 */
export function envForRepoRun(base, allowed, known = vaultNames()) {
  const out = claudeChildEnv(base, undefined, known);
  for (const name of allowed ?? []) {
    if (typeof base?.[name] === "string" && !/^ANTHROPIC_/i.test(name)) out[name] = base[name];
  }
  return out;
}
