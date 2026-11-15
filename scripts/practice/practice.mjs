#!/usr/bin/env node
/**
 * `npm run practice -- <inbound_message_id>...` — THE DRY RUN, ON THE BRANCH (15 Nov 2026).
 *
 * `POST /api/inbound-email/reingest {dry_run:true}` only ever ran production's code, so a fault in a change was found
 * after it deployed (7 PRs for one change, #460–#466). This runs the same `dryReadMessage` with THIS checkout's code:
 * `wrangler dev` on 127.0.0.1 (scripts/practice/worker.ts, one route) with production's D1, R2, KV, Workers AI and the
 * Boss OS brain over remote bindings. Production data is read; the only rows written are the dry run's own model-run
 * bookkeeping, which `forgetDryRun` removes. Nothing is sent: the practice worker has no email binding, no secret, no
 * cron and none of the real routes, and the email switches are off in its vars.
 *
 * Prints, per message: the brief (asks, holds, questions, unclear, files) and the Got it text. Exit 1 if any read failed.
 * The Cloudflare token comes from the vault: run as is and it re-runs itself under `vault:run`.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!ids.length || ids.some((id) => !/^inm_[\w-]+$/.test(id))) {
  console.error("usage: npm run practice -- <inbound_message_id> [more ids]   (ids look like inm_…)");
  process.exit(1);
}
if (!process.env.CLOUDFLARE_API_TOKEN) {
  if (process.env.WP_PRACTICE_IN_VAULT) { console.error("PRACTICE STOP: CLOUDFLARE_API_TOKEN is not in the vault"); process.exit(1); }
  const r = spawnSync("node", [path.join(ROOT, "scripts/vault/vault.mjs"), "run", "--", "node", fileURLToPath(import.meta.url), ...ids], { stdio: "inherit", env: { ...process.env, WP_PRACTICE_IN_VAULT: "1" } });
  process.exit(r.status ?? 1);
}

/** The practice config: production's data bindings, remote; email off; no secret, cron, queue, browser or assets. */
function practiceConfig(nonce) {
  const toml = readFileSync(path.join(ROOT, "wrangler.toml"), "utf8").replace(/^\s*#.*$/gm, "");
  const prod = toml.slice(toml.indexOf("[env.production]"));
  const grab = (re, what) => { const m = re.exec(prod); if (!m) throw new Error(`PRACTICE STOP: wrangler.toml [env.production] has no ${what}`); return m[1]; };
  const top = (re, what) => { const m = re.exec(toml); if (!m) throw new Error(`PRACTICE STOP: wrangler.toml has no ${what}`); return m[1]; };
  return {
    name: "west-peek-os-practice",
    main: path.join(ROOT, "scripts/practice/worker.ts"),
    compatibility_date: top(/^compatibility_date\s*=\s*"([^"]+)"/m, "compatibility_date"),
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{ binding: "WP_OS_DB", database_name: grab(/database_name\s*=\s*"([^"]+)"/, "D1 name"), database_id: grab(/database_id\s*=\s*"([^"]+)"/, "D1 id"), remote: true }],
    r2_buckets: [{ binding: "WP_OS_DOCUMENTS", bucket_name: grab(/bucket_name\s*=\s*"([^"]+)"/, "R2 bucket"), remote: true }],
    kv_namespaces: [{ binding: "WP_OS_KV", id: grab(/\[\[env\.production\.kv_namespaces\]\][^[]*?id\s*=\s*"([^"]+)"/, "KV id"), remote: true }],
    ai: { binding: "AI", remote: true },
    services: [{ binding: "WP_OS_BOSS_BRAINS", service: grab(/binding = "WP_OS_BOSS_BRAINS"\s*\n\s*service\s*=\s*"([^"]+)"/, "brain service"), entrypoint: grab(/binding = "WP_OS_BOSS_BRAINS"[\s\S]*?entrypoint\s*=\s*"([^"]+)"/, "brain entrypoint"), remote: true }],
    vars: { WP_OS_ENV: "production", WP_OS_EMAIL_SEND: "disabled", WP_OS_AI_EMAIL_PARTNERS: "disabled", WP_OS_OUTSIDE_EMAIL_BREAK_GLASS: "off-hard", PRACTICE_NONCE: nonce },
  };
}

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const dir = path.join(ROOT, "node_modules/.cache/practice");
mkdirSync(dir, { recursive: true });
const nonce = randomBytes(16).toString("hex");
const configPath = path.join(dir, "wrangler.json");
writeFileSync(configPath, JSON.stringify(practiceConfig(nonce), null, 2), { mode: 0o600 });
const port = await freePort();
const dev = spawn("npx", ["wrangler", "dev", "--config", configPath, "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false", "--log-level", "warn"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));
const stop = () => { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* gone */ } rmSync(configPath, { force: true }); };
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

// Ready = the route answers (a GET is a 404 from the practice worker). Bounded: 3 minutes.
const base = `http://127.0.0.1:${port}`;
let ready = false;
for (const deadline = Date.now() + 180_000; Date.now() < deadline && dev.exitCode === null; ) {
  try { const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(5_000) }); if (r.status === 404) { ready = true; break; } } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 1_000));
}
if (!ready) { console.error(`PRACTICE STOP: the practice worker did not start.\n${devLog.trim().split("\n").slice(-25).join("\n")}`); process.exit(1); }

