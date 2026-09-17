#!/usr/bin/env node
/**
 * preview-sends-nowhere.mjs — `npm run validate:preview`.
 *
 * ONE ASSERTION: A PREVIEW CANNOT REACH ANYBODY, AND IT CANNOT REACH ANYBODY BECAUSE OF WHERE THE
 * RULE LIVES — AT THE SEND BOUNDARY — RATHER THAN BECAUSE EVERY FEATURE REMEMBERED IT.
 *
 * Operator, 17 Sep 2026: "NO EXTERNAL EFFECTS, EVER. A preview of something that would email an
 * outside person emails nobody. Enforce at the send boundary, not by remembering per feature — that
 * is the difference between a guard and a convention."
 *
 * A convention holds until somebody adds the next transport. This scan is what makes the next
 * transport fail the build instead of silently emailing a founder during a rehearsal.
 *
 * WHAT IS CHECKED
 *
 *   1 · EVERY TRANSPORT PASSES THROUGH THE BOUNDARY. A function that actually sends — one that
 *       calls a mail provider over fetch, or touches the `EMAIL` binding's `send` — must call
 *       `applyPreviewBoundary(` and must do so BEFORE it sends. Position matters: a boundary
 *       applied after the request has gone out is decoration.
 *
 *   2 · THE BOUNDARY REPLACES THE RECIPIENT. `applyPreviewBoundary` assigns `to:` from the single
 *       preview recipient, and does not filter, test or branch on the original destination. A
 *       filter can be defeated by an address nobody predicted; a replacement cannot.
 *
 *   3 · THE APPROVED EXTERNAL-EFFECT PATH REFUSES. `executeExternalEffect` — the one path that can
 *       reach somebody outside the firm — calls `isPreviewEnv(` and throws, so no receipt is
 *       consumed by a rehearsal.
 *
 *   4 · THE ACCOUNTING EXEMPTION IS DELIBERATE AND SMALL. `PREVIEW_WRITABLE_TABLES` contains
 *       `ai_run` (a preview costs money and counts against the caps — the operator was explicit)
 *       and contains none of the tables that constitute a recipient's desk. An exemption list that
 *       quietly grew to include `deliverable` would be a preview that files things on Scooter's
 *       Home, which is exactly what "it must not consume the real run" forbids.
 *
 *   5 · EVERY CARD-OPENING JOB IS PREVIEWABLE. `PREVIEW_JOB_CARDS` covers every key in
 *       `CARD_OPENING_JOB_KEYS`. A job added to one and not the other is this repo's "exists but
 *       nothing invokes it" defect: the preview route would answer `not_previewable` for work that
 *       plainly is.
 *
 * HARD-FAILS ON ZERO: zero sources scanned, zero senders found, or zero previewable jobs all exit
 * 1. A scan that examined nothing is not a passing scan — if the transports are renamed, this must
 * fail loudly rather than pass by finding nothing to check.
 *
 * `--self-test` runs the defects this exists to catch through the same functions and requires each
 * to be caught: a transport that never calls the boundary, one that calls it after sending, a
 * boundary that filters instead of replacing, an executor that forgot to refuse, an exemption list
 * that grew a deliverable, and a job table missing a key.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");

const BOUNDARY = path.join("src", "worker", "effects", "emailTransport.ts");
const EXECUTOR = path.join("src", "worker", "effects", "executor.ts");
const PREVIEW_SERVICE = path.join("src", "worker", "services", "preview.ts");
const PREVIEW_SHARED = path.join("src", "shared", "work", "preview.ts");

/**
 * What counts as SENDING. Deliberately behavioural rather than a list of known function names: a
 * new transport will not be called `sendViaSomething`, but it will have to reach a provider or the
 * binding, and both of those are visible here.
 */
