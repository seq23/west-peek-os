#!/usr/bin/env node
/**
 * West Peek OS encrypted secret vault.
 *
 * - Payload: ~/.west-peek-os/vault/secrets.vault  (AES-256-GCM encrypted JSON map)
 * - Metadata (non-secret): ~/.west-peek-os/vault/manifest.json (key names only)
 * - Master key: random 32 bytes, custodied in macOS Keychain (service below).
 * - Fail closed: if Keychain is unavailable, every command exits non-zero with the exact gate.
 * - Values are never printed, logged, or written to the repo/artifacts/receipts.
 *
 * Commands: init | import <path> | set <NAME> | status | run -- <cmd...> | remove <NAME> | doctor | sync:cloudflare
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const VAULT_DIR = join(homedir(), ".west-peek-os", "vault");
const VAULT_FILE = join(VAULT_DIR, "secrets.vault");
const MANIFEST_FILE = join(VAULT_DIR, "manifest.json");
const KEYCHAIN_SERVICE = "west-peek-os-vault";
const KEYCHAIN_ACCOUNT = "master-key";
const AAD = Buffer.from("west-peek-os-vault:v1", "utf8");

function fail(msg) {
  console.error(`VAULT GATE: ${msg}`);
  process.exit(1);
}

function ensureDir() {
  mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(VAULT_DIR, 0o700);
}

function keychainAvailable() {
  if (platform() !== "darwin") return false;
  try {
    execFileSync("security", ["list-keychains"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function storeMasterKey(keyB64) {
  // -A: allow any local application to read this item without an interactive GUI prompt.
  // The vault is designed for unattended operator-machine use; an interactive ACL prompt
  // would hang headless runs. Item still lives only in the user's login keychain.
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT], {
      stdio: "pipe",
    });
  } catch {
    /* absent is fine */
  }
  execFileSync(
    "security",
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", keyB64, "-A"],
    { stdio: "pipe" },
  );
}

function loadMasterKey() {
  if (!keychainAvailable()) {
    fail("macOS Keychain unavailable on this host. Vault refuses to operate (no plaintext downgrade).");
  }
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString("utf8")
      .trim();
    const key = Buffer.from(out, "base64");
    if (key.length !== 32) fail("Keychain master key is malformed. Re-run `vault:init` after clearing the entry.");
    return key;
  } catch {
    fail("No vault master key in Keychain. Run `vault:init` first.");
  }
}

function encrypt(key, obj) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString("base64");
}

function decrypt(key, payloadB64) {
  const raw = Buffer.from(payloadB64, "base64");
  if (raw.length < 28) fail("Vault payload is corrupt (too short).");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const obj = JSON.parse(pt);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) fail("Vault payload shape invalid.");
    return obj;
  } catch {
    fail("Vault decryption failed (wrong key or tampered payload). Fail closed.");
  }
}

function readVault(key) {
  if (!existsSync(VAULT_FILE)) return {};
  return decrypt(key, readFileSync(VAULT_FILE, "utf8").trim());
}

function writeVault(key, secrets) {
  ensureDir();
  writeFileSync(VAULT_FILE, encrypt(key, secrets) + "\n", { mode: 0o600 });
  chmodSync(VAULT_FILE, 0o600);
  const names = Object.keys(secrets).sort();
  writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), count: names.length, keyNames: names },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

