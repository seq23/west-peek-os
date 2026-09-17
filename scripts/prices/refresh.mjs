#!/usr/bin/env node
/**
 * refresh.mjs — read model prices from the vendors, and say what has moved.
 *
 *   npm run prices:refresh          read the vendors, print a comparison, emit the SQL for any drift
 *   npm run prices:refresh -- --check   read the vendors and EXIT 1 on drift or staleness
 *   npm run validate:prices         offline: the register and the migration must agree, plus self-test
 *
 * WHY THIS EXISTS RATHER THAN A ONE-OFF FILL. Migration 0177 replaced every invented price in this
 * catalogue with one read from a vendor. That fixes today and rots: a vendor changes a list price,
 * nothing here notices, and the table goes back to being confidently wrong — which is the same
 * defect, arrived at by waiting instead of by guessing. A price is only as true as the last time
 * somebody looked.
 *
 * TWO PROGRAMMATIC, AUTHORITATIVE SOURCES, and neither needs a secret:
 *   · https://openrouter.ai/api/v1/models — public, no key, the price OpenRouter actually charges,
 *     which for a first-party model is the vendor's list price passed through.
 *   · https://developers.cloudflare.com/workers-ai/platform/pricing/ — Cloudflare publishes both
 *     the neuron rate and the per-million-token dollar figure, so the dollar figure is quoted
 *     rather than derived by us.
 *   · Perplexity's GET /v1/models returns pricing as usd_per_1m_tokens. It needs a key, so it is
 *     read ONLY when PERPLEXITY_API_KEY is already in the environment of whoever runs this — this
 *     script never asks for, stores, or prints a credential.
 *
 * STALENESS IS LOUD, NOT FATAL. A SOURCED price older than `staleness_days` (45) is reported and
 * shown stale in the Cockpit; it does NOT stop being selectable. A price that expires into a
 * refusal is a time bomb — the firm's AI would stop 45 days after the last person remembered to run
 * a script. What the router refuses is a price that was NEVER read, which is a different and
 * permanent condition.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTER = path.join(ROOT, "deployment", "model-prices.json");

/** Which register row is read from which upstream id. */
const SOURCE_ID = {
  "prov_openrouter|anthropic/claude-sonnet-5": { source: "openrouter_feed", id: "anthropic/claude-sonnet-5" },
  "prov_openrouter|perplexity/sonar": { source: "openrouter_feed", id: "perplexity/sonar" },
  "prov_openrouter|auto": { source: "openrouter_feed", id: "openrouter/auto" },
  "prov_openai|gpt-4o": { source: "openrouter_feed", id: "openai/gpt-4o" },
  "prov_anthropic|claude-sonnet-4": { source: "openrouter_feed", id: "anthropic/claude-sonnet-4" },
  "prov_perplexity|perplexity/sonar": { source: "openrouter_feed", id: "perplexity/sonar" },
  "prov_workers_ai|@cf/ibm-granite/granite-4.0-h-micro": { source: "cloudflare", id: "granite-4.0-h-micro" },
  "prov_workers_ai|@cf/qwen/qwen3-30b-a3b-fp8": { source: "cloudflare", id: "qwen3-30b-a3b-fp8" },
  "prov_workers_ai|@cf/meta/llama-3.2-11b-vision-instruct": { source: "cloudflare", id: "llama-3.2-11b-vision-instruct" },
  "prov_openrouter_free|nvidia/nemotron-3-ultra-550b-a55b:free": { source: "openrouter_feed", id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  "prov_google_free|gemini-2.5-flash": { source: "openrouter_feed", id: "google/gemini-2.5-flash", freeTier: true },
};

// ── Reading the vendors ──────────────────────────────────────────────────────────────────────

/**
 * Model ids the catalogue treats as search-grounded, read out of the shared constant rather than
 * re-listed here — two lists with no link between them is a named defect class in this repo.
 */
export function searchGroundedModels(modelsSource) {
  const m = /SEARCH_GROUNDED_MODELS[^=]*=\s*\[([^\]]*)\]/.exec(modelsSource);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
}