const SENDS = [
  // A request to a mail provider's API.
  /fetchImpl\s*\(\s*RESEND_ENDPOINT/,
  /fetch\s*\(\s*["'`]https:\/\/api\.[a-z]+\.(?:com|io|dev)\/emails/,
  // The Cloudflare Email binding.
  /\bemail\.send\s*\(/,
  /\benv\.EMAIL\.send\s*\(/,
];

/** Comments out, line count preserved — prose must not decide the outcome in either direction. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

function readTree(dir, extensions) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((e) => entry.name.endsWith(e))) {
        out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The scan itself, taking a map of relative path → source so `--self-test` can drive it with
 * fixtures rather than with the tree.
 */
export function checkSources(sources) {
  const violations = [];
  let senders = 0;

  // ── 1 · every sender passes through the boundary, before it sends ──────────────────────────
  for (const [file, raw] of Object.entries(sources)) {
    const code = stripComments(raw);
    // The boundary itself and the preview service define and drive it; they are not senders.
    if (file === BOUNDARY || file === PREVIEW_SERVICE) continue;
    const sendAt = SENDS.map((re) => code.search(re)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (sendAt === undefined) continue;
    senders += 1;
    const guardAt = code.indexOf("applyPreviewBoundary(");
    if (guardAt < 0) {
      violations.push(
        `${file} sends email and never calls applyPreviewBoundary(). A preview would reach the real recipient.`,
      );
      continue;
    }
    if (guardAt > sendAt) {
      violations.push(
        `${file} calls applyPreviewBoundary() AFTER it sends. A boundary applied to a message already on the wire is decoration.`,
      );
    }
  }

  // ── 2 · the boundary replaces, it does not filter ──────────────────────────────────────────
  const boundary = sources[BOUNDARY];
  if (!boundary) {
    violations.push(`${BOUNDARY} is missing — there is no send boundary at all.`);
  } else {
    const code = stripComments(boundary);
    if (!/to:\s*\[\s*PREVIEW_RECIPIENT\s*\]/.test(code)) {
      violations.push(
        `${BOUNDARY} does not assign to: [PREVIEW_RECIPIENT]. The recipient list must be REPLACED, ` +
          "not filtered: a filter can be defeated by an address nobody predicted.",
      );
    }
    if (/\.filter\s*\([^)]*\b(to|recipients?)\b/.test(code)) {
      violations.push(
        `${BOUNDARY} filters the recipient list. Replace it instead — see applyPreviewBoundary.`,
      );
    }
  }

  // ── 3 · the approved external-effect path refuses outright ─────────────────────────────────
  const executor = sources[EXECUTOR];
  if (!executor) {
    violations.push(`${EXECUTOR} is missing — the approved external-effect path cannot be checked.`);
  } else {
    const code = stripComments(executor);
    if (!/isPreviewEnv\s*\(/.test(code) || !/preview_cannot_send/.test(code)) {
      violations.push(
        `${EXECUTOR} does not refuse a preview. That is the one path that can reach a founder, an LP ` +
          "or a journalist, and a preview must never consume the approval receipt behind it.",
      );
    }
  }

  // ── 4 · the accounting exemption is deliberate and small ───────────────────────────────────
  const service = sources[PREVIEW_SERVICE];
  if (!service) {
    violations.push(`${PREVIEW_SERVICE} is missing — a preview has no write block.`);
  } else {
    const block = /PREVIEW_WRITABLE_TABLES[^=]*=\s*\[([\s\S]*?)\]/.exec(stripComments(service));
    const listed = block ? [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
    if (listed.length === 0) {
      violations.push(`${PREVIEW_SERVICE} has no PREVIEW_WRITABLE_TABLES list to check.`);
    }
    if (!listed.includes("ai_run")) {
      violations.push(
        `${PREVIEW_SERVICE}: ai_run is not writable in a preview, so a preview would be free. ` +
          "The operator was explicit: a real run is a real run, it costs money and counts against the caps.",
      );
    }
    for (const forbidden of ["deliverable", "work_card", "notification", "productions_candidate", "work_card_note"]) {
      if (listed.includes(forbidden)) {
        violations.push(
          `${PREVIEW_SERVICE}: ${forbidden} is on the writable list. That is the recipient's desk — ` +
            "a preview that writes it has consumed the real run.",
        );
      }
    }
  }

  // ── 5 · every card-opening job is previewable ──────────────────────────────────────────────
  const shared = sources[PREVIEW_SHARED];
  let previewableJobs = 0;
  if (!shared || !service) {
    violations.push("the preview job table cannot be checked — one of its two files is missing.");
  } else {
    const declared = /CARD_OPENING_JOB_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(stripComments(shared));
    const keys = declared ? [...declared[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
    const table = stripComments(service);
    for (const key of keys) {
      previewableJobs += 1;
      if (!new RegExp(`\\b${key}\\s*:\\s*\\{`).test(table)) {
        violations.push(
          `${key} opens a work card and has no entry in PREVIEW_JOB_CARDS, so /api/preview answers ` +
            '"not previewable" for work that plainly is.',
        );
      }
    }
  }

  return { violations, senders, previewableJobs };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  const clean = {
    [BOUNDARY]: 'export function applyPreviewBoundary(env, p) { if (!isPreviewEnv(env)) return p; return { ...p, to: [PREVIEW_RECIPIENT] }; }',
    [EXECUTOR]: 'if (isPreviewEnv(env)) { throw new EffectError(403, "preview_cannot_send", "no"); }',
    [PREVIEW_SERVICE]:
      'export const PREVIEW_WRITABLE_TABLES = ["ai_run", "cost_alert"];\n' +
      'export const PREVIEW_JOB_CARDS = { productions_hire_search: { cardKind: "X" } };',
    [PREVIEW_SHARED]: 'export const CARD_OPENING_JOB_KEYS = ["productions_hire_search"];',
    [path.join("src", "worker", "effects", "resendClient.ts")]:
      'const payload = applyPreviewBoundary(env, request); const res = await fetchImpl(RESEND_ENDPOINT, {});',
    [path.join("src", "worker", "effects", "cloudflareEmailClient.ts")]:
      'const payload = applyPreviewBoundary(env, request); const r = await email.send({});',
  };

  const cases = {
    "a transport that never calls the boundary": {
      ...clean,
      [path.join("src", "worker", "effects", "newTransport.ts")]: 'const res = await fetchImpl(RESEND_ENDPOINT, {});',
    },
    "a transport that calls the boundary AFTER sending": {
      ...clean,
      [path.join("src", "worker", "effects", "resendClient.ts")]:
        'const res = await fetchImpl(RESEND_ENDPOINT, {}); const payload = applyPreviewBoundary(env, request);',
    },
    "a boundary that filters instead of replacing": {
      ...clean,
      [BOUNDARY]: 'export function applyPreviewBoundary(env, p) { return { ...p, to: p.to.filter((a) => a === PREVIEW_RECIPIENT) }; }',
    },
    "an executor that forgot to refuse a preview": { ...clean, [EXECUTOR]: "const authz = await authorize(env);" },
    "an exemption list that grew a deliverable": {
      ...clean,
      [PREVIEW_SERVICE]:
        'export const PREVIEW_WRITABLE_TABLES = ["ai_run", "deliverable"];\n' +
        'export const PREVIEW_JOB_CARDS = { productions_hire_search: { cardKind: "X" } };',
    },
    "a preview that costs nothing because ai_run is blocked": {
      ...clean,
      [PREVIEW_SERVICE]:
        'export const PREVIEW_WRITABLE_TABLES = ["cost_alert"];\n' +
        'export const PREVIEW_JOB_CARDS = { productions_hire_search: { cardKind: "X" } };',
    },
    "a card-opening job with no preview entry": {
      ...clean,
      [PREVIEW_SHARED]: 'export const CARD_OPENING_JOB_KEYS = ["productions_hire_search", "a_new_weekly_duty"];',
    },
  };

  const failures = [];
  const cleanResult = checkSources(clean);
  if (cleanResult.violations.length > 0) {
    failures.push(`the clean fixture was rejected: ${cleanResult.violations.join("; ")}`);
  }
  if (cleanResult.senders !== 2) failures.push(`the clean fixture found ${cleanResult.senders} senders, expected 2`);
  for (const [name, fixture] of Object.entries(cases)) {
    if (checkSources(fixture).violations.length === 0) failures.push(`NOT CAUGHT: ${name}`);
  }

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `SELF-TEST PASSED: clean fixture passes; all ${Object.keys(cases).length} violating fixtures are caught, ` +
      "including a new transport that never reaches the boundary.",
  );
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`PREVIEW SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}

const { violations, senders, previewableJobs } = checkSources(sources);

if (senders === 0) {
  console.error("PREVIEW SCAN FAILED — found 0 things that send email. Either the transports were renamed and");
  console.error("this scan is looking for the wrong thing, or nothing can send at all. Both must fail loudly:");
  console.error("a scan that passes by finding nothing to check is the 'runs but inert' defect.");
  process.exit(1);
}
if (previewableJobs === 0) {
  console.error("PREVIEW SCAN FAILED — CARD_OPENING_JOB_KEYS is empty, so nothing can be previewed at all.");
  process.exit(1);
}
if (violations.length > 0) {
  console.error("PREVIEW SCAN FAILED — a preview could reach somebody, or consume the real run:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nA preview does the REAL work and reaches exactly one address: Sequoia's. The rule lives at the");
  console.error(`send boundary (${BOUNDARY}) and at the approved-effect path (${EXECUTOR}), never in a feature.`);
  process.exit(1);
}

console.log(
  `PREVIEW SCAN PASSED: ${senders} sender(s) across ${Object.keys(sources).length} sources, each through ` +
    `applyPreviewBoundary() before sending; the external-effect path refuses a preview; ${previewableJobs} ` +
    "card-opening job(s) are previewable; the write exemption is the AI accounting tables only.",
);