/** The Got it as he would read it: TL;DR, each section's bullets, then the details under the rule. */
const gotItLines = (g) => [`    | ${g.tldr}`, ...g.sections.flatMap((sec) => [`    | ${sec.label}`, ...sec.bullets.map((x) => `    |   • ${x}`)]), ...(g.details ? ["    | ───", ...g.details.split("\n").map((l) => `    | ${l}`)] : [])];
const list = (title, items) => [`  ${title} (${items.length})`, ...items.map((i) => `    - ${i}`)];
let failed = 0;
for (const id of ids) {
  console.log(`\n═══ ${id} (branch ${spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()})`);
  let out;
  try {
    const res = await fetch(`${base}/practice`, { method: "POST", headers: { "content-type": "application/json", "x-practice-nonce": nonce }, body: JSON.stringify({ inbound_message_id: id }), signal: AbortSignal.timeout(15 * 60_000) });
    out = await res.json().catch(async () => ({ error: `HTTP ${res.status}` }));
  } catch (e) { out = { error: String(e) }; }
  if (!out?.ok) { failed++; console.log(`  FAILED: ${out?.error ?? "?"} ${out?.detail ?? ""}\n${devLog.trim().split("\n").slice(-15).join("\n")}`); continue; }
  const w = out.would, b = w.first_read.brief;
  console.log([
    `  key ${out.object_key} · partner ${w.authenticated_partner ?? "none"} · steers ${w.would_steer ? `${w.would_steer.object_type} ${w.would_steer.object_id}` : "nothing (new card)"}`,
    `  read by ${w.first_read.reader} · tried: ${w.first_read.readers_tried.join(" | ") || "none"}`,
    ...list("asks", b.asks), ...list("holds", b.holds), ...list("questions", b.questions),
    ...list("unclear", b.unclear.map((u) => `${u.words} :: ${u.missing}`)),
    ...list("files", b.files.map((f) => `${f.filename}${f.purpose ? ` — ${f.purpose}` : ""}`)),
    ...(w.unopened.length ? list("unopened", w.unopened.map((u) => u.reason)) : []),
    "  Got it:",
    ...(w.got_it ? gotItLines(w.got_it) : ["    (none: nothing to say back)"]),
  ].join("\n"));
}
console.log(`\npractice: ${ids.length - failed}/${ids.length} read on the branch's code; nothing written but the dry run's own bookkeeping, nothing sent`);
process.exit(failed ? 1 : 0);