async function readOpenRouter(fetchImpl = fetch, searchModels = new Set()) {
  const res = await fetchImpl("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`openrouter feed HTTP ${res.status}`);
  const body = await res.json();
  const out = new Map();
  for (const m of body.data ?? []) {
    const p = m.pricing ?? {};
    const inUsd = Number(p.prompt) * 1e6;
    const outUsd = Number(p.completion) * 1e6;
    out.set(m.id, {
      // -1 means "no fixed price": auto-routing costs whatever it picks. Not a number, and must
      // never be recorded as one.
      input_per_mtok_usd: inUsd < 0 ? null : round6(inUsd),
      output_per_mtok_usd: outUsd < 0 ? null : round6(outUsd),
      /*
       * A WEB-SEARCH FEE IS ONLY A COST IF THE CALL SEARCHES.
       *
       * The feed lists `web_search` on plenty of models that merely SUPPORT the search plugin —
       * claude-sonnet-5 carries $0.01 — and this firm does not use it there. Recording it as an
       * unconditional per-request charge would inflate every Sonnet estimate by ten times the
       * token cost of a short call, which is the mirror image of the defect that started this:
       * a number in the pricing table that is not what the firm actually pays.
       *
       * So it is applied only to models the catalogue records as search-grounded, where searching
       * IS the call. Read from SEARCH_GROUNDED_MODELS rather than re-listed.
       */
      request_usd: searchModels.has(m.id) && p.web_search ? Number(p.web_search) : 0,
    });
  }
  return out;
}

export function parseCloudflarePricing(html) {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out = new Map();
  // "<model> $0.017 per M input tokens $0.112 per M output tokens 1542 neurons per M input tokens"
  const re = /([A-Za-z0-9._-]+)\s+\$([0-9.]+) per M input tokens\s+\$([0-9.]+) per M output tokens/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1], { input_per_mtok_usd: Number(m[2]), output_per_mtok_usd: Number(m[3]), request_usd: 0 });
  }
  return out;
}