async function promptSecret(name) {
  /*
   * NOT EVERY CALLER HAS A TERMINAL.
   *
   * The hidden prompt below needs raw mode, which needs a real TTY. Run from anywhere that is not
   * one — a Claude Code `!` line, a script, CI — `setRawMode` throws or the prompt hangs waiting
   * for a keystroke that never comes. The operator hit exactly that: "the command doesnt work".
   *
   * So when stdin is not a TTY, read the value from it instead. That makes the safe route work:
   *
   *   npm run vault:set RUNWARE_API_KEY < ~/Desktop/key.txt
   *
   * which keeps the secret out of shell history and out of any transcript, unlike passing it as an
   * argument. Trailing newline is stripped because a file almost always has one and a secret almost
   * never does.
   */
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(`Enter value for ${name} (input hidden): `);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (ch) => {
      const c = ch.toString("utf8");
      if (c === "\n" || c === "\r") {
        stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(buf);
      } else if (c === "\u007f" || c === "\b") {
        buf = buf.slice(0, -1);
      } else if (c === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else {
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "init": {
      ensureDir();
      if (!keychainAvailable()) fail("macOS Keychain unavailable; cannot custody master key. Fail closed.");
      const key = randomBytes(32).toString("base64");
      storeMasterKey(key);
      const masterKey = loadMasterKey();
      if (!existsSync(VAULT_FILE)) writeVault(masterKey, {});
      console.log("Vault initialized. Master key custodied in macOS Keychain (service: west-peek-os-vault).");
      console.log(`Vault: ${VAULT_FILE}`);
      break;
    }
    case "import": {
      const src = rest[0];
      if (!src) fail("usage: vault:import <path-to-operator-supplied.env>");
      if (!existsSync(src)) fail(`source file not found: ${src}`);
      const key = loadMasterKey();
      const parsed = parseEnvFile(readFileSync(src, "utf8"));
      const names = Object.keys(parsed);
      if (names.length === 0) fail("no KEY=VALUE pairs found in source file.");
      const secrets = readVault(key);
      for (const n of names) secrets[n] = parsed[n];
      writeVault(key, secrets);
      console.log(`Imported ${names.length} key(s): ${names.sort().join(", ")}`);
      console.log("Source file left untouched; deleting it remains a human action.");
      break;
    }
    case "set": {
      const name = rest[0];
      if (!name || !VALID_NAME.test(name)) fail("usage: vault:set <NAME> (valid env-var name)");
      const key = loadMasterKey();
      const value = await promptSecret(name);
      if (!value) fail("empty value refused.");
      const secrets = readVault(key);
      secrets[name] = value;
      writeVault(key, secrets);
      console.log(`Set ${name} (${Object.keys(secrets).length} keys total). Value not displayed.`);
      break;
    }
    case "status": {
      const key = loadMasterKey();
      const secrets = readVault(key);
      const names = Object.keys(secrets).sort();
      console.log(`Vault: ${VAULT_FILE}`);
      console.log(`Keys present: ${names.length}`);
      for (const n of names) console.log(`  ${n}: PRESENT`);
      break;
    }
    case "run": {
      const sep = rest[0] === "--" ? 1 : 0;
      const childArgs = rest.slice(sep);
      if (childArgs.length === 0) fail("usage: vault:run -- <command> [args...]");
      const key = loadMasterKey();
      const secrets = readVault(key);
      const child = spawn(childArgs[0], childArgs.slice(1), {
        stdio: "inherit",
        env: { ...process.env, ...secrets },
      });
      child.on("exit", (code) => process.exit(code ?? 1));
      break;
    }
    case "remove": {
      const name = rest[0];
      if (!name) fail("usage: vault:remove <NAME>");
      const key = loadMasterKey();
      const secrets = readVault(key);
      if (!(name in secrets)) fail(`no such key: ${name}`);
      delete secrets[name];
      writeVault(key, secrets);
      console.log(`Removed ${name}.`);
      break;
    }
    case "doctor": {
      const problems = [];
      if (!keychainAvailable()) problems.push("macOS Keychain unavailable");
      let key = null;
      try {
        key = loadMasterKey();
      } catch {
        problems.push("master key not retrievable from Keychain");
      }
      if (key) {
        try {
          const probe = { __doctor_probe__: randomBytes(8).toString("hex") };
          const round = decrypt(key, encrypt(key, probe));
          if (round.__doctor_probe__ !== probe.__doctor_probe__) problems.push("encryption round-trip mismatch");
        } catch {
          problems.push("encryption round-trip failed");
        }
        try {
          const secrets = readVault(key);
          const names = Object.keys(secrets);
          if (existsSync(MANIFEST_FILE)) {
            const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
            const mn = (manifest.keyNames ?? []).slice().sort();
            if (JSON.stringify(mn) !== JSON.stringify(names.slice().sort()))
              problems.push("manifest key names diverge from vault payload");
          }
          console.log(`Vault readable. ${names.length} key(s) present (names only, values never shown).`);
        } catch (e) {
          problems.push(`vault payload unreadable: ${e.message ?? e}`);
        }
      }
      const mode = (VAULT_FILE && existsSync(VAULT_FILE)) ? (0o600).toString(8) : null;
      if (mode) console.log(`Vault file permissions OK (0600 expected): ${VAULT_FILE}`);
      if (problems.length) {
        for (const p of problems) console.error(`DOCTOR FAIL: ${p}`);
        process.exit(1);
      }
      console.log("DOCTOR OK: keychain custody + AES-256-GCM round-trip + manifest consistency verified.");
      break;
    }
    case "sync:cloudflare": {
      // Sends specifically mapped secrets to Cloudflare Worker secret storage.
      // Requires CLOUDFLARE_ACCOUNT_ID (env, non-secret) and CLOUDFLARE_API_TOKEN (vault).
      const mappingPath = join(new URL(".", import.meta.url).pathname, "cloudflare-mapping.json");
      if (!existsSync(mappingPath)) fail(`no sync mapping file: ${mappingPath} (names-only mapping required)`);
      const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID not set (non-secret env). CREDENTIAL GATE.");
      const key = loadMasterKey();
      const secrets = readVault(key);
      if (!secrets.CLOUDFLARE_API_TOKEN) fail("CLOUDFLARE_API_TOKEN absent from vault. CREDENTIAL GATE.");
      const workerName = mapping.worker_name ?? "west-peek-os";
      const names = mapping.secret_names ?? [];
      if (names.length === 0) fail("mapping has empty secret_names; nothing to sync.");
      for (const name of names) {
        if (!(name in secrets)) fail(`mapped secret ${name} is not in the vault; refusing partial sync.`);
      }
      for (const name of names) {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${secrets.CLOUDFLARE_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, text: secrets[name], type: "secret_text" }),
          },
        );
        if (!res.ok) fail(`Cloudflare secret sync failed for ${name}: HTTP ${res.status}`);
        console.log(`Synced ${name} → Cloudflare worker ${workerName} (value never displayed).`);
      }
      console.log("Cloudflare secret sync complete.");
      break;
    }
    default:
      console.error(
        "usage: vault.mjs init | import <path> | set <NAME> | status | run -- <cmd...> | remove <NAME> | doctor | sync:cloudflare",
      );
      process.exit(1);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