async function readCloudflare(fetchImpl = fetch) {
  const res = await fetchImpl("https://developers.cloudflare.com/workers-ai/platform/pricing/");
  if (!res.ok) throw new Error(`cloudflare pricing HTTP ${res.status}`);
  return parseCloudflarePricing(await res.text());
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// ── Comparing ────────────────────────────────────────────────────────────────────────────────

/** Pure. Given the register and what the vendors say, what has moved and what has gone stale. */
export function compare({ register, live, today }) {
  const drift = [];
  const stale = [];
  const unchecked = [];
  let examined = 0;

  for (const row of register.prices ?? []) {
    const key = `${row.provider_id}|${row.model}`;
    const src = SOURCE_ID[key];
    if (!src) {
      unchecked.push(`${key}: no upstream source is mapped for this row, so nothing can re-read it`);
      continue;
    }
    const seen = live.get(`${src.source}:${src.id}`);
    if (!seen) {
      unchecked.push(`${key}: ${src.id} was not present in the ${src.source} response`);
      continue;
    }
    examined++;

    // A free-tier row is $0 by definition; the upstream price is what it costs once the quota goes.
    const expected = src.freeTier
      ? { input_per_mtok_usd: 0, output_per_mtok_usd: 0, request_usd: 0 }
      : seen;

    for (const field of ["input_per_mtok_usd", "output_per_mtok_usd", "request_usd"]) {
      const was = row[field] ?? null;
      const now = expected[field] ?? null;
      if (was === null && now === null) continue;
      if (was === null || now === null || Math.abs(was - now) > 1e-9) {
        drift.push({ key, field, recorded: was, vendor: now });
      }
    }

    if (row.pricing_state === "SOURCED" && row.sourced_at) {
      const days = Math.floor((Date.parse(today) - Date.parse(row.sourced_at)) / 86_400_000);
      if (days > (register.staleness_days ?? 45)) stale.push({ key, days, sourced_at: row.sourced_at });
    }
  }
  return { drift, stale, unchecked, examined };
}

/** The SQL a person can paste into the next migration when something has moved. */
export function driftSql(drift, today, register = { prices: [] }) {
  if (drift.length === 0) return "";
  const byKey = new Map();
  for (const d of drift) {
    if (!byKey.has(d.key)) {
      // START FROM THE WHOLE ROW. A snapshot carries three numbers, and emitting NULL for the two
      // that did not move would write a row saying this model has no token price.
      const [pid, model] = d.key.split("|");
      const row = (register.prices ?? []).find((r) => r.provider_id === pid && r.model === model) ?? {};
      byKey.set(d.key, {
        input_per_mtok_usd: row.input_per_mtok_usd ?? null,
        output_per_mtok_usd: row.output_per_mtok_usd ?? null,
        request_usd: row.request_usd ?? 0,
      });
    }
    byKey.get(d.key)[d.field] = d.vendor;
  }
  const stamp = today.slice(0, 10).replace(/-/g, "");
  const lines = [
    `-- Prices that moved, read ${today.slice(0, 10)} from the vendor. A NEW SNAPSHOT, never an UPDATE:`,
    `-- provider_pricing_snapshot is the history of what a price WAS, and the router reads the latest.`,
  ];
  let n = 0;
  for (const [key, fields] of byKey) {
    const [providerId, model] = key.split("|");
    n++;
    lines.push(
      `INSERT INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)`,
      `SELECT 'pps_${stamp}_${n}', '${providerId}', '${model.replace(/'/g, "''")}', ` +
        `${fields.input_per_mtok_usd ?? "NULL"}, ${fields.output_per_mtok_usd ?? "NULL"}, ${fields.request_usd ?? 0}, '${today}'`,
      `WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_${stamp}_${n}');`,
      ``,
    );
  }
  return lines.join("\n");
}

// ── The offline half: the register and the migration must agree ──────────────────────────────

/**
 * Parse every pricing snapshot the migrations write, as numbers.
 *
 * Textual matching was tried first and was wrong for a boring reason: the register holds JSON
 * numbers (10, 0) and the SQL is hand-written (10.0, 0.0). "10" not matching "10.0" is not a
 * disagreement about a price, and a validator that reports one teaches people to ignore it.
 */
export function snapshotsInMigrations(migrationSql) {
  const out = [];
  const re =
    /SELECT\s+'[^']*',\s*'([^']+)',\s*'((?:[^']|'')+)',\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),/g;
  let m;
  while ((m = re.exec(migrationSql)) !== null) {
    out.push({
      provider_id: m[1],
      model: m[2].replace(/''/g, "'"),
      input_per_mtok_usd: Number(m[3]),
      output_per_mtok_usd: Number(m[4]),
      request_usd: Number(m[5]),
    });
  }
  return out;
}

export function checkRegisterAgainstMigration(register, migrationSql) {
  const violations = [];
  const snapshots = snapshotsInMigrations(migrationSql);
  let examined = 0;
  for (const row of register.prices ?? []) {
    if (row.input_per_mtok_usd === null) continue; // UNKNOWN rows write no snapshot, by design
    examined++;
    const hit = snapshots.find(
      (s) =>
        s.provider_id === row.provider_id &&
        s.model === row.model &&
        Math.abs(s.input_per_mtok_usd - row.input_per_mtok_usd) < 1e-9 &&
        Math.abs(s.output_per_mtok_usd - row.output_per_mtok_usd) < 1e-9 &&
        Math.abs(s.request_usd - (row.request_usd ?? 0)) < 1e-9,
    );
    if (!hit) {
      violations.push(
        `${row.provider_id}/${row.model}: the register says ${row.input_per_mtok_usd}/${row.output_per_mtok_usd} (+${row.request_usd ?? 0} per request) but no migration writes that snapshot. The register would be describing a price the database does not have.`,
      );
    }
  }
  return { violations, examined };
}

function allMigrations() {
  const dir = path.join(ROOT, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

function selfTest() {
  const register = {
    staleness_days: 45,
    prices: [
      { provider_id: "prov_openrouter", model: "anthropic/claude-sonnet-5", input_per_mtok_usd: 2, output_per_mtok_usd: 10, request_usd: 0, pricing_state: "SOURCED", sourced_at: "2026-09-17" },
    ],
  };
  const live = new Map([["openrouter_feed:anthropic/claude-sonnet-5", { input_per_mtok_usd: 2, output_per_mtok_usd: 10, request_usd: 0 }]]);

  const failures = [];
  const clean = compare({ register, live, today: "2026-09-18" });
  if (clean.drift.length !== 0 || clean.stale.length !== 0 || clean.examined !== 1) failures.push("clean case should be quiet and examine 1 row");

  const moved = compare({
    register,
    live: new Map([["openrouter_feed:anthropic/claude-sonnet-5", { input_per_mtok_usd: 3, output_per_mtok_usd: 10, request_usd: 0 }]]),
    today: "2026-09-18",
  });
  if (moved.drift.length !== 1) failures.push("a vendor price change must be reported as drift");
  const sql = driftSql(moved.drift, "2026-09-18T00:00:00.000Z", register);
  if (!sql.includes("provider_pricing_snapshot")) failures.push("drift must emit applyable SQL");
  // The fields that did NOT move must carry their current values, not NULL.
  if (!sql.includes("3, 10, 0")) failures.push("drift SQL must carry the whole row, not only the field that changed");
  if (sql.includes("NULL")) failures.push("drift SQL must not null out a price that simply did not change");
  const searchSet = searchGroundedModels(`export const SEARCH_GROUNDED_MODELS: readonly string[] = ["perplexity/sonar"];`);
  if (!searchSet.has("perplexity/sonar") || searchSet.size !== 1) failures.push("the search-grounded list must be read from the shared constant");

  // THE PER-REQUEST FEE, which is the field the old table could not even express. sonar charges
  // $0.005 a search, and this system modelled it as zero across eight services.
  const feeAppeared = compare({
    register,
    live: new Map([["openrouter_feed:anthropic/claude-sonnet-5", { input_per_mtok_usd: 2, output_per_mtok_usd: 10, request_usd: 0.005 }]]),
    today: "2026-09-18",
  });
  if (feeAppeared.drift.length !== 1 || feeAppeared.drift[0].field !== "request_usd") failures.push("a new per-request fee must be reported");

  const old = compare({ register, live, today: "2026-12-01" });
  if (old.stale.length !== 1) failures.push("a price older than staleness_days must be reported stale");
  if (old.drift.length !== 0) failures.push("stale is not the same as wrong; an unchanged old price is not drift");

  const unmapped = compare({ register: { prices: [{ provider_id: "prov_x", model: "y" }] }, live, today: "2026-09-18" });
  if (unmapped.unchecked.length !== 1 || unmapped.examined !== 0) failures.push("a row with no upstream source must be reported as unchecked, not silently passed");

  // The Cloudflare page parse, against the real shape of its rows.
  const cf = parseCloudflarePricing(
    "<td>granite-4.0-h-micro</td><td>$0.017 per M input tokens</td><td>$0.112 per M output tokens</td><td>1542 neurons</td>",
  );
  if (cf.get("granite-4.0-h-micro")?.output_per_mtok_usd !== 0.112) failures.push("the Cloudflare price table parse is broken");

  // Register vs migration.
  // 10.0 / 0.0 on purpose: the SQL is hand-written and the register is JSON, and "10" must match "10.0".
  const agree = checkRegisterAgainstMigration(register, "SELECT 'pps_x', 'prov_openrouter', 'anthropic/claude-sonnet-5', 2.0, 10.0, 0.0, 'x'");
  if (agree.violations.length !== 0 || agree.examined !== 1) failures.push("a register matching the migration must pass and examine 1 row");
  const disagree = checkRegisterAgainstMigration(register, "SELECT 'pps_x', 'prov_openrouter', 'anthropic/claude-sonnet-5', 9.0, 10.0, 0.0, 'x'");
  if (disagree.violations.length !== 1) failures.push("a register that disagrees with the migration must fail");

  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\nSELF-TEST FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("✓ self-test: drift, a new per-request fee, staleness, an unmapped row, the Cloudflare parse and register/migration agreement all behave");
}

function offlineCheck() {
  const register = JSON.parse(readFileSync(REGISTER, "utf8"));
  const { violations, examined } = checkRegisterAgainstMigration(register, allMigrations());
  if (examined === 0) {
    console.error("✗ validate:prices examined ZERO priced rows. The register is empty or unparseable.");
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(`\n✗ the price register and the migrations disagree on ${violations.length} of ${examined} rows.`);
    process.exit(1);
  }
  const unpriced = (register.unpriced ?? []).length;
  console.log(
    `✓ ${examined} sourced price(s) in deployment/model-prices.json are written by a migration, ` +
      `and ${unpriced} row(s) are recorded as unread rather than filled in with a plausible number`,
  );
}

async function live(strict) {
  const register = JSON.parse(readFileSync(REGISTER, "utf8"));
  const today = new Date().toISOString();
  const liveMap = new Map();

  const searchModels = searchGroundedModels(readFileSync(path.join(ROOT, "src", "shared", "ai", "models.ts"), "utf8"));
  const or = await readOpenRouter(fetch, searchModels);
  for (const [id, p] of or) liveMap.set(`openrouter_feed:${id}`, p);
  const cf = await readCloudflare();
  for (const [id, p] of cf) liveMap.set(`cloudflare:${id}`, p);

  /*
   * PERPLEXITY'S OWN FEED, only when a key is already in this shell's environment. The script never
   * asks for a credential, never writes one anywhere, and prints nothing from it but prices.
   */
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      const res = await fetch("https://api.perplexity.ai/v1/models", {
        headers: { authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
      });
      if (res.ok) {
        const body = await res.json();
        for (const m of body.data ?? body.models ?? []) {
          const p = m.pricing ?? {};
          if (p.input === undefined) continue;
          liveMap.set(`perplexity:${m.id}`, {
            input_per_mtok_usd: Number(p.input),
            output_per_mtok_usd: Number(p.output),
            request_usd: 0,
          });
        }
        console.log("· Perplexity's own model feed was read (a key was present in this shell).");
      } else {
        console.log(`· Perplexity's feed answered HTTP ${res.status}; its rows fall back to the OpenRouter figure.`);
      }
    } catch {
      console.log("· Perplexity's feed could not be reached; its rows fall back to the OpenRouter figure.");
    }
  } else {
    console.log("· PERPLEXITY_API_KEY is not in this shell, so Perplexity rows use the OpenRouter figure for the same model.");
  }

  const { drift, stale, unchecked, examined } = compare({ register, live: liveMap, today });

  console.log(`\nRead ${examined} priced row(s) against the vendors.`);
  for (const u of unchecked) console.log(`  ? ${u}`);
  for (const s of stale) console.log(`  ⏰ ${s.key}: last read ${s.sourced_at}, ${s.days} days ago (limit ${register.staleness_days})`);
  if (drift.length === 0) {
    console.log("  ✓ every price still matches what the vendor publishes.");
  } else {
    for (const d of drift) console.log(`  Δ ${d.key} ${d.field}: recorded ${d.recorded}, vendor now ${d.vendor}`);
    console.log("\n" + driftSql(drift, today, register));
    console.log("Paste the above into the next migration, update deployment/model-prices.json to match, and run `npm run validate:prices`.");
  }

  if (examined === 0) {
    console.error("✗ zero rows were compared — the vendor feeds returned nothing recognisable.");
    process.exit(1);
  }
  if (strict && (drift.length > 0 || stale.length > 0)) process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("--self-test")) selfTest();
else if (argv.includes("--offline-check")) offlineCheck();
else await live(argv.includes("--check"));
